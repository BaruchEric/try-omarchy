#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED = new Map([
  ["guest-kernel", "vmlinuz-linux"],
  ["guest-initramfs", "initramfs-linux.img"],
  ["guest-rootfs", "rootfs.ext4"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function safeArtifactPath(value) {
  invariant(typeof value === "string" && value.length > 0, "artifact path is missing");
  invariant(!path.isAbsolute(value), `artifact path is absolute: ${value}`);
  invariant(!value.includes("\\"), `artifact path contains a backslash: ${value}`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value && normalized !== "." && !normalized.startsWith("../"), `unsafe artifact path: ${value}`);
  return normalized;
}

function parseSums(value) {
  const result = new Map();
  for (const line of value.trim().split("\n")) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    invariant(match, `invalid SHA256SUMS line: ${line}`);
    invariant(!result.has(match[2]), `duplicate SHA256SUMS path: ${match[2]}`);
    result.set(match[2], match[1]);
  }
  return result;
}

export function verifyBuildSpecContract(spec) {
  invariant(spec.runtime?.kernel === REQUIRED.get("guest-kernel"), "build spec kernel path differs from manifest");
  invariant(spec.runtime?.initramfs === REQUIRED.get("guest-initramfs"), "build spec initramfs path differs from manifest");
  invariant(spec.runtime?.disk === REQUIRED.get("guest-rootfs"), "build spec disk path differs from manifest");
  invariant(spec.runtime?.minimumMemoryMiB === 1024, "unexpected guest minimum memory");
  invariant(spec.runtime?.recommendedMemoryMiB === 1536, "unexpected guest recommended memory");
  invariant(spec.guest?.virtualDisplay?.width === 1600 && spec.guest?.virtualDisplay?.height === 900, "build spec display differs from manifest");
}

export async function verifyGuestArtifacts(guestDirectory) {
  const root = await realpath(path.resolve(guestDirectory));
  const manifestPath = path.join(root, "guest-manifest.json");
  const sumsPath = path.join(root, "SHA256SUMS");
  const [manifest, sumsText] = await Promise.all([json(manifestPath), readFile(sumsPath, "utf8")]);
  invariant(manifest?.schemaVersion === 1 && manifest.kind === "omarchy-web-guest-artifacts", "unsupported guest manifest");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length >= REQUIRED.size, "guest manifest has no artifacts");
  invariant(manifest.guest?.architecture === "x86_64", "guest manifest architecture is not x86_64");
  invariant(manifest.guest?.distribution === "Arch Linux", "guest manifest distribution is not Arch Linux");
  invariant(manifest.guest?.display?.width === 1600 && manifest.guest?.display?.height === 900, "guest display is not 1600x900");
  invariant(manifest.upstream?.repository === "https://github.com/basecamp/omarchy", "guest manifest is not official Omarchy provenance");
  invariant(/^[0-9a-f]{40}$/.test(manifest.upstream?.commit ?? ""), "guest manifest commit is not immutable");
  invariant(SHA256.test(manifest.upstream?.treeSha256 ?? ""), "guest manifest tree digest is missing");

  const sums = parseSums(sumsText);
  const expectedSumPaths = new Set(["guest-manifest.json"]);
  const seenArtifactPaths = new Set();
  const artifacts = [];
  const roles = new Map();
  for (const artifact of manifest.artifacts) {
    const relativePath = safeArtifactPath(artifact.path);
    invariant(!seenArtifactPaths.has(relativePath), `duplicate manifest artifact path: ${relativePath}`);
    seenArtifactPaths.add(relativePath);
    invariant(typeof artifact.role === "string" && artifact.role.length > 0, `artifact role is missing: ${relativePath}`);
    invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, `invalid artifact size: ${relativePath}`);
    invariant(SHA256.test(artifact.sha256 ?? ""), `invalid artifact digest: ${relativePath}`);
    const absolutePath = path.resolve(root, relativePath);
    invariant(absolutePath.startsWith(`${root}${path.sep}`), `artifact escapes guest directory: ${relativePath}`);
    const info = await lstat(absolutePath);
    invariant(info.isFile() && !info.isSymbolicLink(), `artifact is not a regular file: ${relativePath}`);
    invariant(info.size === artifact.bytes, `artifact size mismatch: ${relativePath}`);
    invariant(await realpath(absolutePath) === absolutePath, `artifact resolves through an alias: ${relativePath}`);
    const digest = await sha256(absolutePath);
    invariant(digest === artifact.sha256.toLowerCase(), `artifact SHA-256 mismatch: ${relativePath}`);
    invariant(sums.get(relativePath) === digest, `SHA256SUMS mismatch: ${relativePath}`);
    expectedSumPaths.add(relativePath);
    const rolePaths = roles.get(artifact.role) ?? [];
    rolePaths.push(relativePath);
    roles.set(artifact.role, rolePaths);
    artifacts.push({ ...artifact, path: relativePath, absolutePath, sha256: digest });
  }
  for (const [role, expectedPath] of REQUIRED) {
    invariant(roles.get(role)?.length === 1 && roles.get(role)[0] === expectedPath, `${role} must be ${expectedPath}`);
  }
  const manifestDigest = await sha256(manifestPath);
  invariant(sums.get("guest-manifest.json") === manifestDigest, "SHA256SUMS mismatch: guest-manifest.json");
  invariant(sums.size === expectedSumPaths.size, "SHA256SUMS contains an unexpected or missing path");
  for (const sumPath of sums.keys()) invariant(expectedSumPaths.has(sumPath), `unexpected SHA256SUMS path: ${sumPath}`);

  const [spec, provenance] = await Promise.all([
    json(path.join(root, "build-spec.json")),
    json(path.join(root, "provenance.json")),
  ]);
  verifyBuildSpecContract(spec);
  invariant(provenance.upstream?.commit === manifest.upstream.commit, "provenance commit differs from manifest");
  invariant(provenance.normalizedUpstreamTree?.sha256 === manifest.upstream.treeSha256, "provenance tree digest differs from manifest");

  return {
    verifiedAt: new Date().toISOString(),
    guestDirectory: root,
    manifestPath,
    manifestSha256: manifestDigest,
    upstream: manifest.upstream,
    guest: manifest.guest,
    artifacts,
  };
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: artifact-integrity.mjs GUEST_DIST");
  process.stdout.write(`${JSON.stringify(await verifyGuestArtifacts(directory), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`FAIL artifact integrity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
