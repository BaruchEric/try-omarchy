#!/bin/bash

# Runs inside the x86_64 Arch root after packages and files are staged.
set -euo pipefail

spec=/usr/share/omarchy-web/build-spec.json
[[ -f $spec ]] || { echo "Missing $spec" >&2; exit 1; }

read_spec() {
  python3 -c "import json; print(json.load(open('$spec'))$1)"
}

username=$(read_spec '["guest"]["username"]')
uid=$(read_spec '["guest"]["uid"]')
theme=$(read_spec '["guest"]["defaultTheme"]')

locale-gen

if ! id "$username" >/dev/null 2>&1; then
  useradd --create-home --uid "$uid" --shell /bin/bash --groups audio,input,users,video,wheel "$username"
fi

passwd --lock root >/dev/null
passwd --lock "$username" >/dev/null
chown -R "$username:$username" "/home/$username"

systemctl enable getty@tty1.service
systemctl enable NetworkManager.service
systemctl enable systemd-resolved.service
systemctl set-default graphical.target
ln -sfn ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

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
