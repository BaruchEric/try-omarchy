#!/bin/bash
set -euo pipefail

lock=/graphics/versions.lock.json
stage=/staging
image_size_mib=${IMAGE_SIZE_MIB:-3072}
expected_commit=$(jq -r '.omarchy.commit' "$lock" 2>/dev/null || sed -n 's/.*"commit": "\([0-9a-f]*\)".*/\1/p' "$lock" | head -1)

cp /omarchy/default/pacman/pacman-stable.conf /etc/pacman.conf
cp /omarchy/default/pacman/mirrorlist-stable /etc/pacman.d/mirrorlist
sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf
sed -i '/^\[options\]/a CacheDir = /pkg-cache' /etc/pacman.conf

packages=(
  base
  dbus
  foot
  git
  hyprland
  imagemagick
  jq
  libdrm
  libnotify
  linux
  mesa
  mesa-utils
  mkinitcpio
  noto-fonts
  noto-fonts-emoji
  pciutils
  pipewire
  polkit
  procps-ng
  qt6-wayland
  quickshell-git
  seatd
  sudo
  ttf-jetbrains-mono-nerd
  uwsm
  vulkan-swrast
  vulkan-tools
  wireplumber
  woff2-font-awesome
)

pacman -Syyu --noconfirm --needed "${packages[@]}"

while IFS='=' read -r package expected; do
  actual=$(pacman -Q "$package" | awk '{print $2}')
  if [[ $actual != "$expected" ]]; then
    printf 'locked package mismatch: %s expected %s, got %s\n' "$package" "$expected" "$actual" >&2
    exit 1
  fi
done < <(jq -r '.packages | to_entries[] | "\(.key)=\(.value)"' "$lock")

printf 'MODULES=(virtio_pci virtio_blk virtio_gpu virtio_input virtio_console drm_display_helper)\n' >/etc/mkinitcpio.conf.d/omarchy-web.conf
mkinitcpio -P

ln -snf /usr/share/zoneinfo/UTC /etc/localtime
printf 'LANG=C.UTF-8\n' >/etc/locale.conf
printf 'omarchy-web\n' >/etc/hostname
printf '127.0.0.1 localhost\n::1 localhost\n127.0.1.1 omarchy-web.localdomain omarchy-web\n' >/etc/hosts

if ! id omarchy >/dev/null 2>&1; then
  useradd --create-home --uid 1000 --groups video,input,tty --shell /bin/bash omarchy
fi
passwd --delete omarchy

install -d -m 0755 \
  /usr/share/omarchy \
  /usr/share/omarchy-web \
  /usr/share/uwsm/env.d \
  /usr/local/libexec \
  /usr/local/share/wayland-sessions
tar --exclude=.git -C /omarchy -cf - . | tar -C /usr/share/omarchy -xf -
printf '%s\n' "$expected_commit" >/usr/share/omarchy-web/commit
cp /graphics/versions.lock.json /usr/share/omarchy-web/versions.lock.json
cp /usr/share/omarchy/default/uwsm/env.d/10-omarchy /usr/share/uwsm/env.d/10-omarchy
cp /usr/share/omarchy/default/wayland-sessions/omarchy.desktop /usr/local/share/wayland-sessions/omarchy.desktop
cp /graphics/scripts/guest-session.sh /usr/local/libexec/omarchy-graphics-session
cp /graphics/scripts/guest-probe.sh /usr/local/libexec/omarchy-graphics-probe
cp /graphics/scripts/guest-probe-dispatch.sh /usr/local/libexec/omarchy-probe-dispatch
cp /graphics/scripts/guest-evidence-channel.sh /usr/local/libexec/omarchy-evidence-channel
chmod 0755 \
  /usr/local/libexec/omarchy-evidence-channel \
  /usr/local/libexec/omarchy-graphics-session \
  /usr/local/libexec/omarchy-graphics-probe \
  /usr/local/libexec/omarchy-probe-dispatch

while IFS= read -r executable; do
  ln -snf "$executable" "/usr/local/bin/$(basename "$executable")"
done < <(find /usr/share/omarchy/bin -maxdepth 1 -type f -perm /111 -print)

install -d -m 0755 /home/omarchy/.config /home/omarchy/.local/state/omarchy/done
cp -a /usr/share/omarchy/config/. /home/omarchy/.config/
cp /graphics/overrides/monitors.lua /home/omarchy/.config/hypr/monitors.lua
touch /home/omarchy/.local/state/omarchy/done/first-run-user

cat >/home/omarchy/.bash_profile <<'PROFILE'
if [[ $(tty 2>/dev/null) == "/dev/tty1" ]]; then
  exec /usr/local/libexec/omarchy-graphics-session
fi
PROFILE

chown -R omarchy:omarchy /home/omarchy
install -o omarchy -g omarchy -m 0644 /dev/null /var/log/omarchy-hyprland.log
install -o omarchy -g omarchy -m 0644 /dev/null /var/log/omarchy-graphics-smoke.log

runuser -u omarchy -- env \
  HOME=/home/omarchy \
  OMARCHY_PATH=/usr/share/omarchy \
  OMARCHY_THEME_HEADLESS=1 \
  PATH=/usr/share/omarchy/bin:/usr/local/bin:/usr/bin \
  /usr/share/omarchy/bin/omarchy-theme-set "Tokyo Night"

install -d -m 0755 /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/autologin.conf <<'UNIT'
[Unit]
Requires=omarchy-evidence-channel.service
After=omarchy-evidence-channel.service

[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin omarchy --noclear %I $TERM
Type=idle
UNIT

cat >/etc/udev/rules.d/70-omarchy-evidence.rules <<'RULE'
SUBSYSTEM=="virtio-ports", ATTR{name}=="org.omarchy.evidence", MODE="0666"
RULE
printf 'virtio_console\n' >/etc/modules-load.d/omarchy-evidence.conf

cat >/etc/systemd/system/omarchy-evidence-channel.service <<'UNIT'
[Unit]
Description=Prepare the Omarchy graphics evidence channel
After=systemd-udevd.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/omarchy-evidence-channel
RemainAfterExit=yes
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable getty@tty1.service
systemctl enable omarchy-evidence-channel.service
printf 'omarchy-web graphics proof\n' >/etc/issue
: >/etc/machine-id

pacman -Q | sort >/usr/share/omarchy-web/packages.installed.txt
cp /usr/share/omarchy-web/packages.installed.txt /out/packages.installed.txt
cp /boot/vmlinuz-linux /out/vmlinuz
cp /boot/initramfs-linux.img /out/initramfs.img

rm -f /boot/initramfs-linux-fallback.img
rm -rf "$stage"
install -d -m 0755 "$stage"
tar \
  --one-file-system \
  --exclude=./dev/console \
  --exclude=./.dockerenv \
  --exclude=./omarchy \
  --exclude=./graphics \
  --exclude=./out \
  --exclude=./proc \
  --exclude=./run \
  --exclude=./staging \
  --exclude=./sys \
  --exclude=./tmp \
  -C / -cf - . | tar -C "$stage" -xf -
install -d -m 0755 "$stage/dev" "$stage/proc" "$stage/run" "$stage/sys" "$stage/tmp"
chmod 1777 "$stage/tmp"

required_mib=$(du -sm "$stage" | awk '{print $1}')
if (( required_mib + 384 > image_size_mib )); then
  printf 'rootfs needs %s MiB plus headroom; IMAGE_SIZE_MIB=%s is too small\n' "$required_mib" "$image_size_mib" >&2
  exit 1
fi

truncate -s "${image_size_mib}M" /out/rootfs.ext4
mkfs.ext4 -q -F \
  -L omarchy-web \
  -U 63d3677c-30d7-4f6b-a8b4-6ffea9ce2e42 \
  -d "$stage" \
  /out/rootfs.ext4
e2fsck -fn /out/rootfs.ext4

sha256sum /out/rootfs.ext4 /out/vmlinuz /out/initramfs.img >/out/SHA256SUMS
jq -n \
  --arg commit "$expected_commit" \
  --arg kernel "$(pacman -Q linux | awk '{print $2}')" \
  --arg hyprland "$(pacman -Q hyprland | awk '{print $2}')" \
  --arg quickshell "$(pacman -Q quickshell-git | awk '{print $2}')" \
  --arg mesa "$(pacman -Q mesa | awk '{print $2}')" \
  --argjson imageSizeMiB "$image_size_mib" \
  --argjson installedSizeMiB "$required_mib" \
  '{schemaVersion: 1, omarchyCommit: $commit, packages: {linux: $kernel, hyprland: $hyprland, "quickshell-git": $quickshell, mesa: $mesa}, imageSizeMiB: $imageSizeMiB, installedSizeMiB: $installedSizeMiB}' \
  >/out/build-report.json

chown "$OUTPUT_UID:$OUTPUT_GID" \
  /out/rootfs.ext4 \
  /out/vmlinuz \
  /out/initramfs.img \
  /out/SHA256SUMS \
  /out/packages.installed.txt \
  /out/build-report.json
