#!/bin/bash

set -euo pipefail

test_dir=$(cd "$(dirname "$0")" && pwd -P)
native_dir=$(cd "$test_dir/.." && pwd -P)
# shellcheck source=../qemu-persistent-storage.sh
source "$native_dir/qemu-persistent-storage.sh"

fail() {
  printf 'qemu-persistent-storage.test: %s\n' "$*" >&2
  exit 1
}

assert() {
  "$@" || fail "assertion failed: $*"
}

assert_eq() {
  [[ $1 == "$2" ]] || fail "expected [$2], got [$1]"
}

assert_fails() {
  if "$@"; then
    fail "command unexpectedly succeeded: $*"
  fi
}

wait_for_file() {
  local path=$1
  local attempt=0
  for ((attempt = 0; attempt < 100; attempt++)); do
    [[ -f $path ]] && return 0
    sleep 0.02
  done
  fail "timed out waiting for $path"
}

qmp_request() {
  local socket_path=$1
  local action=$2

  python3 - "$socket_path" "$action" <<'PY'
import json
import socket
import sys
import time

socket_path, action = sys.argv[1:]
connection = socket.socket(socket.AF_UNIX)
for attempt in range(250):
    try:
        connection.connect(socket_path)
        break
    except (FileNotFoundError, ConnectionRefusedError):
        if attempt == 249:
            raise
        time.sleep(0.02)
connection.settimeout(5)
stream = connection.makefile("rwb", buffering=0)


def receive():
    line = stream.readline()
    if not line:
        raise SystemExit("QMP disconnected before replying")
    return json.loads(line)


def command(name):
    stream.write(json.dumps({"execute": name}, separators=(",", ":")).encode("ascii") + b"\r\n")
    while True:
        message = receive()
        if "error" in message:
            raise SystemExit(f"QMP {name} failed: {message['error']}")
        if "return" in message:
            return message["return"]


greeting = receive()
if "QMP" not in greeting:
    raise SystemExit("QMP greeting is missing")
command("qmp_capabilities")
if action == "assert-lock-fdset":
    fdsets = command("query-fdsets")
    matches = [
        descriptor
        for fdset in fdsets
        if fdset.get("fdset-id") == 77
        for descriptor in fdset.get("fds", [])
        if descriptor.get("opaque") == "omarchy-persistent-lock"
    ]
    if len(matches) != 1 or not isinstance(matches[0].get("fd"), int):
        raise SystemExit(f"persistent lock fdset is missing or ambiguous: {fdsets!r}")
elif action == "quit":
    command("quit")
else:
    raise SystemExit(f"unknown QMP test action: {action}")
PY
}

test_root=$(mktemp -d '/private/tmp/omarchy-qemu-storage-test.XXXXXX')
case "$test_root" in
  /private/tmp/omarchy-qemu-storage-test.??????) ;;
  *) fail "unexpected test root: $test_root" ;;
esac
holder_pid=''
qemu_pid=''
cleanup() {
  qemu_persistent_storage_release_lock || true
  if [[ $holder_pid =~ ^[0-9]+$ ]]; then
    kill -TERM "$holder_pid" 2>/dev/null || true
  fi
  if [[ $qemu_pid =~ ^[0-9]+$ ]]; then
    kill -TERM "$qemu_pid" 2>/dev/null || true
  fi
  /bin/rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM

export OMARCHY_QEMU_GPU_STATE_ROOT="$test_root/state"
source_disk="$test_root/source.ext4"
dd if=/dev/zero of="$source_disk" bs=4096 count=1 >/dev/null 2>&1
printf 'immutable-base' | dd of="$source_disk" bs=1 seek=32 conv=notrunc >/dev/null 2>&1
printf '\x53\xef' | dd of="$source_disk" bs=1 seek=1080 conv=notrunc >/dev/null 2>&1
source_bytes=$(stat -f '%z' "$source_disk")
source_sha=$(shasum -a 256 "$source_disk" | awk '{print $1}')
identity_a=$(printf 'bundle-a' | shasum -a 256 | awk '{print $1}')
identity_b=$(printf 'bundle-b' | shasum -a 256 | awk '{print $1}')
identity_bad=$(printf 'bundle-bad' | shasum -a 256 | awk '{print $1}')
identity_expanded=$(printf 'bundle-expanded' | shasum -a 256 | awk '{print $1}')
identity_compressed=$(printf 'bundle-compressed' | shasum -a 256 | awk '{print $1}')

# A compressed app payload is expanded once into the private immutable-image
# cache, verified against the raw manifest digest, and reused thereafter.
compressed_disk="$test_root/source.ext4.zst"
zstd_source=$(command -v zstd)
zstd_test="$test_root/zstd"
printf '#!/bin/bash\nexec %q "$@"\n' "$zstd_source" >"$zstd_test"
chmod 700 "$zstd_test"
zstd -q -f "$source_disk" -o "$compressed_disk"
compressed_bytes=$(stat -f '%z' "$compressed_disk")
qemu_persistent_storage_materialize_source \
  "$identity_compressed" "$compressed_disk" "$compressed_bytes" \
  "$source_sha" "$source_bytes" "$zstd_test"
materialized_source=$QEMU_IMMUTABLE_SOURCE_DISK
assert cmp -s "$materialized_source" "$source_disk"
qemu_persistent_storage_materialize_source \
  "$identity_compressed" "$compressed_disk" "$compressed_bytes" \
  "$source_sha" "$source_bytes" "$zstd_test"
assert_eq "$QEMU_IMMUTABLE_SOURCE_DISK" "$materialized_source"

# The factory workspace grows sparsely while its immutable source stays at the
# transport size. Relaunch validates and reuses the expanded workspace.
expanded_bytes=$((source_bytes + 16384))
qemu_persistent_storage_select \
  persistent "$identity_expanded" "$source_disk" "$source_sha" "$source_bytes" '' "$expanded_bytes"
expanded_disk=$QEMU_SELECTED_DISK
assert_eq "$(stat -f '%z' "$expanded_disk")" "$expanded_bytes"
printf 'expanded-persistence' | dd of="$expanded_disk" bs=1 seek="$source_bytes" conv=notrunc >/dev/null 2>&1
qemu_persistent_storage_release_lock
qemu_persistent_storage_select \
  persistent "$identity_expanded" "$source_disk" "$source_sha" "$source_bytes" '' "$expanded_bytes"
assert_eq "$(dd if="$QEMU_SELECTED_DISK" bs=1 skip="$source_bytes" count=20 2>/dev/null)" expanded-persistence
qemu_persistent_storage_release_lock

qemu_persistent_storage_select \
  persistent "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
persistent_a=$QEMU_SELECTED_DISK
assert_eq "$QEMU_SELECTED_STORAGE_MODE" persistent
assert test -f "$persistent_a"
assert test -f "${persistent_a%/*}/metadata.json"
assert_eq "$(stat -f '%Lp' "$persistent_a")" 600
printf 'saved-user-data' | dd of="$persistent_a" bs=1 seek=128 conv=notrunc >/dev/null 2>&1
qemu_persistent_storage_release_lock

qemu_persistent_storage_select \
  persistent "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
assert_eq "$QEMU_SELECTED_DISK" "$persistent_a"
saved=$(dd if="$QEMU_SELECTED_DISK" bs=1 skip=128 count=15 2>/dev/null)
assert_eq "$saved" saved-user-data

# An unrelated process cannot acquire the same identity while this descriptor
# remains locked.
assert_fails /bin/bash -c \
  'source "$1"; qemu_persistent_storage_select persistent "$2" "$3" "$4" "$5" ""' \
  qps-lock-test "$native_dir/qemu-persistent-storage.sh" \
  "$identity_a" "$source_disk" "$source_sha" "$source_bytes" 9>&-
qemu_persistent_storage_release_lock

qemu_persistent_storage_select \
  persistent "$identity_b" "$source_disk" "$source_sha" "$source_bytes" ''
persistent_b=$QEMU_SELECTED_DISK
assert test "$persistent_b" != "$persistent_a"
assert cmp -s "$persistent_b" "$source_disk"
qemu_persistent_storage_release_lock

# QEMU normally closes unrelated inherited descriptors. `-add-fd` explicitly
# retains the lock in a QEMU fdset, so killing only the launcher cannot permit a
# second writer. QMP proves that the real staged QEMU owns the registered fd.
qemu_bin="$native_dir/.build/qemu-gpu-runtime/bin/qemu-system-aarch64"
if [[ ! -x $qemu_bin ]]; then
  printf 'qemu-persistent-storage.test: SKIP staged-QEMU lock inheritance (binary absent)\n' >&2
else
  qemu_version=$($qemu_bin --version | sed -n '1p')
  [[ $qemu_version == 'QEMU emulator version 10.2.50' ]] || {
    fail "staged QEMU version is not 10.2.50: $qemu_version"
  }
  holder_pid_file="$test_root/qemu-launcher.pid"
  qemu_pid_file="$test_root/qemu.pid"
  qmp_socket="$test_root/qmp.sock"
  qemu_log="$test_root/qemu.log"
  /bin/bash -c '
    set -euo pipefail
    source "$1"
    qemu_persistent_storage_select persistent "$2" "$3" "$4" "$5" ""
    "$6" \
      -machine none \
      -nodefaults \
      -display none \
      -S \
      -qmp "unix:$7,server=on,wait=off" \
      -add-fd "$QEMU_PERSISTENT_STORAGE_QEMU_ADD_FD" \
      >"${10}" 2>&1 &
    printf "%s\n" "$!" >"$9"
    printf "%s\n" "$$" >"$8"
    wait "$!"
  ' qps-qemu-holder "$native_dir/qemu-persistent-storage.sh" \
    "$identity_a" "$source_disk" "$source_sha" "$source_bytes" \
    "$qemu_bin" "$qmp_socket" "$holder_pid_file" "$qemu_pid_file" "$qemu_log" \
    9>&- &
  holder_job=$!
  wait_for_file "$holder_pid_file"
  wait_for_file "$qemu_pid_file"
  holder_pid=$(<"$holder_pid_file")
  qemu_pid=$(<"$qemu_pid_file")
  qmp_request "$qmp_socket" assert-lock-fdset || {
    sed -n '1,160p' "$qemu_log" >&2
    fail 'staged QEMU did not publish its persistent-lock fdset'
  }
  kill -KILL "$holder_pid"
  wait "$holder_job" 2>/dev/null || true
  holder_pid=''
  assert kill -0 "$qemu_pid"
  qmp_request "$qmp_socket" assert-lock-fdset
  assert_fails /bin/bash -c \
    'source "$1"; qemu_persistent_storage_select persistent "$2" "$3" "$4" "$5" ""' \
    qps-qemu-inherited-lock-test "$native_dir/qemu-persistent-storage.sh" \
    "$identity_a" "$source_disk" "$source_sha" "$source_bytes" 9>&-
  qmp_request "$qmp_socket" quit
  for ((attempt = 0; attempt < 250; attempt++)); do
    kill -0 "$qemu_pid" 2>/dev/null || break
    sleep 0.02
  done
  if kill -0 "$qemu_pid" 2>/dev/null; then
    fail "staged QEMU did not terminate after QMP quit"
  fi
  qemu_pid=''

  qemu_persistent_storage_select \
    persistent "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
  qemu_persistent_storage_release_lock
  printf 'qemu-persistent-storage.test: staged-QEMU crash lock: PASS\n'
fi

# Reset is deliberately identity-scoped and rebuilds from the immutable base.
qemu_persistent_storage_select \
  reset "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
assert cmp -s "$QEMU_SELECTED_DISK" "$source_disk"
qemu_persistent_storage_release_lock

# Ephemeral selection never changes or locks the saved workspace.
ephemeral_dir="$test_root/ephemeral"
mkdir "$ephemeral_dir"
chmod 700 "$ephemeral_dir"
qemu_persistent_storage_select \
  ephemeral "$identity_a" "$source_disk" "$source_sha" "$source_bytes" "$ephemeral_dir"
assert_eq "$QEMU_SELECTED_STORAGE_MODE" ephemeral
assert cmp -s "$QEMU_SELECTED_DISK" "$source_disk"
printf 'temporary-only' | dd of="$QEMU_SELECTED_DISK" bs=1 seek=256 conv=notrunc >/dev/null 2>&1
assert cmp -s "$persistent_a" "$source_disk"

# Exact metadata and an allowlisted directory are required even for explicit
# reset; unknown host files are never recursively deleted.
qemu_persistent_storage_select \
  persistent "$identity_bad" "$source_disk" "$source_sha" "$source_bytes" ''
bad_directory=$QEMU_PERSISTENT_STORAGE_DIRECTORY
qemu_persistent_storage_release_lock
printf 'must-survive\n' >"$bad_directory/unknown.txt"
chmod 600 "$bad_directory/unknown.txt"
assert_fails qemu_persistent_storage_select \
  reset "$identity_bad" "$source_disk" "$source_sha" "$source_bytes" ''
assert test -f "$bad_directory/unknown.txt"
qemu_persistent_storage_release_lock

# A symlink can never be accepted as a persistent disk, even if the metadata
# and target bytes otherwise match the selected bundle.
/bin/rm -f "$bad_directory/unknown.txt" "$bad_directory/rootfs.ext4"
ln -s "$source_disk" "$bad_directory/rootfs.ext4"
assert_fails qemu_persistent_storage_select \
  persistent "$identity_bad" "$source_disk" "$source_sha" "$source_bytes" ''
assert test -L "$bad_directory/rootfs.ext4"
qemu_persistent_storage_release_lock

# A recognized interrupted transaction is reclaimed; an unmarked directory is
# deliberately left untouched.
recognized_stage="$OMARCHY_QEMU_GPU_STATE_ROOT/disks/.${identity_a}.initializing.ABCDEF"
mkdir "$recognized_stage"
chmod 700 "$recognized_stage"
_qps_write_metadata \
  "$recognized_stage/metadata.json" "$identity_a" "$source_sha" "$source_bytes"
unknown_stage="$OMARCHY_QEMU_GPU_STATE_ROOT/disks/.${identity_a}.initializing.FEDCBA"
mkdir "$unknown_stage"
chmod 700 "$unknown_stage"

# This exact shape bypassed the old newline-serialized allowlist: valid
# metadata, no real rootfs.ext4, and one unknown basename ending in a newline.
# An exact os.listdir set check must leave the directory and hostile file alone.
newline_stage="$OMARCHY_QEMU_GPU_STATE_ROOT/disks/.${identity_a}.initializing.NLTEST"
mkdir "$newline_stage"
chmod 700 "$newline_stage"
_qps_write_metadata \
  "$newline_stage/metadata.json" "$identity_a" "$source_sha" "$source_bytes"
newline_entry=$'rootfs.ext4\n'
printf 'must-survive\n' >"$newline_stage/$newline_entry"
chmod 600 "$newline_stage/$newline_entry"

qemu_persistent_storage_select \
  persistent "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
assert test ! -e "$recognized_stage"
assert test -d "$unknown_stage"
assert test -d "$newline_stage"
assert test -f "$newline_stage/$newline_entry"
qemu_persistent_storage_release_lock

# A broad override is rejected before any mutation.
saved_state_root=$OMARCHY_QEMU_GPU_STATE_ROOT
export OMARCHY_QEMU_GPU_STATE_ROOT=/
assert_fails qemu_persistent_storage_select \
  persistent "$identity_a" "$source_disk" "$source_sha" "$source_bytes" ''
export OMARCHY_QEMU_GPU_STATE_ROOT=$saved_state_root

printf 'qemu-persistent-storage.test: PASS\n'
