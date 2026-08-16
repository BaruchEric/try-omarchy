#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
crate_dir="$repo_root/browser-edition/userspace"
output_dir="$repo_root/public/browser-edition"
output="$output_dir/quattro-userspace.wasm"

mkdir -p "$output_dir"
rustc_bin=$(rustup which rustc)
RUSTC="$rustc_bin" rustup run stable cargo build \
  --manifest-path "$crate_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release
install -m 0644 \
  "$crate_dir/target/wasm32-unknown-unknown/release/omarchy_quattro_browser_userspace.wasm" \
  "$output"
shasum -a 256 "$output"
