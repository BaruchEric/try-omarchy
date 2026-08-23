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
