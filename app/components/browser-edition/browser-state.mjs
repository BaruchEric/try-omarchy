import { QUATTRO_SOURCE_PACK } from "../../../browser-edition/generated/quattro-source-pack.mjs";

export const BROWSER_EDITION_VERSION = "4.0.0.alpha-browser.1";

export const THEMES = Object.freeze(
  Object.fromEntries(
    Object.entries(QUATTRO_SOURCE_PACK.themes).map(([id, theme]) => [
      id,
      Object.freeze(theme),
    ]),
  ),
);

export const APP_DEFINITIONS = Object.freeze({
  welcome: Object.freeze({ title: "Welcome", icon: "OMA", kind: "welcome" }),
  terminal: Object.freeze({ title: "Terminal", icon: ">_", kind: "terminal" }),
  files: Object.freeze({ title: "Files", icon: "DIR", kind: "files" }),
  editor: Object.freeze({ title: "Editor", icon: "NV", kind: "editor" }),
  browser: Object.freeze({ title: "Manual", icon: "WEB", kind: "browser" }),
  themes: Object.freeze({ title: "Style · Theme", icon: "THM", kind: "themes" }),
  keybindings: Object.freeze({ title: "Keybindings", icon: "KEY", kind: "keybindings" }),
  about: Object.freeze({ title: "About Omarchy", icon: "i", kind: "about" }),
});

export const ROOT_MENU = Object.freeze(
  QUATTRO_SOURCE_PACK.rootMenu.map((item) =>
    Object.freeze({
      ...item,
      upstreamIcon: item.icon,
      icon: item.id === "about" ? "i" : item.id.slice(0, 3).toUpperCase(),
      ...(item.id === "about" ? { app: "about" } : {}),
    }),
  ),
);

const showcasedBindings = [
  "SUPER + SPACE",
  "SUPER + RETURN",
  "SUPER + SHIFT + RETURN",
  "SUPER + SHIFT + F",
  "SUPER + SHIFT + N",
  "SUPER + W",
  "SUPER + LEFT",
  "SUPER + SHIFT + CTRL + SPACE",
];

export const KEYBINDINGS = Object.freeze([
  ...showcasedBindings.map((keys) => {
    const binding = QUATTRO_SOURCE_PACK.bindings.find((candidate) => candidate.keys === keys);
    if (!binding) throw new Error(`pinned Quattro source pack is missing ${keys}`);
    return Object.freeze([binding.keys, binding.label]);
  }),
  Object.freeze(["SUPER + 1–4", "Switch workspace"]),
  Object.freeze(["SUPER + SHIFT + 1–4", "Move window to workspace"]),
]);

export function createBrowserDesktopState() {
  return {
    workspace: 1,
    theme: "tokyo-night",
    menuOpen: false,
    focusedWindowId: "welcome-1",
    windows: [
      {
        id: "welcome-1",
        app: "welcome",
        workspace: 1,
        openedAt: 1,
      },
    ],
  };
}

function lastWindowOnWorkspace(windows, workspace) {
  return (
    windows
      .filter((window) => window.workspace === workspace)
      .sort((left, right) => right.openedAt - left.openedAt)[0]?.id ?? null
  );
}

export function browserDesktopReducer(state, action) {
  switch (action.type) {
    case "toggle-menu":
      return { ...state, menuOpen: !state.menuOpen };
    case "close-menu":
      return state.menuOpen ? { ...state, menuOpen: false } : state;
    case "set-theme":
      return THEMES[action.theme]
        ? { ...state, theme: action.theme, menuOpen: false }
        : state;
    case "switch-workspace": {
      if (!Number.isInteger(action.workspace) || action.workspace < 1 || action.workspace > 4) {
        return state;
      }
      return {
        ...state,
        workspace: action.workspace,
        menuOpen: false,
        focusedWindowId: lastWindowOnWorkspace(state.windows, action.workspace),
      };
    }
    case "focus-window":
      return state.windows.some(
        (window) => window.id === action.id && window.workspace === state.workspace,
      )
        ? { ...state, focusedWindowId: action.id, menuOpen: false }
        : state;
    case "cycle-focus": {
      const visible = state.windows.filter((window) => window.workspace === state.workspace);
      if (visible.length < 2) return state;
      const current = visible.findIndex((window) => window.id === state.focusedWindowId);
      const offset = action.direction === -1 ? visible.length - 1 : 1;
      return {
        ...state,
        focusedWindowId: visible[(Math.max(current, 0) + offset) % visible.length].id,
      };
    }
    case "open-app": {
      if (!APP_DEFINITIONS[action.app] || typeof action.id !== "string") return state;
      const existing = state.windows.find(
        (window) => window.app === action.app && window.workspace === state.workspace,
      );
      if (existing) {
        return { ...state, focusedWindowId: existing.id, menuOpen: false };
      }
      return {
        ...state,
        menuOpen: false,
        focusedWindowId: action.id,
        windows: [
          ...state.windows,
          {
            id: action.id,
            app: action.app,
            workspace: state.workspace,
            openedAt: action.openedAt,
          },
        ],
      };
    }
    case "close-window": {
      const id = action.id ?? state.focusedWindowId;
      if (!id) return state;
      const windows = state.windows.filter((window) => window.id !== id);
      if (windows.length === state.windows.length) return state;
      return {
        ...state,
        windows,
        focusedWindowId: lastWindowOnWorkspace(windows, state.workspace),
      };
    }
    case "move-focused-window": {
      if (
        !state.focusedWindowId ||
        !Number.isInteger(action.workspace) ||
        action.workspace < 1 ||
        action.workspace > 4
      ) {
        return state;
      }
      const windows = state.windows.map((window) =>
        window.id === state.focusedWindowId
          ? { ...window, workspace: action.workspace }
          : window,
      );
      return {
        ...state,
        windows,
        focusedWindowId: lastWindowOnWorkspace(windows, state.workspace),
      };
    }
    default:
      return state;
  }
}

export function runBrowserEditionCommand(command, context = {}) {
  const input = String(command ?? "").trim();
  const [program, ...args] = input.split(/\s+/);
  const theme = context.theme ?? "tokyo-night";

  if (!input) return { output: [], effect: null };
  if (program === "clear") return { output: [], effect: "clear" };
  if (program === "help") {
    return {
      output: [
        "Browser Edition commands:",
        "  fastfetch  ls  pwd  cat README.md  whoami  uname -a",
        "  omarchy-version  omarchy-menu  omarchy-theme-set <theme>",
        "  open <terminal|files|editor|browser|themes|keybindings>",
      ],
      effect: null,
    };
  }
  if (program === "fastfetch") {
    return {
      output: [
        "       /\\         omarchy@browser",
        "      /  \\        ----------------",
        "     / /\\ \\       OS: Omarchy Quattro Browser Edition",
        "    / ____ \\      Shell: Quattro browser userspace",
        "   /_/    \\_\\     Theme: " + (THEMES[theme]?.label ?? theme),
        "                  Runtime: WebAssembly + browser-native compositor",
      ],
      effect: null,
    };
  }
  if (program === "ls") {
    return { output: ["Desktop  Documents  Downloads  Projects  README.md"], effect: null };
  }
  if (program === "pwd") return { output: ["/home/omarchy"], effect: null };
  if (program === "whoami") return { output: ["omarchy"], effect: null };
  if (program === "uname") {
    return {
      output: ["Omarchy-Browser wasm 4.0.0-alpha #1 client-side browser"],
      effect: null,
    };
  }
  if (program === "omarchy-version") {
    return { output: [BROWSER_EDITION_VERSION], effect: null };
  }
  if (program === "cat" && args.join(" ") === "README.md") {
    return {
      output: [
        "# Omarchy Quattro Browser Edition",
        "A performance-first, client-side distribution derived from official Quattro.",
        "Press Super+Space to explore the authentic Omarchy menu workflow.",
      ],
      effect: null,
    };
  }
  if (program === "omarchy-menu") return { output: [], effect: "menu" };
  if (program === "open" && APP_DEFINITIONS[args[0]]) {
    return { output: [], effect: `open:${args[0]}` };
  }
  if (program === "omarchy-theme-set" && THEMES[args[0]]) {
    return { output: [`Theme changed to ${THEMES[args[0]].label}`], effect: `theme:${args[0]}` };
  }
  if (program === "omarchy-theme-set") {
    return { output: [`Unknown theme: ${args[0] ?? ""}`], effect: null };
  }
  return { output: [`bash: ${program}: command not available in Browser Edition`], effect: null };
}

export function summarizeFrameCadence(frameDurations, elapsedMs) {
  const durations = frameDurations
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((left, right) => left - right);
  const frames = durations.length;
  const fps = elapsedMs > 0 ? (frames * 1000) / elapsedMs : 0;
  const percentile = (fraction) =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0;

  return Object.freeze({
    frames,
    elapsedMs,
    fps,
    p50FrameMs: percentile(0.5),
    p95FrameMs: percentile(0.95),
    passesMinimum: fps >= 24,
    reachesIdeal: fps >= 55,
  });
}
