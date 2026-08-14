#!/bin/bash
set -euo pipefail

graphics_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock="$graphics_dir/versions.lock.json"

jq -e '.omarchy.commit | test("^[0-9a-f]{40}$")' "$lock" >/dev/null
jq -e '.qemu.width == 1600 and .qemu.height == 900 and .qemu.displayDevice == "virtio-vga"' "$lock" >/dev/null
jq -e '.packages.hyprland == "0.56.2-1" and .packages["quickshell-git"] == "0.3.0.r20.g28771c7-1"' "$lock" >/dev/null
grep -F 'mode = "1600x900@60"' "$graphics_dir/overrides/monitors.lua" >/dev/null
grep -F 'GALLIUM_DRIVER=llvmpipe' "$graphics_dir/scripts/guest-session.sh" >/dev/null
grep -F 'uwsm start -g -1 -e -D Hyprland hyprland.desktop' "$graphics_dir/scripts/guest-session.sh" >/dev/null
grep -F 'default/uwsm/env.d/10-omarchy' "$graphics_dir/scripts/build-in-container.sh" >/dev/null
grep -F '/dev/virtio-ports/org.omarchy.evidence' "$graphics_dir/scripts/guest-evidence-channel.sh" >/dev/null
grep -F 'virtio-vga,max_outputs=1,xres=1600,yres=900' "$graphics_dir/scripts/run-smoke.sh" >/dev/null
grep -F 'pc-q35-8.2' "$graphics_dir/scripts/run-smoke.sh" >/dev/null

for script in "$graphics_dir"/scripts/*.sh "$graphics_dir"/tests/*.sh; do
  bash -n "$script"
done

printf 'PASS: graphics smoke static contract\n'
