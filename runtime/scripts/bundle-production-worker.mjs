#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INPUT_IMPORT = `import {
  dispatchSanitizedWorkerInput,
  sanitizeWorkerInput,
} from "./worker-input.mjs";`;
const PAGED_DISK_IMPORT = `import {
  createPagedDiskPreRun,
  preflightPagedDisk,
  preparePagedDisk,
} from "../../storage/paged-disk.mjs";`;
const BOUNDED_OVERLAY_IMPORT = `import {
  createBoundedOverlayPreRun,
  DEFAULT_MAX_OVERLAY_BYTES,
} from "./bounded-overlay.mjs";`;

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function withoutExports(source, label) {
  const transformed = source.replace(
    /^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm,
    "",
  );
  if (/^\s*(?:import|export)\s/m.test(transformed)) {
    throw new Error(`${label} contains an unsupported module declaration.`);
  }
  return transformed.trim();
}

function removeExactImport(source, declaration, label) {
  const count = source.split(declaration).length - 1;
  if (count !== 1) {
    throw new Error(`${label} must contain exactly one canonical import; found ${count}`);
  }
  return source.replace(declaration, "");
}

export function createProductionWorkerBundle(
  workerInputSource,
  boundedOverlaySource,
  pagedDiskSource,
  workerSource,
) {
  if (/^\s*import\s/m.test(workerInputSource) || /^\s*import\s/m.test(boundedOverlaySource)) {
    throw new Error("Embedded leaf modules cannot contain static imports.");
  }
  const pagedDiskWithoutImport = removeExactImport(
    pagedDiskSource,
    BOUNDED_OVERLAY_IMPORT,
    "paged-disk.mjs",
  );
  const workerWithoutInput = removeExactImport(workerSource, INPUT_IMPORT, "production Worker input");
  const workerWithoutImports = removeExactImport(
    workerWithoutInput,
    PAGED_DISK_IMPORT,
    "production Worker paged disk",
  );
  if (/^\s*import\s/m.test(workerWithoutImports)) {
    throw new Error("production-worker.mjs contains an undeclared static import.");
  }
  return [
    "// Generated self-contained production Worker; do not edit this artifact.",
    `// worker-input.mjs sha256=${sha256(workerInputSource)}`,
    `// bounded-overlay.mjs sha256=${sha256(boundedOverlaySource)}`,
    `// paged-disk.mjs sha256=${sha256(pagedDiskSource)}`,
    `// production-worker.mjs sha256=${sha256(workerSource)}`,
    "const __omarchyWorkerInputModule = (() => {",
    withoutExports(workerInputSource, "worker-input.mjs"),
    "return Object.freeze({ dispatchSanitizedWorkerInput, sanitizeWorkerInput });",
    "})();",
    "const { dispatchSanitizedWorkerInput, sanitizeWorkerInput } = __omarchyWorkerInputModule;",
    "const __omarchyBoundedOverlayModule = (() => {",
    withoutExports(boundedOverlaySource, "bounded-overlay.mjs"),
    "return Object.freeze({ createBoundedOverlayPreRun, DEFAULT_MAX_OVERLAY_BYTES });",
    "})();",
    "const __omarchyPagedDiskModule = (({ createBoundedOverlayPreRun, DEFAULT_MAX_OVERLAY_BYTES }) => {",
    withoutExports(pagedDiskWithoutImport, "paged-disk.mjs"),
    "return Object.freeze({ createPagedDiskPreRun, preflightPagedDisk, preparePagedDisk });",
    "})(__omarchyBoundedOverlayModule);",
    "const { createPagedDiskPreRun, preflightPagedDisk, preparePagedDisk } = __omarchyPagedDiskModule;",
    workerWithoutImports.trim(),
    "",
  ].join("\n");
}

export async function writeProductionWorkerBundle(outputPath, {
  workerInputPath = resolve(runtimeDirectory, "web/worker-input.mjs"),
  boundedOverlayPath = resolve(runtimeDirectory, "../storage/bounded-overlay.mjs"),
  pagedDiskPath = resolve(runtimeDirectory, "../storage/paged-disk.mjs"),
  workerPath = resolve(runtimeDirectory, "web/production-worker.mjs"),
} = {}) {
  const [workerInputSource, boundedOverlaySource, pagedDiskSource, workerSource] = await Promise.all([
    readFile(workerInputPath, "utf8"),
    readFile(boundedOverlayPath, "utf8"),
    readFile(pagedDiskPath, "utf8"),
    readFile(workerPath, "utf8"),
  ]);
  const bundle = createProductionWorkerBundle(
    workerInputSource,
    boundedOverlaySource,
    pagedDiskSource,
    workerSource,
  );
  await writeFile(resolve(outputPath), bundle, "utf8");
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("usage: bundle-production-worker.mjs OUTPUT_PATH");
  const bundle = await writeProductionWorkerBundle(outputPath);
  process.stdout.write(
    `production-worker.mjs: bundled ${Buffer.byteLength(bundle)} bytes with input/storage and no static imports\n`,
  );
}
