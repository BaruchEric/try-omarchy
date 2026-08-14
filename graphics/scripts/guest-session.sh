#!/bin/bash
set -euo pipefail

export OMARCHY_PATH=/usr/share/omarchy
export PATH="$OMARCHY_PATH/bin:/usr/local/sbin:/usr/local/bin:/usr/bin"
export XDG_SESSION_TYPE=wayland
export XDG_SESSION_DESKTOP=Hyprland
export XDG_CURRENT_DESKTOP=Hyprland
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
export WLR_RENDERER_ALLOW_SOFTWARE=1
export AQ_NO_MODIFIERS=1
export XCURSOR_SIZE=24

evidence_tty=${OMARCHY_EVIDENCE_TTY:-/dev/virtio-ports/org.omarchy.evidence}
for attempt in $(seq 1 30); do
  [[ -w $evidence_tty ]] && break
  sleep 1
done
[[ -w $evidence_tty ]] || evidence_tty=/dev/tty1
exec > >(tee -a /var/log/omarchy-hyprland.log "$evidence_tty") 2>&1

printf 'OMARCHY_SESSION_START commit=%s\n' "$(cat /usr/share/omarchy-web/commit)"
/usr/local/libexec/omarchy-probe-dispatch &
printf 'OMARCHY_UWSM_START command=%q\n' 'uwsm start -g -1 -e -D Hyprland hyprland.desktop'
exec uwsm start -g -1 -e -D Hyprland hyprland.desktop
