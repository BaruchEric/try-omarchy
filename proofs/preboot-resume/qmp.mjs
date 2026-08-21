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
const VIRTIO_INPUT_REPORT_HOLD_MILLISECONDS = 150;
const VIRTIO_QUEUE_INDEX_MODULUS = 0x1_0000;
const VIRTIO_DRIVER_OK = "VIRTIO_CONFIG_S_DRIVER_OK: Driver setup and ready";

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

function queueIndexDelta(before, after) {
  if (!Number.isInteger(before) || !Number.isInteger(after) ||
      before < 0 || before >= VIRTIO_QUEUE_INDEX_MODULUS ||
      after < 0 || after >= VIRTIO_QUEUE_INDEX_MODULUS) {
    throw new Error(`invalid Virtio queue indices: before=${before} after=${after}`);
  }
  return (after - before + VIRTIO_QUEUE_INDEX_MODULUS) % VIRTIO_QUEUE_INDEX_MODULUS;
}

function queueProgress(before, after) {
  return {
    lastAvailDelta: queueIndexDelta(before["last-avail-idx"], after["last-avail-idx"]),
    usedDelta: queueIndexDelta(before["used-idx"], after["used-idx"]),
  };
}

function requireQueueProgress(label, progress, expected) {
  if (progress.lastAvailDelta !== expected || progress.usedDelta !== expected) {
    throw new Error(
      `${label} did not consume exactly ${expected} Virtio descriptors: ${JSON.stringify(progress)}`,
    );
  }
}

async function queryVirtioInput(client, info) {
  const status = await client.execute("x-query-virtio-status", { path: info.path });
  const queue = await client.execute("x-query-virtio-queue-status", {
    path: info.path,
    queue: 0,
  });
  const statuses = status?.status?.statuses;
  if (status?.name !== "virtio-input" || status.started !== true || status["vm-running"] !== true ||
      status.broken !== false || status.disabled !== false ||
      !Array.isArray(statuses) || !statuses.includes(VIRTIO_DRIVER_OK)) {
    throw new Error(`Virtio input device is not active and DRIVER_OK: ${JSON.stringify({ info, status })}`);
  }
  if (queue?.name !== "virtio-input" || queue["queue-index"] !== 0 || queue["vring-num"] !== 64 ||
      !Number.isInteger(queue["last-avail-idx"]) || !Number.isInteger(queue["used-idx"]) ||
      !Number.isInteger(queue["vring-desc"]) || queue["vring-desc"] === 0 ||
      !Number.isInteger(queue["vring-avail"]) || queue["vring-avail"] === 0 ||
      !Number.isInteger(queue["vring-used"]) || queue["vring-used"] === 0) {
    throw new Error(`Virtio input event queue is not live: ${JSON.stringify({ info, queue })}`);
  }
  return { path: info.path, status, queue };
}

async function sendVirtioSuperKey(client, keyCode) {
  if (!["2", "ret", "spc"].includes(keyCode)) {
    throw new Error(`unsupported reviewed Virtio Super chord: ${JSON.stringify(keyCode)}`);
  }
  const vmStatus = await client.execute("query-status");
  if (vmStatus?.status !== "running" || vmStatus.running !== true) {
    throw new Error(`VM is not running before Virtio input proof: ${JSON.stringify(vmStatus)}`);
  }
  const infos = (await client.execute("x-query-virtio"))
    .filter((info) => info?.name === "virtio-input");
  if (infos.length !== 2 || new Set(infos.map(({ path }) => path)).size !== 2) {
    throw new Error(`expected exact keyboard/tablet Virtio input topology: ${JSON.stringify(infos)}`);
  }
  const beforeProbe = await Promise.all(infos.map((info) => queryVirtioInput(client, info)));
  const modifierReleaseEvents = [
    "meta_l", "meta_r", "ctrl", "ctrl_r", "alt", "alt_r", "shift", "shift_r",
  ].map((code) => explicitKeyEvent(code, false));
  await client.execute("input-send-event", { events: modifierReleaseEvents });
  const afterProbe = await Promise.all(infos.map((info) => queryVirtioInput(client, info)));
  const devices = beforeProbe.map((before, index) => ({
    path: before.path,
    status: before.status,
    queueBeforeProbe: before.queue,
    queueAfterProbe: afterProbe[index].queue,
    probeProgress: queueProgress(before.queue, afterProbe[index].queue),
  }));
  const keyboardCandidates = devices.filter(({ probeProgress }) =>
    probeProgress.lastAvailDelta === modifierReleaseEvents.length + 1 &&
    probeProgress.usedDelta === modifierReleaseEvents.length + 1);
  if (keyboardCandidates.length !== 1) {
    throw new Error(`could not identify one consuming Virtio keyboard queue: ${JSON.stringify(devices)}`);
  }
  const keyboard = keyboardCandidates[0];
  const tablet = devices.find(({ path }) => path !== keyboard.path);
  requireQueueProgress("Virtio keyboard modifier-release probe", keyboard.probeProgress, 9);
  requireQueueProgress("Virtio tablet keyboard-isolation probe", tablet.probeProgress, 0);
  await delay(VIRTIO_INPUT_REPORT_HOLD_MILLISECONDS);

  const pressEvents = [explicitKeyEvent("meta_l", true), explicitKeyEvent(keyCode, true)];
  const releaseEvents = [explicitKeyEvent(keyCode, false), explicitKeyEvent("meta_l", false)];
  let pressed = false;
  let pressQueue;
  let releaseQueue;
  try {
    await client.execute("input-send-event", { events: pressEvents });
    pressed = true;
    pressQueue = (await queryVirtioInput(client, { path: keyboard.path })).queue;
    requireQueueProgress(
      `Virtio keyboard Super+${keyCode} press report`,
      queueProgress(keyboard.queueAfterProbe, pressQueue),
      pressEvents.length + 1,
    );
    await delay(VIRTIO_INPUT_REPORT_HOLD_MILLISECONDS);
    await client.execute("input-send-event", { events: releaseEvents });
    pressed = false;
    releaseQueue = (await queryVirtioInput(client, { path: keyboard.path })).queue;
    requireQueueProgress(
      `Virtio keyboard Super+${keyCode} release report`,
      queueProgress(pressQueue, releaseQueue),
      releaseEvents.length + 1,
    );
  } finally {
    if (pressed) {
      await client.execute("input-send-event", { events: releaseEvents }).catch(() => {});
    }
  }
  return {
    schemaVersion: 1,
    action: keyCode === "ret" ? "virtio-super-return" : "virtio-super-key",
    keyCode,
    vmStatus,
    requestedHoldMilliseconds: VIRTIO_INPUT_REPORT_HOLD_MILLISECONDS,
    keyboardPath: keyboard.path,
    devices,
    press: {
      events: pressEvents,
      queueBefore: keyboard.queueAfterProbe,
      queueAfter: pressQueue,
      progress: queueProgress(keyboard.queueAfterProbe, pressQueue),
    },
    release: {
      events: releaseEvents,
      queueBefore: pressQueue,
      queueAfter: releaseQueue,
      progress: queueProgress(pressQueue, releaseQueue),
    },
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
    } else if (action === "virtio-super-return") {
      result = await sendVirtioSuperKey(client, "ret");
    } else if (action === "virtio-super-key") {
      if (values.length !== 1) throw new Error("virtio-super-key requires one reviewed qcode");
      result = await sendVirtioSuperKey(client, values[0]);
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
