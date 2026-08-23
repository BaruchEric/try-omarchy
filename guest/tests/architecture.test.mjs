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

test("ARM factory contract is unprovisioned, ephemeral, and isolated", () => {
  const demo = json("spec.aarch64.json");
  const factory = json("spec.aarch64-unprovisioned.json");
  const demoPackages = packageNames(demo.inputs.packages);
  const factoryPackages = packageNames(factory.inputs.packages);
  const factoryLock = json(factory.inputs.packageLock);

  assert.deepEqual(factory.upstream, demo.upstream);
  assert.equal(factory.image.architecture, "aarch64");
  assert.equal(demo.image.sizeMiB, 6144);
  assert.equal(factory.image.sizeMiB, demo.image.sizeMiB);
  assert.equal(factory.image.filesystemLabel, "omarchy-factory");
  assert.equal(factory.image.filesystemUuid, "89054943-1f4e-4f14-b934-d6db3fba4254");
  assert.notEqual(factory.image.filesystemUuid, demo.image.filesystemUuid);
  assert.deepEqual(factory.guest, {
    profile: "factory",
    hostname: "omarchy-factory",
    username: null,
    uid: null,
    defaultTheme: null,
    virtualDisplay: demo.guest.virtualDisplay,
  });
  assert.deepEqual(factory.runtime.storage, {
    device: "virtio-blk-pci",
    format: "raw",
    mode: "ephemeral",
    initialization: "apfs-clone",
    fallback: "full-copy",
    expandedSizeMiB: 24576,
  });
  assert.ok(!factory.runtime.kernelCommandLine.includes("omarchy.web_demo=1"));
  assert.deepEqual(factoryPackages, [...new Set(factoryPackages)].sort());
  assert.deepEqual(factoryPackages, [...demoPackages, "pacman-contrib", "sddm"].sort());
  assert.equal(factoryLock.architecture, "aarch64");
  assert.equal(factoryLock.requestedFileSha256, sha256(text(factory.inputs.packages)));
  assert.equal(typeof factoryLock.packages["pacman-contrib"], "string");
  assert.equal(typeof factoryLock.packages.sddm, "string");
  assert.ok(Object.keys(factoryLock.packages).length > 500);
  for (const unavailable of ["mise", "mise-bin", "ttfx", "ttfx-bin", "tzupdate", "tzupdate-bin"]) {
    assert.ok(!factoryPackages.includes(unavailable));
  }
  assert.deepEqual(factory.supplyChain.mise, {
    version: "2026.8.6",
    url: "https://github.com/jdx/mise/releases/download/v2026.8.6/mise-v2026.8.6-linux-arm64.tar.xz",
    sha256: "dfdb41a4654f473f504625ffa1e011e119e5fd1880ccbed8dcb0b21a58ccd309",
    binarySha256: "f9bd051912beb8861bf248289bfb2d8c281ff00fcdf1e44d730b8ea7e859e9a4",
    reportedVersion: "2026.8.6 linux-arm64 (2026-08-14)",
    license: "MIT",
  });
  for (const requiredPath of [
    "bin/omarchy-provision-owner",
    "bin/omarchy-provision-user",
    "install/provisioning/omarchy-provision-owner.service",
    "install/provisioning/setup-form.sh",
    "install/user/all.sh",
  ]) {
    assert.ok(factory.authenticity.requiredPaths.includes(requiredPath));
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
  const wrapper = fileURLToPath(new URL("build-arm64-container.sh", guest));
  const output = execFileSync(
    wrapper,
    ["--dry-run"],
    { encoding: "utf8" },
  );
  assert.match(output, /^architecture=aarch64$/m);
  assert.match(output, /^platform=linux\/arm64$/m);
  assert.match(output, /guest\/dist-aarch64$/m);
  assert.match(output, /^work-volume=omarchy-arm64-guest-work-[0-9]+$/m);

  const factory = execFileSync(
    wrapper,
    ["--dry-run", "--spec", fileURLToPath(new URL("spec.aarch64-unprovisioned.json", guest))],
    { encoding: "utf8" },
  );
  assert.match(factory, /^profile=factory$/m);
  assert.match(factory, /guest\/dist-aarch64-unprovisioned$/m);
  assert.match(factory, /^mode=build$/m);

  const lock = execFileSync(
    wrapper,
    [
      "--dry-run",
      "--spec", fileURLToPath(new URL("spec.aarch64-unprovisioned.json", guest)),
      "--refresh-package-lock", "/tmp/packages.aarch64-unprovisioned.lock.json",
    ],
    { encoding: "utf8" },
  );
  assert.match(lock, /^mode=refresh-package-lock$/m);
  assert.match(lock, /^package-lock-output=\/tmp\/packages\.aarch64-unprovisioned\.lock\.json$/m);
});

test("factory profile excludes every demo customization", () => {
  const configure = text("scripts/configure-rootfs.sh");
  const finalize = text("scripts/finalize-rootfs.sh");
  const ttfx = text("compat/ttfx-arm64");
  const manifest = text("scripts/write-guest-manifest.py");

  assert.match(configure, /if \[\[ \$profile == demo \]\]; then\n\s+cp -a "\$guest_dir\/overlay\/\."/);
  assert.match(configure, /if \[\[ \$profile == demo \]\]; then[\s\S]*hypr-autostart-arm-qemu\.append\.lua/);
  assert.match(configure, /var\/lib\/omarchy\/provisioning\/pending/);
  assert.match(configure, /omarchy-provision-owner\.service/);
  assert.match(finalize, /systemctl enable omarchy-provision-owner\.service/);
  assert.match(finalize, /systemctl enable sddm\.service/);
  assert.match(finalize, /if \[\[ \$profile == factory \]\]; then[\s\S]*exit 0[\s\S]*username=\$\(read_spec/);
  assert.doesNotMatch(ttfx, /curl|wget|exec|eval|source /);
  assert.match(manifest, /if "profile" in spec\["guest"\]:/);
});

test("factory setup and update prerequisites are pinned and locally represented", () => {
  const build = text("build.sh");
  const mise = text("scripts/register-pinned-mise.sh");
  const repository = text("scripts/register-local-repository.sh");
  const runtime = text("scripts/register-omarchy-runtime.sh");
  const finalize = text("scripts/finalize-rootfs.sh");
  const pacman = text("pacman.aarch64.conf");
  const launcher = readFileSync(
    new URL("../../native/macos/run-qemu-gpu.sh", import.meta.url),
    "utf8",
  );

  assert.ok(
    build.indexOf("register-omarchy-runtime.sh") < build.indexOf("register-pinned-mise.sh")
      && build.indexOf("register-pinned-mise.sh") < build.indexOf("register-local-repository.sh"),
  );
  assert.match(mise, /mise-v\$version-linux-arm64\.tar\.xz/);
  assert.match(mise, /sha256sum -c -/);
  assert.match(mise, /unexpected member set/);
  assert.match(mise, /pacman[\s\\\n]+--noconfirm[\s\S]+-U "\$package_archive"/);
  assert.match(mise, /-T mise/);
  assert.match(runtime, /usr\/share\/omarchy-web\/repo/);
  assert.match(repository, /repo-add --quiet/);
  assert.match(repository, /var\/lib\/pacman\/sync\/\$repo_name\.db/);
  assert.doesNotMatch(repository, /pacman -Syy/);
  assert.match(repository, /pacman -Qem/);
  assert.match(pacman, /^IgnorePkg = linux-aarch64$/m);
  assert.match(finalize, /systemd-growfs-root\.service/);
  assert.match(launcher, /expandedSizeMiB/);
  assert.match(launcher, /os\.O_WRONLY \| os\.O_NOFOLLOW/);
  assert.match(launcher, /os\.ftruncate\(descriptor, expanded_size\)/);
  assert.match(launcher, /this guest requires --ephemeral working-disk expansion/);
  assert.match(launcher, /only disposable disks may use runtime expansion/);
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
  assert.match(nativeWelcome, /'Press Super \+ Space to explore\.'/);
  assert.match(
    configure,
    /if \[\[ \$architecture == x86_64 \]\]; then[\s\S]*hypr-autostart\.append\.lua[\s\S]*elif \[\[ \$architecture == aarch64 \]\]; then[\s\S]*hypr-autostart-arm-qemu\.append\.lua/,
  );
});
