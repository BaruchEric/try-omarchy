#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: fetch-source.sh --destination DIR [--spec SPEC]"
}

fail() {
  echo "fetch-source: $*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "$0")" && pwd)
guest_dir=$(cd "$script_dir/.." && pwd)
spec="$guest_dir/spec.json"
destination=""

while (($#)); do
  case "$1" in
    --destination)
      destination=${2:-}
      shift 2
      ;;
    --spec)
      spec=${2:-}
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

[[ -n $destination ]] || fail "--destination is required"
[[ $destination == /* ]] || fail "--destination must be absolute"
[[ -f $spec ]] || fail "spec not found: $spec"
command -v git >/dev/null || fail "git is required"

repository=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream"]["repository"])' "$spec")
commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream"]["commit"])' "$spec")
tree=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream"]["tree"])' "$spec")

if [[ -d $destination/.git ]]; then
  actual_commit=$(git -C "$destination" rev-parse HEAD)
  actual_tree=$(git -C "$destination" rev-parse 'HEAD^{tree}')
  if [[ $actual_commit == "$commit" && $actual_tree == "$tree" && -z $(git -C "$destination" status --porcelain --untracked-files=all) ]]; then
    echo "Using verified Omarchy checkout at $destination"
    exit 0
  fi
  fail "existing destination is not the clean pinned Omarchy checkout: $destination"
fi

if [[ -e $destination ]]; then
  [[ -d $destination && -z $(find "$destination" -mindepth 1 -maxdepth 1 -print -quit) ]] || \
    fail "destination exists and is not empty: $destination"
else
  mkdir -p "$destination"
fi

git -C "$destination" init --quiet
git -C "$destination" remote add origin "$repository.git"
git -C "$destination" fetch --quiet --depth 1 origin "$commit"
git -C "$destination" checkout --quiet --detach FETCH_HEAD

actual_commit=$(git -C "$destination" rev-parse HEAD)
actual_tree=$(git -C "$destination" rev-parse 'HEAD^{tree}')
[[ $actual_commit == "$commit" ]] || fail "downloaded commit mismatch"
[[ $actual_tree == "$tree" ]] || fail "downloaded tree mismatch"
echo "Fetched verified Omarchy $commit"
