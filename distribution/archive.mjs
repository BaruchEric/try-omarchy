import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const TAR_BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK);

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeRelativePath(value, label = "path") {
  invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
  invariant(!value.includes("\0"), `${label} contains a NUL byte`);
  invariant(!value.includes("\\"), `${label} must use POSIX separators: ${value}`);
  invariant(!path.posix.isAbsolute(value), `${label} must be relative: ${value}`);
  const normalized = path.posix.normalize(value);
  invariant(
    normalized !== "." &&
      normalized !== ".." &&
      !normalized.startsWith("../") &&
      normalized === value.replace(/\/$/, ""),
    `${label} is unsafe or non-canonical: ${value}`,
  );
  return normalized;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, "drain");
}

function putString(header, value, offset, length) {
  const buffer = Buffer.from(value, "utf8");
  invariant(buffer.length <= length, `tar header value is too long: ${value}`);
  buffer.copy(header, offset);
}

function putOctal(header, value, offset, length) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  invariant(encoded.length <= length - 1, `tar numeric value is too large: ${value}`);
  putString(header, `${encoded}\0`, offset, length);
}

function splitTarPath(input) {
  const archivePath = safeRelativePath(input, "archive member path");
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: "" };
  for (let index = archivePath.lastIndexOf("/"); index > 0; index = archivePath.lastIndexOf("/", index - 1)) {
    const prefix = archivePath.slice(0, index);
    const name = archivePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`archive member path exceeds the POSIX ustar limit: ${archivePath}`);
}

function tarHeader({ archivePath, mode, size, epoch, type = "0", linkTarget = "" }) {
  const { name, prefix } = splitTarPath(archivePath);
  invariant(Buffer.byteLength(linkTarget) <= 100, `tar link target is too long: ${linkTarget}`);
  const header = Buffer.alloc(TAR_BLOCK);
  putString(header, name, 0, 100);
  putOctal(header, mode & 0o7777, 100, 8);
  putOctal(header, 0, 108, 8);
  putOctal(header, 0, 116, 8);
  putOctal(header, size, 124, 12);
  putOctal(header, epoch, 136, 12);
  header.fill(0x20, 148, 156);
  putString(header, type, 156, 1);
  if (linkTarget) putString(header, linkTarget, 157, 100);
  putString(header, "ustar\0", 257, 6);
  putString(header, "00", 263, 2);
  putString(header, "root", 265, 32);
  putString(header, "root", 297, 32);
  putOctal(header, 0, 329, 8);
  putOctal(header, 0, 337, 8);
  if (prefix) putString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  putString(header, `${checksumText}\0 `, 148, 8);
  return header;
}

function parseOctal(field, label) {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  invariant(/^[0-7]+$/.test(text), `invalid ${label} in source tar`);
  return Number.parseInt(text, 8);
}

function parseHeader(header) {
  const expected = parseOctal(header.subarray(148, 156), "checksum");
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  invariant(
    checksumHeader.reduce((sum, byte) => sum + byte, 0) === expected,
    "invalid checksum in git source tar",
  );
  const readString = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
  const name = readString(0, 100);
  const prefix = readString(345, 500);
  return {
    archivePath: prefix ? `${prefix}/${name}` : name,
    mode: parseOctal(header.subarray(100, 108), "mode"),
    size: parseOctal(header.subarray(124, 136), "size"),
    type: readString(156, 157) || "0",
    linkTarget: readString(157, 257),
  };
}

function validateArchiveLink(archivePath, linkTarget) {
  invariant(linkTarget && !linkTarget.includes("\0"), `empty or invalid symlink in source archive: ${archivePath}`);
  invariant(!path.posix.isAbsolute(linkTarget), `absolute symlink in source archive: ${archivePath}`);
  const parts = archivePath.split("/");
  const root = parts[1] === "subprojects" ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(archivePath), linkTarget));
  invariant(
    resolved === root || resolved.startsWith(`${root}/`),
    `symlink escapes the source archive root: ${archivePath} -> ${linkTarget}`,
  );
}

export class DeterministicTarWriter {
  constructor(outputPath, sourceDateEpoch) {
    invariant(Number.isInteger(sourceDateEpoch) && sourceDateEpoch > 0, "SOURCE_DATE_EPOCH must be a positive integer");
    this.outputPath = outputPath;
    this.epoch = sourceDateEpoch;
    this.stream = createWriteStream(outputPath, { flags: "wx", mode: 0o644 });
    this.closed = false;
    this.paths = new Set();
  }

  async #begin(entry) {
    const archivePath = safeRelativePath(entry.archivePath, "archive member path");
    invariant(!this.paths.has(archivePath), `duplicate archive member: ${archivePath}`);
    this.paths.add(archivePath);
    await writeChunk(this.stream, tarHeader({ ...entry, archivePath, epoch: this.epoch }));
  }

  async addBuffer(archivePath, contents, mode = 0o644) {
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    await this.#begin({ archivePath, mode, size: buffer.length, type: "0" });
    await writeChunk(this.stream, buffer);
    const padding = (TAR_BLOCK - (buffer.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) await writeChunk(this.stream, Buffer.alloc(padding));
  }

  async addFile(archivePath, sourcePath, mode = 0o644) {
    const info = await stat(sourcePath);
    invariant(info.isFile(), `archive input is not a regular file: ${sourcePath}`);
    await this.#begin({ archivePath, mode, size: info.size, type: "0" });
    for await (const chunk of createReadStream(sourcePath)) await writeChunk(this.stream, chunk);
    const padding = (TAR_BLOCK - (info.size % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) await writeChunk(this.stream, Buffer.alloc(padding));
  }

  async addSymlink(archivePath, linkTarget, mode = 0o777) {
    validateArchiveLink(archivePath, linkTarget);
    await this.#begin({ archivePath, mode, size: 0, type: "2", linkTarget });
  }

  async appendNormalizedTar(sourceTarPath) {
    const handle = await open(sourceTarPath, "r");
    try {
      const info = await handle.stat();
      let offset = 0;
      const header = Buffer.alloc(TAR_BLOCK);
      while (offset + TAR_BLOCK <= info.size) {
        const result = await handle.read(header, 0, TAR_BLOCK, offset);
        invariant(result.bytesRead === TAR_BLOCK, `truncated source tar: ${sourceTarPath}`);
        offset += TAR_BLOCK;
        if (header.equals(ZERO_BLOCK)) break;
        const entry = parseHeader(header);
        const paddedSize = Math.ceil(entry.size / TAR_BLOCK) * TAR_BLOCK;
        if (entry.type === "g") {
          offset += paddedSize;
          continue;
        }
        invariant(entry.type !== "x", `PAX paths are not accepted in source tar: ${entry.archivePath}`);
        if (entry.type === "5") {
          offset += paddedSize;
          continue;
        }
        invariant(entry.type === "0" || entry.type === "2", `unsupported git archive member type ${entry.type}`);
        const archivePath = safeRelativePath(entry.archivePath.replace(/\/$/, ""), "git archive member");
        if (entry.type === "2") {
          invariant(entry.size === 0, `symlink contains data in git archive: ${archivePath}`);
          await this.addSymlink(archivePath, entry.linkTarget, entry.mode);
        } else {
          await this.#begin({ archivePath, mode: entry.mode, size: entry.size, type: "0" });
          let remaining = entry.size;
          let bodyOffset = offset;
          const block = Buffer.alloc(Math.min(1024 * 1024, Math.max(remaining, 1)));
          while (remaining > 0) {
            const length = Math.min(block.length, remaining);
            const body = await handle.read(block, 0, length, bodyOffset);
            invariant(body.bytesRead === length, `truncated member in source tar: ${archivePath}`);
            await writeChunk(this.stream, block.subarray(0, length));
            bodyOffset += length;
            remaining -= length;
          }
          const padding = paddedSize - entry.size;
          if (padding) await writeChunk(this.stream, Buffer.alloc(padding));
        }
        offset += paddedSize;
      }
    } finally {
      await handle.close();
    }
  }

  async close() {
    invariant(!this.closed, "tar writer was already closed");
    this.closed = true;
    await writeChunk(this.stream, Buffer.alloc(TAR_BLOCK * 2));
    this.stream.end();
    await once(this.stream, "close");
  }
}

async function runToFile(command, args, outputPath, { cwd, env } = {}) {
  const temporary = `${outputPath}.tmp-${process.pid}`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o644 });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  const childClosed = once(child, "close");
  const outputClosed = once(output, "close");
  child.stdout.pipe(output);
  const [[code]] = await Promise.all([childClosed, outputClosed]);
  if (code !== 0) {
    await unlink(temporary).catch(() => {});
    throw new Error(`${command} exited ${code}: ${stderr.trim()}`);
  }
  await rename(temporary, outputPath);
  return outputPath;
}

export async function createGitArchive(repository, commit, prefix, outputPath) {
  safeRelativePath(prefix, "git archive prefix");
  await runToFile("git", ["-C", repository, "archive", "--format=tar", `--prefix=${prefix}/`, commit], outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath) };
}

export async function compressZstd(inputPath, outputPath, sourceDateEpoch) {
  await runToFile(
    "zstd",
    ["--compress", "--quiet", "--force", "--threads=1", "-19", inputPath, "--stdout"],
    outputPath,
    { env: { SOURCE_DATE_EPOCH: String(sourceDateEpoch) } },
  );
  await chmod(outputPath, 0o644);
  return { path: outputPath, sha256: await sha256File(outputPath), bytes: (await stat(outputPath)).size };
}

export async function writeJsonDeterministic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

export async function assertRegularFile(filePath, label) {
  const info = await lstat(filePath);
  invariant(info.isFile(), `${label} is not a regular file: ${filePath}`);
  return info;
}
