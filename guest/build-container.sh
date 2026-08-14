#!/bin/bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: guest/build-container.sh [options]

  --output DIR         Host artifact directory (default: guest/dist)
  --work DIR           Linux-only host build directory
  --work-volume NAME   Persistent Docker build volume
  --dry-run            Print the selected storage plan without using Docker

Builds the x86_64 image in a privileged Arch container. Linux x86_64 is the
supported release builder. Docker Desktop uses a Docker-managed volume for the
Linux rootfs work tree and keeps only final artifacts on the host filesystem.
USAGE
}

fail() {
  echo "guest-container-build: $*" >&2
  exit 1
}

guest_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$guest_dir/.." && pwd)
output="$guest_dir/dist"
work="$guest_dir/.work-container"
work_set=0
work_volume=""
work_volume_set=0
dry_run=0

while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || fail "--output requires a directory"
      output=${2:-}
      [[ -n $output ]] || fail "--output requires a directory"
      shift 2
      ;;
    --work)
      (($# >= 2)) || fail "--work requires a directory"
      work=${2:-}
      [[ -n $work ]] || fail "--work requires a directory"
      work_set=1
      shift 2
      ;;
    --work-volume)
      (($# >= 2)) || fail "--work-volume requires a name"
      work_volume=${2:-}
      [[ -n $work_volume ]] || fail "--work-volume requires a name"
      work_volume_set=1
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

(( ! (work_set && work_volume_set) )) || fail "--work and --work-volume are mutually exclusive"

host_os=${OMARCHY_CONTAINER_HOST_OS:-$(uname -s)}
if (( work_volume_set )); then
  work_storage=volume
elif [[ $host_os == Linux ]]; then
  work_storage=bind
else
  (( ! work_set )) || fail "--work is unsafe for a pacstrap rootfs on $host_os; use --work-volume NAME"
  work_storage=volume
  repo_checksum=$(printf '%s' "$repo_dir" | cksum)
  repo_checksum=${repo_checksum%% *}
  work_volume="omarchy-web-guest-work-$repo_checksum"
fi

if [[ $work_storage == volume ]]; then
  [[ $work_volume =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "invalid Docker volume name: $work_volume"
  work_source=$work_volume
else
  work_source=$work
fi

if (( dry_run )); then
  printf 'host-os=%s\n' "$host_os"
  printf 'output=%s\n' "$output"
  printf 'work-storage=%s\n' "$work_storage"
  printf 'work-source=%s\n' "$work_source"
  exit 0
fi

command -v docker >/dev/null || fail "docker is required"
mkdir -p "$output"
output=$(cd "$output" && pwd)
if [[ $work_storage == bind ]]; then
  mkdir -p "$work"
  work=$(cd "$work" && pwd)
  work_source=$work
else
  docker volume create \
    --label com.basecamp.omarchy-web.role=guest-work \
    "$work_volume" >/dev/null
fi

builder_image=omarchy-web-guest-builder
docker build --platform linux/amd64 -f "$guest_dir/Containerfile" -t "$builder_image" "$repo_dir"
builder_digest=$(docker image inspect --format '{{.Id}}' "$builder_image")
docker run --rm --platform linux/amd64 --privileged \
  -e OMARCHY_BUILDER_IMAGE_DIGEST="$builder_digest" \
  -e OMARCHY_PACMAN_DISABLE_SANDBOX=1 \
  -v "$repo_dir:/workspace:ro" \
  -v "$output:/output" \
  -v "$work_source:/work" \
  "$builder_image" \
  --output /output --work /work
