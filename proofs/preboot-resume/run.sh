#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
guest_dir=${PREBOOT_GUEST_DIST:-$repo_dir/guest/dist}
builder_image=${QEMU_NATIVE_BUILDER_IMAGE:-omarchy-qemu-native-builder:qemu-8.2}
qemu_bin="$proof_dir/.build/qemu-8.2-native/qemu-system-x86_64"
qemu_img="$proof_dir/.build/qemu-8.2-native/qemu-img"
evidence_root=${PREBOOT_EVIDENCE_ROOT:-$proof_dir/evidence}
vcpus=${PREBOOT_VCPUS:-1}
proof_scope=${PREBOOT_PROOF_SCOPE:-browser-topology-resume-proof}
migration_compression=${PREBOOT_MIGRATION_COMPRESSION:-none}
if [[ $vcpus == 1 ]]; then
  topology_label=browser-1vcpu
else
  topology_label=mechanism-${vcpus}vcpu
fi
case $migration_compression in
  none) migration_label=raw-incoming ;;
  legacy) migration_label=legacy-compress ;;
  *) printf 'PREBOOT_RESUME_FAIL PREBOOT_MIGRATION_COMPRESSION must be none or legacy\n' >&2; exit 1 ;;
esac
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$topology_label-$migration_label-$$
evidence_dir="$evidence_root/$run_id"

fail() {
  printf 'PREBOOT_RESUME_FAIL %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v node >/dev/null 2>&1 || fail "node is required"
[[ $vcpus =~ ^[1-9][0-9]*$ ]] || fail "PREBOOT_VCPUS must be a positive integer"
[[ -x "$qemu_bin" ]] || fail "run build-pinned-qemu.sh first"
[[ -x "$qemu_img" ]] || fail "run build-pinned-qemu.sh to build pinned qemu-img"
[[ -f "$guest_dir/rootfs.ext4" ]] || fail "exact guest distribution not found: $guest_dir"
mkdir -p "$evidence_dir"

docker run --rm --init --platform linux/amd64 \
  --volume "$repo_dir:/repo:ro" \
  --volume "$proof_dir:/proof" \
  --volume "$guest_dir:/guest:ro" \
  --workdir /proof \
  --env "EVIDENCE_DIR=/proof/evidence/$run_id" \
  --env "PREBOOT_TIMEOUT_SECONDS=${PREBOOT_TIMEOUT_SECONDS:-900}" \
  --env "PREBOOT_VCPUS=$vcpus" \
  --env "PREBOOT_PROOF_SCOPE=$proof_scope" \
  --env "PREBOOT_MIGRATION_COMPRESSION=$migration_compression" \
  "$builder_image" \
  bash /proof/run-inside-container.sh

node "$proof_dir/inspect-wasm-support.mjs" "$repo_dir" \
  >"$evidence_dir/wasm-incoming-support.json"
node "$proof_dir/validate.mjs" "$guest_dir" "$evidence_dir" >"$evidence_dir/validation.json"
printf '%s\n' "$run_id" >"$evidence_root/latest.txt"
printf 'PREBOOT_RESUME_PASS evidence=%s\n' "$evidence_dir"
