#!/bin/bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
guest_dir=${FULL_GUEST_DIST:-$repo_dir/guest/dist}
evidence_root=${FULL_GUEST_EVIDENCE_ROOT:-$proof_dir/evidence}
timeout_seconds=${SMOKE_TIMEOUT_SECONDS:-1800}
qemu_bin=${QEMU_SYSTEM_X86_64:-qemu-system-x86_64}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
evidence_dir="$evidence_root/$run_id"
socket_dir=$(mktemp -d /private/tmp/omarchy-full-guest-qmp.XXXXXX)
qmp_socket="$socket_dir/qmp.sock"
qmp_log="$evidence_dir/qmp.jsonl"
serial_log="$evidence_dir/serial.log"
diagnostics_log="$evidence_dir/diagnostics.log"
qemu_log="$evidence_dir/qemu.log"
before_frame="$evidence_dir/desktop-before.ppm"
foot_open_frame="$evidence_dir/desktop-foot-open.ppm"
foot_frame="$evidence_dir/desktop-foot.ppm"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
qemu_pid=
clean_teardown=false

fail() {
  echo "FULL_GUEST_FAIL $*" >&2
  exit 1
}

command -v "$qemu_bin" >/dev/null 2>&1 || fail "qemu-system-x86_64 is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || fail "SMOKE_TIMEOUT_SECONDS must be a positive integer"
[[ -d $guest_dir ]] || fail "guest distribution not found: $guest_dir"
mkdir -p "$evidence_dir"
: >"$qmp_log"
: >"$serial_log"
: >"$diagnostics_log"
printf 'Native QEMU stderr/stdout for exact full-guest gate\n' >"$qemu_log"

cleanup() {
  local status=$?
  if [[ -n ${qemu_pid:-} ]] && kill -0 "$qemu_pid" 2>/dev/null; then
    if [[ -S $qmp_socket ]]; then
      node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" quit >/dev/null 2>&1 || true
      for _attempt in $(seq 1 30); do
        kill -0 "$qemu_pid" 2>/dev/null || break
        sleep 1
      done
    fi
    if kill -0 "$qemu_pid" 2>/dev/null; then
      kill "$qemu_pid" 2>/dev/null || true
      wait "$qemu_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$qmp_socket"
  rmdir "$socket_dir" 2>/dev/null || true
  if (( status != 0 )); then
    printf 'Incomplete evidence retained at %s\n' "$evidence_dir" >&2
  fi
}
trap cleanup EXIT INT TERM

echo "[full-guest] streaming and verifying exact guest/dist artifacts before boot"
node "$proof_dir/artifact-integrity.mjs" "$guest_dir" >"$evidence_dir/artifact-integrity-before.json"

kernel="$guest_dir/vmlinuz-linux"
initramfs="$guest_dir/initramfs-linux.img"
rootfs="$guest_dir/rootfs.ext4"
kernel_command_line='root=/dev/vda rw rootwait rootfstype=ext4 console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=true rd.systemd.show_status=true mitigations=off nowatchdog omarchy.web_demo=1'
qemu_args=(
  -machine pc-q35-8.2
  -m 1536M
  -accel tcg,tb-size=256,thread=multi
  -smp 2,sockets=1,cores=2,threads=1
  -display none
  -device virtio-vga,max_outputs=1,xres=1600,yres=900
  -device virtio-keyboard-pci
  -device virtio-tablet-pci
  -drive "if=virtio,format=raw,file=$rootfs,cache=unsafe"
  -snapshot
  -kernel "$kernel"
  -initrd "$initramfs"
  -append "$kernel_command_line"
  -serial "file:$serial_log"
  -chardev "file,id=diagnostics,path=$diagnostics_log"
  -device virtio-serial-pci
  -device virtserialport,chardev=diagnostics,name=omarchy.web.diagnostics
  -qmp "unix:$qmp_socket,server=on,wait=off"
  -monitor none
  -nic none
  -no-reboot
)

printf '%q ' "$qemu_bin" "${qemu_args[@]}" >"$evidence_dir/command.txt"
printf '\n' >>"$evidence_dir/command.txt"
qemu_version=$($qemu_bin --version | sed -n '1p')
printf '[full-guest] launching %s\n' "$qemu_version"
"$qemu_bin" "${qemu_args[@]}" >>"$qemu_log" 2>&1 &
qemu_pid=$!

for _attempt in $(seq 1 60); do
  [[ -S $qmp_socket ]] && break
  kill -0 "$qemu_pid" 2>/dev/null || fail "QEMU exited before opening QMP"
  sleep 1
done
[[ -S $qmp_socket ]] || fail "QEMU did not open its QMP socket"
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" status >"$evidence_dir/qmp-initial-status.json"

echo "[full-guest] waiting up to ${timeout_seconds}s for the authentic OMARCHY_GUEST_REPORT"
started_seconds=$SECONDS
last_progress=$SECONDS
while (( SECONDS - started_seconds < timeout_seconds )); do
  if grep -q '^OMARCHY_GUEST_REPORT ' "$diagnostics_log" 2>/dev/null; then
    break
  fi
  kill -0 "$qemu_pid" 2>/dev/null || {
    tail -n 160 "$serial_log" >&2 || true
    tail -n 80 "$qemu_log" >&2 || true
    fail "QEMU exited before the guest report"
  }
  if (( SECONDS - last_progress >= 20 )); then
    printf '[full-guest] still booting (%ss elapsed; serial=%s bytes)\n' \
      "$((SECONDS - started_seconds))" "$(wc -c <"$serial_log" | tr -d ' ')"
    last_progress=$SECONDS
  fi
  sleep 2
done
grep -q '^OMARCHY_GUEST_REPORT ' "$diagnostics_log" || {
  tail -n 200 "$serial_log" >&2 || true
  fail "timed out waiting for OMARCHY_GUEST_REPORT"
}

echo "[full-guest] live Hyprland and Quickshell report received; capturing 1600x900 desktop"
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" screendump "$before_frame" >/dev/null
[[ -s $before_frame ]] || fail "QMP did not create the pre-Foot framebuffer"

echo "[full-guest] invoking Omarchy's real Super+Return binding and proving Foot keyboard input"
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" super-return >/dev/null
sleep 15
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" screendump "$foot_open_frame" >/dev/null
[[ -s $foot_open_frame ]] || fail "QMP did not create the opened-Foot framebuffer"

# Keep the visible command short so the framebuffer independently records that
# keyboard input reached the real terminal.
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" type $'id\n' >/dev/null
sleep 4
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" screendump "$foot_frame" >/dev/null
[[ -s $foot_frame ]] || fail "QMP did not create the Foot framebuffer"

echo "[full-guest] requesting graceful QMP teardown"
set +e
node "$proof_dir/qmp.mjs" "$qmp_socket" "$qmp_log" quit >"$evidence_dir/qmp-quit-result.json" 2>"$evidence_dir/qmp-quit-error.log"
qmp_quit_status=$?
set -e
for _attempt in $(seq 1 60); do
  kill -0 "$qemu_pid" 2>/dev/null || break
  sleep 1
done
kill -0 "$qemu_pid" 2>/dev/null && fail "QEMU remained alive after QMP quit"
set +e
wait "$qemu_pid"
qemu_exit_code=$?
set -e
qemu_pid=
[[ $qemu_exit_code -eq 0 ]] || fail "QEMU exited with status $qemu_exit_code"
clean_teardown=true

echo "[full-guest] re-verifying artifacts after the disposable run"
node "$proof_dir/artifact-integrity.mjs" "$guest_dir" >"$evidence_dir/artifact-integrity-after.json"
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg startedAt "$started_at" \
  --arg finishedAt "$finished_at" \
  --arg qemuVersion "$qemu_version" \
  --arg hostArchitecture "$(uname -m)" \
  --arg guestDirectory "$(cd "$guest_dir" && pwd)" \
  --arg kernelCommandLine "$kernel_command_line" \
  --argjson qemuExitCode "$qemu_exit_code" \
  --argjson qmpQuitClientStatus "$qmp_quit_status" \
  '{schemaVersion:1,status:"completed",startedAt:$startedAt,finishedAt:$finishedAt,qemuVersion:$qemuVersion,hostArchitecture:$hostArchitecture,guestDirectory:$guestDirectory,machine:"pc-q35-8.2",memoryMiB:1536,cores:2,snapshot:true,network:"none",kernelCommandLine:$kernelCommandLine,qemuExitCode:$qemuExitCode,qmpQuitClientStatus:$qmpQuitClientStatus,teardown:"qmp-quit",qemuAliveAfterTeardown:false}' \
  >"$evidence_dir/run.json"

echo "[full-guest] running fail-closed evidence validator"
set +e
node "$proof_dir/validate.mjs" "$guest_dir" "$evidence_dir" \
  >"$evidence_dir/validation.json" 2>"$evidence_dir/validation-error.log"
validation_status=$?
set -e

if command -v sips >/dev/null 2>&1; then
  sips -s format png "$before_frame" --out "$evidence_dir/desktop-before.png" >/dev/null
  sips -s format png "$foot_open_frame" --out "$evidence_dir/desktop-foot-open.png" >/dev/null
  sips -s format png "$foot_frame" --out "$evidence_dir/desktop-foot.png" >/dev/null
fi

(
  cd "$evidence_dir"
  evidence_files=(
    artifact-integrity-before.json artifact-integrity-after.json command.txt diagnostics.log
    desktop-before.ppm desktop-foot-open.ppm desktop-foot.ppm qemu.log qmp.jsonl run.json serial.log validation.json
  )
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${evidence_files[@]}" >SHA256SUMS
  else
    shasum -a 256 "${evidence_files[@]}" >SHA256SUMS
  fi
)
printf '%s\n' "$run_id" >"$evidence_root/latest.txt"

if (( validation_status != 0 )); then
  cat "$evidence_dir/validation-error.log" >&2
  fail "fail-closed evidence validator rejected the completed native run"
fi

trap - EXIT INT TERM
rm -f "$qmp_socket"
rmdir "$socket_dir" 2>/dev/null || true
printf 'FULL_GUEST_PASS evidence=%s\n' "$evidence_dir"
