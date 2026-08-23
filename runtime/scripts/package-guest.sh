#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guest_dir="${1:-}"
output_dir="${2:-$runtime_dir/dist}"
builder_image="${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}"

if [[ -z "$guest_dir" ]]; then
  printf 'Usage: %s GUEST_ASSET_DIRECTORY [OUTPUT_DIRECTORY]\n' "${0##*/}" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { printf 'docker is required\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
[[ -d "$guest_dir" ]] || { printf 'guest directory not found: %s\n' "$guest_dir" >&2; exit 1; }
[[ -d "$output_dir/firmware" ]] || { printf 'build QEMU first; firmware directory is missing: %s/firmware\n' "$output_dir" >&2; exit 1; }

while IFS= read -r file; do
  [[ -f "$guest_dir/$file" ]] || { printf 'missing guest asset: %s/%s\n' "$guest_dir" "$file" >&2; exit 1; }
done < <(node -e '
  const manifest = require(process.argv[1]);
  for (const key of ["rootfs", "kernel", "initramfs"]) {
    process.stdout.write(`${manifest.guest[key].artifactPath}\n`);
  }
' "$runtime_dir/config/demo.json")

guest_dir="$(cd "$guest_dir" && pwd)"
output_dir="$(cd "$output_dir" && pwd)"

docker image inspect "$builder_image" >/dev/null 2>&1 || {
  printf 'builder image %s is missing; run build-qemu-wasm.sh first\n' "$builder_image" >&2
  exit 1
}

rm -f -- "$output_dir/load.js" "$output_dir/qemu.data"
node "$runtime_dir/scripts/prepare-runtime-manifest.mjs" \
  "$guest_dir" "$output_dir/runtime-manifest.json"
install -m 0644 "$runtime_dir/web/runtime.mjs" "$output_dir/runtime.mjs"
node "$runtime_dir/scripts/bundle-production-worker.mjs" "$output_dir/production-worker.mjs"
install -m 0644 "$runtime_dir/web/worker-input.mjs" "$output_dir/worker-input.mjs"
install -m 0644 "$runtime_dir/../storage/paged-disk.mjs" "$output_dir/paged-disk.mjs"
install -m 0644 "$runtime_dir/../storage/bounded-overlay.mjs" "$output_dir/bounded-overlay.mjs"
cmp -s "$runtime_dir/../storage/paged-disk.mjs" "$output_dir/paged-disk.mjs" || {
  printf 'packaged paged-disk.mjs differs from the canonical storage adapter\n' >&2
  exit 1
}
cmp -s "$runtime_dir/../storage/bounded-overlay.mjs" "$output_dir/bounded-overlay.mjs" || {
  printf 'packaged bounded-overlay.mjs differs from the canonical storage guard\n' >&2
  exit 1
}
node "$runtime_dir/scripts/verify-runtime-artifacts.mjs" --write-report "$output_dir"
QEMU_WASM_BUILDER_IMAGE="$builder_image" \
QEMU_WASM_BUILDER_ID="$(docker image inspect --format '{{.Id}}' "$builder_image")" \
  node "$runtime_dir/scripts/write-build-metadata.mjs" "$output_dir"
printf 'Paged-worker production manifest written to %s/runtime-manifest.json (guest assets remain release artifacts)\n' "$output_dir"
