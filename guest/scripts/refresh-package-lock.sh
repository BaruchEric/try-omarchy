#!/bin/bash

# Resolve, but do not download, the complete package transaction. Write to a
# review path first; replacing the checked-in lock is an intentional update.
set -euo pipefail

usage() {
  echo "Usage: refresh-package-lock.sh --source OMARCHY_SOURCE --output FILE"
}

fail() {
  echo "refresh-package-lock: $*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "$0")" && pwd)
guest_dir=$(cd "$script_dir/.." && pwd)
source_dir=""
output=""

while (($#)); do
  case "$1" in
    --source)
      source_dir=${2:-}
      shift 2
      ;;
    --output)
      output=${2:-}
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

[[ -n $source_dir && -d $source_dir/.git ]] || fail "--source must be the pinned Omarchy checkout"
[[ -n $output ]] || fail "--output is required"
[[ $(uname -s) == "Linux" && $(uname -m) == "x86_64" ]] || fail "run on x86_64 Linux (the builder container is fine)"
(( EUID == 0 )) || fail "run as root so pacman can refresh its isolated databases"

temporary=$(mktemp -d)
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT
chmod 0755 "$temporary"
mkdir -p "$temporary/db"
chmod 0755 "$temporary/db"
config="$temporary/pacman.conf"
cp "$source_dir/default/pacman/pacman-stable.conf" "$config"
if [[ ${OMARCHY_PACMAN_DISABLE_SANDBOX:-0} == "1" ]]; then
  sed -i '/^\[options\]$/a DisableSandbox' "$config"
fi

pacman -Syy --noconfirm --config "$config" \
  --dbpath "$temporary/db" --logfile "$temporary/pacman.log"
python3 "$script_dir/resolve-package-lock.py" \
  --config "$config" \
  --dbpath "$temporary/db" \
  --packages "$guest_dir/packages.x86_64.txt" \
  --output "$temporary/resolved.json"

mkdir -p "$(dirname "$output")"
install -m 0644 "$temporary/resolved.json" "$output"
echo "Wrote reviewable package lock to $output"
