import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acceptVmHostMessage,
  createVmHostCommand,
  createVmRun,
  VM_HOST_PROTOCOL,
} from "../app/components/vm-host-protocol.mjs";
import {
  advanceDesktopEvidence,
  appendDiagnosticLine,
  createDesktopEvidence,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getPhasePresentation,
  inspectVmCapabilities,
  isGuestReadyReport,
  mapCanvasPointToGuest,
  measureCanvasDisplay,
  normalizeRuntimeError,
  PRODUCTION_WORKER_URL,
  RELEASE_BASE_URL,
} from "../app/components/vm-ui-state.mjs";

async function render({
  url = "http://localhost/",
  headers = {},
} = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(url, {
      headers: { accept: "text/html", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Omarchy demo launcher", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Try Omarchy — Live in your browser<\/title>/i);
  assert.match(html, /Try Omarchy/);
  assert.match(html, /Start Omarchy/);
  assert.match(html, /Real x86_64 virtual machine/);
  assert.match(html, /Arch · Hyprland · Quickshell/);
  assert.match(html, /Shared memory/);
  assert.match(html, /Wasm threads/);
  assert.match(html, /Offscreen canvas/);
  assert.doesNotMatch(html, /<canvas\b/i);
  assert.doesNotMatch(html, /Omarchy desktop ready|Guest report received/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("social metadata uses the incoming public origin and bespoke card", async () => {
  const response = await render({
    url: "https://try.example/",
    headers: {
      host: "try.example",
      "x-forwarded-host": "try.example",
      "x-forwarded-proto": "https",
    },
  });
  const html = await response.text();

  assert.match(html, /property="og:title" content="Try Omarchy — Live in your browser"/i);
  assert.match(html, /property="og:image" content="https:\/\/try\.example\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /name="twitter:image" content="https:\/\/try\.example\/og\.png"/i);

  const socialCard = await readFile(
    new URL("../public/og.png", import.meta.url),
  );
  assert.ok(socialCard.byteLength > 100_000);
});

test("isolated VM document owns the only real 1600x900 guest canvas", async () => {
  const hostHtml = await readFile(
    new URL("../public/vm/index.html", import.meta.url),
    "utf8",
  );
  const hostSource = await readFile(
    new URL("../public/vm/host.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    hostHtml,
    /<canvas[\s\S]*?id="canvas"[\s\S]*?width="1600"[\s\S]*?height="900"[\s\S]*?tabindex="0"/i,
  );
  assert.match(hostHtml, /aria-describedby="guest-input-help"/i);
  assert.match(hostHtml, /<script type="module" src="\/vm\/host\.mjs">/i);
  assert.match(
    hostSource,
    new RegExp(`const PROTOCOL_CHANNEL = "${VM_HOST_PROTOCOL.channel}"`),
  );
  assert.match(
    hostSource,
    new RegExp(`const PROTOCOL_VERSION = ${VM_HOST_PROTOCOL.version}`),
  );
  assert.match(hostSource, /new Worker\(workerUrl/);
  assert.match(hostSource, /canvas\.transferControlToOffscreen\(\)/);
  assert.match(hostSource, /runtimeWorker\.postMessage\([\s\S]*?\[offscreen\]/);
  assert.match(hostSource, /RELEASE_BASE_PATH = "\/omarchy\/versions\/f0020448\/"/);
  assert.match(hostSource, /kind: "key"/);
  assert.match(hostSource, /kind: "pointer"/);
  assert.match(hostSource, /kind: "wheel"/);
  assert.doesNotMatch(hostSource, /OmarchyWasmRuntime|qemu\.data|load\.js/);
  assert.match(hostSource, /event\.source === window\.parent/);
  assert.match(hostSource, /event\.origin === window\.location\.origin/);
});

test("VM host protocol rejects wrong origins, sources, versions, and shapes", () => {
  const nonce = "run_nonce_12345678901234567890";
  const source = {};
  const data = {
    channel: VM_HOST_PROTOCOL.channel,
    version: VM_HOST_PROTOCOL.version,
    runNonce: nonce,
    type: "ready",
  };
  const expected = {
    expectedOrigin: "https://try.example",
    expectedSource: source,
    expectedNonce: nonce,
  };

  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data },
      expected,
    ),
    data,
  );
  assert.equal(
    acceptVmHostMessage(
      { origin: "https://evil.example", source, data },
      expected,
    ),
    null,
  );
  assert.equal(
    acceptVmHostMessage(
      { origin: "https://try.example", source: {}, data },
      expected,
    ),
    null,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...data, version: 2 },
      },
      expected,
    ),
    null,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...data, unexpected: true },
      },
      expected,
    ),
    null,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...data, type: "guestframe", frame: { sequence: 1 } },
      },
      expected,
    ),
    null,
  );
});

test("reset lifecycle creates a new iframe generation and rejects stale runs", () => {
  const firstNonce = "first_run_12345678901234567890";
  const secondNonce = "second_run_1234567890123456789";
  const first = createVmRun(null, firstNonce);
  const second = createVmRun(first, secondNonce);
  const source = {};
  const staleEvent = {
    origin: "https://try.example",
    source,
    data: {
      channel: VM_HOST_PROTOCOL.channel,
      version: VM_HOST_PROTOCOL.version,
      runNonce: first.nonce,
      type: "phase",
      phase: "running",
    },
  };

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.notEqual(first.src, second.src);
  assert.match(second.src, /\/vm\/index\.html\?/);
  assert.equal(
    acceptVmHostMessage(staleEvent, {
      expectedOrigin: "https://try.example",
      expectedSource: source,
      expectedNonce: second.nonce,
    }),
    null,
  );
  assert.deepEqual(createVmHostCommand("start", second.nonce), {
    channel: VM_HOST_PROTOCOL.channel,
    version: 1,
    runNonce: second.nonce,
    type: "start",
  });
});

test("enables cross-origin isolation for WebAssembly threads", async () => {
  const response = await render();

  assert.equal(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.equal(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
});

test("capability gate requires isolation, shared memory, threads, and offscreen canvas", () => {
  class FakeSharedArrayBuffer {}
  class FakeMemory {
    constructor() {
      this.buffer = new FakeSharedArrayBuffer();
    }
  }

  const supported = inspectVmCapabilities({
    WebAssembly: { Memory: FakeMemory },
    Worker: class {},
    Atomics: {},
    crossOriginIsolated: true,
    SharedArrayBuffer: FakeSharedArrayBuffer,
    OffscreenCanvas: class {},
  });
  assert.equal(supported.supported, true);
  assert.equal(supported.checks.wasmThreads, true);

  const unsupported = inspectVmCapabilities({
    WebAssembly: { Memory: FakeMemory },
    Worker: class {},
    Atomics: {},
    crossOriginIsolated: false,
    SharedArrayBuffer: FakeSharedArrayBuffer,
  });
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.missing.includes("crossOriginIsolated"));
  assert.ok(unsupported.missing.includes("offscreenCanvas"));
});

test("running emulator is not presented as a ready Omarchy desktop", () => {
  assert.deepEqual(getPhasePresentation("running", false), {
    title: "Waiting for the Omarchy desktop",
    detail: "The emulator is running; readiness must come from the guest.",
    stage: 3,
  });
  assert.equal(getPhasePresentation("running", true).stage, 4);
  assert.equal(
    getPhasePresentation("running", true).title,
    "Omarchy desktop ready",
  );
});

test("guest readiness requires an Omarchy-originated x86_64 desktop report", () => {
  const readyReport = {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:00:00Z",
    provenance: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "a".repeat(40),
      version: "4.0.0",
      treeSha256: "b".repeat(64),
    },
    system: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      kernel: "7.1.8-arch1-3",
      sessionType: "wayland",
    },
    components: [
      {
        role: "compositor",
        name: "Hyprland",
        version: "0.56.2",
        executable: "/usr/bin/Hyprland",
      },
      {
        role: "shell",
        name: "quickshell",
        version: "0.3.0",
        executable: "/usr/bin/quickshell",
      },
    ],
    processes: [
      { name: "Hyprland", pid: 101 },
      { name: "quickshell", pid: 102 },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n" },
      {
        argv: ["hyprctl", "version"],
        exitCode: 0,
        stdout: "Hyprland 0.56.2\n",
      },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: '[{"width":1600,"height":900}]\n',
      },
      {
        argv: ["omarchy-version"],
        exitCode: 0,
        stdout: "4.0.0\n",
      },
    ],
    configs: [
      {
        path: "/usr/share/omarchy/shell/shell.qml",
        sha256: "c".repeat(64),
        origin: "omarchy-upstream",
      },
    ],
  };

  assert.equal(isGuestReadyReport(readyReport), true);
  assert.equal(
    isGuestReadyReport({ ...readyReport, schemaVersion: undefined }),
    false,
  );
  assert.equal(
    isGuestReadyReport({
      ...readyReport,
      system: { ...readyReport.system, architecture: "i686" },
    }),
    false,
  );
  assert.equal(
    isGuestReadyReport({ ...readyReport, processes: [{ name: "Hyprland", pid: 101 }] }),
    false,
  );
});

test("desktop readiness requires a report followed by a fresh 1600x900 guest frame", () => {
  const report = {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:00:00Z",
    provenance: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "b".repeat(40),
      version: "4.0.0",
      treeSha256: "c".repeat(64),
    },
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
      { name: "Hyprland", pid: 101 },
      { name: "quickshell", pid: 102 },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n" },
      { argv: ["hyprctl", "version"], exitCode: 0, stdout: "Hyprland 0.56.2\n" },
      { argv: ["hyprctl", "monitors", "-j"], exitCode: 0, stdout: "[]\n" },
      { argv: ["omarchy-version"], exitCode: 0, stdout: "4.0.0\n" },
    ],
    configs: [
      { path: "/usr/share/omarchy/shell/shell.qml", sha256: "d".repeat(64), origin: "omarchy-upstream" },
    ],
  };
  const frame = {
    source: "qemu-guest",
    sequence: 1,
    guestWidth: 1600,
    guestHeight: 900,
  };

  const reportFirst = advanceDesktopEvidence(createDesktopEvidence(), {
    type: "guestreport",
    report,
  });
  assert.equal(reportFirst.ready, false);
  assert.equal(
    advanceDesktopEvidence(reportFirst, { type: "guestframe", frame }).ready,
    true,
  );

  const frameFirst = advanceDesktopEvidence(createDesktopEvidence(), {
    type: "guestframe",
    frame,
  });
  const reportAfterFrame = advanceDesktopEvidence(frameFirst, {
    type: "guestreport",
    report,
  });
  assert.equal(reportAfterFrame.ready, false);
  assert.equal(
    advanceDesktopEvidence(reportAfterFrame, {
      type: "guestframe",
      frame: { ...frame, sequence: 2 },
    }).ready,
    true,
  );
  assert.equal(
    advanceDesktopEvidence(reportFirst, {
      type: "guestframe",
      frame: { ...frame, guestWidth: 1280 },
    }).ready,
    false,
  );
});

test("fixed guest backing maps predictably at DPR 1 and DPR 2", () => {
  const dpr1 = measureCanvasDisplay({ width: 1600, height: 900 }, 1);
  assert.deepEqual(
    [dpr1.deviceWidth, dpr1.deviceHeight, dpr1.aspectMatches, dpr1.pixelPerfect],
    [1600, 900, true, true],
  );

  const dpr2 = measureCanvasDisplay({ width: 800, height: 450 }, 2);
  assert.deepEqual(
    [dpr2.deviceWidth, dpr2.deviceHeight, dpr2.aspectMatches, dpr2.pixelPerfect],
    [1600, 900, true, true],
  );
  assert.deepEqual(
    mapCanvasPointToGuest(400, 225, {
      left: 0,
      top: 0,
      width: 800,
      height: 450,
    }),
    { x: 800, y: 450 },
  );
  assert.deepEqual(
    mapCanvasPointToGuest(-20, 1000, {
      left: 0,
      top: 0,
      width: 800,
      height: 450,
    }),
    { x: 0, y: 899 },
  );
});

test("missing VM artifacts produce a recoverable, specific launcher error", () => {
  const result = normalizeRuntimeError(
    new Error("Runtime manifest request failed with HTTP 404."),
  );
  assert.equal(result.kind, "artifacts-missing");
  assert.equal(result.recoverable, true);
  assert.match(result.message, /\/omarchy\//);
  assert.equal(PRODUCTION_WORKER_URL, "/omarchy/versions/f0020448/production-worker.mjs");
  assert.equal(RELEASE_BASE_URL, "/omarchy/versions/f0020448/");
  assert.equal(DISPLAY_WIDTH, 1600);
  assert.equal(DISPLAY_HEIGHT, 900);
});

test("serial diagnostics stay bounded", () => {
  const lines = appendDiagnosticLine(["one", "two", "three"], "four", 3);
  assert.deepEqual(lines, ["two", "three", "four"]);
});
