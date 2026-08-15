# Omarchy Web boots a disposable demo straight into Omarchy's real UWSM
# session. Interactive terminals still use the unmodified Omarchy bash setup.
if [[ $(tty 2>/dev/null) == "/dev/tty1" && -z ${WAYLAND_DISPLAY:-} ]]; then
  export XDG_SESSION_TYPE=wayland
  export XDG_CURRENT_DESKTOP=Hyprland
  export XDG_SESSION_DESKTOP=Hyprland

  # Observe the exact upstream session without wrapping or replacing it. The
  # systemd-owned probe survives this login shell's exec and keeps retrying if
  # software rendering takes longer than a native machine.
  if ! systemctl --user start --no-block omarchy-web-guest-probe.service; then
    /usr/local/bin/omarchy-web-guest-probe \
      --stage uwsm \
      --status failed \
      --message "could not start the systemd user startup observer" || true
  fi

  exec uwsm start -g -1 -e -D Hyprland hyprland.desktop
fi
