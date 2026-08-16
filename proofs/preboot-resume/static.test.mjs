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
  ]) execFileSync("git", ["check-ignore", "--quiet", ignored], { cwd: repositoryDirectory });
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    assert.ok((await stat(new URL(entry.name, proof))).size < 256 * 1024, `${entry.name} looks generated`);
  }
});

test("native build is assembled from exact locked clean QEMU 8.2 source", async () => {
  const [script, lockText] = await Promise.all([
    readFile(new URL("build-pinned-qemu.sh", proof), "utf8"),
    readFile(new URL("../../runtime/upstream.lock.json", import.meta.url), "utf8"),
  ]);
  const lock = JSON.parse(lockText);
  assert.match(script, /actual_commit=[\s\S]+\$actual_commit == "\$expected_commit"/);
  assert.match(script, /VERSION"\) == 8\.2\.0/);
  assert.match(script, /status --porcelain=v1/);
  assert.match(script, /archive "\$expected_commit"/);
  assert.match(script, /--target-list=x86_64-softmmu/);
  for (const dependency of Object.values(lock.qemuSubprojects)) assert.ok(script.includes(dependency.commit));
});

test("source and fresh target use exact fixed 2-vCPU MTTCG profile", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  for (const contract of [
    "-machine pc-q35-8.2", "-m 1024M", "-accel tcg,tb-size=128,thread=multi",
    "-smp 2,sockets=1,cores=2,threads=1", "-device virtio-vga,max_outputs=1,xres=1600,yres=900",
    "-device virtio-keyboard-pci", "-device virtio-tablet-pci", "-parallel none", "-nic none",
  ]) assert.ok(script.includes(contract), `missing ${contract}`);
  assert.match(script, /common_args=\([\s\S]+source_args=\([\s\S]+"\$\{common_args\[@\]\}"/);
  assert.match(script, /target_args=\([\s\S]+"\$\{common_args\[@\]\}"[\s\S]+-incoming "file:/);
  const launcher = await readFile(new URL("run.sh", proof), "utf8");
  assert.match(launcher, /PREBOOT_VCPUS:-2.*== 2/);
  assert.match(launcher, /PREBOOT_MIGRATION_COMPRESSION:-none.*== none/);
});

test("checkpoint binds exact canonical guest hashes and relative raw backing", async () => {
  const [script, validator] = await Promise.all([
    readFile(new URL("run-inside-container.sh", proof), "utf8"),
    readFile(new URL("validate.mjs", proof), "utf8"),
  ]);
  for (const digest of [
    "d5f6e2eebd8ce80abf355d8d6f67d52c978c603cc253466e29fb064eab792c28",
    "ff89f566d58841bcb8fdb9c8b486d162dbafa2223a38a150c11337f52de52d33",
    "771a12039baff3cf5034442496d0f47e345c2e3e394b49f6c30ed8d9753d6b38",
  ]) assert.ok(script.includes(digest) && validator.includes(digest));
  assert.match(script, /qemu_img" create -q -f qcow2 -F raw -b rootfs\.ext4 source-overlay\.qcow2/);
  assert.match(script, /mv "\$evidence_dir\/source-overlay\.qcow2" "\$evidence_dir\/checkpoint-overlay\.qcow2"/);
  assert.match(script, /backingFilename: "rootfs\.ext4"/);
  assert.match(script, /backingFormat: "raw"/);
});

test("raw running-state stream auto-runs with no target migration control", async () => {
  const [script, validator] = await Promise.all([
    readFile(new URL("run-inside-container.sh", proof), "utf8"),
    readFile(new URL("validate.mjs", proof), "utf8"),
  ]);
  assert.doesNotMatch(script, /execute stop/);
  assert.doesNotMatch(script, /execute cont/);
  assert.doesNotMatch(script, /migrate-set-capabilities/);
  assert.match(script, /source-premigration-status\.json/);
  assert.match(script, /execute migrate .*file:\$evidence_dir\/omarchy-preboot\.vmstate/);
  assert.match(script, /-incoming "file:\$evidence_dir\/omarchy-preboot\.vmstate"/);
  assert.match(script, /wait-status running/);
  assert.match(validator, /target required forbidden pre-main\/post-load QMP migration control/);
  assert.match(validator, /targetAutoRanWithoutQmpCont/);
});

test("source gates authentic report, two healthy frames, and visible Foot before migration", async () => {
  const script = await readFile(new URL("run-inside-container.sh", proof), "utf8");
  const report = script.indexOf('node "$report_gate"');
  const frames = script.indexOf('capture_two_healthy_frames "$source_socket"');
  const foot = script.indexOf('super-return >"$evidence_dir/source-super-return.json"');
  const migrate = script.indexOf('execute migrate "');
  assert.ok(report > 0 && frames > report && foot > frames && migrate > foot);
  assert.match(script, /source-foot-change\.json" minimum 0\.0005/);
  assert.match(script, /super-w/);
  assert.match(script, /source-return-change\.json" maximum 0\.05/);
});

test("restored target repeats healthy-frame and paced shortcut pixel proof", async () => {
  const [script, qmp, validator] = await Promise.all([
    readFile(new URL("run-inside-container.sh", proof), "utf8"),
    readFile(new URL("qmp.mjs", proof), "utf8"),
    readFile(new URL("validate.mjs", proof), "utf8"),
  ]);
  assert.match(script, /capture_two_healthy_frames "\$target_socket"/);
  assert.match(script, /resumed-foot-change\.json" minimum 0\.0005/);
  assert.match(qmp, /sendExplicitChord\(client, \["meta_l", "ret"\]\)/);
  assert.match(qmp, /INPUT_TRANSITION_MILLISECONDS = 16/);
  assert.match(validator, /resumed Super\+Return did not visibly open Foot/);
  assert.doesNotMatch(validator, /uid=1000/);
});

test("structural health accepts the real shell shape and rejects banners or degenerate frames", () => {
  const width = 1600;
  const height = 900;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      if (y < 39) {
        const accent = x % 41 === 0 ? x % 64 : 0;
        pixels[offset] = 20 + accent;
        pixels[offset + 1] = 24 + accent;
        pixels[offset + 2] = 32 + accent;
      } else {
        pixels[offset] = (x + y) % 128;
        pixels[offset + 1] = (2 * x + y) % 128;
        pixels[offset + 2] = (x + 3 * y) % 128;
      }
    }
  }
  const header = Buffer.from("P6\n1600 900\n255\n");
  assert.equal(analyzePpm(Buffer.concat([header, pixels])).clean, true);
  for (const [separator, firstRasterByte] of [
    ["\n", 9],
    ["\r\n", 10],
    ["\t", 13],
    [" ", 32],
    ["\r", 9],
  ]) {
    const candidate = Buffer.from(pixels);
    candidate[0] = firstRasterByte;
    const result = analyzePpm(Buffer.concat([
      Buffer.from(`P6\n1600 900\n255${separator}`),
      candidate,
    ]));
    assert.equal(result.payloadBytes, width * height * 3);
    assert.equal(result.payloadMatches, true);
    assert.equal(result.clean, true);
  }
  assert.equal(analyzePpm(Buffer.concat([
    Buffer.from("P6\n1600 900\n255"),
    Buffer.alloc(width * height * 3, 41),
  ])).clean, false);
  for (let offset = 0; offset < width * 30 * 3; offset += 3) {
    pixels[offset] = 220; pixels[offset + 1] = 20; pixels[offset + 2] = 30;
  }
  assert.equal(analyzePpm(Buffer.concat([header, pixels])).clean, false);
  assert.equal(analyzePpm(Buffer.concat([header, Buffer.alloc(width * height * 3, 17)])).clean, false);
  assert.equal(analyzePpm(Buffer.concat([Buffer.from("P6\n1600 960\n255\n"), Buffer.alloc(1600 * 960 * 3, 32)])).clean, false);
});

test("checkpoint manifest contains the runtime adapter contract and native claim boundary", async () => {
  const [script, validator] = await Promise.all([
    readFile(new URL("run-inside-container.sh", proof), "utf8"),
    readFile(new URL("validate.mjs", proof), "utf8"),
  ]);
  for (const field of ["qemu-8.2-migration", "incomingMode: \"file\"", "qemuBinarySha256", "baseGuestManifestSha256", "immediateIncomingAutoRuns", "qmpContRequired: false", "sourceEvidence", "normalizedGuestReportSha256", "reportValidationSha256", "checkpointFrameSha256", "checkpointFrameHealthSha256"]) {
    assert.ok(script.includes(field));
  }
  assert.match(validator, /native checkpoint handoff, not browser acceptance/i);
  assert.match(validator, /native proof intentionally does not claim unreliable QMP terminal-text delivery/);
});
