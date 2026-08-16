#!/bin/bash

set -euo pipefail

fail() {
  echo "guest-arm64-container-build: $*" >&2
  exit 1
}

guest_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$guest_dir/.." && pwd)
output="$guest_dir/dist-aarch64"
work_volume=""
dry_run=0

while (($#)); do
  case "$1" in
    --output)
      output=${2:-}
      shift 2
      ;;
    --work-volume)
      work_volume=${2:-}
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      echo "Usage: guest/build-arm64-container.sh [--output DIR] [--work-volume NAME] [--dry-run]"
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [[ -z $work_volume ]]; then
  repo_checksum=$(printf '%s' "$repo_dir" | cksum)
  repo_checksum=${repo_checksum%% *}
  work_volume="omarchy-arm64-guest-work-$repo_checksum"
fi
[[ $work_volume =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "invalid Docker volume name: $work_volume"

if (( dry_run )); then
  printf 'architecture=aarch64\nplatform=linux/arm64\noutput=%s\nwork-volume=%s\n' "$output" "$work_volume"
  exit 0
fi

command -v docker >/dev/null || fail "docker is required"
mkdir -p "$output"
output=$(cd "$output" && pwd)
docker volume create --label com.basecamp.omarchy-web.role=guest-work "$work_volume" >/dev/null

builder_image=omarchy-arm64-guest-builder
docker build --platform linux/arm64 -f "$guest_dir/Containerfile.aarch64" -t "$builder_image" "$repo_dir"
builder_digest=$(docker image inspect --format '{{.Id}}' "$builder_image")
docker run --rm --platform linux/arm64 --privileged \
  -e OMARCHY_BUILDER_IMAGE_DIGEST="$builder_digest" \
  -e OMARCHY_PACMAN_DISABLE_SANDBOX=1 \
  -v "$repo_dir:/workspace:ro" \
  -v "$output:/output" \
  -v "$work_volume:/work" \
  "$builder_image" \
  --output /output --work /work
