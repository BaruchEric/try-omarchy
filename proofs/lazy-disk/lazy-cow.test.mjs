import assert from "node:assert/strict";
import test from "node:test";

import { createLazyCowFile } from "./lazy-cow.mjs";

function fakeFs(bytes = 12, chunkBytes = 4) {
  const chunks = [];
  const contents = {
    chunks,
    chunkSize: chunkBytes,
    length: bytes,
    getter(chunkNumber) {
      chunks[chunkNumber] ??= Uint8Array.from(
        { length: Math.min(chunkBytes, bytes - chunkNumber * chunkBytes) },
        (_, offset) => chunkNumber * chunkBytes + offset,
      );
      return chunks[chunkNumber];
    },
  };
  const node = { contents, stream_ops: {}, timestamp: 0 };

  return {
    ERRNO_CODES: { EINVAL: 28, ENOSPC: 51 },
    ErrnoError: class ErrnoError extends Error {
      constructor(code) {
        super(`errno ${code}`);
        this.errno = code;
      }
    },
    mkdirTree() {},
    createLazyFile() {
      return node;
    },
    node,
  };
}

test("writes span lazy chunks without materializing the whole file", () => {
  const fs = fakeFs();
  const disk = createLazyCowFile(fs, "/pack/disk.bin", "https://example.invalid/disk.bin");
  const input = Uint8Array.of(90, 91, 92, 93, 94, 95);

  assert.equal(fs.node.stream_ops.write({ node: fs.node }, input, 0, input.length, 3), 6);
  assert.deepEqual([...fs.node.contents.getter(0)], [0, 1, 2, 90]);
  assert.deepEqual([...fs.node.contents.getter(1)], [91, 92, 93, 94]);
  assert.deepEqual([...fs.node.contents.getter(2)], [95, 9, 10, 11]);
  assert.deepEqual(disk.snapshot(), {
    path: "/pack/disk.bin",
    url: "https://example.invalid/disk.bin",
    chunkBytes: 4,
    bytesWritten: 6,
    loadedChunks: 3,
    touchedWriteChunks: [0, 1, 2],
  });
});

test("rejects writes beyond the immutable base image", () => {
  const fs = fakeFs();
  createLazyCowFile(fs, "/pack/disk.bin", "https://example.invalid/disk.bin");

  assert.throws(
    () => fs.node.stream_ops.write({ node: fs.node }, Uint8Array.of(1, 2), 0, 2, 11),
    (error) => error.errno === 51,
  );
});

test("requires an absolute file path", () => {
  assert.throws(
    () => createLazyCowFile(fakeFs(), "disk.bin", "https://example.invalid/disk.bin"),
    /absolute file path/,
  );
});
