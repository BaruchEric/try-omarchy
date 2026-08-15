import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedOverlayError,
  createBoundedOverlayPreRun,
  DEFAULT_MAX_OVERLAY_BYTES,
  MAX_OVERLAY_BYTES,
  OVERLAY_TEMP_DIRECTORIES,
} from "./bounded-overlay.mjs";

const FILE_MODE = 0o100666;
const DIRECTORY_MODE = 0o040777;

function fakeMemfs() {
  const byPath = new Map();
  const expand = (node, requested) => {
    const previous = node.contents?.length ?? 0;
    if (previous >= requested) return;
    let capacity = Math.max(requested, (previous * (previous < 1024 * 1024 ? 2 : 1.125)) >>> 0);
    if (previous !== 0) capacity = Math.max(capacity, 256);
    const contents = new Uint8Array(capacity);
    if (node.usedBytes > 0) contents.set(node.contents.subarray(0, node.usedBytes));
    node.contents = contents;
  };
  const resize = (node, size) => {
    if (node.usedBytes === size) return;
    if (size === 0) {
      node.contents = null;
      node.usedBytes = 0;
      return;
    }
    const contents = new Uint8Array(size);
    if (node.contents) contents.set(node.contents.subarray(0, Math.min(size, node.usedBytes)));
    node.contents = contents;
    node.usedBytes = size;
  };
  const fileNodeOps = {
    setattr(node, attributes) {
      if (attributes.mode !== undefined) node.mode = attributes.mode;
      if (attributes.size !== undefined) resize(node, attributes.size);
    },
  };
  const fileStreamOps = {
    write(stream, buffer, offset, length, position, canOwn) {
      if (!length) return 0;
      const node = stream.node;
      if (buffer.subarray && (!node.contents || node.contents.subarray)) {
        if (canOwn) {
          node.contents = buffer.subarray(offset, offset + length);
          node.usedBytes = length;
          return length;
        }
        if (node.usedBytes === 0 && position === 0) {
          node.contents = buffer.slice(offset, offset + length);
          node.usedBytes = length;
          return length;
        }
        if (position + length <= node.usedBytes) {
          node.contents.set(buffer.subarray(offset, offset + length), position);
          return length;
        }
      }
      expand(node, position + length);
      node.contents.set(buffer.subarray(offset, offset + length), position);
      node.usedBytes = Math.max(node.usedBytes, position + length);
      return length;
    },
    allocate(stream, offset, length) {
      expand(stream.node, offset + length);
      stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
    },
    mmap() {
      return { ptr: 1, allocated: true };
    },
    msync(stream, buffer, offset, length) {
      fileStreamOps.write(stream, buffer, 0, length, offset, false);
      return 0;
    },
  };
  const dirNodeOps = {
    mknod(parent, name, mode) {
      const file = {
        name,
        parent,
        mode,
        contents: null,
        usedBytes: 0,
        node_ops: fileNodeOps,
        stream_ops: fileStreamOps,
      };
      parent.contents[name] = file;
      return file;
    },
    unlink(parent, name) {
      delete parent.contents[name];
    },
    rename(node, newDirectory, newName) {
      delete node.parent.contents[node.name];
      node.parent = newDirectory;
      node.name = newName;
      newDirectory.contents[newName] = node;
    },
  };
  const fs = {
    ERRNO_CODES: { ENOSPC: 51 },
    ErrnoError: class ErrnoError extends Error {
      constructor(errno) {
        super(`errno ${errno}`);
        this.name = "ErrnoError";
        this.errno = errno;
      }
    },
    isFile(mode) {
      return (mode & 0o170000) === 0o100000;
    },
    mkdirTree(path) {
      const segments = path.split("/").filter(Boolean);
      let currentPath = "";
      let parent = null;
      for (const segment of segments) {
        currentPath += `/${segment}`;
        if (!byPath.has(currentPath)) {
          const directory = {
            name: segment,
            parent,
            mode: DIRECTORY_MODE,
            contents: {},
            node_ops: dirNodeOps,
            stream_ops: {},
          };
          byPath.set(currentPath, directory);
          if (parent) parent.contents[segment] = directory;
        }
        parent = byPath.get(currentPath);
      }
    },
    lookupPath(path) {
      return { node: byPath.get(path) ?? null };
    },
    create(path) {
      const slash = path.lastIndexOf("/");
      const directory = byPath.get(path.slice(0, slash));
      return directory.node_ops.mknod(directory, path.slice(slash + 1), FILE_MODE, 0);
    },
    directory(path) {
      return byPath.get(path);
    },
  };
  return fs;
}

function stream(node) {
  return { node, position: 0 };
}

test("validates a finite hard overlay limit", () => {
  assert.equal(createBoundedOverlayPreRun().maxBytes, DEFAULT_MAX_OVERLAY_BYTES);
  assert.throws(
    () => createBoundedOverlayPreRun({ maxBytes: 0 }),
    (error) => error instanceof BoundedOverlayError && error.code === "INVALID_OVERLAY_LIMIT",
  );
  assert.throws(
    () => createBoundedOverlayPreRun({ maxBytes: MAX_OVERLAY_BYTES + 1 }),
    (error) => error.code === "INVALID_OVERLAY_LIMIT",
  );
});

test("installs node-local guards on both conventional QEMU temp roots", () => {
  const fs = fakeMemfs();
  fs.mkdirTree("/pack");
  const originalPackOps = fs.directory("/pack").node_ops;
  const preRun = createBoundedOverlayPreRun({ maxBytes: 32 });
  preRun({ FS: fs });

  assert.deepEqual(OVERLAY_TEMP_DIRECTORIES, ["/tmp", "/var/tmp"]);
  assert.notEqual(fs.directory("/tmp").node_ops, originalPackOps);
  assert.notEqual(fs.directory("/var/tmp").node_ops, originalPackOps);
  assert.equal(fs.directory("/pack").node_ops, originalPackOps);
  assert.equal(preRun.snapshot().installed, true);
  assert.throws(
    () => preRun({ FS: fs }),
    (error) => error.code === "OVERLAY_ALREADY_INSTALLED",
  );
});

test("rejects qcow2 growth with ENOSPC before MEMFS can exceed the cap", () => {
  const diagnostics = [];
  const fs = fakeMemfs();
  const preRun = createBoundedOverlayPreRun({
    maxBytes: 256,
    onLimit: (event) => diagnostics.push(event),
  });
  preRun({ FS: fs });
  const file = fs.create("/var/tmp/vl.ABC123");
  const fileStream = stream(file);
  file.stream_ops.open(fileStream);

  assert.equal(file.stream_ops.write(fileStream, new Uint8Array(8), 0, 8, 0, false), 8);
  assert.equal(file.stream_ops.write(fileStream, new Uint8Array(4), 0, 4, 8, false), 4);
  assert.equal(file.contents.byteLength, 256, "the test exercises MEMFS's 256-byte minimum growth");
  const before = file.contents;

  assert.throws(
    () => file.stream_ops.write(fileStream, Uint8Array.of(1), 0, 1, 256, false),
    (error) => error.errno === 51 && error.code === "OVERLAY_QUOTA_EXCEEDED" &&
      error.details.projectedAllocatedBytes === 512,
  );
  assert.equal(file.contents, before, "overflow is rejected before an ArrayBuffer is allocated");
  assert.equal(file.usedBytes, 12);
  assert.deepEqual(diagnostics, [{
    code: "OVERLAY_QUOTA_EXCEEDED",
    operation: "write",
    path: "/var/tmp/vl.ABC123",
    requestedEnd: 257,
    currentFileCapacity: 256,
    projectedFileCapacity: 512,
    currentAllocatedBytes: 256,
    projectedAllocatedBytes: 512,
    maxBytes: 256,
  }]);
  assert.deepEqual(preRun.snapshot(), {
    installed: true,
    maxBytes: 256,
    allocatedBytes: 256,
    usedBytes: 12,
    peakAllocatedBytes: 256,
    filesCreated: 1,
    liveFiles: 1,
    rejectedOperations: 1,
    limitExceeded: true,
    lastFailure: {
      operation: "write",
      path: "/var/tmp/vl.ABC123",
      requestedEnd: 257,
      currentFileCapacity: 256,
      projectedFileCapacity: 512,
      currentAllocatedBytes: 256,
      projectedAllocatedBytes: 512,
      maxBytes: 256,
    },
  });
});

test("aggregate capacity covers write, allocate, truncate, and msync growth", () => {
  const fs = fakeMemfs();
  const preRun = createBoundedOverlayPreRun({ maxBytes: 272 });
  preRun({ FS: fs });
  const first = fs.create("/tmp/first");
  const second = fs.create("/var/tmp/second");
  const firstStream = stream(first);
  const secondStream = stream(second);

  first.stream_ops.write(firstStream, new Uint8Array(8), 0, 8, 0, false);
  second.stream_ops.allocate(secondStream, 0, 8);
  assert.equal(preRun.snapshot().allocatedBytes, 16);
  second.node_ops.setattr(second, { size: 16 });
  assert.equal(preRun.snapshot().allocatedBytes, 24);
  first.stream_ops.msync(firstStream, new Uint8Array(8), 8, 8, 0);
  assert.equal(preRun.snapshot().allocatedBytes, 272);

  assert.throws(
    () => second.node_ops.setattr(second, { size: 17 }),
    (error) => error.errno === 51 && error.details.operation === "truncate",
  );
  assert.equal(second.contents.byteLength, 16);
  assert.equal(preRun.snapshot().peakAllocatedBytes, 272);
});

test("an unlinked open overlay remains charged until its final close", () => {
  const fs = fakeMemfs();
  const preRun = createBoundedOverlayPreRun({ maxBytes: 16 });
  preRun({ FS: fs });
  const directory = fs.directory("/var/tmp");
  const file = fs.create("/var/tmp/vl.OPEN01");
  const fileStream = stream(file);
  file.stream_ops.open(fileStream);
  file.stream_ops.write(fileStream, new Uint8Array(16), 0, 16, 0, false);

  directory.node_ops.unlink(directory, "vl.OPEN01");
  assert.equal(preRun.snapshot().allocatedBytes, 16);
  file.stream_ops.close(fileStream);
  assert.equal(preRun.snapshot().allocatedBytes, 0);
  assert.equal(preRun.snapshot().liveFiles, 0);
  assert.equal(preRun.snapshot().peakAllocatedBytes, 16);
});

test("guarded files can move between temp roots but cannot escape the quota", () => {
  const fs = fakeMemfs();
  fs.mkdirTree("/pack");
  const preRun = createBoundedOverlayPreRun({ maxBytes: 256 });
  preRun({ FS: fs });
  const temporary = fs.directory("/tmp");
  const variableTemporary = fs.directory("/var/tmp");
  const pack = fs.directory("/pack");
  const file = fs.create("/tmp/vl.MOVE01");
  const fileStream = stream(file);
  file.stream_ops.write(fileStream, new Uint8Array(8), 0, 8, 0, false);

  temporary.node_ops.rename(file, variableTemporary, "vl.MOVE02");
  assert.equal(variableTemporary.contents["vl.MOVE02"], file);
  assert.throws(
    () => variableTemporary.node_ops.rename(file, pack, "escaped"),
    (error) => error.errno === 51 && error.details.operation === "rename-outside-overlay" &&
      error.details.path === "/var/tmp/vl.MOVE02",
  );
  assert.equal(variableTemporary.contents["vl.MOVE02"], file);
  assert.equal(pack.contents.escaped, undefined);
});

test("fails closed on incompatible or pre-populated MEMFS directories", () => {
  assert.throws(
    () => createBoundedOverlayPreRun({ maxBytes: 16 })({ FS: {} }),
    (error) => error.code === "INCOMPATIBLE_EMSCRIPTEN",
  );
  const fs = fakeMemfs();
  fs.mkdirTree("/tmp");
  fs.create("/tmp/untracked");
  assert.throws(
    () => createBoundedOverlayPreRun({ maxBytes: 16 })({ FS: fs }),
    (error) => error.code === "UNTRACKED_OVERLAY_FILE",
  );
});
