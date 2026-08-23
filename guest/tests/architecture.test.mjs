import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guest = new URL("../", import.meta.url);

function text(path) {
  return readFileSync(new URL(path, guest), "utf8");
}

function json(path) {
  return JSON.parse(text(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageNames(path) {
  return text(path)
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

test("x86 and ARM specs are immutable, distinct Quattro products", () => {
  const x86 = json("spec.json");
  const arm = json("spec.aarch64.json");

  assert.equal(x86.image.architecture, "x86_64");
  assert.equal(arm.image.architecture, "aarch64");
  assert.equal(x86.upstream.channel, "quattro");
  assert.equal(arm.upstream.channel, "quattro");
  assert.deepEqual(x86.upstream, arm.upstream);
  assert.equal(arm.upstream.version, "4.0.0.alpha");
  assert.match(arm.upstream.commit, /^[0-9a-f]{40}$/);
  assert.match(arm.upstream.tree, /^[0-9a-f]{40}$/);
  assert.match(arm.upstream.treeSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(arm.image.filesystemUuid, x86.image.filesystemUuid);
  assert.deepEqual(arm.guest.virtualDisplay, x86.guest.virtualDisplay);
  assert.equal(arm.runtime.virtualMachineMonitor, "qemu-system-aarch64");
  assert.equal(arm.runtime.hypervisor, "hvf");
  assert.deepEqual(arm.runtime.graphics, {
    device: "virtio-gpu-gl-pci",
    display: "cocoa",
    guestRenderer: "virgl",
    hostRenderer: "angle-metal",
  });
  assert.deepEqual(arm.runtime.network, {
    device: "virtio-net-pci",
    backend: "slirp",
    mode: "user",
  });
  assert.deepEqual(arm.runtime.audio, {
    controller: "intel-hda",
    codec: "hda-micro",
    backend: "sdl",
    duplex: true,
  });
  assert.deepEqual(arm.runtime.storage, {
    device: "virtio-blk-pci",
    format: "raw",
    mode: "persistent",
    initialization: "apfs-clone",
    fallback: "full-copy",
  });
  assert.deepEqual(arm.runtime.devices, [
    "virtio-blk-pci",
    "virtio-gpu-gl-pci",
    "virtio-keyboard-pci",
    "virtio-tablet-pci",
    "virtio-net-pci",
    "virtio-serial-pci",
    "virtconsole",
    "virtio-rng-pci",
    "virtio-balloon-pci",
    "intel-hda",
    "hda-micro",
  ]);
  assert.equal(arm.runtime.kernelSource, "/boot/Image");
  assert.deepEqual(x86.inputs.packageCachePins, [
    "qt6-base",
    "qt6-declarative",
    "qt6-svg",
    "qt6-translations",
    "qt6-wayland",
  ]);
  assert.match(arm.runtime.kernelCommandLine, /(?:^| )console=hvc0(?: |$)/);
  assert.ok(!arm.runtime.kernelCommandLine.includes("ttyS0"));
});

test("ARM dependency transaction is architecture-matched and fully locked", () => {
  const spec = json("spec.aarch64.json");
  const packages = packageNames(spec.inputs.packages);
  const lock = json(spec.inputs.packageLock);

  assert.deepEqual(packages, [...new Set(packages)].sort());
  assert.equal(lock.architecture, "aarch64");
  assert.equal(lock.requestedFileSha256, sha256(text(spec.inputs.packages)));
  assert.ok(Object.keys(lock.packages).length > 500);
  for (const required of [
    "chromium",
    "foot",
    "hyprland",
    "linux-aarch64",
    "mesa",
    "quickshell",
    "udiskie",
    "vulkan-swrast",
  ]) {
    assert.ok(packages.includes(required), `missing requested ARM package ${required}`);
    assert.equal(typeof lock.packages[required], "string");
  }
  for (const unavailable of [
    "omarchy-nvim",
    "quickshell-git",
    "ttf-jetbrains-mono-nerd-basic",
    "xdg-terminal-exec",
  ]) {
    assert.ok(!packages.includes(unavailable));
  }
});

test("ARM bootstrap and package repository inputs are commit and digest pinned", () => {
  const spec = json("spec.aarch64.json");
  const container = text("Containerfile.aarch64");
  const pacstrap = text("vendor/omarchy-pkgs/pacstrap-docker");

  assert.match(spec.supplyChain.omarchyPackagesCommit, /^[0-9a-f]{40}$/);
  assert.match(spec.supplyChain.archLinuxArmPackagesCommit, /^[0-9a-f]{40}$/);
  assert.ok(container.includes(spec.supplyChain.omarchyPackagesCommit));
  assert.ok(container.includes(spec.supplyChain.archLinuxArmPackagesCommit));
  assert.equal(
    sha256(pacstrap),
    "dc31490fa0c387a68ee860d18cca67b43831a45206f2d5e9cfaff103fba85055",
  );
  assert.match(container, /sha256sum -c -/);
  assert.doesNotMatch(container, /latest/);
});

test("ARM wrapper selects native arm64 Docker and an isolated output", () => {
  const output = execFileSync(
    fileURLToPath(new URL("build-arm64-container.sh", guest)),
    ["--dry-run"],
    { encoding: "utf8" },
  );
  assert.match(output, /^architecture=aarch64$/m);
  assert.match(output, /^platform=linux\/arm64$/m);
  assert.match(output, /guest\/dist-aarch64$/m);
  assert.match(output, /^work-volume=omarchy-arm64-guest-work-[0-9]+$/m);
});

test("guest identity and initramfs support both runtime device sets", () => {
  const probe = text("overlay/usr/local/bin/omarchy-web-guest-probe");
  const initramfs = text("overlay/etc/mkinitcpio.conf.d/90-omarchy-web.conf");
  const sharedEnvironment = text("overlay/usr/lib/environment.d/90-omarchy-web.conf");
  const browserEnvironment = text("fragments/environment-x86-web.conf");
  const configure = text("scripts/configure-rootfs.sh");
  const terminal = text("overlay/usr/local/bin/xdg-terminal-exec");

  assert.match(probe, /expected_architecture not in \{"x86_64", "aarch64"\}/);
  assert.match(probe, /pathlib\.Path\("\/dev\/hvc0"\)/);
  assert.match(probe, /package_version\("quickshell"/);
  for (const kernelModule of ["virtio_mmio", "virtio_console", "virtio_rng", "virtio_net"]) {
    assert.ok(initramfs.includes(kernelModule));
  }
  assert.doesNotMatch(sharedEnvironment, /LIBGL_ALWAYS_SOFTWARE|GALLIUM_DRIVER/);
  assert.match(sharedEnvironment, /WLR_RENDERER_ALLOW_SOFTWARE=1/);
  assert.match(browserEnvironment, /LIBGL_ALWAYS_SOFTWARE=true/);
  assert.match(browserEnvironment, /GALLIUM_DRIVER=llvmpipe/);
  assert.match(configure, /if \[\[ \$architecture == x86_64 \]\]; then[\s\S]*environment-x86-web\.conf/);
  assert.match(probe, /\["hyprctl", "systeminfo"\]/);
  assert.match(terminal, /exec \/usr\/bin\/foot/);
  assert.doesNotMatch(terminal, /eval|source /);
});

test("ARM QEMU host cursor is boot-gated without freezing display policy", () => {
  const profile = text("fragments/hypr-monitors-arm-qemu.append.lua");
  const configure = text("scripts/configure-rootfs.sh");

  assert.match(profile, /pcall\(io\.open, "\/proc\/cmdline", "r"\)/);
  assert.match(profile, /for option in cmdline:gmatch\("%S\+"\)/);
  assert.match(
    profile,
    /if omarchy_kernel_option_enabled\("omarchy\.qemu_virgl=1"\) then[\s\S]*hl\.config\(\{ cursor = \{ invisible = true \} \}\)[\s\S]*\nend/,
  );
  assert.doesNotMatch(profile, /hl\.monitor\(|GDK_SCALE|1920x1080|@60/);
  assert.doesNotMatch(profile, /LIBGL_ALWAYS_SOFTWARE|GALLIUM_DRIVER|llvmpipe/);
  assert.match(
    configure,
    /elif \[\[ \$architecture == aarch64 \]\]; then\n\s+cat "\$guest_dir\/fragments\/hypr-monitors-arm-qemu\.append\.lua"/,
  );
});

test("browser and native guests receive truthful architecture-specific welcomes", () => {
  const browserWelcome = text("fragments/hypr-autostart.append.lua");
  const nativeWelcome = text("fragments/hypr-autostart-arm-qemu.append.lua");
  const configure = text("scripts/configure-rootfs.sh");

  assert.match(browserWelcome, /Everything resets when this tab closes\./);
  assert.doesNotMatch(nativeWelcome, /resets|tab closes/i);
  assert.match(nativeWelcome, /'Press cmd space to explore\.'/);
  assert.match(
    configure,
    /if \[\[ \$architecture == x86_64 \]\]; then[\s\S]*hypr-autostart\.append\.lua[\s\S]*elif \[\[ \$architecture == aarch64 \]\]; then[\s\S]*hypr-autostart-arm-qemu\.append\.lua/,
  );
});
