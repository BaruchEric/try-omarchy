#!/usr/bin/env bash
set -euo pipefail

source_dir=/qemu-src
output_dir=/out
runtime_dir=/runtime
build_dir=/build/omarchy-qemu-wasm
jobs="${BUILD_JOBS:-2}"
output_uid="${OUTPUT_UID:-0}"
output_gid="${OUTPUT_GID:-0}"

[[ -f "$source_dir/configure" ]] || { printf 'missing %s/configure\n' "$source_dir" >&2; exit 1; }
[[ -x "$runtime_dir/toolchain/sdl2-config" ]] || { printf 'missing SDL2 config shim\n' >&2; exit 1; }
[[ -f "$runtime_dir/toolchain/worker-screen-library.js" ]] || {
  printf 'missing Worker screen-size Emscripten library\n' >&2
  exit 1
}
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { printf 'BUILD_JOBS must be a positive integer\n' >&2; exit 1; }
qemu_target=x86_64-softmmu
qemu_executable=qemu-system-x86_64

mkdir -p "$build_dir" "$output_dir/firmware"
cd "$build_dir"

export SDL2_CONFIG="$runtime_dir/toolchain/sdl2-config"
export EM_CACHE=/build/emscripten-cache

# Warm the Emscripten SDL port explicitly. This also makes a missing network or
# broken toolchain fail before the much longer QEMU compilation begins.
embuilder build sdl2

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
common_flags_string="${common_flags[*]}"

extra_ldflags="-sEXPORTED_RUNTIME_METHODS=FS,getTempRet0,setTempRet0,addFunction,removeFunction --js-library=$runtime_dir/toolchain/worker-screen-library.js"

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
  --with-coroutine=fiber \
  --extra-cflags="$common_flags_string" \
  --extra-cxxflags="$common_flags_string" \
  --extra-ldflags="$extra_ldflags"

grep -Eq '^#define CONFIG_SDL( 1)?$' config-host.h || {
  printf 'QEMU configure completed without CONFIG_SDL in config-host.h\n' >&2
  exit 1
}
emmake make -j "$jobs" "$qemu_executable"
node "$runtime_dir/scripts/patch-generated-qemu.mjs" "$qemu_executable"

install -m 0644 "$qemu_executable" "$output_dir/qemu.mjs"
install -m 0644 "$qemu_executable.wasm" "$output_dir/qemu.wasm"
install -m 0644 "$qemu_executable.worker.js" "$output_dir/qemu.worker.js"

for firmware in bios-256k.bin vgabios-stdvga.bin vgabios-virtio.bin kvmvapic.bin linuxboot_dma.bin; do
  install -m 0644 "$source_dir/pc-bios/$firmware" "$output_dir/firmware/$firmware"
done

chown -R "$output_uid:$output_gid" "$output_dir"
