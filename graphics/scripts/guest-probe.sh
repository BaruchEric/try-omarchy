#!/bin/bash
set -u

log_file=/var/log/omarchy-graphics-smoke.log
probe_lock=${XDG_RUNTIME_DIR:-/run/user/1000}/omarchy-graphics-probe.lock
diagnostic_dir=${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/graphics-proof
mkdir "$probe_lock" 2>/dev/null || exit 0
mkdir -p "$diagnostic_dir"
# The session wrapper already owns the exclusive virtio-serial channel. Preserve
# its inherited stdout and only add the on-disk copy here.
exec > >(tee -a "$log_file") 2>&1

emit() {
  local event=$1
  shift
  jq -cn --arg event "$event" "$@" '$ARGS.named + {event: $event}'
}

fail() {
  emit failure --arg reason "$1"
  printf 'OMARCHY_GRAPHICS_FAIL reason=%s\n' "$1"
  exit 1
}

printf 'OMARCHY_EVIDENCE_BEGIN\n'
emit identity \
  --arg architecture "$(uname -m)" \
  --arg kernel "$(uname -r)" \
  --arg omarchyCommit "$(cat /usr/share/omarchy-web/commit)" \
  --arg omarchyVersion "$(cat /usr/share/omarchy/version)"

packages=$(pacman -Q linux hyprland quickshell-git aquamarine mesa vulkan-swrast | jq -Rsc 'split("\n") | map(select(length > 0))')
emit packages --argjson values "$packages"

for attempt in $(seq 1 120); do
  [[ -e /dev/dri/card0 ]] && break
  sleep 1
done
[[ -e /dev/dri/card0 ]] || fail "virtio DRM card did not appear"

drm_transport=$(basename "$(readlink -f /sys/class/drm/card0/device/driver 2>/dev/null || true)")
drm_driver=
for driver_link in /sys/class/drm/card0/device/virtio*/driver; do
  [[ -L $driver_link ]] || continue
  candidate=$(basename "$(readlink -f "$driver_link")")
  if [[ $candidate == "virtio_gpu" ]]; then
    drm_driver=$candidate
    break
  fi
done
[[ $drm_driver == "virtio_gpu" ]] || fail "card0 driver is '${drm_driver:-missing}', not virtio_gpu"
drm_modes=$(find /sys/class/drm -maxdepth 2 -name modes -exec cat {} \; 2>/dev/null | sort -u | jq -Rsc 'split("\n") | map(select(length > 0))')
emit drm \
  --arg card "/dev/dri/card0" \
  --arg driver "$drm_driver" \
  --arg transport "$drm_transport" \
  --argjson connectorModes "$drm_modes"

for attempt in $(seq 1 120); do
  monitor_json=$(hyprctl -j monitors 2>/dev/null) && [[ $(jq 'length' <<<"$monitor_json") -gt 0 ]] && break
  monitor_json=
  sleep 1
done
[[ -n $monitor_json ]] || fail "hyprctl did not report a monitor"

width=$(jq -r 'map(select(.disabled != true))[0].width // 0' <<<"$monitor_json")
height=$(jq -r 'map(select(.disabled != true))[0].height // 0' <<<"$monitor_json")
refresh=$(jq -r 'map(select(.disabled != true))[0].refreshRate // 0' <<<"$monitor_json")
monitor_name=$(jq -r 'map(select(.disabled != true))[0].name // ""' <<<"$monitor_json")
emit monitor \
  --arg name "$monitor_name" \
  --argjson width "$width" \
  --argjson height "$height" \
  --argjson refreshHz "$refresh" \
  --arg raw "$monitor_json"
(( width == 1600 && height == 900 )) || fail "Hyprland monitor is ${width}x${height}, expected 1600x900"

hyprland_pid=$(pgrep -xo Hyprland 2>/dev/null || true)
[[ -n $hyprland_pid ]] || fail "Hyprland process is missing"
hyprland_version=$(hyprctl version 2>&1 || true)
system_info=$(hyprctl systeminfo 2>&1 || true)
printf '%s\n' "$system_info" >"$diagnostic_dir/hyprland-systeminfo.log"

eglinfo_output=$(EGL_PLATFORM=wayland eglinfo -B 2>&1 || true)
printf '%s\n' "$eglinfo_output" >"$diagnostic_dir/eglinfo.log"

renderer_evidence=$(printf '%s\n' "$system_info" "$eglinfo_output" | grep -Eim1 'llvmpipe|swrast' || true)
if [[ -z $renderer_evidence ]]; then
  runtime_log=$(find "${XDG_RUNTIME_DIR:-/run/user/1000}" -path '*/hypr/*/hyprland.log' -type f -print -quit 2>/dev/null || true)
  [[ -n $runtime_log ]] && renderer_evidence=$(grep -Eim1 'llvmpipe|swrast' "$runtime_log" 2>/dev/null || true)
fi
[[ -n $renderer_evidence ]] || fail "Mesa did not report llvmpipe/swrast"
emit compositor \
  --arg pid "$hyprland_pid" \
  --arg package "$(pacman -Q hyprland)" \
  --arg version "$hyprland_version" \
  --arg renderer "$renderer_evidence"

shell_ping=
for attempt in $(seq 1 180); do
  shell_ping=$(quickshell ipc -p "$OMARCHY_PATH/shell" call shell ping 2>/dev/null || true)
  [[ $shell_ping == "ok" ]] && break
  sleep 1
done
if [[ $shell_ping != "ok" ]]; then
  printf '%s\n' 'OMARCHY_DIAGNOSTIC_BEGIN quickshell'
  journalctl --user -b --no-pager -n 200 2>&1 || true
  journalctl -b -t omarchy-shell --no-pager -n 200 2>&1 || true
  printf '%s\n' 'OMARCHY_DIAGNOSTIC_END quickshell'
  fail "the pinned Omarchy Quickshell did not answer IPC ping"
fi
quickshell_pid=$(pgrep -xo quickshell 2>/dev/null || pgrep -of 'quickshell.*omarchy' 2>/dev/null || true)
[[ -n $quickshell_pid ]] || fail "Quickshell process is missing"
emit shell \
  --arg pid "$quickshell_pid" \
  --arg package "$(pacman -Q quickshell-git)" \
  --arg ipc "$shell_ping" \
  --arg config "$OMARCHY_PATH/shell/shell.qml"

foot --app-id=org.omarchy.graphics-proof --title="Omarchy graphics proof" \
  bash -lc 'printf "\\033[2J\\033[H\\n  Real Omarchy graphics gate\\n\\n  Hyprland + Quickshell\\n  virtio-gpu DRM + Mesa llvmpipe\\n  1600 x 900\\n\\n  PASS\\n"; exec sleep 600' &

client_json=
for attempt in $(seq 1 60); do
  client_json=$(hyprctl -j clients 2>/dev/null || true)
  jq -e 'any(.[]; .class == "org.omarchy.graphics-proof")' <<<"$client_json" >/dev/null 2>&1 && break
  sleep 1
done
jq -e 'any(.[]; .class == "org.omarchy.graphics-proof")' <<<"$client_json" >/dev/null 2>&1 || fail "proof terminal did not become a Hyprland client"
emit client --arg raw "$client_json"

sleep 3
printf 'OMARCHY_GRAPHICS_PASS width=%s height=%s drm=%s renderer=llvmpipe shell=ok\n' "$width" "$height" "$drm_driver"
printf 'OMARCHY_EVIDENCE_END\n'
