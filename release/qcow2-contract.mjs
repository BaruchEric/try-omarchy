import { open } from "node:fs/promises";

const QCOW_MAGIC = 0x514649fb;
const QCOW_VERSION = 3;
const QCOW_V3_HEADER_BYTES = 104;
const QCOW_BACKING_FORMAT_EXTENSION = 0xe2792aca;
const QCOW_END_EXTENSION = 0;
const MAX_QCOW_HEADER_BYTES = 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readExact(handle, length, position, label) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    invariant(bytesRead > 0, `${label} is truncated`);
    offset += bytesRead;
  }
  return bytes;
}

function alignedExtensionBytes(length) {
  return 8 + Math.ceil(length / 8) * 8;
}

export async function validateQcow2BackingFile(
  filePath,
  { expectedFilename, expectedFormat, expectedBytes, expectedVirtualBytes },
) {
  invariant(
    typeof expectedFilename === "string" && expectedFilename.length > 0,
    "expected qcow2 backing filename is missing",
  );
  invariant(
    typeof expectedFormat === "string" && expectedFormat.length > 0,
    "expected qcow2 backing format is missing",
  );
  invariant(
    Number.isSafeInteger(expectedVirtualBytes) && expectedVirtualBytes > 0,
    "expected qcow2 virtual size is invalid",
  );
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    invariant(info.isFile() && info.size > 0, "checkpoint boot delta must be a non-empty file");
    if (expectedBytes !== undefined) {
      invariant(info.size === expectedBytes, "checkpoint boot delta byte length changed");
    }
    const header = await readExact(handle, QCOW_V3_HEADER_BYTES, 0, "qcow2 header");
    invariant(header.readUInt32BE(0) === QCOW_MAGIC, "checkpoint boot delta is not qcow2");
    invariant(
      header.readUInt32BE(4) === QCOW_VERSION,
      "checkpoint boot delta must use the canonical qcow2 v3 header",
    );
    const virtualBytes = header.readBigUInt64BE(24);
    invariant(
      virtualBytes === BigInt(expectedVirtualBytes),
      "checkpoint qcow2 virtual size does not match the backing rootfs byte length",
    );
    const backingOffsetBig = header.readBigUInt64BE(8);
    invariant(
      backingOffsetBig <= BigInt(Number.MAX_SAFE_INTEGER),
      "checkpoint qcow2 backing filename offset is not a safe integer",
    );
    const backingOffset = Number(backingOffsetBig);
    const backingLength = header.readUInt32BE(16);
    const expectedFilenameBytes = Buffer.from(expectedFilename, "utf8");
    invariant(
      backingLength === expectedFilenameBytes.byteLength,
      "checkpoint qcow2 backing filename length is not canonical",
    );
    const headerLength = header.readUInt32BE(100);
    invariant(
      headerLength >= QCOW_V3_HEADER_BYTES &&
        backingOffset >= headerLength + 8 &&
        backingOffset <= MAX_QCOW_HEADER_BYTES &&
        backingOffset + backingLength <= info.size,
      "checkpoint qcow2 backing/header offsets are invalid or unbounded",
    );

    const extensions = await readExact(
      handle,
      backingOffset - headerLength,
      headerLength,
      "qcow2 header extensions",
    );
    let cursor = 0;
    let ended = false;
    let backingFormat = null;
    while (cursor + 8 <= extensions.byteLength) {
      const magic = extensions.readUInt32BE(cursor);
      const length = extensions.readUInt32BE(cursor + 4);
      if (magic === QCOW_END_EXTENSION) {
        invariant(length === 0, "checkpoint qcow2 extension terminator is malformed");
        ended = true;
        break;
      }
      const total = alignedExtensionBytes(length);
      invariant(
        length <= MAX_QCOW_HEADER_BYTES && cursor + total <= extensions.byteLength,
        "checkpoint qcow2 header extension is malformed or unbounded",
      );
      if (magic === QCOW_BACKING_FORMAT_EXTENSION) {
        invariant(backingFormat === null, "checkpoint qcow2 has duplicate backing-format extensions");
        backingFormat = extensions.subarray(cursor + 8, cursor + 8 + length).toString("utf8");
      }
      cursor += total;
    }
    invariant(ended, "checkpoint qcow2 header has no extension terminator");
    invariant(
      backingFormat === expectedFormat,
      `checkpoint qcow2 backing format must be ${expectedFormat}`,
    );
    const backingFilename = await readExact(
      handle,
      backingLength,
      backingOffset,
      "qcow2 backing filename",
    );
    invariant(
      backingFilename.equals(expectedFilenameBytes),
      `checkpoint qcow2 backing filename must be ${expectedFilename}`,
    );
    return Object.freeze({
      version: QCOW_VERSION,
      backingFilename: expectedFilename,
      backingFormat: expectedFormat,
      virtualBytes: expectedVirtualBytes,
    });
  } finally {
    await handle.close();
  }
}
