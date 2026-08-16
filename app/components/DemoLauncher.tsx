"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  launchNativeHelper,
  probeNativeHelper,
} from "./runtime-selection.mjs";
import {
  acceptVmHostMessage,
  createVmHostCommand,
  createVmRun,
  createVmRunNonce,
} from "./vm-host-protocol.mjs";
import {
  advanceDesktopEvidence,
  ACTIVE_RELEASE_ID,
  appendDiagnosticLine,
  CAPABILITY_DEFINITIONS,
  createDesktopEvidence,
  describeCapabilityIssue,
  DISPLAY_WIDTH,
  formatGuestIdentity,
  getPhasePresentation,
  inspectVmCapabilities,
  isGuestReadyReport,
  normalizeRuntimeError,
} from "./vm-ui-state.mjs";

type CapabilityReport = {
  supported: boolean;
  checks: Record<string, boolean>;
  missing: string[];
};

type GuestReport = Record<string, unknown> & {
  provenance?: Record<string, unknown>;
};

type GuestReportOrigin =
  | "live-guest-serial"
  | "live-hibernation-serial"
  | "checkpoint-source-evidence";

type HibernationResumeEvidence = {
  schemaVersion: 1;
  checkpointMode: "guest-hibernation-resume";
  descriptorSha256: string;
  markerSha256: string;
  rendererReportSha256: string;
  renderer: "virgl";
  sourceBootId: string;
  swapUuid: string;
  kernelEvidence: string[];
  runtimeDisplay: "sdl,gl=es,show-cursor=on";
  derivedInitramfsSha256: string;
};

type GuestFrame = {
  sequence: number;
  source: string;
  guestWidth: number;
  guestHeight: number;
  sampledPixels: number;
  nonBlackPixels: number;
};

type DesktopProof = {
  schemaVersion: 1;
  artifactManifestSha256: string;
  challengeSha256: string;
  baselineSequence: number;
  responseSequence: number;
  sampledPixels: number;
  changedPixels: number;
  dominantPixels: number;
};

type ReleaseIdentity = {
  upstream: {
    repository: string;
    commit: string;
    version: string;
    treeSha256: string;
  };
  artifactManifestSha256: string;
};

type RuntimeErrorInfo = ReturnType<typeof normalizeRuntimeError>;
type CanvasMetrics = {
  backingWidth: number;
  backingHeight: number;
  cssWidth: number;
  cssHeight: number;
  deviceWidth: number;
  deviceHeight: number;
  devicePixelRatio: number;
  pixelPerfect: boolean;
  aspectMatches: boolean;
};

type VmRun = {
  generation: number;
  nonce: string;
  src: string;
};

type NativeRuntime = {
  kind: "native-arm64";
  endpoint: string;
  helperVersion: string;
  bundleIdentity: string;
  upstream: {
    repository: string;
    commit: string;
    version: string;
    treeSha256: string;
    channel: "quattro";
  };
  display: "native-window";
  supportsHostBoundResume: true;
};

type NativeLaunchState = "idle" | "launching" | "launched" | "error";

const BOOT_STAGES = ["Runtime", "System image", "Emulator", "Desktop proof"];

export function DemoLauncher() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const machineRef = useRef<HTMLDivElement>(null);
  const activeRunRef = useRef<VmRun | null>(null);
  const desktopEvidenceRef = useRef(
    createDesktopEvidence(ACTIVE_RELEASE_ID),
  );
  const [hostRun, setHostRun] = useState<VmRun | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [nativeRuntime, setNativeRuntime] = useState<NativeRuntime | null>(null);
  const [nativeProbeComplete, setNativeProbeComplete] = useState(false);
  const [nativeLaunchState, setNativeLaunchState] =
    useState<NativeLaunchState>("idle");
  const [phase, setPhase] = useState("idle");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [guestReady, setGuestReady] = useState(false);
  const [guestReport, setGuestReport] = useState<GuestReport | null>(null);
  const [guestReportOrigin, setGuestReportOrigin] =
    useState<GuestReportOrigin | null>(null);
  const [releaseIdentity, setReleaseIdentity] =
    useState<ReleaseIdentity | null>(null);
  const [lastFrame, setLastFrame] = useState<GuestFrame | null>(null);
  const [serialLines, setSerialLines] = useState<string[]>([]);
  const [runtimeError, setRuntimeError] = useState<RuntimeErrorInfo | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const [canvasMetrics, setCanvasMetrics] = useState<CanvasMetrics | null>(null);
  const [displayDpr, setDisplayDpr] = useState(1);

  useEffect(() => {
    let cancelled = false;
    function readDpr() {
      setDisplayDpr(
        Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1,
      );
    }

    function focusGuest() {
      const activeRun = activeRunRef.current;
      const hostWindow = iframeRef.current?.contentWindow;
      if (!activeRun || !hostWindow) return;
      hostWindow.postMessage(
        createVmHostCommand("focus", activeRun.nonce),
        window.location.origin,
      );
    }

    queueMicrotask(async () => {
      if (!cancelled) {
        setCapabilities(inspectVmCapabilities(window) as CapabilityReport);
        readDpr();
      }
      try {
        const selected = await probeNativeHelper({
          fetchImpl: window.fetch.bind(window),
          crypto: window.crypto,
        });
        if (!cancelled) setNativeRuntime(selected as NativeRuntime | null);
      } finally {
        if (!cancelled) setNativeProbeComplete(true);
      }
    });

    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === machineRef.current);
      if (document.fullscreenElement === machineRef.current) {
        focusGuest();
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("resize", readDpr);
    return () => {
      cancelled = true;
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("resize", readDpr);
    };
  }, []);

  useEffect(() => {
    function addHostDiagnostic(value: string) {
      setSerialLines((lines) => appendDiagnosticLine(lines, value));
    }

    function latchDesktopTerminal(kind: string, reason: unknown) {
      desktopEvidenceRef.current = advanceDesktopEvidence(
        desktopEvidenceRef.current,
        {
          type: "terminal",
          kind,
          reason: String(reason ?? "The VM session ended."),
        },
      );
      setGuestReady(false);
    }

    function handleHostMessage(event: MessageEvent) {
      const activeRun = activeRunRef.current;
      const hostWindow = iframeRef.current?.contentWindow;
      if (!activeRun || !hostWindow) return;

      const message = acceptVmHostMessage(event, {
        expectedOrigin: window.location.origin,
        expectedSource: hostWindow,
        expectedNonce: activeRun.nonce,
      });
      if (!message) return;

      switch (message.type) {
        case "ready":
          hostWindow.postMessage(
            createVmHostCommand("start", activeRun.nonce),
            window.location.origin,
          );
          break;
        case "phase": {
          const nextPhase = message.phase as string;
          setPhase(nextPhase);
          if (nextPhase === "failed" || nextPhase === "exited") {
            const failure = normalizeRuntimeError(
              message.reason ?? `The emulator entered ${nextPhase}.`,
            );
            latchDesktopTerminal(nextPhase, failure.technical);
            setRuntimeError(failure);
            addHostDiagnostic(`[runtime] ${failure.technical}`);
          }
          break;
        }
        case "serial":
          addHostDiagnostic(`[${message.stream}] ${message.line}`);
          break;
        case "release": {
          const release = {
            upstream: message.upstream,
            artifactManifestSha256: message.artifactManifestSha256,
          } as ReleaseIdentity;
          const next = advanceDesktopEvidence(desktopEvidenceRef.current, {
            type: "release",
            release,
            guestReportProvenance: message.guestReportProvenance,
          });
          desktopEvidenceRef.current = next;
          if (next.release !== release) {
            setGuestReady(false);
            addHostDiagnostic(
              "[release] Rejected a release identity that did not match the compile-time artifact-manifest SHA-256 and pinned Omarchy source.",
            );
            break;
          }
          setReleaseIdentity(release);
          addHostDiagnostic(
            `[release] Verified artifact manifest ${release.artifactManifestSha256}.`,
          );
          break;
        }
        case "guestframe": {
          const frame = message.frame as GuestFrame;
          setLastFrame(frame);
          const previous = desktopEvidenceRef.current;
          const next = advanceDesktopEvidence(previous, {
            type: "guestframe",
            frame,
          });
          desktopEvidenceRef.current = next;
          if (!previous.ready && next.ready && next.report) {
            setGuestReport(next.report as GuestReport);
            setGuestReady(true);
            setRuntimeError(null);
            addHostDiagnostic(
              "[guest] Release-matched report, guest-acknowledged desktop transition, and a later 1600x900 guest frame verified; session is ready.",
            );
            hostWindow.postMessage(
              createVmHostCommand("focus", activeRun.nonce),
              window.location.origin,
            );
          }
          break;
        }
        case "guestreport": {
          const report = message.report;
          if (!isGuestReadyReport(report)) {
            addHostDiagnostic(
              "[guest] Rejected a readiness report that did not prove Omarchy, Arch x86_64, Hyprland, and the shell.",
            );
            break;
          }
          const next = advanceDesktopEvidence(desktopEvidenceRef.current, {
            type: "guestreport",
            report,
            origin: message.origin,
            ...(message.sourceEvidence === undefined
              ? {}
              : { sourceEvidence: message.sourceEvidence }),
            ...(message.resume === undefined
              ? {}
              : { resume: message.resume }),
          });
          desktopEvidenceRef.current = next;
          if (next.report !== report) {
            setGuestReady(false);
            addHostDiagnostic(
              "[guest] Rejected an authentic-looking report because its repository, commit, version, or source-tree SHA-256 did not exactly match the verified active release.",
            );
            break;
          }
          setGuestReport(report as GuestReport);
          setGuestReportOrigin(message.origin as GuestReportOrigin);
          setGuestReady(false);
          addHostDiagnostic(
            `[guest] Authenticity report from ${message.origin} matched the active release; waiting for the Worker's guest-acknowledged desktop-transition proof.`,
          );
          break;
        }
        case "hibernationresume": {
          const evidence = message.evidence as HibernationResumeEvidence;
          const next = advanceDesktopEvidence(desktopEvidenceRef.current, {
            type: "hibernationresume",
            evidence,
          });
          desktopEvidenceRef.current = next;
          setGuestReady(false);
          if (next.hibernationResume !== evidence) {
            addHostDiagnostic(
              "[resume] Rejected duplicate, out-of-order, malformed, or descriptor-mismatched hibernation evidence.",
            );
            break;
          }
          addHostDiagnostic(
            `[resume] Authenticated VirGL hibernation resume for descriptor ${evidence.descriptorSha256}; waiting for a fresh live guest report.`,
          );
          break;
        }
        case "desktopproof": {
          const proof = message.proof as DesktopProof;
          const next = advanceDesktopEvidence(desktopEvidenceRef.current, {
            type: "desktopproof",
            proof,
          });
          desktopEvidenceRef.current = next;
          setGuestReady(false);
          if (next.desktopProof !== proof) {
            addHostDiagnostic(
              "[guest] Rejected duplicate, out-of-order, malformed, or release-mismatched desktop proof.",
            );
            break;
          }
          addHostDiagnostic(
            `[guest] Guest-acknowledged desktop proof verified (${proof.changedPixels}/${proof.sampledPixels} changed samples); waiting for a frame later than sequence ${proof.responseSequence}.`,
          );
          break;
        }
        case "inputaccepted": {
          addHostDiagnostic(
            `[input] QEMU queued a ${String(message.event.kind)} event (diagnostic only).`,
          );
          break;
        }
        case "reload":
          latchDesktopTerminal("reload", message.reason);
          addHostDiagnostic(
            `[runtime] ${message.reason} Use Reset to replace this isolated VM document.`,
          );
          break;
        case "error": {
          const failure = normalizeRuntimeError(
            message.technical ?? message.message,
          );
          latchDesktopTerminal("error", failure.technical);
          setRuntimeError(failure);
          setPhase("error");
          addHostDiagnostic(`[host] ${failure.technical}`);
          break;
        }
        case "metrics":
          setCanvasMetrics(message.metrics as CanvasMetrics);
          break;
      }
    }

    window.addEventListener("message", handleHostMessage);
    return () => {
      window.removeEventListener("message", handleHostMessage);
      activeRunRef.current = null;
    };
  }, []);

  const nativeSelected = nativeRuntime !== null;
  const nativeLaunched = nativeLaunchState === "launched";
  const displayReady = guestReady || nativeLaunched;
  const unsupported =
    nativeProbeComplete && !nativeSelected && capabilities !== null && !capabilities.supported;
  const phaseView = getPhasePresentation(phase, guestReady);
  const starting = nativeSelected
    ? nativeLaunchState === "launching"
    : sessionStarted && !guestReady && phase !== "error" && phase !== "failed";

  function addDiagnostic(value: string) {
    setSerialLines((lines) => appendDiagnosticLine(lines, value));
  }

  function beginFreshRun(isReset: boolean) {
    try {
      const nextRun = createVmRun(
        activeRunRef.current,
        createVmRunNonce(window.crypto),
        ACTIVE_RELEASE_ID,
      ) as VmRun;
      activeRunRef.current = nextRun;
      if (iframeRef.current) iframeRef.current.src = "about:blank";
      setHostRun(nextRun);
      setNativeLaunchState("idle");
      setSessionStarted(true);
      setGuestReady(false);
      setGuestReport(null);
      setGuestReportOrigin(null);
      setReleaseIdentity(null);
      setLastFrame(null);
      setCanvasMetrics(null);
      desktopEvidenceRef.current = createDesktopEvidence(ACTIVE_RELEASE_ID);
      setRuntimeError(null);
      setControlMessage("");
      setSerialLines(
        isReset
          ? [
              "[launcher] Previous VM document destroyed; starting a fresh disposable session.",
            ]
          : [],
      );
      setPhase("loading-runtime");
    } catch (error) {
      const failure = normalizeRuntimeError(error);
      setRuntimeError(failure);
      setPhase("error");
      addDiagnostic(`[launcher] ${failure.technical}`);
    }
  }

  async function handleLaunch() {
    if (!nativeProbeComplete || starting || displayReady) return;
    if (nativeRuntime) {
      setSessionStarted(true);
      setNativeLaunchState("launching");
      setRuntimeError(null);
      setPhase("native-launching");
      setSerialLines([
        "[launcher] Verified the local Apple Silicon helper and exact Quattro ARM64 bundle.",
      ]);
      try {
        const receipt = await launchNativeHelper(nativeRuntime, {
          fetchImpl: window.fetch.bind(window),
          crypto: window.crypto,
        });
        setNativeLaunchState("launched");
        setPhase("native-running");
        addDiagnostic(
          `[native] Opened ARM64 bundle ${receipt.bundleIdentity} in a hardware-virtualized macOS window.`,
        );
      } catch (error) {
        const failure = normalizeRuntimeError(error);
        setNativeLaunchState("error");
        setRuntimeError(failure);
        setPhase("error");
        addDiagnostic(`[native] ${failure.technical}`);
      }
      return;
    }
    if (!capabilities?.supported) return;
    beginFreshRun(false);
  }

  async function handleFullscreen() {
    const machine = machineRef.current;
    if (!machine) return;

    try {
      if (document.fullscreenElement === machine) {
        await document.exitFullscreen();
      } else {
        await machine.requestFullscreen();
      }
      const activeRun = activeRunRef.current;
      const hostWindow = iframeRef.current?.contentWindow;
      if (activeRun && hostWindow) {
        hostWindow.postMessage(
          createVmHostCommand("focus", activeRun.nonce),
          window.location.origin,
        );
      }
      setControlMessage("");
    } catch {
      setControlMessage(
        "Fullscreen was blocked. Use your browser's fullscreen control instead.",
      );
    }
  }

  function resetSession() {
    if (nativeSelected) return;
    beginFreshRun(true);
  }

  function runGuestShortcut(command: "menu" | "terminal") {
    const activeRun = activeRunRef.current;
    const hostWindow = iframeRef.current?.contentWindow;
    if (!guestReady || !activeRun || !hostWindow) return;
    hostWindow.postMessage(
      createVmHostCommand(command, activeRun.nonce),
      window.location.origin,
    );
    setControlMessage("");
  }

  const launchLabel =
    !nativeProbeComplete || capabilities === null
      ? "Start Omarchy"
      : nativeSelected
        ? "Open native Omarchy"
        : unsupported
          ? "Browser unsupported"
          : "Start Omarchy";
  const identity = nativeSelected
    ? `Omarchy ${nativeRuntime.upstream.version} · Quattro · ARM64`
    : guestReport
      ? formatGuestIdentity(guestReport)
      : "Guest evidence pending";
  const frameResolution =
    lastFrame?.guestWidth && lastFrame.guestHeight
      ? `${lastFrame.guestWidth} × ${lastFrame.guestHeight}`
      : "Waiting for guest frame";
  const displayStyle = {
    // The frame has a one-pixel border on each side; add those CSS pixels so
    // the canvas content itself maps exactly to the guest's device pixels.
    "--guest-max-css-width": `${DISPLAY_WIDTH / displayDpr + 2}px`,
    "--guest-canvas-css-width": `${DISPLAY_WIDTH / displayDpr}px`,
  } as CSSProperties;

  return (
    <main
      className="demo-shell"
      data-session-active={sessionStarted}
      style={displayStyle}
    >
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Omarchy demo home">
          OMARCHY
        </a>
        <div className="header-status" aria-label="Demo runtime status">
          <span
            className="status-light"
            data-state={displayReady ? "ready" : runtimeError ? "error" : "idle"}
            aria-hidden="true"
          />
          {displayReady
            ? nativeSelected
              ? "Native ARM64 active"
              : "Guest verified"
            : sessionStarted
              ? phaseView.title
              : nativeSelected
                ? "Apple Silicon edition"
                : "Browser edition"}
        </div>
      </header>

      <section className="hero" id="top" data-session-active={sessionStarted}>
        <div className="hero-copy">
          <p className="eyebrow">
            {nativeSelected
              ? "Run the real system · Apple Silicon native speed"
              : "Run the real system · No installation"}
          </p>
          <h1>
            Try Omarchy
            <br />
            in your browser.
          </h1>
          <p className="lede">
            {nativeSelected
              ? "A disposable ARM64 Quattro machine, accelerated by Apple Virtualization.framework. It opens in a native window so the desktop can run at host-class speed."
              : "A disposable, client-side Omarchy machine. Explore the real Hyprland desktop, themes, terminal, and keyboard-driven workflow, then close the tab when you’re done."}
          </p>

          <div className="actions">
            <button
              className="launch-button"
              type="button"
              onClick={handleLaunch}
              disabled={
                !nativeProbeComplete ||
                (!nativeSelected && (capabilities === null || unsupported)) ||
                starting ||
                displayReady
              }
              aria-describedby="launch-note compatibility-note"
            >
              <span>{launchLabel}</span>
              <span aria-hidden="true">↗</span>
            </button>
            <p id="launch-note">
              {nativeSelected
                ? "Uses the verified local helper already running on this Mac."
                : "Nothing is installed on your computer."}
            </p>
          </div>
          <p className="compatibility-note" id="compatibility-note" role="status">
            {nativeSelected
              ? "Selected ARM64 Quattro with native CPU virtualization, Virtio graphics, and host-bound resume."
              : unsupported
              ? `Missing: ${describeCapabilityIssue(capabilities)}. Use a current Chromium-based browser with page isolation enabled.`
              : nativeProbeComplete
                ? "Native helper not detected; using the x86_64 WebAssembly fallback."
                : "Checking for the Apple Silicon helper before selecting a runtime."}
          </p>
        </div>

        <div className="machine-column">
          <div
            className="machine-frame"
            ref={machineRef}
            data-active={sessionStarted}
            data-ready={displayReady}
          >
            <div className="machine-toolbar">
              <div className="machine-title">
                <span>OMARCHY / LIVE SESSION</span>
                <span className="machine-phase" aria-live="polite">
                  {phaseView.title}
                </span>
              </div>
              <div className="machine-controls">
                <span className="resolution-label">1600 × 900</span>
                {sessionStarted && !nativeSelected && (
                  <>
                    <button
                      className="machine-control"
                      type="button"
                      onClick={handleFullscreen}
                      aria-pressed={isFullscreen}
                    >
                      {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    </button>
                    <button
                      className="machine-control machine-control--reset"
                      type="button"
                      onClick={resetSession}
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="machine-screen">
              {hostRun && (
                <iframe
                  key={hostRun.generation}
                  ref={iframeRef}
                  className="guest-host"
                  src={hostRun.src}
                  title="Omarchy disposable virtual machine"
                  aria-describedby="shortcut-help"
                  sandbox="allow-same-origin allow-scripts"
                  referrerPolicy="same-origin"
                />
              )}

              {!sessionStarted && (
                <div className="screen-overlay screen-overlay--idle">
                  <div className="boot-mark" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                  <p className="screen-kicker">
                    {nativeSelected
                      ? "Native ARM64 virtual machine"
                      : "Real x86_64 virtual machine"}
                  </p>
                  <h2 className="screen-title">{phaseView.title}</h2>
                  {nativeSelected ? (
                    <div
                      className="runtime-checks"
                      aria-label="Native runtime capabilities"
                    >
                      {[
                        "Apple virtualization",
                        "ARM64 Quattro",
                        "Native Virtio display",
                        "Host-bound resume",
                      ].map((label) => (
                        <span key={label}>
                          <i data-ready="true" aria-hidden="true" />
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div
                      className="runtime-checks"
                      aria-label="Browser capabilities"
                    >
                      {CAPABILITY_DEFINITIONS.map((capability) => {
                        const available = capabilities?.checks[capability.key];
                        return (
                          <span key={capability.key}>
                            <i
                              data-ready={
                                capabilities === null ? "checking" : available
                              }
                              aria-hidden="true"
                            />
                            {capability.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {sessionStarted && nativeSelected && !nativeLaunched && !runtimeError && (
                <div className="screen-overlay screen-overlay--booting">
                  <div className="boot-status" role="status" aria-live="polite">
                    <div>
                      <p className="screen-kicker">Native launch</p>
                      <h2 className="screen-title">{phaseView.title}</h2>
                      <p className="screen-detail">{phaseView.detail}</p>
                    </div>
                  </div>
                </div>
              )}

              {sessionStarted && nativeSelected && nativeLaunched && !runtimeError && (
                <div className="screen-overlay screen-overlay--idle" role="status">
                  <div className="boot-mark" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                  <p className="screen-kicker">ARM64 · Apple Virtualization.framework</p>
                  <h2 className="screen-title">Native window opened</h2>
                  <p className="screen-detail">
                    Use the Omarchy window that just opened. Its display and input
                    stay native instead of crossing the x86-to-WebAssembly emulator.
                  </p>
                </div>
              )}

              {sessionStarted && !nativeSelected && !guestReady && !runtimeError && (
                <div className="screen-overlay screen-overlay--booting">
                  <div className="boot-status" role="status" aria-live="polite">
                    <div>
                      <p className="screen-kicker">
                        Live boot · stage {phaseView.stage} of 4
                      </p>
                      <h2 className="screen-title">{phaseView.title}</h2>
                      <p className="screen-detail">{phaseView.detail}</p>
                    </div>
                    <ol className="boot-progress" aria-label="VM boot progress">
                      {BOOT_STAGES.map((stage, index) => {
                        const stageNumber = index + 1;
                        const state =
                          phaseView.stage > stageNumber
                            ? "complete"
                            : phaseView.stage === stageNumber
                              ? "active"
                              : "pending";
                        return (
                          <li key={stage} data-state={state}>
                            <span aria-hidden="true" />
                            {stage}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </div>
              )}

              {runtimeError && (
                <div className="screen-overlay screen-overlay--error" role="alert">
                  <div className="error-panel">
                    <p className="screen-kicker">Session not started</p>
                    <h2 className="screen-title">{runtimeError.title}</h2>
                    <p className="screen-detail">{runtimeError.message}</p>
                    <button
                      className="inline-action"
                      type="button"
                      onClick={nativeSelected ? handleLaunch : resetSession}
                    >
                      {nativeSelected ? "Try opening the native window again" : "Start a fresh session"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="machine-footer">
              <span>{displayReady ? identity : "Arch · Hyprland · Quickshell"}</span>
              <span>
                {nativeLaunched
                  ? "Native CPU · native display"
                  : guestReady
                  ? "Release · input · display verified"
                  : "Disposable session"}
              </span>
            </div>

            {sessionStarted && !nativeSelected && (
              <div className="session-tools">
                <div className="shortcut-help" id="shortcut-help">
                  <strong>Explore the real desktop.</strong>
                  <button
                    className="shortcut-action"
                    type="button"
                    disabled={!guestReady}
                    onClick={() => runGuestShortcut("menu")}
                  >
                    Open Omarchy menu
                  </button>
                  <button
                    className="shortcut-action"
                    type="button"
                    disabled={!guestReady}
                    onClick={() => runGuestShortcut("terminal")}
                  >
                    Open terminal
                  </button>
                  <span>
                    <kbd>Super</kbd> + <kbd>Space</kbd> Omarchy menu
                  </span>
                  <span>
                    <kbd>Super</kbd> + <kbd>Enter</kbd> Terminal
                  </span>
                  <span>
                    <kbd>Super</kbd> + <kbd>W</kbd> Close window
                  </span>
                  <small>
                    Browser-reserved shortcuts may work best in fullscreen.
                  </small>
                </div>

                <details className="diagnostics">
                  <summary>
                    Diagnostics
                    <span>{serialLines.length} lines</span>
                  </summary>
                  <div className="diagnostic-facts">
                    <span>
                      <b>Runtime</b>
                      {phase}
                    </span>
                    <span>
                      <b>Guest</b>
                      {identity}
                    </span>
                    <span>
                      <b>Guest evidence</b>
                      {guestReportOrigin ?? "waiting for authenticated provenance"}
                    </span>
                    <span>
                      <b>Release manifest</b>
                      {releaseIdentity
                        ? releaseIdentity.artifactManifestSha256
                        : "waiting for verified identity"}
                    </span>
                    <span>
                      <b>Frame</b>
                      {lastFrame
                        ? `#${lastFrame.sequence} · ${frameResolution}`
                        : frameResolution}
                    </span>
                    <span>
                      <b>Canvas fit</b>
                      {canvasMetrics
                        ? `${Math.round(canvasMetrics.cssWidth)} × ${Math.round(canvasMetrics.cssHeight)} CSS px @ ${canvasMetrics.devicePixelRatio}× DPR · ${canvasMetrics.pixelPerfect ? "1:1 device pixels" : "scaled"}`
                        : "measuring"}
                    </span>
                    <span>
                      <b>Isolation</b>
                      {capabilities?.checks.crossOriginIsolated
                        ? "active"
                        : "unavailable"}
                    </span>
                  </div>
                  <pre aria-label="VM serial output">
                    {serialLines.length
                      ? serialLines.join("\n")
                      : "No serial output yet."}
                  </pre>
                </details>
              </div>
            )}

            <p className="control-message" role="status">
              {controlMessage}
            </p>
          </div>
          {sessionStarted && (
            <p className="disposable-note">
              {nativeSelected
                ? "The ARM64 VM runs locally in its native macOS window. Its saved resume state is bound to this exact Mac and guest bundle."
                : "Reset destroys this isolated in-memory VM and starts a fresh one without reloading the page. Nothing from this session is kept."}
            </p>
          )}
        </div>
      </section>

      <footer className="site-footer">
        <p>THE OPERATING SYSTEM IS THE DEMO.</p>
        <p>Runs locally in this tab.</p>
      </footer>
    </main>
  );
}
