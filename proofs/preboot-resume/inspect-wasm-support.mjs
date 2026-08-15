#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const [repoArgument, sourceArgument] = process.argv.slice(2);
const repo = path.resolve(repoArgument ?? new URL("../..", import.meta.url).pathname);
const source = path.resolve(sourceArgument ?? "/private/tmp/qemu-wasm-source");
const lock = JSON.parse(await readFile(path.join(repo, "runtime/upstream.lock.json"), "utf8"));
const build = JSON.parse(await readFile(path.join(repo, "runtime/dist/runtime-build.json"), "utf8"));
const wasmPath = path.join(repo, "runtime/dist/qemu.wasm");
const [version, migration, migrationFile, vl, qapi, wasm] = await Promise.all([
  readFile(path.join(source, "VERSION"), "utf8"),
  readFile(path.join(source, "migration/migration.c"), "utf8"),
  readFile(path.join(source, "migration/file.c"), "utf8"),
  readFile(path.join(source, "system/vl.c"), "utf8"),
  readFile(path.join(source, "qapi/migration.json"), "utf8"),
  readFile(wasmPath),
]);
const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

invariant(version.trim() === "8.2.0", "QEMU-Wasm source is not version 8.2.0");
invariant(commit === lock.qemuWasm.commit, "QEMU-Wasm source commit differs from the lock");
invariant(build.component.commit === commit, "linked Wasm build metadata points at another QEMU commit");

const sourceChecks = {
  fileTransportIsQapiSince82: /@file: Direct the migration stream to a file[\s\S]{0,500}Since 8\.2/.test(qapi),
  uriParserSelectsFileTransport: migration.includes('strstart(uri, "file:", NULL)') && migration.includes("MIGRATION_ADDRESS_TYPE_FILE"),
  incomingDispatchesFileReader: migration.includes("file_start_incoming_migration(&addr->u.file, errp)"),
  fileReaderOpensReadOnly: migrationFile.includes("O_RDONLY") && migrationFile.includes("migration_channel_process_incoming(ioc)"),
  cliStartsIncomingMigration: vl.includes("qmp_migrate_incoming(incoming, false, NULL, &local_err)"),
};
for (const [name, passed] of Object.entries(sourceChecks)) invariant(passed, `source check failed: ${name}`);

function hasAscii(marker) {
  return wasm.includes(Buffer.from(marker, "utf8"));
}

const linkedWasmChecks = {
  incomingFileCliHelp: hasAscii("-incoming file:filename[,offset=offset]"),
  qmpMigrateIncoming: hasAscii("qmp_migrate_incoming"),
  migrationFileIncoming: hasAscii("migration_file_incoming"),
  saveStateCore: hasAscii("qemu_savevm_state"),
  loadStateCore: hasAscii("qemu_loadvm_state_section"),
};
for (const [name, passed] of Object.entries(linkedWasmChecks)) invariant(passed, `linked Wasm marker missing: ${name}`);

const output = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  qemu: {
    repository: lock.qemuWasm.repository,
    version: version.trim(),
    commit,
  },
  sourceChecks,
  linkedWasm: {
    path: "runtime/dist/qemu.wasm",
    bytes: wasm.byteLength,
    sha256: await sha256(wasmPath),
    buildModifiedByReviewedRuntimePatches: build.component.modified,
    checks: linkedWasmChecks,
  },
  conclusion: "The exact linked QEMU-Wasm build contains QEMU 8.2's file-backed incoming migration/loadvm path. This is presence evidence only; consuming the generated Omarchy vmstate in a browser remains an integration and performance gate.",
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
