"use client";

import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import Link from "next/link";

import {
  APP_DEFINITIONS,
  BROWSER_EDITION_VERSION,
  browserDesktopReducer,
  createBrowserDesktopState,
  KEYBINDINGS,
  ROOT_MENU,
  runBrowserEditionCommand,
  summarizeFrameCadence,
  THEMES,
} from "./browser-state.mjs";
import styles from "./QuattroBrowser.module.css";

type AppId = keyof typeof APP_DEFINITIONS;
type ThemeId = keyof typeof THEMES;
type DesktopWindow = {
  id: string;
  app: AppId;
  workspace: number;
  openedAt: number;
};

const QUICK_APPS: AppId[] = [
  "terminal",
  "files",
  "editor",
  "browser",
  "themes",
  "keybindings",
];

export function QuattroBrowser() {
  const [desktop, dispatch] = useReducer(
    browserDesktopReducer,
    undefined,
    createBrowserDesktopState,
  );
  const [clock, setClock] = useState("--:--");
  const [menuQuery, setMenuQuery] = useState("");
  const [notification, setNotification] = useState(
    "Welcome to the Quattro Browser Edition preview",
  );
  const [cadence, setCadence] = useState<ReturnType<typeof summarizeFrameCadence> | null>(null);
  const menuInputRef = useRef<HTMLInputElement>(null);
  const windowCounter = useRef(2);
  const openedCounter = useRef(2);

  const theme = THEMES[desktop.theme as ThemeId] ?? THEMES["tokyo-night"];
  const visibleWindows = desktop.windows.filter(
    (window: DesktopWindow) => window.workspace === desktop.workspace,
  );

  const themeVariables = {
    "--qb-accent": theme.accent,
    "--qb-selection": theme.selection,
    "--qb-muted": theme.muted,
    "--qb-bg": theme.background,
    "--qb-dark-bg": theme.darkBackground,
    "--qb-darker-bg": theme.darkerBackground,
    "--qb-lighter-bg": theme.lighterBackground,
    "--qb-fg": theme.foreground,
    "--qb-dark-fg": theme.darkForeground,
    "--qb-bright-fg": theme.brightForeground,
    "--qb-red": theme.red,
    "--qb-yellow": theme.yellow,
    "--qb-green": theme.green,
    "--qb-cyan": theme.cyan,
    "--qb-blue": theme.blue,
    "--qb-magenta": theme.magenta,
  } as CSSProperties;

  function openApp(app: AppId) {
    dispatch({
      type: "open-app",
      app,
      id: `${app}-${windowCounter.current++}`,
      openedAt: openedCounter.current++,
    });
  }

  function setTheme(nextTheme: ThemeId) {
    dispatch({ type: "set-theme", theme: nextTheme });
    setNotification(`Theme changed to ${THEMES[nextTheme].label}`);
  }

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("omarchy-browser-theme");
    if (storedTheme && THEMES[storedTheme as ThemeId]) {
      dispatch({ type: "set-theme", theme: storedTheme });
    }

    function updateClock() {
      setClock(
        new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date()),
      );
    }
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("omarchy-browser-theme", desktop.theme);
  }, [desktop.theme]);

  useEffect(() => {
    if (!desktop.menuOpen) return;
    const frame = window.requestAnimationFrame(() => menuInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [desktop.menuOpen]);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => setNotification(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [notification]);

  useEffect(() => {
    let animationFrame = 0;
    let startedAt = 0;
    let previousAt = 0;
    let durations: number[] = [];

    function sample(now: number) {
      if (document.visibilityState !== "visible") {
        startedAt = now;
        previousAt = now;
        durations = [];
        animationFrame = window.requestAnimationFrame(sample);
        return;
      }
      if (!startedAt) {
        startedAt = now;
        previousAt = now;
      } else {
        durations.push(now - previousAt);
        previousAt = now;
      }
      const elapsed = now - startedAt;
      if (elapsed >= 2_000) {
        setCadence(summarizeFrameCadence(durations, elapsed));
        startedAt = now;
        previousAt = now;
        durations = [];
      }
      animationFrame = window.requestAnimationFrame(sample);
    }

    animationFrame = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const superKey = event.metaKey;
      const menuKey = (superKey || event.ctrlKey) && event.code === "Space";
      if (menuKey) {
        event.preventDefault();
        dispatch({ type: "toggle-menu" });
        return;
      }
      if (!superKey) {
        if (event.key === "Escape") dispatch({ type: "close-menu" });
        return;
      }

      const number = Number(event.key);
      if (number >= 1 && number <= 4) {
        event.preventDefault();
        dispatch({
          type: event.shiftKey ? "move-focused-window" : "switch-workspace",
          workspace: number,
        });
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        openApp("terminal");
      } else if (event.key.toLowerCase() === "f" && event.shiftKey) {
        event.preventDefault();
        openApp("files");
      } else if (event.key.toLowerCase() === "n" && event.shiftKey) {
        event.preventDefault();
        openApp("editor");
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        dispatch({ type: "close-window" });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        dispatch({ type: "cycle-focus", direction: -1 });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        dispatch({ type: "cycle-focus", direction: 1 });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const menuItems = useMemo(() => {
    const query = menuQuery.trim().toLowerCase();
    const rootItems = ROOT_MENU.map((item) => ({ ...item, type: "menu" as const }));
    const apps = QUICK_APPS.map((app) => ({
      id: app,
      icon: APP_DEFINITIONS[app].icon,
      label: APP_DEFINITIONS[app].title,
      app,
      type: "app" as const,
    }));
    return [...rootItems, ...apps].filter((item) =>
      query ? `${item.id} ${item.label}`.toLowerCase().includes(query) : item.type === "menu",
    );
  }, [menuQuery]);

  function activateMenuItem(item: (typeof menuItems)[number]) {
    if (item.app && APP_DEFINITIONS[item.app as AppId]) {
      openApp(item.app as AppId);
      setMenuQuery("");
      return;
    }
    if (item.id === "apps") {
      setMenuQuery("app:");
      return;
    }
    if (item.id === "learn") openApp("keybindings");
    else if (item.id === "style") openApp("themes");
    else if (item.id === "setup") openApp("files");
    else if (item.id === "about") openApp("about");
    else {
      setNotification(`${item.label} is represented by curated Browser Edition actions`);
      dispatch({ type: "close-menu" });
    }
  }

  function handleTerminalEffect(effect: string | null) {
    if (!effect) return;
    if (effect === "menu") dispatch({ type: "toggle-menu" });
    else if (effect.startsWith("open:")) openApp(effect.slice(5) as AppId);
    else if (effect.startsWith("theme:")) setTheme(effect.slice(6) as ThemeId);
  }

  return (
    <main
      className={styles.desktop}
      style={themeVariables}
      data-theme={desktop.theme}
      data-frame-fps={cadence ? cadence.fps.toFixed(1) : "pending"}
      data-performance={cadence ? (cadence.passesMinimum ? "pass" : "fail") : "measuring"}
    >
      <div className={styles.wallpaper} aria-hidden="true">
        <span className={styles.wallpaperOrb} />
        <span className={styles.wallpaperGrid} />
      </div>

      <header className={styles.bar}>
        <button
          className={styles.menuButton}
          type="button"
          onClick={() => dispatch({ type: "toggle-menu" })}
          aria-label="Open Omarchy menu"
        >
          <span className={styles.omarchyMark}>O</span>
        </button>
        <nav className={styles.workspaces} aria-label="Workspaces">
          {[1, 2, 3, 4].map((workspace) => (
            <button
              key={workspace}
              type="button"
              data-active={desktop.workspace === workspace}
              data-occupied={desktop.windows.some(
                (window: DesktopWindow) => window.workspace === workspace,
              )}
              onClick={() => dispatch({ type: "switch-workspace", workspace })}
              aria-label={`Workspace ${workspace}`}
            >
              {workspace}
            </button>
          ))}
        </nav>
        <div className={styles.activeTitle}>
          {visibleWindows.find(
            (window: DesktopWindow) => window.id === desktop.focusedWindowId,
          )?.app
            ? APP_DEFINITIONS[
                visibleWindows.find(
                  (window: DesktopWindow) => window.id === desktop.focusedWindowId,
                )!.app
              ].title
            : "Desktop"}
        </div>
        <div className={styles.barStatus}>
          <span className={styles.browserBadge}>Browser Edition</span>
          <span
            className={styles.fpsBadge}
            data-pass={cadence?.passesMinimum ?? false}
            title="Measured browser animation cadence"
          >
            {cadence ? `${Math.round(cadence.fps)} FPS` : "FPS…"}
          </span>
          <span title="Client-side runtime">WASM</span>
          <span aria-label="Network connected">NET</span>
          <span>{clock}</span>
        </div>
      </header>

      <section
        className={styles.windowGrid}
        data-count={Math.min(visibleWindows.length, 4)}
        aria-label={`Workspace ${desktop.workspace}`}
      >
        {visibleWindows.map((window: DesktopWindow) => (
          <article
            key={window.id}
            className={styles.window}
            data-focused={window.id === desktop.focusedWindowId}
            onPointerDown={() => dispatch({ type: "focus-window", id: window.id })}
          >
            <header className={styles.windowHeader}>
              <div>
                <span className={styles.appIcon}>{APP_DEFINITIONS[window.app].icon}</span>
                <span>{APP_DEFINITIONS[window.app].title}</span>
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: "close-window", id: window.id })}
                aria-label={`Close ${APP_DEFINITIONS[window.app].title}`}
              >
                ×
              </button>
            </header>
            <div className={styles.windowBody}>
              <AppContent
                app={window.app}
                theme={desktop.theme as ThemeId}
                onOpen={openApp}
                onTheme={setTheme}
                onTerminalEffect={handleTerminalEffect}
              />
            </div>
          </article>
        ))}
        {visibleWindows.length === 0 ? (
          <div className={styles.emptyWorkspace}>
            <span>Workspace {desktop.workspace}</span>
            <strong>SUPER + RETURN</strong>
            <small>Open a terminal</small>
          </div>
        ) : null}
      </section>

      {desktop.menuOpen ? (
        <div className={styles.menuScrim} onPointerDown={() => dispatch({ type: "close-menu" })}>
          <section
            className={styles.menuPanel}
            aria-label="Omarchy menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className={styles.menuSearch}>
              <span>⌕</span>
              <input
                ref={menuInputRef}
                value={menuQuery === "app:" ? "" : menuQuery}
                onChange={(event) => setMenuQuery(event.target.value)}
                placeholder={menuQuery === "app:" ? "Search apps…" : "Search Omarchy…"}
                aria-label="Search Omarchy menu"
              />
              <kbd>ESC</kbd>
            </div>
            <div className={styles.menuRows}>
              {(menuQuery === "app:"
                ? QUICK_APPS.map((app) => ({
                    id: app,
                    icon: APP_DEFINITIONS[app].icon,
                    label: APP_DEFINITIONS[app].title,
                    app,
                    type: "app" as const,
                  }))
                : menuItems
              ).map((item) => (
                <button key={`${item.type}-${item.id}`} type="button" onClick={() => activateMenuItem(item)}>
                  <span>{item.icon}</span>
                  <strong>{item.label}</strong>
                  <small>{item.app ? "launch" : "›"}</small>
                </button>
              ))}
            </div>
            <footer>
              <span>Official Quattro menu hierarchy</span>
              {menuQuery === "app:" ? (
                <button type="button" onClick={() => setMenuQuery("")}>Back</button>
              ) : (
                <span>SUPER + SPACE</span>
              )}
            </footer>
          </section>
        </div>
      ) : null}

      {notification ? (
        <div className={styles.notification} role="status">
          <span />
          {notification}
        </div>
      ) : null}
      <Link className={styles.exitLink} href="/">Exit demo</Link>
    </main>
  );
}

function AppContent({
  app,
  theme,
  onOpen,
  onTheme,
  onTerminalEffect,
}: {
  app: AppId;
  theme: ThemeId;
  onOpen: (app: AppId) => void;
  onTheme: (theme: ThemeId) => void;
  onTerminalEffect: (effect: string | null) => void;
}) {
  if (app === "terminal") {
    return <Terminal theme={theme} onEffect={onTerminalEffect} />;
  }
  if (app === "welcome") {
    return (
      <div className={styles.welcome}>
        <p className={styles.windowEyebrow}>Omarchy Quattro · Browser Edition</p>
        <h1>Your operating system is your interface.</h1>
        <p>
          Explore Quattro&apos;s keyboard-first workflow, tiling, workspaces, menu,
          themes and terminal without installing a machine image.
        </p>
        <div className={styles.welcomeActions}>
          <button type="button" onClick={() => onOpen("terminal")}>Open terminal</button>
          <button type="button" onClick={() => onOpen("keybindings")}>Learn shortcuts</button>
        </div>
        <dl className={styles.runtimeFacts}>
          <div><dt>Source</dt><dd>Official Quattro</dd></div>
          <div><dt>Rendering</dt><dd>Browser native</dd></div>
          <div><dt>State</dt><dd>Local to this browser</dd></div>
        </dl>
      </div>
    );
  }
  if (app === "files") return <Files />;
  if (app === "editor") return <Editor />;
  if (app === "browser") return <Manual />;
  if (app === "themes") {
    return (
      <div className={styles.themePicker}>
        <p className={styles.windowEyebrow}>Style · Theme</p>
        <h2>Choose the system theme</h2>
        <div>
          {(Object.entries(THEMES) as [ThemeId, (typeof THEMES)[ThemeId]][]).map(
            ([id, candidate]) => (
              <button key={id} type="button" data-active={theme === id} onClick={() => onTheme(id)}>
                <span style={{ background: candidate.background }}>
                  <i style={{ background: candidate.accent }} />
                  <i style={{ background: candidate.foreground }} />
                  <i style={{ background: candidate.selection }} />
                </span>
                <strong>{candidate.label}</strong>
                <small>{theme === id ? "Active" : "Apply"}</small>
              </button>
            ),
          )}
        </div>
      </div>
    );
  }
  if (app === "keybindings") {
    return (
      <div className={styles.keybindings}>
        <p className={styles.windowEyebrow}>Learn · Keybindings</p>
        <h2>Keyboard first, always</h2>
        <div>
          {KEYBINDINGS.map(([keys, label]) => (
            <p key={keys}><kbd>{keys}</kbd><span>{label}</span></p>
          ))}
        </div>
        <small>On macOS, Control+Space is provided as a browser fallback for Super+Space.</small>
      </div>
    );
  }
  return (
    <div className={styles.about}>
      <div className={styles.aboutMark}>O</div>
      <p className={styles.windowEyebrow}>About Omarchy</p>
      <h2>Quattro, adapted for the browser</h2>
      <p>
        This experimental distribution derives its interaction contract, menu,
        themes and workflow from the official MIT-licensed Omarchy source.
      </p>
      <code>f0020448ca87329199de7cb12f2015ebc4a3e5e7</code>
      <small>{BROWSER_EDITION_VERSION}</small>
    </div>
  );
}

function Terminal({ theme, onEffect }: { theme: ThemeId; onEffect: (effect: string | null) => void }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([
    "Omarchy Quattro Browser Edition",
    "Type 'help' for available commands. This is the client-side userspace preview.",
    "",
  ]);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = runBrowserEditionCommand(input, { theme });
    if (result.effect === "clear") setHistory([]);
    else setHistory((lines) => [...lines, `omarchy@browser ~ $ ${input}`, ...result.output]);
    setInput("");
    onEffect(result.effect);
  }

  return (
    <div className={styles.terminal} onPointerDown={() => inputRef.current?.focus()}>
      <div className={styles.terminalOutput}>
        {history.map((line, index) => <div key={`${index}-${line}`}>{line || "\u00a0"}</div>)}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="browser-terminal-input">omarchy@browser <span>~</span> $</label>
        <input
          ref={inputRef}
          id="browser-terminal-input"
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Terminal command"
        />
        <button type="submit" aria-label="Run terminal command">↵</button>
      </form>
    </div>
  );
}

function Files() {
  const folders = ["Desktop", "Documents", "Downloads", "Projects"];
  return (
    <div className={styles.files}>
      <aside>
        <strong>Places</strong>
        <button type="button" data-active="true">Home</button>
        <button type="button">Recent</button>
        <button type="button">Starred</button>
      </aside>
      <section>
        <header><span>/home/omarchy</span><small>5 items</small></header>
        <div>
          {folders.map((folder) => <button key={folder} type="button"><i />{folder}</button>)}
          <button type="button"><i data-file="true" />README.md</button>
        </div>
      </section>
    </div>
  );
}

function Editor() {
  return (
    <div className={styles.editor}>
      <aside><span>README.md</span><span>bindings.lua</span><span>colors.toml</span></aside>
      <div>
        <header>README.md <span>×</span></header>
        <textarea
          aria-label="Editor"
          defaultValue={"# Omarchy Browser Edition\n\nPerformance is part of the experience.\n\n- Super + Space opens the Omarchy menu\n- Super + Return opens a terminal\n- Super + 1–4 changes workspace\n"}
        />
        <footer>NORMAL <span>markdown · utf-8 · 6 lines</span></footer>
      </div>
    </div>
  );
}

function Manual() {
  return (
    <div className={styles.manual}>
      <header><span>‹</span><span>›</span><div>omarchy.org/manual</div></header>
      <article>
        <p className={styles.windowEyebrow}>Omarchy Manual</p>
        <h2>Beautiful, modern and opinionated.</h2>
        <p>
          Omarchy turns a fresh system into a keyboard-driven development
          environment. Browser Edition concentrates that experience into a
          fast, disposable client-side session.
        </p>
        <h3>Start with the keyboard</h3>
        <p>Open the menu, launch a terminal, tile a second app, then move between workspaces.</p>
      </article>
    </div>
  );
}
