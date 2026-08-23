#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_build="${QEMU_WASM_OUTPUT:-$runtime_dir/dist}"
output_dir="${1:-$runtime_dir/smoke-dist}"
builder_image="${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}"

command -v docker >/dev/null 2>&1 || { printf 'docker is required\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
[[ -d "$runtime_build/firmware" ]] || {
  printf 'build QEMU first; firmware directory is missing: %s/firmware\n' "$runtime_build" >&2
  exit 1
}

for relative_path in \
  qemu.mjs qemu.wasm qemu.worker.js production-worker.mjs worker-input.mjs paged-disk.mjs bounded-overlay.mjs \
  firmware/bios-256k.bin firmware/vgabios-stdvga.bin \
  firmware/kvmvapic.bin firmware/linuxboot_dma.bin; do
  [[ -f "$runtime_build/$relative_path" ]] || {
    printf 'missing built runtime artifact: %s/%s\n' "$runtime_build" "$relative_path" >&2
    exit 1
  }
done

docker image inspect "$builder_image" >/dev/null 2>&1 || {
  printf 'builder image %s is missing; run build-qemu-wasm.sh first\n' "$builder_image" >&2
  exit 1
}

mkdir -p "$output_dir/firmware"
runtime_build="$(cd "$runtime_build" && pwd)"
output_dir="$(cd "$output_dir" && pwd)"

install -m 0644 "$runtime_build/qemu.mjs" "$output_dir/qemu.mjs"
install -m 0644 "$runtime_build/qemu.wasm" "$output_dir/qemu.wasm"
install -m 0644 "$runtime_build/qemu.worker.js" "$output_dir/qemu.worker.js"
install -m 0644 "$runtime_build/production-worker.mjs" "$output_dir/production-worker.mjs"
install -m 0644 "$runtime_build/worker-input.mjs" "$output_dir/worker-input.mjs"
install -m 0644 "$runtime_build/paged-disk.mjs" "$output_dir/paged-disk.mjs"
install -m 0644 "$runtime_build/bounded-overlay.mjs" "$output_dir/bounded-overlay.mjs"
for firmware in bios-256k.bin vgabios-stdvga.bin kvmvapic.bin linuxboot_dma.bin; do
  install -m 0644 "$runtime_build/firmware/$firmware" "$output_dir/firmware/$firmware"
done

docker run --rm --init \
  --volume "$output_dir/firmware:/firmware:ro" \
  --volume "$output_dir:/out" \
  --env "OUTPUT_UID=$(id -u)" \
  --env "OUTPUT_GID=$(id -g)" \
  --entrypoint /bin/bash \
  "$builder_image" \
  -euo pipefail -c '
    cd /out
    /emsdk/upstream/emscripten/tools/file_packager.py qemu.data \
      --preload /firmware@/pack > load.js
    chown "$OUTPUT_UID:$OUTPUT_GID" qemu.data load.js
  '

install -m 0644 "$runtime_dir/config/smoke.json" "$output_dir/runtime-manifest.json"
install -m 0644 "$runtime_dir/web/runtime.mjs" "$output_dir/runtime.mjs"
node "$runtime_dir/scripts/verify-runtime-artifacts.mjs" --write-report "$output_dir"
QEMU_WASM_BUILDER_IMAGE="$builder_image" \
QEMU_WASM_BUILDER_ID="$(docker image inspect --format '{{.Id}}' "$builder_image")" \
  node "$runtime_dir/scripts/write-build-metadata.mjs" "$output_dir"
printf 'Firmware-only SDL smoke bundle written to %s\n' "$output_dir"
