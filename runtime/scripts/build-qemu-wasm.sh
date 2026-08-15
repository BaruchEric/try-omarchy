#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qemu_source="${QEMU_WASM_SOURCE:-/private/tmp/qemu-wasm-source}"
output_dir="${QEMU_WASM_OUTPUT:-$runtime_dir/dist}"
builder_image="${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}"
em_cache_volume="${QEMU_WASM_EM_CACHE_VOLUME:-omarchy-qemu-wasm-emcache-3.1.50}"
tcg_experiment="${OMARCHY_TCG_HOT_THRESHOLD_EXPERIMENT:-}"
graphics_experiment="${OMARCHY_GRAPHICS_EXPERIMENT:-}"
webgl_build=
if [[ "$graphics_experiment" == "virgl-webgl2" ||
      "$graphics_experiment" == "webgl2-present" ]]; then
  webgl_build=1
fi
default_build_volume=omarchy-qemu-wasm-build-qemu-8.2-emsdk-3.1.50
if [[ "$tcg_experiment" == "250" ]]; then
  default_build_volume+=-tcg-threshold-250
elif [[ "$tcg_experiment" == "750" ]]; then
  default_build_volume+=-tcg-threshold-750
elif [[ "$tcg_experiment" == "1500-metrics" ]]; then
  default_build_volume+=-tcg-baseline-1500-metrics
elif [[ "$tcg_experiment" == "1500-clock" ]]; then
  default_build_volume+=-tcg-bounded-clock
fi

if [[ -n "$webgl_build" ]]; then
  default_build_volume+=-virgl-webgl2
fi
build_volume="${QEMU_WASM_BUILD_VOLUME:-$default_build_volume}"
jobs="${BUILD_JOBS:-2}"

usage() {
  printf 'Usage: %s [--source PATH] [--output PATH] [--jobs N] [--image TAG]\n' "${0##*/}"
}

while (($#)); do
  case "$1" in
    --source) qemu_source="$2"; shift 2 ;;
    --output) output_dir="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --image) builder_image="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { printf 'docker is required\n' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf 'git is required\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
[[ -d "$qemu_source" ]] || { printf 'QEMU-Wasm source not found: %s\n' "$qemu_source" >&2; exit 1; }
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { printf 'jobs must be a positive integer\n' >&2; exit 2; }
[[ -z "$tcg_experiment" || "$tcg_experiment" == "250" || "$tcg_experiment" == "750" ||
   "$tcg_experiment" == "1500-metrics" || "$tcg_experiment" == "1500-clock" ]] || {
  printf 'unsupported QEMU-Wasm TCG threshold experiment: %s\n' "$tcg_experiment" >&2
  exit 2
}
[[ -z "$graphics_experiment" || "$graphics_experiment" == "virgl-webgl2" ||
   "$graphics_experiment" == "webgl2-present" ]] || {
  printf 'unsupported QEMU-Wasm graphics experiment: %s\n' "$graphics_experiment" >&2
  exit 2
}
[[ -z "$tcg_experiment" || -z "$graphics_experiment" ||
   ( ( "$tcg_experiment" == "1500-metrics" || "$tcg_experiment" == "750" ||
       "$tcg_experiment" == "1500-clock" ) &&
     "$graphics_experiment" == "virgl-webgl2" ) ]] || {
  printf 'only the instrumented 750, 1500-metrics, or 1500-clock TCG profiles may be combined with VirGL/WebGL2\n' >&2
  exit 2
}

"$runtime_dir/scripts/audit-upstreams.sh" "$qemu_source"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
qemu_source="$(cd "$qemu_source" && pwd)"
if [[ ( -n "$tcg_experiment" || -n "$graphics_experiment" ) &&
      "$output_dir" == "$runtime_dir/dist" ]]; then
  printf 'experiments must use an isolated output directory, not runtime/dist\n' >&2
  exit 2
fi

virgl_source=
if [[ -n "$webgl_build" ]]; then
  virgl_url=https://gitlab.freedesktop.org/virgl/virglrenderer.git
  virgl_revision=88b9fe3bfc64b23a701e4875006dbc0e769f14f6
  virgl_source="$runtime_dir/build/upstreams/virglrenderer"
  if [[ ! -d "$virgl_source/.git" ]]; then
    mkdir -p "$virgl_source"
    git -C "$virgl_source" init --quiet
    git -C "$virgl_source" remote add origin "$virgl_url"
  fi
  [[ "$(git -C "$virgl_source" remote get-url origin)" == "$virgl_url" ]] || {
    printf 'cached VirGL remote does not match %s\n' "$virgl_url" >&2
    exit 1
  }
  if ! git -C "$virgl_source" cat-file -e "$virgl_revision^{commit}" 2>/dev/null; then
    git -C "$virgl_source" fetch --quiet --depth=1 origin "$virgl_revision"
  fi
  git -C "$virgl_source" checkout --quiet --detach "$virgl_revision"
  [[ "$(git -C "$virgl_source" rev-parse HEAD)" == "$virgl_revision" ]] || {
    printf 'VirGL checkout did not resolve to the pinned commit\n' >&2
    exit 1
  }
fi

virgl_mount_args=()
if [[ -n "$virgl_source" ]]; then
  virgl_mount_args+=(--volume "$virgl_source:/virglrenderer-src:ro")
fi

if ! docker image inspect "$builder_image" >/dev/null 2>&1; then
  printf 'Building pinned Emscripten/QEMU dependency image %s...\n' "$builder_image"
  builder_context="$(mktemp -d "${TMPDIR:-/tmp}/omarchy-qemu-builder.XXXXXX")"
  cleanup_builder_context() {
    rm -rf -- "$builder_context"
  }
  trap cleanup_builder_context EXIT
  cp "$qemu_source/Dockerfile" "$builder_context/Dockerfile"
  patch --quiet --directory "$builder_context" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-builder-zlib-url.patch"
  docker build --tag "$builder_image" --file "$builder_context/Dockerfile" "$builder_context"
  cleanup_builder_context
  trap - EXIT
fi

prepare_wrap_checkout() {
  local name="$1"
  local wrap="$qemu_source/subprojects/$name.wrap"
  local url revision checkout current_url

  [[ -f "$wrap" ]] || { printf 'missing QEMU subproject wrap: %s\n' "$wrap" >&2; return 1; }
  url="$(awk -F ' *= *' '$1 == "url" { print $2; exit }' "$wrap")"
  revision="$(awk -F ' *= *' '$1 == "revision" { print $2; exit }' "$wrap")"
  [[ -n "$url" && "$revision" =~ ^[a-f0-9]{40}$ ]] || {
    printf 'invalid pinned wrap metadata: %s\n' "$wrap" >&2
    return 1
  }

  checkout="$runtime_dir/build/upstreams/$name-$revision"
  if [[ ! -d "$checkout/.git" ]]; then
    mkdir -p "$checkout"
    git -C "$checkout" init --quiet
    git -C "$checkout" remote add origin "$url"
  fi
  current_url="$(git -C "$checkout" remote get-url origin)"
  [[ "$current_url" == "$url" ]] || {
    printf 'cached %s remote mismatch: expected %s, got %s\n' "$name" "$url" "$current_url" >&2
    return 1
  }
  if ! git -C "$checkout" cat-file -e "$revision^{commit}" 2>/dev/null; then
    printf 'Fetching pinned QEMU subproject %s at %s...\n' "$name" "$revision" >&2
    git -C "$checkout" fetch --quiet --depth=1 origin "$revision"
  fi
  printf '%s\n' "$checkout"
}

required_wraps=(dtc keycodemapdb berkeley-softfloat-3 berkeley-testfloat-3)
declare -a wrap_checkouts=()
for wrap_name in "${required_wraps[@]}"; do
  wrap_checkouts+=("$(prepare_wrap_checkout "$wrap_name")")
done

source_overlay="$(mktemp -d "${TMPDIR:-/tmp}/omarchy-qemu-source-overlay.XXXXXX")"
cleanup_source_overlay() {
  rm -rf -- "$source_overlay"
}
trap cleanup_source_overlay EXIT
mkdir -p \
  "$source_overlay/accel/tcg" \
  "$source_overlay/system" \
  "$source_overlay/tcg" \
  "$source_overlay/include/ui" \
  "$source_overlay/ui" \
  "$source_overlay/subprojects"
cp "$qemu_source/meson.build" "$source_overlay/meson.build"
cp "$qemu_source/accel/tcg/tcg-accel-ops-rr.c" "$source_overlay/accel/tcg/tcg-accel-ops-rr.c"
cp "$qemu_source/system/main.c" "$source_overlay/system/main.c"
cp "$qemu_source/tcg/wasm32.c" "$source_overlay/tcg/wasm32.c"
cp "$qemu_source/tcg/wasm32.h" "$source_overlay/tcg/wasm32.h"
cp "$qemu_source/ui/sdl2-2d.c" "$source_overlay/ui/sdl2-2d.c"
cp "$qemu_source/ui/sdl2.c" "$source_overlay/ui/sdl2.c"
cp "$qemu_source/ui/sdl2-gl.c" "$source_overlay/ui/sdl2-gl.c"
cp "$qemu_source/include/ui/sdl2.h" "$source_overlay/include/ui/sdl2.h"
cp -R "$qemu_source/subprojects/." "$source_overlay/subprojects/"
for index in "${!required_wraps[@]}"; do
  wrap_name="${required_wraps[$index]}"
  wrap_checkout="${wrap_checkouts[$index]}"
  wrap_revision="$(awk -F ' *= *' '$1 == "revision" { print $2; exit }' \
    "$qemu_source/subprojects/$wrap_name.wrap")"
  mkdir -p "$source_overlay/subprojects/$wrap_name"
  git -C "$wrap_checkout" archive "$wrap_revision" \
    | tar -x -C "$source_overlay/subprojects/$wrap_name"
  if [[ -d "$qemu_source/subprojects/packagefiles/$wrap_name" ]]; then
    cp -R "$qemu_source/subprojects/packagefiles/$wrap_name/." \
      "$source_overlay/subprojects/$wrap_name/"
  fi
done
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-sdl-frame-hook.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-sdl-frame-sampling.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-input-bridge.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-runstate-guard.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-sdl-texture-reuse.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-sdl-pageflip-coalesce.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-worker-dom.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-tcg-rr-init.patch"
patch --quiet --directory "$source_overlay" --strip=1 \
  < "$runtime_dir/patches/qemu-wasm-tcg-vcpu-layout.patch"
if [[ "$tcg_experiment" == "250" ]]; then
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-hot-threshold-250.patch"
elif [[ "$tcg_experiment" == "750" ]]; then
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch"
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-hot-threshold-750.patch"
elif [[ "$tcg_experiment" == "1500-metrics" ]]; then
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch"
elif [[ "$tcg_experiment" == "1500-clock" ]]; then
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-baseline-threshold-1500-metrics.patch"
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-tcg-bounded-clock-cache.patch"
fi
if [[ -n "$webgl_build" ]]; then
  patch --quiet --directory "$source_overlay" --strip=1 \
    < "$runtime_dir/patches/qemu-wasm-virgl-webgl-link.patch"
  (
    cd "$source_overlay"
    git apply --recount --unidiff-zero --unsafe-paths \
      "$runtime_dir/patches/qemu-wasm-sdl-webgl-context.patch"
    git apply --recount --unsafe-paths \
      "$runtime_dir/patches/qemu-wasm-sdl-webgl-frame-proof.patch"
  )
fi

docker volume create "$em_cache_volume" >/dev/null
docker volume create "$build_volume" >/dev/null
docker run --rm --init \
  --volume "$qemu_source:/qemu-src:ro" \
  --volume "$source_overlay/meson.build:/qemu-src/meson.build:ro" \
  --volume "$source_overlay/accel/tcg/tcg-accel-ops-rr.c:/qemu-src/accel/tcg/tcg-accel-ops-rr.c:ro" \
  --volume "$source_overlay/system/main.c:/qemu-src/system/main.c:ro" \
  --volume "$source_overlay/tcg/wasm32.c:/qemu-src/tcg/wasm32.c:ro" \
  --volume "$source_overlay/tcg/wasm32.h:/qemu-src/tcg/wasm32.h:ro" \
  --volume "$source_overlay/ui/sdl2-2d.c:/qemu-src/ui/sdl2-2d.c:ro" \
  --volume "$source_overlay/ui/sdl2.c:/qemu-src/ui/sdl2.c:ro" \
  --volume "$source_overlay/ui/sdl2-gl.c:/qemu-src/ui/sdl2-gl.c:ro" \
  --volume "$source_overlay/include/ui/sdl2.h:/qemu-src/include/ui/sdl2.h:ro" \
  --volume "$source_overlay/subprojects:/qemu-src/subprojects:ro" \
  --volume "$build_volume:/build/omarchy-qemu-wasm" \
  --volume "$em_cache_volume:/build/emscripten-cache" \
  --volume "$runtime_dir:/runtime:ro" \
  --volume "$output_dir:/out" \
  "${virgl_mount_args[@]}" \
  --env "BUILD_JOBS=$jobs" \
  --env "OMARCHY_GRAPHICS_EXPERIMENT=$graphics_experiment" \
  --env "OUTPUT_UID=$(id -u)" \
  --env "OUTPUT_GID=$(id -g)" \
  --entrypoint /runtime/scripts/build-inside-container.sh \
  "$builder_image"

cleanup_source_overlay
trap - EXIT

if [[ "$graphics_experiment" == "virgl-webgl2" ]]; then
  cp "$runtime_dir/config/virgl-webgl2.json" "$output_dir/runtime-manifest.json"
elif [[ "$graphics_experiment" == "webgl2-present" ]]; then
  cp "$runtime_dir/config/webgl2-present.json" "$output_dir/runtime-manifest.json"
else
  cp "$runtime_dir/config/demo.json" "$output_dir/runtime-manifest.json"
fi
install -m 0644 "$runtime_dir/web/runtime.mjs" "$output_dir/runtime.mjs"
node "$runtime_dir/scripts/bundle-production-worker.mjs" "$output_dir/production-worker.mjs"
if [[ -n "$tcg_experiment" ]]; then
  node "$runtime_dir/scripts/stamp-tcg-threshold-experiment.mjs" \
    "$output_dir/production-worker.mjs" "$output_dir/qemu.wasm" "$tcg_experiment"
fi
if [[ -n "$graphics_experiment" ]]; then
  node "$runtime_dir/scripts/stamp-graphics-experiment.mjs" \
    "$output_dir/production-worker.mjs" "$output_dir/qemu.wasm" "$graphics_experiment"
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
node "$runtime_dir/scripts/verify-runtime-artifacts.mjs" "$output_dir"
QEMU_WASM_BUILDER_IMAGE="$builder_image" \
QEMU_WASM_BUILDER_ID="$(docker image inspect --format '{{.Id}}' "$builder_image")" \
  node "$runtime_dir/scripts/write-build-metadata.mjs" "$output_dir"
printf 'QEMU-Wasm browser runtime written to %s\n' "$output_dir"
