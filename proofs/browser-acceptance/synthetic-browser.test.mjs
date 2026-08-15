import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ACTIVE_UPSTREAM } from "../../app/components/vm-ui-state.mjs";
import { runAcceptance } from "./run.mjs";
import { close, listen } from "./server.mjs";

const ENABLED = process.env.OMARCHY_SYNTHETIC_BROWSER_SMOKE === "1";

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function authenticFixtureReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-15T00:11:44.933Z",
    provenance: { ...ACTIVE_UPSTREAM },
    system: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      kernel: "7.1.8-arch1-3",
      sessionType: "wayland",
    },
    components: [
      { role: "compositor", name: "Hyprland", version: "0.56.2", executable: "/usr/bin/Hyprland" },
      { role: "shell", name: "quickshell", version: "0.3.0", executable: "/usr/bin/quickshell" },
    ],
    processes: [
      { name: "Hyprland", pid: 434 },
      { name: "quickshell", pid: 484 },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n" },
      { argv: ["hyprctl", "version"], exitCode: 0, stdout: "Hyprland 0.56.2\n" },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: JSON.stringify([{ width: 1600, height: 900, disabled: false, dpmsStatus: true }]),
      },
      { argv: ["omarchy-version"], exitCode: 0, stdout: "4.0.0.alpha-1\n" },
    ],
    configs: [
      { path: "/usr/share/omarchy/shell/shell.qml", sha256: "b".repeat(64), origin: "omarchy-upstream" },
    ],
  };
}

function syntheticWorkerSource(rootfsSha256) {
  return `
const upstream = ${JSON.stringify(ACTIVE_UPSTREAM)};
const report = ${JSON.stringify(authenticFixtureReport())};
const rootfsSha256 = ${JSON.stringify(rootfsSha256)};
let canvas;
let sequence = 0;

function draw(second = false) {
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 1600, 900);
  gradient.addColorStop(0, second ? "#93c5fd" : "#172554");
  gradient.addColorStop(0.5, second ? "#c084fc" : "#7e22ce");
  gradient.addColorStop(1, second ? "#fde68a" : "#db2777");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1600, 900);
}

function guestFrame() {
  postMessage({
    type: "guestframe",
    sequence: ++sequence,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 576,
    timestamp: performance.now(),
  });
}

async function start(data) {
  canvas = data.canvas;
  canvas.width = 1600;
  canvas.height = 900;
  const manifestBytes = await fetch(new URL("artifact-manifest.json", data.releaseBaseUrl)).then((response) => response.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", manifestBytes);
  const artifactManifestSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  const rootfsUrl = new URL("rootfs.ext4", data.releaseBaseUrl);
  const head = await fetch(rootfsUrl, { method: "HEAD" });
  if (!head.ok) throw new Error("synthetic rootfs HEAD failed");
  const range = await fetch(rootfsUrl, {
    headers: { Range: "bytes=0-15", "If-Match": '"sha256-' + rootfsSha256 + '"' },
  });
  if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 16) {
    throw new Error("synthetic rootfs range failed");
  }
  postMessage({ type: "release", upstream, artifactManifestSha256 });
  postMessage({ type: "display", width: 1600, height: 900 });
  postMessage({ type: "phase", phase: "running" });
  postMessage({ type: "guestreport", report, origin: "live-guest-serial" });
  draw();
  guestFrame();
  draw(true);
  guestFrame();
  postMessage({
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256,
      challengeSha256: "c".repeat(64),
      baselineSequence: 1,
      responseSequence: 2,
      sampledPixels: 576,
      changedPixels: 304,
      dominantPixels: 272,
    },
  });
  setTimeout(guestFrame, 10);
}

function input(event) {
  let accepted;
  if (event.kind === "pointer") {
    accepted = { kind: "pointer", x: Math.round(event.x * 32767), y: Math.round(event.y * 32767), buttons: event.buttons };
  } else {
    const scancodes = { MetaLeft: 227, Enter: 40 };
    accepted = { kind: "key", scancode: scancodes[event.code], down: event.down };
  }
  postMessage({ type: "inputaccepted", event: accepted });
}

self.onmessage = (message) => {
  if (message.data?.type === "start") start(message.data).catch((error) => postMessage({ type: "error", error: { message: error.message } }));
  else if (message.data?.type === "input") input(message.data.event);
};
`;
}

test("synthetic browser smoke exercises CDP, production iframe, evidence, and screenshot plumbing", {
  skip: !ENABLED,
  timeout: 120_000,
}, async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "omarchy-acceptance-browser-smoke-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const rootfs = Buffer.from("0123456789abcdef");
  const rootfsSha256 = sha256(rootfs);
  const worker = Buffer.from(syntheticWorkerSource(rootfsSha256));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    upstream: { ...ACTIVE_UPSTREAM },
    artifacts: [
      {
        path: "production-worker.mjs",
        role: "host-worker",
        mediaType: "text/javascript",
        bytes: worker.byteLength,
        sha256: sha256(worker),
      },
      {
        path: "rootfs.ext4",
        role: "guest-rootfs",
        mediaType: "application/vnd.omarchy.ext4",
        bytes: rootfs.byteLength,
        sha256: rootfsSha256,
      },
    ],
  })}\n`);

  const upstream = createServer((request, response) => {
    const assets = new Map([
      ["/release/artifact-manifest.json", [manifest, "application/json"]],
      ["/release/production-worker.mjs", [worker, "text/javascript"]],
    ]);
    if (assets.has(request.url)) {
      const [body, type] = assets.get(request.url);
      response.writeHead(200, { "Content-Length": body.byteLength, "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (request.url === "/release/rootfs.ext4" && request.method === "HEAD") {
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": rootfs.byteLength,
        ETag: `"sha256-${rootfsSha256}"`,
      });
      response.end();
      return;
    }
    if (request.url === "/release/rootfs.ext4" && request.headers.range === "bytes=0-15") {
      response.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Length": rootfs.byteLength,
        "Content-Range": `bytes 0-15/${rootfs.byteLength}`,
        ETag: `"sha256-${rootfsSha256}"`,
      });
      response.end(rootfs);
      return;
    }
    response.writeHead(404, { "Content-Length": 0 });
    response.end();
  });
  const upstreamOrigin = await listen(upstream);
  context.after(() => close(upstream));

  const output = join(temporary, "evidence");
  await runAcceptance({
    releaseBaseUrl: `${upstreamOrigin}/release/`,
    output,
    timeoutMs: 60_000,
  });
  const evidence = JSON.parse(await readFile(join(output, "evidence.json"), "utf8"));
  const requests = JSON.parse(await readFile(join(output, "requests.json"), "utf8"));
  const hashes = JSON.parse(await readFile(join(output, "hashes.json"), "utf8"));
  assert.equal(evidence.verdict, "passed");
  assert.equal(evidence.contract.stage, "passed");
  assert.equal(evidence.screenshot.width, 1600);
  assert.equal(requests.violations.length, 0);
  assert.match(hashes.acceptanceSources["public/vm/host.mjs"].sha256, /^[a-f0-9]{64}$/);
  assert.match(
    hashes.acceptanceSources["public/vm/desktop-proof.mjs"].sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(hashes.release.artifactManifestSha256, evidence.contract.releaseId);
});
