#!/bin/bash
set -euo pipefail

evidence_port=/dev/virtio-ports/org.omarchy.evidence
for attempt in $(seq 1 60); do
  [[ -e $evidence_port ]] && break
  sleep 1
done

[[ -e $evidence_port ]] || {
  echo "OMARCHY_EVIDENCE_CHANNEL_FAIL port=$evidence_port"
  exit 1
}

chmod 0666 "$evidence_port"
printf 'OMARCHY_EVIDENCE_CHANNEL_READY port=%s\n' "$evidence_port" | tee "$evidence_port"
