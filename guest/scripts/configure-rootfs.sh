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

architecture=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"]["architecture"])' "$spec")
profile=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["guest"].get("profile", "demo"))' "$spec")
[[ $profile == demo || $profile == factory ]] || fail "unsupported guest profile: $profile"
[[ $profile != factory || $architecture == aarch64 ]] || fail "factory profile currently supports only aarch64"

mkdir -p "$root/etc" "$root/etc/skel" "$root/usr/share/omarchy-web"
if [[ $profile == demo ]]; then
  cp -a "$guest_dir/overlay/." "$root/"
else
  # A factory guest must not inherit the demo's autologin, welcome, Chromium
  # policy, menu restrictions, web-app stubs, completion markers, or service
  # masks. Install only the virtual-hardware compatibility files that are
  # needed before the real upstream first-boot owner flow can run.
  while IFS='|' read -r mode relative; do
    mkdir -p "$(dirname "$root/$relative")"
    install -m "$mode" "$guest_dir/overlay/$relative" "$root/$relative"
  done <<'FACTORY_VM_FILES'
0644|etc/mkinitcpio.conf.d/90-omarchy-web.conf
0644|usr/lib/environment.d/90-omarchy-web.conf
0755|usr/local/bin/xdg-terminal-exec
FACTORY_VM_FILES
  mkdir -p "$root/usr/local/bin"
  install -m 0755 "$guest_dir/compat/ttfx-arm64" "$root/usr/local/bin/ttfx"
fi

# Quattro's authentic configuration remains installed byte-for-byte. The x86
# browser uses a bounded user config because the hundreds of Lua bridge calls
# in the full physical-desktop profile exceed Hyprland's reload budget under
# TCG. ARM/native keeps the exact Quattro user bootstrap.
if [[ $architecture == x86_64 ]]; then
  hyprland_user_config="$root/etc/skel/.config/hypr/hyprland.lua"
  install -m 0644 "$guest_dir/fragments/hypr-x86-web.lua" "$hyprland_user_config"
  install -m 0644 "$guest_dir/fragments/environment-x86-web.conf" \
    "$root/usr/lib/environment.d/91-omarchy-x86-web-renderer.conf"
fi

# User customizations are additive. The prefix of each file remains byte-for-
# byte identical to Basecamp's pinned config and can be audited independently.
# The fixed x86 browser canvas always needs a forced scale. ARM retains
# Quattro's upstream automatic Retina profile; the accelerated QEMU-only
# fragment merely selects Cocoa's host-composited cursor path.
if [[ $architecture == x86_64 ]]; then
  cat "$guest_dir/fragments/hypr-monitors.append.lua" >>"$root/etc/skel/.config/hypr/monitors.lua"
  cat "$guest_dir/fragments/hypr-autostart.append.lua" >>"$root/etc/skel/.config/hypr/autostart.lua"
elif [[ $architecture == aarch64 ]]; then
  cp -a "$guest_dir/native-overlay/." "$root/"
  mkdir -p "$root/etc/systemd/user/default.target.wants"
  ln -sfn /usr/lib/systemd/user/omarchy-native-audio-bridge.service \
    "$root/etc/systemd/user/default.target.wants/omarchy-native-audio-bridge.service"
  cat "$guest_dir/fragments/hypr-monitors-arm-qemu.append.lua" >>"$root/etc/skel/.config/hypr/monitors.lua"
  if [[ $profile == demo ]]; then
    cat "$guest_dir/fragments/hypr-autostart-arm-qemu.append.lua" >>"$root/etc/skel/.config/hypr/autostart.lua"
  fi
fi

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
if [[ $profile == factory ]]; then
  # An unprovisioned machine receives a new identity from systemd on its first
  # boot. Do not stamp it with the deterministic demo identity.
  : >"$root/etc/machine-id"
else
  printf '%s\n' "${commit:0:32}" >"$root/etc/machine-id"
fi
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

if [[ $profile == demo ]]; then
  while IFS= read -r unit; do
    [[ -n $unit && $unit != \#* ]] || continue
    mask_unit "$root/etc/systemd/system" "$unit"
  done <"$guest_dir/services.system-mask.txt"

  while IFS= read -r unit; do
    [[ -n $unit && $unit != \#* ]] || continue
    mask_unit "$root/etc/skel/.config/systemd/user" "$unit"
  done <"$guest_dir/services.user-mask.txt"
else
  provision_unit="$root/usr/share/omarchy/install/provisioning/omarchy-provision-owner.service"
  [[ -f $provision_unit ]] || fail "pinned upstream owner-provisioning service is missing"
  mkdir -p "$root/etc/systemd/system" "$root/var/lib/omarchy/provisioning"
  install -m 0644 "$provision_unit" "$root/etc/systemd/system/omarchy-provision-owner.service"
  : >"$root/var/lib/omarchy/provisioning/pending"
  printf '%s\n' audio input users video >"$root/var/lib/omarchy/provisioning/groups"
fi

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

echo "Configured Omarchy $profile profile in $root"
