#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: native/macos/run-qemu-gpu.sh [--ephemeral | --reset-storage] [GUEST_DIR]" >&2
  exit 64
}

fail() {
  echo "run-qemu-gpu: $*" >&2
  exit 1
}

storage_mode=persistent
case ${1:-} in
  --ephemeral)
    storage_mode=ephemeral
    shift
    ;;
  --reset-storage)
    storage_mode=reset
    shift
    ;;
  --*) usage ;;
esac
(( $# <= 1 )) || usage

native_dir=$(cd "$(dirname "$0")" && pwd -P)
repo_dir=$(cd "$native_dir/../.." && pwd -P)
guest_input=${1:-"$repo_dir/guest/dist-aarch64"}
qemu_bin="$native_dir/.build/qemu-gpu-runtime/bin/qemu-system-aarch64"
input_bridge="$native_dir/.build/Omarchy Quattro.app/Contents/MacOS/omarchy-vm-helper"
storage_library="$native_dir/qemu-persistent-storage.sh"

[[ -f $storage_library && ! -L $storage_library ]] || {
  fail "persistent-storage library is missing or unsafe: $storage_library"
}
# shellcheck source=qemu-persistent-storage.sh
source "$storage_library"

[[ $(uname -m) == arm64 ]] || fail "requires an ARM64 Mac"
[[ $(uname -s) == Darwin ]] || fail "requires macOS"
[[ -d $guest_input && ! -L $guest_input ]] || fail "ARM guest directory is missing or unsafe: $guest_input"
guest_dir=$(cd "$guest_input" && pwd -P)

for command in codesign file getconf id mktemp ps python3 stat sysctl; do
  command -v "$command" >/dev/null || fail "$command is required"
done

[[ -f $qemu_bin && -x $qemu_bin ]] || {
  fail "missing staged GPU QEMU runtime at $qemu_bin"
}
[[ -f $input_bridge && -x $input_bridge ]] || {
  fail "missing focused Command-key bridge at $input_bridge; run native/macos/build-app.sh first"
}
file "$qemu_bin" | grep -q 'arm64' || fail "staged QEMU is not an ARM64 executable"
for marker in \
  OMARCHY_SDL_AUDIO_CONTROL_DIRECTORY \
  OMARCHY_SDL_INPUT_DEVICE_NAME \
  OMARCHY_SDL_OUTPUT_DEVICE_NAME; do
  LC_ALL=C grep -aFq "$marker" "$qemu_bin" || {
    fail "staged QEMU lacks persistent host audio routing; rerun npm run omarchy:native:prepare"
  }
done
file "$input_bridge" | grep -q 'arm64' || fail "focused Command-key bridge is not an ARM64 executable"
codesign --verify --strict "$input_bridge" >/dev/null 2>&1 || {
  fail "focused Command-key bridge is not code-signed"
}

qemu_accels=$("$qemu_bin" -accel help 2>&1) || fail "cannot inspect staged QEMU accelerators"
printf '%s\n' "$qemu_accels" | grep -qx 'hvf' || fail "staged QEMU does not support HVF"
qemu_machines=$("$qemu_bin" -machine help 2>&1) || fail "cannot inspect staged QEMU machines"
printf '%s\n' "$qemu_machines" | grep -Eq '^virt[[:space:]]' || fail "staged QEMU does not provide the ARM virt machine"
qemu_cpus=$("$qemu_bin" -cpu help 2>&1) || fail "cannot inspect staged QEMU CPUs"
printf '%s\n' "$qemu_cpus" | grep -Eq '^[[:space:]]*host([[:space:]]|$)' || fail "staged QEMU does not expose the host CPU"
qemu_displays=$("$qemu_bin" -display help 2>&1) || fail "cannot inspect staged QEMU displays"
printf '%s\n' "$qemu_displays" | grep -qx 'cocoa' || fail "staged QEMU does not provide the Cocoa display"
qemu_devices=$("$qemu_bin" -device help 2>&1) || fail "cannot inspect staged QEMU devices"
qemu_help=$("$qemu_bin" -help 2>&1) || fail "cannot inspect staged QEMU options"
printf '%s\n' "$qemu_help" | grep -q -- '^-add-fd fd=fd,set=set' || {
  fail "staged QEMU cannot preserve the persistent-disk lock descriptor"
}
qemu_netdevs=$("$qemu_bin" -machine virt -netdev help 2>&1) || {
  fail "cannot inspect staged QEMU network backends"
}
printf '%s\n' "$qemu_netdevs" | grep -qx 'user' || {
  fail "staged QEMU does not provide no-root SLIRP networking; rerun npm run omarchy:native:prepare"
}
qemu_audiodevs=$("$qemu_bin" -machine virt -audiodev help 2>&1) || {
  fail "cannot inspect staged QEMU audio backends"
}
printf '%s\n' "$qemu_audiodevs" | grep -qx 'sdl' || {
  fail "staged QEMU does not provide duplex SDL audio; rerun npm run omarchy:native:prepare"
}

require_qemu_device() {
  local device=$1
  [[ $qemu_devices == *"name \"$device\""* ]] || fail "staged QEMU does not provide $device"
}

for device in \
  hda-micro \
  intel-hda \
  virtconsole \
  virtserialport \
  virtio-balloon-pci \
  virtio-blk-pci \
  virtio-gpu-gl-pci \
  virtio-keyboard-pci \
  virtio-net-pci \
  virtio-rng-pci \
  virtio-serial-pci \
  virtio-tablet-pci; do
  require_qemu_device "$device"
done

qemu_entitlements=$(codesign -d --entitlements - "$qemu_bin" 2>&1) || {
  fail "staged QEMU is not code-signed for HVF"
}
[[ $qemu_entitlements == *com.apple.security.hypervisor* ]] || {
  fail "staged QEMU lacks the com.apple.security.hypervisor entitlement"
}

gpu_help=$("$qemu_bin" -device virtio-gpu-gl-pci,help 2>&1) || {
  fail "cannot inspect the staged VirGL device"
}
gpu_device='virtio-gpu-gl-pci,max_outputs=1,xres=1920,yres=1080'
if [[ $gpu_help == *'romfile=<str>'* ]]; then
  gpu_device+=',romfile='
fi

# Emit one trusted tab-delimited record on stdout. All validation failures go
# to stderr so command substitution cannot accidentally become launch data.
bundle_validation=$(python3 - "$guest_dir" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import stat
import sys


def fail(message: str) -> None:
    raise SystemExit(f"run-qemu-gpu: invalid ARM guest bundle: {message}")


def exact_keys(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} has an unexpected schema")
    return value


def load_json(path: Path, label: str) -> tuple[dict[str, object], bytes]:
    try:
        data = path.read_bytes()
        value = json.loads(data)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} is not a JSON object")
    return value, data


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(8 * 1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        fail(f"cannot hash {path.name}: {error}")
    return digest.hexdigest()


guest = Path(sys.argv[1])
expected_artifacts = {
    "LICENSE.omarchy": ("guest-license", "text/plain"),
    "build-spec.json": ("guest-metadata", "application/json"),
    "initramfs-linux.img": ("guest-initramfs", "application/vnd.linux.initramfs"),
    "packages.lock.txt": ("guest-metadata", "text/plain"),
    "provenance.json": ("guest-metadata", "application/json"),
    "rootfs.ext4": ("guest-rootfs", "application/vnd.omarchy.ext4"),
    "rootfs.ext4.zst": ("guest-rootfs-compressed", "application/zstd"),
    "vmlinuz-linux": ("guest-kernel", "application/vnd.linux.kernel"),
}
expected_files = set(expected_artifacts) | {"guest-manifest.json", "SHA256SUMS"}

try:
    actual_files = {entry.name for entry in guest.iterdir()}
except OSError as error:
    fail(f"cannot enumerate bundle: {error}")
if actual_files != expected_files:
    missing = sorted(expected_files - actual_files)
    extra = sorted(actual_files - expected_files)
    fail(f"file set differs (missing={missing}, extra={extra})")
for name in expected_files:
    path = guest / name
    try:
        mode = path.lstat().st_mode
    except OSError as error:
        fail(f"cannot stat {name}: {error}")
    if not stat.S_ISREG(mode):
        fail(f"{name} is not a direct regular file")

manifest, manifest_data = load_json(guest / "guest-manifest.json", "guest-manifest.json")
exact_keys(
    manifest,
    {"artifacts", "build", "guest", "kind", "normalizedUpstreamTree", "schemaVersion", "upstream"},
    "guest-manifest.json",
)
if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "omarchy-web-guest-artifacts":
    fail("guest manifest identity is invalid")
manifest_guest_raw = manifest.get("guest")
if not isinstance(manifest_guest_raw, dict):
    fail("guest manifest guest has an unexpected schema")
manifest_profile = manifest_guest_raw.get("profile", "demo")
manifest_guest_keys = {"architecture", "display", "distribution", "kernelCommandLine", "username"}
if manifest_profile == "factory":
    manifest_guest_keys.add("profile")
elif manifest_profile != "demo" or "profile" in manifest_guest_raw:
    fail("guest manifest profile is unsupported")
manifest_guest = exact_keys(manifest_guest_raw, manifest_guest_keys, "guest manifest guest")
if (
    manifest_guest.get("architecture") != "aarch64"
    or manifest_guest.get("distribution") != "Arch Linux"
    or (manifest_profile == "demo" and manifest_guest.get("username") != "omarchy")
    or (manifest_profile == "factory" and manifest_guest.get("username") is not None)
):
    fail("guest manifest is not a supported ARM64 Omarchy guest")

spec, _ = load_json(guest / "build-spec.json", "build-spec.json")
exact_keys(
    spec,
    {
        "authenticity",
        "guest",
        "image",
        "inputs",
        "runtime",
        "schemaVersion",
        "supplyChain",
        "themes",
        "upstream",
    },
    "build-spec.json",
)
if spec.get("schemaVersion") != 1:
    fail("unsupported build spec schema")
image = exact_keys(
    spec.get("image"),
    {"architecture", "filesystem", "filesystemLabel", "filesystemUuid", "sizeMiB", "sourceDateEpoch"},
    "build spec image",
)
spec_guest_raw = spec.get("guest")
if not isinstance(spec_guest_raw, dict):
    fail("build spec guest has an unexpected schema")
spec_profile = spec_guest_raw.get("profile", "demo")
spec_guest_keys = {"defaultTheme", "hostname", "uid", "username", "virtualDisplay"}
if spec_profile == "factory":
    spec_guest_keys.add("profile")
elif spec_profile != "demo" or "profile" in spec_guest_raw:
    fail("build spec profile is unsupported")
spec_guest = exact_keys(spec_guest_raw, spec_guest_keys, "build spec guest")
if spec_profile != manifest_profile:
    fail("manifest and build spec profiles differ")

profile_contracts = {
    "demo": {
        "filesystemLabel": "omarchy-arm64",
        "filesystemUuid": "e9e7c363-3c0b-4a90-8dcf-27579f061653",
        "sizeMiB": 6144,
        "hostname": "omarchy-arm64",
        "username": "omarchy",
        "uid": 1000,
        "defaultTheme": "tokyo-night",
    },
    "factory": {
        "filesystemLabel": "omarchy-factory",
        "filesystemUuid": "89054943-1f4e-4f14-b934-d6db3fba4254",
        "sizeMiB": 6144,
        "hostname": "omarchy-factory",
        "username": None,
        "uid": None,
        "defaultTheme": None,
    },
}
profile_contract = profile_contracts[spec_profile]
if (
    image.get("architecture") != "aarch64"
    or image.get("filesystem") != "ext4"
    or image.get("filesystemLabel") != profile_contract["filesystemLabel"]
    or image.get("filesystemUuid") != profile_contract["filesystemUuid"]
    or image.get("sizeMiB") != profile_contract["sizeMiB"]
):
    fail("build spec image contract is invalid")

display = exact_keys(
    spec_guest.get("virtualDisplay"),
    {"height", "refreshHz", "scale", "width"},
    "build spec display",
)
if (
    spec_guest.get("hostname") != profile_contract["hostname"]
    or spec_guest.get("username") != profile_contract["username"]
    or spec_guest.get("uid") != profile_contract["uid"]
    or spec_guest.get("defaultTheme") != profile_contract["defaultTheme"]
    or display != {"width": 1600, "height": 900, "refreshHz": 60, "scale": 1}
    or manifest_guest.get("display") != display
):
    fail("guest or display contract is invalid")

runtime = exact_keys(
    spec.get("runtime"),
    {
        "audio",
        "compressedDisk",
        "devices",
        "disk",
        "graphics",
        "hypervisor",
        "initramfs",
        "initramfsSource",
        "kernel",
        "kernelCommandLine",
        "kernelSource",
        "minimumCpuCount",
        "minimumMemoryMiB",
        "network",
        "recommendedMemoryMiB",
        "storage",
        "virtualMachineMonitor",
    },
    "build spec runtime",
)
expected_devices = [
    "virtio-blk-pci",
    "virtio-gpu-gl-pci",
    "virtio-keyboard-pci",
    "virtio-tablet-pci",
    "virtio-net-pci",
    "virtio-serial-pci",
    "virtconsole",
    "virtserialport",
    "virtio-rng-pci",
    "virtio-balloon-pci",
    "intel-hda",
    "hda-micro",
]
graphics = {
    "device": "virtio-gpu-gl-pci",
    "display": "cocoa",
    "guestRenderer": "virgl",
    "hostRenderer": "angle-metal",
}
network = {
    "device": "virtio-net-pci",
    "backend": "slirp",
    "mode": "user",
}
audio = {
    "controller": "intel-hda",
    "codec": "hda-micro",
    "backend": "sdl",
    "duplex": True,
}
storage = {
    "device": "virtio-blk-pci",
    "format": "raw",
    "mode": "ephemeral" if spec_profile == "factory" else "persistent",
    "initialization": "apfs-clone",
    "fallback": "full-copy",
}
if spec_profile == "factory":
    storage["expandedSizeMiB"] = 24576
if (
    runtime.get("kernel") != "vmlinuz-linux"
    or runtime.get("kernelSource") != "/boot/Image"
    or runtime.get("initramfs") != "initramfs-linux.img"
    or runtime.get("initramfsSource") != "/boot/initramfs-linux.img"
    or runtime.get("disk") != "rootfs.ext4"
    or runtime.get("compressedDisk") != "rootfs.ext4.zst"
    or runtime.get("virtualMachineMonitor") != "qemu-system-aarch64"
    or runtime.get("hypervisor") != "hvf"
    or runtime.get("graphics") != graphics
    or runtime.get("network") != network
    or runtime.get("audio") != audio
    or runtime.get("storage") != storage
    or runtime.get("devices") != expected_devices
    or runtime.get("minimumMemoryMiB") != 2048
    or runtime.get("recommendedMemoryMiB") != 4096
    or runtime.get("minimumCpuCount") != 4
):
    fail("native runtime contract is invalid")

upstream = exact_keys(
    spec.get("upstream"),
    {"channel", "commit", "license", "repository", "tree", "treeSha256", "version"},
    "build spec upstream",
)
if (
    upstream.get("repository") != "https://github.com/basecamp/omarchy"
    or upstream.get("channel") != "quattro"
    or upstream.get("license") != "MIT"
    or not isinstance(upstream.get("version"), str)
    or not re.fullmatch(r"[0-9a-f]{40}", str(upstream.get("commit", "")))
    or not re.fullmatch(r"[0-9a-f]{40}", str(upstream.get("tree", "")))
    or not re.fullmatch(r"[0-9a-f]{64}", str(upstream.get("treeSha256", "")))
):
    fail("upstream identity is not pinned")

supply_chain_keys = {
    "archLinuxArmPackagesCommit",
    "archLinuxArmPackagesRepository",
    "omarchyPackagesCommit",
    "omarchyPackagesRepository",
}
if spec_profile == "factory":
    supply_chain_keys.add("mise")
supply_chain = exact_keys(spec.get("supplyChain"), supply_chain_keys, "build spec supply chain")
if (
    supply_chain.get("omarchyPackagesRepository") != "https://github.com/omacom-io/omarchy-pkgs"
    or supply_chain.get("omarchyPackagesCommit") != "7e448b90313fea4fb78da9a78607287691d3b241"
    or supply_chain.get("archLinuxArmPackagesRepository") != "https://github.com/archlinuxarm/PKGBUILDs"
    or supply_chain.get("archLinuxArmPackagesCommit") != "0b5418fc3f62860b191cd872cb2f933f9fc77841"
):
    fail("ARM package supply chain is not pinned")
if spec_profile == "factory":
    mise = exact_keys(
        supply_chain.get("mise"),
        {"binarySha256", "license", "reportedVersion", "sha256", "url", "version"},
        "build spec mise component",
    )
    if mise != {
        "version": "2026.8.11",
        "url": "https://github.com/jdx/mise/releases/download/v2026.8.11/mise-v2026.8.11-linux-arm64.tar.xz",
        "sha256": "fefd580d2c6a8169762f40ce5019a61de5b2dcf0b38c5d428ef6b97d5ce76fba",
        "binarySha256": "6b7471271a990cbd6a795b24f9df83338aa220c227bf75fd083442e5a728f5f7",
        "reportedVersion": "2026.8.11 linux-arm64 (2026-08-23)",
        "license": "MIT",
    }:
        fail("factory mise component is not the reviewed ARM64 release")

command_line = runtime.get("kernelCommandLine")
if not isinstance(command_line, str) or not command_line or any(character in command_line for character in "\x00\r\n\t"):
    fail("kernel command line is invalid")
if manifest_guest.get("kernelCommandLine") != command_line:
    fail("manifest and build spec command lines differ")
arguments = command_line.split(" ")
for required in ("root=/dev/vda", "rw", "rootwait", "console=tty0", "console=hvc0"):
    if arguments.count(required) != 1:
        fail(f"kernel command line must contain exactly one {required}")
if any(argument.startswith("omarchy.qemu_virgl=") for argument in arguments):
    fail("kernel command line already contains a QEMU VirGL role")
if spec_profile == "demo" and arguments.count("omarchy.web_demo=1") != 1:
    fail("demo kernel command line is missing its role")
if spec_profile == "factory" and any(argument.startswith("omarchy.web_demo=") for argument in arguments):
    fail("factory kernel command line contains a demo role")

records = manifest.get("artifacts")
if not isinstance(records, list) or len(records) != len(expected_artifacts):
    fail("artifact record count is invalid")
records_by_path: dict[str, dict[str, object]] = {}
for raw_record in records:
    record = exact_keys(raw_record, {"bytes", "mediaType", "path", "role", "sha256"}, "artifact record")
    path = record.get("path")
    if not isinstance(path, str) or path not in expected_artifacts or path in records_by_path:
        fail(f"artifact path is missing, duplicated, or unsafe: {path!r}")
    role, media_type = expected_artifacts[path]
    if record.get("role") != role or record.get("mediaType") != media_type:
        fail(f"artifact metadata is invalid for {path}")
    size = record.get("bytes")
    digest = record.get("sha256")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        fail(f"artifact size is invalid for {path}")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail(f"artifact digest is invalid for {path}")
    records_by_path[path] = record
if set(records_by_path) != set(expected_artifacts):
    fail("artifact records are incomplete")

calculated: dict[str, str] = {}
for name, record in records_by_path.items():
    path = guest / name
    if path.stat().st_size != record["bytes"]:
        fail(f"artifact size mismatch for {name}")
    calculated[name] = sha256(path)
    if calculated[name] != record["sha256"]:
        fail(f"artifact digest mismatch for {name}")
calculated["guest-manifest.json"] = hashlib.sha256(manifest_data).hexdigest()

try:
    checksum_lines = (guest / "SHA256SUMS").read_text(encoding="ascii").splitlines()
except (OSError, UnicodeError) as error:
    fail(f"cannot read SHA256SUMS: {error}")
checksum_names = set(expected_artifacts) | {"guest-manifest.json"}
checksums: dict[str, str] = {}
for line in checksum_lines:
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
    if not match or match.group(2) not in checksum_names or match.group(2) in checksums:
        fail("SHA256SUMS has an invalid, unsafe, or duplicate entry")
    checksums[match.group(2)] = match.group(1)
if set(checksums) != checksum_names:
    fail("SHA256SUMS is incomplete")
for name, digest in checksums.items():
    if calculated[name] != digest:
        fail(f"SHA256SUMS mismatch for {name}")

kernel = guest / "vmlinuz-linux"
with kernel.open("rb") as handle:
    handle.seek(56)
    if handle.read(4) != b"ARM\x64":
        fail("vmlinuz-linux is not an uncompressed ARM64 Image")
with (guest / "initramfs-linux.img").open("rb") as handle:
    if handle.read(6) not in {b"070701", b"070702"}:
        fail("initramfs-linux.img is not a mkinitcpio newc archive")
rootfs = guest / "rootfs.ext4"
if rootfs.stat().st_size != image["sizeMiB"] * 1024 * 1024:
    fail("rootfs.ext4 does not have the specified image size")
with rootfs.open("rb") as handle:
    handle.seek(1024 + 56)
    if handle.read(2) != b"\x53\xef":
        fail("rootfs.ext4 does not have an ext4 superblock")
with (guest / "rootfs.ext4.zst").open("rb") as handle:
    if handle.read(4) != b"\x28\xb5\x2f\xfd":
        fail("rootfs.ext4.zst is not a Zstandard frame")

rootfs_record = records_by_path["rootfs.ext4"]
expanded_size_mib = storage.get("expandedSizeMiB", image["sizeMiB"])
if not isinstance(expanded_size_mib, int) or isinstance(expanded_size_mib, bool) or expanded_size_mib < image["sizeMiB"]:
    fail("working-disk expansion size is invalid")
sys.stdout.write(
    "\t".join(
        (
            calculated["guest-manifest.json"],
            str(rootfs_record["sha256"]),
            str(rootfs_record["bytes"]),
            str(expanded_size_mib * 1024 * 1024),
            command_line,
        )
    )
)
PY
)
IFS=$'\t' read -r bundle_identity source_disk_sha source_disk_bytes expanded_disk_bytes kernel_command_line \
  <<<"$bundle_validation"
[[ $bundle_identity =~ ^[0-9a-f]{64}$ ]] || fail "validated bundle identity is invalid"
[[ $source_disk_sha =~ ^[0-9a-f]{64}$ ]] || fail "validated rootfs digest is invalid"
[[ $source_disk_bytes =~ ^[1-9][0-9]*$ ]] || fail "validated rootfs size is invalid"
[[ $expanded_disk_bytes =~ ^[1-9][0-9]*$ ]] || fail "validated working-disk size is invalid"
(( expanded_disk_bytes >= source_disk_bytes )) || fail "working disk cannot be smaller than its source"
[[ -n $kernel_command_line ]] || fail "validated kernel command line is empty"
if (( expanded_disk_bytes > source_disk_bytes )); then
  [[ $storage_mode == ephemeral ]] || fail "this guest requires --ephemeral working-disk expansion"
fi

host_cpu_count=$(
  sysctl -n hw.logicalcpu 2>/dev/null ||
    sysctl -n hw.ncpu 2>/dev/null ||
    getconf _NPROCESSORS_ONLN 2>/dev/null
) || {
  fail "cannot determine the host CPU count"
}
[[ $host_cpu_count =~ ^[0-9]+$ ]] || fail "host CPU count is invalid: $host_cpu_count"
vcpu_count=8
if (( host_cpu_count < vcpu_count )); then
  vcpu_count=$host_cpu_count
fi
(( vcpu_count >= 4 )) || fail "the ARM guest requires at least four host CPUs"

work_dir=""
owner_marker=""
owner_token=""
qemu_pid=""
bridge_pid=""
audio_bridge_pid=""

terminate_child() {
  local pid=$1
  local attempts=$2
  local attempt=0
  local state=""
  [[ $pid =~ ^[0-9]+$ ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for ((attempt = 0; attempt < attempts; attempt++)); do
    state=$(ps -p "$pid" -o state= 2>/dev/null || true)
    [[ -n $state && $state != *Z* ]] || break
    sleep 0.05
  done
  state=$(ps -p "$pid" -o state= 2>/dev/null || true)
  if [[ -n $state && $state != *Z* ]]; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ $qemu_pid =~ ^[0-9]+$ ]]; then
    terminate_child "$qemu_pid" 40
  fi
  if [[ $bridge_pid =~ ^[0-9]+$ ]]; then
    terminate_child "$bridge_pid" 20
  fi
  if [[ $audio_bridge_pid =~ ^[0-9]+$ ]]; then
    terminate_child "$audio_bridge_pid" 20
  fi
  qemu_persistent_storage_release_lock
  if [[ -n $work_dir && -n $owner_marker && -n $owner_token ]]; then
    case "$work_dir" in
      /private/tmp/omarchy-qemu-gpu.??????)
        if [[ -d $work_dir && ! -L $work_dir && -f $owner_marker && ! -L $owner_marker ]] &&
           [[ $(stat -f '%u' "$work_dir" 2>/dev/null) == $(id -u) ]] &&
           [[ $(<"$owner_marker") == "$owner_token" ]]; then
          /bin/rm -rf "$work_dir" || {
            echo "run-qemu-gpu: could not remove owned temporary directory $work_dir" >&2
          }
        else
          echo "run-qemu-gpu: refusing to remove unverified temporary directory $work_dir" >&2
        fi
        ;;
      *)
        echo "run-qemu-gpu: refusing to remove unexpected temporary path $work_dir" >&2
        ;;
    esac
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

reap_stale_work_dirs() {
  local candidate=""
  local marker=""
  local marker_value=""
  local launcher_pid=""
  local launcher_command=""
  local qemu_marker=""
  local stale_qemu_pid=""
  local qemu_command=""

  for candidate in /private/tmp/omarchy-qemu-gpu.??????; do
    [[ -d $candidate && ! -L $candidate ]] || continue
    [[ $(stat -f '%u' "$candidate" 2>/dev/null) == $(id -u) ]] || continue
    [[ $(stat -f '%Lp' "$candidate" 2>/dev/null) == 700 ]] || continue

    marker="$candidate/.run-qemu-gpu.owner"
    [[ -f $marker && ! -L $marker ]] || continue
    marker_value=$(<"$marker")
    [[ $marker_value =~ ^run-qemu-gpu:v1:([0-9]+):([0-9]+)$ ]] || continue

    launcher_pid=${BASH_REMATCH[1]}
    launcher_command=$(ps -p "$launcher_pid" -o command= 2>/dev/null || true)
    [[ $launcher_command != *"run-qemu-gpu.sh"* ]] || continue

    qemu_marker="$candidate/.qemu.pid"
    if [[ -f $qemu_marker && ! -L $qemu_marker ]]; then
      stale_qemu_pid=$(<"$qemu_marker")
      if [[ $stale_qemu_pid =~ ^[0-9]+$ ]]; then
        qemu_command=$(ps -p "$stale_qemu_pid" -o command= 2>/dev/null || true)
        if [[ $qemu_command == *"$qemu_bin"* &&
              $qemu_command == *"unix:/tmp/${candidate##*/}/qmp.sock"* ]]; then
          continue
        fi
      fi
    fi

    echo "[qemu-gpu] Removing a verified stale disposable run: $candidate" >&2
    /bin/rm -rf "$candidate"
  done
}

reap_stale_work_dirs

umask 077
work_dir=$(mktemp -d '/private/tmp/omarchy-qemu-gpu.XXXXXX') || {
  fail "could not create a private temporary directory"
}
case "$work_dir" in
  /private/tmp/omarchy-qemu-gpu.??????) ;;
  *) fail "mktemp returned an unexpected path: $work_dir" ;;
esac
[[ -d $work_dir && ! -L $work_dir ]] || fail "temporary directory is unsafe: $work_dir"
[[ $(stat -f '%u' "$work_dir") == $(id -u) ]] || fail "temporary directory is not owned by this user"
owner_marker="$work_dir/.run-qemu-gpu.owner"
owner_token="run-qemu-gpu:v1:$$:${RANDOM}${RANDOM}"
printf '%s\n' "$owner_token" >"$owner_marker"
chmod 600 "$owner_marker"

# Foundation's standardizedFileURL deliberately spells macOS's private
# temporary-directory alias as /tmp. Keep the owned directory's physical path
# for cleanup, but expose QMP through the standardized alias expected by the
# security-checking input bridge.
qmp_socket="/tmp/${work_dir##*/}/qmp.sock"
audio_bridge_socket="/tmp/${work_dir##*/}/audio.sock"
audio_route_dir="/tmp/${work_dir##*/}/audio-routes"
mkdir -m 700 "$work_dir/audio-routes"

source_disk="$guest_dir/rootfs.ext4"
qemu_persistent_storage_select \
  "$storage_mode" \
  "$bundle_identity" \
  "$source_disk" \
  "$source_disk_sha" \
  "$source_disk_bytes" \
  "$work_dir" || fail "could not prepare the selected root disk"
working_disk=$QEMU_SELECTED_DISK
if (( expanded_disk_bytes > source_disk_bytes )); then
  [[ $QEMU_SELECTED_STORAGE_MODE == ephemeral ]] || fail "only disposable disks may use runtime expansion"
  python3 - "$working_disk" "$source_disk_bytes" "$expanded_disk_bytes" <<'PY' ||
import os
import stat
import sys

path = sys.argv[1]
source_size = int(sys.argv[2])
expanded_size = int(sys.argv[3])
flags = os.O_WRONLY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
descriptor = os.open(path, flags)
try:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_size != source_size:
        raise SystemExit("disposable root disk changed before expansion")
    os.ftruncate(descriptor, expanded_size)
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    if after.st_size != expanded_size:
        raise SystemExit("disposable root disk has the wrong expanded size")
finally:
    os.close(descriptor)
PY
  {
    fail "could not safely expand the disposable root disk"
  }
  [[ $(stat -f '%z' "$working_disk") == "$expanded_disk_bytes" ]] || fail "expanded root disk has the wrong size"
  echo "[qemu-gpu] Expanded the disposable sparse disk to $((expanded_disk_bytes / 1024 / 1024)) MiB." >&2
fi

qemu_args=(
  -name 'Omarchy Quattro ARM64 - QEMU VirGL'
  # HVF exposes the ARM virtual GICv2 interface on current Apple Silicon.
  # Eight vCPUs is the architectural GICv2 limit and matches our host cap.
  -machine 'virt,accel=hvf,gic-version=2'
  # HVF does not provide a usable guest PMU on Apple Silicon. Do not advertise
  # one: Linux otherwise probes the dead device and prints a misleading failure.
  -cpu 'host,pmu=off'
  -smp "$vcpu_count,sockets=1,cores=$vcpu_count,threads=1"
  -m 4G
  -nodefaults
  -no-reboot
  -netdev 'user,id=omarchy-net'
  -device 'virtio-net-pci,netdev=omarchy-net,mac=52:54:00:12:34:56,romfile='
  -audiodev 'sdl,id=omarchy-audio'
  -device 'intel-hda,id=omarchy-hda,romfile='
  -device 'hda-micro,bus=omarchy-hda.0,audiodev=omarchy-audio'
  -serial none
  -monitor none
  -qmp "unix:$qmp_socket,server=on,wait=off"
  -kernel "$guest_dir/vmlinuz-linux"
  -initrd "$guest_dir/initramfs-linux.img"
  -append "$kernel_command_line omarchy.qemu_virgl=1"
  -drive "if=none,id=omarchy-root,file=$working_disk,format=raw,media=disk,cache=writeback"
  -device 'virtio-blk-pci,drive=omarchy-root,serial=omarchy-root'
  -device "$gpu_device"
  # Cocoa forwards its live backing-pixel dimensions and the current host
  # display refresh rate through Virtio GPU EDID. The companion bridge captures
  # Command only while this QEMU window owns focus and injects guest Super over
  # the private QMP socket; physical Option remains guest Alt.
  -display 'cocoa,gl=es,show-cursor=on,zoom-to-fit=on,full-screen=on'
  -device 'virtio-keyboard-pci,romfile='
  -device 'virtio-tablet-pci,romfile='
  -object 'rng-random,id=omarchy-rng,filename=/dev/urandom'
  -device 'virtio-rng-pci,rng=omarchy-rng'
  -device virtio-balloon-pci
  -device 'virtio-serial-pci,id=omarchy-serial'
  -chardev 'stdio,id=omarchy-hvc0,signal=off'
  -device 'virtconsole,bus=omarchy-serial.0,nr=0,chardev=omarchy-hvc0'
  -chardev "socket,id=omarchy-audio-bridge,path=$audio_bridge_socket,server=on,wait=off"
  -device 'virtserialport,bus=omarchy-serial.0,nr=1,chardev=omarchy-audio-bridge,name=dev.tryomarchy.audio'
)

# SDL2 has one legacy process-wide override that would collapse input and
# output onto the same named device. The patched QEMU backend uses the two
# direction-specific Omarchy variables instead; unset means live System Default.
unset SDL_AUDIO_DEVICE_NAME
export OMARCHY_SDL_AUDIO_CONTROL_DIRECTORY="$audio_route_dir"

if [[ $QEMU_SELECTED_STORAGE_MODE == persistent ]]; then
  qemu_args+=(
    -add-fd "$QEMU_PERSISTENT_STORAGE_QEMU_ADD_FD"
  )
fi

if [[ ${OMARCHY_QEMU_GPU_DRY_RUN:-0} == 1 ]]; then
  printf '[qemu-gpu] dry-run command:' >&2
  printf ' %q' "$qemu_bin" "${qemu_args[@]}" >&2
  printf '\n[qemu-gpu] bridge command: %q --bridge-command-super QEMU_PID %q' \
    "$input_bridge" "$qmp_socket" >&2
  printf '\n[qemu-gpu] audio bridge command: %q --bridge-native-audio QEMU_PID %q %q' \
    "$input_bridge" "$audio_bridge_socket" "$audio_route_dir" >&2
  printf '\n' >&2
  exit 0
fi
[[ ${OMARCHY_QEMU_GPU_DRY_RUN:-0} == 0 ]] || {
  fail "OMARCHY_QEMU_GPU_DRY_RUN must be 0 or 1"
}

if [[ $QEMU_SELECTED_STORAGE_MODE == persistent ]]; then
  echo "[qemu-gpu] Starting the persistent ARM64 VirGL guest with $vcpu_count vCPUs and 4 GiB RAM." >&2
  echo "[qemu-gpu] User data: $QEMU_PERSISTENT_STORAGE_DIRECTORY" >&2
else
  echo "[qemu-gpu] Starting a disposable ARM64 VirGL guest with $vcpu_count vCPUs and 4 GiB RAM." >&2
fi
"$qemu_bin" "${qemu_args[@]}" &
qemu_pid=$!
printf '%s\n' "$qemu_pid" >"$work_dir/.qemu.pid"
chmod 600 "$work_dir/.qemu.pid"

for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -S $qmp_socket && -S $audio_bridge_socket ]] && break
  kill -0 "$qemu_pid" 2>/dev/null || fail "QEMU exited before creating its private QMP socket"
  sleep 0.05
done
[[ -S $qmp_socket ]] || fail "QEMU did not create its private QMP socket"
[[ -S $audio_bridge_socket ]] || fail "QEMU did not create its private audio bridge socket"

# FD 9 deliberately remains open only in QEMU. Letting the sibling input
# bridge inherit it could keep a persistent workspace locked after QEMU exits.
"$input_bridge" --bridge-command-super "$qemu_pid" "$qmp_socket" 9>&- &
bridge_pid=$!
"$input_bridge" --bridge-native-audio \
  "$qemu_pid" "$audio_bridge_socket" "$audio_route_dir" 9>&- &
audio_bridge_pid=$!

# Bash 3.2 has no `wait -n`. Poll both children so a bridge failure at any
# point terminates QEMU instead of leaving an unmodified Command key behind.
while true; do
  qemu_state=$(ps -p "$qemu_pid" -o state= 2>/dev/null || true)
  [[ -n $qemu_state && $qemu_state != *Z* ]] || break

  bridge_state=$(ps -p "$bridge_pid" -o state= 2>/dev/null || true)
  if [[ -z $bridge_state || $bridge_state == *Z* ]]; then
    if wait "$bridge_pid"; then
      bridge_status=0
    else
      bridge_status=$?
    fi
    bridge_pid=""
    fail "focused Command-key bridge exited while QEMU was running (status $bridge_status)"
  fi

  audio_bridge_state=$(ps -p "$audio_bridge_pid" -o state= 2>/dev/null || true)
  if [[ -z $audio_bridge_state || $audio_bridge_state == *Z* ]]; then
    if wait "$audio_bridge_pid"; then
      audio_bridge_status=0
    else
      audio_bridge_status=$?
    fi
    audio_bridge_pid=""
    fail "native audio bridge exited while QEMU was running (status $audio_bridge_status)"
  fi
  sleep 0.1
done

if wait "$qemu_pid"; then
  qemu_status=0
else
  qemu_status=$?
fi
qemu_pid=""

for ((attempt = 0; attempt < 40; attempt++)); do
  bridge_state=$(ps -p "$bridge_pid" -o state= 2>/dev/null || true)
  [[ -n $bridge_state && $bridge_state != *Z* ]] || break
  sleep 0.05
done
bridge_state=$(ps -p "$bridge_pid" -o state= 2>/dev/null || true)
if [[ -n $bridge_state && $bridge_state != *Z* ]]; then
  terminate_child "$bridge_pid" 20
else
  wait "$bridge_pid" 2>/dev/null || true
fi
bridge_pid=""

for ((attempt = 0; attempt < 40; attempt++)); do
  audio_bridge_state=$(ps -p "$audio_bridge_pid" -o state= 2>/dev/null || true)
  [[ -n $audio_bridge_state && $audio_bridge_state != *Z* ]] || break
  sleep 0.05
done
audio_bridge_state=$(ps -p "$audio_bridge_pid" -o state= 2>/dev/null || true)
if [[ -n $audio_bridge_state && $audio_bridge_state != *Z* ]]; then
  terminate_child "$audio_bridge_pid" 20
else
  wait "$audio_bridge_pid" 2>/dev/null || true
fi
audio_bridge_pid=""
exit "$qemu_status"
