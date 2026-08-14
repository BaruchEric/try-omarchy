"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  acceptVmHostMessage,
  createVmHostCommand,
  createVmRun,
  createVmRunNonce,
} from "./vm-host-protocol.mjs";
import {
  advanceDesktopEvidence,
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

type GuestFrame = {
  sequence: number;
  source: string;
  guestWidth?: number;
  guestHeight?: number;
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

const BOOT_STAGES = ["Runtime", "System image", "Emulator", "Desktop proof"];

export function DemoLauncher() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const machineRef = useRef<HTMLDivElement>(null);
  const activeRunRef = useRef<VmRun | null>(null);
  const desktopEvidenceRef = useRef(createDesktopEvidence());
  const [hostRun, setHostRun] = useState<VmRun | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [phase, setPhase] = useState("idle");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [guestReady, setGuestReady] = useState(false);
  const [guestReport, setGuestReport] = useState<GuestReport | null>(null);
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

    queueMicrotask(() => {
      if (!cancelled) {
        setCapabilities(inspectVmCapabilities(window) as CapabilityReport);
        readDpr();
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
          if (nextPhase === "failed") {
            const failure = normalizeRuntimeError(
              message.reason ?? "The emulator reported a failed phase.",
            );
            setRuntimeError(failure);
            addHostDiagnostic(`[runtime] ${failure.technical}`);
          }
          break;
        }
        case "serial":
          addHostDiagnostic(`[${message.stream}] ${message.line}`);
          break;
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
              "[guest] Desktop report followed by a fresh 1600x900 guest frame; session is ready.",
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
          });
          desktopEvidenceRef.current = next;
          setGuestReport(report as GuestReport);
          setGuestReady(false);
          addHostDiagnostic(
            "[guest] Authenticity report received; waiting for a later 1600x900 guest frame.",
          );
          break;
        }
        case "reload":
          addHostDiagnostic(
            `[runtime] ${message.reason} Use Reset to replace this isolated VM document.`,
          );
          break;
        case "error": {
          const failure = normalizeRuntimeError(
            message.technical ?? message.message,
          );
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

  const unsupported = capabilities !== null && !capabilities.supported;
  const phaseView = getPhasePresentation(phase, guestReady);
  const starting =
    sessionStarted && !guestReady && phase !== "error" && phase !== "failed";

  function addDiagnostic(value: string) {
    setSerialLines((lines) => appendDiagnosticLine(lines, value));
  }

  function beginFreshRun(isReset: boolean) {
    try {
      const nextRun = createVmRun(
        activeRunRef.current,
        createVmRunNonce(window.crypto),
      ) as VmRun;
      activeRunRef.current = nextRun;
      if (iframeRef.current) iframeRef.current.src = "about:blank";
      setHostRun(nextRun);
      setSessionStarted(true);
      setGuestReady(false);
      setGuestReport(null);
      setLastFrame(null);
      setCanvasMetrics(null);
      desktopEvidenceRef.current = createDesktopEvidence();
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

  function handleLaunch() {
    if (!capabilities?.supported || starting || guestReady) return;
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
    beginFreshRun(true);
  }

  const launchLabel =
    capabilities === null
      ? "Start Omarchy"
      : unsupported
        ? "Browser unsupported"
        : "Start Omarchy";
  const identity = guestReport
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
            data-state={guestReady ? "ready" : runtimeError ? "error" : "idle"}
            aria-hidden="true"
          />
          {guestReady
            ? "Guest verified"
            : sessionStarted
              ? phaseView.title
              : "Browser edition"}
        </div>
      </header>

      <section className="hero" id="top" data-session-active={sessionStarted}>
        <div className="hero-copy">
          <p className="eyebrow">Run the real system · No installation</p>
          <h1>
            Try Omarchy
            <br />
            in your browser.
          </h1>
          <p className="lede">
            A disposable, client-side Omarchy machine. Explore the real
            Hyprland desktop, themes, terminal, and keyboard-driven workflow,
            then close the tab when you&apos;re done.
          </p>

          <div className="actions">
            <button
              className="launch-button"
              type="button"
              onClick={handleLaunch}
              disabled={capabilities === null || unsupported}
              aria-describedby="launch-note compatibility-note"
            >
              <span>{launchLabel}</span>
              <span aria-hidden="true">↗</span>
            </button>
            <p id="launch-note">Nothing is installed on your computer.</p>
          </div>
          <p className="compatibility-note" id="compatibility-note" role="status">
            {unsupported
              ? `Missing: ${describeCapabilityIssue(capabilities)}. Use a current Chromium-based browser with page isolation enabled.`
              : "Requires WebAssembly threads, shared memory, and OffscreenCanvas."}
          </p>
        </div>

        <div className="machine-column">
          <div
            className="machine-frame"
            ref={machineRef}
            data-active={sessionStarted}
            data-ready={guestReady}
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
                {sessionStarted && (
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
                  <p className="screen-kicker">Real x86_64 virtual machine</p>
                  <h2 className="screen-title">{phaseView.title}</h2>
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
                </div>
              )}

              {sessionStarted && !guestReady && !runtimeError && (
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
                      onClick={resetSession}
                    >
                      Start a fresh session
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="machine-footer">
              <span>{guestReady ? identity : "Arch · Hyprland · Quickshell"}</span>
              <span>
                {guestReady ? "Guest report received" : "Disposable session"}
              </span>
            </div>

            {sessionStarted && (
              <div className="session-tools">
                <div className="shortcut-help" id="shortcut-help">
                  <strong>Click the desktop first.</strong>
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
              Reset destroys this isolated in-memory VM and starts a fresh one
              without reloading the page. Nothing from this session is kept.
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
