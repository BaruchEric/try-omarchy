#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DeterministicTarWriter,
  assertRegularFile,
  compressZstd,
  createGitArchive,
  invariant,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  writeJsonDeterministic,
} from "./archive.mjs";
import {
  purlForPackage,
  readInstalledPackages,
  readPackageLock,
  resolveGuestLicenses,
  spdxIdForPackage,
  validateSpdxExpression,
  verifyPackageLock,
} from "./licenses.mjs";

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SOURCE_ROOT = "qemu-wasm-corresponding-source";
const DEFAULT_RUNTIME_INPUTS = [
  "Makefile",
  "README.md",
  "config",
  "patches",
  "scripts",
  "toolchain",
  "upstream.lock.json",
  "web",
];
const REQUIRED_ROOTFS_AUDIT_TREES = [
  ["/usr/share/licenses", "usr/share"],
  ["/var/lib/pacman/local", "var/lib/pacman"],
];
const LICENSE_GUEST_ROOT = "/usr/share/licenses";
const ALLOWED_EXTERNAL_LICENSE_ROOT = "/usr/share/doc";
const SAFE_DEBUGFS_PATH = /^\/[A-Za-z0-9._+/-]+$/;

async function makeTreeOwnerWritable(target) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, info.mode | 0o700);
    for (const entry of await readdir(target)) {
      await makeTreeOwnerWritable(path.join(target, entry));
    }
    return;
  }

  await chmod(target, info.mode | 0o600);
}

export async function removeExtractedTree(target) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
    await makeTreeOwnerWritable(target);
    await rm(target, { recursive: true, force: true });
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function resolveInput(configRoot, value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  return path.resolve(configRoot, value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function git(repository, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = error?.stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed in ${repository}${stderr ? `: ${stderr}` : ""}`);
  }
}

function normalizeRepositoryUrl(value) {
  return value.replace(/\.git$/, "").replace(/\/$/, "");
}

async function verifyGitRepository(repository, expectedRepository, commit, { requireHead = false } = {}) {
  const root = await realpath(repository);
  invariant((await lstat(path.join(root, ".git"))).isDirectory(), `source is not a git checkout: ${repository}`);
  invariant(COMMIT.test(commit), `source commit is not immutable: ${commit}`);
  await git(root, ["cat-file", "-e", `${commit}^{commit}`]);
  if (requireHead) {
    invariant((await git(root, ["rev-parse", "HEAD^{commit}"])) === commit, `source checkout HEAD does not match pinned commit ${commit}`);
    invariant((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) === "", `source checkout is dirty: ${repository}`);
  }
  const remote = await git(root, ["remote", "get-url", "origin"]);
  invariant(
    normalizeRepositoryUrl(remote) === normalizeRepositoryUrl(expectedRepository),
    `source remote mismatch for ${repository}: expected ${expectedRepository}, got ${remote}`,
  );
  return {
    root,
    commit,
    repository: expectedRepository,
    gitTree: await git(root, ["rev-parse", `${commit}^{tree}`]),
  };
}

function parseWrap(contents, label) {
  const values = {};
  for (const line of contents.split("\n")) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  invariant(/^https:\/\//.test(values.url ?? ""), `${label} has no HTTPS url`);
  invariant(COMMIT.test(values.revision ?? ""), `${label} has no immutable revision`);
  return values;
}

function parseGitlinks(value) {
  const links = [];
  for (const line of value.split("\n")) {
    if (!line) continue;
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(line);
    invariant(match, `unexpected git ls-tree record: ${line}`);
    if (match[1] === "160000") {
      links.push({ path: safeRelativePath(match[4], "QEMU gitlink path"), commit: match[3] });
    }
  }
  return links.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyGuestArtifacts(guestDirectory, manifest) {
  invariant(isRecord(manifest) && manifest.schemaVersion === 1, "guest manifest has an unsupported schema");
  invariant(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "guest manifest contains no artifacts");
  invariant(COMMIT.test(manifest.upstream?.commit ?? ""), "guest manifest has no immutable Omarchy commit");
  invariant(manifest.upstream?.repository === "https://github.com/basecamp/omarchy", "guest manifest is not official Omarchy source");
  invariant(manifest.upstream?.license === "MIT", "guest manifest does not record Omarchy's MIT license");
  invariant(
    SHA256.test(manifest.normalizedUpstreamTree?.sha256 ?? manifest.upstream?.treeSha256 ?? ""),
    "guest manifest has no normalized Omarchy tree SHA-256",
  );
  invariant(Number.isInteger(manifest.build?.sourceDateEpoch) && manifest.build.sourceDateEpoch > 0, "guest manifest has no SOURCE_DATE_EPOCH");

  const root = await realpath(guestDirectory);
  const seen = new Set();
  const verified = [];
  for (const artifact of manifest.artifacts) {
    invariant(isRecord(artifact), "guest manifest artifact is invalid");
    const relativePath = safeRelativePath(artifact.path, "guest artifact path");
    invariant(!seen.has(relativePath), `duplicate guest artifact: ${relativePath}`);
    invariant(Number.isInteger(artifact.bytes) && artifact.bytes > 0, `guest artifact size is invalid: ${relativePath}`);
    invariant(SHA256.test(artifact.sha256 ?? ""), `guest artifact SHA-256 is invalid: ${relativePath}`);
    const sourcePath = path.join(root, ...relativePath.split("/"));
    const sourceReal = await realpath(sourcePath);
    invariant(sourceReal.startsWith(`${root}${path.sep}`), `guest artifact escapes its directory: ${relativePath}`);
    const info = await assertRegularFile(sourcePath, "guest artifact");
    invariant(info.size === artifact.bytes, `guest artifact size changed: ${relativePath}`);
    const digest = await sha256File(sourcePath);
    invariant(digest === artifact.sha256.toLowerCase(), `guest artifact digest changed: ${relativePath}`);
    seen.add(relativePath);
    verified.push({ ...artifact, path: relativePath, sha256: digest });
  }
  invariant(verified.some((item) => item.role === "guest-rootfs" || item.path === "rootfs.ext4"), "guest manifest has no rootfs artifact");
  return verified;
}

function insideGuestPath(guestPath, root) {
  return guestPath === root || guestPath.startsWith(`${root}/`);
}

function resolveGuestLinkTarget(linkGuestPath, target) {
  return path.posix.normalize(
    target.startsWith("/")
      ? target
      : path.posix.join(path.posix.dirname(linkGuestPath), target),
  );
}

async function collectExternalLicenseTargets(destination) {
  const licenseRoot = path.join(destination, "usr", "share", "licenses");
  const targets = new Set();

  async function visit(directory, guestDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const nativePath = path.join(directory, entry.name);
      const guestPath = path.posix.join(guestDirectory, entry.name);
      const info = await lstat(nativePath);
      if (info.isDirectory()) {
        await visit(nativePath, guestPath);
      } else if (info.isSymbolicLink()) {
        const target = resolveGuestLinkTarget(guestPath, await readlink(nativePath));
        if (insideGuestPath(target, LICENSE_GUEST_ROOT)) continue;
        invariant(
          insideGuestPath(target, ALLOWED_EXTERNAL_LICENSE_ROOT) &&
            SAFE_DEBUGFS_PATH.test(target) &&
            !target.split("/").includes(".."),
          `license symlink target is outside the reviewed guest documentation root: ${guestPath}`,
        );
        targets.add(target);
      }
    }
  }

  await visit(licenseRoot, LICENSE_GUEST_ROOT);
  return [...targets].sort();
}

async function runDebugfs(debugfsCommand, command, imagePath, guestPath) {
  try {
    await execFileAsync(debugfsCommand, ["-R", command, imagePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const rawDetail = error?.code === "ENOENT"
      ? `${debugfsCommand} is not installed`
      : error?.stderr?.trim() || error.message;
    const detail = rawDetail.length > 4096 ? rawDetail.slice(-4096) : rawDetail;
    throw new Error(`could not extract ${guestPath} from the guest ext4 image with debugfs: ${detail}`);
  }
}

export async function extractRootfsAuditTrees(imagePath, destination, debugfsCommand) {
  await mkdir(destination, { recursive: false });
  invariant(!/\s/.test(destination), `temporary rootfs extraction path contains whitespace: ${destination}`);

  for (const [guestPath, parentPath] of REQUIRED_ROOTFS_AUDIT_TREES) {
    const nativeParent = path.join(destination, ...parentPath.split("/"));
    await mkdir(nativeParent, { recursive: true });
    await runDebugfs(
      debugfsCommand,
      `rdump ${guestPath} ${nativeParent}`,
      imagePath,
      guestPath,
    );
  }

  for (const guestPath of await collectExternalLicenseTargets(destination)) {
    const nativePath = path.join(destination, ...guestPath.split("/").filter(Boolean));
    await mkdir(path.dirname(nativePath), { recursive: true });
    await runDebugfs(
      debugfsCommand,
      `dump ${guestPath} ${nativePath}`,
      imagePath,
      guestPath,
    );
  }
  return destination;
}

async function resolveRootfs(config, guestDirectory, temporaryRoot, rootArtifact) {
  if (config.guest.rootfsDirectory) {
    invariant(
      config.guest.allowUnverifiedRootfsDirectory === true,
      "guest.rootfsDirectory is not cryptographically bound to rootfs.ext4; set allowUnverifiedRootfsDirectory only for fixtures/development",
    );
    const root = resolveInput(config.configRoot, config.guest.rootfsDirectory, "guest.rootfsDirectory");
    const info = await lstat(root);
    invariant(info.isDirectory() && !info.isSymbolicLink(), `guest rootfs directory is unsafe: ${root}`);
    return { path: await realpath(root), kind: "unverified-directory", cryptographicallyBoundToGuestArtifact: false };
  }
  const image = config.guest.rootfsImage
    ? resolveInput(config.configRoot, config.guest.rootfsImage, "guest.rootfsImage")
    : path.join(guestDirectory, "rootfs.ext4");
  await assertRegularFile(image, "guest rootfs image");
  const defaultImage = path.join(guestDirectory, ...rootArtifact.path.split("/"));
  if ((await realpath(image)) !== (await realpath(defaultImage))) {
    invariant((await stat(image)).size === rootArtifact.bytes, "configured rootfs image size does not match the guest manifest");
    invariant((await sha256File(image)) === rootArtifact.sha256, "configured rootfs image digest does not match the guest manifest");
  }
  return {
    path: await extractRootfsAuditTrees(
      image,
      path.join(temporaryRoot, "rootfs"),
      config.guest.debugfsCommand ?? "debugfs",
    ),
    kind: "verified-ext4-artifact",
    cryptographicallyBoundToGuestArtifact: true,
    artifactPath: rootArtifact.path,
    sha256: rootArtifact.sha256,
  };
}

async function collectRuntimeInputs(runtimeDirectory, inputs) {
  const root = await realpath(runtimeDirectory);
  const selected = inputs ?? DEFAULT_RUNTIME_INPUTS;
  invariant(Array.isArray(selected) && selected.length > 0, "runtime.sourceInputs must be a non-empty array");
  const files = [];
  const seen = new Set();

  async function visit(absolutePath, relativePath) {
    const info = await lstat(absolutePath);
    invariant(!info.isSymbolicLink(), `runtime source input is a symlink: ${relativePath}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolutePath)).sort()) {
        await visit(path.join(absolutePath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    invariant(info.isFile(), `runtime source input is not a regular file: ${relativePath}`);
    invariant(!seen.has(relativePath), `duplicate runtime source input: ${relativePath}`);
    seen.add(relativePath);
    files.push({
      relativePath,
      sourcePath: absolutePath,
      mode: info.mode & 0o111 ? 0o755 : 0o644,
      bytes: info.size,
      sha256: await sha256File(absolutePath),
    });
  }

  for (const input of selected) {
    const relative = safeRelativePath(input, "runtime source input");
    invariant(relative !== "build" && !relative.startsWith("build/"), "runtime build cache cannot be a source input");
    invariant(relative !== "dist" && !relative.startsWith("dist/"), "compiled runtime output cannot be a source input");
    const absolute = path.join(root, ...relative.split("/"));
    const resolvedParent = await realpath(path.dirname(absolute));
    invariant(resolvedParent === root || resolvedParent.startsWith(`${root}${path.sep}`), `runtime source input escapes its root: ${relative}`);
    await visit(absolute, relative);
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  invariant(files.some((file) => file.relativePath.startsWith("patches/") && file.bytes > 0), "runtime source inputs contain no patches");
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.mode.toString(8)}\0${file.relativePath}\0${file.sha256}\0`);
  return { files, sha256: digest.digest("hex") };
}

async function prepareRuntimeSources(config, temporaryRoot) {
  const runtimeDirectory = resolveInput(config.configRoot, config.runtime.directory, "runtime.directory");
  const checkout = resolveInput(config.configRoot, config.runtime.qemuCheckout, "runtime.qemuCheckout");
  const lockPath = config.runtime.lockFile
    ? resolveInput(config.configRoot, config.runtime.lockFile, "runtime.lockFile")
    : path.join(runtimeDirectory, "upstream.lock.json");
  const lock = await readJson(lockPath);
  invariant(lock.schemaVersion === 1 && isRecord(lock.qemuWasm), "runtime upstream lock is invalid");
  const qemu = await verifyGitRepository(checkout, lock.qemuWasm.repository, lock.qemuWasm.commit, { requireHead: true });
  const gitlinks = parseGitlinks(await git(qemu.root, ["ls-tree", "-r", qemu.commit]));
  const archives = [];
  const qemuArchive = await createGitArchive(
    qemu.root,
    qemu.commit,
    `${SOURCE_ROOT}/qemu-wasm`,
    path.join(temporaryRoot, "qemu.tar"),
  );
  archives.push(qemuArchive);
  qemu.gitArchiveSha256 = qemuArchive.sha256;

  const subprojects = [];
  for (const [name, expected] of Object.entries(lock.qemuSubprojects ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    invariant(/^[A-Za-z0-9._+-]+$/.test(name), `unsafe QEMU subproject name: ${name}`);
    invariant(isRecord(expected) && COMMIT.test(expected.commit ?? "") && /^https:\/\//.test(expected.repository ?? ""), `invalid QEMU subproject lock: ${name}`);
    const wrapPath = path.join(qemu.root, "subprojects", `${name}.wrap`);
    const wrap = parseWrap(await readFile(wrapPath, "utf8"), `${name}.wrap`);
    invariant(normalizeRepositoryUrl(wrap.url) === normalizeRepositoryUrl(expected.repository), `${name}.wrap repository does not match the runtime lock`);
    invariant(wrap.revision === expected.commit, `${name}.wrap revision does not match the runtime lock`);
    const configured = config.runtime.subprojectDirectories?.[name];
    const directory = configured
      ? resolveInput(config.configRoot, configured, `runtime.subprojectDirectories.${name}`)
      : path.join(runtimeDirectory, "build", "upstreams", `${name}-${expected.commit}`);
    const source = await verifyGitRepository(directory, expected.repository, expected.commit);
    const archive = await createGitArchive(
      source.root,
      source.commit,
      `${SOURCE_ROOT}/subprojects/${name}`,
      path.join(temporaryRoot, `subproject-${name}.tar`),
    );
    archives.push(archive);
    subprojects.push({ ...source, name, gitArchiveSha256: archive.sha256 });
  }
  invariant(subprojects.length > 0, "runtime lock contains no build subprojects");

  const inputs = await collectRuntimeInputs(runtimeDirectory, config.runtime.sourceInputs);
  const runtimeRoot = await realpath(runtimeDirectory);
  const lockReal = await realpath(lockPath);
  invariant(lockReal.startsWith(`${runtimeRoot}${path.sep}`), "runtime upstream lock must be inside the archived runtime source directory");
  const lockRelative = safeRelativePath(path.relative(runtimeRoot, lockReal).replaceAll(path.sep, "/"), "runtime upstream lock path");
  const lockInput = inputs.files.find((item) => item.relativePath === lockRelative);
  invariant(lockInput, `runtime upstream lock is not included in runtime.sourceInputs: ${lockRelative}`);
  const licenses = [];
  for (const relativePath of ["LICENSE", "COPYING", "COPYING.LIB"]) {
    const sourcePath = path.join(qemu.root, relativePath);
    try {
      const info = await lstat(sourcePath);
      invariant(info.isFile() && !info.isSymbolicLink() && info.size > 0, `QEMU license is unsafe or empty: ${relativePath}`);
      licenses.push({ logicalPath: `qemu-wasm/${relativePath}`, sourcePath, bytes: info.size, sha256: await sha256File(sourcePath) });
    } catch (error) {
      if (relativePath !== "COPYING.LIB" || error?.code !== "ENOENT") throw error;
    }
  }
  invariant(licenses.some((item) => item.logicalPath.endsWith("/LICENSE")), "QEMU source is missing LICENSE");
  invariant(licenses.some((item) => item.logicalPath.endsWith("/COPYING")), "QEMU source is missing COPYING");
  return {
    runtimeDirectory,
    lockPath,
    lockSha256: lockInput.sha256,
    lock,
    qemu,
    gitlinks,
    subprojects,
    inputs,
    licenses,
    archives,
  };
}

function bundlePathForDigest(digest) {
  return `THIRD_PARTY_NOTICES/license-texts/${digest}`;
}

function addNoticeAsset(assets, file) {
  const existing = assets.get(file.sha256);
  if (existing) {
    invariant(existing.bytes === file.bytes, `SHA-256 collision while collecting license texts: ${file.sha256}`);
    existing.logicalPaths.add(file.logicalPath);
  } else {
    assets.set(file.sha256, { ...file, archivePath: bundlePathForDigest(file.sha256), logicalPaths: new Set([file.logicalPath]) });
  }
}

function noticeReferences(files) {
  return files.map((file) => ({
    originalPath: file.logicalPath,
    sha256: file.sha256,
    bytes: file.bytes,
    bundlePath: bundlePathForDigest(file.sha256),
  }));
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function makeNoticesMarkdown(index) {
  const lines = [
    "# Third-party notices",
    "",
    `Generated reproducibly from the released root filesystem and pinned runtime source at SOURCE_DATE_EPOCH ${index.sourceDateEpoch}.`,
    "",
    "This inventory is engineering evidence, not legal clearance. See `INDEX.json` and `sbom.spdx.json` for machine-readable metadata.",
    "",
    "## Core components",
    "",
    "| Component | Version/pin | Concluded license | Notice files |",
    "| --- | --- | --- | --- |",
  ];
  for (const component of index.components) {
    lines.push(`| ${markdownEscape(component.name)} | ${markdownEscape(component.version)} | ${markdownEscape(component.concludedLicense)} | ${component.licenseFiles.length} |`);
  }
  lines.push(
    "",
    "## Installed Arch packages",
    "",
    "| Package | Version | Raw pacman license data | Concluded SPDX expression | Package-specific notices |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const item of index.packages) {
    lines.push(
      `| ${markdownEscape(item.name)} | ${markdownEscape(item.version)} | ${markdownEscape(item.rawLicenses.join(", "))} | ${markdownEscape(item.concludedLicense)} | ${item.licenseFiles.length} |`,
    );
  }
  lines.push(
    "",
    "All files found under `/usr/share/licenses` in the released guest are included once by SHA-256 in `license-texts/`. `INDEX.json` maps their installed paths to those content-addressed members.",
    "",
    "The QEMU source archive covers the exact emulator build source, locked build subprojects, web-runtime patches, configuration, and build scripts. Kernel/package corresponding-source offers and firmware-by-firmware review remain separate release gates.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function deterministicUuid(digest) {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createSpdx({ epoch, manifest, packages, extractedLicenses, runtime }) {
  const created = new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
  const qemuId = "SPDXRef-Package-QEMU-Wasm";
  const omarchyId = "SPDXRef-Package-Omarchy";
  const componentPackages = [
    {
      name: "Omarchy",
      SPDXID: omarchyId,
      versionInfo: manifest.upstream.version,
      downloadLocation: `${manifest.upstream.repository}/tree/${manifest.upstream.commit}`,
      filesAnalyzed: false,
      checksums: [{ algorithm: "SHA256", checksumValue: manifest.normalizedUpstreamTree?.sha256 ?? manifest.upstream.treeSha256 }],
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      copyrightText: "NOASSERTION",
      sourceInfo: `Pinned upstream commit ${manifest.upstream.commit}; normalized source tree digest recorded by the guest build.`,
      externalRefs: [
        {
          referenceCategory: "PERSISTENT-ID",
          referenceType: "gitoid",
          referenceLocator: `gitoid:commit:sha1:${manifest.upstream.commit}`,
        },
      ],
    },
    {
      name: "QEMU-Wasm",
      SPDXID: qemuId,
      versionInfo: runtime.qemu.commit,
      downloadLocation: `${normalizeRepositoryUrl(runtime.qemu.repository)}/tree/${runtime.qemu.commit}`,
      filesAnalyzed: false,
      checksums: [{ algorithm: "SHA256", checksumValue: runtime.qemu.gitArchiveSha256 }],
      licenseConcluded: "GPL-2.0-only",
      licenseDeclared: "GPL-2.0-only",
      copyrightText: "NOASSERTION",
      sourceInfo: `Clean pinned git commit plus the separately inventoried Omarchy browser runtime patches and locked QEMU build subprojects. Git tree ${runtime.qemu.gitTree}.`,
      externalRefs: [
        {
          referenceCategory: "PERSISTENT-ID",
          referenceType: "gitoid",
          referenceLocator: `gitoid:commit:sha1:${runtime.qemu.commit}`,
        },
      ],
    },
  ];
  const archPackages = packages.map((item) => ({
    name: item.name,
    SPDXID: spdxIdForPackage(item.name),
    versionInfo: item.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: item.concludedLicense,
    licenseDeclared: item.concludedLicense,
    copyrightText: "NOASSERTION",
    sourceInfo: `Installed package metadata SHA-256 ${item.descSha256}; original pacman license fields: ${item.rawLicenses.join(", ")}.`,
    packageComment: item.licenseFiles.length
      ? `License notices are indexed from: ${item.licenseFiles.map((file) => file.logicalPath).join(", ")}`
      : "No package-specific file was installed; the bundle still contains the complete /usr/share/licenses corpus and the package is identified by a reviewed SPDX expression.",
    ...(item.homepage && /^https?:\/\//.test(item.homepage) ? { homepage: item.homepage } : {}),
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purlForPackage(item),
      },
    ],
  }));
  const allPackages = [...componentPackages, ...archPackages];
  const namespaceDigest = sha256Buffer(
    JSON.stringify({
      epoch,
      omarchy: manifest.upstream.commit,
      qemu: runtime.qemu.commit,
      runtimeInputs: runtime.inputs.sha256,
      packages: archPackages.map((item) => [item.name, item.versionInfo, item.licenseConcluded]),
    }),
  );
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "Omarchy browser demo distribution",
    documentNamespace: `urn:uuid:${deterministicUuid(namespaceDigest)}`,
    creationInfo: {
      created,
      creators: ["Tool: omarchy-browser-distribution/1"],
    },
    documentDescribes: allPackages.map((item) => item.SPDXID),
    packages: allPackages,
    relationships: allPackages.map((item) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: item.SPDXID,
    })),
    ...(extractedLicenses.length ? { hasExtractedLicensingInfos: extractedLicenses } : {}),
  };
}

async function writeNoticeBundle({ outputPath, temporaryTar, epoch, index, assets, spdx }) {
  const writer = new DeterministicTarWriter(temporaryTar, epoch);
  const indexText = `${JSON.stringify(index, null, 2)}\n`;
  await writer.addBuffer("THIRD_PARTY_NOTICES/INDEX.json", indexText);
  await writer.addBuffer("THIRD_PARTY_NOTICES/THIRD_PARTY_NOTICES.md", makeNoticesMarkdown(index));
  await writer.addBuffer("THIRD_PARTY_NOTICES/sbom.spdx.json", `${JSON.stringify(spdx, null, 2)}\n`);
  for (const asset of [...assets.values()].sort((left, right) => left.archivePath.localeCompare(right.archivePath))) {
    invariant((await sha256File(asset.sourcePath)) === asset.sha256, `license text changed during packaging: ${asset.sourcePath}`);
    await writer.addFile(asset.archivePath, asset.sourcePath);
  }
  await writer.close();
  return compressZstd(temporaryTar, outputPath, epoch);
}

async function writeSourceBundle({ outputPath, temporaryTar, epoch, runtime, sourceManifest }) {
  const writer = new DeterministicTarWriter(temporaryTar, epoch);
  await writer.addBuffer(`${SOURCE_ROOT}/SOURCE-MANIFEST.json`, `${JSON.stringify(sourceManifest, null, 2)}\n`);
  for (const archive of runtime.archives) await writer.appendNormalizedTar(archive.path);
  for (const file of runtime.inputs.files) {
    invariant((await sha256File(file.sourcePath)) === file.sha256, `runtime source input changed during packaging: ${file.relativePath}`);
    await writer.addFile(`${SOURCE_ROOT}/omarchy-web-runtime/${file.relativePath}`, file.sourcePath, file.mode);
  }
  await writer.close();
  return compressZstd(temporaryTar, outputPath, epoch);
}

function artifactRecord(name, role, mediaType, result) {
  return { path: name, role, mediaType, bytes: result.bytes, sha256: result.sha256 };
}

async function fileArtifact(filePath, name, role, mediaType) {
  return artifactRecord(name, role, mediaType, {
    bytes: (await stat(filePath)).size,
    sha256: await sha256File(filePath),
  });
}

export async function buildDistribution(inputConfig, { configRoot = process.cwd() } = {}) {
  invariant(isRecord(inputConfig) && inputConfig.schemaVersion === 1, "distribution input has an unsupported schema");
  invariant(isRecord(inputConfig.guest) && isRecord(inputConfig.runtime), "distribution input requires guest and runtime sections");
  const config = { ...inputConfig, configRoot: path.resolve(configRoot) };
  const outputDirectory = resolveInput(config.configRoot, config.outputDirectory, "outputDirectory");
  const epoch = config.sourceDateEpoch;
  invariant(Number.isInteger(epoch) && epoch > 0, "sourceDateEpoch must be a positive integer");
  try {
    await lstat(outputDirectory);
    throw new Error(`refusing to replace existing distribution directory: ${outputDirectory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const guestDirectory = resolveInput(config.configRoot, config.guest.artifactDirectory, "guest.artifactDirectory");
  const guestManifestPath = path.join(guestDirectory, "guest-manifest.json");
  const guestManifest = await readJson(guestManifestPath);
  invariant(guestManifest.build?.sourceDateEpoch === epoch, "sourceDateEpoch does not match the completed guest build");
  const guestArtifacts = await verifyGuestArtifacts(guestDirectory, guestManifest);
  const rootArtifact = guestArtifacts.find((item) => item.role === "guest-rootfs" || item.path === "rootfs.ext4");
  const guestManifestSha256 = await sha256File(guestManifestPath);
  const packageLockPath = config.guest.packageLock
    ? resolveInput(config.configRoot, config.guest.packageLock, "guest.packageLock")
    : path.join(guestDirectory, "packages.lock.txt");
  await assertRegularFile(packageLockPath, "guest package lock");

  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outputDirectory), `.${path.basename(outputDirectory)}.staging-`));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omarchy-distribution-"));
  let promoted = false;
  try {
    const rootfs = await resolveRootfs(config, guestDirectory, temporary, rootArtifact);
    const installed = await readInstalledPackages(rootfs.path);
    const packageLock = await readPackageLock(packageLockPath);
    verifyPackageLock(installed, packageLock);
    const guestLicenses = await resolveGuestLicenses(rootfs.path, installed, config.licenses ?? {});
    const licenseReviewSha256 = sha256Buffer(JSON.stringify(canonicalize(config.licenses ?? {})));
    const runtime = await prepareRuntimeSources(config, temporary);
    validateSpdxExpression("MIT");
    validateSpdxExpression("GPL-2.0-only");

    const omarchyLicense = guestLicenses.corpus.find((file) => file.logicalPath === "usr/share/licenses/omarchy/LICENSE");
    invariant(omarchyLicense, "rootfs is missing the exact Omarchy license at /usr/share/licenses/omarchy/LICENSE");
    const assets = new Map();
    for (const file of [...guestLicenses.corpus, ...runtime.licenses]) addNoticeAsset(assets, file);
    const packageIndex = guestLicenses.packages.map((item) => ({
      name: item.name,
      version: item.version,
      architecture: item.architecture,
      purl: purlForPackage(item),
      homepage: item.homepage,
      rawLicenses: item.rawLicenses,
      concludedLicense: item.concludedLicense,
      pacmanMetadataSha256: item.descSha256,
      licenseFiles: noticeReferences(item.licenseFiles),
    }));
    const noticeIndex = {
      schemaVersion: 1,
      generatedAt: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"),
      sourceDateEpoch: epoch,
      legalStatus: "NOT_CLEARED",
      rootfsAnalysis: {
        kind: rootfs.kind,
        cryptographicallyBoundToGuestArtifact: rootfs.cryptographicallyBoundToGuestArtifact,
        ...(rootfs.artifactPath ? { artifactPath: rootfs.artifactPath, sha256: rootfs.sha256 } : {}),
      },
      components: [
        {
          name: "Omarchy",
          version: guestManifest.upstream.version,
          repository: guestManifest.upstream.repository,
          commit: guestManifest.upstream.commit,
          concludedLicense: "MIT",
          licenseFiles: noticeReferences([omarchyLicense]),
        },
        {
          name: "QEMU-Wasm",
          version: runtime.qemu.commit,
          repository: runtime.qemu.repository,
          commit: runtime.qemu.commit,
          concludedLicense: "GPL-2.0-only",
          modified: true,
          licenseFiles: noticeReferences(runtime.licenses),
        },
      ],
      packages: packageIndex,
      licenseCorpus: [...assets.values()]
        .sort((left, right) => left.sha256.localeCompare(right.sha256))
        .map((asset) => ({
          sha256: asset.sha256,
          bytes: asset.bytes,
          bundlePath: asset.archivePath,
          originalPaths: [...asset.logicalPaths].sort(),
        })),
      unresolvedLicenseCount: 0,
      licenseReviewSha256,
      manualReviewStillRequired: [
        "firmware and ROM licensing/source by shipped filename",
        "kernel and copyleft guest-package corresponding-source offers",
        "Emscripten/SDL generated-runtime linkage and notice analysis",
        "Omarchy trademark, endorsement, export, and organizational release approval",
      ],
    };
    const spdx = createSpdx({
      epoch,
      manifest: guestManifest,
      packages: guestLicenses.packages,
      extractedLicenses: guestLicenses.extractedLicenses,
      runtime,
    });
    const sbomPath = path.join(staging, "sbom.spdx.json");
    await writeJsonDeterministic(sbomPath, spdx);

    const sourceManifest = {
      schemaVersion: 1,
      generatedAt: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"),
      sourceDateEpoch: epoch,
      scope: "Complete corresponding source inputs for the modified QEMU-Wasm executable; guest kernel/packages and prebuilt firmware require separate source offers.",
      qemuWasm: {
        repository: runtime.qemu.repository,
        commit: runtime.qemu.commit,
        gitTree: runtime.qemu.gitTree,
        gitArchiveSha256: runtime.qemu.gitArchiveSha256,
      },
      qemuBuildSubprojects: runtime.subprojects.map((item) => ({
        name: item.name,
        repository: item.repository,
        commit: item.commit,
        gitTree: item.gitTree,
        gitArchiveSha256: item.gitArchiveSha256,
      })),
      runtimeBuildInputs: {
        sha256: runtime.inputs.sha256,
        files: runtime.inputs.files.map(({ relativePath, mode, bytes, sha256 }) => ({
          path: relativePath,
          mode: mode.toString(8),
          bytes,
          sha256,
        })),
      },
      upstreamLock: {
        path: path.relative(runtime.runtimeDirectory, runtime.lockPath).replaceAll(path.sep, "/"),
        sha256: runtime.lockSha256,
      },
      upstreamGitlinksNotUsedAsQemuWasmBuildInputs: runtime.gitlinks,
      buildInstructions: "omarchy-web-runtime/README.md",
    };

    const noticeResult = await writeNoticeBundle({
      outputPath: path.join(staging, "THIRD_PARTY_NOTICES.tar.zst"),
      temporaryTar: path.join(temporary, "notices.tar"),
      epoch,
      index: noticeIndex,
      assets,
      spdx,
    });
    const sourceResult = await writeSourceBundle({
      outputPath: path.join(staging, "qemu-wasm-corresponding-source.tar.zst"),
      temporaryTar: path.join(temporary, "source.tar"),
      epoch,
      runtime,
      sourceManifest,
    });
    const artifacts = [
      await fileArtifact(sbomPath, "sbom.spdx.json", "sbom", "application/spdx+json"),
      artifactRecord("THIRD_PARTY_NOTICES.tar.zst", "license-bundle", "application/zstd", noticeResult),
      artifactRecord("qemu-wasm-corresponding-source.tar.zst", "emulator-source", "application/zstd", sourceResult),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const linux = guestLicenses.packages.find((item) => item.name === "linux");
    const distributionManifest = {
      schemaVersion: 1,
      generatedAt: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"),
      sourceDateEpoch: epoch,
      legalStatus: "NOT_CLEARED",
      inputs: {
        guestManifest: { path: "guest-manifest.json", sha256: guestManifestSha256 },
        guestArtifacts,
        rootfsAnalysis: noticeIndex.rootfsAnalysis,
        packageLock: { sha256: packageLock.sha256, packages: packageLock.packages.size },
        qemuWasm: sourceManifest.qemuWasm,
        qemuBuildSubprojects: sourceManifest.qemuBuildSubprojects,
        runtimeBuildInputs: { sha256: runtime.inputs.sha256, files: runtime.inputs.files.length },
        licenseReview: {
          sha256: licenseReviewSha256,
          mappings: Object.keys(config.licenses?.licenseMappings ?? {}).length,
          packageOverrides: Object.keys(config.licenses?.packageLicenseOverrides ?? {}).length,
        },
      },
      artifacts,
      releaseAssembler: {
        licenseBundle: "THIRD_PARTY_NOTICES.tar.zst",
        sbom: "sbom.spdx.json",
        runtimeSource: "qemu-wasm-corresponding-source.tar.zst",
        licenses: [
          {
            component: "Omarchy",
            spdx: "MIT",
            noticePath: "THIRD_PARTY_NOTICES.tar.zst",
            sourceUrl: guestManifest.upstream.repository,
          },
          {
            component: "qemu-wasm",
            spdx: "GPL-2.0-only",
            noticePath: "THIRD_PARTY_NOTICES.tar.zst",
            sourceUrl: normalizeRepositoryUrl(runtime.qemu.repository),
          },
          {
            component: "Linux",
            spdx: linux.concludedLicense,
            noticePath: "THIRD_PARTY_NOTICES.tar.zst",
            sourceUrl: linux.homepage && /^https:\/\//.test(linux.homepage) ? linux.homepage : "https://kernel.org/",
          },
        ],
      },
      unresolvedLicenseCount: 0,
      manualClearanceRequired: true,
    };
    await writeJsonDeterministic(path.join(staging, "distribution-manifest.json"), distributionManifest);
    await rename(staging, outputDirectory);
    promoted = true;
    return { outputDirectory, manifest: distributionManifest, spdx, noticeIndex, sourceManifest };
  } finally {
    await removeExtractedTree(temporary);
    if (!promoted) await removeExtractedTree(staging);
  }
}

function parseArguments(argv) {
  invariant(argv.length === 2 && argv[0] === "--config" && argv[1], "Usage: node distribution/build.mjs --config distribution-input.json");
  return path.resolve(argv[1]);
}

async function main() {
  const configPath = parseArguments(process.argv.slice(2));
  const result = await buildDistribution(await readJson(configPath), { configRoot: path.dirname(configPath) });
  process.stdout.write(`Distribution artifacts written atomically to ${result.outputDirectory}\n`);
  process.stdout.write(`SPDX packages: ${result.spdx.packages.length}; unresolved licenses: 0; legal clearance: required\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
