#!/usr/bin/env bash
set -euo pipefail

qemu_bin=/proof/.build/qemu-8.2-native/qemu-system-x86_64
qemu_img=/proof/.build/qemu-8.2-native/qemu-img
firmware_dir=/proof/.build/qemu-8.2-source/pc-bios
qmp_client=/proof/qmp.mjs
frame_health=/proof/frame-health.mjs
evidence_dir=${EVIDENCE_DIR:?EVIDENCE_DIR is required}
timeout_seconds=${PREBOOT_TIMEOUT_SECONDS:-900}
vcpus=${PREBOOT_VCPUS:-1}
proof_scope=${PREBOOT_PROOF_SCOPE:-browser-topology-resume-proof}
migration_compression=${PREBOOT_MIGRATION_COMPRESSION:-none}
source_socket=/tmp/omarchy-preboot-source-$$.sock
target_socket=/tmp/omarchy-preboot-target-$$.sock
source_pid=
target_pid=

fail() {
  printf 'PREBOOT_CONTAINER_FAIL %s\n' "$*" >&2
  exit 1
}

wait_for_clean_frame() {
  local socket=$1
  local qmp_log=$2
  local output=$3
  local health_output=$4
  local label=$5
  local timeout=$6
  local candidate="$output.candidate"
  local candidate_health="$health_output.candidate"
  local clean_streak=0
  local frame_deadline=$((SECONDS + timeout))
  while (( SECONDS < frame_deadline )); do
    node "$qmp_client" "$socket" "$qmp_log" screendump "$candidate" >/dev/null
    if node "$frame_health" "$candidate" >"$candidate_health"; then
      clean_streak=$((clean_streak + 1))
    else
      clean_streak=0
    fi
    if (( clean_streak >= 2 )); then
      mv "$candidate" "$output"
      mv "$candidate_health" "$health_output"
      return 0
    fi
    sleep 10
  done
  fail "$label did not settle to two consecutive clean 1600x900 frames"
}

cleanup() {
  local status=$?
  for tuple in "${target_pid:-}:$target_socket:$evidence_dir/qmp-cleanup-target.jsonl" \
               "${source_pid:-}:$source_socket:$evidence_dir/qmp-cleanup-source.jsonl"; do
    IFS=: read -r pid socket cleanup_log <<<"$tuple"
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      if [[ -S $socket ]]; then
        node "$qmp_client" "$socket" "$cleanup_log" execute quit '{}' >/dev/null 2>&1 || true
      fi
      for _attempt in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$source_socket" "$target_socket"
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null 2>&1 || fail "node is unavailable in the pinned builder"
command -v gzip >/dev/null 2>&1 || fail "gzip is unavailable in the pinned builder"
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || fail "timeout must be a positive integer"
[[ $vcpus =~ ^[1-9][0-9]*$ ]] || fail "vCPU count must be a positive integer"
[[ $migration_compression == none || $migration_compression == legacy ]] || fail "migration compression must be none or legacy"
[[ -x $qemu_bin ]] || fail "pinned QEMU binary is unavailable"
[[ -x $qemu_img ]] || fail "pinned qemu-img is unavailable"
mkdir -p "$evidence_dir"
: >"$evidence_dir/source-qmp.jsonl"
: >"$evidence_dir/target-qmp.jsonl"
: >"$evidence_dir/source-diagnostics.log"
: >"$evidence_dir/target-diagnostics.log"
: >"$evidence_dir/source-qemu.log"
: >"$evidence_dir/target-qemu.log"
node - "$evidence_dir/proof-scope.json" "$proof_scope" "$vcpus" "$migration_compression" <<'EOF'
const fs = require("fs");
const [output, proofScope, vcpusText, migrationCompression] = process.argv.slice(2);
const vcpus = Number(vcpusText);
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 1,
  proofScope,
  vcpus,
  browserTopologyVcpus: 1,
  topologyMatchesBrowser: vcpus === 1,
  migrationCompression,
  immediateFileIncoming: migrationCompression === "none",
  browserAcceptance: false,
  note: vcpus === 1
    ? "Native migration/resume proof at the planned browser CPU topology; browser execution remains separate acceptance."
    : "Migration mechanism proof only; CPU topology intentionally differs from the planned one-vCPU browser runtime."
}, null, 2) + "\n");
EOF

node /proof/artifact-integrity.mjs /guest \
  >"$evidence_dir/artifact-integrity-before.json"
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
  -accel tcg,tb-size=128,thread=single
  -smp "$vcpus,sockets=1,cores=$vcpus,threads=1"
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

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/source-diagnostics.log" && break
  kill -0 "$source_pid" 2>/dev/null || fail "source QEMU exited before guest report"
  sleep 1
done
grep -q '^OMARCHY_GUEST_REPORT ' "$evidence_dir/source-diagnostics.log" || \
  fail "timed out waiting for authentic guest report"
wait_for_clean_frame \
  "$source_socket" \
  "$evidence_dir/source-qmp.jsonl" \
  "$evidence_dir/source-desktop.ppm" \
  "$evidence_dir/source-frame-health.json" \
  "checkpoint source" \
  300

# A nominally non-black framebuffer is not enough: Omarchy's idle surface can
# legitimately be almost one dark color, and a failed compositor session can
# look identical. Prove the real desktop binding and keyboard path before
# freezing that state. `exit` closes Foot again so the packaged checkpoint
# starts at the normal desktop rather than inside the proof terminal.
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" release-modifiers >/dev/null
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" super-return >/dev/null
sleep 15
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  screendump "$evidence_dir/source-foot.ppm" >/dev/null
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  type $'id >/dev/virtio-ports/omarchy.web.diagnostics\n' >/dev/null
source_input_deadline=$((SECONDS + 30))
while (( SECONDS < source_input_deadline )); do
  grep -q 'uid=1000(omarchy)' "$evidence_dir/source-diagnostics.log" && break
  sleep 1
done
grep -q 'uid=1000(omarchy)' "$evidence_dir/source-diagnostics.log" || \
  fail "source Super+Return did not open an interactive Omarchy Foot session"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" type $'exit\n' >/dev/null
sleep 5
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" release-modifiers >/dev/null
wait_for_clean_frame \
  "$source_socket" \
  "$evidence_dir/source-qmp.jsonl" \
  "$evidence_dir/source-desktop-after-input.ppm" \
  "$evidence_dir/source-frame-health-after-input.json" \
  "checkpoint source after input proof" \
  120
boot_finished_ms=$(date +%s%3N)

node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" execute stop '{}' >/dev/null
if [[ $migration_compression == legacy ]]; then
  node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
    execute migrate-set-capabilities \
    '{"capabilities":[{"capability":"compress","state":true}]}' >/dev/null
  node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
    execute migrate-set-parameters \
    '{"compress-level":6,"compress-threads":2,"compress-wait-thread":true,"decompress-threads":2}' >/dev/null
fi

checkpoint_started_ms=$(date +%s%3N)
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute migrate "{\"uri\":\"file:$evidence_dir/omarchy-preboot.vmstate\"}" >/dev/null
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  wait-migration 600000 >"$evidence_dir/source-migration-complete.json"
checkpoint_finished_ms=$(date +%s%3N)
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" \
  execute query-migrate '{}' >"$evidence_dir/source-migration-final.json"
node "$qmp_client" "$source_socket" "$evidence_dir/source-qmp.jsonl" execute quit '{}' >/dev/null
wait "$source_pid"
source_exit=$?
source_pid=
[[ $source_exit -eq 0 ]] || fail "source QEMU exited with $source_exit"
mv "$evidence_dir/source-overlay.qcow2" "$evidence_dir/checkpoint-overlay.qcow2"

gzip -9 -c "$evidence_dir/omarchy-preboot.vmstate" >"$evidence_dir/omarchy-preboot.vmstate.gz"
gzip -t "$evidence_dir/omarchy-preboot.vmstate.gz"
gzip -9 -c "$evidence_dir/checkpoint-overlay.qcow2" >"$evidence_dir/checkpoint-overlay.qcow2.gz"
gzip -t "$evidence_dir/checkpoint-overlay.qcow2.gz"

target_args=(
  "${common_args[@]}"
  -chardev "file,id=omarchy-diag,path=$evidence_dir/target-diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$target_socket,server=on,wait=off"
  -snapshot
  -drive "file=$evidence_dir/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe"
)
if [[ $migration_compression == legacy ]]; then
  target_args+=(-incoming defer)
else
  target_args+=(-incoming "file:$evidence_dir/omarchy-preboot.vmstate")
fi
printf '%q ' "$qemu_bin" "${target_args[@]}" >"$evidence_dir/target-command.txt"
printf '\n' >>"$evidence_dir/target-command.txt"
resume_started_ms=$(date +%s%3N)
"$qemu_bin" "${target_args[@]}" >>"$evidence_dir/target-qemu.log" 2>&1 &
target_pid=$!
target_process_pid=$target_pid
target_start_ticks=$(awk '{print $22}' "/proc/$target_pid/stat")

for _attempt in $(seq 1 1200); do
  [[ -S $target_socket ]] && break
  kill -0 "$target_pid" 2>/dev/null || fail "target QEMU exited while loading vmstate"
  sleep 0.1
done
[[ -S $target_socket ]] || fail "target QMP socket was not created"
if [[ $migration_compression == legacy ]]; then
  node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
    execute migrate-set-capabilities \
    '{"capabilities":[{"capability":"compress","state":true}]}' >/dev/null
  node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
    execute migrate-set-parameters \
    '{"decompress-threads":2}' >/dev/null
  node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
    execute migrate-incoming \
    "{\"uri\":\"file:$evidence_dir/omarchy-preboot.vmstate\"}" >/dev/null
fi
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  wait-status paused 600000 >"$evidence_dir/target-loaded-status.json"
resume_loaded_ms=$(date +%s%3N)
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  execute query-migrate '{}' >"$evidence_dir/target-migration-final.json"
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" execute cont '{}' >/dev/null
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  wait-status running 60000 >"$evidence_dir/target-running-status.json"
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" release-modifiers >/dev/null
wait_for_clean_frame \
  "$target_socket" \
  "$evidence_dir/target-qmp.jsonl" \
  "$evidence_dir/resumed-desktop.ppm" \
  "$evidence_dir/resumed-frame-health.json" \
  "resumed target" \
  300
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" super-return >/dev/null
sleep 15
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  type $'id >/dev/virtio-ports/omarchy.web.diagnostics\n' >/dev/null
sleep 5
node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" \
  screendump "$evidence_dir/resumed-foot.ppm" >/dev/null
grep -q 'uid=1000(omarchy)' "$evidence_dir/target-diagnostics.log" || \
  fail "resumed Foot command did not reach the named guest diagnostics port"

node "$qmp_client" "$target_socket" "$evidence_dir/target-qmp.jsonl" execute quit '{}' >/dev/null
wait "$target_pid"
target_exit=$?
target_pid=
[[ $target_exit -eq 0 ]] || fail "target QEMU exited with $target_exit"
resume_finished_ms=$(date +%s%3N)

node /proof/artifact-integrity.mjs /guest \
  >"$evidence_dir/artifact-integrity-after.json"

qemu_version=$($qemu_bin --version | sed -n '1p')
qemu_sha256=$(sha256sum "$qemu_bin" | awk '{print $1}')
vmstate_sha256=$(sha256sum "$evidence_dir/omarchy-preboot.vmstate" | awk '{print $1}')
vmstate_bytes=$(stat -c %s "$evidence_dir/omarchy-preboot.vmstate")
gzip_bytes=$(stat -c %s "$evidence_dir/omarchy-preboot.vmstate.gz")
overlay_sha256=$(sha256sum "$evidence_dir/checkpoint-overlay.qcow2" | awk '{print $1}')
overlay_bytes=$(stat -c %s "$evidence_dir/checkpoint-overlay.qcow2")
overlay_gzip_bytes=$(stat -c %s "$evidence_dir/checkpoint-overlay.qcow2.gz")
if [[ $migration_compression == legacy ]]; then
  migration_description='QEMU legacy compress capability, zlib level 6, two threads'
  incoming_mode='defer-qmp-file'
else
  migration_description='none; raw QEMU stream'
  incoming_mode='immediate-cli-file'
fi
node - "$evidence_dir/run.json" <<EOF
const fs = require("fs");
const [output] = process.argv.slice(2);
const record = {
  schemaVersion: 1,
  status: "completed",
  qemuVersion: ${qemu_version@Q},
  qemuSourceCommit: "0ef7b4e2814b231705d8371dd7997f5b72e70baf",
  qemuSha256: "$qemu_sha256",
  sourceProcess: { pid: $source_process_pid, startTicks: $source_start_ticks, exitCode: $source_exit },
  targetProcess: { pid: $target_process_pid, startTicks: $target_start_ticks, exitCode: $target_exit },
  sourceExitedBeforeTargetLaunch: true,
  machine: "pc-q35-8.2",
  memoryMiB: 1024,
  vcpus: $vcpus,
  proofScope: ${proof_scope@Q},
  browserTopologyVcpus: 1,
  topologyMatchesBrowser: $([[ $vcpus == 1 ]] && printf true || printf false),
  browserAcceptance: false,
  diskMode: "packaged preboot qcow2 delta over exact immutable rootfs; resumed target adds -snapshot",
  migrationCompression: ${migration_description@Q},
  incomingMode: ${incoming_mode@Q},
  kernelCommandLine: ${kernel_command_line@Q},
  bootMilliseconds: $((boot_finished_ms - boot_started_ms)),
  checkpointMilliseconds: $((checkpoint_finished_ms - checkpoint_started_ms)),
  resumeLoadMilliseconds: $((resume_loaded_ms - resume_started_ms)),
  resumedInteractionMilliseconds: $((resume_finished_ms - resume_loaded_ms)),
  vmstateBytes: $vmstate_bytes,
  vmstateSha256: "$vmstate_sha256",
  gzipBytes: $gzip_bytes,
  gzipRatio: $gzip_bytes / $vmstate_bytes,
  overlayBytes: $overlay_bytes,
  overlaySha256: "$overlay_sha256",
  overlayGzipBytes: $overlay_gzip_bytes,
  overlayGzipRatio: $overlay_gzip_bytes / $overlay_bytes,
};
fs.writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
EOF

trap - EXIT INT TERM
rm -f "$source_socket" "$target_socket"
printf 'PREBOOT_CONTAINER_PASS evidence=%s\n' "$evidence_dir"
