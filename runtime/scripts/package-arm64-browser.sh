#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guest_dir="${1:-}"
output_dir="${2:-$runtime_dir/experiments/arm64-browser/dist}"

[[ -n "$guest_dir" ]] || { printf 'usage: %s ARM64_GUEST_DIRECTORY [OUTPUT_DIRECTORY]\n' "${0##*/}" >&2; exit 2; }
guest_dir="$(cd "$guest_dir" && pwd)"
output_dir="$(cd "$output_dir" && pwd)"
[[ "$output_dir" != "$runtime_dir/dist" ]] || { printf 'ARM64 experiment refuses runtime/dist\n' >&2; exit 2; }

for file in qemu.mjs qemu.wasm qemu.worker.js; do
  [[ -f "$output_dir/$file" ]] || { printf 'build ARM64 QEMU-Wasm first: missing %s\n' "$file" >&2; exit 1; }
done
node -e '
  const value = require(process.argv[1]);
  if (value?.guest?.architecture !== "aarch64") throw new Error("guest manifest is not ARM64");
' "$guest_dir/guest-manifest.json"

install -m 0644 "$runtime_dir/config/arm64-browser.json" "$output_dir/runtime-manifest.json"
install -m 0644 "$runtime_dir/web/runtime.mjs" "$output_dir/runtime.mjs"
node "$runtime_dir/scripts/bundle-production-worker.mjs" "$output_dir/production-worker.mjs"
install -m 0644 "$runtime_dir/web/worker-input.mjs" "$output_dir/worker-input.mjs"
install -m 0644 "$runtime_dir/../storage/paged-disk.mjs" "$output_dir/paged-disk.mjs"
install -m 0644 "$runtime_dir/../storage/bounded-overlay.mjs" "$output_dir/bounded-overlay.mjs"
node "$runtime_dir/scripts/verify-arm64-qemu-wasm.mjs" "$output_dir"
node "$runtime_dir/scripts/write-arm64-build-metadata.mjs" "$output_dir"
printf 'ARM64 browser cold-boot package written to %s\n' "$output_dir"
