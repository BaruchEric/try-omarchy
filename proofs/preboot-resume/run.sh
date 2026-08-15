#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
guest_dir=${PREBOOT_GUEST_DIST:-$repo_dir/guest/dist}
builder_image=${QEMU_NATIVE_BUILDER_IMAGE:-omarchy-qemu-native-builder:qemu-8.2}
qemu_bin="$proof_dir/.build/qemu-8.2-native/qemu-system-x86_64"
qemu_img="$proof_dir/.build/qemu-8.2-native/qemu-img"
evidence_root=${PREBOOT_EVIDENCE_ROOT:-$proof_dir/evidence}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-qemu8-2vcpu-mttcg-raw-auto-$$
evidence_dir="$evidence_root/$run_id"

fail() {
  printf 'PREBOOT_RESUME_FAIL %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v node >/dev/null 2>&1 || fail "node is required"
[[ ${PREBOOT_VCPUS:-2} == 2 ]] || fail "canonical checkpoint profile requires exactly PREBOOT_VCPUS=2"
[[ ${PREBOOT_MIGRATION_COMPRESSION:-none} == none ]] || fail "canonical checkpoint must be raw/uncompressed"
[[ -x $qemu_bin && -x $qemu_img ]] || fail "run build-pinned-qemu.sh first"
[[ -f $guest_dir/rootfs.ext4 ]] || fail "canonical guest distribution not found: $guest_dir"
mkdir -p "$evidence_dir"

docker run --rm --init --platform linux/amd64 \
  --volume "$repo_dir:/repo:ro" \
  --volume "$proof_dir:/proof" \
  --volume "$guest_dir:/guest:ro" \
  --workdir /proof \
  --env "EVIDENCE_DIR=/proof/evidence/$run_id" \
  --env "PREBOOT_TIMEOUT_SECONDS=${PREBOOT_TIMEOUT_SECONDS:-900}" \
  --env "OMARCHY_REPO_ROOT=/repo" \
  "$builder_image" \
  bash /proof/run-inside-container.sh

node "$proof_dir/validate.mjs" "$guest_dir" "$evidence_dir" >"$evidence_dir/validation.json"
printf '%s\n' "$run_id" >"$evidence_root/latest.txt"
printf 'PREBOOT_RESUME_PASS evidence=%s\n' "$evidence_dir"
