import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { invariant, safeRelativePath, sha256File } from "./archive.mjs";

const KNOWN_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-1.1",
  "Apache-2.0",
  "Artistic-1.0-Perl",
  "Artistic-2.0",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-2-Clause-Patent",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "BSD-4-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "CDDL-1.0",
  "curl",
  "EPL-1.0",
  "EPL-2.0",
  "FSFAP",
  "FSFUL",
  "FSFULLR",
  "FTL",
  "GFDL-1.1-only",
  "GFDL-1.1-or-later",
  "GFDL-1.2-only",
  "GFDL-1.2-or-later",
  "GFDL-1.3-only",
  "GFDL-1.3-or-later",
  "GPL-1.0-only",
  "GPL-1.0-or-later",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "HPND",
  "ICU",
  "IJG",
  "ISC",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "libpng-2.0",
  "libtiff",
  "MIT",
  "MIT-0",
  "MPL-1.1",
  "MPL-2.0",
  "NCSA",
  "OpenSSL",
  "OFL-1.0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "W3C",
  "X11",
  "Zlib",
]);

const KNOWN_EXCEPTIONS = new Set([
  "Autoconf-exception-2.0",
  "Autoconf-exception-3.0",
  "Bison-exception-2.2",
  "Bootloader-exception",
  "Classpath-exception-2.0",
  "FLTK-exception",
  "Font-exception-2.0",
  "GCC-exception-2.0",
  "GCC-exception-3.1",
  "LLVM-exception",
  "Linux-syscall-note",
  "OpenJDK-assembly-exception-1.0",
  "Qt-GPL-exception-1.0",
]);

const LEGACY_ALIASES = new Map([
  ["APACHE", "Apache-2.0"],
  ["BOOST", "BSL-1.0"],
  ["ISC", "ISC"],
  ["MIT", "MIT"],
  ["MPL2", "MPL-2.0"],
  ["PYTHON", "Python-2.0"],
  ["ZLIB", "Zlib"],
]);

function tokens(expression) {
  const found = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/g) ?? [];
  invariant(found.join("") === expression.replaceAll(/\s+/g, ""), `invalid SPDX expression syntax: ${expression}`);
  return found;
}

export function validateSpdxExpression(expression, additionalIds = []) {
  invariant(typeof expression === "string" && expression.trim() === expression && expression.length > 0, "SPDX expression is missing");
  invariant(!/\b(?:NOASSERTION|NONE|unknown|custom)\b/i.test(expression), `unresolved SPDX expression: ${expression}`);
  const allowedIds = new Set([...KNOWN_LICENSE_IDS, ...additionalIds]);
  const input = tokens(expression);
  let index = 0;

  function primary() {
    if (input[index] === "(") {
      index += 1;
      orExpression();
      invariant(input[index] === ")", `unbalanced SPDX expression: ${expression}`);
      index += 1;
      return;
    }
    const id = input[index];
    invariant(id && id !== "AND" && id !== "OR" && id !== "WITH" && id !== ")", `expected a license ID in: ${expression}`);
    invariant(allowedIds.has(id) || /^LicenseRef-[A-Za-z0-9.-]+$/.test(id), `unknown SPDX license ID ${id} in: ${expression}`);
    index += 1;
    if (input[index] === "WITH") {
      index += 1;
      const exception = input[index];
      invariant(KNOWN_EXCEPTIONS.has(exception), `unknown SPDX exception ${exception} in: ${expression}`);
      index += 1;
    }
  }

  function andExpression() {
    primary();
    while (input[index] === "AND") {
      index += 1;
      primary();
    }
  }

  function orExpression() {
    andExpression();
    while (input[index] === "OR") {
      index += 1;
      andExpression();
    }
  }

  orExpression();
  invariant(index === input.length, `invalid SPDX expression: ${expression}`);
  return expression;
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
  invariant(values.length === 1 && values[0], `pacman ${sourcePath} requires exactly one %${key}% value`);
  return values[0];
}

export async function readInstalledPackages(rootfs) {
  const database = path.join(rootfs, "var/lib/pacman/local");
  const rootReal = await realpath(rootfs);
  const entries = await readdir(database, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "ALPM_DB_VERSION" && entry.isFile()) continue;
    invariant(entry.isDirectory() && !entry.isSymbolicLink(), `unsafe pacman database entry: ${entry.name}`);
    const descPath = path.join(database, entry.name, "desc");
    const descReal = await realpath(descPath);
    invariant(descReal.startsWith(`${rootReal}${path.sep}`), `pacman metadata escapes rootfs: ${descPath}`);
    const descInfo = await lstat(descPath);
    invariant(descInfo.isFile() && !descInfo.isSymbolicLink(), `pacman metadata is not a regular file: ${descPath}`);
    const contents = await readFile(descPath, "utf8");
    const metadata = parsePacmanSections(contents, descPath);
    const name = only(metadata, "NAME", descPath);
    const version = only(metadata, "VERSION", descPath);
    const license = metadata.LICENSE ?? [];
    invariant(license.length > 0 && license.every(Boolean), `package ${name} has no declared license data`);
    packages.push({
      name,
      version,
      base: metadata.BASE?.[0] ?? name,
      architecture: metadata.ARCH?.[0] ?? "x86_64",
      homepage: metadata.URL?.[0] ?? null,
      rawLicenses: license,
      descPath,
      descSha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  invariant(packages.length > 0, "rootfs pacman database contains no installed packages");
  const unique = new Set();
  for (const item of packages) {
    invariant(!unique.has(item.name), `duplicate installed package metadata: ${item.name}`);
    unique.add(item.name);
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readPackageLock(lockPath) {
  const value = await readFile(lockPath, "utf8");
  if (lockPath.endsWith(".json")) {
    const parsed = JSON.parse(value);
    invariant(
      parsed &&
        typeof parsed === "object" &&
        parsed.packages &&
        typeof parsed.packages === "object" &&
        !Array.isArray(parsed.packages),
      "package lock JSON is invalid",
    );
    return {
      architecture: parsed.architecture ?? "x86_64",
      packages: new Map(Object.entries(parsed.packages ?? {})),
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  const packages = new Map();
  for (const [index, line] of value.replaceAll("\r\n", "\n").split("\n").entries()) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    invariant(separator > 0 && separator < line.length - 1, `invalid package lock line ${index + 1}`);
    const name = line.slice(0, separator);
    const version = line.slice(separator + 1);
    invariant(!packages.has(name), `duplicate package in lock: ${name}`);
    packages.set(name, version);
  }
  invariant(packages.size > 0, "package lock contains no packages");
  return { architecture: "x86_64", packages, sha256: createHash("sha256").update(value).digest("hex") };
}

export function verifyPackageLock(installed, lock) {
  const installedMap = new Map(installed.map((item) => [item.name, item.version]));
  const missing = [...lock.packages].filter(([name, version]) => installedMap.get(name) !== version);
  const extra = [...installedMap].filter(([name, version]) => lock.packages.get(name) !== version);
  invariant(
    missing.length === 0 && extra.length === 0,
    `installed package set does not match the reviewed lock (missing/changed: ${missing.map(([name]) => name).join(", ") || "none"}; extra/changed: ${extra.map(([name]) => name).join(", ") || "none"})`,
  );
}

function isInsideGuestRoot(guestPath, allowedGuestRoot) {
  return guestPath === allowedGuestRoot || guestPath.startsWith(`${allowedGuestRoot}/`);
}

async function resolveGuestPath(rootfs, guestPath, allowedGuestRoot) {
  let pending = path.posix.normalize(`/${guestPath}`).split("/").filter(Boolean);
  const resolved = [];
  const followedLinks = new Set();

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
      isInsideGuestRoot(targetGuestPath, allowedGuestRoot),
      `license symlink escapes license root: ${linkGuestPath}`,
    );
    pending = [
      ...targetGuestPath.split("/").filter(Boolean),
      ...pending,
    ];
    resolved.length = 0;
  }

  const resolvedGuestPath = `/${resolved.join("/")}`;
  const resolvedHostPath = path.join(rootfs, ...resolved);
  return {
    guestPath: resolvedGuestPath,
    hostPath: resolvedHostPath,
    info: await lstat(resolvedHostPath),
  };
}

async function collectTreeFiles(rootfs, relativeRoot) {
  const rootReal = await realpath(rootfs);
  const start = path.join(rootfs, ...relativeRoot.split("/"));
  const startInfo = await lstat(start);
  invariant(startInfo.isDirectory() && !startInfo.isSymbolicLink(), `license root is not a directory: ${relativeRoot}`);
  const startReal = await realpath(start);
  invariant(startReal.startsWith(`${rootReal}${path.sep}`), `license root escapes the rootfs: ${relativeRoot}`);
  const files = [];

  const allowedGuestRoot = `/${relativeRoot}`;

  async function visit(
    directory,
    relativeDirectory,
    physicalGuestDirectory = relativeDirectory,
    ancestors = new Set(),
  ) {
    const directoryReal = await realpath(directory);
    invariant(directoryReal.startsWith(`${rootReal}${path.sep}`), `license directory escapes rootfs: ${relativeDirectory}`);
    invariant(!ancestors.has(directoryReal), `license directory symlink cycle: ${relativeDirectory}`);
    const nextAncestors = new Set(ancestors).add(directoryReal);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = safeRelativePath(path.posix.join(relativeDirectory, entry.name), "rootfs license path");
      const physicalGuestPath = path.posix.join(physicalGuestDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isDirectory()) {
        invariant(!info.isSymbolicLink(), `license directory is a symlink: ${relativePath}`);
        await visit(absolutePath, relativePath, physicalGuestPath, nextAncestors);
      } else if (info.isSymbolicLink()) {
        const resolved = await resolveGuestPath(rootfs, physicalGuestPath, allowedGuestRoot);
        invariant(
          isInsideGuestRoot(resolved.guestPath, allowedGuestRoot),
          `license symlink escapes license root: ${relativePath}`,
        );
        if (resolved.info.isDirectory()) {
          await visit(
            resolved.hostPath,
            relativePath,
            resolved.guestPath.slice(1),
            nextAncestors,
          );
        }
        else {
          invariant(resolved.info.isFile(), `license symlink does not resolve to a file: ${relativePath}`);
          files.push({ logicalPath: relativePath, sourcePath: resolved.hostPath });
        }
      } else {
        invariant(info.isFile(), `special file is forbidden in license tree: ${relativePath}`);
        files.push({ logicalPath: relativePath, sourcePath: absolutePath });
      }
    }
  }

  await visit(start, relativeRoot);
  invariant(files.length > 0, `license tree contains no files: ${relativeRoot}`);
  for (const item of files) {
    item.sha256 = await sha256File(item.sourcePath);
    item.bytes = (await stat(item.sourcePath)).size;
  }
  return files;
}

function resolvePackageExpression(item, overrides, mappings, additionalIds) {
  const override = overrides[item.name];
  if (override) {
    invariant(typeof override === "object" && !Array.isArray(override), `license override for ${item.name} is invalid`);
    const expression = validateSpdxExpression(override.concluded, additionalIds);
    return { expression, override };
  }
  invariant(
    item.rawLicenses.length === 1,
    `package ${item.name} declares multiple licenses (${item.rawLicenses.join(", ")}); a reviewed packageLicenseOverrides entry is required`,
  );
  const raw = item.rawLicenses[0];
  const mapped = mappings[raw] ?? LEGACY_ALIASES.get(raw.toUpperCase()) ?? raw;
  return { expression: validateSpdxExpression(mapped, additionalIds), override: null };
}

function packageNoticeFiles(item, corpus, override) {
  const prefixes = new Set([
    `usr/share/licenses/${item.name}/`,
    `usr/share/licenses/${item.base}/`,
  ]);
  let files = corpus.filter((file) => [...prefixes].some((prefix) => file.logicalPath.startsWith(prefix)));
  if (override?.licenseFiles) {
    invariant(Array.isArray(override.licenseFiles) && override.licenseFiles.length > 0, `licenseFiles override for ${item.name} is empty`);
    files = override.licenseFiles.map((input) => {
      const relative = safeRelativePath(input, `license file override for ${item.name}`);
      const match = corpus.find((file) => file.logicalPath === relative);
      invariant(match, `license file override for ${item.name} is not in /usr/share/licenses: ${relative}`);
      return match;
    });
  }
  return [...new Map(files.map((file) => [file.logicalPath, file])).values()];
}

export async function resolveGuestLicenses(rootfs, packages, config = {}) {
  const corpus = await collectTreeFiles(rootfs, "usr/share/licenses");
  const overrides = config.packageLicenseOverrides ?? {};
  const mappings = config.licenseMappings ?? {};
  const additionalIds = config.additionalSpdxLicenseIds ?? [];
  invariant(Array.isArray(additionalIds) && additionalIds.every((id) => /^[A-Za-z0-9.+-]+$/.test(id)), "additionalSpdxLicenseIds is invalid");
  const resolved = [];
  const extractedLicenses = new Map();
  const failures = [];

  for (const item of packages) {
    try {
      const { expression, override } = resolvePackageExpression(item, overrides, mappings, additionalIds);
      const licenseFiles = packageNoticeFiles(item, corpus, override);
      const licenseRefs = expression.match(/LicenseRef-[A-Za-z0-9.-]+/g) ?? [];
      if (licenseRefs.length > 0) {
        invariant(new Set(licenseRefs).size === 1, `package ${item.name} uses multiple LicenseRef IDs; split it into reviewed extracted licenses`);
        invariant(licenseFiles.length > 0, `package ${item.name} uses ${licenseRefs[0]} but provides no reviewed license text`);
        const extractedText = (
          await Promise.all(licenseFiles.map(async (file) => `----- ${file.logicalPath} -----\n${await readFile(file.sourcePath, "utf8")}`))
        ).join("\n\n");
        const existing = extractedLicenses.get(licenseRefs[0]);
        invariant(!existing || existing.extractedText === extractedText, `LicenseRef ${licenseRefs[0]} resolves to different texts`);
        extractedLicenses.set(licenseRefs[0], {
          licenseId: licenseRefs[0],
          extractedText,
          name: override?.name ?? `${item.name} package license`,
          ...(Array.isArray(override?.seeAlso) ? { seeAlsos: override.seeAlso } : {}),
        });
      }
      resolved.push({ ...item, concludedLicense: expression, licenseFiles });
    } catch (error) {
      failures.push(`${item.name}: ${error.message}`);
    }
  }

  invariant(
    failures.length === 0,
    `unresolved package license data (${failures.length}):\n- ${failures.join("\n- ")}`,
  );

  invariant(resolved.some((item) => item.name === "linux"), "the guest package set is missing the Linux kernel package");
  const linux = resolved.find((item) => item.name === "linux");
  invariant(/GPL-2\.0-(?:only|or-later)/.test(linux.concludedLicense), `Linux package license was not resolved to GPL-2.0: ${linux.concludedLicense}`);
  return {
    packages: resolved,
    corpus,
    extractedLicenses: [...extractedLicenses.values()].sort((left, right) => left.licenseId.localeCompare(right.licenseId)),
    additionalIds: [...additionalIds].sort(),
  };
}

export function purlForPackage(item) {
  return `pkg:arch/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}?arch=${encodeURIComponent(item.architecture)}`;
}

export function spdxIdForPackage(name) {
  const clean = name.replace(/[^A-Za-z0-9.-]/g, "-");
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 10);
  return `SPDXRef-Arch-${clean}-${suffix}`;
}
