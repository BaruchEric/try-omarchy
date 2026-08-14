#!/usr/bin/env bash
set -euo pipefail

proof_dir=$(cd "$(dirname "$0")" && pwd)
image=${QEMU_WASM_BUILDER_IMAGE:-omarchy-qemu-wasm-builder:emsdk-3.1.50}

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
mkdir -p "$proof_dir/dist"

docker run --rm \
  --platform linux/amd64 \
  --volume "$proof_dir:/proof:ro" \
  --volume "$proof_dir/dist:/out" \
  --entrypoint /bin/bash \
  "$image" \
  -euo pipefail -c \
  'emcc /proof/proof.c -O2 -sFORCE_FILESYSTEM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sEXPORTED_RUNTIME_METHODS=FS -o /out/proof.mjs'

echo "Paged disk browser proof built in $proof_dir/dist"
