import { inspectBrowserCapabilities, formatCapabilityError, OmarchyWasmRuntime } from "./runtime.mjs";

const button = document.querySelector("#start");
const canvas = document.querySelector("#canvas");
const status = document.querySelector("#status");
const serial = document.querySelector("#serial");
const requestedAssetBase = new URLSearchParams(location.search).get("assets");
const assetBase = requestedAssetBase && !requestedAssetBase.includes("://")
  ? requestedAssetBase
  : "../dist/";
const phaseLabels = {
  "loading-manifest": "Loading the pinned runtime configuration…",
  "loading-guest": "Loading the guest image into browser memory…",
  "starting-emulator": "Starting x86_64 QEMU with the SDL canvas…",
  running: "Emulator started; waiting for guest-agent readiness evidence.",
  failed: "The emulator aborted. Open serial diagnostics for details.",
};

const capabilityReport = inspectBrowserCapabilities();
if (!capabilityReport.supported) {
  button.disabled = true;
  status.textContent = `Unsupported browser/runtime headers: ${formatCapabilityError(capabilityReport)}.`;
}

button.addEventListener("click", async () => {
  button.disabled = true;
  const runtime = new OmarchyWasmRuntime({ baseUrl: assetBase, canvas });
  runtime.addEventListener("phasechange", ({ detail }) => {
    status.textContent = phaseLabels[detail.phase] ?? detail.phase;
  });
  runtime.addEventListener("serial", ({ detail }) => {
    serial.textContent = `${serial.textContent}${detail.line}\n`.slice(-32000);
  });
  runtime.addEventListener("runtimediagnostic", ({ detail }) => {
    canvas.dataset.runtimeStage = detail.stage;
    if (!detail.line) {
      serial.textContent = `${serial.textContent}[host] ${detail.stage} ${JSON.stringify(detail)}\n`.slice(-32000);
    }
  });
  runtime.addEventListener("guestreport", ({ detail }) => {
    const architecture = detail.guestArchitecture ?? detail.environment?.architecture ?? "unknown architecture";
    status.textContent = `Guest-agent report received (${architecture}); awaiting a later guest frame and input acknowledgement.`;
  });
  runtime.addEventListener("guestframe", ({ detail }) => {
    canvas.dataset.guestFrameSequence = String(detail.sequence);
    canvas.dataset.framebufferSource = detail.source;
  });

  try {
    await runtime.start();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
});
