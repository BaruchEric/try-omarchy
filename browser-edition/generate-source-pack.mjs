#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const browserEditionDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(browserEditionDir, "..");
const sourceRoot = resolve(
  process.env.OMARCHY_SOURCE ?? resolve(repositoryRoot, "guest/.work-container/omarchy-source"),
);
const outputPath = resolve(browserEditionDir, "generated/quattro-source-pack.mjs");
const expectedCommit = "f0020448ca87329199de7cb12f2015ebc4a3e5e7";
const themeIds = [
  "catppuccin",
  "gruvbox",
  "matte-black",
  "rose-pine",
  "tokyo-night",
  "white",
];
const authorityPaths = [
  "default/omarchy/omarchy-menu.jsonc",
  "default/hypr/bindings.lua",
  "default/hypr/bindings/applications.lua",
  "default/hypr/bindings/tiling.lua",
  "default/hypr/bindings/utilities.lua",
  "shell/shell.qml",
  "shell/plugins/bar/Bar.qml",
  ...themeIds.map((id) => `themes/${id}/colors.toml`),
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFile(path) {
  const absolute = resolve(sourceRoot, path);
  if (!existsSync(absolute)) throw new Error(`missing pinned Omarchy source file: ${path}`);
  return readFileSync(absolute);
}

function stripJsonComments(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += character;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseTheme(id) {
  const text = sourceFile(`themes/${id}/colors.toml`).toString("utf8");
  const values = Object.fromEntries(
    [...text.matchAll(/^([a-z_]+)\s*=\s*"([^"]+)"\s*$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const required = [
    "accent",
    "selection",
    "muted",
    "background",
    "dark_background",
    "darker_background",
    "lighter_background",
    "foreground",
    "dark_foreground",
    "bright_foreground",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
  ];
  for (const key of required) {
    if (!/^#[0-9a-f]{6}$/i.test(values[key] ?? "")) {
      throw new Error(`theme ${id} is missing exact color ${key}`);
    }
  }
  return {
    label: id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    accent: values.accent,
    selection: values.selection,
    muted: values.muted,
    background: values.background,
    darkBackground: values.dark_background,
    darkerBackground: values.darker_background,
    lighterBackground: values.lighter_background,
    foreground: values.foreground,
    darkForeground: values.dark_foreground,
    brightForeground: values.bright_foreground,
    red: values.red,
    yellow: values.yellow,
    green: values.green,
    cyan: values.cyan,
    blue: values.blue,
    magenta: values.magenta,
  };
}

function parseBindings() {
  const paths = authorityPaths.filter((path) => path.includes("bindings") && path.endsWith(".lua"));
  const bindings = [];
  const seen = new Set();
  for (const path of paths) {
    const text = sourceFile(path).toString("utf8");
    for (const match of text.matchAll(/o\.bind\(\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|nil)/g)) {
      if (!match[2] || seen.has(match[1])) continue;
      seen.add(match[1]);
      bindings.push({ keys: match[1], label: match[2], source: path });
    }
  }
  return bindings;
}

function buildPack() {
  const commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (commit !== expectedCommit) {
    throw new Error(`Omarchy source commit ${commit} does not match ${expectedCommit}`);
  }
  const version = sourceFile("version").toString("utf8").trim();
  const menuBytes = sourceFile("default/omarchy/omarchy-menu.jsonc");
  const menu = JSON.parse(stripJsonComments(menuBytes.toString("utf8")));
  const rootMenu = Object.entries(menu)
    .filter(([id]) => !id.includes("."))
    .map(([id, entry]) => ({
      id,
      icon: String(entry.icon ?? ""),
      label: String(entry.label ?? id),
      ...(typeof entry.action === "string" ? { action: entry.action } : {}),
    }));

  return {
    schemaVersion: 1,
    identity: {
      repository: "https://github.com/basecamp/omarchy",
      channel: "quattro",
      version,
      commit,
      tree: "19fba2114c162be330337f8a7f1e109e2a1f8384",
      normalizedTreeSha256:
        "7c053841c0b43df796cb002441f3e0cccad4a32288769f499c86b509b4f86980",
    },
    sources: Object.fromEntries(
      authorityPaths.map((path) => [path, sha256(sourceFile(path))]),
    ),
    rootMenu,
    bindings: parseBindings(),
    themes: Object.fromEntries(themeIds.map((id) => [id, parseTheme(id)])),
  };
}

const pack = buildPack();
const generated = `// Generated from the pinned official Omarchy Quattro source.\n// Run: node browser-edition/generate-source-pack.mjs\nexport const QUATTRO_SOURCE_PACK = Object.freeze(${JSON.stringify(pack, null, 2)});\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== generated) {
    throw new Error("generated Quattro source pack is stale");
  }
  process.stdout.write("Quattro source pack is current.\n");
} else {
  writeFileSync(outputPath, generated);
  process.stdout.write(`Wrote ${outputPath}\n`);
}
