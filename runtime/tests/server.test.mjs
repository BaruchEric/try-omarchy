import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheControl, createRuntimeServer, isolationHeaders, parseRange } from "../scripts/serve.mjs";

test("range parser accepts bounded, open, and suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.equal(parseRange("bytes=20-30", 10), undefined);
  assert.equal(parseRange("items=0-2", 10), undefined);
  assert.equal(parseRange(undefined, 10), null);
});

test("immutable caching is reserved for content-addressed binary assets", () => {
  assert.equal(cacheControl("/smoke-dist/qemu.wasm"), "no-store");
  assert.equal(
    cacheControl("/releases/cc43e9cc132533d7e8c30eca5ed86810/qemu.wasm"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(cacheControl("/runtime-manifest.json"), "no-cache");
});

test("runtime server sends isolation headers and byte ranges", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-runtime-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web", "harness.html"), "0123456789");

  const server = createRuntimeServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();

  const redirect = await fetch(`http://127.0.0.1:${port}/?assets=../smoke-dist/`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/web/harness.html?assets=../smoke-dist/");
  for (const [header, expected] of Object.entries(isolationHeaders)) {
    assert.equal(redirect.headers.get(header), expected);
  }

  const full = await fetch(`http://127.0.0.1:${port}/web/harness.html`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  for (const [header, expected] of Object.entries(isolationHeaders)) {
    assert.equal(full.headers.get(header), expected);
  }

  const partial = await fetch(`http://127.0.0.1:${port}/web/harness.html`, {
    headers: { Range: "bytes=3-6" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 3-6/10");
  assert.equal(await partial.text(), "3456");

  const invalid = await fetch(`http://127.0.0.1:${port}/web/harness.html`, {
    headers: { Range: "bytes=99-100" },
  });
  assert.equal(invalid.status, 416);
});

test("runtime server does not escape its configured root", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "omarchy-runtime-root-test-"));
  const root = join(parent, "served");
  await mkdir(root);
  await writeFile(join(parent, "secret.txt"), "secret");
  context.after(() => rm(parent, { recursive: true, force: true }));

  const server = createRuntimeServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/..%2fsecret.txt`);
  assert.equal(response.status, 403);
  assert.notEqual(await response.text(), "secret");
});
