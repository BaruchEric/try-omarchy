#!/bin/bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: guest/build.sh [options]

  --output DIR       Artifact directory (default: guest/dist)
  --work DIR         Persistent build/cache directory (default: guest/.work)
  --source DIR       Use an existing clean pinned Omarchy checkout
  --keep-rootfs      Keep the staged package root after a successful build

Run as root on x86_64 Arch Linux, or use guest/build-container.sh.
USAGE
}

fail() {
  echo "guest-build: $*" >&2
  exit 1
}

guest_dir=$(cd "$(dirname "$0")" && pwd)
output="$guest_dir/dist"
work="$guest_dir/.work"
source_dir=""
keep_rootfs=0

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
    --source)
      source_dir=${2:-}
      shift 2
      ;;
    --keep-rootfs)
      keep_rootfs=1
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

[[ $(uname -s) == "Linux" ]] || fail "full image builds require Linux"
[[ $(uname -m) == "x86_64" ]] || fail "guest packages must be assembled on x86_64"
(( EUID == 0 )) || fail "run as root (pacstrap and arch-chroot require it)"
for command in pacstrap arch-chroot git python3 mke2fs zstd; do
  command -v "$command" >/dev/null || fail "$command is required; use the supplied Arch builder container"
done

output=$(mkdir -p "$output" && cd "$output" && pwd)
work=$(mkdir -p "$work" && cd "$work" && pwd)
if [[ -z $source_dir ]]; then
  source_dir="$work/omarchy-source"
  "$guest_dir/scripts/fetch-source.sh" --destination "$source_dir"
else
  source_dir=$(cd "$source_dir" && pwd)
fi

root=$(mktemp -d "$work/rootfs.XXXXXX")
resolution_db=$(mktemp -d "$work/pacman-db.XXXXXX")
chmod 0755 "$resolution_db"
cleanup() {
  if (( keep_rootfs )); then
    echo "Staged rootfs retained at $root"
  else
    rm -rf "$root"
  fi
  rm -rf "$resolution_db"
}
trap cleanup EXIT

packages=()
while IFS= read -r package; do
  [[ -n $package && $package != \#* ]] || continue
  packages+=("$package")
done <"$guest_dir/packages.x86_64.txt"

echo "Installing ${#packages[@]} trimmed guest packages"
upstream_pacman_config="$source_dir/default/pacman/pacman-stable.conf"
package_cache="$work/pacman-cache"
pacman_config="$work/pacman-builder.conf"
[[ $package_cache != *$'\n'* ]] || fail "work path cannot contain a newline"
install -d -m 0755 "$package_cache"

# Preserve the pinned repository configuration exactly, adding only builder
# options. The generated file is temporary build input; configure-rootfs later
# installs Omarchy's unmodified pacman configuration into the guest.
options_sections=0
while IFS= read -r line || [[ -n $line ]]; do
  printf '%s\n' "$line"
  if [[ $line == "[options]" ]]; then
    printf 'CacheDir = %s\n' "$package_cache"
    if [[ ${OMARCHY_PACMAN_DISABLE_SANDBOX:-0} == "1" ]]; then
      printf 'DisableSandbox\n'
    fi
    options_sections=$((options_sections + 1))
  fi
done <"$upstream_pacman_config" >"$pacman_config"
(( options_sections == 1 )) || fail "pinned pacman configuration must contain one [options] section"

# Resolve against an empty target database and require the reviewed transitive
# version lock before any multi-gigabyte package transaction begins.
pacman -Syy --noconfirm --config "$pacman_config" \
  --dbpath "$resolution_db" --logfile "$resolution_db/pacman.log"
python3 "$guest_dir/scripts/resolve-package-lock.py" \
  --config "$pacman_config" \
  --dbpath "$resolution_db" \
  --packages "$guest_dir/packages.x86_64.txt" \
  --output "$resolution_db/resolved.json" \
  --expect "$guest_dir/packages.x86_64.lock.json"

# pacstrap reads configured CacheDir paths for host-cache mode only with -P.
# The copied builder config is replaced by configure-rootfs below. Archives
# remain under $work across failed staging roots and are still signature-checked.
pacstrap -c -P -C "$pacman_config" -K -M "$root" "${packages[@]}"

# pacstrap creates a target-side mirror of every configured cache directory,
# even in host-cache mode. It must be empty; remove only that staged mirror and
# any empty parents it introduced, never the persistent cache itself.
staged_package_cache="$root$package_cache"
[[ $staged_package_cache == "$root/"* ]] || fail "unsafe staged package cache path"
rmdir "$staged_package_cache" || fail "target-side package cache mirror is unexpectedly non-empty"
staged_parent=$(dirname "$staged_package_cache")
while [[ $staged_parent != "$root" ]]; do
  rmdir "$staged_parent" 2>/dev/null || break
  staged_parent=$(dirname "$staged_parent")
done

"$guest_dir/scripts/materialize-omarchy.sh" --root "$root" --source "$source_dir"
"$guest_dir/scripts/configure-rootfs.sh" --root "$root"
arch-chroot "$root" /usr/local/lib/omarchy-web/finalize-rootfs
arch-chroot "$root" pacman -Q | LC_ALL=C sort >"$root/usr/share/omarchy-web/packages.lock.txt"

# arch-chroot bind-mounts the host resolver file at this path. Replace it only
# after every chroot invocation has returned and the temporary mount is gone.
ln -sfn ../run/systemd/resolve/stub-resolv.conf "$root/etc/resolv.conf"

"$guest_dir/scripts/pack-image.sh" --root "$root" --output "$output"
echo "Guest build complete: $output/guest-manifest.json"
