#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_LICENSE_COMPONENTS = new Set(["omarchy", "qemu-wasm", "linux"]);
const SHA256 = /^[0-9a-f]{64}$/i;
const BUILDER_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value, label = "artifact path") {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  invariant(!path.isAbsolute(value), `${label} must be relative: ${value}`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  invariant(
    normalized !== ".." && !normalized.startsWith("../") && normalized !== ".",
    `${label} escapes its artifact directory: ${value}`,
  );
  return normalized;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function describeFile(filePath, { artifactPath, role, mediaType }) {
  const info = await stat(filePath);
  invariant(info.isFile() && info.size > 0, `release artifact is empty: ${filePath}`);
  return {
    path: safeRelativePath(artifactPath),
    role,
    bytes: info.size,
    sha256: await sha256(filePath),
    mediaType,
  };
}

function validateFragment(fragment, kind) {
  invariant(isRecord(fragment) && fragment.schemaVersion === 1, `${kind} fragment has an unsupported schema`);
  invariant(Array.isArray(fragment.artifacts) && fragment.artifacts.length > 0, `${kind} fragment has no artifacts`);
  for (const artifact of fragment.artifacts) {
    invariant(isRecord(artifact), `${kind} fragment contains invalid artifact metadata`);
    safeRelativePath(artifact.path, `${kind} artifact path`);
    invariant(typeof artifact.role === "string" && artifact.role.length > 0, `${kind} artifact role is missing`);
    invariant(Number.isInteger(artifact.bytes) && artifact.bytes > 0, `${kind} artifact size is invalid`);
    invariant(SHA256.test(artifact.sha256 ?? ""), `${kind} artifact digest is invalid`);
    invariant(typeof artifact.mediaType === "string" && artifact.mediaType.includes("/"), `${kind} artifact media type is invalid`);
  }
}

async function copyVerifiedFragmentArtifacts(fragment, sourceRoot, stagingRoot, seenPaths) {
  const copied = [];
  for (const artifact of fragment.artifacts) {
    const relativePath = safeRelativePath(artifact.path);
    invariant(!seenPaths.has(relativePath), `duplicate release artifact path: ${relativePath}`);
    const sourcePath = path.resolve(sourceRoot, relativePath);
    invariant(
      sourcePath === path.resolve(sourceRoot, relativePath) &&
        sourcePath.startsWith(`${path.resolve(sourceRoot)}${path.sep}`),
      `artifact escapes source root: ${relativePath}`,
    );
    const [info, digest] = await Promise.all([lstat(sourcePath), sha256(sourcePath)]);
    invariant(info.isFile(), `artifact is not a file: ${relativePath}`);
    invariant(info.size === artifact.bytes, `artifact size changed after fragment creation: ${relativePath}`);
    invariant(digest === artifact.sha256.toLowerCase(), `artifact digest changed after fragment creation: ${relativePath}`);

    const destinationPath = path.join(stagingRoot, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    seenPaths.add(relativePath);
    copied.push({ ...artifact, path: relativePath, sha256: digest });
  }
  return copied;
}

function validateLicenses(licenses) {
  invariant(Array.isArray(licenses) && licenses.length > 0, "release input must include license records");
  const components = new Set();
  for (const record of licenses) {
    invariant(isRecord(record), "license record must be an object");
    invariant(typeof record.component === "string" && record.component.length > 0, "license component is missing");
    invariant(typeof record.spdx === "string" && record.spdx.length > 0, `SPDX expression is missing for ${record.component}`);
    safeRelativePath(record.noticePath, `notice path for ${record.component}`);
    invariant(/^https:\/\//.test(record.sourceUrl ?? ""), `HTTPS source URL is missing for ${record.component}`);
    components.add(record.component.toLowerCase());
  }
  for (const component of REQUIRED_LICENSE_COMPONENTS) {
    invariant(components.has(component), `license record is missing for ${component}`);
  }
}

function validateRuntimeAssets(runtimeManifest, paths) {
  const assets = runtimeManifest?.assets;
  invariant(isRecord(assets), "runtime manifest is missing assets");
  const required = [assets.module, assets.preload, assets.data, ...Object.values(assets.locate ?? {})];
  for (const value of required) {
    const artifactPath = safeRelativePath(value, "runtime manifest asset");
    invariant(paths.has(artifactPath), `runtime manifest references an unpackaged asset: ${artifactPath}`);
  }
}

function chooseBuilderDigest(runtimeBuild, guestBuild) {
  const candidates = [
    runtimeBuild.builderImageId,
    runtimeBuild.builderImage,
    guestBuild?.builderImageDigest,
  ];
  const selected = candidates.find((value) => BUILDER_DIGEST.test(value ?? ""));
  invariant(selected, "neither build fragment records a sha256 builder image digest");
  return selected;
}

function resolveConfigPath(configRoot, value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  return path.resolve(configRoot, value);
}

export async function assembleRelease(config, { configRoot = process.cwd() } = {}) {
  invariant(isRecord(config), "release input must be an object");
  const runtimeDirectory = resolveConfigPath(configRoot, config.runtimeDirectory, "runtimeDirectory");
  const guestDirectory = resolveConfigPath(configRoot, config.guestDirectory, "guestDirectory");
  const outputDirectory = resolveConfigPath(configRoot, config.outputDirectory, "outputDirectory");
  const licenseBundle = resolveConfigPath(configRoot, config.licenseBundle, "licenseBundle");
  const sbom = resolveConfigPath(configRoot, config.sbom, "sbom");
  const runtimeSource = resolveConfigPath(configRoot, config.runtimeSource, "runtimeSource");

  invariant(/^https:\/\//.test(config.runtime?.correspondingSourceUrl ?? ""), "runtime corresponding-source URL must use HTTPS");
  invariant(typeof config.runtime?.license === "string" && config.runtime.license.length > 0, "runtime license is missing");
  validateLicenses(config.licenses);

  const runtimeBuildPath = path.join(runtimeDirectory, "runtime-build.json");
  const runtimeManifestPath = path.join(runtimeDirectory, "runtime-manifest.json");
  const guestManifestPath = path.join(guestDirectory, "guest-manifest.json");
  const [runtimeBuild, runtimeManifest, guestFragment] = await Promise.all([
    readJson(runtimeBuildPath),
    readJson(runtimeManifestPath),
    readJson(guestManifestPath),
  ]);
  validateFragment(runtimeBuild, "runtime");
  validateFragment(guestFragment, "guest");

  invariant(runtimeBuild.component?.name === "QEMU-Wasm", "runtime fragment is not QEMU-Wasm");
  invariant(/^[0-9a-f]{40}$/i.test(runtimeBuild.component?.commit ?? ""), "runtime commit is not immutable");
  invariant(!Number.isNaN(Date.parse(runtimeBuild.generatedAt ?? "")), "runtime build timestamp is invalid");
  invariant(guestFragment.upstream?.repository === "https://github.com/basecamp/omarchy", "guest fragment is not official Omarchy");
  invariant(/^[0-9a-f]{40}$/i.test(guestFragment.upstream?.commit ?? ""), "Omarchy commit is not immutable");
  invariant(
    SHA256.test(guestFragment.normalizedUpstreamTree?.sha256 ?? guestFragment.upstream?.treeSha256 ?? ""),
    "Omarchy normalized tree digest is missing",
  );

  try {
    await stat(outputDirectory);
    throw new Error(`refusing to replace existing release directory: ${outputDirectory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const stagingRoot = `${outputDirectory}.staging-${process.pid}-${Date.now()}`;
  await mkdir(stagingRoot, { recursive: false });

  const paths = new Set();
  const artifacts = [];
  try {
    artifacts.push(
      ...(await copyVerifiedFragmentArtifacts(runtimeBuild, runtimeDirectory, stagingRoot, paths)),
      ...(await copyVerifiedFragmentArtifacts(guestFragment, guestDirectory, stagingRoot, paths)),
    );

    const extras = [
      [runtimeManifestPath, "runtime-manifest.json", "emulator-config", "application/json"],
      [runtimeBuildPath, "runtime-build.json", "emulator-metadata", "application/json"],
      [guestManifestPath, "guest-manifest.json", "guest-metadata", "application/json"],
      [licenseBundle, safeRelativePath(config.licenseBundleName ?? "THIRD_PARTY_NOTICES.tar.zst"), "license-bundle", "application/zstd"],
      [sbom, safeRelativePath(config.sbomName ?? "sbom.spdx.json"), "sbom", "application/spdx+json"],
      [runtimeSource, safeRelativePath(config.runtimeSourceName ?? "qemu-wasm-corresponding-source.tar.zst"), "emulator-source", "application/zstd"],
    ];
    for (const [sourcePath, artifactPath, role, mediaType] of extras) {
      invariant(!paths.has(artifactPath), `duplicate release artifact path: ${artifactPath}`);
      const destinationPath = path.join(stagingRoot, artifactPath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      artifacts.push(await describeFile(destinationPath, { artifactPath, role, mediaType }));
      paths.add(artifactPath);
    }

    validateRuntimeAssets(runtimeManifest, paths);
    for (const license of config.licenses) {
      invariant(paths.has(safeRelativePath(license.noticePath)), `license notice is not packaged: ${license.noticePath}`);
    }

    const manifest = {
      schemaVersion: 1,
      product: "Omarchy browser demo",
      upstream: {
        repository: guestFragment.upstream.repository,
        commit: guestFragment.upstream.commit,
        version: guestFragment.upstream.version,
        license: guestFragment.upstream.license,
        treeSha256: guestFragment.normalizedUpstreamTree?.sha256 ?? guestFragment.upstream.treeSha256,
      },
      runtime: {
        name: "qemu-wasm",
        repository: runtimeBuild.component.repository,
        commit: runtimeBuild.component.commit,
        license: config.runtime.license,
        modified: runtimeBuild.component.modified === true,
        correspondingSourceUrl: config.runtime.correspondingSourceUrl,
      },
      build: {
        builtAt: runtimeBuild.generatedAt,
        builderImageDigest: chooseBuilderDigest(runtimeBuild, guestFragment.build),
        sourceDateEpoch: guestFragment.build.sourceDateEpoch,
        ...(config.workflowUrl ? { workflowUrl: config.workflowUrl } : {}),
      },
      guest: {
        architecture: guestFragment.guest.architecture,
        distribution: guestFragment.guest.distribution,
        display: {
          width: guestFragment.guest.display.width,
          height: guestFragment.guest.display.height,
        },
      },
      artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
      licenses: config.licenses,
    };

    await writeFile(
      path.join(stagingRoot, "artifact-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await rename(stagingRoot, outputDirectory);
    return { outputDirectory, manifest };
  } catch (error) {
    // A failed stage is intentionally left in place for inspection. It is never
    // promoted and a later invocation uses a distinct staging directory.
    error.message = `${error.message} (incomplete staging directory: ${stagingRoot})`;
    throw error;
  }
}

function parseArguments(argv) {
  const args = { config: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") args.config = argv[++index];
    else throw new Error(`Usage: node release/assemble.mjs --config release-input.json`);
  }
  invariant(args.config, "Usage: node release/assemble.mjs --config release-input.json");
  return args;
}

async function main() {
  const { config: configPathInput } = parseArguments(process.argv.slice(2));
  const configPath = path.resolve(configPathInput);
  const config = await readJson(configPath);
  const result = await assembleRelease(config, { configRoot: path.dirname(configPath) });
  process.stdout.write(`Release staged atomically at ${result.outputDirectory}\n`);
  process.stdout.write(`Artifacts: ${result.manifest.artifacts.length}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
