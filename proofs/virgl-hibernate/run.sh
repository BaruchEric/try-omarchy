#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$proof_dir/../.." && pwd)
guest_dir=${VIRGL_HIBERNATE_GUEST_DIST:-$repo_dir/guest/dist}
builder_image=${VIRGL_HIBERNATE_BUILDER_IMAGE:-omarchy-qemu-native-virgl:qemu-8.2}
qemu_bin="$proof_dir/.build/qemu-8.2-native-virgl/qemu-system-x86_64"
qemu_img="$proof_dir/.build/qemu-8.2-native-virgl/qemu-img"
browser_qemu_wasm=${VIRGL_HIBERNATE_BROWSER_QEMU_WASM:-}
evidence_root=${VIRGL_HIBERNATE_EVIDENCE_ROOT:-$proof_dir/evidence}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-virgl-hibernate-$$
evidence_dir="$evidence_root/$run_id"
nonce=${VIRGL_HIBERNATE_NONCE:-$(openssl rand -hex 32)}

fail() {
  printf 'VIRGL_HIBERNATE_FAIL %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
[[ ${VIRGL_HIBERNATE_VCPUS:-2} == 2 ]] || fail "the proof requires exactly two vCPUs"
[[ $nonce =~ ^[0-9a-f]{64}$ ]] || fail "nonce must contain exactly 64 lowercase hexadecimal characters"
[[ -x $qemu_bin && -x $qemu_img ]] || fail "run build-pinned-qemu.sh first"
[[ -n $browser_qemu_wasm ]] || \
  fail "VIRGL_HIBERNATE_BROWSER_QEMU_WASM must explicitly select the bounded-CLOCK VirGL candidate"
[[ -f $browser_qemu_wasm ]] || fail "browser QEMU Wasm is missing: $browser_qemu_wasm"
[[ $(basename "$browser_qemu_wasm") == qemu.wasm ]] \
  || fail "VIRGL_HIBERNATE_BROWSER_QEMU_WASM must point directly to qemu.wasm"
[[ -f $guest_dir/rootfs.ext4 ]] || fail "canonical guest distribution is missing: $guest_dir"
browser_candidate_dir=$(cd "$(dirname "$browser_qemu_wasm")" && pwd -P)
browser_qemu_wasm="$browser_candidate_dir/qemu.wasm"
candidate_validation=$(mktemp)
outer_validation=
cleanup_host() {
  rm -f "$candidate_validation"
  [[ -z ${outer_validation:-} ]] || rm -f "$outer_validation"
}
trap cleanup_host EXIT
node "$proof_dir/validate-browser-candidate.mjs" "$browser_qemu_wasm" >"$candidate_validation" \
  || fail "selected browser Wasm is not the exact VirGL/bounded-CLOCK candidate"
browser_qemu_wasm_sha256=$(node -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).qemuWasmSha256" \
  "$candidate_validation")
[[ $browser_qemu_wasm_sha256 =~ ^[0-9a-f]{64}$ ]] || fail "candidate validator returned an invalid digest"
mkdir -p "$evidence_dir"

docker run --rm --init --platform linux/amd64 \
  --volume "$repo_dir:/repo:ro" \
  --volume "$proof_dir:/proof" \
  --volume "$guest_dir:/guest:ro" \
  --volume "$browser_candidate_dir:/browser-candidate:ro" \
  --workdir /proof \
  --env "EVIDENCE_DIR=/proof/evidence/$run_id" \
  --env "HIBERNATION_NONCE=$nonce" \
  --env "SOURCE_TIMEOUT_SECONDS=${VIRGL_HIBERNATE_SOURCE_TIMEOUT_SECONDS:-1200}" \
  --env "TARGET_TIMEOUT_SECONDS=${VIRGL_HIBERNATE_TARGET_TIMEOUT_SECONDS:-600}" \
  --env "DESKTOP_TIMEOUT_SECONDS=${VIRGL_HIBERNATE_DESKTOP_TIMEOUT_SECONDS:-900}" \
  --env BROWSER_QEMU_WASM_PATH=/browser-candidate/qemu.wasm \
  --env "BROWSER_QEMU_WASM_EXPECTED_SHA256=$browser_qemu_wasm_sha256" \
  --env OMARCHY_REPO_ROOT=/repo \
  --env LIBGL_ALWAYS_SOFTWARE=1 \
  --env GALLIUM_DRIVER=llvmpipe \
  "$builder_image" \
  bash /proof/run-inside-container.sh

outer_validation=$(mktemp)
node "$proof_dir/validate.mjs" "$guest_dir" "$evidence_dir" "$browser_qemu_wasm" \
  >"$outer_validation"
cmp -s "$evidence_dir/container-validation.json" "$outer_validation" \
  || fail "outer indexed validation is not deterministic"
rm -f "$outer_validation"
outer_validation=
rm -f "$candidate_validation"
candidate_validation=
trap - EXIT
printf '%s\n' "$run_id" >"$evidence_root/latest.txt"
printf 'VIRGL_HIBERNATE_PASS evidence=%s\n' "$evidence_dir"
