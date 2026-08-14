#!/bin/bash
set -euo pipefail

graphics_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out_dir=${GRAPHICS_OUT:-$graphics_dir/out}
evidence_dir=${GRAPHICS_EVIDENCE:-$out_dir/evidence}
timeout_seconds=${SMOKE_TIMEOUT_SECONDS:-1200}
qemu_bin=${QEMU_SYSTEM_X86_64:-qemu-system-x86_64}
monitor_dir=$(mktemp -d /private/tmp/omarchy-graphics-monitor.XXXXXX)

command -v "$qemu_bin" >/dev/null 2>&1 || { echo "qemu-system-x86_64 is required" >&2; exit 1; }
for asset in rootfs.ext4 vmlinuz initramfs.img; do
  [[ -s $out_dir/$asset ]] || { echo "missing $out_dir/$asset; run build-guest.sh first" >&2; exit 1; }
done

mkdir -p "$evidence_dir"
serial_log="$evidence_dir/serial.log"
guest_log="$evidence_dir/guest-evidence.log"
qemu_log="$evidence_dir/qemu.log"
monitor_socket="$monitor_dir/qemu.sock"
screenshot="$evidence_dir/desktop.ppm"
rm -f "$serial_log" "$guest_log" "$qemu_log" "$monitor_socket" "$screenshot" "$evidence_dir/desktop.png"

qemu_args=(
  -machine pc-q35-8.2
  -m 1536M
  -accel tcg,tb-size=256,thread=multi
  -smp 2,sockets=1,cores=2,threads=1
  -display none
  -device virtio-vga,max_outputs=1,xres=1600,yres=900
  -device virtio-keyboard-pci
  -device virtio-tablet-pci
  -drive "if=virtio,format=raw,file=$out_dir/rootfs.ext4,cache=unsafe"
  -snapshot
  -kernel "$out_dir/vmlinuz"
  -initrd "$out_dir/initramfs.img"
  -append "root=/dev/vda rw rootwait rootfstype=ext4 console=tty0 console=ttyS0,115200n8 loglevel=4 systemd.show_status=true rd.systemd.show_status=true mitigations=off nowatchdog omarchy.web_demo=1"
  -serial "file:$serial_log"
  -chardev "file,id=evidence,path=$guest_log"
  -device virtio-serial-pci
  -device virtserialport,chardev=evidence,name=org.omarchy.evidence
  -monitor "unix:$monitor_socket,server=on,wait=off"
  -nic none
  -no-reboot
)

printf '%q ' "$qemu_bin" "${qemu_args[@]}" >"$evidence_dir/command.txt"
printf '\n' >>"$evidence_dir/command.txt"
"$qemu_bin" "${qemu_args[@]}" >"$qemu_log" 2>&1 &
qemu_pid=$!

cleanup() {
  if kill -0 "$qemu_pid" 2>/dev/null; then
    printf 'quit\n' | nc -U -w 2 "$monitor_socket" >/dev/null 2>&1 || kill "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
  fi
  rm -f "$monitor_socket"
  rmdir "$monitor_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'QEMU pid %s; waiting up to %ss for the guest graphics gate...\n' "$qemu_pid" "$timeout_seconds"
started=$SECONDS
while (( SECONDS - started < timeout_seconds )); do
  if grep -q '^OMARCHY_GRAPHICS_PASS ' "$guest_log" 2>/dev/null; then
    break
  fi
  if grep -q '^OMARCHY_GRAPHICS_FAIL ' "$guest_log" 2>/dev/null; then
    tail -n 120 "$guest_log" >&2
    exit 1
  fi
  if ! kill -0 "$qemu_pid" 2>/dev/null; then
    echo "QEMU exited before the guest passed" >&2
    tail -n 120 "$serial_log" >&2 || true
    tail -n 80 "$qemu_log" >&2 || true
    exit 1
  fi
  sleep 2
done

grep -q '^OMARCHY_GRAPHICS_PASS ' "$guest_log" 2>/dev/null || {
  echo "timed out waiting for OMARCHY_GRAPHICS_PASS" >&2
  tail -n 120 "$guest_log" >&2 || true
  exit 1
}

printf 'screendump %s\n' "$screenshot" | nc -U -w 3 "$monitor_socket" >/dev/null 2>&1 || true
for attempt in $(seq 1 20); do
  [[ -s $screenshot ]] && break
  sleep 1
done
[[ -s $screenshot ]] || { echo "QEMU did not produce a framebuffer screenshot" >&2; exit 1; }

"$graphics_dir/scripts/validate-evidence.sh" "$evidence_dir"
if command -v sips >/dev/null 2>&1; then
  sips -s format png "$screenshot" --out "$evidence_dir/desktop.png" >/dev/null
fi

cp "$out_dir/build-report.json" "$evidence_dir/build-report.json"
cp "$out_dir/SHA256SUMS" "$evidence_dir/guest-SHA256SUMS"
sha256sum "$serial_log" "$guest_log" "$screenshot" >"$evidence_dir/SHA256SUMS" 2>/dev/null || shasum -a 256 "$serial_log" "$guest_log" "$screenshot" >"$evidence_dir/SHA256SUMS"
printf 'Evidence: %s\n' "$evidence_dir"
