#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  invariant,
  safeRelativePath,
  sha256File,
  writeJsonDeterministic,
} from "./archive.mjs";
import { validateSpdxExpression } from "./licenses.mjs";

const LICENSE_ROOT = "/usr/share/licenses";
const DOCUMENTATION_ROOT = "/usr/share/doc";
const ALLOWED_LICENSE_ROOTS = [LICENSE_ROOT, DOCUMENTATION_ROOT];

// These are the non-review aliases accepted by the distribution builder. Keep
// this list deliberately small: everything else belongs in the TODO report.
const BUILDER_DEFAULT_ALIASES = new Map([
  ["APACHE", "Apache-2.0"],
  ["BOOST", "BSL-1.0"],
  ["ISC", "ISC"],
  ["MIT", "MIT"],
  ["MPL2", "MPL-2.0"],
  ["PYTHON", "Python-2.0"],
  ["ZLIB", "Zlib"],
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isInsideHostRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isInsideGuestRoots(guestPath) {
  return ALLOWED_LICENSE_ROOTS.some(
    (root) => guestPath === root || guestPath.startsWith(`${root}/`),
  );
}

function parsePacmanSections(value, sourcePath) {
  const result = new Map();
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  let key = null;
  for (const line of lines) {
    const match = /^%([A-Z0-9_]+)%$/.exec(line);
    if (match) {
      key = match[1];
      invariant(!result.has(key), `duplicate %${key}% section in ${sourcePath}`);
      result.set(key, []);
    } else if (line === "") {
      key = null;
    } else {
      invariant(key, `value outside a pacman section in ${sourcePath}`);
      result.get(key).push(line);
    }
  }
  return Object.fromEntries(result);
}

function only(metadata, key, sourcePath) {
  const values = metadata[key] ?? [];
  invariant(
    values.length === 1 && values[0],
    `pacman ${sourcePath} requires exactly one %${key}% value`,
  );
  return values[0];
}

async function readPackagesForReview(rootfs) {
  const rootInfo = await lstat(rootfs);
  invariant(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    `review rootfs is not a real directory: ${rootfs}`,
  );
  const rootReal = await realpath(rootfs);
  const database = path.join(rootReal, "var/lib/pacman/local");
  const databaseInfo = await lstat(database);
  invariant(
    databaseInfo.isDirectory() && !databaseInfo.isSymbolicLink(),
    `pacman database is not a real directory: ${database}`,
  );
  const databaseReal = await realpath(database);
  invariant(
    isInsideHostRoot(databaseReal, rootReal),
    `pacman database escapes review rootfs: ${database}`,
  );

  const entries = await readdir(databaseReal, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (entry.name === "ALPM_DB_VERSION" && entry.isFile()) continue;
    invariant(
      entry.isDirectory() && !entry.isSymbolicLink(),
      `unsafe pacman database entry: ${entry.name}`,
    );
    const relativeDescPath = safeRelativePath(
      path.posix.join("var/lib/pacman/local", entry.name, "desc"),
      "pacman metadata path",
    );
    const descPath = path.join(databaseReal, entry.name, "desc");
    const descReal = await realpath(descPath);
    invariant(
      isInsideHostRoot(descReal, rootReal),
      `pacman metadata escapes rootfs: ${relativeDescPath}`,
    );
    const descInfo = await lstat(descPath);
    invariant(
      descInfo.isFile() && !descInfo.isSymbolicLink(),
      `pacman metadata is not a regular file: ${relativeDescPath}`,
    );
    const contents = await readFile(descPath, "utf8");
    const metadata = parsePacmanSections(contents, relativeDescPath);
    const name = only(metadata, "NAME", relativeDescPath);
    const version = only(metadata, "VERSION", relativeDescPath);
    packages.push({
      name,
      version,
      base: metadata.BASE?.[0] ?? name,
      architecture: metadata.ARCH?.[0] ?? "x86_64",
      homepage: metadata.URL?.[0] ?? null,
      rawLicenses: metadata.LICENSE ?? [],
      metadataPath: relativeDescPath,
      metadataSha256: createHash("sha256").update(contents).digest("hex"),
    });
  }

  invariant(packages.length > 0, "rootfs pacman database contains no installed packages");
  const unique = new Set();
  for (const item of packages) {
    invariant(!unique.has(item.name), `duplicate installed package metadata: ${item.name}`);
    unique.add(item.name);
  }
  return {
    rootReal,
    packages: packages.sort((left, right) => compareStrings(left.name, right.name)),
  };
}

function unresolvedReason(item) {
  if (item.rawLicenses.length === 0) {
    return {
      code: "MISSING_PACMAN_LICENSE_DECLARATION",
      message: "The package has no %LICENSE% values.",
    };
  }
  if (item.rawLicenses.length > 1) {
    return {
      code: "MULTIPLE_PACMAN_LICENSE_DECLARATIONS",
      message: `Pacman supplied ${item.rawLicenses.length} separate %LICENSE% values; the builder requires a reviewed package-specific conclusion.`,
    };
  }

  const raw = item.rawLicenses[0];
  const expression = BUILDER_DEFAULT_ALIASES.get(raw.toUpperCase()) ?? raw;
  try {
    validateSpdxExpression(expression);
    return null;
  } catch (error) {
    return {
      code: "UNRESOLVED_SPDX_DECLARATION",
      message: error.message,
    };
  }
}

async function resolveGuestPath(rootfs, guestPath) {
  invariant(path.posix.isAbsolute(guestPath), `guest license path must be absolute: ${guestPath}`);
  invariant(
    path.posix.normalize(guestPath) === guestPath && isInsideGuestRoots(guestPath),
    `guest license path is outside reviewed roots: ${guestPath}`,
  );
  let pending = guestPath.split("/").filter(Boolean);
  const resolved = [];
  const followedLinks = new Set();
  const symlinks = [];

  while (pending.length > 0) {
    const component = pending.shift();
    const candidate = path.join(rootfs, ...resolved, component);
    const info = await lstat(candidate);
    if (!info.isSymbolicLink()) {
      resolved.push(component);
      continue;
    }

    const linkGuestPath = `/${[...resolved, component].join("/")}`;
    invariant(!followedLinks.has(linkGuestPath), `license symlink cycle: ${linkGuestPath}`);
    invariant(followedLinks.size < 40, `license symlink chain is too deep: ${linkGuestPath}`);
    followedLinks.add(linkGuestPath);

    const target = await readlink(candidate);
    invariant(!target.includes("\0"), `license symlink target is invalid: ${linkGuestPath}`);
    const parentGuestPath = `/${resolved.join("/")}`;
    const targetGuestPath = path.posix.normalize(
      target.startsWith("/") ? target : path.posix.join(parentGuestPath, target),
    );
    invariant(
      isInsideGuestRoots(targetGuestPath),
      `license symlink escapes reviewed guest roots: ${linkGuestPath}`,
    );
    symlinks.push({
      path: safeRelativePath(linkGuestPath.slice(1), "license symlink path"),
      target,
    });
    pending = [...targetGuestPath.split("/").filter(Boolean), ...pending];
    resolved.length = 0;
  }

  const resolvedGuestPath = `/${resolved.join("/")}`;
  const hostPath = path.join(rootfs, ...resolved);
  invariant(isInsideHostRoot(hostPath, rootfs), `resolved license path escapes rootfs: ${guestPath}`);
  return {
    guestPath: resolvedGuestPath,
    hostPath,
    info: await lstat(hostPath),
    symlinks,
  };
}

async function collectCandidateTree(rootfs, relativeRoot) {
  const guestRoot = `/${safeRelativePath(relativeRoot, "license candidate root")}`;
  try {
    await lstat(path.join(rootfs, ...relativeRoot.split("/")));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const start = await resolveGuestPath(rootfs, guestRoot);
  const candidates = [];

  async function addFile(hostPath, logicalGuestPath, resolvedGuestPath, symlinks) {
    const info = await stat(hostPath);
    invariant(info.isFile(), `license candidate is not a regular file: ${logicalGuestPath}`);
    candidates.push({
      path: safeRelativePath(logicalGuestPath.slice(1), "license candidate path"),
      resolvedPath: safeRelativePath(resolvedGuestPath.slice(1), "resolved license candidate path"),
      bytes: info.size,
      sha256: await sha256File(hostPath),
      symlinks,
    });
  }

  async function visit(
    directory,
    logicalGuestDirectory,
    physicalGuestDirectory,
    inheritedSymlinks,
    ancestors = new Set(),
  ) {
    const directoryReal = await realpath(directory);
    invariant(
      isInsideHostRoot(directoryReal, rootfs),
      `license candidate directory escapes rootfs: ${logicalGuestDirectory}`,
    );
    invariant(
      !ancestors.has(directoryReal),
      `license candidate directory symlink cycle: ${logicalGuestDirectory}`,
    );
    const nextAncestors = new Set(ancestors).add(directoryReal);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      const logicalGuestPath = path.posix.join(logicalGuestDirectory, entry.name);
      const physicalGuestPath = path.posix.join(physicalGuestDirectory, entry.name);
      const hostPath = path.join(directory, entry.name);
      const info = await lstat(hostPath);
      if (info.isDirectory()) {
        await visit(
          hostPath,
          logicalGuestPath,
          physicalGuestPath,
          inheritedSymlinks,
          nextAncestors,
        );
      } else if (info.isSymbolicLink()) {
        const resolved = await resolveGuestPath(rootfs, physicalGuestPath);
        const symlinks = [...inheritedSymlinks, ...resolved.symlinks];
        if (resolved.info.isDirectory()) {
          await visit(
            resolved.hostPath,
            logicalGuestPath,
            resolved.guestPath,
            symlinks,
            nextAncestors,
          );
        } else {
          invariant(
            resolved.info.isFile(),
            `license candidate symlink does not resolve to a file: ${logicalGuestPath}`,
          );
          await addFile(
            resolved.hostPath,
            logicalGuestPath,
            resolved.guestPath,
            symlinks,
          );
        }
      } else {
        invariant(info.isFile(), `special file is forbidden in license candidate tree: ${logicalGuestPath}`);
        await addFile(hostPath, logicalGuestPath, physicalGuestPath, inheritedSymlinks);
      }
    }
  }

  if (start.info.isDirectory()) {
    await visit(start.hostPath, guestRoot, start.guestPath, start.symlinks);
  } else {
    invariant(start.info.isFile(), `license candidate root is not a file or directory: ${relativeRoot}`);
    await addFile(start.hostPath, guestRoot, start.guestPath, start.symlinks);
  }

  return candidates.sort((left, right) => compareStrings(left.path, right.path));
}

function reviewTodo() {
  return {
    status: "TODO",
    concluded: null,
    licenseFiles: null,
    notes: "TODO: record a package-specific human review; do not infer a conclusion from filenames.",
  };
}

export async function generateLicenseReviewSkeleton(rootfs) {
  invariant(typeof rootfs === "string" && rootfs.length > 0, "review rootfs is missing");
  const { rootReal, packages } = await readPackagesForReview(path.resolve(rootfs));
  const unresolved = packages
    .map((item) => ({ item, reason: unresolvedReason(item) }))
    .filter(({ reason }) => reason !== null);

  const candidateCache = new Map();
  function candidatesAt(relativeRoot) {
    if (!candidateCache.has(relativeRoot)) {
      candidateCache.set(relativeRoot, collectCandidateTree(rootReal, relativeRoot));
    }
    return candidateCache.get(relativeRoot);
  }

  const groups = new Map();
  for (const { item, reason } of unresolved) {
    const searchPaths = [...new Set([item.name, item.base])]
      .map((name) => safeRelativePath(`usr/share/licenses/${name}`, `license candidate path for ${item.name}`))
      .sort(compareStrings);
    const candidateLists = await Promise.all(searchPaths.map(candidatesAt));
    const licenseFileCandidates = [...new Map(
      candidateLists.flat().map((candidate) => [candidate.path, candidate]),
    ).values()].sort((left, right) => compareStrings(left.path, right.path));
    const packageRecord = {
      name: item.name,
      version: item.version,
      base: item.base,
      architecture: item.architecture,
      homepage: item.homepage,
      rawPacmanLicenseDeclarations: [...item.rawLicenses],
      pacmanMetadata: {
        path: item.metadataPath,
        sha256: item.metadataSha256,
      },
      licenseFileSearchPaths: searchPaths,
      licenseFileCandidates,
      review: reviewTodo(),
    };
    const key = JSON.stringify(item.rawLicenses);
    const group = groups.get(key) ?? {
      rawPacmanLicenseDeclarations: [...item.rawLicenses],
      unresolvedReason: reason,
      packages: [],
    };
    group.packages.push(packageRecord);
    groups.set(key, group);
  }

  const declarationGroups = [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, group]) => ({
      ...group,
      packageCount: group.packages.length,
      packages: group.packages.sort((left, right) => compareStrings(left.name, right.name)),
    }));
  const packagesWithoutCandidates = declarationGroups
    .flatMap((group) => group.packages)
    .filter((item) => item.licenseFileCandidates.length === 0)
    .map((item) => item.name)
    .sort(compareStrings);
  const uniqueCandidates = [...new Map(
    declarationGroups
      .flatMap((group) => group.packages)
      .flatMap((item) => item.licenseFileCandidates)
      .map((candidate) => [candidate.path, candidate]),
  ).values()].sort((left, right) => compareStrings(left.path, right.path));
  const metadataFingerprintInput = packages.map((item) => ({
    name: item.name,
    version: item.version,
    rawPacmanLicenseDeclarations: item.rawLicenses,
    pacmanMetadataSha256: item.metadataSha256,
  }));

  return {
    schemaVersion: 1,
    documentType: "omarchy-package-license-review-skeleton",
    legalStatus: "NOT_CLEARED",
    reviewStatus: "TODO",
    generatedConclusions: 0,
    instructions: [
      "This is an engineering inventory, not a legal conclusion or release approval.",
      "Review each package independently even when packages share a raw declaration group.",
      "Installed filenames are candidates only; they do not establish the applicable license.",
      "Replace TODO/null values only after human review, then transfer reviewed decisions explicitly into the distribution config.",
    ],
    inputFingerprints: {
      packageMetadataSha256: hashJson(metadataFingerprintInput),
      candidateLicenseFilesSha256: hashJson(uniqueCandidates),
    },
    summary: {
      installedPackageCount: packages.length,
      packagesResolvedByBuilderDefaults: packages.length - unresolved.length,
      packagesRequiringReview: unresolved.length,
      rawDeclarationGroupsRequiringReview: declarationGroups.length,
      packagesWithoutInstalledLicenseFileCandidates: packagesWithoutCandidates.length,
    },
    packagesWithoutInstalledLicenseFileCandidates: packagesWithoutCandidates,
    declarationGroups,
  };
}

export function serializeLicenseReviewSkeleton(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function usage() {
  return "Usage: node distribution/license-review.mjs --rootfs PATH [--output FILE]\n";
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  let rootfs = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    invariant(argument === "--rootfs" || argument === "--output", usage().trim());
    const value = argv[index + 1];
    invariant(value && !value.startsWith("--"), `${argument} requires a value`);
    if (argument === "--rootfs") {
      invariant(rootfs === null, "--rootfs may only be specified once");
      rootfs = value;
    } else {
      invariant(output === null, "--output may only be specified once");
      output = value;
    }
    index += 1;
  }
  invariant(rootfs !== null, usage().trim());
  return { help: false, rootfs: path.resolve(rootfs), output: output ? path.resolve(output) : null };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await generateLicenseReviewSkeleton(options.rootfs);
  if (options.output) {
    await writeJsonDeterministic(options.output, report);
    process.stdout.write(
      `Review skeleton written to ${options.output}: ${report.summary.packagesRequiringReview} packages in ${report.summary.rawDeclarationGroupsRequiringReview} raw-declaration groups; legal clearance: required\n`,
    );
  } else {
    process.stdout.write(serializeLicenseReviewSkeleton(report));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
