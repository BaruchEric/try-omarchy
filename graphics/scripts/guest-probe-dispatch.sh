#!/bin/bash
set -u

for attempt in $(seq 1 120); do
  for instance_dir in "${XDG_RUNTIME_DIR:-/run/user/1000}"/hypr/*; do
    [[ -S $instance_dir/.socket.sock ]] || continue
    signature=$(basename "$instance_dir")
    wayland_socket=$(find "${XDG_RUNTIME_DIR:-/run/user/1000}" -maxdepth 1 -type s -name 'wayland-*' -print -quit 2>/dev/null || true)
    [[ -n $wayland_socket ]] || continue
    printf 'OMARCHY_PROBE_STARTED signature=%s wayland=%s\n' "$signature" "$(basename "$wayland_socket")"
    exec env \
      HYPRLAND_INSTANCE_SIGNATURE="$signature" \
      WAYLAND_DISPLAY="$(basename "$wayland_socket")" \
      XDG_CURRENT_DESKTOP=Hyprland \
      XDG_SESSION_DESKTOP=Hyprland \
      XDG_SESSION_TYPE=wayland \
      /usr/local/libexec/omarchy-graphics-probe
  done
  sleep 1
done

printf 'OMARCHY_GRAPHICS_FAIL reason=probe-dispatch-timeout\n'
exit 1
