#!/usr/bin/env bash
set -euo pipefail

target="${TARGET:-/build/target}"
runtime_dir="${RUNTIME_DIR:-/runtime}"
virgl_source="${VIRGL_SOURCE:-/virglrenderer-src}"
virgl_commit=88b9fe3bfc64b23a701e4875006dbc0e769f14f6
build_root=/build/omarchy-webgl-virgl-dependencies
cross_file="$build_root/cross.meson"
virgl_worktree="$build_root/virglrenderer-src"

[[ -f "$virgl_source/meson.build" ]] || {
  printf 'missing pinned VirGL source at %s\n' "$virgl_source" >&2
  exit 1
}
[[ -f "$runtime_dir/toolchain/webgl-epoxy/epoxy-webgl.c" ]] || {
  printf 'missing WebGL epoxy compatibility source\n' >&2
  exit 1
}
actual_commit="$(git -C "$virgl_source" rev-parse HEAD)"
[[ "$actual_commit" == "$virgl_commit" ]] || {
  printf 'VirGL commit mismatch: expected %s, got %s\n' "$virgl_commit" "$actual_commit" >&2
  exit 1
}

rm -rf -- "$build_root"
mkdir -p \
  "$build_root" \
  "$target/include/epoxy" \
  "$target/lib/pkgconfig"

cat >"$cross_file" <<'EOF'
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']

[built-in options]
c_args = ['-Wno-error=unused-command-line-argument']
c_link_args = ['-Wno-error=unused-command-line-argument']
EOF

mkdir -p "$virgl_worktree"
git -C "$virgl_source" archive "$virgl_commit" | tar -x -C "$virgl_worktree"
patch --quiet --directory "$virgl_worktree" --strip=1 \
  < "$runtime_dir/patches/virglrenderer-webgl-platform.patch"
patch --quiet --directory "$virgl_worktree" --strip=1 \
  < "$runtime_dir/patches/virglrenderer-webgl-winsys.patch"
patch --quiet --directory "$virgl_worktree" --strip=1 \
  < "$runtime_dir/patches/virglrenderer-webgl-no-vtest.patch"
patch --quiet --directory "$virgl_worktree" --strip=1 \
  < "$runtime_dir/patches/virglrenderer-webgl-capabilities.patch"

install -m 0644 "$runtime_dir"/toolchain/webgl-epoxy/include/epoxy/*.h \
  "$target/include/epoxy/"
install -m 0644 "$runtime_dir/toolchain/webgl-epoxy/include/gbm.h" \
  "$target/include/gbm.h"
install -m 0644 "$runtime_dir/toolchain/webgl-epoxy/epoxy.pc" \
  "$target/lib/pkgconfig/epoxy.pc"
install -m 0644 "$runtime_dir/toolchain/webgl-epoxy/libdrm.pc" \
  "$target/lib/pkgconfig/libdrm.pc"

emcc ${CFLAGS:-} \
  -I"$target/include" \
  -c "$runtime_dir/toolchain/webgl-epoxy/epoxy-webgl.c" \
  -o "$build_root/epoxy-webgl.o"
emar rcs "$target/lib/libepoxy-webgl.a" "$build_root/epoxy-webgl.o"
emranlib "$target/lib/libepoxy-webgl.a"

meson setup "$build_root/virgl" "$virgl_worktree" \
  --prefix="$target" \
  --cross-file="$cross_file" \
  --default-library=static \
  --buildtype=release \
  -Dplatforms=[] \
  -Dvenus-experimental=false \
  -Ddrm-msm-experimental=false \
  -Drender-server=false \
  -Dvideo=false \
  -Dtests=false \
  -Dfuzzer=false \
  -Dtracing=none
meson compile -C "$build_root/virgl"
meson install -C "$build_root/virgl"

test -f "$target/lib/libvirglrenderer.a"
test -f "$target/lib/pkgconfig/virglrenderer.pc"
printf 'Pinned VirGL %s and WebGL epoxy shim installed in %s\n' \
  "$virgl_commit" "$target"
