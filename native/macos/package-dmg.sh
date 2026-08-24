#!/bin/bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: native/macos/package-dmg.sh [--notarize-profile PROFILE] APP [OUTPUT_DMG]
EOF
  exit 64
}

fail() {
  echo "package-dmg: $*" >&2
  exit 1
}

notarize_profile=
if [[ ${1:-} == --notarize-profile ]]; then
  (($# >= 3)) || usage
  notarize_profile=$2
  shift 2
fi
(( $# == 1 || $# == 2 )) || usage

app=$1
[[ $app == /* && -d $app && ! -L $app && $app == *.app ]] || \
  fail "APP must be an absolute direct .app bundle"
output=${2:-"${app%.app}.dmg"}
[[ $output == /* && $output == *.dmg ]] || fail "OUTPUT_DMG must be an absolute .dmg path"
[[ ! -e $output && ! -L $output ]] || fail "output already exists: $output"

for tool in codesign ditto hdiutil ln mkdir mktemp osascript rm sync; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
done
codesign --verify --deep --strict --verbose=2 "$app"

native_dir=$(cd "$(dirname "$0")" && pwd -P)
layout_source="$native_dir/dmg-layout.applescript"
[[ -f $layout_source && ! -L $layout_source ]] || {
  fail "DMG Finder layout is missing or unsafe"
}

work_dir=$(mktemp -d /private/tmp/omarchy-dmg.XXXXXX)
mounted=0
mount_dir="$work_dir/mount"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if (( mounted )); then
    hdiutil detach "$mount_dir" -force >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if [[ -n $notarize_profile ]]; then
  command -v xcrun >/dev/null 2>&1 || fail "xcrun is required for notarization"
  archive="$work_dir/Omarchy.zip"
  ditto -c -k --keepParent "$app" "$archive"
  xcrun notarytool submit "$archive" --keychain-profile "$notarize_profile" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
fi

staging="$work_dir/dmg"
mkdir -p "$staging"
ditto "$app" "$staging/${app##*/}"
ln -s /Applications "$staging/Applications"

read_write_dmg="$work_dir/Omarchy-rw.dmg"
hdiutil create \
  -volname "Try Omarchy" \
  -srcfolder "$staging" \
  -fs APFS \
  -format UDRW \
  "$read_write_dmg" >/dev/null

mkdir "$mount_dir"
hdiutil attach \
  -readwrite \
  -noverify \
  -noautoopen \
  -mountpoint "$mount_dir" \
  "$read_write_dmg" >/dev/null
mounted=1

osascript "$layout_source" "$mount_dir" "${app##*/}"

sync
hdiutil detach "$mount_dir" >/dev/null
mounted=0
hdiutil convert \
  "$read_write_dmg" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -o "$output" >/dev/null

if [[ -n $notarize_profile ]]; then
  xcrun notarytool submit "$output" --keychain-profile "$notarize_profile" --wait
  xcrun stapler staple "$output"
  xcrun stapler validate "$output"
fi

echo "[native] Packaged $output"
