#!/bin/bash

set -euo pipefail

if (($#)); then
  echo "Usage: native/macos/build-sign-run.sh" >&2
  exit 64
fi

native_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$native_dir/../.." && pwd)
guest_dir="$repo_dir/guest/dist-aarch64"
helper="$native_dir/.build/release/omarchy-vm-helper"
module_cache="$native_dir/.build/module-cache"

[[ -d $guest_dir ]] || {
  echo "native-build-run: missing ARM64 guest at $guest_dir" >&2
  echo "Build it with ./guest/build-arm64-container.sh first." >&2
  exit 1
}

cd "$native_dir"
mkdir -p "$module_cache/swift" "$module_cache/clang"
export SWIFT_MODULECACHE_PATH="$module_cache/swift"
export CLANG_MODULE_CACHE_PATH="$module_cache/clang"
swift build --disable-sandbox -c release
codesign --force --sign - \
  --entitlements omarchy-vm-helper.entitlements \
  "$helper"
"$helper" --validate "$guest_dir"

echo "[native] Opening the local ARM64 guest with host-bound resume enabled."
exec "$helper" --run "$guest_dir"
