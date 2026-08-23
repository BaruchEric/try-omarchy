#!/bin/bash

# Runs inside the architecture-matched Arch root after packages and files are staged.
set -euo pipefail

spec=/usr/share/omarchy-web/build-spec.json
[[ -f $spec ]] || { echo "Missing $spec" >&2; exit 1; }

read_spec() {
  python3 -c "import json; print(json.load(open('$spec'))$1)"
}

profile=$(read_spec '["guest"].get("profile", "demo")')
[[ $profile == demo || $profile == factory ]] || { echo "Unsupported guest profile: $profile" >&2; exit 1; }

locale-gen

passwd --lock root >/dev/null
systemctl enable NetworkManager.service
systemctl enable systemd-resolved.service
# Setting the default target is exactly this forced symlink. Creating it
# directly avoids a systemctl introspection path that crashes under common
# x86-on-ARM container emulators after it has already written the link.
ln -sfn /usr/lib/systemd/system/graphical.target /etc/systemd/system/default.target

if [[ $profile == factory ]]; then
  # Leave account, password, theme, and per-user state entirely to the pinned
  # Quattro owner-provisioning program. Its oneshot owns tty1 and deliberately
  # orders the display manager behind the setup flow.
  [[ -x /usr/bin/omarchy-provision-owner ]] || { echo "Missing upstream owner provisioner" >&2; exit 1; }
  [[ -f /var/lib/omarchy/provisioning/pending ]] || { echo "Factory provisioning is not armed" >&2; exit 1; }
  expected_mise=$(read_spec '["supplyChain"]["mise"]["reportedVersion"]')
  [[ -x /usr/bin/mise ]] || { echo "Missing pinned ARM64 mise" >&2; exit 1; }
  [[ $(/usr/bin/mise --version) == "$expected_mise" ]] || { echo "Pinned mise identity mismatch" >&2; exit 1; }
  systemctl enable omarchy-provision-owner.service
  systemctl enable sddm.service

  # The immutable artifact stays compact, while the native launcher enlarges
  # only its disposable APFS clone. Grow ext4 online before the owner wizard so
  # Omarchy's 10 GiB update-safety check sees the full working capacity.
  [[ -f /usr/lib/systemd/system/systemd-growfs-root.service ]] || { echo "Missing systemd root grow service" >&2; exit 1; }
  mkdir -p /etc/systemd/system/local-fs.target.wants
  ln -sfn /usr/lib/systemd/system/systemd-growfs-root.service \
    /etc/systemd/system/local-fs.target.wants/systemd-growfs-root.service

  fc-cache -f
  update-desktop-database /usr/share/applications || true

  # The runtime supplies the virtual devices, so never let mkinitcpio's host
  # autodetection remove virtio block/input/graphics drivers.
  mkinitcpio -P
  echo "Finalized unprovisioned Omarchy factory guest"
  exit 0
fi

username=$(read_spec '["guest"]["username"]')
uid=$(read_spec '["guest"]["uid"]')
theme=$(read_spec '["guest"]["defaultTheme"]')

if ! id "$username" >/dev/null 2>&1; then
  useradd --create-home --uid "$uid" --shell /bin/bash --groups audio,input,users,video,wheel "$username"
fi

passwd --lock "$username" >/dev/null
chown -R "$username:$username" "/home/$username"

systemctl enable getty@tty1.service

# Generate the same current-theme state a normal headless Omarchy install
# creates. Only session notifications/restarts are skipped.
runtime_dir=/tmp/omarchy-web-build-runtime
install -d -m 0700 -o "$username" -g "$username" "$runtime_dir"
runuser -u "$username" -- env \
  HOME="/home/$username" \
  USER="$username" \
  LOGNAME="$username" \
  XDG_RUNTIME_DIR="$runtime_dir" \
  OMARCHY_PATH=/usr/share/omarchy \
  OMARCHY_THEME_HEADLESS=1 \
  PATH=/usr/share/omarchy/bin:/usr/local/bin:/usr/bin \
  omarchy-theme-set "$theme"
rm -rf "$runtime_dir"

fc-cache -f
update-desktop-database /usr/share/applications || true

# The runtime supplies the virtual devices, so never let mkinitcpio's host
# autodetection remove virtio block/input/graphics drivers.
mkinitcpio -P

chown -R "$username:$username" "/home/$username"
echo "Finalized Omarchy web guest for $username"
