#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ESC = "\u001b";
const MAX_MARKER_BYTES = 64 * 1024;

function consumeStringControl(line, offset) {
  for (let index = offset + 2; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b && line[index + 1] === "\\") return index + 2;
  }
  return -1;
}

function consumeCsi(line, offset) {
  let index = offset + 2;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code >= 0x30 && code <= 0x3f) index += 1;
    else break;
  }
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) index += 1;
    else break;
  }
  if (index >= line.length) return -1;
  const final = line.charCodeAt(index);
  return final >= 0x40 && final <= 0x7e ? index + 1 : -1;
}

function consumeEscape(line, offset) {
  const introducer = line[offset + 1];
  if (introducer === undefined) return -1;
  if (introducer === "[") return consumeCsi(line, offset);
  if (introducer === "]" || introducer === "P" || introducer === "X" ||
      introducer === "^" || introducer === "_") {
    return consumeStringControl(line, offset);
  }

  let index = offset + 1;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) index += 1;
    else break;
  }
  if (index >= line.length) return -1;
  const final = line.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : -1;
}

function stripLeadingTerminalControls(line) {
  let offset = 0;
  while (offset < line.length) {
    const code = line.charCodeAt(offset);
    if (line[offset] === ESC) {
      offset = consumeEscape(line, offset);
      if (offset < 0) return null;
      continue;
    }
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      offset += 1;
      continue;
    }
    break;
  }
  return line.slice(offset);
}

export function parseUniqueDiagnosticMarker(diagnostics, prefix) {
  if (typeof diagnostics !== "string" || typeof prefix !== "string" ||
      prefix.length === 0 || /[\r\n\0]/.test(prefix)) {
    throw new TypeError("Diagnostic marker input is invalid.");
  }

  const matches = [];
  for (const rawLine of diagnostics.split("\n")) {
    const line = stripLeadingTerminalControls(rawLine);
    if (line?.startsWith(prefix)) matches.push(line.slice(prefix.length));
  }
  if (matches.length !== 1) {
    throw new Error(`${prefix}must occur exactly once after recognized terminal controls; found ${matches.length}`);
  }

  const encoded = new TextEncoder().encode(matches[0]);
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_MARKER_BYTES) {
    throw new Error(`${prefix}payload exceeds its byte bound`);
  }
  const payload = JSON.parse(matches[0]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError(`${prefix}payload must be a JSON object`);
  }
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [diagnosticsPath, prefix] = process.argv.slice(2);
  if (!diagnosticsPath || !prefix) {
    process.stderr.write("usage: diagnostic-markers.mjs DIAGNOSTICS PREFIX\n");
    process.exitCode = 2;
  } else {
    try {
      const diagnostics = await readFile(diagnosticsPath, "utf8");
      const payload = parseUniqueDiagnosticMarker(diagnostics, prefix);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    }
  }
}
