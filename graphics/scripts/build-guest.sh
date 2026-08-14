#!/bin/bash
set -euo pipefail

graphics_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$graphics_dir/.." && pwd)
lock_file="$graphics_dir/versions.lock.json"
source_dir=${OMARCHY_SOURCE:-/private/tmp/omarchy-source-inspected}
out_dir=${GRAPHICS_OUT:-$graphics_dir/out}

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
[[ -d $source_dir ]] || { echo "Omarchy source not found: $source_dir" >&2; exit 1; }

expected_commit=$(jq -r '.omarchy.commit' "$lock_file")
actual_commit=$(git -C "$source_dir" rev-parse HEAD)
[[ $actual_commit == "$expected_commit" ]] || {
  echo "Omarchy source mismatch: expected $expected_commit, got $actual_commit" >&2
  exit 1
}

mkdir -p "$out_dir"
mkdir -p "$graphics_dir/.cache/pacman"
source_dir=$(cd "$source_dir" && pwd)
out_dir=$(cd "$out_dir" && pwd)
builder_image=$(jq -r '.builder.image' "$lock_file")

docker run --rm --platform linux/amd64 \
  --volume "$source_dir:/omarchy:ro" \
  --volume "$graphics_dir:/graphics:ro" \
  --volume "$graphics_dir/.cache/pacman:/pkg-cache" \
  --volume "$out_dir:/out" \
  --env "OUTPUT_UID=$(id -u)" \
  --env "OUTPUT_GID=$(id -g)" \
  --env "IMAGE_SIZE_MIB=${IMAGE_SIZE_MIB:-3072}" \
  "$builder_image" \
  /bin/bash /graphics/scripts/build-in-container.sh

printf 'Graphics guest built in %s\n' "$out_dir"
printf 'Next: %s/scripts/run-smoke.sh\n' "$graphics_dir"
