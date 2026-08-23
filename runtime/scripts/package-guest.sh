#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guest_dir="${1:-}"
output_dir="${2:-$runtime_dir/dist}"
builder_image="${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}"
tcg_experiment="${OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT:-}"
graphics_experiment="${OMARCHY_GRAPHICS_EXPERIMENT:-}"
vcpu_experiment="${OMARCHY_VCPU_EXPERIMENT:-}"
hibernation_requested="false"
boot_mode_label="cold-boot"

if [[ -z "$guest_dir" ]]; then
  printf 'Usage: %s GUEST_ASSET_DIRECTORY [OUTPUT_DIRECTORY]\n' "${0##*/}" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { printf 'docker is required\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
[[ -d "$guest_dir" ]] || { printf 'guest directory not found: %s\n' "$guest_dir" >&2; exit 1; }
[[ -d "$output_dir/firmware" ]] || { printf 'build QEMU first; firmware directory is missing: %s/firmware\n' "$output_dir" >&2; exit 1; }

hibernation_artifacts=(
  "hibernate-manifest.json"
  "initramfs-virgl-hibernate.img"
  "hibernate-root-overlay.qcow2"
  "omarchy-hibernate.qcow2"
)
hibernation_artifact_count=0
for file in "${hibernation_artifacts[@]}"; do
  [[ ! -e "$guest_dir/$file" ]] || ((hibernation_artifact_count += 1))
done
if (( hibernation_artifact_count > 0 )); then
  (( hibernation_artifact_count == ${#hibernation_artifacts[@]} )) || {
    printf 'guest-hibernation-resume requires the exact descriptor, derived initramfs, root delta, and swap image set\n' >&2
    exit 2
  }
  for file in "${hibernation_artifacts[@]}"; do
    [[ -f "$guest_dir/$file" ]] || {
      printf 'guest-hibernation-resume artifact is not a regular file: %s/%s\n' "$guest_dir" "$file" >&2
      exit 2
    }
  done
  for file in checkpoint-manifest.json omarchy-preboot.vmstate checkpoint-overlay.qcow2; do
    [[ ! -e "$guest_dir/$file" ]] || {
      printf 'guest-hibernation-resume refuses an ambiguous migration-checkpoint artifact: %s/%s\n' "$guest_dir" "$file" >&2
      exit 2
    }
  done
  [[ -z "$graphics_experiment" || "$graphics_experiment" == "virgl-webgl2" ]] || {
    printf 'guest-hibernation-resume requires the VirGL/WebGL2 runtime profile\n' >&2
    exit 2
  }
  [[ -z "$vcpu_experiment" ]] || {
    printf 'guest-hibernation-resume requires its exact two-vCPU restore topology\n' >&2
    exit 2
  }
  graphics_experiment="virgl-webgl2"
  export OMARCHY_GRAPHICS_EXPERIMENT="$graphics_experiment"
  hibernation_requested="true"
  boot_mode_label="guest-hibernation-resume"
fi
[[ -z "$tcg_experiment" || "$tcg_experiment" == "250" || "$tcg_experiment" == "750" ||
   "$tcg_experiment" == "1500-metrics" || "$tcg_experiment" == "1500-clock" ||
   "$tcg_experiment" == "6000-fill" || "$tcg_experiment" == "6000-batch32" ]] || {
  printf 'unsupported QEMU-Wasm TCG threshold experiment: %s\n' "$tcg_experiment" >&2
  exit 2
}
[[ -z "$graphics_experiment" || "$graphics_experiment" == "virgl-webgl2" ||
   "$graphics_experiment" == "webgl2-present" ]] || {
  printf 'unsupported QEMU-Wasm graphics experiment: %s\n' "$graphics_experiment" >&2
  exit 2
}
[[ -z "$vcpu_experiment" || "$vcpu_experiment" == "1" ||
   "$vcpu_experiment" == "4" ]] || {
  printf 'unsupported browser vCPU experiment: %s\n' "$vcpu_experiment" >&2
  exit 2
}
[[ -z "$vcpu_experiment" ||
   ( ( "$tcg_experiment" == "750" || "$tcg_experiment" == "6000-fill" ) &&
     "$graphics_experiment" == "virgl-webgl2" ) ]] || {
  printf 'the browser vCPU experiment requires VirGL/WebGL2 plus a compatible instrumented TCG profile\n' >&2
  exit 2
}
[[ -z "$tcg_experiment" || -z "$graphics_experiment" ||
   ( ( "$tcg_experiment" == "1500-metrics" || "$tcg_experiment" == "750" ||
       "$tcg_experiment" == "1500-clock" || "$tcg_experiment" == "6000-fill" ||
       "$tcg_experiment" == "6000-batch32" ) &&
     "$graphics_experiment" == "virgl-webgl2" ) ]] || {
  printf 'only an instrumented VirGL-compatible TCG profile may be combined with VirGL/WebGL2\n' >&2
  exit 2
}

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
if [[ ( -n "$tcg_experiment" || -n "$graphics_experiment" ) &&
      "$output_dir" == "$runtime_dir/dist" ]]; then
  printf 'experiments must use an isolated output directory, not runtime/dist\n' >&2
  exit 2
fi

docker image inspect "$builder_image" >/dev/null 2>&1 || {
  printf 'builder image %s is missing; run build-qemu-wasm.sh first\n' "$builder_image" >&2
  exit 1
}

rm -f -- "$output_dir/load.js" "$output_dir/qemu.data"
node "$runtime_dir/scripts/prepare-runtime-manifest.mjs" \
  "$guest_dir" "$output_dir/runtime-manifest.json"
install -m 0644 "$runtime_dir/web/runtime.mjs" "$output_dir/runtime.mjs"
node "$runtime_dir/scripts/bundle-production-worker.mjs" "$output_dir/production-worker.mjs"
if [[ -n "$tcg_experiment" ]]; then
  node "$runtime_dir/scripts/stamp-tcg-threshold-experiment.mjs" \
    "$output_dir/production-worker.mjs" "$output_dir/qemu.wasm" "$tcg_experiment"
fi
if [[ -n "$tcg_experiment" && -n "$graphics_experiment" ]]; then
  printf 'Experimental %s + %s %s manifest written to %s/runtime-manifest.json (not promotion eligible)\n' \
    "$graphics_experiment" "$tcg_experiment" "$boot_mode_label" "$output_dir"
fi
if [[ -n "$graphics_experiment" ]]; then
  node "$runtime_dir/scripts/stamp-graphics-experiment.mjs" \
    "$output_dir/production-worker.mjs" "$output_dir/qemu.wasm" "$graphics_experiment"
fi
if [[ -n "$vcpu_experiment" ]]; then
  node "$runtime_dir/scripts/stamp-vcpu-experiment.mjs" \
    "$output_dir/production-worker.mjs" "$output_dir/qemu.wasm" "$vcpu_experiment"
fi
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
if [[ "$hibernation_requested" == "true" ]]; then
  printf 'Authenticated guest-hibernation-resume manifest written to %s/runtime-manifest.json (not promotion eligible)\n' "$output_dir"
elif [[ -n "$tcg_experiment" ]]; then
  printf 'Experimental %s paged-worker manifest written to %s/runtime-manifest.json (not promotion eligible)\n' "$tcg_experiment" "$output_dir"
elif [[ "$graphics_experiment" == "webgl2-present" ]]; then
  printf 'Experimental checkpoint-compatible WebGL2 presenter written to %s/runtime-manifest.json (not promotion eligible)\n' "$output_dir"
elif [[ -n "$graphics_experiment" ]]; then
  printf 'Experimental %s cold-boot manifest written to %s/runtime-manifest.json (not promotion eligible)\n' "$graphics_experiment" "$output_dir"
else
  printf 'Paged-worker production manifest written to %s/runtime-manifest.json (guest assets remain release artifacts)\n' "$output_dir"
fi
