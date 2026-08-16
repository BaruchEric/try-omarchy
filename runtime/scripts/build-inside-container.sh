#!/usr/bin/env bash
set -euo pipefail

source_dir=/qemu-src
output_dir=/out
runtime_dir=/runtime
build_dir=/build/omarchy-qemu-wasm
jobs="${BUILD_JOBS:-2}"
output_uid="${OUTPUT_UID:-0}"
output_gid="${OUTPUT_GID:-0}"
graphics_experiment="${OMARCHY_GRAPHICS_EXPERIMENT:-}"
qemu_architecture="${OMARCHY_QEMU_ARCHITECTURE:-x86_64}"
webgl_build=
if [[ "$graphics_experiment" == "virgl-webgl2" ||
      "$graphics_experiment" == "webgl2-present" ]]; then
  webgl_build=1
fi

[[ -f "$source_dir/configure" ]] || { printf 'missing %s/configure\n' "$source_dir" >&2; exit 1; }
[[ -x "$runtime_dir/toolchain/sdl2-config" ]] || { printf 'missing SDL2 config shim\n' >&2; exit 1; }
[[ -f "$runtime_dir/toolchain/worker-screen-library.js" ]] || {
  printf 'missing Worker screen-size Emscripten library\n' >&2
  exit 1
}
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { printf 'BUILD_JOBS must be a positive integer\n' >&2; exit 1; }
[[ -z "$graphics_experiment" || "$graphics_experiment" == "virgl-webgl2" ||
   "$graphics_experiment" == "webgl2-present" ]] || {
  printf 'unsupported graphics experiment: %s\n' "$graphics_experiment" >&2
  exit 1
}
case "$qemu_architecture" in
  x86_64)
    qemu_target=x86_64-softmmu
    qemu_executable=qemu-system-x86_64
    ;;
  aarch64)
    qemu_target=aarch64-softmmu
    qemu_executable=qemu-system-aarch64
    [[ -z "$graphics_experiment" ]] || {
      printf 'ARM browser experiment does not yet support a graphics experiment\n' >&2
      exit 1
    }
    ;;
  *)
    printf 'unsupported QEMU guest architecture: %s\n' "$qemu_architecture" >&2
    exit 1
    ;;
esac

mkdir -p "$build_dir" "$output_dir/firmware"
cd "$build_dir"

export SDL2_CONFIG="$runtime_dir/toolchain/sdl2-config"
export EM_CACHE=/build/emscripten-cache

# Warm the Emscripten SDL port explicitly. This also makes a missing network or
# broken toolchain fail before the much longer QEMU compilation begins.
embuilder build sdl2

if [[ -n "$webgl_build" ]]; then
  RUNTIME_DIR="$runtime_dir" \
    "$runtime_dir/scripts/build-webgl-virgl-dependencies.sh"
fi

common_flags=(
  -O3
  -g0
  -Wno-error=unused-command-line-argument
  -matomics
  -mbulk-memory
  -DNDEBUG
  -DG_DISABLE_ASSERT
  -D_GNU_SOURCE
  -sASYNCIFY=1
  -pthread
  -sPROXY_TO_PTHREAD=1
  -sOFFSCREENCANVAS_SUPPORT=1
  -sOFFSCREEN_FRAMEBUFFER=1
  '-sOFFSCREENCANVASES_TO_PTHREAD=""'
  -sFORCE_FILESYSTEM=1
  -sALLOW_TABLE_GROWTH=1
  -sINITIAL_MEMORY=2300MB
  -sWASM_BIGINT=1
  -sMALLOC=mimalloc
  -sEXPORT_ES6=1
  -sMODULARIZE=1
  -sENVIRONMENT=web,worker
  -sASYNCIFY_IMPORTS=ffi_call_js
)
if [[ -n "$webgl_build" ]]; then
  common_flags+=(
    -sMIN_WEBGL_VERSION=2
    -sMAX_WEBGL_VERSION=2
    -sFULL_ES3=1
    -Wl,--error-limit=0
  )
fi
common_flags_string="${common_flags[*]}"
if [[ "$qemu_architecture" == "aarch64" ]]; then
  # QEMU main + RCU + four MTTCG vCPUs consume six pthreads. Prewarming eight
  # avoids on-demand module instantiation during the first browser launch.
  common_flags+=( -sPTHREAD_POOL_SIZE=8 )
  common_flags_string="${common_flags[*]}"
fi

graphics_configure_flags=()
if [[ -n "$webgl_build" ]]; then
  graphics_configure_flags+=(--enable-opengl --enable-virglrenderer)
fi

extra_ldflags="-sEXPORTED_RUNTIME_METHODS=FS,getTempRet0,setTempRet0,addFunction,removeFunction --js-library=$runtime_dir/toolchain/worker-screen-library.js"
if [[ -n "$webgl_build" ]]; then
  : # Final-emulator-only undefined handling is pinned in QEMU's Meson graph.
fi

emconfigure "$source_dir/configure" \
  --static \
  --target-list="$qemu_target" \
  --cpu=wasm32 \
  --cross-prefix= \
  --without-default-features \
  --enable-system \
  --enable-pixman \
  --enable-sdl \
  --disable-sdl-image \
  --enable-fdt \
  --enable-virtfs \
  "${graphics_configure_flags[@]}" \
  --with-coroutine=fiber \
  --extra-cflags="$common_flags_string" \
  --extra-cxxflags="$common_flags_string" \
  --extra-ldflags="$extra_ldflags"

grep -Eq '^#define CONFIG_SDL( 1)?$' config-host.h || {
  printf 'QEMU configure completed without CONFIG_SDL in config-host.h\n' >&2
  exit 1
}
if [[ -n "$webgl_build" ]]; then
  grep -Eq '^#define CONFIG_OPENGL( 1)?$' config-host.h || {
    printf 'VirGL experiment configured without CONFIG_OPENGL\n' >&2
    exit 1
  }
  grep -Fq '/build/target/lib/libvirglrenderer.a' build.ninja &&
    grep -Fq 'virtio-gpu-virgl.c' build.ninja || {
    printf 'VirGL experiment configured without the pinned renderer/device sources\n' >&2
    exit 1
  }
fi

emmake make -j "$jobs" "$qemu_executable"
node "$runtime_dir/scripts/patch-generated-qemu.mjs" "$qemu_executable"

install -m 0644 "$qemu_executable" "$output_dir/qemu.mjs"
install -m 0644 "$qemu_executable.wasm" "$output_dir/qemu.wasm"
install -m 0644 "$qemu_executable.worker.js" "$output_dir/qemu.worker.js"

if [[ "$qemu_architecture" == "x86_64" ]]; then
  for firmware in bios-256k.bin vgabios-stdvga.bin vgabios-virtio.bin kvmvapic.bin linuxboot_dma.bin; do
    install -m 0644 "$source_dir/pc-bios/$firmware" "$output_dir/firmware/$firmware"
  done
fi

chown -R "$output_uid:$output_gid" "$output_dir"
