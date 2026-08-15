import assert from "node:assert/strict";
import test from "node:test";

import { startProofServer } from "./server.mjs";

test("proof server logs bounded ranges and rejects a whole-rootfs GET", async (t) => {
  const proof = await startProofServer();
  t.after(() => proof.close());

  const head = await fetch(`${proof.url}rootfs.ext4`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("etag"), proof.metadata.etag);

  const overlayModule = await fetch(`${proof.url}bounded-overlay.mjs`);
  assert.equal(overlayModule.status, 200);
  assert.match(await overlayModule.text(), /createBoundedOverlayPreRun/);

  const range = await fetch(`${proof.url}rootfs.ext4`, {
    headers: { Range: "bytes=1048576-2097151", "If-Match": proof.metadata.etag },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 1048576-2097151/${proof.metadata.bytes}`);
  assert.equal((await range.arrayBuffer()).byteLength, 1024 * 1024);

  const full = await fetch(`${proof.url}rootfs.ext4`);
  assert.equal(full.status, 412);
  assert.equal((await full.arrayBuffer()).byteLength, 0);

  assert.deepEqual(proof.requests, [
    {
      method: "HEAD",
      path: "/rootfs.ext4",
      range: null,
      ifMatch: null,
      responseBytes: 0,
      status: 200,
    },
    {
      method: "GET",
      path: "/rootfs.ext4",
      range: "bytes=1048576-2097151",
      ifMatch: proof.metadata.etag,
      responseBytes: 1024 * 1024,
      status: 206,
    },
    {
      method: "GET",
      path: "/rootfs.ext4",
      range: null,
      ifMatch: null,
      responseBytes: 0,
      status: 412,
    },
  ]);
});
