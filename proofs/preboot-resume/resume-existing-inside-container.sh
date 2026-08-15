#!/usr/bin/env bash
set -euo pipefail

qemu_bin=/proof/.build/qemu-8.2-native/qemu-system-x86_64
firmware_dir=/proof/.build/qemu-8.2-source/pc-bios
qmp_client=/proof/qmp.mjs
source_evidence=${SOURCE_EVIDENCE:?SOURCE_EVIDENCE is required}
output_dir=${OUTPUT_DIR:?OUTPUT_DIR is required}
target_socket=/tmp/omarchy-existing-target-$$.sock
target_pid=

fail() {
  printf 'PREBOOT_EXISTING_CONTAINER_FAIL %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [[ -n ${target_pid:-} ]] && kill -0 "$target_pid" 2>/dev/null; then
    if [[ -S $target_socket ]]; then
      node "$qmp_client" "$target_socket" "$output_dir/qmp-cleanup.jsonl" \
        execute quit '{}' >/dev/null 2>&1 || true
    fi
    wait "$target_pid" 2>/dev/null || true
  fi
  rm -f "$target_socket"
  exit "$status"
}
trap cleanup EXIT INT TERM

[[ -x $qemu_bin ]] || fail "pinned QEMU is missing"
[[ -f $source_evidence/omarchy-preboot.vmstate ]] || fail "vmstate is missing"
[[ -f $source_evidence/checkpoint-overlay.qcow2 ]] || fail "checkpoint overlay is missing"
[[ -L $source_evidence/rootfs.ext4 ]] || fail "checkpoint backing-file link is missing"
grep -q -- '-machine pc-q35-8.2' "$source_evidence/source-command.txt" || fail "source machine is not pc-q35-8.2"
grep -q -- '-smp 1\\,sockets=1\\,cores=1\\,threads=1' "$source_evidence/source-command.txt" || fail "source is not the one-vCPU topology"
mkdir -p "$output_dir"
: >"$output_dir/diagnostics.log"
: >"$output_dir/qemu.log"
: >"$output_dir/qmp.jsonl"
node /proof/artifact-integrity.mjs /guest >"$output_dir/artifact-integrity.json"

kernel_command_line='root=/dev/vda rw rootwait console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=false rd.systemd.show_status=false mitigations=off nowatchdog omarchy.web_demo=1'
target_args=(
  -L "$firmware_dir"
  -machine pc-q35-8.2
  -m 1024M
  -accel tcg,tb-size=128,thread=single
  -smp 1,sockets=1,cores=1,threads=1
  -display none
  -device virtio-vga,max_outputs=1,xres=1600,yres=900
  -device virtio-keyboard-pci
  -device virtio-tablet-pci
  -kernel /guest/vmlinuz-linux
  -initrd /guest/initramfs-linux.img
  -append "$kernel_command_line"
  -device virtio-serial-pci
  -chardev "file,id=omarchy-diag,path=$output_dir/diagnostics.log,mux=on"
  -serial chardev:omarchy-diag
  -device virtserialport,chardev=omarchy-diag,name=omarchy.web.diagnostics
  -qmp "unix:$target_socket,server=on,wait=off"
  -monitor none
  -parallel none
  -nic none
  -no-reboot
  -snapshot
  -drive "file=$source_evidence/checkpoint-overlay.qcow2,if=virtio,format=qcow2,media=disk,cache=unsafe"
  -incoming defer
)
printf '%q ' "$qemu_bin" "${target_args[@]}" >"$output_dir/target-command.txt"
printf '\n' >>"$output_dir/target-command.txt"

resume_started_ms=$(date +%s%3N)
"$qemu_bin" "${target_args[@]}" >>"$output_dir/qemu.log" 2>&1 &
target_pid=$!
target_process_pid=$target_pid
target_start_ticks=$(awk '{print $22}' "/proc/$target_pid/stat")
for _attempt in $(seq 1 1200); do
  [[ -S $target_socket ]] && break
  kill -0 "$target_pid" 2>/dev/null || fail "target exited before QMP"
  sleep 0.1
done
[[ -S $target_socket ]] || fail "target QMP socket was not created"

node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  execute migrate-set-capabilities \
  '{"capabilities":[{"capability":"compress","state":true}]}' >/dev/null
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  execute migrate-set-parameters '{"decompress-threads":2}' >/dev/null
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  execute migrate-incoming \
  "{\"uri\":\"file:$source_evidence/omarchy-preboot.vmstate\"}" >/dev/null
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  wait-status paused 600000 >"$output_dir/loaded-status.json"
resume_loaded_ms=$(date +%s%3N)
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  execute query-migrate '{}' >"$output_dir/migration-final.json"
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" execute cont '{}' >/dev/null
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  wait-status running 60000 >"$output_dir/running-status.json"
sleep 5
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  screendump "$output_dir/resumed-desktop.ppm" >/dev/null
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" super-return >/dev/null
sleep 15
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  type $'id >/dev/virtio-ports/omarchy.web.diagnostics\n' >/dev/null
sleep 5
node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" \
  screendump "$output_dir/resumed-foot.ppm" >/dev/null
grep -q 'uid=1000(omarchy)' "$output_dir/diagnostics.log" || fail "resumed input did not execute as Omarchy"

node "$qmp_client" "$target_socket" "$output_dir/qmp.jsonl" execute quit '{}' >/dev/null
wait "$target_pid"
target_exit=$?
target_pid=
[[ $target_exit -eq 0 ]] || fail "target exited with $target_exit"

resume_load_ms=$((resume_loaded_ms - resume_started_ms))
qemu_sha256=$(sha256sum "$qemu_bin" | awk '{print $1}')
vmstate_sha256=$(sha256sum "$source_evidence/omarchy-preboot.vmstate" | awk '{print $1}')
overlay_sha256=$(sha256sum "$source_evidence/checkpoint-overlay.qcow2" | awk '{print $1}')
desktop_sha256=$(sha256sum "$output_dir/resumed-desktop.ppm" | awk '{print $1}')
foot_sha256=$(sha256sum "$output_dir/resumed-foot.ppm" | awk '{print $1}')
node - "$output_dir/result.json" <<EOF
const fs = require("fs");
const [output] = process.argv.slice(2);
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 1,
  status: "PASS",
  claim: "Compressed QEMU 8.2 file migration restored in a fresh process after deferred destination decompression setup; this native QMP socket is not a browser integration proof.",
  browserReady: false,
  targetProcess: { pid: $target_process_pid, startTicks: $target_start_ticks, exitCode: $target_exit },
  machine: "pc-q35-8.2",
  memoryMiB: 1024,
  vcpus: 1,
  resumeLoadMilliseconds: $resume_load_ms,
  qemuSha256: "$qemu_sha256",
  vmstateSha256: "$vmstate_sha256",
  overlaySha256: "$overlay_sha256",
  resumedDesktopSha256: "$desktop_sha256",
  resumedFootSha256: "$foot_sha256"
}, null, 2) + "\n");
EOF

trap - EXIT INT TERM
rm -f "$target_socket"
printf 'PREBOOT_EXISTING_CONTAINER_PASS output=%s\n' "$output_dir"
