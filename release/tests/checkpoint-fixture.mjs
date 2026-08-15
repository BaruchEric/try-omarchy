import { createHash } from "node:crypto";

function normalizedJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizedJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizedJsonValue(value[key])]),
    );
  }
  return value;
}

export function checkpointSourceEvidence(upstream) {
  const guestReport = {
    schemaVersion: 1,
    generatedAt: "2026-08-15T12:00:00.000Z",
    provenance: {
      repository: upstream.repository,
      commit: upstream.commit,
      version: upstream.version,
      treeSha256: upstream.treeSha256,
    },
    system: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      kernel: "6.16.0-arch1-1",
      sessionType: "wayland",
    },
    components: [
      {
        role: "compositor",
        name: "Hyprland",
        version: "0.50.1",
        executable: "/usr/bin/Hyprland",
      },
      {
        role: "shell",
        name: "Quickshell",
        version: "0.2.0",
        executable: "/usr/bin/quickshell",
      },
    ],
    processes: [
      { name: "Hyprland", pid: 101 },
      { name: "quickshell", pid: 102 },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n", stderr: "" },
      {
        argv: ["hyprctl", "version"],
        exitCode: 0,
        stdout: "Hyprland 0.50.1\n",
        stderr: "",
      },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: "[{\"width\":1600,\"height\":900,\"disabled\":false}]",
        stderr: "",
      },
      {
        argv: ["omarchy-version"],
        exitCode: 0,
        stdout: `${upstream.version}\n`,
        stderr: "",
      },
    ],
    configs: [
      {
        path: "/home/omarchy/.config/hypr/hyprland.conf",
        sha256: "5".repeat(64),
        origin: "omarchy-upstream",
      },
    ],
  };
  const normalizedGuestReportSha256 = createHash("sha256")
    .update(JSON.stringify(normalizedJsonValue(guestReport)))
    .digest("hex");
  return {
    guestReport,
    normalizedGuestReportSha256,
    reportValidationSha256: "6".repeat(64),
    checkpointFrameSha256: "7".repeat(64),
    checkpointFrameHealthSha256: "8".repeat(64),
  };
}

export const HIBERNATION_SWAP_UUID =
  "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f";
export const HIBERNATION_SWAP_VIRTUAL_BYTES = 1_610_612_736;
export const HIBERNATION_SOURCE_BOOT_ID =
  "8d8ea31b-3c52-4cc5-a876-f9e1fc0b68a7";
export const HIBERNATION_RESUME_NONCE = "ab".repeat(32);
export const HIBERNATION_KERNEL_EVIDENCE = Object.freeze([
  "PM: Image signature found, resuming",
  "PM: Image loading done",
  "Hibernation image restored successfully",
]);

export function normalizedJsonSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedJsonValue(value)))
    .digest("hex");
}

export function hibernationResumeMarker() {
  return {
    schemaVersion: 1,
    status: "resumed",
    nonce: HIBERNATION_RESUME_NONCE,
    sourceBootId: HIBERNATION_SOURCE_BOOT_ID,
    swapUuid: HIBERNATION_SWAP_UUID,
    gpuDriver: "virtio_gpu",
    renderNode: "/dev/dri/renderD128",
  };
}

export function hibernationResumeEvidence(marker = hibernationResumeMarker()) {
  const digestKeys = [
    "diagnosticsSha256",
    "rendererProbeSha256",
    "normalizedGuestReportSha256",
    "reportValidationSha256",
    "desktopFrame1Sha256",
    "desktopFrame1HealthSha256",
    "desktopFrame2Sha256",
    "desktopFrame2HealthSha256",
    "footFrameSha256",
    "footFrameHealthSha256",
    "footChangeSha256",
  ];
  return {
    ...Object.fromEntries(
      digestKeys.map((key, index) => [key, (index % 10).toString(16).repeat(64)]),
    ),
    hibernationMarkerSha256: normalizedJsonSha256(marker),
    renderer: "virgl (llvmpipe (LLVM 20.1.8, 256 bits))",
    freshPostResumeInteraction: true,
  };
}

export function hibernationSourceEvidence() {
  return {
    diagnosticsSha256: "d".repeat(64),
    hibernationEntryMarkerSha256: "e".repeat(64),
    nonceSha256: createHash("sha256")
      .update(HIBERNATION_RESUME_NONCE)
      .digest("hex"),
    sourceBootId: HIBERNATION_SOURCE_BOOT_ID,
    gpuBoundAtHibernate: false,
  };
}

export function hibernationKernelCommandLine(
  swapUuid = HIBERNATION_SWAP_UUID,
) {
  return [
    "root=/dev/vda",
    "rw",
    "rootwait",
    "console=tty0",
    "console=ttyS0,115200n8",
    "loglevel=4",
    "systemd.show_status=false",
    "rd.systemd.show_status=false",
    "mitigations=off",
    "nowatchdog",
    "omarchy.web_demo=1",
    `resume=UUID=${swapUuid}`,
    "ignore_loglevel",
    "hibernate.compressor=lzo",
  ].join(" ");
}

export function hibernationProfile({
  baseGuestManifestSha256 = "1".repeat(64),
  rootfsSha256 = "2".repeat(64),
  guestProvenanceSha256 = "3".repeat(64),
  kernelSha256 = "4".repeat(64),
  baseInitramfsSha256 = "5".repeat(64),
  derivedInitramfsSha256 = "6".repeat(64),
  browserQemuWasmSha256 = "7".repeat(64),
  producerManifestSha256 = "8".repeat(64),
  producerManifestBytes = 4096,
} = {}) {
  const sourceEvidence = hibernationSourceEvidence();
  const commandLine = hibernationKernelCommandLine();
  return {
    schemaVersion: 1,
    mode: "guest-hibernation-resume",
    derivedInitramfs: {
      artifactPath: "initramfs-virgl-hibernate.img",
      mountPath: "/pack/initramfs-virgl-hibernate.img",
      bytes: 72_000_000,
      sha256: derivedInitramfsSha256,
      format: "linux-initramfs",
      baseArtifactPath: "initramfs-linux.img",
    },
    rootDelta: {
      artifactPath: "hibernate-root-overlay.qcow2",
      mountPath: "/pack/hibernate-root-overlay.qcow2",
      bytes: 24_000_000,
      sha256: "9".repeat(64),
      format: "qcow2",
      backingFilename: "rootfs.ext4",
      backingFormat: "raw",
    },
    swapImage: {
      artifactPath: "omarchy-hibernate.qcow2",
      mountPath: "/pack/omarchy-hibernate.qcow2",
      bytes: 480_000_000,
      sha256: "a".repeat(64),
      format: "qcow2",
      virtualBytes: HIBERNATION_SWAP_VIRTUAL_BYTES,
      swapUuid: HIBERNATION_SWAP_UUID,
    },
    producer: {
      manifestArtifactPath: "hibernate-manifest.json",
      manifestBytes: producerManifestBytes,
      manifestSha256: producerManifestSha256,
      qemuBinarySha256: "c".repeat(64),
    },
    sourceEvidence,
    resumeEvidence: hibernationResumeEvidence(),
    identity: {
      baseGuestManifestSha256,
      rootfsSha256,
      guestProvenanceSha256,
      kernelSha256,
      baseInitramfsSha256,
      derivedInitramfsSha256,
      browserQemuWasmSha256,
      qemu: {
        repository: "https://github.com/ktock/qemu-wasm.git",
        sourceCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
        version: "8.2.0",
      },
      producerMachine: {
        type: "pc-q35-8.2",
        memoryMiB: 1024,
        smp: "2,sockets=1,cores=2,threads=1",
        accel: "tcg,tb-size=128,thread=multi",
        cpu: "qemu64",
        display: "sdl,gl=on,show-cursor=on",
        displayDevice:
          "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
        blockDevices: [
          {
            driveId: "omarchy-hibernate-root",
            device: "virtio-blk-pci",
            serial: "omarchy-root",
            role: "root",
            format: "qcow2",
          },
          {
            driveId: "omarchy-hibernate-swap",
            device: "virtio-blk-pci",
            serial: "omarchy-resume",
            role: "resume",
            format: "qcow2",
          },
        ],
      },
      runtimeMachine: {
        type: "pc-q35-8.2",
        memoryMiB: 1024,
        smp: "2,sockets=1,cores=2,threads=1",
        accel: "tcg,tb-size=128,thread=multi",
        cpu: "qemu64",
        display: "sdl,gl=es,show-cursor=on",
        displayDevice:
          "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
        blockDevices: [
          {
            driveId: "omarchy-hibernate-root",
            device: "virtio-blk-pci",
            serial: "omarchy-root",
            role: "root",
            format: "qcow2",
          },
          {
            driveId: "omarchy-hibernate-swap",
            device: "virtio-blk-pci",
            serial: "omarchy-resume",
            role: "resume",
            format: "qcow2",
          },
        ],
      },
    },
    restoreContract: {
      coldBootFallbackAllowed: false,
      disposableWrites:
        "target -snapshot layers over immutable root delta and hibernation image",
      gpuBoundAtHibernate: false,
      resumeNonceSha256: createHash("sha256")
        .update(HIBERNATION_RESUME_NONCE)
        .digest("hex"),
      sourceBootId: HIBERNATION_SOURCE_BOOT_ID,
      kernelCommandLineBase: commandLine,
      sourceEvidenceSha256: normalizedJsonSha256(sourceEvidence),
      sourceKernelCommandLineSha256: createHash("sha256")
        .update(
          `${commandLine} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=${HIBERNATION_RESUME_NONCE}`,
        )
        .digest("hex"),
      sourceKernelCommandLineRedacted:
        `${commandLine} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>`,
      targetKernelCommandLine: `${commandLine} omarchy.hibernate_target=1`,
      runtimeDisplay: "sdl,gl=es,show-cursor=on",
      virtioGpuLoadedAfterResume: true,
    },
  };
}

export function hibernationRuntimeManifest(baseManifest, profile) {
  const manifest = structuredClone(baseManifest);
  manifest.guest.initramfs = {
    artifactPath: profile.derivedInitramfs.artifactPath,
    mountPath: profile.derivedInitramfs.mountPath,
  };
  const argumentsList = manifest.qemu.arguments;
  argumentsList.splice(6, 0, "-cpu", profile.identity.runtimeMachine.cpu);
  argumentsList[argumentsList.indexOf("-display") + 1] =
    profile.restoreContract.runtimeDisplay;
  const displayDevice = argumentsList.indexOf(
    "virtio-vga,max_outputs=1,xres=1600,yres=900",
  );
  argumentsList[displayDevice] = profile.identity.runtimeMachine.displayDevice;
  argumentsList[argumentsList.indexOf("-initrd") + 1] =
    profile.derivedInitramfs.mountPath;
  argumentsList[argumentsList.indexOf("-append") + 1] =
    profile.restoreContract.targetKernelCommandLine;
  manifest.checkpoint = profile;
  return manifest;
}

export function hibernationProducerDocument(profile, upstream) {
  void upstream;
  const sourceEvidence = hibernationSourceEvidence();
  return {
    schemaVersion: 1,
    kind: "omarchy-web-guest-hibernation",
    derivedInitramfs: {
      artifactPath: profile.derivedInitramfs.artifactPath,
      bytes: profile.derivedInitramfs.bytes,
      sha256: profile.derivedInitramfs.sha256,
      format: profile.derivedInitramfs.format,
      baseArtifactPath: profile.derivedInitramfs.baseArtifactPath,
    },
    rootDelta: {
      path: profile.rootDelta.artifactPath,
      bytes: profile.rootDelta.bytes,
      sha256: profile.rootDelta.sha256,
      format: profile.rootDelta.format,
      backingFilename: profile.rootDelta.backingFilename,
      backingFormat: profile.rootDelta.backingFormat,
    },
    swapImage: {
      path: profile.swapImage.artifactPath,
      bytes: profile.swapImage.bytes,
      sha256: profile.swapImage.sha256,
      format: profile.swapImage.format,
      virtualBytes: profile.swapImage.virtualBytes,
      swapUuid: profile.swapImage.swapUuid,
    },
    producer: {
      qemuBinarySha256: profile.producer.qemuBinarySha256,
    },
    resumeEvidence: structuredClone(profile.resumeEvidence),
    identity: {
      baseGuestManifestSha256: profile.identity.baseGuestManifestSha256,
      rootfsSha256: profile.identity.rootfsSha256,
      guestProvenanceSha256: profile.identity.guestProvenanceSha256,
      kernelSha256: profile.identity.kernelSha256,
      baseInitramfsSha256: profile.identity.baseInitramfsSha256,
      derivedInitramfsSha256: profile.identity.derivedInitramfsSha256,
      browserQemuWasmSha256: profile.identity.browserQemuWasmSha256,
    },
    qemu: structuredClone(profile.identity.qemu),
    producerMachine: structuredClone(profile.identity.producerMachine),
    runtimeMachine: structuredClone(profile.identity.runtimeMachine),
    restoreContract: structuredClone(profile.restoreContract),
    sourceEvidence,
  };
}

export function qcow2Fixture({
  backingFilename = "rootfs.ext4",
  backingFormat = "raw",
  virtualBytes = 1024 * 1024,
} = {}) {
  const headerLength = 112;
  const formatBytes = Buffer.from(backingFormat, "utf8");
  const formatExtensionBytes = 8 + Math.ceil(formatBytes.byteLength / 8) * 8;
  const backingOffset = headerLength + formatExtensionBytes + 8;
  const backingBytes = Buffer.from(backingFilename, "utf8");
  const bytes = Buffer.alloc(backingOffset + backingBytes.byteLength);
  bytes.writeUInt32BE(0x514649fb, 0);
  bytes.writeUInt32BE(3, 4);
  bytes.writeBigUInt64BE(BigInt(backingOffset), 8);
  bytes.writeUInt32BE(backingBytes.byteLength, 16);
  bytes.writeUInt32BE(16, 20);
  bytes.writeBigUInt64BE(BigInt(virtualBytes), 24);
  bytes.writeUInt32BE(4, 96);
  bytes.writeUInt32BE(headerLength, 100);
  bytes.writeUInt32BE(0xe2792aca, headerLength);
  bytes.writeUInt32BE(formatBytes.byteLength, headerLength + 4);
  formatBytes.copy(bytes, headerLength + 8);
  backingBytes.copy(bytes, backingOffset);
  return bytes;
}

export function standaloneQcow2Fixture({
  virtualBytes = HIBERNATION_SWAP_VIRTUAL_BYTES,
} = {}) {
  const bytes = Buffer.alloc(104);
  bytes.writeUInt32BE(0x514649fb, 0);
  bytes.writeUInt32BE(3, 4);
  bytes.writeBigUInt64BE(0n, 8);
  bytes.writeUInt32BE(0, 16);
  bytes.writeUInt32BE(16, 20);
  bytes.writeBigUInt64BE(BigInt(virtualBytes), 24);
  bytes.writeUInt32BE(4, 96);
  bytes.writeUInt32BE(104, 100);
  return bytes;
}
