import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
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
  ACTIVE_RELEASE_ID,
  ACTIVE_UPSTREAM,
  appendDiagnosticLine,
  createDesktopEvidence,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getPhasePresentation,
  guestReportMatchesRelease,
  inspectVmCapabilities,
  isActiveReleaseIdentity,
  isGuestReadyReport,
  isPublishableReleaseId,
  mapCanvasPointToGuest,
  measureCanvasDisplay,
  normalizeRuntimeError,
  PRODUCTION_WORKER_URL,
  RELEASE_BASE_URL,
} from "../app/components/vm-ui-state.mjs";
import {
  EXPECTED_UPSTREAM,
  fetchVerifiedWorkerBootstrap,
  isSelfContainedWorkerSource,
  normalizedPointerForCanvas,
  normalizeRuntimeGuestFrame,
  normalizeRuntimeInputAccepted,
  validateRuntimeRelease,
} from "../public/vm/host-utils.mjs";

const FIXTURE_RELEASE_ID = "e".repeat(64);

function guestReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:00:00Z",
    provenance: { ...ACTIVE_UPSTREAM },
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
        stdout: `${ACTIVE_UPSTREAM.version}\n`,
      },
    ],
    configs: [
      {
        path: "/usr/share/omarchy/shell/shell.qml",
        sha256: "c".repeat(64),
        origin: "omarchy-upstream",
      },
    ],
    ...overrides,
  };
}

function releaseIdentity(releaseId = FIXTURE_RELEASE_ID) {
  return {
    upstream: { ...ACTIVE_UPSTREAM },
    artifactManifestSha256: releaseId,
  };
}

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
  const hostUtilsSource = await readFile(
    new URL("../public/vm/host-utils.mjs", import.meta.url),
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
  assert.match(hostSource, /fetchVerifiedWorkerBootstrap/);
  assert.match(hostSource, /new Blob\(\[verifiedBootstrap\.workerBytes\]/);
  assert.match(hostSource, /new Worker\(runtimeWorkerBlobUrl/);
  assert.match(hostSource, /expectedReleaseId: releaseId/);
  assert.match(hostUtilsSource, /Production Worker request failed with HTTP/);
  assert.match(hostSource, /canvas\.transferControlToOffscreen\(\)/);
  assert.match(hostSource, /runtimeWorker\.postMessage\([\s\S]*?\[offscreen\]/);
  assert.match(hostSource, /`\/omarchy\/versions\/\$\{releaseId\}\/`/);
  assert.match(hostSource, /kind: "key"/);
  assert.match(hostSource, /kind: "pointer"/);
  assert.match(hostSource, /kind: "wheel"/);
  assert.doesNotMatch(hostSource, /OmarchyWasmRuntime|qemu\.data|load\.js/);
  assert.match(hostSource, /event\.source === window\.parent/);
  assert.match(hostSource, /event\.origin === window\.location\.origin/);
  assert.match(hostSource, /lostpointercapture/);
  assert.match(hostSource, /releasePointerButtons/);
  assert.match(hostSource, /readinessProbeAwaiting/);
  assert.match(hostSource, /\["start", "focus", "menu", "terminal"\]/);
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

  const release = {
    ...data,
    type: "release",
    ...releaseIdentity(),
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: release },
      expected,
    ),
    release,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: {
          ...release,
          upstream: { ...release.upstream, unexpected: true },
        },
      },
      expected,
    ),
    null,
  );

  const inputaccepted = {
    ...data,
    type: "inputaccepted",
    event: { kind: "pointer", x: 16384, y: 16384, buttons: 0 },
    readinessProbe: true,
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: inputaccepted },
      expected,
    ),
    inputaccepted,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...inputaccepted, readinessProbe: "yes" },
      },
      expected,
    ),
    null,
  );

  const blackFrame = {
    ...data,
    type: "guestframe",
    frame: {
      sequence: 1,
      source: "qemu-guest",
      guestWidth: 1600,
      guestHeight: 900,
      sampledPixels: 1440,
      nonBlackPixels: 0,
    },
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: blackFrame },
      expected,
    ),
    blackFrame,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: {
          ...blackFrame,
          frame: { ...blackFrame.frame, nonBlackPixels: 1441 },
        },
      },
      expected,
    ),
    null,
  );
});

test("reset lifecycle creates a new iframe generation and rejects stale runs", () => {
  const firstNonce = "first_run_12345678901234567890";
  const secondNonce = "second_run_1234567890123456789";
  const first = createVmRun(null, firstNonce, FIXTURE_RELEASE_ID);
  const second = createVmRun(first, secondNonce, FIXTURE_RELEASE_ID);
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
  assert.match(second.src, new RegExp(`release=${FIXTURE_RELEASE_ID}`));
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
  assert.equal(createVmHostCommand("menu", second.nonce).type, "menu");
  assert.equal(createVmHostCommand("terminal", second.nonce).type, "terminal");
  assert.throws(
    () => createVmRun(second, firstNonce, "0".repeat(64)),
    /published 64-hex active release ID/,
  );
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
  assert.equal(
    isGuestReadyReport({
      ...readyReport,
      commands: readyReport.commands.map((command) =>
        command.argv.join(" ") === "hyprctl monitors -j"
          ? { ...command, stdout: "[]\n" }
          : command,
      ),
    }),
    false,
  );
  assert.equal(
    isGuestReadyReport({
      ...readyReport,
      commands: readyReport.commands.map((command) =>
        command.argv.join(" ") === "hyprctl monitors -j"
          ? {
              ...command,
              stdout:
                '[{"width":1600,"height":900},{"width":1600,"height":900}]\n',
            }
          : command,
      ),
    }),
    false,
  );
  assert.equal(
    isGuestReadyReport({
      ...readyReport,
      commands: readyReport.commands.map((command) =>
        command.argv.join(" ") === "omarchy-version"
          ? { ...command, stdout: "4.0.0-malicious\n" }
          : command,
      ),
    }),
    false,
  );
  assert.equal(
    isGuestReadyReport({
      ...readyReport,
      commands: readyReport.commands.map((command) =>
        command.argv.join(" ") === "omarchy-version"
          ? { ...command, stdout: "4.0.0-2\n" }
          : command,
      ),
    }),
    true,
  );
});

test("desktop readiness requires release match, exact QEMU probe acceptance, then a later non-black frame", () => {
  const report = guestReport();
  const release = releaseIdentity();
  const frame = {
    source: "qemu-guest",
    sequence: 1,
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 1440,
    nonBlackPixels: 5,
  };
  const probe = { kind: "pointer", x: 16384, y: 16384, buttons: 0 };

  assert.equal(isPublishableReleaseId(ACTIVE_RELEASE_ID), false);
  assert.equal(isPublishableReleaseId(FIXTURE_RELEASE_ID), true);
  assert.equal(isActiveReleaseIdentity(release), false);
  assert.equal(isActiveReleaseIdentity(release, FIXTURE_RELEASE_ID), true);
  assert.equal(guestReportMatchesRelease(report, release, FIXTURE_RELEASE_ID), true);

  let evidence = createDesktopEvidence(FIXTURE_RELEASE_ID);
  evidence = advanceDesktopEvidence(evidence, { type: "release", release });
  evidence = advanceDesktopEvidence(evidence, { type: "guestreport", report });
  assert.equal(evidence.ready, false);

  const afterArbitraryInput = advanceDesktopEvidence(evidence, {
    type: "inputaccepted",
    input: { kind: "key", scancode: 40, down: true },
    readinessProbe: false,
  });
  assert.equal(afterArbitraryInput.input, null);
  assert.equal(afterArbitraryInput.ready, false);

  const afterMislabeledInput = advanceDesktopEvidence(evidence, {
    type: "inputaccepted",
    input: { ...probe, x: 16383 },
    readinessProbe: true,
  });
  assert.equal(afterMislabeledInput.input, null);

  evidence = advanceDesktopEvidence(evidence, {
    type: "inputaccepted",
    input: probe,
    readinessProbe: true,
  });
  assert.equal(evidence.ready, false);

  const blackFrame = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: { ...frame, nonBlackPixels: 0 },
  });
  assert.equal(blackFrame.ready, false);
  const wrongResolution = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: { ...frame, guestWidth: 1280 },
  });
  assert.equal(wrongResolution.ready, false);

  evidence = advanceDesktopEvidence(evidence, { type: "guestframe", frame });
  assert.equal(evidence.ready, true);

  let wrongRelease = createDesktopEvidence(FIXTURE_RELEASE_ID);
  wrongRelease = advanceDesktopEvidence(wrongRelease, {
    type: "release",
    release: {
      ...release,
      artifactManifestSha256: "d".repeat(64),
    },
  });
  wrongRelease = advanceDesktopEvidence(wrongRelease, {
    type: "guestreport",
    report,
  });
  assert.equal(wrongRelease.release, null);
  assert.equal(wrongRelease.report, null);

  let wrongReport = createDesktopEvidence(FIXTURE_RELEASE_ID);
  wrongReport = advanceDesktopEvidence(wrongReport, { type: "release", release });
  wrongReport = advanceDesktopEvidence(wrongReport, {
    type: "guestreport",
    report: {
      ...report,
      provenance: { ...report.provenance, commit: "a".repeat(40) },
    },
  });
  assert.equal(wrongReport.report, null);
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

  const letterboxed = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(normalizedPointerForCanvas(500, 100, letterboxed), null);
  assert.deepEqual(
    normalizedPointerForCanvas(500, 100, letterboxed, { clamp: true }),
    { x: 0.5, y: 0 },
  );
  assert.deepEqual(
    normalizedPointerForCanvas(1200, 500, letterboxed, { clamp: true }),
    { x: 1, y: 0.5 },
  );
});

test("verified bootstrap pins exact manifest bytes and Worker bytes before Blob execution", async () => {
  const workerBytes = Buffer.from(
    "self.addEventListener('message', () => {});\n",
  );
  const workerSha256 = createHash("sha256").update(workerBytes).digest("hex");
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        upstream: { ...EXPECTED_UPSTREAM, license: "MIT" },
        artifacts: [
          {
            path: "production-worker.mjs",
            role: "host-worker",
            mediaType: "text/javascript",
            bytes: workerBytes.byteLength,
            sha256: workerSha256,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const releaseId = createHash("sha256").update(manifestBytes).digest("hex");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = String(url).endsWith("artifact-manifest.json")
      ? manifestBytes
      : workerBytes;
    return new Response(body, {
      headers: {
        "Content-Type": String(url).endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/javascript; charset=utf-8",
        "Content-Length": String(body.byteLength),
      },
    });
  };

  const bootstrap = await fetchVerifiedWorkerBootstrap({
    releaseBaseUrl: new URL(
      `https://try.example/omarchy/versions/${releaseId}/`,
    ),
    expectedReleaseId: releaseId,
    fetchImpl,
    cryptoScope: webcrypto,
  });
  assert.equal(bootstrap.artifactManifestSha256, releaseId);
  assert.equal(bootstrap.workerArtifact.sha256, workerSha256);
  assert.deepEqual(bootstrap.upstream, EXPECTED_UPSTREAM);
  assert.deepEqual(Buffer.from(bootstrap.workerBytes), workerBytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[1].init.cache, "force-cache");

  await assert.rejects(
    fetchVerifiedWorkerBootstrap({
      releaseBaseUrl: new URL(
        `https://try.example/omarchy/versions/${"a".repeat(64)}/`,
      ),
      expectedReleaseId: "a".repeat(64),
      fetchImpl,
      cryptoScope: webcrypto,
    }),
    /does not match the active release ID/,
  );
  const tamperedWorker = Buffer.alloc(workerBytes.byteLength, 0x20);
  await assert.rejects(
    fetchVerifiedWorkerBootstrap({
      releaseBaseUrl: new URL(
        `https://try.example/omarchy/versions/${releaseId}/`,
      ),
      expectedReleaseId: releaseId,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("artifact-manifest.json")) {
          return fetchImpl(url, init);
        }
        return new Response(tamperedWorker, {
          headers: {
            "Content-Type": "text/javascript",
            "Content-Length": String(tamperedWorker.byteLength),
          },
        });
      },
      cryptoScope: webcrypto,
    }),
    /SHA-256 differs from the artifact manifest/,
  );
  await assert.rejects(
    fetchVerifiedWorkerBootstrap({
      releaseBaseUrl: new URL(
        `https://try.example/omarchy/versions/${"a".repeat(64)}/`,
      ),
      expectedReleaseId: releaseId,
      fetchImpl,
      cryptoScope: webcrypto,
    }),
    /release URL does not match/,
  );
  assert.equal(isSelfContainedWorkerSource("import './worker-input.mjs';"), false);
  assert.equal(
    isSelfContainedWorkerSource("export { input } from './input.mjs';"),
    false,
  );
  assert.equal(
    isSelfContainedWorkerSource("const loaded = import(absoluteUrl);"),
    true,
  );
});

test("runtime release, frame, and accepted-input payloads are strict", () => {
  const expected = releaseIdentity();
  assert.deepEqual(
    validateRuntimeRelease({ type: "release", ...expected }, expected),
    expected,
  );
  assert.equal(
    validateRuntimeRelease(
      { type: "release", ...expected, unexpected: true },
      expected,
    ),
    null,
  );

  const runtimeFrame = {
    type: "guestframe",
    sequence: 9,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    timestamp: 123.5,
    sampledPixels: 1440,
    nonBlackPixels: 4,
  };
  assert.deepEqual(normalizeRuntimeGuestFrame(runtimeFrame), {
    sequence: 9,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 1440,
    nonBlackPixels: 4,
  });
  assert.equal(
    normalizeRuntimeGuestFrame({ ...runtimeFrame, timestamp: Number.NaN }),
    null,
  );
  assert.equal(
    normalizeRuntimeGuestFrame({ ...runtimeFrame, unexpected: true }),
    null,
  );

  assert.deepEqual(
    normalizeRuntimeInputAccepted({
      type: "inputaccepted",
      event: { kind: "pointer", x: 16384, y: 16384, buttons: 0 },
    }),
    { kind: "pointer", x: 16384, y: 16384, buttons: 0 },
  );
  assert.equal(
    normalizeRuntimeInputAccepted({
      type: "inputaccepted",
      event: { kind: "key", scancode: 999, down: true },
    }),
    null,
  );
});

test("missing VM artifacts produce a recoverable, specific launcher error", () => {
  const result = normalizeRuntimeError(
    new Error("Runtime manifest request failed with HTTP 404."),
  );
  assert.equal(result.kind, "artifacts-missing");
  assert.equal(result.recoverable, true);
  assert.match(result.message, /\/omarchy\//);
  assert.equal(
    PRODUCTION_WORKER_URL,
    `/omarchy/versions/${ACTIVE_RELEASE_ID}/production-worker.mjs`,
  );
  assert.equal(RELEASE_BASE_URL, `/omarchy/versions/${ACTIVE_RELEASE_ID}/`);
  const missingWorker = normalizeRuntimeError(
    new Error("Production Worker request failed with HTTP 404: /omarchy/versions/f0020448/production-worker.mjs"),
  );
  assert.equal(missingWorker.kind, "artifacts-missing");
  assert.match(missingWorker.message, /artifact upload/i);
  assert.equal(DISPLAY_WIDTH, 1600);
  assert.equal(DISPLAY_HEIGHT, 900);
});

test("serial diagnostics stay bounded", () => {
  const lines = appendDiagnosticLine(["one", "two", "three"], "four", 3);
  assert.deepEqual(lines, ["two", "three", "four"]);
});
