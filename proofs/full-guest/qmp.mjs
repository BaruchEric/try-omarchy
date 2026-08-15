#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

class QmpClient {
  constructor(socketPath, logPath) {
    this.socketPath = socketPath;
    this.logPath = logPath;
    this.buffer = "";
    this.sequence = 0;
    this.pending = new Map();
    this.inbox = [];
    this.greeting = null;
    this.logTail = Promise.resolve();
  }

  log(direction, payload) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`;
    this.logTail = this.logTail.then(() => appendFile(this.logPath, line));
    return this.logTail;
  }

  async connect() {
    this.socket = net.createConnection({ path: this.socketPath });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.consume(chunk));
    this.socket.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    await this.log("connect", { socketPath: this.socketPath });
    this.greeting = await this.waitFor("greeting", (message) => Boolean(message.QMP));
    await this.execute("qmp_capabilities");
    return this;
  }

  consume(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.log("parse-error", { line, error: error.message }).catch(() => {});
        continue;
      }
      this.log("receive", message).catch(() => {});
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`QMP ${message.error.class}: ${message.error.desc}`));
        else pending.resolve(message.return);
        continue;
      }
      let matched = false;
      for (const [key, pending] of this.pending) {
        if (pending.predicate?.(message)) {
          this.pending.delete(key);
          clearTimeout(pending.timer);
          pending.resolve(message);
          matched = true;
          break;
        }
      }
      if (!matched) this.inbox.push(message);
    }
  }

  waitFor(label, predicate, timeoutMilliseconds = 10000) {
    const available = this.inbox.findIndex(predicate);
    if (available >= 0) return Promise.resolve(this.inbox.splice(available, 1)[0]);
    const key = `wait-${label}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for QMP ${label}`));
      }, timeoutMilliseconds);
      this.pending.set(key, { resolve, reject, predicate, timer });
    });
  }

  async execute(command, argumentsObject = undefined, timeoutMilliseconds = 15000) {
    const id = `command-${++this.sequence}`;
    const payload = { execute: command, id };
    if (argumentsObject !== undefined) payload.arguments = argumentsObject;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out executing QMP ${command}`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.log("send", payload);
    this.socket.write(`${JSON.stringify(payload)}\r\n`);
    return result;
  }

  async close() {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.end();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.log("disconnect", {});
  }
}

const SIMPLE_QCODES = new Set("abcdefghijklmnopqrstuvwxyz0123456789".split(""));
const SPECIAL_QCODES = {
  " ": ["spc"],
  "-": ["minus"],
  "_": ["shift", "minus"],
  ".": ["dot"],
  "/": ["slash"],
  ">": ["shift", "dot"],
  "<": ["shift", "comma"],
  "=": ["equal"],
  ":": ["shift", "semicolon"],
  ";": ["semicolon"],
  "$": ["shift", "4"],
  "*": ["shift", "8"],
  "\n": ["ret"],
};

export function qcodesForCharacter(character) {
  if (SIMPLE_QCODES.has(character)) return [character];
  if (/^[A-Z]$/.test(character)) return ["shift", character.toLowerCase()];
  if (SPECIAL_QCODES[character]) return SPECIAL_QCODES[character];
  throw new Error(`No fail-closed QMP key mapping for ${JSON.stringify(character)}`);
}

function keyObjects(codes) {
  return codes.map((code) => ({ type: "qcode", data: code }));
}

export async function runQmpAction({ socketPath, logPath, action, values = [] }) {
  invariant(socketPath && logPath && action, "QMP socket, log, and action are required");
  const client = await new QmpClient(socketPath, logPath).connect();
  try {
    switch (action) {
      case "status":
        return await client.execute("query-status");
      case "screendump": {
        const filename = values[0];
        invariant(filename?.startsWith("/"), "screendump path must be absolute");
        return await client.execute("screendump", { filename, format: "ppm" }, 30000);
      }
      case "super-return":
        return await client.execute("send-key", { keys: keyObjects(["meta_l", "ret"]), "hold-time": 100 });
      case "type": {
        const text = values[0];
        invariant(typeof text === "string" && text.length > 0, "type action needs text");
        for (const character of text) {
          await client.execute("send-key", { keys: keyObjects(qcodesForCharacter(character)), "hold-time": 80 });
          // TCG can acknowledge QMP before the emulated virtio keyboard and
          // compositor have consumed the event. Deliberate pacing prevents
          // dropped characters in the proof command.
          await delay(300);
        }
        return { characters: text.length };
      }
      case "quit":
        return await client.execute("quit", undefined, 5000);
      default:
        throw new Error(`Unknown QMP action: ${action}`);
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const [socketPath, logPath, action, ...values] = process.argv.slice(2);
  const result = await runQmpAction({ socketPath, logPath, action, values });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`QMP failure: ${error.message}\n`);
    process.exitCode = 1;
  });
}
