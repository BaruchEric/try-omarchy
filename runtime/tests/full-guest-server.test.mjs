import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createFullGuestServer } from "../scripts/serve-full-guest.mjs";
import { isolationHeaders } from "../scripts/serve.mjs";

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function writeArtifact(root, path, body, role, mediaType) {
  const bytes = Buffer.from(body);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  return { path, role, mediaType, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

test("full-guest server exposes a no-copy release and strictly ranged rootfs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-full-guest-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  const webRoot = join(root, "web");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot), mkdir(webRoot)]);

  const runtimeManifestBody = `${JSON.stringify({
    schemaVersion: 2,
    guest: { rootfs: { artifactPath: "rootfs.ext4" } },
  })}\n`;
  const runtimeArtifacts = [
    await writeArtifact(runtimeRoot, "production-worker.mjs", "export {};\n", "host-worker", "text/javascript"),
  ];
  await writeArtifact(runtimeRoot, "runtime-manifest.json", runtimeManifestBody, "runtime-config", "application/json");
  await writeFile(join(runtimeRoot, "runtime-build.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifacts: runtimeArtifacts,
  })}\n`);

  const disk = Buffer.from("0123456789abcdef");
  const guestArtifacts = [
    await writeArtifact(guestRoot, "rootfs.ext4", disk, "guest-rootfs", "application/octet-stream"),
    await writeArtifact(guestRoot, "vmlinuz-linux", "kernel", "guest-kernel", "application/octet-stream"),
  ];
  await writeFile(join(guestRoot, "guest-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    normalizedUpstreamTree: { sha256: "b".repeat(64) },
    upstream: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "a".repeat(40),
      version: "4.0.0.alpha",
      license: "MIT",
      treeSha256: "b".repeat(64),
    },
    artifacts: guestArtifacts,
  })}\n`);
  await writeFile(join(webRoot, "full-guest.html"), "full guest harness");

  const server = await createFullGuestServer({ runtimeRoot, guestRoot, webRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const redirect = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/web/full-guest.html");
  const harness = await fetch(`${base}/web/full-guest.html`);
  assert.equal(await harness.text(), "full guest harness");

  const release = await fetch(`${base}/release/artifact-manifest.json`).then((response) => response.json());
  const verification = await fetch(`${base}/__verification`).then((response) => response.json());
  assert.equal(verification.artifactCount, 5);
  assert.match(verification.artifactManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(server.releaseVerification.artifactManifestSha256, verification.artifactManifestSha256);
  assert.deepEqual(release.upstream, {
    repository: "https://github.com/basecamp/omarchy",
    commit: "a".repeat(40),
    version: "4.0.0.alpha",
    license: "MIT",
    treeSha256: "b".repeat(64),
  });
  assert.deepEqual(release.artifacts.map(({ path }) => path), [
    "production-worker.mjs", "runtime-manifest.json", "rootfs.ext4", "vmlinuz-linux",
    "guest-manifest.json",
  ]);

  const expectedEtag = `"sha256-${guestArtifacts[0].sha256}"`;
  const head = await fetch(`${base}/release/rootfs.ext4`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(disk.byteLength));
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("etag"), expectedEtag);
  assert.equal(head.headers.get("content-encoding"), null);
  assert.equal(
    head.headers.get("x-omarchy-verified-artifact-manifest-sha256"),
    verification.artifactManifestSha256,
  );
  for (const [header, expected] of Object.entries(isolationHeaders)) {
    assert.equal(head.headers.get(header), expected);
  }

  const full = await fetch(`${base}/release/rootfs.ext4`);
  assert.equal(full.status, 412);
  assert.equal((await full.arrayBuffer()).byteLength, 0);
  const missingValidator = await fetch(`${base}/release/rootfs.ext4`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(missingValidator.status, 412);
  const openRange = await fetch(`${base}/release/rootfs.ext4`, {
    headers: { Range: "bytes=2-", "If-Match": expectedEtag },
  });
  assert.equal(openRange.status, 416);
  const ranged = await fetch(`${base}/release/rootfs.ext4`, {
    headers: { Range: "bytes=2-5", "If-Match": expectedEtag },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-5/16");
  assert.equal(await ranged.text(), "2345");

  const regular = await fetch(`${base}/release/production-worker.mjs`);
  assert.equal(regular.status, 200);
  assert.equal(await regular.text(), "export {};\n");
  const requests = await fetch(`${base}/__requests`).then((response) => response.json());
  assert.equal(
    requests.some(({ method, path, range, status }) =>
      method === "GET" && path === "rootfs.ext4" && range === null && status === 200),
    false,
  );
  assert.equal(requests.some(({ path, range, status }) => path === "rootfs.ext4" && range === null && status === 412), true);
  assert.equal(requests.some(({ path, range, status }) => path === "rootfs.ext4" && range === "bytes=2-5" && status === 206), true);
  assert.ok(requests.every(({ artifactManifestSha256 }) =>
    artifactManifestSha256 === verification.artifactManifestSha256));
});

test("full-guest server exposes checkpoint artifacts only through strict bounded ranges", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-full-guest-checkpoint-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  const webRoot = join(root, "web");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot), mkdir(webRoot)]);
  const vmstate = Buffer.from("0123456789abcdef");
  const bootDelta = Buffer.from("qcow2-checkpoint-delta");
  const producerManifest = Buffer.from("{\"schemaVersion\":1}\n");
  const runtimeManifestBody = `${JSON.stringify({
    schemaVersion: 2,
    guest: { rootfs: { artifactPath: "rootfs.ext4" } },
    checkpoint: {
      vmstate: {
        artifactPath: "omarchy-preboot.vmstate",
        bytes: vmstate.byteLength,
        sha256: sha256(vmstate),
      },
      bootDelta: {
        artifactPath: "checkpoint-overlay.qcow2",
        bytes: bootDelta.byteLength,
        sha256: sha256(bootDelta),
      },
      producer: {
        manifestArtifactPath: "checkpoint-manifest.json",
        manifestBytes: producerManifest.byteLength,
        manifestSha256: sha256(producerManifest),
      },
    },
  })}\n`;
  const runtimeArtifacts = [
    await writeArtifact(runtimeRoot, "production-worker.mjs", "export {};\n", "host-worker", "text/javascript"),
  ];
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), runtimeManifestBody);
  await writeFile(join(runtimeRoot, "runtime-build.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifacts: runtimeArtifacts,
  })}\n`);
  const guestArtifacts = [
    await writeArtifact(guestRoot, "rootfs.ext4", "base-rootfs", "guest-rootfs", "application/octet-stream"),
  ];
  await Promise.all([
    writeFile(join(guestRoot, "omarchy-preboot.vmstate"), vmstate),
    writeFile(join(guestRoot, "checkpoint-overlay.qcow2"), bootDelta),
    writeFile(join(guestRoot, "checkpoint-manifest.json"), producerManifest),
  ]);
  await writeFile(join(guestRoot, "guest-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    upstream: {
      repository: "https://github.com/basecamp/omarchy",
      commit: "a".repeat(40),
      version: "4.0.0.alpha",
      license: "MIT",
      treeSha256: "b".repeat(64),
    },
    artifacts: guestArtifacts,
  })}\n`);
  await writeFile(join(webRoot, "full-guest.html"), "checkpoint harness");

  const server = await createFullGuestServer({ runtimeRoot, guestRoot, webRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const release = await fetch(`${base}/release/artifact-manifest.json`).then((response) => response.json());
  assert.ok(release.artifacts.some(({ path, role }) =>
    path === "omarchy-preboot.vmstate" && role === "preboot-vmstate"));
  assert.ok(release.artifacts.some(({ path, role }) =>
    path === "checkpoint-overlay.qcow2" && role === "preboot-disk-delta"));

  for (const [path, bytes] of [
    ["omarchy-preboot.vmstate", vmstate],
    ["checkpoint-overlay.qcow2", bootDelta],
  ]) {
    const etag = `"sha256-${sha256(bytes)}"`;
    assert.equal((await fetch(`${base}/release/${path}`)).status, 412, `${path} must reject a full GET`);
    assert.equal((await fetch(`${base}/release/${path}`, {
      headers: { Range: "bytes=0-3" },
    })).status, 412, `${path} must require its immutable validator`);
    const response = await fetch(`${base}/release/${path}`, {
      headers: { Range: "bytes=0-3", "If-Match": etag },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 4);
  }
});

test("full-guest server refuses release metadata that does not match files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-full-guest-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  const webRoot = join(root, "web");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot), mkdir(webRoot)]);
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), JSON.stringify({
    guest: { rootfs: { artifactPath: "rootfs.ext4" } },
  }));
  await writeFile(join(runtimeRoot, "runtime-build.json"), JSON.stringify({
    schemaVersion: 1,
    artifacts: [{ path: "runtime-manifest.json", bytes: 999, sha256: "a".repeat(64) }],
  }));
  await writeFile(join(guestRoot, "guest-manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [] }));
  await assert.rejects(
    createFullGuestServer({ runtimeRoot, guestRoot, webRoot }),
    /size differs from its manifest/,
  );
});

test("full-guest server refuses a same-size artifact mutation before listening", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-full-guest-mutated-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  const webRoot = join(root, "web");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot), mkdir(webRoot)]);

  const runtimeManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    guest: { rootfs: { artifactPath: "rootfs.ext4" } },
  })}\n`);
  const runtimeArtifact = await writeArtifact(
    runtimeRoot,
    "runtime-manifest.json",
    runtimeManifest,
    "runtime-config",
    "application/json",
  );
  await writeFile(join(runtimeRoot, "runtime-build.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifacts: [runtimeArtifact],
  })}\n`);

  const rootfsArtifact = await writeArtifact(
    guestRoot,
    "rootfs.ext4",
    "authentic-rootfs",
    "guest-rootfs",
    "application/octet-stream",
  );
  await writeFile(join(guestRoot, "guest-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifacts: [rootfsArtifact],
  })}\n`);
  await writeFile(join(guestRoot, "rootfs.ext4"), "hostile-rootfs!!");
  assert.equal(Buffer.byteLength("hostile-rootfs!!"), rootfsArtifact.bytes, "fixture mutation must preserve size");

  await assert.rejects(
    createFullGuestServer({ runtimeRoot, guestRoot, webRoot }),
    /artifact SHA-256 differs from its manifest: rootfs\.ext4/,
  );
});
