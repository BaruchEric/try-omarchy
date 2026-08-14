"use client";

import { useState } from "react";

type Capability = {
  label: string;
  available: boolean | null;
};

function inspectCapabilities(): Capability[] {
  return [
    { label: "WebAssembly", available: typeof WebAssembly !== "undefined" },
    {
      label: "Threads",
      available:
        window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined",
    },
    {
      label: "Canvas",
      available: typeof HTMLCanvasElement !== "undefined",
    },
  ];
}

const CHECKING_CAPABILITIES: Capability[] = [
  { label: "WebAssembly", available: null },
  { label: "Threads", available: null },
  { label: "Canvas", available: null },
];

export function DemoLauncher() {
  const [expanded, setExpanded] = useState(false);
  const [capabilities, setCapabilities] = useState(CHECKING_CAPABILITIES);
  const ready = capabilities.every((capability) => capability.available);

  function handleLaunch() {
    setCapabilities(inspectCapabilities());
    setExpanded(true);
  }

  return (
    <main className="demo-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Omarchy demo home">
          OMARCHY
        </a>
        <div className="header-status" aria-label="Demo runtime status">
          <span className="status-light" aria-hidden="true" />
          Browser edition
        </div>
      </header>

      <section className="hero" id="top">
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
            then close the tab when you’re done.
          </p>

          <div className="actions">
            <button
              className="launch-button"
              type="button"
              onClick={handleLaunch}
              aria-describedby="launch-note"
            >
              <span>Start Omarchy</span>
              <span aria-hidden="true">↗</span>
            </button>
            <p id="launch-note">Nothing is installed on your computer.</p>
          </div>
        </div>

        <div className="machine-column">
          <div className="machine-frame" data-expanded={expanded}>
            <div className="machine-toolbar">
              <span>OMARCHY / LIVE SESSION</span>
              <span>1600 × 900</span>
            </div>
            <div className="machine-screen">
              <div className="boot-mark" aria-hidden="true">
                <span />
                <span />
              </div>
              <p className="screen-kicker">Real x86_64 virtual machine</p>
              <p className="screen-title">
                {expanded ? "Runtime image coming online" : "Ready when you are"}
              </p>
              <div className="runtime-checks" aria-label="Browser capabilities">
                {capabilities.map((capability) => (
                  <span key={capability.label}>
                    <i
                      data-ready={
                        capability.available === null
                          ? "checking"
                          : capability.available
                      }
                      aria-hidden="true"
                    />
                    {capability.label}
                  </span>
                ))}
              </div>
              {expanded && (
                <p className="runtime-message" role="status">
                  {ready
                    ? "Graphics runtime is being connected."
                    : "This browser needs cross-origin isolation for the VM."}
                </p>
              )}
            </div>
            <div className="machine-footer">
              <span>Arch · Hyprland · Quickshell</span>
              <span>Disposable session</span>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <p>THE OPERATING SYSTEM IS THE DEMO.</p>
        <p>Runs locally in this tab.</p>
      </footer>
    </main>
  );
}
