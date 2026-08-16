export const BROWSER_EDITION_VERSION = "4.0.0.alpha-browser.1";

export const THEMES = Object.freeze({
  "tokyo-night": Object.freeze({
    label: "Tokyo Night",
    accent: "#7aa2f7",
    selection: "#292e42",
    muted: "#414868",
    background: "#1a1b26",
    darkBackground: "#13141c",
    darkerBackground: "#0e0e14",
    lighterBackground: "#24283b",
    foreground: "#a9b1d6",
    darkForeground: "#565f89",
    brightForeground: "#c0caf5",
    red: "#f7768e",
    yellow: "#e0af68",
    green: "#9ece6a",
    cyan: "#449dab",
    blue: "#7aa2f7",
    magenta: "#ad8ee6",
  }),
  "matte-black": Object.freeze({
    label: "Matte Black",
    accent: "#e68e0d",
    selection: "#2a2a2a",
    muted: "#333333",
    background: "#121212",
    darkBackground: "#0d0d0d",
    darkerBackground: "#090909",
    lighterBackground: "#1e1e1e",
    foreground: "#bebebe",
    darkForeground: "#555555",
    brightForeground: "#eaeaea",
    red: "#d35f5f",
    yellow: "#b91c1c",
    green: "#ffc107",
    cyan: "#bebebe",
    blue: "#e68e0d",
    magenta: "#d35f5f",
  }),
  gruvbox: Object.freeze({
    label: "Gruvbox",
    accent: "#7daea3",
    selection: "#504945",
    muted: "#665c54",
    background: "#282828",
    darkBackground: "#1e1e1e",
    darkerBackground: "#161616",
    lighterBackground: "#3c3836",
    foreground: "#d4be98",
    darkForeground: "#7c6f64",
    brightForeground: "#d4be98",
    red: "#ea6962",
    yellow: "#d8a657",
    green: "#a9b665",
    cyan: "#89b482",
    blue: "#7daea3",
    magenta: "#d3869b",
  }),
});

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

export const ROOT_MENU = Object.freeze([
  Object.freeze({ id: "apps", icon: "APP", label: "Apps" }),
  Object.freeze({ id: "learn", icon: "LRN", label: "Learn" }),
  Object.freeze({ id: "trigger", icon: "TRG", label: "Trigger" }),
  Object.freeze({ id: "style", icon: "STY", label: "Style" }),
  Object.freeze({ id: "setup", icon: "SET", label: "Setup" }),
  Object.freeze({ id: "install", icon: "PKG", label: "Install" }),
  Object.freeze({ id: "remove", icon: "RM", label: "Remove" }),
  Object.freeze({ id: "update", icon: "UP", label: "Update" }),
  Object.freeze({ id: "about", icon: "i", label: "About", app: "about" }),
  Object.freeze({ id: "system", icon: "PWR", label: "System" }),
]);

export const KEYBINDINGS = Object.freeze([
  Object.freeze(["SUPER + SPACE", "Omarchy menu"]),
  Object.freeze(["SUPER + RETURN", "Terminal"]),
  Object.freeze(["SUPER + SHIFT + RETURN", "Browser"]),
  Object.freeze(["SUPER + SHIFT + F", "File manager"]),
  Object.freeze(["SUPER + SHIFT + N", "Editor"]),
  Object.freeze(["SUPER + W", "Close window"]),
  Object.freeze(["SUPER + 1–4", "Switch workspace"]),
  Object.freeze(["SUPER + SHIFT + 1–4", "Move window to workspace"]),
  Object.freeze(["SUPER + LEFT / RIGHT", "Focus window"]),
  Object.freeze(["SUPER + SHIFT + CTRL + SPACE", "Theme menu"]),
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
