import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BROWSER_QEMU_HOST,
  BROWSER_QEMU_PATH,
  BROWSER_QEMU_PORT,
  createBrowserQemuServer,
  runBrowserQemu,
} from "../scripts/run-browser-qemu.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "omarchy-browser-qemu-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const guestRoot = join(root, "guest");
  const webRoot = join(root, "web");
  await Promise.all([mkdir(runtimeRoot), mkdir(guestRoot), mkdir(webRoot)]);
  return { root, runtimeRoot, guestRoot, webRoot };
}

test("browser QEMU launcher has one exact loopback entrypoint", () => {
  assert.equal(BROWSER_QEMU_HOST, "127.0.0.1");
  assert.equal(BROWSER_QEMU_PORT, 8094);
  assert.equal(BROWSER_QEMU_PATH, "/web/full-guest.html");
});

test("browser QEMU launcher fails clearly when generated bundles are absent", async (context) => {
  const { root, webRoot } = await fixture(context);
  await assert.rejects(
    createBrowserQemuServer({
      runtimeRoot: join(root, "missing-runtime"),
      guestRoot: join(root, "missing-guest"),
      webRoot,
    }),
    /Canonical browser QEMU runtime is missing.*make -C runtime build/s,
  );

  const runtimeRoot = join(root, "runtime-present");
  await mkdir(runtimeRoot);
  await assert.rejects(
    createBrowserQemuServer({
      runtimeRoot,
      guestRoot: join(root, "missing-guest"),
      webRoot,
    }),
    /x86_64 Omarchy guest bundle is missing.*guest\/dist/s,
  );
});

test("browser QEMU launcher verifies canonical runtime without rewriting it", async (context) => {
  const paths = await fixture(context);
  const sentinel = createServer();
  let verification;
  let serverPaths;
  const server = await createBrowserQemuServer({
    ...paths,
    verifyRuntime: async (runtimeRoot, options) => {
      verification = { runtimeRoot, options };
    },
    serverFactory: async (value) => {
      serverPaths = value;
      return sentinel;
    },
  });
  assert.equal(server, sentinel);
  assert.deepEqual(verification, {
    runtimeRoot: paths.runtimeRoot,
    options: { writeReport: false, canonical: true },
  });
  assert.deepEqual(serverPaths, {
    runtimeRoot: paths.runtimeRoot,
    guestRoot: paths.guestRoot,
    webRoot: paths.webRoot,
  });
});

test("browser QEMU launcher labels invalid runtime and guest bundles", async (context) => {
  const paths = await fixture(context);
  await assert.rejects(
    createBrowserQemuServer({
      ...paths,
      verifyRuntime: async () => {
        throw new Error("qemu.wasm does not validate");
      },
    }),
    /Canonical browser QEMU runtime is invalid.*qemu\.wasm does not validate/s,
  );

  await writeFile(join(paths.runtimeRoot, "runtime-build.json"), "{\"schemaVersion\":1,\"artifacts\":[]}");
  await writeFile(join(paths.runtimeRoot, "runtime-manifest.json"), "{\"guest\":{\"rootfs\":{\"artifactPath\":\"rootfs.ext4\"}}}");
  await writeFile(join(paths.guestRoot, "guest-manifest.json"), "not json");
  await assert.rejects(
    createBrowserQemuServer({
      ...paths,
      verifyRuntime: async () => {},
    }),
    /Packaged browser QEMU runtime or x86_64 guest bundle is invalid.*guest manifest/s,
  );
});

test("browser QEMU launcher prints its exact reachable URL", async (context) => {
  const paths = await fixture(context);
  let output = "";
  const { server, url } = await runBrowserQemu({
    ...paths,
    port: 0,
    output: { write(value) { output += value; } },
    verifyRuntime: async () => {},
    serverFactory: async () => createServer((_request, response) => response.end()),
  });
  context.after(() => new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  }));
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/web\/full-guest\.html$/);
  assert.equal(output, `OMARCHY_BROWSER_QEMU_URL ${url}\n`);
});
