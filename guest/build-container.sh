#!/bin/bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: guest/build-container.sh [--output DIR] [--work DIR]

Builds the x86_64 image in a privileged Arch container. Linux x86_64 is the
supported release builder; Docker Desktop can run this slowly for development.
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

while (($#)); do
  case "$1" in
    --output)
      output=${2:-}
      shift 2
      ;;
    --work)
      work=${2:-}
      shift 2
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

command -v docker >/dev/null || fail "docker is required"
mkdir -p "$output" "$work"
output=$(cd "$output" && pwd)
work=$(cd "$work" && pwd)

docker build --platform linux/amd64 -f "$guest_dir/Containerfile" -t omarchy-web-guest-builder "$repo_dir"
docker run --rm --platform linux/amd64 --privileged \
  -e OMARCHY_BUILDER_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' omarchy-web-guest-builder)" \
  -e OMARCHY_PACMAN_DISABLE_SANDBOX=1 \
  -v "$repo_dir:/workspace:ro" \
  -v "$output:/output" \
  -v "$work:/work" \
  omarchy-web-guest-builder \
  --output /output --work /work
