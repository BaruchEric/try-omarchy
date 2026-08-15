#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
source_dir=${QEMU_WASM_SOURCE:-/private/tmp/qemu-wasm-source}
base_builder_image=${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}
builder_image=${VIRGL_HIBERNATE_BUILDER_IMAGE:-omarchy-qemu-native-virgl:qemu-8.2}
build_dir="$proof_dir/.build/qemu-8.2-native-virgl"
source_overlay="$proof_dir/.build/qemu-8.2-source"
jobs=${BUILD_JOBS:-2}

fail() {
  printf 'VIRGL_HIBERNATE_BUILD_FAIL %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v git >/dev/null 2>&1 || fail "git is required"
[[ $jobs =~ ^[1-9][0-9]*$ ]] || fail "BUILD_JOBS must be a positive integer"
[[ -f $source_dir/VERSION ]] || fail "pinned QEMU source not found: $source_dir"

expected_commit=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).qemuWasm.commit" \
  "$repo_dir/runtime/upstream.lock.json")
actual_commit=$(git -C "$source_dir" rev-parse HEAD)
[[ $actual_commit == "$expected_commit" ]] || \
  fail "QEMU source commit mismatch: expected $expected_commit, got $actual_commit"
[[ $(<"$source_dir/VERSION") == 8.2.0 ]] || fail "pinned source is not QEMU 8.2.0"
[[ -z $(git -C "$source_dir" status --porcelain=v1) ]] || fail "pinned QEMU source is dirty"

declare -A revisions=(
  [dtc]=b6910bec11614980a21e46fbccc35934b671bd81
  [keycodemapdb]=f5772a62ec52591ff6870b7e8ef32482371f22c6
  [berkeley-softfloat-3]=b64af41c3276f97f0e181920400ee056b9c88037
  [berkeley-testfloat-3]=e7af9751d9f9fd3b47911f51a5cfd08af256a9ab
)

for name in "${!revisions[@]}"; do
  checkout="$repo_dir/runtime/build/upstreams/$name-${revisions[$name]}"
  [[ -d $checkout/.git ]] || fail "missing pinned subproject checkout: $checkout"
  [[ $(git -C "$checkout" rev-parse "${revisions[$name]}^{commit}") == "${revisions[$name]}" ]] || \
    fail "subproject revision unavailable: $name"
done

mkdir -p "$proof_dir/.build" "$build_dir"
if ! docker image inspect "$builder_image" >/dev/null 2>&1; then
  docker build --platform linux/amd64 \
    --build-arg "BASE_IMAGE=$base_builder_image" \
    --tag "$builder_image" \
    --file "$proof_dir/Dockerfile.native-builder" \
    "$proof_dir"
fi

if [[ ! -f $source_overlay/.omarchy-source-commit ]]; then
  overlay_tmp=$(mktemp -d "$proof_dir/.build/qemu-8.2-source.XXXXXX")
  cleanup_overlay_tmp() {
    rm -rf -- "$overlay_tmp"
  }
  trap cleanup_overlay_tmp EXIT
  git -C "$source_dir" archive "$expected_commit" | tar -x -C "$overlay_tmp"
  for name in "${!revisions[@]}"; do
    checkout="$repo_dir/runtime/build/upstreams/$name-${revisions[$name]}"
    mkdir -p "$overlay_tmp/subprojects/$name"
    git -C "$checkout" archive "${revisions[$name]}" | tar -x -C "$overlay_tmp/subprojects/$name"
    if [[ -d $source_dir/subprojects/packagefiles/$name ]]; then
      cp -R "$source_dir/subprojects/packagefiles/$name/." "$overlay_tmp/subprojects/$name/"
    fi
  done
  printf '%s\n' "$expected_commit" >"$overlay_tmp/.omarchy-source-commit"
  mv "$overlay_tmp" "$source_overlay"
  trap - EXIT
fi
[[ $(<"$source_overlay/.omarchy-source-commit") == "$expected_commit" ]] || \
  fail "cached source overlay was assembled from another commit"

docker run --rm --init --platform linux/amd64 \
  --volume "$source_overlay:/qemu-src:ro" \
  --volume "$proof_dir:/proof" \
  --workdir /proof/.build/qemu-8.2-native-virgl \
  --env "BUILD_JOBS=$jobs" \
  "$builder_image" \
  bash -lc '
    set -euo pipefail
    unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS PKG_CONFIG_PATH PKG_CONFIG_LIBDIR
    export TEST_DIR=/proof/.build/qemu-8.2-native-virgl/iotests-scratch
    export SOCK_DIR=/proof/.build/qemu-8.2-native-virgl/iotests-sockets
    mkdir -p "$TEST_DIR" "$SOCK_DIR"
    if [[ ! -f build.ninja ]]; then
      /qemu-src/configure \
        --target-list=x86_64-softmmu \
        --disable-docs \
        --disable-gtk \
        --disable-curses \
        --disable-vnc \
        --disable-werror \
        --with-coroutine=ucontext \
        --enable-pixman \
        --enable-sdl \
        --enable-opengl \
        --enable-virglrenderer
    fi
    ninja -j "$BUILD_JOBS" qemu-system-x86_64 qemu-img
    ./qemu-system-x86_64 --version | sed -n "1p"
    ./qemu-system-x86_64 -display help 2>&1 | grep -qw sdl
    ./qemu-system-x86_64 -device help 2>&1 | grep -q virtio-vga-gl
    pkg-config --modversion virglrenderer >virglrenderer-version.txt
    cc -O2 -Wall -Wextra -Werror /proof/egl-renderer-probe.c \
      -o egl-renderer-probe $(pkg-config --cflags --libs egl glesv2)
  '

printf '%s\n' "$expected_commit" >"$build_dir/source-commit.txt"
printf 'VIRGL_HIBERNATE_BUILD_PASS binary=%s qemu_img=%s\n' \
  "$build_dir/qemu-system-x86_64" "$build_dir/qemu-img"
