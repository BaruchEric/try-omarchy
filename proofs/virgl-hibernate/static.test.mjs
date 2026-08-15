import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBrowserCandidate } from "./validate-browser-candidate.mjs";

const proofDirectory = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(path.join(proofDirectory, name), "utf8");
const occurrences = (text, fragment) => text.split(fragment).length - 1;

function uleb128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function markerWasm(markers) {
  const name = Buffer.from("markers");
  const payload = Buffer.concat([
    uleb128(name.length),
    name,
    Buffer.from(markers.join("\0")),
  ]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]),
    uleb128(payload.length),
    payload,
  ]);
}

async function writeCandidateFixture(directory, { markers = true, graphics = true, clock = true } = {}) {
  await mkdir(directory, { recursive: true });
  const wasm = markerWasm(markers ? [
    "virtio-vga-gl",
    "virgl",
    "OMARCHY_RUNTIME_DIAGNOSTIC wasm32-tcg-experiment threshold=1500 metrics-schema=3",
    "cache=bounded-clock-v1 active-cap=%d replacement-credit=%d retained-cap=%d gc-pressure-bytes=%d core=%d",
  ] : ["arbitrary-software-wasm"]);
  const wasmSha256 = createHash("sha256").update(wasm).digest("hex");
  const cachePolicy = {
    kind: "bounded-clock-v1",
    activeCap: 15000,
    replacementCredit: 256,
    retainedCap: 15256,
    gcPressureBytes: 4 * 1024 * 1024,
  };
  const verification = {
    schemaVersion: 1,
    wasm: {
      valid: true,
      ...(graphics ? { graphicsExperiment: {
        kind: "virgl-webgl2",
        promotionEligible: false,
        browserApi: "WebGL2",
        renderer: "virglrenderer-0.10.4",
        qemuWasmSha256: wasmSha256,
      } } : {}),
      ...(clock ? {
        tcgExperiment: {
          kind: "qemu-wasm-tcg-bounded-clock",
          instantiateThreshold: 1500,
          metricsSchemaVersion: 3,
          cachePolicy,
        },
        tcgExperimentArtifactSha256: wasmSha256,
      } : {}),
    },
    javascript: {
      webgl2Loader: true,
      graphicsExperimentWorkerIdentity: true,
      tcgExperimentWorkerIdentity: true,
    },
  };
  const experiments = [
    ...(graphics ? [{
      kind: "virgl-webgl2",
      promotionEligible: false,
      browserApi: "WebGL2",
      renderer: { version: "0.10.4" },
    }] : []),
    ...(clock ? [{
      kind: "qemu-wasm-tcg-bounded-clock",
      instantiateThreshold: 1500,
      metricsSchemaVersion: 3,
      promotionEligible: false,
      cachePolicy: { ...cachePolicy, gcPressureInterval: 64 },
    }] : []),
  ];
  const build = {
    schemaVersion: 1,
    component: {
      name: "QEMU-Wasm",
      repository: "https://github.com/ktock/qemu-wasm.git",
      commit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
      modified: true,
      patches: [
        "patches/qemu-wasm-tcg-bounded-clock-cache.patch",
        "patches/qemu-wasm-virgl-webgl-link.patch",
        "patches/qemu-wasm-sdl-webgl-context.patch",
        "patches/qemu-wasm-sdl-webgl-frame-proof.patch",
      ],
      experiments,
    },
    artifacts: [{
      path: "qemu.wasm",
      role: "emulator-wasm",
      mediaType: "application/wasm",
      bytes: wasm.byteLength,
      sha256: wasmSha256,
    }],
  };
  const runtimeManifest = {
    schemaVersion: 2,
    qemu: {
      memoryMiB: 1024,
      cores: 2,
      arguments: [
        "-machine", "pc-q35-8.2",
        "-m", "1024M",
        "-accel", "tcg,tb-size=128,thread=multi",
        "-smp", "2,sockets=1,cores=2,threads=1",
        "-display", "sdl,gl=es,show-cursor=on",
        "-device", "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
      ],
    },
  };
  await Promise.all([
    writeFile(path.join(directory, "qemu.wasm"), wasm),
    writeFile(path.join(directory, "runtime-verification.json"), `${JSON.stringify(verification)}\n`),
    writeFile(path.join(directory, "runtime-build.json"), `${JSON.stringify(build)}\n`),
    writeFile(path.join(directory, "runtime-manifest.json"), `${JSON.stringify(runtimeManifest)}\n`),
  ]);
  return path.join(directory, "qemu.wasm");
}

test("all scripts are syntactically valid without running a VM", async () => {
  for (const name of [
    "build-pinned-qemu.sh",
    "prepare-initramfs.sh",
    "run.sh",
    "run-inside-container.sh",
  ]) {
    execFileSync("bash", ["-n", path.join(proofDirectory, name)]);
  }
  for (const name of [
    "initramfs-overlay/hooks/resume",
    "initramfs-overlay/hooks/omarchy_hibernate_stage",
  ]) {
    execFileSync("sh", ["-n", path.join(proofDirectory, name)]);
  }
  execFileSync(process.execPath, ["--check", path.join(proofDirectory, "validate.mjs")]);
  execFileSync(process.execPath, ["--check", path.join(proofDirectory, "validate-browser-candidate.mjs")]);
});

test("browser candidate gate accepts only hash-bound VirGL plus bounded CLOCK", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "omarchy-virgl-hibernate-candidate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const valid = await writeCandidateFixture(path.join(root, "valid"));
  const result = await validateBrowserCandidate(valid);
  assert.equal(result.status, "PASS");
  assert.equal(result.profile, "virgl-webgl2-tcg-bounded-clock");

  const arbitrary = await writeCandidateFixture(path.join(root, "arbitrary"), { markers: false });
  await assert.rejects(validateBrowserCandidate(arbitrary), /missing marker/);
  const software = await writeCandidateFixture(path.join(root, "software"), { graphics: false });
  await assert.rejects(validateBrowserCandidate(software), /VirGL|graphics/i);
  const unbounded = await writeCandidateFixture(path.join(root, "unbounded"), { clock: false });
  await assert.rejects(validateBrowserCandidate(unbounded), /bounded CLOCK|tcg/i);
});

test("the source-only proof stays bounded and generated artifacts are ignored", async () => {
  assert.equal(await read(".gitignore"), ".build/\nevidence/\n");
  assert.equal(await read(".dockerignore"), ".build\nevidence\n");
  const walk = async (directory) => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".build", "evidence"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(absolute));
      else if (entry.isFile()) files.push(absolute);
    }
    return files;
  };
  const files = await walk(proofDirectory);
  for (const file of files) {
    assert.ok((await stat(file)).size < 256 * 1024, `${file} is unexpectedly large`);
  }
});

test("the native QEMU producer is pinned and built with VirGL/SDL/OpenGL", async () => {
  const [build, dockerfile] = await Promise.all([
    read("build-pinned-qemu.sh"),
    read("Dockerfile.native-builder"),
  ]);
  for (const token of [
    "runtime/upstream.lock.json",
    "--target-list=x86_64-softmmu",
    "--enable-sdl",
    "--enable-opengl",
    "--enable-virglrenderer",
    "virtio-vga-gl",
    "qemu-system-x86_64 qemu-img",
    "egl-renderer-probe.c",
    "TEST_DIR=/proof/.build/qemu-8.2-native-virgl/iotests-scratch",
    "SOCK_DIR=/proof/.build/qemu-8.2-native-virgl/iotests-sockets",
  ]) assert.ok(build.includes(token), `native build is missing ${token}`);
  for (const dependency of ["libegl1-mesa-dev", "libgles2-mesa-dev", "libvirglrenderer-dev", "xvfb", "zstd", "cpio"]) {
    assert.ok(dockerfile.includes(dependency), `builder is missing ${dependency}`);
  }
});

test("derived initramfs defers virtio_gpu and carries exact resume/late hooks", async () => {
  const [config, prepare, blacklist, resume, late] = await Promise.all([
    read("initramfs-overlay/config"),
    read("prepare-initramfs.sh"),
    read("initramfs-overlay/etc/modprobe.d/90-omarchy-hibernate-virtio-gpu.conf"),
    read("initramfs-overlay/hooks/resume"),
    read("initramfs-overlay/hooks/omarchy_hibernate_stage"),
  ]);
  assert.equal(config, [
    'MODULES="virtio_input"',
    'EARLYHOOKS="udev"',
    'HOOKS="udev keymap resume"',
    'LATEHOOKS="omarchy_hibernate_stage"',
    'CLEANUPHOOKS="udev"',
    'EMERGENCYHOOKS=""',
    "",
  ].join("\n"));
  assert.doesNotMatch(config, /\bkms\b|virtio_gpu/);
  assert.match(blacklist, /^# The source hibernates[\s\S]*\nblacklist virtio_gpu\n+$/);
  assert.equal(occurrences(blacklist, "blacklist virtio_gpu"), 1);
  for (const token of [
    "cmp -n", "zstd -dc", "cpio -it", "hooks/resume",
    "hooks/omarchy_hibernate_stage", "omarchy-egl-renderer-probe",
    "derived initramfs exceeds 64 MiB",
  ]) assert.ok(prepare.includes(token), `initramfs preparation is missing ${token}`);
  assert.match(resume, /printf '%d:%d'.*>\/sys\/power\/resume/);
  assert.match(resume, /producer swap is not formatted yet; continuing cold boot/);
  assert.match(resume, /OMARCHY_HIBERNATION_COLD_BOOT .*resume-device-unresolved/);
  assert.doesNotMatch(resume, /< <\(/, "BusyBox ash hook must not use process substitution");
  assert.doesNotMatch(late, /\binstall -m\b/, "late hook must use BusyBox-portable cp/chmod");
});

test("producer hibernates directly, remains bounded, and fails closed", async () => {
  const late = await read("initramfs-overlay/hooks/omarchy_hibernate_stage");
  for (const token of [
    "blacklist virtio_gpu",
    "TimeoutStartSec=infinity",
    "[[ ! -d /sys/module/virtio_gpu ]]",
    "mkswap --force --uuid",
    "536870912 >/sys/power/image_size",
    "shutdown >/sys/power/disk",
    "disk >/sys/power/state",
    "OMARCHY_HIBERNATION_ENTER",
    "OMARCHY_HIBERNATION_FAILURE",
    "OMARCHY_HIBERNATION_COLD_BOOT",
    "ConditionPathExists=/var/lib/omarchy-hibernate/armed",
  ]) assert.ok(late.includes(token), `producer is missing ${token}`);
  assert.doesNotMatch(late, /systemctl\s+hibernate|hibernate\.target\s+(unmask|start)/);
  for (const variable of ["LIBGL_ALWAYS_SOFTWARE", "GALLIUM_DRIVER", "WLR_RENDERER_ALLOW_SOFTWARE"]) {
    assert.match(late, new RegExp(`\\^${variable}=`));
  }
});

test("resumed branch explicitly proves a fresh guest VirGL context before desktop", async () => {
  const [late, probe] = await Promise.all([
    read("initramfs-overlay/hooks/omarchy_hibernate_stage"),
    read("egl-renderer-probe.c"),
  ]);
  const resumedProducer = late.slice(late.indexOf("cat >\"$root/usr/local/libexec/omarchy-hibernate-producer\""));
  const order = [
    "modprobe virtio_gpu",
    "renderD128",
    "features:.*\\+virgl",
    "omarchy-egl-renderer-probe",
    "OMARCHY_RENDERER_REPORT",
    "OMARCHY_HIBERNATION_REPORT",
  ].map((token) => resumedProducer.indexOf(token));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "resume proof is out of order");
  assert.match(probe, /glGetString\(GL_RENDERER\)/);
  assert.match(probe, /contains_casefold\(renderer, "virgl"\)/);
  assert.doesNotMatch(probe, /contains_casefold\(renderer, "llvmpipe"\)/);
  assert.ok(probe.includes('fputs("{\\"schemaVersion\\":1,\\"renderNode\\":'));
  assert.ok(probe.includes('\\"renderer\\":'));
  assert.ok(probe.includes(',\\"vendor\\":'));
  assert.ok(probe.includes(',\\"version\\":'));
});

test("source and fresh target use exact ordered device topology without migration", async () => {
  const runner = await read("run-inside-container.sh");
  for (const token of [
    "pc-q35-8.2", "qemu64", "1024M", "tcg,tb-size=128,thread=multi",
    "2,sockets=1,cores=2,threads=1", "sdl,gl=on,show-cursor=on",
    "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
    "ignore_loglevel hibernate.compressor=lzo",
    "resume=UUID=$swap_uuid", "omarchy.hibernate_swap_uuid=$swap_uuid",
  ]) assert.ok(runner.includes(token), `runner is missing ${token}`);
  for (const token of [
    "id=omarchy-hibernate-root,file=",
    "virtio-blk-pci,drive=omarchy-hibernate-root,serial=omarchy-root",
    "id=omarchy-hibernate-swap,file=",
    "virtio-blk-pci,drive=omarchy-hibernate-swap,serial=omarchy-resume",
  ]) assert.equal(occurrences(runner, token), 2, `source/target topology count differs for ${token}`);
  assert.doesNotMatch(runner, /^\s*-incoming\b/m);
  assert.match(runner, /target_args=\([\s\S]*?\n\s+-snapshot\n/);
  assert.ok(runner.indexOf("omarchy-hibernate-root,file=") < runner.indexOf("drive=omarchy-hibernate-root,serial=omarchy-root"));
  assert.ok(runner.indexOf("drive=omarchy-hibernate-root,serial=omarchy-root") < runner.indexOf("omarchy-hibernate-swap,file="));
});

test("native PASS requires marker, live report, two frames, and real Foot input", async () => {
  const runner = await read("run-inside-container.sh");
  const phases = [
    "fresh-target-resume",
    "resumed-authentic-report",
    "resumed-healthy-frames",
    "resumed-foot-input",
  ].map((phase) => runner.indexOf(`set_phase ${phase}`));
  assert.ok(phases.every((index) => index >= 0));
  assert.deepEqual([...phases].sort((a, b) => a - b), phases);
  for (const token of [
    "report_gate", "capture_two_healthy_frames", "release-modifiers", "super-return",
    "wait_for_foot_frame", "target-running-status.json", "freshPostResumeInteraction: true",
  ]) assert.ok(runner.includes(token), `acceptance gate is missing ${token}`);
  assert.match(runner, /health\.clean|frame_health/);
});

test("producer metadata is nonce-safe, split by environment, and fully indexed", async () => {
  const [runner, validator, outer] = await Promise.all([
    read("run-inside-container.sh"),
    read("validate.mjs"),
    read("run.sh"),
  ]);
  for (const token of [
    "producerMachine", "runtimeMachine", "sdl,gl=es,show-cursor=on",
    "kernelCommandLineBase", "sourceKernelCommandLineSha256",
    "sourceKernelCommandLineRedacted", "omarchy.hibernate_nonce=<redacted>",
    "sourceEvidenceSha256", "resumeNonceSha256", "browserQemuWasmSha256",
    "hibernationEntryMarkerSha256", "hibernationMarkerSha256",
  ]) assert.ok(runner.includes(token), `manifest generation is missing ${token}`);
  assert.doesNotMatch(runner, /sourceEvidence:\s*\{[\s\S]*?artifactPath/);
  assert.match(validator, /producer manifest leaks its plaintext resume nonce/);
  assert.match(validator, /SHA256SUMS file set\/order is incomplete or nondeterministic/);
  assert.match(runner, /kill "\$xvfb_pid"[\s\S]*?wait "\$xvfb_pid"[\s\S]*?xvfb_pid=/);
  assert.match(runner, /find \. -type f ! -name SHA256SUMS/);
  assert.match(runner, /final indexed validation is not deterministic/);
  assert.doesNotMatch(outer, /evidence_dir\/validation\.json/);
  assert.match(outer, /outer indexed validation is not deterministic/);
  assert.match(runner, /if \[\[ \$phase != complete \]\]/);
  assert.match(outer, /VIRGL_HIBERNATE_BROWSER_QEMU_WASM must explicitly select/);
  assert.match(outer, /validate-browser-candidate\.mjs/);
  assert.match(outer, /BROWSER_QEMU_WASM_EXPECTED_SHA256/);
  assert.doesNotMatch(outer, /browser_qemu_wasm="?\$repo_dir\/runtime\/dist\/qemu\.wasm/);
});

test("README exposes only bounded commands and the native/browser proof boundary", async () => {
  const readme = await read("README.md");
  for (const token of [
    "node --test proofs/virgl-hibernate/static.test.mjs",
    "BUILD_JOBS=8 proofs/virgl-hibernate/build-pinned-qemu.sh",
    "VIRGL_HIBERNATE_SOURCE_TIMEOUT_SECONDS=1200",
    "VIRGL_HIBERNATE_BROWSER_QEMU_WASM=",
    "make -C runtime build-virgl-webgl2-tcg-bounded-clock",
    "runtime/experiments/virgl-webgl2-tcg-bounded-clock/dist/qemu.wasm",
    "guest-hibernation-resume",
    "browser acceptance",
    "54 minutes",
    "non-promotable",
  ]) assert.ok(readme.includes(token), `README is missing ${token}`);
});
