#!/bin/bash

set -euo pipefail

fail() {
  echo "guest-arm64-container-build: $*" >&2
  exit 1
}

guest_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$guest_dir/.." && pwd)
spec="$guest_dir/spec.aarch64.json"
output=""
output_set=0
work_volume=""
refresh_package_lock=""
dry_run=0

while (($#)); do
  case "$1" in
    --output)
      output=${2:-}
      output_set=1
      shift 2
      ;;
    --spec)
      spec=${2:-}
      shift 2
      ;;
    --work-volume)
      work_volume=${2:-}
      shift 2
      ;;
    --refresh-package-lock)
      refresh_package_lock=${2:-}
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: guest/build-arm64-container.sh [options]

  --spec FILE                    ARM64 build spec (default: spec.aarch64.json)
  --output DIR                   Artifact directory (profile-specific default)
  --work-volume NAME             Persistent Docker build/cache volume
  --refresh-package-lock FILE    Resolve the spec transaction to FILE; do not build
  --dry-run                      Print the selected immutable build plan
USAGE
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -f $spec ]] || fail "spec not found: $spec"
spec=$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")
case "$spec" in
  "$guest_dir"/*) ;;
  *) fail "--spec must resolve inside $guest_dir" ;;
esac
container_spec="/workspace/guest/${spec#"$guest_dir/"}"
plan_fields=$(python3 - "$spec" <<'PY'
import json
import pathlib
import sys

spec = json.loads(pathlib.Path(sys.argv[1]).read_text())
architecture = spec["image"]["architecture"]
profile = spec["guest"].get("profile", "demo")
if architecture != "aarch64":
    raise SystemExit(f"ARM builder requires an aarch64 spec, got {architecture}")
if profile not in {"demo", "factory"}:
    raise SystemExit(f"unsupported ARM guest profile: {profile}")
print(f"{architecture}\t{profile}")
PY
) || fail "invalid ARM64 build spec"
IFS=$'\t' read -r architecture profile <<<"$plan_fields"
[[ -n $architecture && -n $profile ]] || fail "could not read ARM64 build spec"

if [[ -z $output ]]; then
  if [[ $profile == factory ]]; then
    output="$guest_dir/dist-aarch64-unprovisioned"
  else
    output="$guest_dir/dist-aarch64"
  fi
fi

if [[ -n $refresh_package_lock && $output_set == 1 ]]; then
  fail "--output and --refresh-package-lock are mutually exclusive"
fi

if [[ -z $work_volume ]]; then
  repo_checksum=$(printf '%s' "$repo_dir" | cksum)
  repo_checksum=${repo_checksum%% *}
  work_volume="omarchy-arm64-guest-work-$repo_checksum"
fi
[[ $work_volume =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "invalid Docker volume name: $work_volume"

if (( dry_run )); then
  printf 'architecture=%s\nplatform=linux/arm64\nprofile=%s\nspec=%s\noutput=%s\nwork-volume=%s\n' \
    "$architecture" "$profile" "$spec" "$output" "$work_volume"
  if [[ -n $refresh_package_lock ]]; then
    printf 'mode=refresh-package-lock\npackage-lock-output=%s\n' "$refresh_package_lock"
  else
    printf 'mode=build\n'
  fi
  exit 0
fi

command -v docker >/dev/null || fail "docker is required"

builder_image=omarchy-arm64-guest-builder
docker build --platform linux/arm64 -f "$guest_dir/Containerfile.aarch64" -t "$builder_image" "$repo_dir"
builder_digest=$(docker image inspect --format '{{.Id}}' "$builder_image")

if [[ -n $refresh_package_lock ]]; then
  lock_name=$(basename "$refresh_package_lock")
  [[ -n $lock_name && $lock_name != . && $lock_name != .. ]] || fail "invalid package lock output"
  lock_parent=$(dirname "$refresh_package_lock")
  mkdir -p "$lock_parent"
  lock_parent=$(cd "$lock_parent" && pwd)
  docker run --rm --platform linux/arm64 \
    --entrypoint /workspace/guest/scripts/refresh-package-lock.sh \
    -e OMARCHY_PACMAN_DISABLE_SANDBOX=1 \
    -v "$repo_dir:/workspace:ro" \
    -v "$lock_parent:/lock-output" \
    "$builder_image" \
    --spec "$container_spec" --output "/lock-output/$lock_name"
  exit 0
fi

mkdir -p "$output"
output=$(cd "$output" && pwd)
docker volume create --label com.basecamp.omarchy-web.role=guest-work "$work_volume" >/dev/null
docker run --rm --platform linux/arm64 --privileged \
  -e OMARCHY_BUILDER_IMAGE_DIGEST="$builder_digest" \
  -e OMARCHY_PACMAN_DISABLE_SANDBOX=1 \
  -v "$repo_dir:/workspace:ro" \
  -v "$output:/output" \
  -v "$work_volume:/work" \
  "$builder_image" \
  --spec "$container_spec" --output /output --work /work
