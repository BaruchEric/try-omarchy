import assert from "node:assert/strict";
import test from "node:test";

import {
  browserDesktopReducer,
  createBrowserDesktopState,
  runBrowserEditionCommand,
  THEMES,
} from "../app/components/browser-edition/browser-state.mjs";

test("opens, focuses, moves, and closes tiled apps across workspaces", () => {
  let state = createBrowserDesktopState();
  state = browserDesktopReducer(state, {
    type: "open-app",
    app: "terminal",
    id: "terminal-2",
    openedAt: 2,
  });
  assert.equal(state.windows.length, 2);
  assert.equal(state.focusedWindowId, "terminal-2");

  state = browserDesktopReducer(state, { type: "move-focused-window", workspace: 2 });
  assert.equal(state.windows.find((window) => window.id === "terminal-2")?.workspace, 2);
  assert.equal(state.focusedWindowId, "welcome-1");

  state = browserDesktopReducer(state, { type: "switch-workspace", workspace: 2 });
  assert.equal(state.focusedWindowId, "terminal-2");
  state = browserDesktopReducer(state, { type: "close-window" });
  assert.equal(state.windows.some((window) => window.id === "terminal-2"), false);
});

test("keeps one app instance per workspace and rejects invalid actions", () => {
  let state = createBrowserDesktopState();
  state = browserDesktopReducer(state, {
    type: "open-app",
    app: "welcome",
    id: "welcome-duplicate",
    openedAt: 2,
  });
  assert.equal(state.windows.length, 1);
  assert.equal(state.focusedWindowId, "welcome-1");
  assert.equal(browserDesktopReducer(state, { type: "switch-workspace", workspace: 9 }), state);
  assert.equal(browserDesktopReducer(state, { type: "set-theme", theme: "generic" }), state);
});

test("ships exact official Quattro theme tokens", () => {
  assert.equal(THEMES["tokyo-night"].background, "#1a1b26");
  assert.equal(THEMES["tokyo-night"].accent, "#7aa2f7");
  assert.equal(THEMES["matte-black"].accent, "#e68e0d");
  assert.equal(THEMES.gruvbox.foreground, "#d4be98");
});

test("terminal identifies Browser Edition without claiming a Linux kernel", () => {
  const fastfetch = runBrowserEditionCommand("fastfetch", { theme: "tokyo-night" });
  assert.match(fastfetch.output.join("\n"), /Omarchy Quattro Browser Edition/);
  assert.match(fastfetch.output.join("\n"), /WebAssembly \+ browser-native compositor/);
  assert.doesNotMatch(fastfetch.output.join("\n"), /Arch Linux/);

  assert.equal(runBrowserEditionCommand("omarchy-menu").effect, "menu");
  assert.equal(runBrowserEditionCommand("open files").effect, "open:files");
  assert.equal(
    runBrowserEditionCommand("omarchy-theme-set gruvbox").effect,
    "theme:gruvbox",
  );
});
