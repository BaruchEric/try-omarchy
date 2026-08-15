export const DEFAULT_MAX_OVERLAY_BYTES = 64 * 1024 * 1024;
export const MAX_OVERLAY_BYTES = 128 * 1024 * 1024;
export const OVERLAY_TEMP_DIRECTORIES = Object.freeze(["/tmp", "/var/tmp"]);

const ENOSPC = 51;
const INSTALLATION = Symbol("omarchy.bounded-overlay.installation");
const FILE_STATE = Symbol("omarchy.bounded-overlay.file-state");
const CAPACITY_DOUBLING_MAX = 1024 * 1024;

export class BoundedOverlayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BoundedOverlayError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new BoundedOverlayError(code, message, details);
}

function normalizeMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_OVERLAY_BYTES) {
    fail(
      "INVALID_OVERLAY_LIMIT",
      `maxBytes must be a positive integer no larger than ${MAX_OVERLAY_BYTES} bytes.`,
    );
  }
  return value;
}

function nodeCapacity(node) {
  const capacity = node?.contents?.byteLength ?? node?.contents?.length ?? 0;
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    fail("INCOMPATIBLE_EMSCRIPTEN", "MEMFS exposed an invalid file backing capacity.");
  }
  return capacity;
}

function nodeUsedBytes(node) {
  if (!Number.isSafeInteger(node?.usedBytes) || node.usedBytes < 0) {
    fail("INCOMPATIBLE_EMSCRIPTEN", "MEMFS exposed an invalid file length.");
  }
  return node.usedBytes;
}

// This is the exact growth rule in Emscripten 3.1.50's library_memfs.js.
// Predicting it before the original operation is what makes the cap apply to
// allocated ArrayBuffer capacity, not merely the qcow2 file's logical length.
function expandedMemfsCapacity(previousCapacity, requiredCapacity) {
  if (previousCapacity >= requiredCapacity) return previousCapacity;
  let capacity = Math.max(
    requiredCapacity,
    (previousCapacity * (previousCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125)) >>> 0,
  );
  if (previousCapacity !== 0) capacity = Math.max(capacity, 256);
  return capacity;
}

function checkedEnd(position, length) {
  if (!Number.isSafeInteger(position) || position < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      !Number.isSafeInteger(position + length)) {
    fail("INCOMPATIBLE_EMSCRIPTEN", "MEMFS received an unsafe overlay file range.");
  }
  return position + length;
}

function filePath(fileState) {
  return `${fileState.directory === "/" ? "" : fileState.directory}/${fileState.name}`;
}

function errno(fs, details) {
  const error = new fs.ErrnoError(fs?.ERRNO_CODES?.ENOSPC ?? ENOSPC);
  error.code = "OVERLAY_QUOTA_EXCEEDED";
  error.details = details;
  return error;
}

function assertFilesystem(fs) {
  if (!fs?.mkdirTree || !fs?.lookupPath || !fs?.isFile || !fs?.ErrnoError) {
    fail(
      "INCOMPATIBLE_EMSCRIPTEN",
      "The bounded overlay requires Emscripten FS mkdirTree, lookupPath, isFile, and ErrnoError.",
    );
  }
}

function assertEmptyDirectory(node, path) {
  if (!node || !node.node_ops || typeof node.node_ops.mknod !== "function" ||
      typeof node.node_ops.unlink !== "function" ||
      !node.contents || typeof node.contents !== "object" || Array.isArray(node.contents)) {
    fail(
      "INCOMPATIBLE_EMSCRIPTEN",
      `The pinned MEMFS directory operations are unavailable at ${path}.`,
    );
  }
  const entries = Object.keys(node.contents);
  if (entries.length !== 0) {
    fail(
      "UNTRACKED_OVERLAY_FILE",
      `Refusing to guard non-empty temporary directory ${path}.`,
      { entries: entries.sort() },
    );
  }
}

/**
 * Create a preRun hook which bounds QEMU -snapshot's temporary qcow2 file.
 *
 * QEMU 8.2 creates that file with g_file_open_tmp() in /var/tmp in the pinned
 * browser build. Both conventional Emscripten temp directories are guarded so
 * a libc/GLib default-path variation cannot silently bypass the cap.
 */
export function createBoundedOverlayPreRun({
  maxBytes = DEFAULT_MAX_OVERLAY_BYTES,
  onLimit,
} = {}) {
  const normalizedMaxBytes = normalizeMaxBytes(maxBytes);
  const notifyLimit = typeof onLimit === "function" ? onLimit : () => {};
  const state = {
    installed: false,
    allocatedBytes: 0,
    usedBytes: 0,
    peakAllocatedBytes: 0,
    filesCreated: 0,
    liveFiles: new Set(),
    rejectedOperations: 0,
    limitExceeded: false,
    lastFailure: null,
  };

  function snapshot() {
    return Object.freeze({
      installed: state.installed,
      maxBytes: normalizedMaxBytes,
      allocatedBytes: state.allocatedBytes,
      usedBytes: state.usedBytes,
      peakAllocatedBytes: state.peakAllocatedBytes,
      filesCreated: state.filesCreated,
      liveFiles: state.liveFiles.size,
      rejectedOperations: state.rejectedOperations,
      limitExceeded: state.limitExceeded,
      lastFailure: state.lastFailure ? Object.freeze({ ...state.lastFailure }) : null,
    });
  }

  function reject(fs, fileState, operation, projectedCapacity, requestedEnd) {
    const details = Object.freeze({
      operation,
      path: filePath(fileState),
      requestedEnd,
      currentFileCapacity: fileState.capacity,
      projectedFileCapacity: projectedCapacity,
      currentAllocatedBytes: state.allocatedBytes,
      projectedAllocatedBytes: state.allocatedBytes - fileState.capacity + projectedCapacity,
      maxBytes: normalizedMaxBytes,
    });
    state.rejectedOperations += 1;
    state.limitExceeded = true;
    state.lastFailure = details;
    if (state.rejectedOperations === 1) {
      try {
        notifyLimit(Object.freeze({ code: "OVERLAY_QUOTA_EXCEEDED", ...details }));
      } catch {
        // The deterministic ENOSPC result must not be replaced by diagnostics.
      }
    }
    throw errno(fs, details);
  }

  function reserve(fs, fileState, operation, projectedCapacity, requestedEnd) {
    if (!Number.isSafeInteger(projectedCapacity) || projectedCapacity < 0) {
      fail("INCOMPATIBLE_EMSCRIPTEN", "MEMFS predicted an invalid overlay allocation.");
    }
    const aggregate = state.allocatedBytes - fileState.capacity + projectedCapacity;
    if (!Number.isSafeInteger(aggregate) || aggregate > normalizedMaxBytes) {
      reject(fs, fileState, operation, projectedCapacity, requestedEnd);
    }
  }

  function reconcile(fileState) {
    const nextCapacity = nodeCapacity(fileState.node);
    const nextUsedBytes = nodeUsedBytes(fileState.node);
    state.allocatedBytes += nextCapacity - fileState.capacity;
    state.usedBytes += nextUsedBytes - fileState.usedBytes;
    fileState.capacity = nextCapacity;
    fileState.usedBytes = nextUsedBytes;
    state.peakAllocatedBytes = Math.max(state.peakAllocatedBytes, state.allocatedBytes);
    if (state.allocatedBytes > normalizedMaxBytes) {
      fail(
        "INCOMPATIBLE_EMSCRIPTEN",
        "MEMFS allocated more overlay memory than its pinned growth rule predicted.",
      );
    }
  }

  function releaseFile(fileState) {
    if (!state.liveFiles.delete(fileState)) return;
    state.allocatedBytes -= fileState.capacity;
    state.usedBytes -= fileState.usedBytes;
    fileState.capacity = 0;
    fileState.usedBytes = 0;
  }

  function guardFile(fs, node, directory, name) {
    if (!node || node[FILE_STATE] || !node.stream_ops || !node.node_ops ||
        typeof node.stream_ops.write !== "function" ||
        typeof node.stream_ops.allocate !== "function" ||
        typeof node.node_ops.setattr !== "function") {
      fail(
        "INCOMPATIBLE_EMSCRIPTEN",
        "A temporary file does not match the pinned Emscripten 3.1.50 MEMFS shape.",
      );
    }

    const originalStreamOps = node.stream_ops;
    const originalNodeOps = node.node_ops;
    const fileState = {
      node,
      directory,
      name,
      capacity: nodeCapacity(node),
      usedBytes: nodeUsedBytes(node),
      openCount: 0,
      unlinked: false,
    };
    Object.defineProperty(node, FILE_STATE, { value: fileState });
    state.liveFiles.add(fileState);
    state.filesCreated += 1;
    state.allocatedBytes += fileState.capacity;
    state.usedBytes += fileState.usedBytes;

    const boundedWrite = (stream, buffer, offset, length, position, canOwn) => {
      const requestedEnd = checkedEnd(position, length);
      let projectedCapacity = fileState.capacity;
      if (length > 0 && requestedEnd > fileState.capacity) {
        // Pinned MEMFS has an exact-size fast path for the first position-zero
        // write. Every other extension uses expandFileStorage's growth rule.
        projectedCapacity = fileState.usedBytes === 0 && position === 0
          ? length
          : expandedMemfsCapacity(fileState.capacity, requestedEnd);
      }
      reserve(fs, fileState, "write", projectedCapacity, requestedEnd);
      const result = originalStreamOps.write(stream, buffer, offset, length, position, canOwn);
      reconcile(fileState);
      return result;
    };

    node.stream_ops = {
      ...originalStreamOps,
      open(stream) {
        fileState.openCount += 1;
        return originalStreamOps.open?.(stream);
      },
      close(stream) {
        const result = originalStreamOps.close?.(stream);
        fileState.openCount = Math.max(0, fileState.openCount - 1);
        if (fileState.unlinked && fileState.openCount === 0) releaseFile(fileState);
        return result;
      },
      write: boundedWrite,
      allocate(stream, offset, length) {
        const requestedEnd = checkedEnd(offset, length);
        const projectedCapacity = expandedMemfsCapacity(fileState.capacity, requestedEnd);
        reserve(fs, fileState, "allocate", projectedCapacity, requestedEnd);
        const result = originalStreamOps.allocate(stream, offset, length);
        reconcile(fileState);
        return result;
      },
      msync(stream, buffer, offset, length) {
        boundedWrite(stream, buffer, 0, length, offset, false);
        return 0;
      },
    };
    node.node_ops = {
      ...originalNodeOps,
      setattr(target, attributes) {
        if (attributes?.size !== undefined) {
          const requestedEnd = checkedEnd(0, attributes.size);
          reserve(fs, fileState, "truncate", requestedEnd, requestedEnd);
        }
        const result = originalNodeOps.setattr(target, attributes);
        reconcile(fileState);
        return result;
      },
    };
    return node;
  }

  function protectDirectory(fs, path) {
    fs.mkdirTree(path);
    const directory = fs.lookupPath(path, { follow: true })?.node;
    assertEmptyDirectory(directory, path);
    if (directory[INSTALLATION]) {
      fail("OVERLAY_ALREADY_INSTALLED", `The bounded overlay is already installed at ${path}.`);
    }

    const originalNodeOps = directory.node_ops;
    directory.node_ops = {
      ...originalNodeOps,
      mknod(parent, name, mode, device) {
        if (!fs.isFile(mode)) {
          const placeholder = { directory: path, name, capacity: 0 };
          reject(fs, placeholder, "create-non-file", 0, 0);
        }
        const child = originalNodeOps.mknod(parent, name, mode, device);
        return guardFile(fs, child, path, name);
      },
      unlink(parent, name) {
        const child = parent.contents?.[name];
        const fileState = child?.[FILE_STATE];
        const result = originalNodeOps.unlink(parent, name);
        if (fileState) {
          fileState.unlinked = true;
          if (fileState.openCount === 0) releaseFile(fileState);
        }
        return result;
      },
      rename(oldNode, newDirectory, newName) {
        const result = originalNodeOps.rename(oldNode, newDirectory, newName);
        const fileState = oldNode?.[FILE_STATE];
        if (fileState) {
          fileState.directory = path;
          fileState.name = newName;
        }
        return result;
      },
    };
    Object.defineProperty(directory, INSTALLATION, { value: true });
    return directory;
  }

  function preRun(module) {
    if (state.installed) fail("OVERLAY_ALREADY_INSTALLED", "The bounded overlay preRun hook ran more than once.");
    const fs = module?.FS;
    assertFilesystem(fs);
    // Each directory gets a node-local clone of MEMFS's shared operation table.
    // The quota state remains aggregate across both possible GLib temp roots.
    const directories = OVERLAY_TEMP_DIRECTORIES.map((path) => protectDirectory(fs, path));
    // Repair the rename allow-list after both directories are known.
    for (const directory of directories) {
      const rename = directory.node_ops.rename;
      directory.node_ops.rename = (oldNode, newDirectory, newName) => {
        if (!directories.includes(newDirectory)) {
          const fileState = oldNode?.[FILE_STATE];
          if (fileState) {
            reject(fs, fileState, "rename-outside-overlay", fileState.capacity, fileState.usedBytes);
          }
        }
        const result = rename(oldNode, newDirectory, newName);
        const fileState = oldNode?.[FILE_STATE];
        if (fileState) {
          fileState.directory = newDirectory === directories[0] ? OVERLAY_TEMP_DIRECTORIES[0] : OVERLAY_TEMP_DIRECTORIES[1];
          fileState.name = newName;
        }
        return result;
      };
    }
    state.installed = true;
  }

  Object.defineProperties(preRun, {
    maxBytes: { value: normalizedMaxBytes, enumerable: true },
    snapshot: { value: snapshot, enumerable: true },
  });
  return preRun;
}
