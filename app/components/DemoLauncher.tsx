"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  advanceDesktopEvidence,
  appendDiagnosticLine,
  CAPABILITY_DEFINITIONS,
  createDesktopEvidence,
  describeCapabilityIssue,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  formatGuestIdentity,
  getPhasePresentation,
  inspectVmCapabilities,
  isGuestReadyReport,
  measureCanvasDisplay,
  normalizeRuntimeError,
  RUNTIME_BASE_URL,
  RUNTIME_MODULE_URL,
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
type CanvasMetrics = ReturnType<typeof measureCanvasDisplay>;

interface VmRuntime extends EventTarget {
  start(): Promise<unknown>;
  requestReset(): boolean;
}

type VmRuntimeConstructor = new (options: {
  baseUrl: string;
  canvas: HTMLCanvasElement;
}) => VmRuntime;

function eventDetail(event: Event): unknown {
  return (event as CustomEvent<unknown>).detail;
}

function objectDetail(event: Event): Record<string, unknown> {
  const detail = eventDetail(event);
  return detail && typeof detail === "object"
    ? (detail as Record<string, unknown>)
    : {};
}

const BOOT_STAGES = ["Runtime", "System image", "Emulator", "Desktop proof"];

export function DemoLauncher() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const machineRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<VmRuntime | null>(null);
  const runNumberRef = useRef(0);
  const desktopEvidenceRef = useRef(createDesktopEvidence());
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
    queueMicrotask(() => {
      if (!cancelled) {
        setCapabilities(inspectVmCapabilities(window) as CapabilityReport);
        setDisplayDpr(
          Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
            ? window.devicePixelRatio
            : 1,
        );
      }
    });

    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === machineRef.current);
      if (document.fullscreenElement === machineRef.current) {
        canvasRef.current?.focus({ preventScroll: true });
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      cancelled = true;
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver(() => {
      setCanvasMetrics(
        measureCanvasDisplay(canvas.getBoundingClientRect(), window.devicePixelRatio),
      );
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const unsupported = capabilities !== null && !capabilities.supported;
  const phaseView = getPhasePresentation(phase, guestReady);
  const starting =
    sessionStarted && !guestReady && phase !== "error" && phase !== "failed";

  function addDiagnostic(value: string) {
    setSerialLines((lines) => appendDiagnosticLine(lines, value));
  }

  async function handleLaunch() {
    if (!capabilities?.supported || starting || guestReady) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const runNumber = runNumberRef.current + 1;
    runNumberRef.current = runNumber;
    setSessionStarted(true);
    setGuestReady(false);
    setGuestReport(null);
    setLastFrame(null);
    desktopEvidenceRef.current = createDesktopEvidence();
    setRuntimeError(null);
    setControlMessage("");
    setSerialLines([]);
    setPhase("loading-runtime");

    try {
      const runtimeUrl = new URL(RUNTIME_MODULE_URL, window.location.href).href;
      const imported = (await import(
        /* @vite-ignore */ runtimeUrl
      )) as unknown as {
        OmarchyWasmRuntime?: VmRuntimeConstructor;
      };
      if (typeof imported.OmarchyWasmRuntime !== "function") {
        throw new Error(
          "The module at /omarchy/runtime.mjs does not export OmarchyWasmRuntime.",
        );
      }
      if (runNumber !== runNumberRef.current) return;

      const runtime = new imported.OmarchyWasmRuntime({
        baseUrl: new URL(RUNTIME_BASE_URL, window.location.href).href,
        canvas,
      });
      runtimeRef.current = runtime;

      runtime.addEventListener("phasechange", (event) => {
        if (runNumber !== runNumberRef.current) return;
        const detail = objectDetail(event);
        const nextPhase =
          typeof detail.phase === "string" ? detail.phase : "unknown";
        setPhase(nextPhase);
        if (nextPhase === "failed") {
          const failure = normalizeRuntimeError(
            detail.reason ?? "The emulator reported a failed phase.",
          );
          setRuntimeError(failure);
          addDiagnostic(`[runtime] ${failure.technical}`);
        }
      });

      runtime.addEventListener("serial", (event) => {
        if (runNumber !== runNumberRef.current) return;
        const detail = objectDetail(event);
        const stream = detail.stream === "stderr" ? "stderr" : "stdout";
        const line = typeof detail.line === "string" ? detail.line : "";
        if (line) addDiagnostic(`[${stream}] ${line}`);
      });

      runtime.addEventListener("guestframe", (event) => {
        if (runNumber !== runNumberRef.current) return;
        const detail = objectDetail(event);
        if (
          detail.source === "qemu-guest" &&
          typeof detail.sequence === "number" &&
          Number.isFinite(detail.sequence)
        ) {
          const frame = {
            sequence: detail.sequence,
            source: detail.source,
            guestWidth:
              typeof detail.guestWidth === "number"
                ? detail.guestWidth
                : undefined,
            guestHeight:
              typeof detail.guestHeight === "number"
                ? detail.guestHeight
                : undefined,
          };
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
            addDiagnostic(
              "[guest] Desktop report followed by a fresh 1600x900 guest frame; session is ready.",
            );
            canvas.focus({ preventScroll: true });
          }
        }
      });

      runtime.addEventListener("guestreport", (event) => {
        if (runNumber !== runNumberRef.current) return;
        const report = eventDetail(event);
        if (!isGuestReadyReport(report)) {
          addDiagnostic(
            "[guest] Rejected a readiness report that did not prove Omarchy, Arch x86_64, Hyprland, and the shell.",
          );
          return;
        }

        const next = advanceDesktopEvidence(desktopEvidenceRef.current, {
          type: "guestreport",
          report,
        });
        desktopEvidenceRef.current = next;
        setGuestReport(report as GuestReport);
        setGuestReady(false);
        addDiagnostic(
          "[guest] Authenticity report received; waiting for a later 1600x900 guest frame.",
        );
      });

      runtime.addEventListener("guestreporterror", (event) => {
        const detail = objectDetail(event);
        addDiagnostic(
          `[guest] Invalid readiness report: ${String(detail.error ?? "unknown parse error")}`,
        );
      });

      runtime.addEventListener("reloadrequired", (event) => {
        const detail = objectDetail(event);
        addDiagnostic(
          `[runtime] ${String(detail.reason ?? "Reload required to reset the VM.")}`,
        );
      });

      await runtime.start();
    } catch (error) {
      if (runNumber !== runNumberRef.current) return;
      const failure = normalizeRuntimeError(error);
      setRuntimeError(failure);
      setPhase("error");
      addDiagnostic(`[launcher] ${failure.technical}`);
    }
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
      setControlMessage("");
    } catch {
      setControlMessage(
        "Fullscreen was blocked. Use your browser's fullscreen control instead.",
      );
    }
  }

  function reloadSession() {
    window.location.reload();
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
                      onClick={reloadSession}
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="machine-screen">
              <canvas
                ref={canvasRef}
                className="guest-canvas"
                width={DISPLAY_WIDTH}
                height={DISPLAY_HEIGHT}
                tabIndex={0}
                aria-label="Omarchy guest display. Click to send keyboard and pointer input to the virtual machine."
                aria-describedby={sessionStarted ? "shortcut-help" : undefined}
                onPointerDown={() =>
                  canvasRef.current?.focus({ preventScroll: true })
                }
                onContextMenu={(event) => event.preventDefault()}
              >
                Your browser needs canvas support to show the Omarchy guest.
              </canvas>

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
                      onClick={reloadSession}
                    >
                      Reload and try again
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
              Reset reloads this page and destroys the current in-memory VM.
              Nothing from this session is kept.
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
