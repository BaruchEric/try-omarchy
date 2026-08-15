#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_image=${1:?source initramfs path is required}
output_image=${2:?output initramfs path is required}
expected_sha256=9a4239b35f2ad1fe6684c6c006f38a04489df640a08feae3fe56e5b91a6e17ed
renderer_probe="$proof_dir/.build/qemu-8.2-native-virgl/egl-renderer-probe"
overlay_tmp=

fail() {
  printf 'VIRGL_HIBERNATE_INITRAMFS_FAIL %s\n' "$*" >&2
  exit 1
}

command -v cpio >/dev/null 2>&1 || fail "cpio is required"
command -v zstd >/dev/null 2>&1 || fail "zstd is required"
[[ -f $source_image ]] || fail "source initramfs is missing"
[[ -x $renderer_probe ]] || fail "fresh EGL renderer probe is missing; run build-pinned-qemu.sh"
[[ $(sha256sum "$source_image" | awk '{print $1}') == "$expected_sha256" ]] || \
  fail "source initramfs identity differs"
[[ ! -e $output_image ]] || fail "refusing to replace existing output: $output_image"

cleanup() {
  [[ -z ${overlay_tmp:-} ]] || rm -rf -- "$overlay_tmp"
}
trap cleanup EXIT
overlay_tmp=$(mktemp -d)
cp -R "$proof_dir/initramfs-overlay/." "$overlay_tmp/"
mkdir -p "$overlay_tmp/usr/local/libexec"
install -m 0755 "$renderer_probe" "$overlay_tmp/usr/local/libexec/omarchy-egl-renderer-probe"

cp "$source_image" "$output_image"
(
  cd "$overlay_tmp"
  find . -mindepth 1 -print0 \
    | LC_ALL=C sort -z \
    | cpio --null -o --format=newc --owner=0:0 2>/dev/null \
    | zstd -q -T1 -3 \
    >>"$output_image"
)

source_bytes=$(stat -c %s "$source_image")
cmp -n "$source_bytes" "$source_image" "$output_image" \
  || fail "derived initramfs does not preserve the canonical base prefix"
for required in \
  config \
  etc/modprobe.d/90-omarchy-hibernate-virtio-gpu.conf \
  hooks/resume \
  hooks/omarchy_hibernate_stage \
  usr/local/libexec/omarchy-egl-renderer-probe; do
  tail -c "+$((source_bytes + 1))" "$output_image" \
    | zstd -dc 2>/dev/null \
    | cpio -it 2>/dev/null \
    | grep -Fxq "$required" \
    || fail "derived initramfs is missing $required"
done
for required in config hooks/resume hooks/omarchy_hibernate_stage; do
  tail -c "+$((source_bytes + 1))" "$output_image" \
    | zstd -dc 2>/dev/null \
    | cpio -i --to-stdout "$required" 2>/dev/null \
    | cmp - "$overlay_tmp/$required" \
    || fail "derived initramfs content differs for $required"
done
[[ $(stat -c %s "$output_image") -le 67108864 ]] || fail "derived initramfs exceeds 64 MiB"
printf 'VIRGL_HIBERNATE_INITRAMFS_PASS path=%s bytes=%s sha256=%s\n' \
  "$output_image" "$(stat -c %s "$output_image")" \
  "$(sha256sum "$output_image" | awk '{print $1}')"
