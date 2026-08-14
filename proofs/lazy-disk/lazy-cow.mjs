const DEFAULT_CHUNK_BYTES = 1024 * 1024;

function errno(fs, name, fallback) {
  const code = fs?.ERRNO_CODES?.[name] ?? fallback;
  return new fs.ErrnoError(code);
}

function splitPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.endsWith("/")) {
    throw new TypeError("path must be an absolute file path");
  }

  const slash = path.lastIndexOf("/");
  return {
    parent: slash === 0 ? "/" : path.slice(0, slash),
    name: path.slice(slash + 1),
  };
}

/**
 * Mount an HTTP range-backed Emscripten lazy file and make in-range writes
 * mutate only its already-lazy, in-memory chunks.
 *
 * Emscripten 3.1.50's stock lazy-file reader is suitable for immutable range
 * reads in a Worker. Its inherited MEMFS writer does not update the lazy
 * reader, so QEMU disk writes need this explicit chunk-level overlay.
 */
export function createLazyCowFile(fs, path, url) {
  if (!fs?.createLazyFile || !fs?.mkdirTree) {
    throw new TypeError("an Emscripten FS export is required");
  }

  const { parent, name } = splitPath(path);
  fs.mkdirTree(parent);
  const node = fs.createLazyFile(parent, name, url, true, true);
  const lazy = node.contents;
  // Reading chunkSize performs the one-time HEAD request and installs the
  // range getter in Emscripten's LazyUint8Array.
  const chunkBytes = Number(lazy?.chunkSize || DEFAULT_CHUNK_BYTES);

  if (!lazy || typeof lazy.getter !== "function" || !Array.isArray(lazy.chunks)) {
    throw new Error("Emscripten did not create a chunked lazy file; run this inside a Worker");
  }

  const stats = {
    path,
    url,
    chunkBytes,
    bytesWritten: 0,
    touchedWriteChunks: new Set(),
  };

  node.stream_ops.write = (stream, buffer, offset, length, position) => {
    if (!Number.isSafeInteger(position) || position < 0 || length < 0) {
      throw errno(fs, "EINVAL", 28);
    }
    if (position + length > lazy.length) {
      throw errno(fs, "ENOSPC", 51);
    }

    let sourceOffset = offset;
    let destination = position;
    let remaining = length;

    while (remaining > 0) {
      const chunkNumber = Math.floor(destination / lazy.chunkSize);
      const chunkOffset = destination % lazy.chunkSize;
      const chunk = lazy.getter(chunkNumber);
      const writable = Math.min(remaining, chunk.length - chunkOffset);
      chunk.set(buffer.subarray(sourceOffset, sourceOffset + writable), chunkOffset);
      stats.touchedWriteChunks.add(chunkNumber);
      sourceOffset += writable;
      destination += writable;
      remaining -= writable;
    }

    node.timestamp = Date.now();
    stats.bytesWritten += length;
    return length;
  };

  return {
    node,
    snapshot() {
      return {
        path: stats.path,
        url: stats.url,
        chunkBytes: stats.chunkBytes,
        bytesWritten: stats.bytesWritten,
        loadedChunks: lazy.chunks.reduce((count, chunk) => count + Number(chunk !== undefined), 0),
        touchedWriteChunks: [...stats.touchedWriteChunks].sort((a, b) => a - b),
      };
    },
  };
}
