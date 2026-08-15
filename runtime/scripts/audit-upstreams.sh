#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qemu_source="${1:-${QEMU_WASM_SOURCE:-/private/tmp/qemu-wasm-source}}"
container_source="${2:-${CONTAINER2WASM_SOURCE:-/private/tmp/container2wasm-source}}"

fail() {
  printf 'runtime upstream audit: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail 'git is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -d "$qemu_source/.git" ]] || fail "QEMU-Wasm source is not a git checkout: $qemu_source"

expected_qemu="$(jq -r '.qemuWasm.commit' "$runtime_dir/upstream.lock.json")"
actual_qemu="$(git -C "$qemu_source" rev-parse HEAD)"
[[ "$actual_qemu" == "$expected_qemu" ]] || fail "QEMU-Wasm commit is $actual_qemu; expected $expected_qemu"

[[ -f "$qemu_source/util/coroutine-fiber.c" ]] || fail 'QEMU-Wasm fiber coroutine port is missing'
[[ -f "$qemu_source/ui/sdl2.c" ]] || fail 'QEMU SDL2 display frontend is missing'
grep -q 'Multi-Threaded TCG' "$qemu_source/README.md" || fail 'QEMU-Wasm MTTCG claim is missing'
grep -q "'sdl2-2d.c'" "$qemu_source/ui/meson.build" || fail 'SDL 2D frontend is not wired into the build'
grep -q '^config VIRTIO_GPU' "$qemu_source/hw/display/Kconfig" || fail 'virtio-gpu device is missing'

for subproject in dtc keycodemapdb berkeley-softfloat-3 berkeley-testfloat-3; do
  wrap="$qemu_source/subprojects/$subproject.wrap"
  [[ -f "$wrap" ]] || fail "QEMU $subproject wrap is missing"
  wrap_url="$(awk -F ' *= *' '$1 == "url" { print $2; exit }' "$wrap")"
  wrap_revision="$(awk -F ' *= *' '$1 == "revision" { print $2; exit }' "$wrap")"
  expected_url="$(jq -r --arg name "$subproject" '.qemuSubprojects[$name].repository' \
    "$runtime_dir/upstream.lock.json")"
  expected_revision="$(jq -r --arg name "$subproject" '.qemuSubprojects[$name].commit' \
    "$runtime_dir/upstream.lock.json")"
  [[ "$wrap_url" == "$expected_url" ]] || fail "$subproject wrap URL is $wrap_url; expected $expected_url"
  [[ "$wrap_revision" == "$expected_revision" ]] || {
    fail "$subproject wrap revision is $wrap_revision; expected $expected_revision"
  }
done

printf 'QEMU-Wasm %s: x86_64 TCG, fibers, SDL2, and virtio-gpu source gates passed.\n' "$actual_qemu"

if [[ -d "$container_source/.git" ]]; then
  expected_container="$(jq -r '.container2wasmReference.commit' "$runtime_dir/upstream.lock.json")"
  actual_container="$(git -C "$container_source" rev-parse HEAD)"
  [[ "$actual_container" == "$expected_container" ]] || fail "container2wasm commit is $actual_container; expected $expected_container"

  args="$container_source/config/qemu/args-x86_64.json.template"
  kernel_config="$container_source/config/qemu/linux_x86_config"
  grep -q '"-nographic"' "$args" || fail 'reference runtime no longer has the expected headless flag; re-audit it'
  grep -q '^# CONFIG_DRM is not set$' "$kernel_config" || fail 'reference kernel DRM state changed; re-audit it'
  printf 'container2wasm %s: confirmed reference is headless with DRM disabled.\n' "$actual_container"
else
  printf 'container2wasm reference not present at %s; skipped reference-only checks.\n' "$container_source"
fi
