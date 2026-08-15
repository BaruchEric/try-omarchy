#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
guest_dir=${PREBOOT_GUEST_DIST:-$repo_dir/guest/dist}
builder_image=${QEMU_NATIVE_BUILDER_IMAGE:-omarchy-qemu-native-builder:qemu-8.2}
source_argument=${1:-}

fail() {
  printf 'PREBOOT_EXISTING_FAIL %s\n' "$*" >&2
  exit 1
}

[[ -n $source_argument ]] || fail "usage: resume-existing.sh EVIDENCE_DIRECTORY"
[[ -d $source_argument ]] || fail "evidence directory does not exist: $source_argument"
source_evidence=$(cd "$source_argument" && pwd)
case $source_evidence in
  "$proof_dir"/evidence/*) ;;
  *) fail "evidence directory must be below $proof_dir/evidence" ;;
esac
[[ -f $source_evidence/omarchy-preboot.vmstate ]] || fail "vmstate is missing"
[[ -f $source_evidence/checkpoint-overlay.qcow2 ]] || fail "paired checkpoint overlay is missing"
[[ -f $guest_dir/rootfs.ext4 ]] || fail "guest artifacts are missing: $guest_dir"

source_relative=${source_evidence#"$proof_dir/"}
smoke_id=deferred-resume-$(date -u +%Y%m%dT%H%M%SZ)-$$
output_dir="$source_evidence/$smoke_id"
mkdir -p "$output_dir"

docker run --rm --init --platform linux/amd64 \
  --volume "$repo_dir:/repo:ro" \
  --volume "$proof_dir:/proof" \
  --volume "$guest_dir:/guest:ro" \
  --workdir /proof \
  --env "SOURCE_EVIDENCE=/proof/$source_relative" \
  --env "OUTPUT_DIR=/proof/$source_relative/$smoke_id" \
  "$builder_image" \
  bash /proof/resume-existing-inside-container.sh

printf 'PREBOOT_EXISTING_PASS evidence=%s\n' "$output_dir"
