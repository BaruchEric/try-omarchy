#!/usr/bin/env bash
set -euo pipefail

proof_dir=/proof
qemu_bin=/proof/.build/qemu-8.2-native-virgl/qemu-system-x86_64
qemu_img=/proof/.build/qemu-8.2-native-virgl/qemu-img
firmware_dir=/proof/.build/qemu-8.2-source/pc-bios
qmp_client=/repo/proofs/preboot-resume/qmp.mjs
frame_health=/repo/proofs/preboot-resume/frame-health.mjs
frame_change=/repo/proofs/preboot-resume/frame-change.mjs
report_gate=/repo/proofs/preboot-resume/report-gate.mjs
browser_qemu_wasm=${BROWSER_QEMU_WASM_PATH:?BROWSER_QEMU_WASM_PATH is required}
browser_qemu_wasm_expected_sha256=${BROWSER_QEMU_WASM_EXPECTED_SHA256:?BROWSER_QEMU_WASM_EXPECTED_SHA256 is required}
prepare_initramfs=/proof/prepare-initramfs.sh
evidence_dir=${EVIDENCE_DIR:?EVIDENCE_DIR is required}
nonce=${HIBERNATION_NONCE:?HIBERNATION_NONCE is required}
source_timeout=${SOURCE_TIMEOUT_SECONDS:-1200}
target_timeout=${TARGET_TIMEOUT_SECONDS:-600}
desktop_timeout=${DESKTOP_TIMEOUT_SECONDS:-900}
swap_uuid=4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f
swap_virtual_bytes=1610612736
source_socket=/tmp/omarchy-virgl-hibernate-source-$$.sock
target_socket=/tmp/omarchy-virgl-hibernate-target-$$.sock
display_number=$((90 + ($$ % 900)))
xvfb_pid=
source_pid=
target_pid=
phase=preflight

expected_manifest_sha256=55aecd33a4e285f4caba5c565cde0831e8a556cb6160bb2dbf6173d915ff3d37
expected_rootfs_sha256=db677ce248761affd81967501fc21fd3687d2ca8c1644499268a5c3dc39e7cac
expected_kernel_sha256=1f2572d6d03706ed0f818ee17d77df021b7875f4e9fd119a1157f3a208aeed73
expected_initramfs_sha256=9a4239b35f2ad1fe6684c6c006f38a04489df640a08feae3fe56e5b91a6e17ed
expected_provenance_sha256=527c0e84e7594a44363cc7ff3ac2b5c871643a3eeb86ba104ed9be4040d0d738
expected_qemu_commit=0ef7b4e2814b231705d8371dd7997f5b72e70baf

set_phase() {
  phase=$1
  printf '%s\n' "$phase" >"$evidence_dir/phase.txt"
}

fail() {
  printf '%s\n' "$*" >"$evidence_dir/failure-reason.txt"
  printf 'VIRGL_HIBERNATE_CONTAINER_FAIL phase=%s reason=%s\n' "$phase" "$*" >&2
  exit 1
}

qmp_quit() {
  local socket=$1
  local log=$2
  [[ -S $socket ]] || return 0
  node "$qmp_client" "$socket" "$log" execute quit '{}' >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n ${target_pid:-} ]] && kill -0 "$target_pid" 2>/dev/null; then
    qmp_quit "$target_socket" "$evidence_dir/target-cleanup-qmp.jsonl"
    kill "$target_pid" 2>/dev/null || true
    wait "$target_pid" 2>/dev/null || true
  fi
  if [[ -n ${source_pid:-} ]] && kill -0 "$source_pid" 2>/dev/null; then
    qmp_quit "$source_socket" "$evidence_dir/source-cleanup-qmp.jsonl"
    kill "$source_pid" 2>/dev/null || true
    wait "$source_pid" 2>/dev/null || true
  fi
  if [[ -n ${xvfb_pid:-} ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  rm -f "$source_socket" "$target_socket"
  if [[ $phase != complete ]]; then
    printf '%s\n' "$phase" >"$evidence_dir/final-phase.txt"
    printf '%s\n' "$status" >"$evidence_dir/script-exit-status.txt"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_socket() {
  local socket=$1
  local pid=$2
  local label=$3
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    [[ -S $socket ]] && return 0
    kill -0 "$pid" 2>/dev/null || fail "$label exited before creating QMP"
    sleep 0.25
  done
  fail "$label did not create QMP within 60 seconds"
}

wait_for_exit() {
  local pid=$1
  local timeout=$2
  local label=$3
  local deadline=$((SECONDS + timeout))
  while kill -0 "$pid" 2>/dev/null; do
    (( SECONDS < deadline )) || fail "$label exceeded its ${timeout}-second bound"
    sleep 1
  done
}

wait_for_resume_marker() {
  local pid=$1
  local log=$2
  local deadline=$((SECONDS + target_timeout))
  while (( SECONDS < deadline )); do
    if grep -q '^OMARCHY_HIBERNATION_FAILURE ' "$log"; then
      fail "fresh target emitted a fail-closed hibernation marker"
    fi
    grep -q '^OMARCHY_HIBERNATION_REPORT ' "$log" && return 0
    kill -0 "$pid" 2>/dev/null || fail "fresh target exited before the resumed marker"
    sleep 1
  done
  fail "fresh target did not emit the resumed marker within ${target_timeout} seconds"
}

assert_no_uwsm_failure() {
  if grep -Eq '^OMARCHY_GUEST_STAGE .*"stage":"uwsm","status":"failed"' \
      "$evidence_dir/target-diagnostics.log"; then
    fail "resumed target emitted a UWSM failure stage"
  fi
}

capture_two_healthy_frames() {
  local prefix=$1
  local deadline=$((SECONDS + 360))
  local streak=0
  local candidate="$prefix-candidate.ppm"
  local candidate_health="$prefix-candidate-health.json"
  while (( SECONDS < deadline )); do
    assert_no_uwsm_failure
    node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
      screendump "$candidate" >/dev/null
    if node "$frame_health" "$candidate" >"$candidate_health"; then
      streak=$((streak + 1))
      mv "$candidate" "$prefix-$streak.ppm"
      mv "$candidate_health" "$prefix-$streak-health.json"
      (( streak == 2 )) && return 0
    else
      streak=0
      mv "$candidate" "$prefix-rejected-latest.ppm"
      mv "$candidate_health" "$prefix-rejected-latest-health.json"
    fi
    sleep 5
  done
  fail "resumed target did not produce two healthy 1600x900 Omarchy frames"
}

wait_for_foot_frame() {
  local baseline=$1
  local output=$2
  local deadline=$((SECONDS + 180))
  local candidate="$output.candidate"
  local health_output="${output%.ppm}-health.json"
  local candidate_health="$health_output.candidate"
  local change_output="$evidence_dir/resumed-foot-change.json"
  local candidate_change="$change_output.candidate"
  while (( SECONDS < deadline )); do
    assert_no_uwsm_failure
    node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
      screendump "$candidate" >/dev/null
    if node "$frame_health" "$candidate" >"$candidate_health" \
      && node "$frame_change" "$baseline" "$candidate" minimum 0.0005 >"$candidate_change"; then
      mv "$candidate" "$output"
      mv "$candidate_health" "$health_output"
      mv "$candidate_change" "$change_output"
      return 0
    fi
    sleep 5
  done
  fail "resumed Super+Return did not visibly open Foot"
}

for numeric in "$source_timeout" "$target_timeout" "$desktop_timeout"; do
  [[ $numeric =~ ^[1-9][0-9]*$ ]] || fail "timeouts must be positive integers"
done
[[ $nonce =~ ^[0-9a-f]{64}$ ]] || fail "invalid nonce"
for executable in "$qemu_bin" "$qemu_img" "$prepare_initramfs"; do
  [[ -x $executable ]] || fail "required executable is missing: $executable"
done
[[ -f $browser_qemu_wasm ]] || fail "browser QEMU Wasm is missing: $browser_qemu_wasm"
[[ $browser_qemu_wasm_expected_sha256 =~ ^[0-9a-f]{64}$ ]] \
  || fail "browser QEMU Wasm expected SHA-256 is invalid"
[[ $(sha256sum "$browser_qemu_wasm" | awk '{print $1}') == "$browser_qemu_wasm_expected_sha256" ]] \
  || fail "mounted browser QEMU Wasm differs from the validated VirGL/bounded-CLOCK candidate"
for tool in Xvfb node sha256sum zstd cpio; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
done
[[ -d $firmware_dir ]] || fail "pinned QEMU firmware is unavailable"
mkdir -p "$evidence_dir"
set_phase preflight
: >"$evidence_dir/source-diagnostics.log"
: >"$evidence_dir/target-diagnostics.log"
: >"$evidence_dir/source-qemu.log"
: >"$evidence_dir/target-qemu.log"
: >"$evidence_dir/source-qmp.jsonl"
: >"$evidence_dir/target-qmp.jsonl"

[[ $(sha256sum /guest/guest-manifest.json | awk '{print $1}') == "$expected_manifest_sha256" ]] \
  || fail "canonical guest manifest identity differs"
[[ $(sha256sum /guest/rootfs.ext4 | awk '{print $1}') == "$expected_rootfs_sha256" ]] \
  || fail "canonical rootfs identity differs"
[[ $(sha256sum /guest/vmlinuz-linux | awk '{print $1}') == "$expected_kernel_sha256" ]] \
  || fail "canonical kernel identity differs"
[[ $(sha256sum /guest/initramfs-linux.img | awk '{print $1}') == "$expected_initramfs_sha256" ]] \
  || fail "canonical initramfs identity differs"
[[ $(sha256sum /guest/provenance.json | awk '{print $1}') == "$expected_provenance_sha256" ]] \
  || fail "canonical provenance identity differs"
[[ $(</proof/.build/qemu-8.2-native-virgl/source-commit.txt) == "$expected_qemu_commit" ]] \
  || fail "native QEMU source commit differs"
[[ $($qemu_bin --version | sed -n '1p') == 'QEMU emulator version 8.2.0' ]] \
  || fail "native producer is not QEMU 8.2.0"
node /repo/proofs/preboot-resume/artifact-integrity.mjs /guest \
  >"$evidence_dir/artifact-integrity-before.json"

"$prepare_initramfs" /guest/initramfs-linux.img "$evidence_dir/initramfs-virgl-hibernate.img" \
  >"$evidence_dir/initramfs-preparation.log"
ln -s /guest/rootfs.ext4 "$evidence_dir/rootfs.ext4"
(
  cd "$evidence_dir"
  "$qemu_img" create -q -f qcow2 -F raw -b rootfs.ext4 hibernate-root-overlay.qcow2
  "$qemu_img" create -q -f qcow2 -o cluster_size=65536 omarchy-hibernate.qcow2 1536M
)

Xvfb ":$display_number" -screen 0 1600x900x24 +extension GLX +render -noreset \
  >"$evidence_dir/xvfb.log" 2>&1 &
xvfb_pid=$!
export DISPLAY=":$display_number"
for _attempt in $(seq 1 120); do
  [[ -S "/tmp/.X11-unix/X$display_number" ]] && break
  kill -0 "$xvfb_pid" 2>/dev/null || fail "Xvfb exited before its display was ready"
  sleep 0.25
done
[[ -S "/tmp/.X11-unix/X$display_number" ]] || fail "Xvfb display was not ready"

base_kernel_command_line="root=/dev/vda rw rootwait console=tty0 console=ttyS0,115200n8 loglevel=4 ignore_loglevel hibernate.compressor=lzo systemd.show_status=false rd.systemd.show_status=false mitigations=off nowatchdog omarchy.web_demo=1 resume=UUID=$swap_uuid omarchy.hibernate_swap_uuid=$swap_uuid"
source_kernel_command_line="$base_kernel_command_line omarchy.hibernate_producer=1 omarchy.hibernate_nonce=$nonce"
target_kernel_command_line="$base_kernel_command_line omarchy.hibernate_target=1"

common_args=(
  -L "$firmware_dir"
  -machine pc-q35-8.2
  -cpu qemu64
  -m 1024M
  -accel tcg,tb-size=128,thread=multi
  -smp 2,sockets=1,cores=2,threads=1
  -display sdl,gl=on,show-cursor=on
  -device virtio-vga-gl,max_outputs=1,xres=1600,yres=900
  -device virtio-keyboard-pci
  -device virtio-tablet-pci
  -kernel /guest/vmlinuz-linux
  -initrd "$evidence_dir/initramfs-virgl-hibernate.img"
  -device virtio-serial-pci
  -monitor none
  -parallel none
  -nic none
  -no-reboot
)

source_args=(
  "${common_args[@]}"
  -append "$source_kernel_command_line"
  -chardev "file,id=omarchy-diag,path=$evidence_dir/source-diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$source_socket,server=on,wait=off"
  -drive "if=none,id=omarchy-hibernate-root,file=$evidence_dir/hibernate-root-overlay.qcow2,format=qcow2,cache=unsafe"
  -device virtio-blk-pci,drive=omarchy-hibernate-root,serial=omarchy-root
  -drive "if=none,id=omarchy-hibernate-swap,file=$evidence_dir/omarchy-hibernate.qcow2,format=qcow2,cache=unsafe"
  -device virtio-blk-pci,drive=omarchy-hibernate-swap,serial=omarchy-resume
)
printf '%q ' "$qemu_bin" "${source_args[@]}" >"$evidence_dir/source-command.txt"
printf '\n' >>"$evidence_dir/source-command.txt"

set_phase source-hibernate
source_started_ms=$(date +%s%3N)
"$qemu_bin" "${source_args[@]}" >>"$evidence_dir/source-qemu.log" 2>&1 &
source_pid=$!
wait_for_socket "$source_socket" "$source_pid" "source QEMU"
wait_for_exit "$source_pid" "$source_timeout" "source hibernation"
set +e
wait "$source_pid"
source_exit=$?
set -e
source_pid=
source_finished_ms=$(date +%s%3N)
[[ $source_exit -eq 0 ]] || fail "source QEMU exited with $source_exit"
[[ $(grep -c '^OMARCHY_HIBERNATION_ENTER ' "$evidence_dir/source-diagnostics.log") -eq 1 ]] \
  || fail "source did not emit exactly one hibernation-entry marker"
! grep -q '^OMARCHY_HIBERNATION_FAILURE ' "$evidence_dir/source-diagnostics.log" \
  || fail "source emitted a hibernation failure marker"
grep -Fq 'PM: hibernation: hibernation entry' "$evidence_dir/source-diagnostics.log" \
  || fail "source kernel did not enter hibernation"
grep -Fq 'PM: Image saving done' "$evidence_dir/source-diagnostics.log" \
  || fail "source kernel did not finish saving the image"

set_phase frozen-artifacts
"$qemu_img" check -q "$evidence_dir/hibernate-root-overlay.qcow2" \
  || fail "root delta failed qemu-img check"
"$qemu_img" check -q "$evidence_dir/omarchy-hibernate.qcow2" \
  || fail "swap image failed qemu-img check"
"$qemu_img" info --output=json "$evidence_dir/hibernate-root-overlay.qcow2" \
  >"$evidence_dir/hibernate-root-overlay-info.json"
"$qemu_img" info --output=json "$evidence_dir/omarchy-hibernate.qcow2" \
  >"$evidence_dir/omarchy-hibernate-info.json"
root_delta_bytes=$(stat -c %s "$evidence_dir/hibernate-root-overlay.qcow2")
swap_image_bytes=$(stat -c %s "$evidence_dir/omarchy-hibernate.qcow2")
derived_initramfs_bytes=$(stat -c %s "$evidence_dir/initramfs-virgl-hibernate.img")
(( root_delta_bytes <= 268435456 )) || fail "root delta exceeds the 256 MiB proof cap"
(( swap_image_bytes <= 1073741824 )) || fail "swap image exceeds the 1 GiB proof cap"
(( derived_initramfs_bytes <= 67108864 )) || fail "derived initramfs exceeds the 64 MiB proof cap"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.format !== "qcow2" || value["virtual-size"] !== 1610612736 || value["backing-filename"] !== undefined) process.exit(1);
' "$evidence_dir/omarchy-hibernate-info.json" || fail "swap qcow2 geometry/backing is invalid"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.format !== "qcow2" || value["virtual-size"] !== 6442450944 || value["backing-filename"] !== "rootfs.ext4" || value["backing-filename-format"] !== "raw") process.exit(1);
' "$evidence_dir/hibernate-root-overlay-info.json" || fail "root delta backing contract is invalid"
sha256sum \
  "$evidence_dir/hibernate-root-overlay.qcow2" \
  "$evidence_dir/omarchy-hibernate.qcow2" \
  "$evidence_dir/initramfs-virgl-hibernate.img" \
  >"$evidence_dir/hibernation-artifacts-before-target.sha256"

target_args=(
  "${common_args[@]}"
  -append "$target_kernel_command_line"
  -chardev "file,id=omarchy-diag,path=$evidence_dir/target-diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$target_socket,server=on,wait=off"
  -snapshot
  -drive "if=none,id=omarchy-hibernate-root,file=$evidence_dir/hibernate-root-overlay.qcow2,format=qcow2,cache=unsafe"
  -device virtio-blk-pci,drive=omarchy-hibernate-root,serial=omarchy-root
  -drive "if=none,id=omarchy-hibernate-swap,file=$evidence_dir/omarchy-hibernate.qcow2,format=qcow2,cache=unsafe"
  -device virtio-blk-pci,drive=omarchy-hibernate-swap,serial=omarchy-resume
)
printf '%q ' "$qemu_bin" "${target_args[@]}" >"$evidence_dir/target-command.txt"
printf '\n' >>"$evidence_dir/target-command.txt"

set_phase fresh-target-resume
target_started_ms=$(date +%s%3N)
"$qemu_bin" "${target_args[@]}" >>"$evidence_dir/target-qemu.log" 2>&1 &
target_pid=$!
wait_for_socket "$target_socket" "$target_pid" "fresh target QEMU"
wait_for_resume_marker "$target_pid" "$evidence_dir/target-diagnostics.log"
target_resumed_ms=$(date +%s%3N)
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  execute query-status '{}' >"$evidence_dir/target-running-status.json"

grep -Fq 'PM: Image signature found, resuming' "$evidence_dir/target-diagnostics.log" \
  || fail "target kernel did not find the hibernation signature"
grep -Fq 'PM: Image loading done' "$evidence_dir/target-diagnostics.log" \
  || fail "target kernel did not finish loading the image"
grep -Fq 'PM: hibernation: Hibernation image restored successfully.' "$evidence_dir/target-diagnostics.log" \
  || fail "target kernel did not authenticate a successful restore"
[[ $(grep -c '^OMARCHY_HIBERNATION_REPORT ' "$evidence_dir/target-diagnostics.log") -eq 1 ]] \
  || fail "target did not emit exactly one resumed marker"
! grep -q '^OMARCHY_HIBERNATION_FAILURE ' "$evidence_dir/target-diagnostics.log" \
  || fail "target emitted a fail-closed marker"
! grep -q '^OMARCHY_HIBERNATION_COLD_BOOT ' "$evidence_dir/target-diagnostics.log" \
  || fail "target emitted a cold-fallback marker"
[[ $(grep -c '^OMARCHY_RENDERER_REPORT ' "$evidence_dir/target-diagnostics.log") -eq 1 ]] \
  || fail "target did not emit exactly one renderer report"
node - "$evidence_dir/target-diagnostics.log" "$evidence_dir/renderer-probe.json" <<'EOF'
const fs = require("fs");
const [input, output] = process.argv.slice(2);
const prefix = "OMARCHY_RENDERER_REPORT ";
const lines = fs.readFileSync(input, "utf8").split(/\r?\n/).filter((line) => line.startsWith(prefix));
if (lines.length !== 1) throw new Error("renderer report is not unique");
const report = JSON.parse(lines[0].slice(prefix.length));
if (report.schemaVersion !== 1 || report.renderNode !== "/dev/dri/renderD128" ||
    typeof report.renderer !== "string" || !/virgl/i.test(report.renderer)) {
  throw new Error(`fresh renderer identity is invalid: ${JSON.stringify(report)}`);
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
EOF

set_phase resumed-authentic-report
report_deadline=$((SECONDS + desktop_timeout))
while (( SECONDS < report_deadline )); do
  assert_no_uwsm_failure
  grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/target-diagnostics.log" && break
  kill -0 "$target_pid" 2>/dev/null || fail "resumed target exited before its authentic guest report"
  sleep 1
done
grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/target-diagnostics.log" \
  || fail "resumed target did not emit an authentic guest report within ${desktop_timeout} seconds"
node "$report_gate" "$evidence_dir/target-diagnostics.log" /guest/guest-manifest.json \
  >"$evidence_dir/target-report-validation.json" \
  || fail "resumed target guest report failed authenticity/monitor verification"

set_phase resumed-healthy-frames
capture_two_healthy_frames "$evidence_dir/resumed-desktop"

set_phase resumed-foot-input
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  release-modifiers >"$evidence_dir/target-release-modifiers.json"
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  super-return >"$evidence_dir/target-super-return.json"
wait_for_foot_frame \
  "$evidence_dir/resumed-desktop-2.ppm" \
  "$evidence_dir/resumed-foot.ppm"
target_accepted_ms=$(date +%s%3N)

node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" execute quit '{}' >/dev/null
set +e
wait "$target_pid"
target_exit=$?
set -e
target_pid=
[[ $target_exit -eq 0 ]] || fail "fresh target QEMU exited with $target_exit"
if [[ -n ${xvfb_pid:-} ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
fi
xvfb_pid=

sha256sum \
  "$evidence_dir/hibernate-root-overlay.qcow2" \
  "$evidence_dir/omarchy-hibernate.qcow2" \
  "$evidence_dir/initramfs-virgl-hibernate.img" \
  >"$evidence_dir/hibernation-artifacts-after-target.sha256"
cmp -s \
  "$evidence_dir/hibernation-artifacts-before-target.sha256" \
  "$evidence_dir/hibernation-artifacts-after-target.sha256" \
  || fail "immutable hibernation artifacts changed under target -snapshot"
node /repo/proofs/preboot-resume/artifact-integrity.mjs /guest \
  >"$evidence_dir/artifact-integrity-after.json"

set_phase manifest
qemu_version=$($qemu_bin --version | sed -n '1p')
qemu_sha256=$(sha256sum "$qemu_bin" | awk '{print $1}')
browser_qemu_wasm_sha256=$(sha256sum "$browser_qemu_wasm" | awk '{print $1}')
root_delta_sha256=$(sha256sum "$evidence_dir/hibernate-root-overlay.qcow2" | awk '{print $1}')
swap_image_sha256=$(sha256sum "$evidence_dir/omarchy-hibernate.qcow2" | awk '{print $1}')
derived_initramfs_sha256=$(sha256sum "$evidence_dir/initramfs-virgl-hibernate.img" | awk '{print $1}')
nonce_sha256=$(printf '%s' "$nonce" | sha256sum | awk '{print $1}')
source_diagnostics_sha256=$(sha256sum "$evidence_dir/source-diagnostics.log" | awk '{print $1}')

node - \
  "$evidence_dir" \
  "$nonce" \
  "$qemu_sha256" \
  "$browser_qemu_wasm_sha256" \
  "$root_delta_sha256" \
  "$swap_image_sha256" \
  "$derived_initramfs_sha256" \
  "$base_kernel_command_line" \
  "$source_kernel_command_line" \
  "$target_kernel_command_line" <<'EOF'
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const [
  directory,
  nonce,
  qemuSha256,
  browserQemuWasmSha256,
  rootDeltaSha256,
  swapImageSha256,
  derivedInitramfsSha256,
  kernelCommandLineBase,
  sourceKernelCommandLine,
  targetKernelCommandLine,
] = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(directory, name), "utf8");
const bytes = (name) => fs.statSync(path.join(directory, name)).size;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileSha256 = (name) => sha256(fs.readFileSync(path.join(directory, name)));
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};
const normalizedJsonBytes = (value) => Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
const marker = (prefix, log) => {
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`${prefix} must occur exactly once`);
  return JSON.parse(lines[0].slice(prefix.length));
};
const sourceDiagnostics = read("source-diagnostics.log");
const targetDiagnostics = read("target-diagnostics.log");
const enter = marker("OMARCHY_HIBERNATION_ENTER ", sourceDiagnostics);
const hibernationReport = marker("OMARCHY_HIBERNATION_REPORT ", targetDiagnostics);
const rendererReport = marker("OMARCHY_RENDERER_REPORT ", targetDiagnostics);
const guestReport = marker("OMARCHY_GUEST_REPORT ", targetDiagnostics);
if (enter.nonce !== nonce || hibernationReport.nonce !== nonce ||
    enter.sourceBootId !== hibernationReport.sourceBootId) {
  throw new Error("source/target hibernation identity differs");
}
if (!/virgl/i.test(rendererReport.renderer) || hibernationReport.renderer !== "virgl") {
  throw new Error("fresh target did not authenticate a VirGL renderer");
}
const requiredKernelEvidence = [
  "PM: Image signature found, resuming",
  "PM: Image loading done",
  "PM: hibernation: Hibernation image restored successfully.",
];
let previousKernelIndex = -1;
for (const line of requiredKernelEvidence) {
  const index = targetDiagnostics.indexOf(line);
  if (index <= previousKernelIndex) throw new Error(`kernel evidence is missing or out of order: ${line}`);
  previousKernelIndex = index;
}
const hibernationMarkerIndex = targetDiagnostics.indexOf("OMARCHY_HIBERNATION_REPORT ");
const guestReportIndex = targetDiagnostics.indexOf("OMARCHY_GUEST_REPORT ");
if (hibernationMarkerIndex < 0 || guestReportIndex <= hibernationMarkerIndex) {
  throw new Error("live guest report did not follow the authenticated hibernation marker");
}
const sourceEvidence = {
  diagnosticsSha256: fileSha256("source-diagnostics.log"),
  hibernationEntryMarkerSha256: sha256(normalizedJsonBytes(enter)),
  nonceSha256: sha256(nonce),
  sourceBootId: enter.sourceBootId,
  gpuBoundAtHibernate: enter.gpuBoundAtHibernate,
};
const blockDevices = [
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
];
const machineCommon = {
  type: "pc-q35-8.2",
  cpu: "qemu64",
  memoryMiB: 1024,
  smp: "2,sockets=1,cores=2,threads=1",
  accel: "tcg,tb-size=128,thread=multi",
  displayDevice: "virtio-vga-gl,max_outputs=1,xres=1600,yres=900",
  blockDevices,
};
const manifest = {
  schemaVersion: 1,
  kind: "omarchy-web-guest-hibernation",
  identity: {
    baseGuestManifestSha256: "55aecd33a4e285f4caba5c565cde0831e8a556cb6160bb2dbf6173d915ff3d37",
    rootfsSha256: "db677ce248761affd81967501fc21fd3687d2ca8c1644499268a5c3dc39e7cac",
    kernelSha256: "1f2572d6d03706ed0f818ee17d77df021b7875f4e9fd119a1157f3a208aeed73",
    baseInitramfsSha256: "9a4239b35f2ad1fe6684c6c006f38a04489df640a08feae3fe56e5b91a6e17ed",
    derivedInitramfsSha256,
    guestProvenanceSha256: "527c0e84e7594a44363cc7ff3ac2b5c871643a3eeb86ba104ed9be4040d0d738",
    browserQemuWasmSha256,
  },
  qemu: {
    repository: "https://github.com/ktock/qemu-wasm.git",
    version: "8.2.0",
    sourceCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
  },
  producer: {
    qemuBinarySha256: qemuSha256,
  },
  producerMachine: {
    ...machineCommon,
    display: "sdl,gl=on,show-cursor=on",
  },
  runtimeMachine: {
    ...machineCommon,
    display: "sdl,gl=es,show-cursor=on",
  },
  rootDelta: {
    path: "hibernate-root-overlay.qcow2",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw",
    bytes: bytes("hibernate-root-overlay.qcow2"),
    sha256: rootDeltaSha256,
  },
  swapImage: {
    path: "omarchy-hibernate.qcow2",
    format: "qcow2",
    virtualBytes: 1610612736,
    swapUuid: "4c9a13d2-7c3a-4f2c-b6e1-5a3048610e8f",
    bytes: bytes("omarchy-hibernate.qcow2"),
    sha256: swapImageSha256,
  },
  derivedInitramfs: {
    artifactPath: "initramfs-virgl-hibernate.img",
    format: "linux-initramfs",
    baseArtifactPath: "initramfs-linux.img",
    bytes: bytes("initramfs-virgl-hibernate.img"),
    sha256: derivedInitramfsSha256,
  },
  sourceEvidence,
  resumeEvidence: {
    diagnosticsSha256: fileSha256("target-diagnostics.log"),
    hibernationMarkerSha256: sha256(normalizedJsonBytes(hibernationReport)),
    rendererProbeSha256: sha256(normalizedJsonBytes(rendererReport)),
    renderer: rendererReport.renderer,
    normalizedGuestReportSha256: sha256(normalizedJsonBytes(guestReport)),
    reportValidationSha256: fileSha256("target-report-validation.json"),
    desktopFrame1Sha256: fileSha256("resumed-desktop-1.ppm"),
    desktopFrame1HealthSha256: fileSha256("resumed-desktop-1-health.json"),
    desktopFrame2Sha256: fileSha256("resumed-desktop-2.ppm"),
    desktopFrame2HealthSha256: fileSha256("resumed-desktop-2-health.json"),
    footFrameSha256: fileSha256("resumed-foot.ppm"),
    footFrameHealthSha256: fileSha256("resumed-foot-health.json"),
    footChangeSha256: fileSha256("resumed-foot-change.json"),
    freshPostResumeInteraction: true,
  },
  restoreContract: {
    coldBootFallbackAllowed: false,
    disposableWrites: "target -snapshot layers over immutable root delta and hibernation image",
    gpuBoundAtHibernate: false,
    kernelCommandLineBase,
    resumeNonceSha256: sha256(nonce),
    sourceBootId: enter.sourceBootId,
    sourceEvidenceSha256: sha256(normalizedJsonBytes(sourceEvidence)),
    sourceKernelCommandLineRedacted:
      `${kernelCommandLineBase} omarchy.hibernate_producer=1 omarchy.hibernate_nonce=<redacted>`,
    sourceKernelCommandLineSha256: sha256(Buffer.from(sourceKernelCommandLine, "utf8")),
    targetKernelCommandLine,
    runtimeDisplay: "sdl,gl=es,show-cursor=on",
    virtioGpuLoadedAfterResume: hibernationReport.gpuDriver === "virtio_gpu",
  },
};
fs.writeFileSync(path.join(directory, "hibernate-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
EOF

node - "$evidence_dir/run.json" "$evidence_dir/hibernate-manifest.json" <<EOF
const fs = require("fs");
const [output, manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 1,
  status: "completed",
  mode: "guest-hibernation-resume",
  qemuVersion: ${qemu_version@Q},
  qemuSourceCommit: "$expected_qemu_commit",
  qemuSha256: "$qemu_sha256",
  browserQemuWasmSha256: "$browser_qemu_wasm_sha256",
  sourceExitCode: $source_exit,
  targetExitCode: $target_exit,
  sourceExitedBeforeTargetLaunch: true,
  sourceHibernateMilliseconds: $((source_finished_ms - source_started_ms)),
  targetResumeMilliseconds: $((target_resumed_ms - target_started_ms)),
  targetAcceptanceMilliseconds: $((target_accepted_ms - target_started_ms)),
  rootDeltaBytes: $root_delta_bytes,
  rootDeltaSha256: "$root_delta_sha256",
  swapImageBytes: $swap_image_bytes,
  swapImageVirtualBytes: $swap_virtual_bytes,
  swapImageSha256: "$swap_image_sha256",
  derivedInitramfsBytes: $derived_initramfs_bytes,
  derivedInitramfsSha256: "$derived_initramfs_sha256",
  nonceSha256: "$nonce_sha256",
  sourceDiagnosticsSha256: "$source_diagnostics_sha256",
  sourceEvidenceSha256: manifest.restoreContract.sourceEvidenceSha256,
  nativeMechanismProof: true,
  browserAcceptance: false,
  desktopAcceptance: true,
  freshVirglContext: true,
  authenticGuestReport: true,
  twoHealthyFrames: true,
  footInputProof: true
}, null, 2) + "\n");
EOF

set_phase validation
VIRGL_HIBERNATE_SKIP_EVIDENCE_INDEX=1 \
  node /proof/validate.mjs /guest "$evidence_dir" "$browser_qemu_wasm" \
  >"$evidence_dir/container-validation.json"
set_phase complete
(
  cd "$evidence_dir"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum >SHA256SUMS
)
final_validation=/tmp/omarchy-virgl-hibernate-final-validation-$$.json
node /proof/validate.mjs /guest "$evidence_dir" "$browser_qemu_wasm" >"$final_validation"
cmp -s "$evidence_dir/container-validation.json" "$final_validation" \
  || fail "final indexed validation is not deterministic"
rm -f "$final_validation"
printf 'VIRGL_HIBERNATE_CONTAINER_PASS evidence=%s\n' "$evidence_dir"
