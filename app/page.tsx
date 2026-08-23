import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Try Omarchy — Browser VM and Native Mac VM",
  description:
    "A clear view of the real Omarchy Browser VM and accelerated Native Mac VM.",
};

const layers = [
  {
    index: "01",
    eyebrow: "Native launcher",
    title: "Omarchy Quattro.app",
    detail: "Swift + AppKit",
    description:
      "Owns macOS permissions, launches the verified VM, and maps focused Command shortcuts to guest Super.",
    accent: "coral",
  },
  {
    index: "02",
    eyebrow: "Hypervisor",
    title: "QEMU + HVF",
    detail: "ARM64 · native execution",
    description:
      "Runs guest ARM instructions directly on Apple Silicon while QEMU supplies the virtual machine.",
    accent: "blue",
  },
  {
    index: "03",
    eyebrow: "Device boundary",
    title: "VirGL + Virtio",
    detail: "ANGLE · Metal",
    description:
      "Accelerates graphics through VirGL and Metal, with host network, duplex audio, input, and storage.",
    accent: "violet",
  },
  {
    index: "04",
    eyebrow: "Guest system",
    title: "Omarchy Quattro",
    detail: "Linux · ARM64",
    description:
      "Runs the complete desktop from a pinned kernel, initramfs, and root filesystem.",
    accent: "green",
  },
];

const bootSteps = [
  ["Verify", "SHA-256 bundle identity"],
  ["Clone", "One APFS working disk per release"],
  ["Boot", "ARM64 guest through HVF"],
  ["Persist", "Keep apps, files, and settings"],
  ["Reopen", "Continue from the same disk"],
];

export default function Home() {
  return (
    <main className="architecture-page">
      <header className="architecture-nav">
        <a className="architecture-brand" href="#top" aria-label="Try Omarchy home">
          <span className="architecture-brand-mark" aria-hidden="true">
            O
          </span>
          <span>Try Omarchy</span>
        </a>
        <nav aria-label="Page navigation">
          <a href="/browser">Browser VM</a>
          <a href="#architecture">Architecture</a>
          <a href="#startup">Startup flow</a>
        </nav>
      </header>

      <section className="architecture-hero" id="top">
        <div className="architecture-kicker">
          <span className="architecture-status-dot" aria-hidden="true" />
          Apple Silicon · QEMU/HVF · native ARM64
        </div>
        <h1>
          Linux at native
          <br />
          <span>ARM speed.</span>
        </h1>
        <p>
          HVF executes ARM code directly. QEMU supplies the machine. Omarchy
          stays itself—no x86 translation and no browser runtime around the
          complete ARM64 guest.
        </p>
        <div className="architecture-runtime-picker" aria-label="Choose an Omarchy runtime">
          <a href="/browser">
            <span>Browser VM</span>
            <strong>Run fully client-side</strong>
            <small>x86_64 QEMU + WebAssembly · no installation</small>
          </a>
          <a href="#architecture">
            <span>Native Mac VM</span>
            <strong>Explore native speed</strong>
            <small>ARM64 QEMU + HVF · Apple Silicon</small>
          </a>
        </div>
      </section>

      <section className="architecture-section" id="architecture" aria-labelledby="architecture-title">
        <div className="architecture-section-heading">
          <div>
            <span className="architecture-section-number">01</span>
            <h2 id="architecture-title">System architecture</h2>
          </div>
          <p>Four layers, one direct path from Mac input to the Linux desktop.</p>
        </div>

        <div className="architecture-diagram">
          <div className="architecture-host-label">
            <span>macOS host</span>
            <span>Apple Silicon</span>
          </div>

          <div className="architecture-layer-grid">
            {layers.map((layer, position) => (
              <div className="architecture-layer-wrap" key={layer.index}>
                <article className={`architecture-layer architecture-layer--${layer.accent}`}>
                  <div className="architecture-layer-topline">
                    <span>{layer.index}</span>
                    <span className="architecture-layer-signal" aria-hidden="true" />
                  </div>
                  <p className="architecture-layer-eyebrow">{layer.eyebrow}</p>
                  <h3>{layer.title}</h3>
                  <p className="architecture-layer-detail">{layer.detail}</p>
                  <p className="architecture-layer-description">{layer.description}</p>
                </article>
                {position < layers.length - 1 && (
                  <div className="architecture-connector" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>

          <div className="architecture-foundation">
            <span>Hardware virtualization</span>
            <strong>ARM instructions run directly on the M-series CPU</strong>
            <span className="architecture-foundation-rule" aria-hidden="true" />
            <span>QEMU devices · HVF CPU · no x86 translation</span>
          </div>
        </div>
      </section>

      <section className="architecture-section architecture-startup" id="startup" aria-labelledby="startup-title">
        <div className="architecture-section-heading">
          <div>
            <span className="architecture-section-number">02</span>
            <h2 id="startup-title">From first clone to persistent return</h2>
          </div>
          <p>A verified working disk is created once, then safely reused on every launch.</p>
        </div>

        <ol className="architecture-timeline">
          {bootSteps.map(([title, detail], index) => (
            <li key={title}>
              <div className="architecture-timeline-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
            </li>
          ))}
        </ol>

        <aside className="architecture-note">
          <div className="architecture-note-icon" aria-hidden="true">⌁</div>
          <div>
            <strong>Persistent by design</strong>
            <p>
              Files, installed apps, and settings survive close and reopen. A new
              guest manifest gets a new disk identity, so one Omarchy release can
              never silently reuse another release&apos;s storage.
            </p>
          </div>
        </aside>
      </section>

      <footer className="architecture-footer">
        <span>Omarchy · macOS architecture</span>
        <span>Swift / AppKit / QEMU / HVF / VirGL / Metal / ARM64 Linux</span>
      </footer>
    </main>
  );
}
