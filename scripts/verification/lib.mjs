import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const verificationDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(verificationDirectory, "../..");
export const contractPath = path.join(
  verificationDirectory,
  "acceptance-contract.json",
);

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON from ${filePath}: ${error.message}`);
  }
}

export async function readContract() {
  return readJson(contractPath);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getAtPath(value, dottedPath) {
  return dottedPath.split(".").reduce((cursor, key) => cursor?.[key], value);
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

export async function fileSize(filePath) {
  return (await stat(filePath)).size;
}

export function resolveInside(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Artifact path must be a non-empty relative path: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Artifact path escapes its root: ${relativePath}`);
  }
  return resolved;
}

export function parseArguments(argv, specification = {}) {
  const values = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }

    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    const definition = specification[rawName];
    if (!definition) {
      throw new Error(`Unknown option --${rawName}`);
    }

    if (definition === "boolean") {
      values[rawName] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    const optionValue = inlineValue ?? argv[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new Error(`Option --${rawName} requires a value`);
    }
    values[rawName] = optionValue;
    if (inlineValue === undefined) index += 1;
  }

  return { values, positional };
}

export class VerificationResult {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  check(id, condition, message, details = undefined) {
    this.checks.push({ id, passed: Boolean(condition), message, details });
    return Boolean(condition);
  }

  merge(other) {
    this.checks.push(...other.checks);
  }

  get passed() {
    return this.checks.every((check) => check.passed);
  }

  toJSON() {
    return {
      name: this.name,
      passed: this.passed,
      totals: {
        checks: this.checks.length,
        passed: this.checks.filter((check) => check.passed).length,
        failed: this.checks.filter((check) => !check.passed).length,
      },
      checks: this.checks,
    };
  }
}

export function printResult(result, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.toJSON(), null, 2)}\n`);
    return;
  }

  for (const check of result.checks) {
    const marker = check.passed ? "PASS" : "FAIL";
    process.stdout.write(`${marker} ${check.id}: ${check.message}\n`);
    if (!check.passed && check.details !== undefined) {
      process.stdout.write(`     ${JSON.stringify(check.details)}\n`);
    }
  }
  process.stdout.write(
    `\n${result.passed ? "PASS" : "FAIL"} ${result.name}: ` +
      `${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks passed\n`,
  );
}

export function finishCli(result, options = {}) {
  printResult(result, options);
  if (!result.passed) process.exitCode = 1;
}

export function isFullGitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

export function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function isIsoDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function commandKey(argv) {
  return Array.isArray(argv) ? argv.join(" ") : "";
}
