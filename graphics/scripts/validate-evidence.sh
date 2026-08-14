#!/bin/bash
set -euo pipefail

evidence_dir=${1:?usage: validate-evidence.sh EVIDENCE_DIRECTORY}
serial_log="$evidence_dir/serial.log"
guest_log="$evidence_dir/guest-evidence.log"
screenshot="$evidence_dir/desktop.ppm"

[[ -s $serial_log ]] || { echo "missing serial evidence: $serial_log" >&2; exit 1; }
[[ -s $guest_log ]] || { echo "missing guest evidence: $guest_log" >&2; exit 1; }
[[ -s $screenshot ]] || { echo "missing framebuffer evidence: $screenshot" >&2; exit 1; }

grep -F 'OMARCHY_GRAPHICS_PASS width=1600 height=900 drm=virtio_gpu renderer=llvmpipe shell=ok' "$guest_log" >/dev/null
grep -F '"architecture":"x86_64"' "$guest_log" >/dev/null
grep -F '"driver":"virtio_gpu"' "$guest_log" >/dev/null
grep -F '"width":1600,"height":900' "$guest_log" >/dev/null
grep -F '"package":"hyprland 0.56.2-1"' "$guest_log" >/dev/null
grep -F '"package":"quickshell-git 0.3.0.r20.g28771c7-1"' "$guest_log" >/dev/null
grep -Ei '"renderer":"[^"]*(llvmpipe|swrast)' "$guest_log" >/dev/null
grep -F '"ipc":"ok"' "$guest_log" >/dev/null

magic=$(sed -n '1p' "$screenshot")
dimensions=$(sed -n '2p' "$screenshot")
[[ $magic == "P6" ]] || { echo "unexpected screenshot format: $magic" >&2; exit 1; }
[[ $dimensions == "1600 900" ]] || { echo "unexpected screenshot dimensions: $dimensions" >&2; exit 1; }

printf 'PASS: native QEMU guest produced real 1600x900 Omarchy pixels through virtio-gpu DRM and llvmpipe.\n'
