#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VerificationResult,
  fileSize,
  finishCli,
  isFullGitSha,
  isIsoDate,
  isRecord,
  isSha256,
  parseArguments,
  readContract,
  readJson,
  resolveInside,
  sha256File,
} from "./lib.mjs";

const OMARCHY_REPOSITORY = "https://github.com/basecamp/omarchy";

function validUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function verifyArtifactManifest(
  manifest,
  { artifactRoot, checkFiles = true } = {},
) {
  const contract = await readContract();
  const result = new VerificationResult("artifact manifest");
  const upstream = manifest?.upstream;
  const runtime = manifest?.runtime;
  const build = manifest?.build;
  const guest = manifest?.guest;
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const licenses = Array.isArray(manifest?.licenses) ? manifest.licenses : [];

  result.check(
    "MANIFEST-001",
    manifest?.schemaVersion === 1 && manifest?.product === contract.product,
    "manifest uses the supported schema and product name",
  );
  result.check(
    "AUTH-001",
    upstream?.repository === OMARCHY_REPOSITORY &&
      isFullGitSha(upstream?.commit) &&
      typeof upstream?.version === "string" &&
      upstream.version.length > 0 &&
      upstream?.license === "MIT",
    "Omarchy is pinned to the official repository at a full commit SHA",
    upstream,
  );
  result.check(
    "MANIFEST-002",
    runtime?.name === "qemu-wasm" &&
      validUrl(runtime?.repository) &&
      isFullGitSha(runtime?.commit) &&
      typeof runtime?.license === "string" &&
      runtime.license.length > 0 &&
      typeof runtime?.modified === "boolean" &&
      validUrl(runtime?.correspondingSourceUrl),
    "emulator provenance and corresponding source URL are recorded",
    runtime,
  );
  result.check(
    "MANIFEST-003",
    isIsoDate(build?.builtAt) &&
      /^sha256:[0-9a-f]{64}$/i.test(build?.builderImageDigest ?? "") &&
      Number.isInteger(build?.sourceDateEpoch) &&
      build.sourceDateEpoch > 0,
    "build time, builder digest, and source epoch are immutable",
    build,
  );
  result.check(
    "AUTH-002",
    guest?.architecture === "x86_64" &&
      guest?.distribution === "Arch Linux" &&
      guest?.display?.width === contract.thresholds.guestWidth &&
      guest?.display?.height === contract.thresholds.guestHeight,
    "guest architecture, distribution, and display match the demo contract",
    guest,
  );

  const roles = new Set(artifacts.map((artifact) => artifact?.role));
  const missingRoles = contract.requiredArtifactRoles.filter(
    (role) => !roles.has(role),
  );
  result.check(
    "MANIFEST-004",
    missingRoles.length === 0,
    "all required release artifact roles are present",
    { missingRoles },
  );

  const paths = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const prefix = `ARTIFACT-${String(index + 1).padStart(3, "0")}`;
    const shapeValid =
      isRecord(artifact) &&
      typeof artifact.path === "string" &&
      artifact.path.length > 0 &&
      typeof artifact.role === "string" &&
      artifact.role.length > 0 &&
      Number.isInteger(artifact.bytes) &&
      artifact.bytes > 0 &&
      isSha256(artifact.sha256) &&
      typeof artifact.mediaType === "string" &&
      artifact.mediaType.includes("/");
    result.check(prefix, shapeValid, `${artifact?.role ?? "artifact"} metadata is valid`);

    if (!shapeValid) continue;
    result.check(
      `${prefix}-PATH`,
      !paths.has(artifact.path),
      `${artifact.path} appears only once in the manifest`,
    );
    paths.add(artifact.path);

    if (artifact.role === "emulator-wasm") {
      result.check(
        `${prefix}-MIME`,
        artifact.mediaType === "application/wasm",
        "WebAssembly is declared as application/wasm",
        artifact.mediaType,
      );
    }

    if (!checkFiles) continue;
    try {
      const filePath = resolveInside(artifactRoot, artifact.path);
      const [bytes, digest] = await Promise.all([
        fileSize(filePath),
        sha256File(filePath),
      ]);
      result.check(
        `${prefix}-SIZE`,
        bytes === artifact.bytes,
        `${artifact.path} size matches its manifest`,
        { expected: artifact.bytes, actual: bytes },
      );
      result.check(
        `${prefix}-SHA256`,
        digest.toLowerCase() === artifact.sha256.toLowerCase(),
        `${artifact.path} SHA-256 matches its manifest`,
        { expected: artifact.sha256, actual: digest },
      );
    } catch (error) {
      result.check(
        `${prefix}-FILE`,
        false,
        `${artifact.path} can be read inside the artifact root`,
        error.message,
      );
    }
  }

  const licenseComponents = new Map(
    licenses.map((license) => [license?.component?.toLowerCase(), license]),
  );
  const requiredLicenseComponents = ["omarchy", "qemu-wasm", "linux"];
  const missingLicenseComponents = requiredLicenseComponents.filter(
    (component) => !licenseComponents.has(component),
  );
  const licenseRecordsValid = licenses.every(
    (license) =>
      isRecord(license) &&
      typeof license.component === "string" &&
      license.component.length > 0 &&
      typeof license.spdx === "string" &&
      license.spdx.length > 0 &&
      typeof license.noticePath === "string" &&
      license.noticePath.length > 0 &&
      validUrl(license.sourceUrl),
  );
  result.check(
    "LIC-001",
    licenseRecordsValid && missingLicenseComponents.length === 0,
    "core components have SPDX identifiers, notices, and source URLs",
    { missingLicenseComponents },
  );

  return result;
}

async function main() {
  const { values, positional } = parseArguments(process.argv.slice(2), {
    "artifact-root": "string",
    "metadata-only": "boolean",
    json: "boolean",
  });
  const manifestPath = positional[0];
  if (!manifestPath) {
    throw new Error(
      "Usage: verify-artifact-manifest.mjs <manifest.json> [--artifact-root DIR] [--metadata-only] [--json]",
    );
  }
  const absoluteManifestPath = path.resolve(manifestPath);
  const artifactRoot = path.resolve(
    values["artifact-root"] ?? path.dirname(absoluteManifestPath),
  );
  const manifest = await readJson(absoluteManifestPath);
  const result = await verifyArtifactManifest(manifest, {
    artifactRoot,
    checkFiles: !values["metadata-only"],
  });
  finishCli(result, { json: values.json });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
