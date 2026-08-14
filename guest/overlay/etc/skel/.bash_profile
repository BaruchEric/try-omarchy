# Omarchy Web boots a disposable demo straight into Omarchy's real UWSM
# session. Interactive terminals still use the unmodified Omarchy bash setup.
if [[ $(tty 2>/dev/null) == "/dev/tty1" && -z ${WAYLAND_DISPLAY:-} ]]; then
  export XDG_SESSION_TYPE=wayland
  export XDG_CURRENT_DESKTOP=Hyprland
  export XDG_SESSION_DESKTOP=Hyprland
  exec uwsm start -g -1 -e -D Hyprland hyprland.desktop
fi
