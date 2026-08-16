#!/usr/bin/env bash
set -euo pipefail

qemu_bin=/proof/.build/qemu-8.2-native/qemu-system-x86_64
qemu_img=/proof/.build/qemu-8.2-native/qemu-img
firmware_dir=/proof/.build/qemu-8.2-source/pc-bios
qmp_client=/proof/qmp.mjs
frame_health=/proof/frame-health.mjs
frame_change=/proof/frame-change.mjs
report_gate=/proof/report-gate.mjs
evidence_dir=${EVIDENCE_DIR:?EVIDENCE_DIR is required}
timeout_seconds=${PREBOOT_TIMEOUT_SECONDS:-900}
source_socket=/tmp/omarchy-preboot-source-$$.sock
target_socket=/tmp/omarchy-preboot-target-$$.sock
source_pid=
target_pid=
phase=preflight

expected_manifest_sha256=d5f6e2eebd8ce80abf355d8d6f67d52c978c603cc253466e29fb064eab792c28
expected_rootfs_sha256=ff89f566d58841bcb8fdb9c8b486d162dbafa2223a38a150c11337f52de52d33
expected_provenance_sha256=527c0e84e7594a44363cc7ff3ac2b5c871643a3eeb86ba104ed9be4040d0d738
expected_qemu_commit=0ef7b4e2814b231705d8371dd7997f5b72e70baf

set_phase() {
  phase=$1
  printf '%s\n' "$phase" >"$evidence_dir/phase.txt"
}

fail() {
  printf '%s\n' "$*" >"$evidence_dir/failure-reason.txt"
  printf 'PREBOOT_CONTAINER_FAIL phase=%s reason=%s\n' "$phase" "$*" >&2
  exit 1
}

assert_no_uwsm_failure() {
  if grep -Eq '^OMARCHY_GUEST_STAGE .*"stage":"uwsm","status":"failed"' "$evidence_dir/source-diagnostics.log"; then
    fail "guest emitted a UWSM failure stage"
  fi
}

capture_two_healthy_frames() {
  local socket=$1
  local qmp_log=$2
  local prefix=$3
  local label=$4
  local timeout=$5
  local candidate="$prefix-candidate.ppm"
  local candidate_health="$prefix-candidate-health.json"
  local streak=0
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    [[ $socket == "$source_socket" ]] && assert_no_uwsm_failure
    node "$qmp_client" "$socket" "$qmp_log" screendump "$candidate" >/dev/null
    if node "$frame_health" "$candidate" >"$candidate_health"; then
      streak=$((streak + 1))
      mv "$candidate" "$prefix-$streak.ppm"
      mv "$candidate_health" "$prefix-$streak-health.json"
      if (( streak == 2 )); then
        return 0
      fi
    else
      streak=0
      mv "$candidate" "$prefix-rejected-latest.ppm"
      mv "$candidate_health" "$prefix-rejected-latest-health.json"
    fi
    sleep 5
  done
  fail "$label did not produce two consecutive healthy 1600x900 Omarchy shell frames"
}

wait_for_frame_change() {
  local socket=$1
  local qmp_log=$2
  local baseline=$3
  local output=$4
  local change_output=$5
  local mode=$6
  local threshold=$7
  local label=$8
  local timeout=$9
  local candidate="$output.candidate"
  local candidate_change="$change_output.candidate"
  local health_output="${output%.ppm}-health.json"
  local candidate_health="$health_output.candidate"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    [[ $socket == "$source_socket" ]] && assert_no_uwsm_failure
    node "$qmp_client" "$socket" "$qmp_log" screendump "$candidate" >/dev/null
    if node "$frame_health" "$candidate" >"$candidate_health" \
      && node "$frame_change" "$baseline" "$candidate" "$mode" "$threshold" >"$candidate_change"; then
      mv "$candidate" "$output"
      mv "$candidate_health" "$health_output"
      mv "$candidate_change" "$change_output"
      return 0
    fi
    sleep 5
  done
  fail "$label did not satisfy healthy-frame $mode change threshold $threshold"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for tuple in "${target_pid:-}:$target_socket:$evidence_dir/qmp-cleanup-target.jsonl" \
               "${source_pid:-}:$source_socket:$evidence_dir/qmp-cleanup-source.jsonl"; do
    IFS=: read -r pid socket cleanup_log <<<"$tuple"
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      if [[ -S $socket ]]; then
        node "$qmp_client" "$socket" "$cleanup_log" execute quit '{}' >/dev/null 2>&1 || true
      fi
      for _attempt in $(seq 1 40); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$source_socket" "$target_socket"
  printf '%s\n' "$phase" >"$evidence_dir/final-phase.txt"
  printf '%s\n' "$status" >"$evidence_dir/script-exit-status.txt"
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null 2>&1 || fail "node is unavailable in the pinned builder"
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || fail "timeout must be a positive integer"
[[ -x $qemu_bin ]] || fail "pinned QEMU binary is unavailable"
[[ -x $qemu_img ]] || fail "pinned qemu-img is unavailable"
[[ -d $firmware_dir ]] || fail "pinned QEMU firmware is unavailable"
[[ $(</proof/.build/qemu-8.2-native/source-commit.txt) == "$expected_qemu_commit" ]] || fail "native producer source commit differs"
mkdir -p "$evidence_dir"
set_phase preflight
: >"$evidence_dir/source-qmp.jsonl"
: >"$evidence_dir/target-qmp.jsonl"
: >"$evidence_dir/source-diagnostics.log"
: >"$evidence_dir/target-diagnostics.log"
: >"$evidence_dir/source-qemu.log"
: >"$evidence_dir/target-qemu.log"

[[ $(sha256sum /guest/guest-manifest.json | awk '{print $1}') == "$expected_manifest_sha256" ]] || fail "canonical guest manifest SHA-256 differs"
[[ $(sha256sum /guest/rootfs.ext4 | awk '{print $1}') == "$expected_rootfs_sha256" ]] || fail "canonical rootfs SHA-256 differs"
[[ $(sha256sum /guest/provenance.json | awk '{print $1}') == "$expected_provenance_sha256" ]] || fail "canonical guest provenance SHA-256 differs"
[[ $($qemu_bin --version | sed -n '1p') == 'QEMU emulator version 8.2.0' ]] || fail "native producer is not QEMU 8.2.0"
node /proof/artifact-integrity.mjs /guest >"$evidence_dir/artifact-integrity-before.json"

ln -s /guest/rootfs.ext4 "$evidence_dir/rootfs.ext4"
(
  cd "$evidence_dir"
  "$qemu_img" create -q -f qcow2 -F raw -b rootfs.ext4 source-overlay.qcow2
)

kernel_command_line='root=/dev/vda rw rootwait console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=false rd.systemd.show_status=false mitigations=off nowatchdog omarchy.web_demo=1'
common_args=(
  -L "$firmware_dir"
  -machine pc-q35-8.2
  -m 1024M
  -accel tcg,tb-size=128,thread=multi
  -smp 2,sockets=1,cores=2,threads=1
  -display none
  -device virtio-vga,max_outputs=1,xres=1600,yres=900
  -device virtio-keyboard-pci
  -device virtio-tablet-pci
  -kernel /guest/vmlinuz-linux
  -initrd /guest/initramfs-linux.img
  -append "$kernel_command_line"
  -device virtio-serial-pci
  -monitor none
  -parallel none
  -nic none
  -no-reboot
)

source_args=(
  "${common_args[@]}"
  -chardev "file,id=omarchy-diag,path=$evidence_dir/source-diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$source_socket,server=on,wait=off"
  -drive "file=$evidence_dir/source-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe"
)
printf '%q ' "$qemu_bin" "${source_args[@]}" >"$evidence_dir/source-command.txt"
printf '\n' >>"$evidence_dir/source-command.txt"

set_phase source-boot
boot_started_ms=$(date +%s%3N)
"$qemu_bin" "${source_args[@]}" >>"$evidence_dir/source-qemu.log" 2>&1 &
source_pid=$!
source_process_pid=$source_pid
source_start_ticks=$(awk '{print $22}' "/proc/$source_pid/stat")
for _attempt in $(seq 1 120); do
  [[ -S $source_socket ]] && break
  kill -0 "$source_pid" 2>/dev/null || fail "source QEMU exited before QMP"
  sleep 0.25
done
[[ -S $source_socket ]] || fail "source QMP socket was not created"

report_deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < report_deadline )); do
  assert_no_uwsm_failure
  grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/source-diagnostics.log" && break
  kill -0 "$source_pid" 2>/dev/null || fail "source QEMU exited before authentic guest report"
  sleep 1
done
grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/source-diagnostics.log" || fail "timed out waiting for authentic guest report"
report_received_ms=$(date +%s%3N)
node "$report_gate" "$evidence_dir/source-diagnostics.log" /guest/guest-manifest.json >"$evidence_dir/source-report-validation.json" \
  || fail "authentic guest report failed verification"

set_phase source-healthy-frames
capture_two_healthy_frames "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  "$evidence_dir/source-desktop" "checkpoint source" 360

set_phase source-foot-proof
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" release-modifiers >"$evidence_dir/source-release-modifiers.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" super-return >"$evidence_dir/source-super-return.json"
wait_for_frame_change "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  "$evidence_dir/source-desktop-2.ppm" "$evidence_dir/source-foot.ppm" \
  "$evidence_dir/source-foot-change.json" minimum 0.0005 "source Super+Return Foot appearance" 120

set_phase source-return-to-shell
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" release-modifiers >"$evidence_dir/source-release-before-close.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" super-w >"$evidence_dir/source-super-w.json"
wait_for_frame_change "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  "$evidence_dir/source-desktop-2.ppm" "$evidence_dir/source-checkpoint-desktop.ppm" \
  "$evidence_dir/source-return-change.json" maximum 0.05 "source Foot close/clean checkpoint desktop" 120
boot_finished_ms=$(date +%s%3N)

# Capture a running runstate. Immediate `-incoming file:` has no browser-side
# QMP control channel, so a paused stream would be unusable. QEMU performs its
# normal stop-and-copy phase and leaves the source in postmigrate only after the
# raw stream and paired disk state are consistent.
set_phase checkpoint-running-state
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" release-modifiers >"$evidence_dir/source-release-before-migration.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute query-status '{}' >"$evidence_dir/source-premigration-status.json"
checkpoint_started_ms=$(date +%s%3N)
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute migrate "{\"uri\":\"file:$evidence_dir/omarchy-preboot.vmstate\"}" >/dev/null
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  wait-migration 600000 >"$evidence_dir/source-migration-complete.json"
checkpoint_finished_ms=$(date +%s%3N)
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute query-migrate '{}' >"$evidence_dir/source-migration-final.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute query-status '{}' >"$evidence_dir/source-postmigration-status.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" execute quit '{}' >/dev/null
set +e
wait "$source_pid"
source_exit=$?
set -e
source_pid=
[[ $source_exit -eq 0 ]] || fail "source QEMU exited with $source_exit"
mv "$evidence_dir/source-overlay.qcow2" "$evidence_dir/checkpoint-overlay.qcow2"
"$qemu_img" info --output=json "$evidence_dir/checkpoint-overlay.qcow2" >"$evidence_dir/checkpoint-overlay-info.json"
sha256sum "$evidence_dir/omarchy-preboot.vmstate" "$evidence_dir/checkpoint-overlay.qcow2" \
  >"$evidence_dir/checkpoint-artifacts-before-target.sha256"

target_args=(
  "${common_args[@]}"
  -chardev "file,id=omarchy-diag,path=$evidence_dir/target-diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$target_socket,server=on,wait=off"
  -snapshot
  -drive "file=$evidence_dir/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe"
  -incoming "file:$evidence_dir/omarchy-preboot.vmstate"
)
printf '%q ' "$qemu_bin" "${target_args[@]}" >"$evidence_dir/target-command.txt"
printf '\n' >>"$evidence_dir/target-command.txt"

set_phase target-immediate-incoming
resume_started_ms=$(date +%s%3N)
"$qemu_bin" "${target_args[@]}" >>"$evidence_dir/target-qemu.log" 2>&1 &
target_pid=$!
target_process_pid=$target_pid
target_start_ticks=$(awk '{print $22}' "/proc/$target_pid/stat")
for _attempt in $(seq 1 6000); do
  [[ -S $target_socket ]] && break
  kill -0 "$target_pid" 2>/dev/null || fail "fresh target QEMU exited while loading immediate vmstate"
  sleep 0.1
done
[[ -S $target_socket ]] || fail "fresh target QMP socket was not created"
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  wait-status running 600000 >"$evidence_dir/target-running-status.json" \
  || fail "immediate incoming target did not auto-run without QMP cont"
resume_running_ms=$(date +%s%3N)
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  execute query-migrate '{}' >"$evidence_dir/target-migration-final.json"

set_phase target-healthy-frames
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" release-modifiers >"$evidence_dir/target-release-modifiers.json"
capture_two_healthy_frames "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  "$evidence_dir/resumed-desktop" "resumed target" 360
resume_healthy_ms=$(date +%s%3N)

set_phase target-foot-proof
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" super-return >"$evidence_dir/target-super-return.json"
wait_for_frame_change "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  "$evidence_dir/resumed-desktop-2.ppm" "$evidence_dir/resumed-foot.ppm" \
  "$evidence_dir/resumed-foot-change.json" minimum 0.0005 "resumed Super+Return Foot appearance" 120
resume_finished_ms=$(date +%s%3N)

node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" execute quit '{}' >/dev/null
set +e
wait "$target_pid"
target_exit=$?
set -e
target_pid=
[[ $target_exit -eq 0 ]] || fail "fresh target QEMU exited with $target_exit"
sha256sum "$evidence_dir/omarchy-preboot.vmstate" "$evidence_dir/checkpoint-overlay.qcow2" \
  >"$evidence_dir/checkpoint-artifacts-after-target.sha256"
cmp -s "$evidence_dir/checkpoint-artifacts-before-target.sha256" "$evidence_dir/checkpoint-artifacts-after-target.sha256" \
  || fail "checkpoint artifacts changed during disposable target smoke"
node /proof/artifact-integrity.mjs /guest >"$evidence_dir/artifact-integrity-after.json"

qemu_version=$($qemu_bin --version | sed -n '1p')
qemu_sha256=$(sha256sum "$qemu_bin" | awk '{print $1}')
vmstate_sha256=$(sha256sum "$evidence_dir/omarchy-preboot.vmstate" | awk '{print $1}')
vmstate_bytes=$(stat -c %s "$evidence_dir/omarchy-preboot.vmstate")
overlay_sha256=$(sha256sum "$evidence_dir/checkpoint-overlay.qcow2" | awk '{print $1}')
overlay_bytes=$(stat -c %s "$evidence_dir/checkpoint-overlay.qcow2")

node - "$evidence_dir/run.json" <<EOF
const fs = require("fs");
const [output] = process.argv.slice(2);
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 2,
  status: "completed",
  qemuVersion: ${qemu_version@Q},
  qemuSourceCommit: "$expected_qemu_commit",
  qemuSha256: "$qemu_sha256",
  sourceProcess: { pid: $source_process_pid, startTicks: $source_start_ticks, exitCode: $source_exit },
  targetProcess: { pid: $target_process_pid, startTicks: $target_start_ticks, exitCode: $target_exit },
  sourceExitedBeforeTargetLaunch: true,
  machine: "pc-q35-8.2",
  memoryMiB: 1024,
  vcpus: 2,
  smp: "2,sockets=1,cores=2,threads=1",
  accelerator: "tcg,tb-size=128,thread=multi",
  browserAcceptance: false,
  nativeCheckpointHandoff: true,
  diskMode: "packaged qcow2 boot delta over exact immutable rootfs; resumed target adds -snapshot",
  migrationCompression: "none",
  incomingMode: "immediate-cli-file",
  capturedRunstate: "running",
  targetAutoRanWithoutQmpCont: true,
  kernelCommandLine: ${kernel_command_line@Q},
  guestReportMilliseconds: $((report_received_ms - boot_started_ms)),
  bootToCheckpointReadyMilliseconds: $((boot_finished_ms - boot_started_ms)),
  checkpointMilliseconds: $((checkpoint_finished_ms - checkpoint_started_ms)),
  resumeToRunningMilliseconds: $((resume_running_ms - resume_started_ms)),
  resumeToHealthyMilliseconds: $((resume_healthy_ms - resume_started_ms)),
  resumedFootProofMilliseconds: $((resume_finished_ms - resume_healthy_ms)),
  vmstateBytes: $vmstate_bytes,
  vmstateSha256: "$vmstate_sha256",
  overlayBytes: $overlay_bytes,
  overlaySha256: "$overlay_sha256"
}, null, 2) + "\n");
EOF

node - "$evidence_dir/checkpoint-manifest.json" \
  "$evidence_dir/source-diagnostics.log" \
  "$evidence_dir/source-report-validation.json" \
  "$evidence_dir/source-checkpoint-desktop.ppm" \
  "$evidence_dir/source-checkpoint-desktop-health.json" <<EOF
const fs = require("fs");
const crypto = require("crypto");
const [output, diagnosticsPath, reportValidationPath, checkpointFramePath, checkpointFrameHealthPath] = process.argv.slice(2);
const reportPrefix = "OMARCHY_GUEST_REPORT ";
const reportLines = fs.readFileSync(diagnosticsPath, "utf8").split("\n").filter((line) => line.startsWith(reportPrefix));
if (reportLines.length !== 1) throw new Error("expected one source guest report, found " + reportLines.length);
const guestReport = JSON.parse(reportLines[0].slice(reportPrefix.length));
const recursivelySort = (value) => Array.isArray(value)
  ? value.map(recursivelySort)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, recursivelySort(value[key])]))
    : value;
const digestBytes = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalizedGuestReportSha256 = digestBytes(JSON.stringify(recursivelySort(guestReport)));
const reportValidationSha256 = digestBytes(fs.readFileSync(reportValidationPath));
const checkpointFrameSha256 = digestBytes(fs.readFileSync(checkpointFramePath));
const checkpointFrameHealthSha256 = digestBytes(fs.readFileSync(checkpointFrameHealthPath));
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 1,
  kind: "omarchy-web-preboot-checkpoint",
  vmstate: {
    path: "omarchy-preboot.vmstate",
    bytes: $vmstate_bytes,
    sha256: "$vmstate_sha256",
    format: "qemu-8.2-migration",
    compression: "none",
    incomingMode: "file"
  },
  bootDelta: {
    path: "checkpoint-overlay.qcow2",
    bytes: $overlay_bytes,
    sha256: "$overlay_sha256",
    format: "qcow2",
    backingFilename: "rootfs.ext4",
    backingFormat: "raw"
  },
  producer: { qemuBinarySha256: "$qemu_sha256" },
  identity: {
    baseGuestManifestSha256: "$expected_manifest_sha256",
    rootfsSha256: "$expected_rootfs_sha256",
    guestProvenanceSha256: "$expected_provenance_sha256"
  },
  qemu: {
    repository: "https://github.com/ktock/qemu-wasm.git",
    sourceCommit: "$expected_qemu_commit",
    version: "8.2.0"
  },
  machine: {
    type: "pc-q35-8.2",
    memoryMiB: 1024,
    smp: "2,sockets=1,cores=2,threads=1",
    accel: "tcg,tb-size=128,thread=multi"
  },
  restoreContract: {
    sourceRunstate: "running",
    immediateIncomingAutoRuns: true,
    qmpContRequired: false,
    disposableWrites: "target -snapshot layer over immutable boot delta"
  },
  sourceEvidence: {
    guestReport,
    normalizedGuestReportSha256,
    reportValidationSha256,
    checkpointFrameSha256,
    checkpointFrameHealthSha256
  }
}, null, 2) + "\n");
EOF

(
  cd "$evidence_dir"
  sha256sum omarchy-preboot.vmstate checkpoint-overlay.qcow2 checkpoint-manifest.json >SHA256SUMS
)
set_phase completed
trap - EXIT INT TERM
rm -f "$source_socket" "$target_socket"
printf 'PREBOOT_CONTAINER_PASS evidence=%s\n' "$evidence_dir"
