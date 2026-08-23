#!/bin/bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: native/macos/build-app.sh [--open] [--dmg] [--guest-dir DIR]
                                  [--sign-identity IDENTITY]
                                  [--notarize-profile PROFILE]

Build a self-contained Apple Silicon app. Developer ID signing is used when
--sign-identity is supplied; otherwise the local build is ad-hoc signed.
--notarize-profile implies --dmg and names a notarytool keychain profile.
EOF
  exit 64
}

open_app=0
build_dmg=0
guest_dir=
sign_identity=${OMARCHY_CODESIGN_IDENTITY:--}
notarize_profile=
while (($#)); do
  case "$1" in
    --open) open_app=1; shift ;;
    --dmg) build_dmg=1; shift ;;
    --guest-dir)
      (($# >= 2)) || usage
      guest_dir=$2
      shift 2
      ;;
    --sign-identity)
      (($# >= 2)) || usage
      sign_identity=$2
      shift 2
      ;;
    --notarize-profile)
      (($# >= 2)) || usage
      notarize_profile=$2
      build_dmg=1
      shift 2
      ;;
    *) usage ;;
  esac
done

native_dir=$(cd "$(dirname "$0")" && pwd)
helper="$native_dir/.build/release/omarchy-vm-helper"
app="$native_dir/.build/Omarchy Quattro.app"
contents="$app/Contents"
module_cache="$native_dir/.build/module-cache"
runtime_source="$native_dir/.build/qemu-gpu-runtime"
repo_dir=$(cd "$native_dir/../.." && pwd -P)
guest_dir=${guest_dir:-"$repo_dir/guest/dist-aarch64"}
dependency_bundler="$native_dir/bundle-macho-dependencies.sh"
package_dmg="$native_dir/package-dmg.sh"
zstd_bin=$(command -v zstd || true)

[[ -d $runtime_source && ! -L $runtime_source ]] || {
  echo "build-app: missing staged QEMU runtime; run build-qemu-gpu-runtime.sh first" >&2
  exit 1
}
[[ -d $guest_dir && ! -L $guest_dir ]] || {
  echo "build-app: missing factory guest directory: $guest_dir" >&2
  exit 1
}
guest_dir=$(cd "$guest_dir" && pwd -P)
[[ -x $dependency_bundler && ! -L $dependency_bundler ]] || {
  echo "build-app: dependency bundler is missing or unsafe" >&2
  exit 1
}
[[ -n $zstd_bin && -f $zstd_bin && -x $zstd_bin ]] || {
  echo "build-app: zstd is required to create the self-contained app" >&2
  exit 1
}

cd "$native_dir"
mkdir -p "$module_cache/swift" "$module_cache/clang"
export SWIFT_MODULECACHE_PATH="$module_cache/swift"
export CLANG_MODULE_CACHE_PATH="$module_cache/clang"
swift build --disable-sandbox -c release -debug-info-format none

rm -rf "$app"
mkdir -p \
  "$contents/MacOS" \
  "$contents/Resources/guest" \
  "$contents/Resources/runtime/bin" \
  "$contents/Resources/scripts"
install -m 0755 "$helper" "$contents/MacOS/omarchy-vm-helper"
install -m 0644 "$native_dir/Info.plist" "$contents/Info.plist"
ditto "$runtime_source" "$contents/Resources/runtime"
install -m 0755 "$zstd_bin" "$contents/Resources/runtime/bin/zstd"
install -m 0755 "$native_dir/run-qemu-gpu.sh" "$contents/Resources/scripts/run-qemu-gpu.sh"
install -m 0644 "$native_dir/qemu-persistent-storage.sh" \
  "$contents/Resources/scripts/qemu-persistent-storage.sh"
ditto "$guest_dir" "$contents/Resources/guest"

"$dependency_bundler" "$contents/Resources/runtime"

sign_options=(--force --sign "$sign_identity")
if [[ $sign_identity != - ]]; then
  sign_options+=(--options runtime --timestamp)
fi
for library in "$contents/Resources/runtime/lib"/*.dylib; do
  codesign "${sign_options[@]}" "$library"
done
codesign "${sign_options[@]}" "$contents/Resources/runtime/bin/zstd"
codesign "${sign_options[@]}" \
  --entitlements "$native_dir/qemu-hvf.entitlements" \
  "$contents/Resources/runtime/bin/qemu-system-aarch64"
codesign "${sign_options[@]}" \
  --entitlements "$native_dir/omarchy-vm-helper.entitlements" \
  "$contents/MacOS/omarchy-vm-helper"

codesign "${sign_options[@]}" \
  --entitlements "$native_dir/omarchy-vm-helper.entitlements" \
  "$app"
codesign --verify --deep --strict --verbose=2 "$app"

echo "[native] Built $app"
if (( build_dmg )); then
  dmg="$native_dir/.build/Omarchy Quattro.dmg"
  rm -f "$dmg"
  package_arguments=()
  if [[ -n $notarize_profile ]]; then
    package_arguments+=(--notarize-profile "$notarize_profile")
  fi
  "$package_dmg" "${package_arguments[@]}" "$app" "$dmg"
fi
if (( open_app )); then
  open "$app"
fi
