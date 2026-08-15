#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import net from "node:net";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class QmpClient {
  constructor(socketPath, logPath) {
    this.socketPath = socketPath;
    this.logPath = logPath;
    this.buffer = "";
    this.inbox = [];
    this.pending = new Map();
    this.sequence = 0;
    this.logTail = Promise.resolve();
  }

  log(direction, payload) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`;
    this.logTail = this.logTail.then(() => appendFile(this.logPath, line));
    return this.logTail;
  }

  consume(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      this.log("receive", message).catch(() => {});
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`QMP ${message.error.class}: ${message.error.desc}`));
        else pending.resolve(message.return);
      } else {
        this.inbox.push(message);
      }
    }
  }

  async connect() {
    this.socket = net.createConnection({ path: this.socketPath });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.consume(chunk));
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    await this.log("connect", { socketPath: this.socketPath });
    const deadline = Date.now() + 10_000;
    while (!this.inbox.some((message) => message.QMP)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for QMP greeting");
      await delay(20);
    }
    await this.execute("qmp_capabilities");
    return this;
  }

  async execute(command, argumentsObject = undefined, timeoutMilliseconds = 120_000) {
    const id = `command-${++this.sequence}`;
    const payload = { execute: command, id };
    if (argumentsObject !== undefined) payload.arguments = argumentsObject;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out executing QMP ${command}`));
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
  ".": ["dot"],
  "/": ["slash"],
  ">": ["shift", "dot"],
  "\n": ["ret"],
};

function qcodes(character) {
  if (SIMPLE_QCODES.has(character)) return [character];
  if (SPECIAL_QCODES[character]) return SPECIAL_QCODES[character];
  throw new Error(`no reviewed QMP key mapping for ${JSON.stringify(character)}`);
}

function keyObjects(codes) {
  return codes.map((code) => ({ type: "qcode", data: code }));
}

const INPUT_TRANSITION_MILLISECONDS = 16;

function explicitKeyEvent(code, down) {
  return {
    type: "key",
    data: { down, key: { type: "qcode", data: code } },
  };
}

async function sendExplicitChord(client, codes) {
  const transitions = [
    ...codes.map((code) => ({ code, down: true })),
    ...[...codes].reverse().map((code) => ({ code, down: false })),
  ];
  const evidence = [];
  for (const transition of transitions) {
    const sentAt = Date.now();
    await client.execute("input-send-event", {
      events: [explicitKeyEvent(transition.code, transition.down)],
    });
    const acknowledgedAt = Date.now();
    evidence.push({ ...transition, sentAt, acknowledgedAt });
    await delay(INPUT_TRANSITION_MILLISECONDS);
  }
  return {
    codes,
    requestedInterTransitionMilliseconds: INPUT_TRANSITION_MILLISECONDS,
    transitions: evidence,
  };
}

async function waitFor(client, command, accept, timeoutMilliseconds) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMilliseconds) {
    latest = await client.execute(command);
    if (accept(latest)) return { elapsedMilliseconds: Date.now() - started, result: latest };
    await delay(100);
  }
  throw new Error(`timed out waiting for ${command}: ${JSON.stringify(latest)}`);
}

async function main() {
  const [socketPath, logPath, action, ...values] = process.argv.slice(2);
  if (!socketPath || !logPath || !action) throw new Error("usage: qmp.mjs SOCKET LOG ACTION [VALUES]");
  const client = await new QmpClient(socketPath, logPath).connect();
  try {
    let result;
    if (action === "execute") {
      const [command, json = "{}"] = values;
      result = await client.execute(command, JSON.parse(json));
    } else if (action === "wait-migration") {
      result = await waitFor(client, "query-migrate", (status) => {
        if (["failed", "cancelled"].includes(status.status)) {
          throw new Error(`migration entered terminal ${status.status}: ${JSON.stringify(status)}`);
        }
        return status.status === "completed";
      }, Number(values[0] ?? 300_000));
    } else if (action === "wait-status") {
      const desired = values[0];
      result = await waitFor(client, "query-status", (status) => status.status === desired, Number(values[1] ?? 300_000));
    } else if (action === "screendump") {
      result = await client.execute("screendump", { filename: values[0], format: "ppm" });
    } else if (action === "super-return") {
      // Match the browser input bridge: send acknowledged down/up transitions
      // separately and never rely on QEMU's synthetic simultaneous chord.
      result = await sendExplicitChord(client, ["meta_l", "ret"]);
    } else if (action === "super-w") {
      result = await sendExplicitChord(client, ["meta_l", "w"]);
    } else if (action === "release-modifiers") {
      result = await client.execute("input-send-event", {
        events: ["meta_l", "meta_r", "ctrl", "ctrl_r", "alt", "alt_r", "shift", "shift_r"].map((code) => ({
          type: "key",
          data: { down: false, key: { type: "qcode", data: code } },
        })),
      });
    } else if (action === "type") {
      for (const character of values[0]) {
        await client.execute("send-key", { keys: keyObjects(qcodes(character)), "hold-time": 80 });
        await delay(200);
      }
      result = { characters: values[0].length };
    } else {
      throw new Error(`unknown action: ${action}`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`QMP failure: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
