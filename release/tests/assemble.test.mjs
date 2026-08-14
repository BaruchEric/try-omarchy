import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleRelease } from "../assemble.mjs";
import { verifyArtifactManifest } from "../../scripts/verification/verify-artifact-manifest.mjs";

const BUILDER_DIGEST = `sha256:${"a".repeat(64)}`;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function put(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await writeFile(target, value);
  return {
    path: relativePath,
    bytes: Buffer.byteLength(value),
    sha256: digest(value),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarchy-release-test-"));
  const runtime = path.join(root, "runtime");
  const guest = path.join(root, "guest");
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(runtime)),
    import("node:fs/promises").then(({ mkdir }) => mkdir(guest)),
  ]);

  const runtimeArtifacts = [];
  for (const [name, role, mediaType, value] of [
    ["qemu.mjs", "emulator-loader", "text/javascript", "export default 1"],
    ["qemu.wasm", "emulator-wasm", "application/wasm", "wasm-fixture"],
    ["qemu.worker.js", "emulator-worker", "text/javascript", "worker-fixture"],
    ["load.js", "emulator-preload", "text/javascript", "preload-fixture"],
    ["qemu.data", "guest-package", "application/octet-stream", "data-fixture"],
  ]) {
    runtimeArtifacts.push({ ...(await put(runtime, name, value)), role, mediaType });
  }

  const runtimeManifest = {
    schemaVersion: 1,
    assets: {
      module: "qemu.mjs",
      preload: "load.js",
      data: "qemu.data",
      locate: { "qemu-system-x86_64.wasm": "qemu.wasm", "qemu-system-x86_64.worker.js": "qemu.worker.js" },
    },
  };
  const runtimeBuild = {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:00:00.000Z",
    component: {
      name: "QEMU-Wasm",
      repository: "https://github.com/ktock/qemu-wasm.git",
      commit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
      modified: true,
    },
    builderImageId: BUILDER_DIGEST,
    artifacts: runtimeArtifacts,
  };
  await writeFile(path.join(runtime, "runtime-manifest.json"), `${JSON.stringify(runtimeManifest)}\n`);
  await writeFile(path.join(runtime, "runtime-build.json"), `${JSON.stringify(runtimeBuild)}\n`);

  const guestArtifacts = [];
  for (const [name, role, mediaType, value] of [
    ["vmlinuz-linux", "guest-kernel", "application/vnd.linux.kernel", "kernel-fixture"],
    ["rootfs.ext4", "guest-rootfs", "application/vnd.omarchy.ext4", "rootfs-fixture"],
    ["provenance.json", "guest-metadata", "application/json", "{\"fixture\":true}\n"],
  ]) {
    guestArtifacts.push({ ...(await put(guest, name, value)), role, mediaType });
  }
  const guestManifest = {
    schemaVersion: 1,
    upstream: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
      version: "4.0.0.alpha",
      license: "MIT",
    },
    normalizedUpstreamTree: { sha256: "b".repeat(64) },
    build: {
      builtAt: "2026-08-14T11:00:00Z",
      sourceDateEpoch: 1786719479,
      builderImageDigest: `sha256:${"c".repeat(64)}`,
    },
    guest: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      display: { width: 1600, height: 900 },
    },
    artifacts: guestArtifacts,
  };
  await writeFile(path.join(guest, "guest-manifest.json"), `${JSON.stringify(guestManifest)}\n`);

  await writeFile(path.join(root, "notices.tar.zst"), "notices-fixture");
  await writeFile(path.join(root, "sbom.spdx.json"), "{\"spdxVersion\":\"SPDX-2.3\"}\n");
  await writeFile(path.join(root, "runtime-source.tar.zst"), "source-fixture");

  const outputDirectory = path.join(root, "release");
  const config = {
    runtimeDirectory: runtime,
    guestDirectory: guest,
    outputDirectory,
    licenseBundle: path.join(root, "notices.tar.zst"),
    licenseBundleName: "THIRD_PARTY_NOTICES.tar.zst",
    sbom: path.join(root, "sbom.spdx.json"),
    runtimeSource: path.join(root, "runtime-source.tar.zst"),
    runtime: {
      license: "GPL-2.0-only",
      correspondingSourceUrl: "https://downloads.example.test/qemu-wasm-source.tar.zst",
    },
    licenses: [
      { component: "Omarchy", spdx: "MIT", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://github.com/basecamp/omarchy" },
      { component: "qemu-wasm", spdx: "GPL-2.0-only", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://github.com/ktock/qemu-wasm" },
      { component: "Linux", spdx: "GPL-2.0-only", noticePath: "THIRD_PARTY_NOTICES.tar.zst", sourceUrl: "https://kernel.org" },
    ],
  };
  return { root, runtime, outputDirectory, config };
}

test("assembles verified fragments into a validator-clean atomic release", async () => {
  const { outputDirectory, config } = await fixture();
  const { manifest } = await assembleRelease(config);
  assert.equal(manifest.product, "Omarchy browser demo");
  assert.equal(manifest.artifacts.find((item) => item.role === "emulator-wasm").mediaType, "application/wasm");
  assert.equal(manifest.runtime.modified, true);

  const result = await verifyArtifactManifest(manifest, {
    artifactRoot: outputDirectory,
    checkFiles: true,
  });
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));
  assert.equal((await stat(path.join(outputDirectory, "artifact-manifest.json"))).size > 0, true);
});

test("refuses a fragment when an artifact changed after hashing", async () => {
  const { runtime, config } = await fixture();
  await writeFile(path.join(runtime, "qemu.wasm"), "tampered-after-fragment");
  await assert.rejects(assembleRelease(config), /artifact (size|digest) changed/);
});

test("refuses to overwrite an immutable release directory", async () => {
  const { outputDirectory, config } = await fixture();
  await assembleRelease(config);
  await assert.rejects(assembleRelease(config), /refusing to replace existing release directory/);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory, "artifact-manifest.json"), "utf8")).schemaVersion, 1);
});
