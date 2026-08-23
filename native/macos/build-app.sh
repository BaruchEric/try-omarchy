#!/bin/bash

set -euo pipefail

open_app=0
if (($#)); then
  if [[ $# == 1 && $1 == --open ]]; then
    open_app=1
  else
    echo "Usage: native/macos/build-app.sh [--open]" >&2
    exit 64
  fi
fi

native_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$native_dir/../.." && pwd)
guest_dir="$repo_dir/guest/dist-aarch64"
helper="$native_dir/.build/release/omarchy-vm-helper"
app="$native_dir/.build/Omarchy Quattro.app"
contents="$app/Contents"
module_cache="$native_dir/.build/module-cache"

[[ -d $guest_dir ]] || {
  echo "native-app: missing ARM64 guest at $guest_dir" >&2
  exit 1
}

cd "$native_dir"
mkdir -p "$module_cache/swift" "$module_cache/clang"
export SWIFT_MODULECACHE_PATH="$module_cache/swift"
export CLANG_MODULE_CACHE_PATH="$module_cache/clang"
swift build --disable-sandbox -c release

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"
install -m 0755 "$helper" "$contents/MacOS/omarchy-vm-helper"
install -m 0644 "$native_dir/Info.plist" "$contents/Info.plist"

codesign --force --sign - \
  --entitlements "$native_dir/omarchy-vm-helper.entitlements" \
  "$app"
codesign --verify --strict "$app"

echo "[native] Built $app"
if (( open_app )); then
  open "$app" --args --run "$guest_dir"
fi
