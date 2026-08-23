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
  guestReportEvidenceMatchesRelease,
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
  guestReportProvenanceMatches,
  isSelfContainedWorkerSource,
  normalizeGuestReportProvenance,
  normalizedPointerForCanvas,
  normalizeRuntimeDesktopProof,
  normalizeRuntimeGuestFrame,
  normalizeRuntimeGuestReport,
  normalizeRuntimeInputAccepted,
  validateRuntimeRelease,
} from "../public/vm/host-utils.mjs";

const FIXTURE_RELEASE_ID = "e".repeat(64);

const COLD_GUEST_REPORT_PROVENANCE = Object.freeze({
  origin: "live-guest-serial",
});

function checkpointSourceEvidence(overrides = {}) {
  return {
    normalizedGuestReportSha256: "1".repeat(64),
    reportValidationSha256: "2".repeat(64),
    checkpointFrameSha256: "3".repeat(64),
    checkpointFrameHealthSha256: "4".repeat(64),
    ...overrides,
  };
}

function checkpointGuestReportProvenance(overrides = {}) {
  return {
    origin: "checkpoint-source-evidence",
    sourceEvidence: checkpointSourceEvidence(overrides),
  };
}

function liveGuestReportEvent(report) {
  return { type: "guestreport", report, origin: "live-guest-serial" };
}

function desktopReleaseEvent(release, guestReportProvenance = COLD_GUEST_REPORT_PROVENANCE) {
  return { type: "release", release, guestReportProvenance };
}

function normalizedJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizedJsonValue(value[key])]),
  );
}

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

test("server-renders the QEMU/HVF native macOS architecture page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Try Omarchy — Browser VM and Native Mac VM<\/title>/i);
  assert.match(html, /Linux at native/);
  assert.match(html, /QEMU \+ HVF/);
  assert.match(html, /VirGL \+ Virtio/);
  assert.match(html, /Omarchy Quattro/);
  assert.match(html, /QEMU devices · HVF CPU · no x86 translation/);
  assert.match(html, /From first clone to persistent return/);
  assert.match(html, /Persistent by design/);
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

  assert.match(html, /property="og:title" content="Try Omarchy — Browser VM and Native Mac VM"/i);
  assert.match(html, /property="og:image" content="https:\/\/try\.example\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /name="twitter:image" content="https:\/\/try\.example\/og\.png"/i);

  const socialCard = await readFile(
    new URL("../public/og.png", import.meta.url),
  );
  assert.ok(socialCard.byteLength > 100_000);
});

test("browser route renders only the real client-side QEMU VM", async () => {
  const response = await render({ url: "http://localhost/browser" });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Omarchy Browser VM — fully client-side<\/title>/i);
  assert.match(html, /Real Quattro VM · No installation/);
  assert.match(html, /Real x86_64 virtual machine/);
  assert.match(html, /Nothing is installed on your computer/);
  assert.doesNotMatch(html, /Native ARM64|Virtualization\.framework|Browser Edition/);
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
  assert.match(hostSource, /normalizeRuntimeGuestReport/);
  assert.match(hostSource, /guestReportProvenance: verifiedBootstrap\.guestReportProvenance/);
  assert.match(hostUtilsSource, /Checkpoint guest report digest does not match/);
  assert.match(hostUtilsSource, /guestReportProvenanceMatches/);
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
  assert.doesNotMatch(hostSource, /readinessProbeAwaiting|sendReadinessProbe/);
  assert.match(hostSource, /normalizeRuntimeDesktopProof/);
  assert.match(hostSource, /preProofGuestFrameSequences\.has\(proof\.baselineSequence\)/);
  assert.match(hostSource, /preProofGuestFrameSequences\.has\(proof\.responseSequence\)/);
  assert.match(hostSource, /desktopProofSeen/);
  assert.match(hostSource, /frame\.sequence > desktopProofResponseSequence/);
  assert.match(hostSource, /runtimeTerminal/);
  assert.match(hostSource, /latchRuntimeTerminal\(\)/);
  assert.match(hostSource, /runtimeRunning &&[\s\S]*?desktopProofSeen/);
  assert.match(hostSource, /!desktopInteractionReady/);
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
    guestReportProvenance: COLD_GUEST_REPORT_PROVENANCE,
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: release },
      expected,
    ),
    release,
  );
  const { guestReportProvenance: ignoredProvenance, ...releaseWithoutProvenance } =
    release;
  assert.equal(ignoredProvenance, COLD_GUEST_REPORT_PROVENANCE);
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: releaseWithoutProvenance,
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
        data: {
          ...release,
          upstream: { ...release.upstream, unexpected: true },
        },
      },
      expected,
    ),
    null,
  );
  const liveReport = {
    ...data,
    ...liveGuestReportEvent(guestReport()),
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: liveReport },
      expected,
    ),
    liveReport,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...liveReport, sourceEvidence: checkpointSourceEvidence() },
      },
      expected,
    ),
    null,
  );
  const checkpointReport = {
    ...data,
    type: "guestreport",
    report: guestReport(),
    ...checkpointGuestReportProvenance(),
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: checkpointReport },
      expected,
    ),
    checkpointReport,
  );
  const {
    checkpointFrameHealthSha256: ignoredCheckpointFrameHealthSha256,
    ...incompleteSourceEvidence
  } = checkpointReport.sourceEvidence;
  assert.match(ignoredCheckpointFrameHealthSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: { ...checkpointReport, sourceEvidence: incompleteSourceEvidence },
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
        data: {
          ...checkpointReport,
          sourceEvidence: {
            ...checkpointReport.sourceEvidence,
            reportValidationSha256: "A".repeat(64),
          },
        },
      },
      expected,
    ),
    null,
  );

  const desktopProof = {
    ...data,
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256: FIXTURE_RELEASE_ID,
      challengeSha256: "c".repeat(64),
      baselineSequence: 10,
      responseSequence: 11,
      sampledPixels: 576,
      changedPixels: 29,
      dominantPixels: 547,
    },
  };
  assert.deepEqual(
    acceptVmHostMessage(
      { origin: "https://try.example", source, data: desktopProof },
      expected,
    ),
    desktopProof,
  );
  assert.equal(
    acceptVmHostMessage(
      {
        origin: "https://try.example",
        source,
        data: {
          ...desktopProof,
          proof: { ...desktopProof.proof, changedPixels: 28 },
        },
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
        data: {
          ...desktopProof,
          proof: { ...desktopProof.proof, unexpected: true },
        },
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
        data: {
          ...desktopProof,
          proof: {
            ...desktopProof.proof,
            guestAcknowledgement: "omarchy-input-ack-secret",
          },
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
    readinessProbe: false,
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
        data: { ...inputaccepted, readinessProbe: true },
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
      sampledPixels: 576,
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
          frame: { ...blackFrame.frame, nonBlackPixels: 577 },
        },
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
        data: {
          ...blackFrame,
          frame: { ...blackFrame.frame, sampledPixels: 575 },
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

test("desktop readiness requires release, report, one causal proof, then a later frame", () => {
  const report = guestReport();
  const release = releaseIdentity();
  const frame = (sequence, overrides = {}) => ({
    source: "qemu-guest",
    sequence,
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
    nonBlackPixels: 500,
    ...overrides,
  });
  const proof = {
    schemaVersion: 1,
    artifactManifestSha256: FIXTURE_RELEASE_ID,
    challengeSha256: "c".repeat(64),
    baselineSequence: 3,
    responseSequence: 4,
    sampledPixels: 576,
    changedPixels: 29,
    dominantPixels: 547,
  };

  assert.equal(isPublishableReleaseId(ACTIVE_RELEASE_ID), false);
  assert.equal(isPublishableReleaseId(FIXTURE_RELEASE_ID), true);
  assert.equal(isActiveReleaseIdentity(release), false);
  assert.equal(isActiveReleaseIdentity(release, FIXTURE_RELEASE_ID), true);
  assert.equal(guestReportMatchesRelease(report, release, FIXTURE_RELEASE_ID), true);

  let evidence = createDesktopEvidence(FIXTURE_RELEASE_ID);
  evidence = advanceDesktopEvidence(evidence, desktopReleaseEvent(release));
  evidence = advanceDesktopEvidence(evidence, liveGuestReportEvent(report));
  assert.equal(evidence.ready, false);

  const afterArbitraryInput = advanceDesktopEvidence(evidence, {
    type: "inputaccepted",
    input: { kind: "key", scancode: 40, down: true },
    readinessProbe: false,
  });
  assert.equal(afterArbitraryInput.desktopProof, null);
  assert.equal(afterArbitraryInput.ready, false);

  const beforeProofFrame = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: frame(4),
  });
  assert.equal(beforeProofFrame.ready, false);

  evidence = advanceDesktopEvidence(evidence, {
    type: "desktopproof",
    proof,
  });
  assert.equal(evidence.ready, false);

  const blackFrame = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: frame(5, { nonBlackPixels: 0 }),
  });
  assert.equal(blackFrame.ready, false);
  const wrongResolution = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: frame(5, { guestWidth: 1280 }),
  });
  assert.equal(wrongResolution.ready, false);
  const unchangedSequence = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: frame(4),
  });
  assert.equal(unchangedSequence.ready, false);

  evidence = advanceDesktopEvidence(evidence, {
    type: "guestframe",
    frame: frame(5),
  });
  assert.equal(evidence.ready, true);

  let terminal = advanceDesktopEvidence(evidence, {
    type: "terminal",
    kind: "failed",
    reason: "late runtime failure",
  });
  assert.equal(terminal.invalid, true);
  assert.equal(terminal.ready, false);
  assert.deepEqual(terminal.terminal, {
    kind: "failed",
    reason: "late runtime failure",
  });
  terminal = advanceDesktopEvidence(terminal, {
    type: "guestframe",
    frame: frame(6),
  });
  assert.equal(terminal.ready, false, "terminal evidence must be irreversible");

  let duplicateProof = createDesktopEvidence(FIXTURE_RELEASE_ID);
  duplicateProof = advanceDesktopEvidence(duplicateProof, desktopReleaseEvent(release));
  duplicateProof = advanceDesktopEvidence(duplicateProof, liveGuestReportEvent(report));
  duplicateProof = advanceDesktopEvidence(duplicateProof, { type: "desktopproof", proof });
  duplicateProof = advanceDesktopEvidence(duplicateProof, { type: "desktopproof", proof });
  duplicateProof = advanceDesktopEvidence(duplicateProof, {
    type: "guestframe",
    frame: frame(5),
  });
  assert.equal(duplicateProof.invalid, true);
  assert.equal(duplicateProof.ready, false);

  let wrongProof = createDesktopEvidence(FIXTURE_RELEASE_ID);
  wrongProof = advanceDesktopEvidence(wrongProof, desktopReleaseEvent(release));
  wrongProof = advanceDesktopEvidence(wrongProof, liveGuestReportEvent(report));
  wrongProof = advanceDesktopEvidence(wrongProof, {
    type: "desktopproof",
    proof: { ...proof, artifactManifestSha256: "d".repeat(64) },
  });
  wrongProof = advanceDesktopEvidence(wrongProof, {
    type: "guestframe",
    frame: frame(5),
  });
  assert.equal(wrongProof.invalid, true);
  assert.equal(wrongProof.ready, false);

  let wrongRelease = createDesktopEvidence(FIXTURE_RELEASE_ID);
  wrongRelease = advanceDesktopEvidence(wrongRelease, {
    ...desktopReleaseEvent({
      ...release,
      artifactManifestSha256: "d".repeat(64),
    }),
  });
  wrongRelease = advanceDesktopEvidence(wrongRelease, liveGuestReportEvent(report));
  assert.equal(wrongRelease.release, null);
  assert.equal(wrongRelease.report, null);

  let wrongReport = createDesktopEvidence(FIXTURE_RELEASE_ID);
  wrongReport = advanceDesktopEvidence(wrongReport, desktopReleaseEvent(release));
  wrongReport = advanceDesktopEvidence(wrongReport, {
    ...liveGuestReportEvent({
      ...report,
      provenance: { ...report.provenance, commit: "a".repeat(40) },
    }),
  });
  assert.equal(wrongReport.report, null);
});

test("checkpoint report provenance cannot be omitted, downgraded, mismatched, or replayed", () => {
  const report = guestReport();
  const release = releaseIdentity();
  const provenance = checkpointGuestReportProvenance();
  assert.deepEqual(normalizeGuestReportProvenance(provenance), provenance);
  assert.equal(
    guestReportProvenanceMatches(provenance, {
      ...provenance,
      sourceEvidence: {
        ...provenance.sourceEvidence,
        checkpointFrameSha256: "9".repeat(64),
      },
    }),
    false,
  );
  assert.equal(
    guestReportEvidenceMatchesRelease(
      { type: "guestreport", report, ...provenance },
      release,
      FIXTURE_RELEASE_ID,
      provenance,
    ),
    true,
  );

  const beginCheckpoint = () =>
    advanceDesktopEvidence(
      createDesktopEvidence(FIXTURE_RELEASE_ID),
      desktopReleaseEvent(release, provenance),
    );
  let missing = beginCheckpoint();
  missing = advanceDesktopEvidence(missing, {
    type: "guestreport",
    report,
    origin: "checkpoint-source-evidence",
  });
  assert.equal(missing.invalid, true);
  assert.equal(missing.report, null);

  let downgraded = beginCheckpoint();
  downgraded = advanceDesktopEvidence(
    downgraded,
    liveGuestReportEvent(report),
  );
  assert.equal(downgraded.invalid, true);
  assert.equal(downgraded.ready, false);

  let mismatched = beginCheckpoint();
  mismatched = advanceDesktopEvidence(mismatched, {
    type: "guestreport",
    report,
    ...checkpointGuestReportProvenance({
      checkpointFrameHealthSha256: "9".repeat(64),
    }),
  });
  assert.equal(mismatched.invalid, true);
  assert.equal(mismatched.report, null);

  let replayed = beginCheckpoint();
  replayed = advanceDesktopEvidence(replayed, {
    type: "guestreport",
    report,
    ...provenance,
  });
  assert.equal(replayed.report, report);
  assert.deepEqual(replayed.reportProvenance, provenance);
  replayed = advanceDesktopEvidence(replayed, {
    type: "guestreport",
    report,
    ...provenance,
  });
  assert.equal(replayed.invalid, true);
  assert.equal(replayed.ready, false);
  const afterTerminalReplay = advanceDesktopEvidence(replayed, {
    type: "guestreport",
    report,
    ...provenance,
  });
  assert.equal(afterTerminalReplay.invalid, true);
  assert.equal(afterTerminalReplay.ready, false);

  let cold = advanceDesktopEvidence(
    createDesktopEvidence(FIXTURE_RELEASE_ID),
    desktopReleaseEvent(release),
  );
  cold = advanceDesktopEvidence(cold, {
    ...liveGuestReportEvent(report),
    sourceEvidence: provenance.sourceEvidence,
  });
  assert.equal(cold.invalid, true, "cold reports reject checkpoint-only fields");
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
  assert.deepEqual(
    bootstrap.guestReportProvenance,
    COLD_GUEST_REPORT_PROVENANCE,
  );
  assert.equal(bootstrap.checkpointGuestReport, null);
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

test("checkpoint bootstrap binds the exact source report and four evidence digests", async () => {
  const workerBytes = Buffer.from("self.onmessage = () => {};\n");
  const report = guestReport();
  const normalizedGuestReportSha256 = createHash("sha256")
    .update(JSON.stringify(normalizedJsonValue(report)))
    .digest("hex");
  const sourceEvidence = checkpointSourceEvidence({
    normalizedGuestReportSha256,
  });
  const checkpointBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "omarchy-web-preboot-checkpoint",
    sourceEvidence: { guestReport: report, ...sourceEvidence },
  })}\n`);
  const checkpointSha256 = createHash("sha256")
    .update(checkpointBytes)
    .digest("hex");
  const runtimeBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    checkpoint: {
      schemaVersion: 1,
      mode: "preboot-resume",
      producer: {
        manifestArtifactPath: "checkpoint-manifest.json",
        manifestBytes: checkpointBytes.byteLength,
        manifestSha256: checkpointSha256,
        qemuBinarySha256: "5".repeat(64),
      },
    },
  })}\n`);
  const records = [
    {
      path: "production-worker.mjs",
      role: "host-worker",
      mediaType: "text/javascript",
      bytes: workerBytes.byteLength,
      sha256: createHash("sha256").update(workerBytes).digest("hex"),
    },
    {
      path: "runtime-manifest.json",
      role: "runtime-config",
      mediaType: "application/json",
      bytes: runtimeBytes.byteLength,
      sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
    },
    {
      path: "checkpoint-manifest.json",
      role: "preboot-checkpoint-metadata",
      mediaType: "application/json",
      bytes: checkpointBytes.byteLength,
      sha256: checkpointSha256,
    },
  ];
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    upstream: { ...EXPECTED_UPSTREAM },
    artifacts: records,
  })}\n`);
  const releaseId = createHash("sha256").update(manifestBytes).digest("hex");
  const bodies = new Map([
    ["artifact-manifest.json", manifestBytes],
    ["production-worker.mjs", workerBytes],
    ["runtime-manifest.json", runtimeBytes],
    ["checkpoint-manifest.json", checkpointBytes],
  ]);
  const fetchImpl = async (url) => {
    const name = new URL(url).pathname.split("/").at(-1);
    const body = bodies.get(name);
    return new Response(body, {
      status: body ? 200 : 404,
      headers: body
        ? {
            "Content-Type": name.endsWith(".json")
              ? "application/json"
              : "text/javascript",
            "Content-Length": String(body.byteLength),
          }
        : {},
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
  const expectedProvenance = checkpointGuestReportProvenance({
    normalizedGuestReportSha256,
  });
  assert.deepEqual(bootstrap.guestReportProvenance, expectedProvenance);
  assert.deepEqual(bootstrap.checkpointGuestReport, report);

  const runtimeEvent = {
    type: "guestreport",
    report,
    ...expectedProvenance,
  };
  assert.deepEqual(
    normalizeRuntimeGuestReport(runtimeEvent, bootstrap),
    {
      report,
      ...expectedProvenance,
    },
  );
  assert.equal(
    normalizeRuntimeGuestReport(
      {
        ...runtimeEvent,
        sourceEvidence: checkpointSourceEvidence({
          normalizedGuestReportSha256,
          checkpointFrameSha256: "9".repeat(64),
        }),
      },
      bootstrap,
    ),
    null,
    "a checkpoint digest mismatch must fail closed",
  );
  assert.equal(
    normalizeRuntimeGuestReport(liveGuestReportEvent(report), bootstrap),
    null,
    "a checkpoint report cannot be downgraded to live serial",
  );
  assert.equal(
    normalizeRuntimeGuestReport(
      { ...runtimeEvent, report: { ...report, generatedAt: "2026-08-15T01:02:03Z" } },
      bootstrap,
    ),
    null,
    "a different report cannot replay the checkpoint digests",
  );
});

test("runtime release, desktop-proof, frame, and input diagnostics are strict", () => {
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

  const runtimeProof = {
    type: "desktopproof",
    proof: {
      schemaVersion: 1,
      artifactManifestSha256: FIXTURE_RELEASE_ID,
      challengeSha256: "c".repeat(64),
      baselineSequence: 20,
      responseSequence: 21,
      sampledPixels: 576,
      changedPixels: 29,
      dominantPixels: 547,
    },
  };
  assert.deepEqual(
    normalizeRuntimeDesktopProof(runtimeProof, FIXTURE_RELEASE_ID),
    runtimeProof.proof,
  );
  assert.equal(
    normalizeRuntimeDesktopProof(
      {
        ...runtimeProof,
        proof: { ...runtimeProof.proof, responseSequence: 20 },
      },
      FIXTURE_RELEASE_ID,
    ),
    null,
  );
  assert.equal(
    normalizeRuntimeDesktopProof(
      { ...runtimeProof, unexpected: true },
      FIXTURE_RELEASE_ID,
    ),
    null,
  );
  assert.equal(
    normalizeRuntimeDesktopProof(runtimeProof, "d".repeat(64)),
    null,
  );
  assert.equal(
    normalizeRuntimeDesktopProof(
      {
        ...runtimeProof,
        proof: { ...runtimeProof.proof, dominantPixels: 0 },
      },
      FIXTURE_RELEASE_ID,
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
    sampledPixels: 576,
    nonBlackPixels: 4,
  };
  assert.deepEqual(normalizeRuntimeGuestFrame(runtimeFrame), {
    sequence: 9,
    source: "qemu-guest",
    guestWidth: 1600,
    guestHeight: 900,
    sampledPixels: 576,
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
  assert.equal(
    normalizeRuntimeGuestFrame({ ...runtimeFrame, sampledPixels: 575 }),
    null,
  );
  assert.equal(
    normalizeRuntimeGuestFrame({ ...runtimeFrame, guestWidth: 1280 }),
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
    new Error(
      `Production Worker request failed with HTTP 404: /omarchy/versions/${"f0020448" + "0".repeat(56)}/production-worker.mjs`,
    ),
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
