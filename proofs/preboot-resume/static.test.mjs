import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzePpm } from "./frame-health.mjs";

const proof = new URL("./", import.meta.url);
const proofDirectory = fileURLToPath(proof);
const repositoryDirectory = fileURLToPath(new URL("../../", import.meta.url));

test("generated builds and evidence are ignored and source files stay small", async () => {
  const [gitignore, dockerignore, entries] = await Promise.all([
    readFile(new URL(".gitignore", proof), "utf8"),
    readFile(new URL(".dockerignore", proof), "utf8"),
    readdir(proofDirectory, { withFileTypes: true }),
  ]);
  assert.match(gitignore, /^\.build\/$/m);
  assert.match(gitignore, /^evidence\/$/m);
  assert.match(dockerignore, /^\.build\/?$/m);
  assert.match(dockerignore, /^evidence\/?$/m);
  for (const ignored of [
    "proofs/preboot-resume/.build/qemu-8.2-native/qemu-system-x86_64",
    "proofs/preboot-resume/evidence/example/omarchy-preboot.vmstate",
  ]) {
    execFileSync("git", ["check-ignore", "--quiet", ignored], { cwd: repositoryDirectory });
  }
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const metadata = await stat(new URL(entry.name, proof));
    assert.ok(metadata.size < 256 * 1024, `${entry.name} unexpectedly looks like a generated artifact`);
  }
});

test("native build is assembled from the exact locked clean QEMU source", async () => {
  const [script, lockText] = await Promise.all([
    readFile(new URL("build-pinned-qemu.sh", proof), "utf8"),
    readFile(new URL("../../runtime/upstream.lock.json", import.meta.url), "utf8"),
  ]);
  const lock = JSON.parse(lockText);
  assert.match(script, /runtime\/upstream\.lock\.json/);
  assert.match(script, /qemuWasm\.commit/);
  assert.match(script, /actual_commit == "?\$expected_commit"?/);
  assert.match(script, /VERSION"\) == 8\.2\.0/);
  assert.match(script, /status --porcelain=v1/);
  assert.match(script, /archive "\$expected_commit"/);
  assert.match(script, /--target-list=x86_64-softmmu/);
  assert.match(script, /--with-coroutine=ucontext/);
  for (const dependency of Object.values(lock.qemuSubprojects)) {
    assert.ok(script.includes(dependency.commit), `build omits locked subproject ${dependency.commit}`);
  }
});

test("native source and target share the browser guest-facing shape", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  for (const contract of [
    "-machine pc-q35-8.2",
    "-m 1024M",
    "-accel tcg,tb-size=128,thread=single",
    '-smp "$vcpus,sockets=1,cores=$vcpus,threads=1"',
    "-device virtio-vga,max_outputs=1,xres=1600,yres=900",
    "-device virtio-keyboard-pci",
    "-device virtio-tablet-pci",
    "-parallel none",
    "-nic none",
  ]) {
    assert.match(script, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(script, /common_args=\([\s\S]+source_args=\([\s\S]+"\$\{common_args\[@\]\}"/);
  assert.match(script, /target_args=\([\s\S]+"\$\{common_args\[@\]\}"[\s\S]+-incoming/);
  assert.match(script, /source-overlay\.qcow2/);
  assert.match(script, /checkpoint-overlay\.qcow2/);
  assert.match(script, /target_args=\([\s\S]+-snapshot/);
  assert.match(script, /vcpus=\$\{PREBOOT_VCPUS:-1\}/);
  assert.match(script, /browserAcceptance: false/);
});

test("artifact gate binds the corrected guest to the one-vCPU browser contract", async () => {
  const verifier = await readFile(new URL("artifact-integrity.mjs", proof), "utf8");
  assert.match(verifier, /minimumMemoryMiB === 1024/);
  assert.match(verifier, /recommendedMemoryMiB === 1536/);
  assert.match(verifier, /manifest\.guest\?\.kernelCommandLine === KERNEL_COMMAND_LINE/);
  assert.match(verifier, /spec\.runtime\?\.kernelCommandLine === KERNEL_COMMAND_LINE/);
  assert.match(verifier, /artifact SHA-256 mismatch/);
  assert.match(verifier, /artifact resolves through an alias/);
  assert.match(verifier, /provenance commit differs from manifest/);
});

test("paired disk delta is frozen before the fresh incoming target", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  const sourceArgs = script.match(/source_args=\(([\s\S]*?)\n\)/)?.[1];
  const targetArgs = script.match(/target_args=\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(sourceArgs && targetArgs, "source/target argument blocks are missing");
  assert.match(script, /qemu_img" create -q -f qcow2 -F raw -b rootfs\.ext4 source-overlay\.qcow2/);
  assert.match(sourceArgs, /source-overlay\.qcow2/);
  assert.doesNotMatch(sourceArgs, /-snapshot/);
  assert.match(targetArgs, /-snapshot/);
  assert.match(targetArgs, /checkpoint-overlay\.qcow2/);
  assert.match(script, /migration_compression=\$\{PREBOOT_MIGRATION_COMPRESSION:-none\}/);
  assert.match(script, /target_args\+\=\(-incoming defer\)/);
  assert.match(script, /target_args\+\=\(-incoming "file:\$evidence_dir\/omarchy-preboot\.vmstate"\)/);
  assert.match(script, /target_socket[\s\S]+migrate-set-capabilities[\s\S]+"capability":"compress","state":true[\s\S]+migrate-set-parameters[\s\S]+"decompress-threads":2[\s\S]+execute migrate-incoming[\s\S]+file:\$evidence_dir\/omarchy-preboot\.vmstate[\s\S]+wait-status paused/);
  assert.match(script, /execute stop[\s\S]+wait-migration[\s\S]+execute quit[\s\S]+wait "\$source_pid"[\s\S]+mv "\$evidence_dir\/source-overlay\.qcow2" "\$evidence_dir\/checkpoint-overlay\.qcow2"[\s\S]+target_args=/);
});

test("checkpoint is deterministic and supports browser-compatible raw immediate incoming", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  assert.match(script, /execute stop/);
  assert.match(script, /migrate-set-capabilities[\s\S]+"capability":"compress","state":true/);
  assert.match(script, /migrate-set-parameters[\s\S]+"compress-level":6/);
  assert.match(script, /execute migrate/);
  assert.match(script, /wait-migration/);
  assert.match(script, /execute migrate-incoming/);
  assert.match(script, /wait-status paused/);
  assert.match(script, /execute cont/);
  assert.match(script, /migration_description='none; raw QEMU stream'/);
  assert.match(script, /incoming_mode='immediate-cli-file'/);
});

test("frame settle rejects wrong dimensions and the Hyprland red error banner", () => {
  const header = Buffer.from("P6\n1600 900\n255\n");
  const pixels = Buffer.alloc(1600 * 900 * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 20;
    pixels[offset + 1] = 60;
    pixels[offset + 2] = 100;
  }
  const clean = analyzePpm(Buffer.concat([header, pixels]));
  assert.equal(clean.clean, true);
  for (let offset = 0; offset < 1600 * 4 * 3; offset += 3) {
    pixels[offset] = 220;
    pixels[offset + 1] = 20;
    pixels[offset + 2] = 30;
  }
  const banner = analyzePpm(Buffer.concat([header, pixels]));
  assert.equal(banner.clean, false);
  assert.ok(banner.topAlertRedRatio >= 0.05);
  const wrongSize = analyzePpm(Buffer.concat([Buffer.from("P6\n1600 960\n255\n"), Buffer.alloc(1600 * 960 * 3, 32)]));
  assert.equal(wrongSize.clean, false);
});

test("saved compressed stream recheck refuses to claim browser readiness", async () => {
  const script = await readFile(new URL("resume-existing-inside-container.sh", proof), "utf8");
  assert.match(script, /-incoming defer/);
  assert.match(script, /migrate-set-capabilities/);
  assert.match(script, /migrate-incoming/);
  assert.match(script, /browserReady: false/);
  assert.match(script, /uid=1000\(omarchy\)/);
});

test("resumed proof requires authentic interaction rather than status alone", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  const validator = await readFile(new URL("validate.mjs", proof), "utf8");
  assert.match(script, /super-return/);
  assert.match(script, /release-modifiers/);
  assert.match(script, /wait_for_clean_frame/);
  assert.match(script, /id >\/dev\/virtio-ports\/omarchy\.web\.diagnostics/);
  assert.match(script, /resumed-desktop\.ppm/);
  assert.match(script, /resumed-foot\.ppm/);
  assert.match(validator, /uid=1000\\\(omarchy\\\)/);
  assert.match(validator, /footChangedPixelRatio >= 0\.005/);
});

test("source input is proven before an unhealthy desktop can be checkpointed", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  const validator = await readFile(new URL("validate.mjs", proof), "utf8");
  const inputProof = script.indexOf('super-return >/dev/null');
  const checkpointStop = script.indexOf('execute stop');
  assert.ok(inputProof > 0 && checkpointStop > inputProof, "source input proof must precede checkpoint stop");
  assert.match(script, /source-foot\.ppm/);
  assert.match(script, /source-desktop-after-input\.ppm/);
  assert.match(script, /source Super\+Return did not open an interactive Omarchy Foot session/);
  assert.match(validator, /sourceFootChangedPixelRatio >= 0\.005/);
  assert.match(validator, /checkpoint source did not execute id as the Omarchy desktop user/);
  assert.match(validator, /checkpoint source did not receive Omarchy's Super\+Return binding/);
});

test("Wasm capability inspection is fail closed and disclaims integration proof", async () => {
  const script = await readFile(new URL("inspect-wasm-support.mjs", proof), "utf8");
  assert.match(script, /incoming file:filename\[,offset=offset\]/);
  assert.match(script, /file_start_incoming_migration/);
  assert.match(script, /qmp_migrate_incoming/);
  assert.match(script, /presence evidence only/);
  assert.match(script, /browser remains an integration and performance gate/);
});
