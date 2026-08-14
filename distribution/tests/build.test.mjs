import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildDistribution, removeExtractedTree } from "../build.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("fixtures", import.meta.url));
const SOURCE_DATE_EPOCH = 1_786_719_479;
const SUBPROJECTS = ["berkeley-softfloat-3", "berkeley-testfloat-3", "dtc", "keycodemapdb"];

test("removes read-only trees produced by debugfs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarchy-debugfs-cleanup-"));
  const lockedDirectory = path.join(root, "etc", "ca-certificates", "extracted", "cadir");
  const lockedFile = path.join(lockedDirectory, "01419da9.0");
  await mkdir(lockedDirectory, { recursive: true });
  await writeFile(lockedFile, "certificate fixture");
  await chmod(lockedFile, 0o444);
  await chmod(lockedDirectory, 0o555);

  await removeExtractedTree(root);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function command(commandName, args, options = {}) {
  return execFileAsync(commandName, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

async function initializeGitRepository(directory, remote) {
  await command("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await command("git", ["-C", directory, "config", "user.name", "Fixture Builder"]);
  await command("git", ["-C", directory, "config", "user.email", "fixture@example.test"]);
  await command("git", ["-C", directory, "remote", "add", "origin", remote]);
  await command("git", ["-C", directory, "add", "."]);
  await command("git", ["-C", directory, "commit", "--quiet", "-m", "fixture source"], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${SOURCE_DATE_EPOCH} +0000`,
      GIT_COMMITTER_DATE: `${SOURCE_DATE_EPOCH} +0000`,
    },
  });
  return (await command("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
}

async function putGuestArtifact(directory, relativePath, contents, role, mediaType) {
  const target = path.join(directory, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return {
    path: relativePath,
    role,
    mediaType,
    bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  };
}

async function makeFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarchy-distribution-test-"));
  context?.after(() => rm(root, { recursive: true, force: true }));
  const rootfs = path.join(root, "rootfs");
  const guest = path.join(root, "guest");
  const runtime = path.join(root, "runtime");
  const qemu = path.join(root, "qemu");
  await Promise.all([
    cp(path.join(fixtureRoot, "rootfs"), rootfs, { recursive: true }),
    cp(path.join(fixtureRoot, "runtime"), runtime, { recursive: true }),
    cp(path.join(fixtureRoot, "qemu"), qemu, { recursive: true }),
    mkdir(guest, { recursive: true }),
  ]);

  const subprojectDirectories = {};
  const qemuSubprojects = {};
  await mkdir(path.join(qemu, "subprojects"), { recursive: true });
  for (const name of SUBPROJECTS) {
    const directory = path.join(root, "subprojects", name);
    const repository = `https://sources.example.test/${name}.git`;
    await cp(path.join(fixtureRoot, "subproject"), directory, { recursive: true });
    const commit = await initializeGitRepository(directory, repository);
    subprojectDirectories[name] = directory;
    qemuSubprojects[name] = { repository, commit };
    await writeFile(
      path.join(qemu, "subprojects", `${name}.wrap`),
      `[wrap-git]\ndirectory = ${name}\nurl = ${repository}\nrevision = ${commit}\n`,
    );
  }

  const qemuRepository = "https://sources.example.test/qemu-wasm.git";
  const qemuCommit = await initializeGitRepository(qemu, qemuRepository);
  const lock = {
    schemaVersion: 1,
    qemuWasm: { repository: qemuRepository, commit: qemuCommit },
    qemuSubprojects,
    toolchain: { emsdk: "3.1.50", sdl: "2" },
  };
  await writeFile(path.join(runtime, "upstream.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  const packageLock = "demo-lib 1.2.3-1\nlinux 6.12.1.arch1-1\n";
  const guestArtifacts = [
    await putGuestArtifact(guest, "rootfs.ext4", "small ext4 fixture", "guest-rootfs", "application/vnd.omarchy.ext4"),
    await putGuestArtifact(guest, "packages.lock.txt", packageLock, "guest-metadata", "text/plain"),
    await putGuestArtifact(guest, "LICENSE.omarchy", "MIT fixture", "guest-license", "text/plain"),
  ];
  const guestManifest = {
    schemaVersion: 1,
    upstream: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
      version: "4.0.0.alpha",
      license: "MIT",
    },
    normalizedUpstreamTree: { sha256: "b".repeat(64) },
    build: { sourceDateEpoch: SOURCE_DATE_EPOCH },
    guest: { architecture: "x86_64", distribution: "Arch Linux" },
    artifacts: guestArtifacts,
  };
  await writeFile(path.join(guest, "guest-manifest.json"), `${JSON.stringify(guestManifest, null, 2)}\n`);

  const config = {
    schemaVersion: 1,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    outputDirectory: path.join(root, "distribution-one"),
    guest: {
      artifactDirectory: guest,
      rootfsDirectory: rootfs,
      allowUnverifiedRootfsDirectory: true,
      packageLock: path.join(guest, "packages.lock.txt"),
    },
    runtime: {
      directory: runtime,
      qemuCheckout: qemu,
      subprojectDirectories,
    },
  };
  return { root, rootfs, guest, runtime, qemu, config };
}

async function decompress(archive, output) {
  await command("zstd", ["--decompress", "--quiet", "--force", archive, "-o", output]);
  return output;
}

async function archiveMembers(archive, temporaryTar) {
  await decompress(archive, temporaryTar);
  return (await command("tar", ["-tf", temporaryTar])).stdout.trim().split("\n");
}

async function extractArchiveMember(archive, temporaryTar, member) {
  await decompress(archive, temporaryTar);
  return (await command("tar", ["-xOf", temporaryTar, member])).stdout;
}

test("emits reproducible SPDX, notices, and exact QEMU corresponding source", async (context) => {
  const fixture = await makeFixture(context);
  const first = await buildDistribution(fixture.config);
  const secondConfig = { ...fixture.config, outputDirectory: path.join(fixture.root, "distribution-two") };
  const second = await buildDistribution(secondConfig);

  assert.equal(first.manifest.unresolvedLicenseCount, 0);
  assert.equal(first.manifest.legalStatus, "NOT_CLEARED");
  assert.equal(first.spdx.spdxVersion, "SPDX-2.3");
  assert.equal(first.spdx.creationInfo.created, "2026-08-14T14:57:59Z");
  assert.equal(first.spdx.packages.find((item) => item.name === "linux").licenseConcluded, "GPL-2.0-only");
  assert.match(first.spdx.packages.find((item) => item.name === "demo-lib").externalRefs[0].referenceLocator, /^pkg:arch\/demo-lib@1\.2\.3-1/);

  for (const name of ["sbom.spdx.json", "THIRD_PARTY_NOTICES.tar.zst", "qemu-wasm-corresponding-source.tar.zst"]) {
    const left = await readFile(path.join(first.outputDirectory, name));
    const right = await readFile(path.join(second.outputDirectory, name));
    assert.equal(sha256(left), sha256(right), `${name} is not reproducible`);
  }

  const noticeMembers = await archiveMembers(
    path.join(first.outputDirectory, "THIRD_PARTY_NOTICES.tar.zst"),
    path.join(fixture.root, "notices.tar"),
  );
  assert(noticeMembers.includes("THIRD_PARTY_NOTICES/INDEX.json"));
  assert(noticeMembers.includes("THIRD_PARTY_NOTICES/sbom.spdx.json"));
  assert.equal(noticeMembers.filter((name) => name.startsWith("THIRD_PARTY_NOTICES/license-texts/")).length, 6);

  const sourceMembers = await archiveMembers(
    path.join(first.outputDirectory, "qemu-wasm-corresponding-source.tar.zst"),
    path.join(fixture.root, "source.tar"),
  );
  assert(sourceMembers.includes("qemu-wasm-corresponding-source/SOURCE-MANIFEST.json"));
  assert(sourceMembers.includes("qemu-wasm-corresponding-source/qemu-wasm/ui/display.c"));
  assert(sourceMembers.includes("qemu-wasm-corresponding-source/subprojects/dtc/source.c"));
  assert(sourceMembers.includes("qemu-wasm-corresponding-source/omarchy-web-runtime/patches/frame.patch"));
  const sourceManifest = JSON.parse(
    await extractArchiveMember(
      path.join(first.outputDirectory, "qemu-wasm-corresponding-source.tar.zst"),
      path.join(fixture.root, "source-again.tar"),
      "qemu-wasm-corresponding-source/SOURCE-MANIFEST.json",
    ),
  );
  assert.equal(sourceManifest.sourceDateEpoch, SOURCE_DATE_EPOCH);
  assert.equal(sourceManifest.qemuBuildSubprojects.length, 4);
  assert.match(sourceManifest.runtimeBuildInputs.sha256, /^[0-9a-f]{64}$/);
  assert.equal(second.manifest.sourceDateEpoch, SOURCE_DATE_EPOCH);
});

test("fails closed when installed package license metadata is missing", async (context) => {
  const fixture = await makeFixture(context);
  const desc = path.join(fixture.rootfs, "var/lib/pacman/local/demo-lib-1.2.3-1/desc");
  await writeFile(desc, (await readFile(desc, "utf8")).replace("%LICENSE%\nMIT\n", ""));
  await assert.rejects(buildDistribution(fixture.config), /has no declared license data/);
  await assert.rejects(lstat(fixture.config.outputDirectory), { code: "ENOENT" });
});

test("fails closed on unknown or ambiguous package licenses", async (context) => {
  const fixture = await makeFixture(context);
  const desc = path.join(fixture.rootfs, "var/lib/pacman/local/demo-lib-1.2.3-1/desc");
  await writeFile(desc, (await readFile(desc, "utf8")).replace("MIT", "custom"));
  await assert.rejects(buildDistribution(fixture.config), /unresolved SPDX expression|unknown SPDX license ID/);
});

test("supports a reviewed custom LicenseRef with an extracted local text", async (context) => {
  const fixture = await makeFixture(context);
  const desc = path.join(fixture.rootfs, "var/lib/pacman/local/demo-lib-1.2.3-1/desc");
  await writeFile(desc, (await readFile(desc, "utf8")).replace("MIT", "custom"));
  fixture.config.licenses = {
    packageLicenseOverrides: {
      "demo-lib": {
        concluded: "LicenseRef-Demo-Fixture",
        name: "Demo fixture terms",
        licenseFiles: ["usr/share/licenses/demo-lib/LICENSE"],
      },
    },
  };
  const result = await buildDistribution(fixture.config);
  assert.equal(result.spdx.hasExtractedLicensingInfos[0].licenseId, "LicenseRef-Demo-Fixture");
  assert.match(result.spdx.hasExtractedLicensingInfos[0].extractedText, /Permission is hereby granted/);
});

test("rejects a package lock that is not the exact installed rootfs set", async (context) => {
  const fixture = await makeFixture(context);
  await writeFile(path.join(fixture.guest, "packages.lock.txt"), "demo-lib 1.2.3-1\nlinux 6.12.0-1\n");
  const manifestPath = path.join(fixture.guest, "guest-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const lock = manifest.artifacts.find((item) => item.path === "packages.lock.txt");
  lock.bytes = Buffer.byteLength("demo-lib 1.2.3-1\nlinux 6.12.0-1\n");
  lock.sha256 = sha256("demo-lib 1.2.3-1\nlinux 6.12.0-1\n");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(buildDistribution(fixture.config), /does not match the reviewed lock/);
});

test("rejects changed or traversal-named guest artifacts", async (context) => {
  await context.test("digest changed", async () => {
    const fixture = await makeFixture(context);
    await writeFile(path.join(fixture.guest, "rootfs.ext4"), "tampered rootfs fixture");
    await assert.rejects(buildDistribution(fixture.config), /guest artifact (size|digest) changed/);
  });
  await context.test("path traversal", async () => {
    const fixture = await makeFixture(context);
    const manifestPath = path.join(fixture.guest, "guest-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts[0].path = "../rootfs.ext4";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(buildDistribution(fixture.config), /guest artifact path is unsafe or non-canonical/);
  });
});

test("rejects license symlinks that escape the rootfs", async (context) => {
  const fixture = await makeFixture(context);
  const unsafe = path.join(fixture.rootfs, "usr/share/licenses/demo-lib/ESCAPE");
  await symlink("/etc/passwd", unsafe);
  await assert.rejects(buildDistribution(fixture.config), /license symlink escapes rootfs/);
});

test("requires an explicit non-release flag for an unverified rootfs directory", async (context) => {
  const fixture = await makeFixture(context);
  delete fixture.config.guest.allowUnverifiedRootfsDirectory;
  await assert.rejects(buildDistribution(fixture.config), /not cryptographically bound to rootfs\.ext4/);
});

test("rejects dirty or mis-pinned QEMU source and unsafe runtime inputs", async (context) => {
  await context.test("dirty checkout", async () => {
    const fixture = await makeFixture(context);
    await writeFile(path.join(fixture.qemu, "untracked.txt"), "not part of the pinned commit");
    await assert.rejects(buildDistribution(fixture.config), /source checkout is dirty/);
  });
  await context.test("unsafe source input", async () => {
    const fixture = await makeFixture(context);
    fixture.config.runtime.sourceInputs = ["../rootfs"];
    await assert.rejects(buildDistribution(fixture.config), /unsafe or non-canonical/);
  });
});
