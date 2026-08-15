import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { ACTIVE_UPSTREAM } from "../../app/components/vm-ui-state.mjs";
import {
  advanceAcceptance,
  checkAcceptanceTimeout,
  createAcceptanceState,
  markTerminalCommandSent,
  READINESS_INPUT,
  TERMINAL_INPUT_SEQUENCE,
} from "./contract.mjs";
import { parseArguments } from "./run.mjs";
import {
  close,
  createAcceptanceProxy,
  inspectArtifactManifest,
  listen,
  normalizeLocalReleaseBase,
  waitForRequestIdle,
} from "./server.mjs";

const RELEASE_ID = "a".repeat(64);
const RUN_NONCE = "browser_acceptance_nonce_123456";

function report() {
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
      { path: "/usr/share/omarchy/default/hypr/omarchy.lua", sha256: "b".repeat(64), origin: "omarchy-upstream" },
    ],
  };
}

function release() {
  return {
    type: "release",
    upstream: { ...ACTIVE_UPSTREAM },
    artifactManifestSha256: RELEASE_ID,
  };
}

function frame(sequence, overrides = {}) {
  return {
    type: "guestframe",
    frame: {
      sequence,
      source: "qemu-guest",
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 576,
      nonBlackPixels: 200,
      ...overrides,
    },
  };
}

test("acceptance contract requires exact release, report, frame, input, and still-later frame order", () => {
  let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  state = advanceAcceptance(state, { type: "ready" }, 1);
  state = advanceAcceptance(state, release(), 2);
  state = advanceAcceptance(state, { type: "guestreport", report: report() }, 3);
  state = advanceAcceptance(state, {
    type: "inputaccepted",
    readinessProbe: true,
    event: { ...READINESS_INPUT },
  }, 4);
  state = advanceAcceptance(state, frame(10), 5);
  assert.equal(state.stage, "ready-to-send-terminal");
  state = markTerminalCommandSent(state, 6);
  for (let index = 0; index < TERMINAL_INPUT_SEQUENCE.length; index += 1) {
    state = advanceAcceptance(state, {
      type: "inputaccepted",
      readinessProbe: false,
      event: { ...TERMINAL_INPUT_SEQUENCE[index] },
    }, 7 + index);
  }
  state = advanceAcceptance(state, frame(11), 12);
  assert.equal(state.stage, "waiting-later-frame", "metrics are also required before PASS");
  state = advanceAcceptance(state, {
    type: "metrics",
    metrics: {
      backingWidth: 1600,
      backingHeight: 900,
      cssWidth: 1600,
      cssHeight: 900,
      deviceWidth: 1600,
      deviceHeight: 900,
      devicePixelRatio: 1,
      pixelPerfect: true,
      aspectMatches: true,
    },
  }, 13);
  assert.equal(state.stage, "passed");
  assert.ok(state.report.ordinal < state.firstFrame.ordinal);
  assert.ok(state.firstFrame.ordinal < state.terminalCommand.ordinal);
  assert.ok(state.terminalInputComplete.ordinal < state.laterFrame.ordinal);
});

test("acceptance contract fails closed on weak pixels, uncorrelated input, and timeouts", () => {
  let state = createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE });
  state = advanceAcceptance(state, { type: "ready" }, 1);
  state = advanceAcceptance(state, release(), 2);
  state = advanceAcceptance(state, { type: "guestreport", report: report() }, 3);
  state = advanceAcceptance(state, frame(1, { sampledPixels: 575 }), 4);
  assert.equal(state.firstFrame, null);
  state = advanceAcceptance(state, {
    type: "inputaccepted",
    readinessProbe: false,
    event: { ...TERMINAL_INPUT_SEQUENCE[0] },
  }, 5);
  assert.equal(state.stage, "failed");
  assert.match(state.failure.reason, /Uncorrelated/);

  const timedOut = checkAcceptanceTimeout(
    createAcceptanceState({ releaseId: RELEASE_ID, runNonce: RUN_NONCE }),
    31,
    {
      totalMs: 100,
      hostMs: 30,
      releaseMs: 30,
      reportMs: 30,
      firstFrameAndInputMs: 30,
      terminalInputMs: 30,
      laterFrameMs: 30,
    },
  );
  assert.equal(timedOut.stage, "failed");
});

test("CLI and release URL parsing reject ambiguous or remote inputs", () => {
  assert.equal(parseArguments(["--release-base", "http://127.0.0.1:8094/release/"]).timeoutMs, 1_860_000);
  assert.throws(() => parseArguments([]), /required/);
  assert.throws(() => parseArguments(["--release-base", "http://127.0.0.1/release/", "--wat"]), /Unknown/);
  assert.equal(normalizeLocalReleaseBase("http://localhost:8094/release").href, "http://localhost:8094/release/");
  assert.throws(() => normalizeLocalReleaseBase("https://example.com/release/"), /localhost/);
  assert.throws(() => normalizeLocalReleaseBase("http://localhost/release/?mutable=1"), /no query/);
});

test("artifact manifest inspection and proxy preserve exact bounded rootfs requests", async (context) => {
  const rootfs = Buffer.from("0123456789abcdef");
  const rootfsSha = createHash("sha256").update(rootfs).digest("hex");
  const worker = Buffer.from("self.onmessage = () => {};\n");
  const workerSha = createHash("sha256").update(worker).digest("hex");
  const manifestBody = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    upstream: { ...ACTIVE_UPSTREAM },
    artifacts: [
      {
        path: "production-worker.mjs",
        role: "host-worker",
        mediaType: "text/javascript",
        bytes: worker.byteLength,
        sha256: workerSha,
      },
      {
        path: "rootfs.ext4",
        role: "guest-rootfs",
        mediaType: "application/vnd.omarchy.ext4",
        bytes: rootfs.byteLength,
        sha256: rootfsSha,
      },
    ],
  })}\n`);
  assert.equal(inspectArtifactManifest(manifestBody).rootfs.sha256, rootfsSha);

  const upstream = createServer((request, response) => {
    if (request.url === "/release/artifact-manifest.json") {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": manifestBody.byteLength });
      response.end(manifestBody);
      return;
    }
    if (request.url === "/release/rootfs.ext4" && request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Length": rootfs.byteLength,
        "Accept-Ranges": "bytes",
        ETag: `"sha256-${rootfsSha}"`,
      });
      response.end();
      return;
    }
    if (request.url === "/release/rootfs.ext4") {
      const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(request.headers.range ?? "");
      if (!match || request.headers["if-match"] !== `"sha256-${rootfsSha}"`) {
        response.writeHead(412, { "Content-Length": 0 });
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = rootfs.subarray(start, end + 1);
      response.writeHead(206, {
        "Content-Length": body.byteLength,
        "Content-Range": `bytes ${start}-${end}/${rootfs.byteLength}`,
        ETag: `"sha256-${rootfsSha}"`,
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamOrigin = await listen(upstream);
  context.after(() => close(upstream));
  const proxy = await createAcceptanceProxy({ releaseBaseUrl: `${upstreamOrigin}/release/` });
  const proxyOrigin = await listen(proxy.server);
  context.after(() => close(proxy.server));
  const base = `${proxyOrigin}/omarchy/versions/${proxy.releaseId}/`;
  const harness = await fetch(`${proxyOrigin}/proofs/browser-acceptance/harness.html`);
  assert.equal(harness.status, 200);
  assert.equal(harness.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(await fetch(`${base}artifact-manifest.json`).then((response) => response.text()), manifestBody.toString());
  assert.equal(await fetch(`${base}artifact-manifest.json`).then((response) => response.text()), manifestBody.toString());

  const head = await fetch(`${base}rootfs.ext4`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const range = await fetch(`${base}rootfs.ext4`, {
    headers: { Range: "bytes=2-5", "If-Match": `"sha256-${rootfsSha}"` },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "2345");
  const full = await fetch(`${base}rootfs.ext4`);
  assert.equal(full.status, 412);
  await waitForRequestIdle(proxy);
  const summary = proxy.summarizeRequests();
  assert.equal(summary.rootfs.headRequests, 1);
  assert.equal(summary.rootfs.rangeRequests, 2);
  assert.equal(summary.rootfs.unboundedGetRequests, 1);
  assert.ok(
    summary.violations.some((violation) => /bounded range|HTTP 412/.test(violation)),
    "an attempted unbounded GET must make acceptance fail closed",
  );
});
