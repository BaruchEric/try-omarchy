#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const FROM = "-sPTHREAD_POOL_SIZE=4";
const TO = "-sPTHREAD_POOL_SIZE=8";

export function normalizeArm64PthreadPool(source) {
  if (typeof source !== "string" || !source.includes(FROM)) {
    throw new Error("ARM64 QEMU build graph has no pinned four-worker dependency flags");
  }
  const result = source.replaceAll(FROM, TO);
  if (result.includes(FROM) || !result.includes(TO)) {
    throw new Error("ARM64 QEMU build graph pthread pool normalization failed");
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const path = resolve(process.argv[2] ?? "build.ninja");
  const source = await readFile(path, "utf8");
  const result = normalizeArm64PthreadPool(source);
  await writeFile(path, result, "utf8");
  process.stdout.write(`ARM64 pthread pool normalized to eight workers in ${path}\n`);
}
