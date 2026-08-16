#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: configure-rootfs.sh --root ROOT [--guest-dir GUEST_DIR] [--spec SPEC]"
}

fail() {
  echo "configure-rootfs: $*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "$0")" && pwd)
guest_dir=$(cd "$script_dir/.." && pwd)
root=""
spec=""

while (($#)); do
  case "$1" in
    --root)
      root=${2:-}
      shift 2
      ;;
    --guest-dir)
      guest_dir=${2:-}
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

[[ -n $root ]] || fail "--root is required"
[[ $root == /* ]] || fail "--root must be an absolute path"
case "$root" in
  /|/bin|/boot|/etc|/home|/opt|/root|/usr|/var)
    fail "refusing unsafe root: $root"
    ;;
esac
[[ -d $root/usr/share/omarchy ]] || fail "materialize Omarchy before configuring the rootfs"
[[ -n $spec ]] || spec="$guest_dir/spec.json"
[[ -f $spec ]] || fail "guest spec not found: $spec"

mkdir -p "$root/etc" "$root/etc/skel" "$root/usr/share/omarchy-web"
cp -a "$guest_dir/overlay/." "$root/"

# User customizations are additive. The prefix of each file remains byte-for-
# byte identical to Basecamp's pinned config and can be audited independently.
cat "$guest_dir/fragments/hypr-monitors.append.lua" >>"$root/etc/skel/.config/hypr/monitors.lua"
cat "$guest_dir/fragments/hypr-autostart.append.lua" >>"$root/etc/skel/.config/hypr/autostart.lua"

hostname=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["guest"]["hostname"])' "$spec")
commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream"]["commit"])' "$spec")
printf '%s\n' "$hostname" >"$root/etc/hostname"
cat >"$root/etc/hosts" <<EOF
127.0.0.1 localhost
::1 localhost
127.0.1.1 $hostname
EOF
printf 'en_US.UTF-8 UTF-8\n' >"$root/etc/locale.gen"
printf 'LANG=en_US.UTF-8\n' >"$root/etc/locale.conf"
printf 'KEYMAP=us\n' >"$root/etc/vconsole.conf"
printf '%s\n' "${commit:0:32}" >"$root/etc/machine-id"
ln -sfn /usr/share/zoneinfo/UTC "$root/etc/localtime"

# Keep the exact architecture-appropriate package/mirror configuration in the
# guest. x86_64 retains upstream Omarchy's files; ARM64 uses the reviewed ALARM
# configuration and the builder's pinned mirror list.
pacman_input=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["inputs"].get("pacmanConfig", ""))' "$spec")
if [[ -n $pacman_input ]]; then
  install -m 0644 "$guest_dir/$pacman_input" "$root/etc/pacman.conf"
  install -m 0644 /etc/pacman.d/mirrorlist "$root/etc/pacman.d/mirrorlist"
else
  install -m 0644 "$root/usr/share/omarchy/default/pacman/pacman-stable.conf" "$root/etc/pacman.conf"
  install -m 0644 "$root/usr/share/omarchy/default/pacman/mirrorlist-stable" "$root/etc/pacman.d/mirrorlist"
fi

mask_unit() {
  local scope=$1
  local unit=$2
  [[ $unit =~ ^[A-Za-z0-9@_.:-]+$ ]] || fail "unsafe unit name: $unit"
  mkdir -p "$scope"
  rm -f "$scope/$unit"
  ln -s /dev/null "$scope/$unit"
}

while IFS= read -r unit; do
  [[ -n $unit && $unit != \#* ]] || continue
  mask_unit "$root/etc/systemd/system" "$unit"
done <"$guest_dir/services.system-mask.txt"

while IFS= read -r unit; do
  [[ -n $unit && $unit != \#* ]] || continue
  mask_unit "$root/etc/skel/.config/systemd/user" "$unit"
done <"$guest_dir/services.user-mask.txt"

# The tty1 login starts the observer before executing Omarchy's exact UWSM
# command. It deliberately is not ordered after graphical-session.target: that
# would hide the failures which prevent Hyprland from reaching the target.

# No persistent logs, random seed, browser state, or package cache should be
# shipped in a disposable image.
rm -rf "$root/var/log/journal" "$root/var/lib/systemd/random-seed"
mkdir -p "$root/var/log" "$root/var/cache/pacman/pkg"
find "$root/var/cache/pacman/pkg" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true

mkdir -p "$root/usr/local/lib/omarchy-web"
install -m 0755 "$guest_dir/scripts/finalize-rootfs.sh" "$root/usr/local/lib/omarchy-web/finalize-rootfs"
install -m 0644 "$spec" "$root/usr/share/omarchy-web/build-spec.json"

# Record content digests before the user overlay is copied into $HOME. This is
# the machine-readable proof that the compositor/shell runtime came from the
# pinned Omarchy tree rather than a frontend reproduction.
python3 "$guest_dir/scripts/write-provenance.py" \
  --root "$root" \
  --spec "$spec" \
  --output "$root/usr/share/omarchy-web/provenance.json"

echo "Configured disposable Omarchy web profile in $root"
