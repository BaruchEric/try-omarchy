#!/bin/bash

# Persistent-disk lifecycle for run-qemu-gpu.sh.
#
# This file is intentionally a library, not a subprocess. The caller must
# source it so file descriptor 9, and therefore its BSD advisory lock, remains
# open for the complete QEMU lifetime. The caller must pass
# `-add-fd "$QEMU_PERSISTENT_STORAGE_QEMU_ADD_FD"` to QEMU; QEMU otherwise
# closes unrelated inherited descriptors. The fdset keeps the lock alive if
# the launcher is killed while QEMU is still writing the disk.

QEMU_PERSISTENT_STORAGE_SCHEMA=1
QEMU_PERSISTENT_STORAGE_KIND='omarchy-qemu-persistent-disk'
QEMU_PERSISTENT_STORAGE_ROOT_MARKER='omarchy-qemu-storage-root-v1'
QEMU_PERSISTENT_STORAGE_LOCK_FD=9
QEMU_PERSISTENT_STORAGE_QEMU_ADD_FD='fd=9,set=77,opaque=omarchy-persistent-lock'

QEMU_SELECTED_DISK=''
QEMU_SELECTED_STORAGE_MODE=''
QEMU_PERSISTENT_STORAGE_DIRECTORY=''
QEMU_PERSISTENT_STORAGE_IDENTITY=''
QEMU_PERSISTENT_STORAGE_LOCK_PATH=''
QEMU_PERSISTENT_STORAGE_WORKING_BYTES=''
QEMU_IMMUTABLE_SOURCE_DISK=''

_qps_error() {
  printf 'qemu-persistent-storage: %s\n' "$*" >&2
}

_qps_fail() {
  _qps_error "$*"
  return 1
}

_qps_is_identity() {
  [[ ${1:-} =~ ^[0-9a-f]{64}$ ]]
}

_qps_is_positive_integer() {
  [[ ${1:-} =~ ^[1-9][0-9]*$ ]]
}

_qps_lstat_kind() {
  stat -f '%HT' "$1" 2>/dev/null
}

_qps_owner() {
  stat -f '%u' "$1" 2>/dev/null
}

_qps_permissions() {
  stat -f '%Lp' "$1" 2>/dev/null
}

_qps_size() {
  stat -f '%z' "$1" 2>/dev/null
}

_qps_file_identity() {
  stat -f '%d:%i' "$1" 2>/dev/null
}

_qps_assert_private_directory() {
  local qps_directory=$1
  local qps_label=$2

  [[ -d $qps_directory && ! -L $qps_directory ]] || {
    _qps_fail "$qps_label is not a direct directory: $qps_directory"
    return 1
  }
  [[ $(_qps_lstat_kind "$qps_directory") == Directory ]] || {
    _qps_fail "$qps_label has an unsafe file type: $qps_directory"
    return 1
  }
  [[ $(_qps_owner "$qps_directory") == $(id -u) ]] || {
    _qps_fail "$qps_label is not owned by the current user: $qps_directory"
    return 1
  }
  [[ $(_qps_permissions "$qps_directory") == 700 ]] || {
    _qps_fail "$qps_label must have mode 0700: $qps_directory"
    return 1
  }
}

_qps_assert_private_regular_file() {
  local qps_file=$1
  local qps_label=$2

  [[ -f $qps_file && ! -L $qps_file ]] || {
    _qps_fail "$qps_label is not a direct regular file: $qps_file"
    return 1
  }
  [[ $(_qps_lstat_kind "$qps_file") == 'Regular File' ]] || {
    _qps_fail "$qps_label has an unsafe file type: $qps_file"
    return 1
  }
  [[ $(_qps_owner "$qps_file") == $(id -u) ]] || {
    _qps_fail "$qps_label is not owned by the current user: $qps_file"
    return 1
  }
  [[ $(_qps_permissions "$qps_file") == 600 ]] || {
    _qps_fail "$qps_label must have mode 0600: $qps_file"
    return 1
  }
}

_qps_assert_source_disk() {
  local qps_source=$1
  local qps_expected_bytes=$2

  [[ -f $qps_source && ! -L $qps_source ]] || {
    _qps_fail "source root disk is not a direct regular file: $qps_source"
    return 1
  }
  [[ $(_qps_lstat_kind "$qps_source") == 'Regular File' ]] || {
    _qps_fail "source root disk has an unsafe file type: $qps_source"
    return 1
  }
  [[ $(_qps_size "$qps_source") == "$qps_expected_bytes" ]] || {
    _qps_fail "source root disk does not have the manifest size"
    return 1
  }
}

_qps_assert_safe_root_path() {
  local qps_root=$1

  [[ $qps_root == /* && $qps_root != *$'\n'* && $qps_root != *$'\r'* ]] || {
    _qps_fail "state root must be an absolute single-line path"
    return 1
  }
  case "$qps_root" in
    /|/Users|/private|/private/tmp|/tmp)
      _qps_fail "refusing unsafe broad state root: $qps_root"
      return 1
      ;;
  esac
}

_qps_write_root_marker() {
  local qps_marker=$1

  (umask 077; set -o noclobber; printf '%s\n' "$QEMU_PERSISTENT_STORAGE_ROOT_MARKER" >"$qps_marker") \
    2>/dev/null
}

_qps_validate_root_marker() {
  local qps_marker=$1

  _qps_assert_private_regular_file "$qps_marker" 'state-root marker' || return 1
  [[ $(<"$qps_marker") == "$QEMU_PERSISTENT_STORAGE_ROOT_MARKER" ]] || {
    _qps_fail "state-root marker is invalid: $qps_marker"
    return 1
  }
}

_qps_prepare_state_root() {
  local qps_configured_root=''
  local qps_root=''
  local qps_marker=''
  local qps_marker_status=0
  local qps_child=''

  if [[ -n ${OMARCHY_QEMU_GPU_STATE_ROOT:-} ]]; then
    qps_configured_root=$OMARCHY_QEMU_GPU_STATE_ROOT
  else
    [[ -n ${HOME:-} ]] || {
      _qps_fail 'HOME is unavailable; cannot locate Application Support'
      return 1
    }
    qps_configured_root="$HOME/Library/Application Support/Omarchy/QEMU/v1"
  fi
  _qps_assert_safe_root_path "$qps_configured_root" || return 1

  umask 077
  mkdir -p "$qps_configured_root" || {
    _qps_fail "cannot create state root: $qps_configured_root"
    return 1
  }
  _qps_assert_private_directory "$qps_configured_root" 'state root' || return 1
  qps_root=$(cd "$qps_configured_root" && pwd -P) || {
    _qps_fail "cannot resolve state root: $qps_configured_root"
    return 1
  }
  _qps_assert_safe_root_path "$qps_root" || return 1

  qps_marker="$qps_root/.omarchy-qemu-storage"
  if [[ ! -e $qps_marker && ! -L $qps_marker ]]; then
    if _qps_write_root_marker "$qps_marker"; then
      :
    else
      qps_marker_status=$?
      [[ -e $qps_marker || -L $qps_marker ]] || {
        _qps_fail "cannot initialize state-root marker: $qps_marker"
        return 1
      }
    fi
  fi
  _qps_validate_root_marker "$qps_marker" || return 1

  for qps_child in disks images locks; do
    if [[ ! -e $qps_root/$qps_child && ! -L $qps_root/$qps_child ]]; then
      if mkdir "$qps_root/$qps_child" 2>/dev/null; then
        chmod 700 "$qps_root/$qps_child" || return 1
      elif [[ ! -d $qps_root/$qps_child || -L $qps_root/$qps_child ]]; then
        _qps_fail "cannot create state $qps_child directory"
        return 1
      fi
    fi
    _qps_assert_private_directory "$qps_root/$qps_child" "state $qps_child directory" || return 1
  done

  QEMU_PERSISTENT_STORAGE_ROOT=$qps_root
  QEMU_PERSISTENT_STORAGE_DISKS_ROOT="$qps_root/disks"
  QEMU_PERSISTENT_STORAGE_IMAGES_ROOT="$qps_root/images"
  QEMU_PERSISTENT_STORAGE_LOCKS_ROOT="$qps_root/locks"
}

_qps_lock_fd_is_open() {
  { true >&9; } 2>/dev/null
}

_qps_lock_fd_matches_path() {
  local qps_path=$1
  [[ $(stat -f '%HT:%u:%i' /dev/fd/9 2>/dev/null) == \
     "Regular File:$(id -u):$(_qps_file_identity "$qps_path" | sed 's/^.*://')" ]]
}

_qps_acquire_lock() {
  local qps_identity=$1
  local qps_lock_path="$QEMU_PERSISTENT_STORAGE_LOCKS_ROOT/$qps_identity.lock"

  if _qps_lock_fd_is_open; then
    _qps_fail "file descriptor $QEMU_PERSISTENT_STORAGE_LOCK_FD is already in use"
    return 1
  fi
  [[ -x /usr/bin/lockf ]] || {
    _qps_fail '/usr/bin/lockf is required for persistent workspace locking'
    return 1
  }
  if [[ -e $qps_lock_path || -L $qps_lock_path ]]; then
    _qps_assert_private_regular_file "$qps_lock_path" 'workspace lock' || return 1
  fi

  exec 9>>"$qps_lock_path" || {
    _qps_fail "cannot open workspace lock: $qps_lock_path"
    return 1
  }
  chmod 600 "$qps_lock_path" || {
    exec 9>&-
    _qps_fail "cannot protect workspace lock: $qps_lock_path"
    return 1
  }
  _qps_assert_private_regular_file "$qps_lock_path" 'workspace lock' || {
    exec 9>&-
    return 1
  }
  _qps_lock_fd_matches_path "$qps_lock_path" || {
    exec 9>&-
    _qps_fail "workspace lock changed while it was opened"
    return 1
  }
  if ! /usr/bin/lockf -s -t 0 9; then
    exec 9>&-
    _qps_fail "workspace $qps_identity is already open"
    return 1
  fi

  QEMU_PERSISTENT_STORAGE_LOCK_PATH=$qps_lock_path
}

qemu_persistent_storage_release_lock() {
  if _qps_lock_fd_is_open; then
    exec 9>&-
  fi
  QEMU_PERSISTENT_STORAGE_LOCK_PATH=''
}

_qps_write_metadata() {
  local qps_path=$1
  local qps_identity=$2
  local qps_source_sha=$3
  local qps_source_bytes=$4

  (umask 077; set -o noclobber; printf \
    '{"bundleIdentity":"%s","kind":"%s","schemaVersion":%s,"sourceRootfs":{"bytes":%s,"sha256":"%s"}}\n' \
    "$qps_identity" \
    "$QEMU_PERSISTENT_STORAGE_KIND" \
    "$QEMU_PERSISTENT_STORAGE_SCHEMA" \
    "$qps_source_bytes" \
    "$qps_source_sha" >"$qps_path") 2>/dev/null
}

_qps_validate_metadata() {
  local qps_path=$1
  local qps_identity=$2
  local qps_source_sha=$3
  local qps_source_bytes=$4

  local qps_expected=''
  _qps_assert_private_regular_file "$qps_path" 'persistent-disk metadata' || return 1
  [[ $(_qps_size "$qps_path") -le 16384 ]] || return 1
  printf -v qps_expected \
    '{"bundleIdentity":"%s","kind":"%s","schemaVersion":%s,"sourceRootfs":{"bytes":%s,"sha256":"%s"}}' \
    "$qps_identity" \
    "$QEMU_PERSISTENT_STORAGE_KIND" \
    "$QEMU_PERSISTENT_STORAGE_SCHEMA" \
    "$qps_source_bytes" \
    "$qps_source_sha"
  [[ $(<"$qps_path") == "$qps_expected" ]] || {
    _qps_fail 'metadata does not match the selected guest bundle'
    return 1
  }
}

_qps_has_only_store_contents() (
  local qps_directory=$1
  local qps_allow_missing_disk=$2

  local qps_entry=''
  local qps_has_metadata=0
  local qps_has_disk=0
  local qps_count=0

  shopt -s nullglob dotglob
  for qps_entry in "$qps_directory"/*; do
    ((qps_count += 1))
    case ${qps_entry##*/} in
      metadata.json) qps_has_metadata=1 ;;
      rootfs.ext4) qps_has_disk=1 ;;
      *) return 1 ;;
    esac
  done
  shopt -u nullglob dotglob
  ((qps_has_metadata == 1)) || return 1
  if [[ $qps_allow_missing_disk == 1 ]]; then
    ((qps_count == 1 || (qps_count == 2 && qps_has_disk == 1)))
  else
    ((qps_count == 2 && qps_has_disk == 1))
  fi
)

_qps_validate_store_directory() {
  local qps_directory=$1
  local qps_identity=$2
  local qps_source_sha=$3
  local qps_source_bytes=$4
  local qps_working_bytes=$5
  local qps_allow_missing_disk=${6:-0}
  local qps_disk="$qps_directory/rootfs.ext4"

  _qps_assert_private_directory "$qps_directory" 'persistent-disk directory' || return 1
  _qps_has_only_store_contents "$qps_directory" "$qps_allow_missing_disk" || {
    _qps_fail "persistent-disk directory contains unexpected files: $qps_directory"
    return 1
  }
  _qps_validate_metadata \
    "$qps_directory/metadata.json" \
    "$qps_identity" \
    "$qps_source_sha" \
    "$qps_source_bytes" || return 1

  if [[ -e $qps_disk || -L $qps_disk ]]; then
    _qps_assert_private_regular_file "$qps_disk" 'persistent root disk' || return 1
    [[ $(_qps_size "$qps_disk") == "$qps_working_bytes" ]] || {
      _qps_fail "persistent root disk has the wrong size: $qps_disk"
      return 1
    }
  elif [[ $qps_allow_missing_disk != 1 ]]; then
    _qps_fail "persistent root disk is missing: $qps_disk"
    return 1
  fi
}

_qps_fsync() {
  /bin/sync
}

_qps_clone_disk() {
  local qps_source=$1
  local qps_destination=$2
  local qps_expected_bytes=$3

  if /bin/cp -c "$qps_source" "$qps_destination" 2>/dev/null; then
    _qps_error "APFS-cloned the immutable root disk"
  else
    [[ ! -e $qps_destination && ! -L $qps_destination ]] || /bin/rm -f "$qps_destination"
    _qps_error "APFS clone unavailable; copying the immutable root disk"
    /bin/cp "$qps_source" "$qps_destination" || {
      _qps_fail "cannot copy the immutable root disk"
      return 1
    }
  fi
  chmod 600 "$qps_destination" || return 1
  _qps_assert_private_regular_file "$qps_destination" 'working root disk' || return 1
  [[ $(_qps_size "$qps_destination") == "$qps_expected_bytes" ]] || {
    _qps_fail "working root disk has the wrong size"
    return 1
  }
  [[ $(_qps_file_identity "$qps_destination") != $(_qps_file_identity "$qps_source") ]] || {
    _qps_fail "working root disk did not receive a distinct inode"
    return 1
  }
  _qps_fsync "$qps_destination" || {
    _qps_fail "cannot flush the initialized root disk"
    return 1
  }
}

_qps_expand_disk() {
  local qps_disk=$1
  local qps_source_bytes=$2
  local qps_working_bytes=$3

  [[ $qps_working_bytes == "$qps_source_bytes" ]] && return 0
  [[ $qps_working_bytes -gt $qps_source_bytes ]] || {
    _qps_fail 'working root disk cannot be smaller than its immutable source'
    return 1
  }
  /usr/bin/truncate -s "$qps_working_bytes" "$qps_disk" || {
    _qps_fail 'cannot sparsely expand the working root disk'
    return 1
  }
  [[ $(_qps_size "$qps_disk") == "$qps_working_bytes" ]] || {
    _qps_fail 'expanded working root disk has the wrong size'
    return 1
  }
  _qps_error "expanded the sparse working disk to $((qps_working_bytes / 1024 / 1024)) MiB"
}

_qps_validate_immutable_source() {
  local qps_source=$1
  local qps_expected_bytes=$2
  local qps_magic=''

  _qps_assert_private_regular_file "$qps_source" 'materialized immutable root disk' || return 1
  [[ $(_qps_size "$qps_source") == "$qps_expected_bytes" ]] || {
    _qps_fail 'materialized immutable root disk has the wrong size'
    return 1
  }
  qps_magic=$(/usr/bin/od -An -tx1 -j 1080 -N 2 "$qps_source" | tr -d '[:space:]') || {
    _qps_fail 'cannot inspect the materialized ext4 superblock'
    return 1
  }
  [[ $qps_magic == 53ef ]] || {
    _qps_fail 'materialized immutable root disk has no ext4 superblock'
    return 1
  }
}

# Expand a signed, manifest-verified Zstandard artifact into an identity-keyed
# immutable APFS source exactly once. The persistent workspace is then cloned
# from this source, so the 6 GiB base blocks are not physically duplicated.
qemu_persistent_storage_materialize_source() {
  local qps_identity=${1:-}
  local qps_compressed=${2:-}
  local qps_compressed_bytes=${3:-}
  local qps_source_sha=${4:-}
  local qps_source_bytes=${5:-}
  local qps_zstd=${6:-}
  local qps_final=''
  local qps_staging=''
  local qps_actual_sha=''
  local qps_lock_path=''

  QEMU_IMMUTABLE_SOURCE_DISK=''
  _qps_is_identity "$qps_identity" || {
    _qps_fail 'bundle identity must be exactly 64 lowercase hexadecimal characters'
    return 1
  }
  _qps_is_identity "$qps_source_sha" || {
    _qps_fail 'source rootfs digest must be exactly 64 lowercase hexadecimal characters'
    return 1
  }
  _qps_is_positive_integer "$qps_compressed_bytes" || return 1
  _qps_is_positive_integer "$qps_source_bytes" || return 1
  [[ -f $qps_compressed && ! -L $qps_compressed ]] || {
    _qps_fail 'compressed root disk is missing or unsafe'
    return 1
  }
  [[ $(_qps_size "$qps_compressed") == "$qps_compressed_bytes" ]] || {
    _qps_fail 'compressed root disk has the wrong size'
    return 1
  }
  [[ -f $qps_zstd && ! -L $qps_zstd && -x $qps_zstd ]] || {
    _qps_fail 'bundled Zstandard decoder is missing or unsafe'
    return 1
  }

  _qps_prepare_state_root || return 1
  qps_final="$QEMU_PERSISTENT_STORAGE_IMAGES_ROOT/$qps_identity.ext4"
  qps_lock_path="$QEMU_PERSISTENT_STORAGE_LOCKS_ROOT/$qps_identity.image.lock"
  exec 8>>"$qps_lock_path" || return 1
  chmod 600 "$qps_lock_path" || { exec 8>&-; return 1; }
  _qps_assert_private_regular_file "$qps_lock_path" 'base-image lock' || {
    exec 8>&-
    return 1
  }
  if ! /usr/bin/lockf -s 8; then
    exec 8>&-
    _qps_fail 'cannot lock base-image materialization'
    return 1
  fi

  for qps_staging in \
    "$QEMU_PERSISTENT_STORAGE_IMAGES_ROOT"/."$qps_identity".initializing.??????; do
    [[ -f $qps_staging && ! -L $qps_staging ]] || continue
    [[ $(_qps_owner "$qps_staging") == $(id -u) ]] || continue
    case "$qps_staging" in
      "$QEMU_PERSISTENT_STORAGE_IMAGES_ROOT/.${qps_identity}.initializing."??????)
        /bin/rm -f -- "$qps_staging" || {
          exec 8>&-
          _qps_fail 'cannot reclaim an interrupted base-image expansion'
          return 1
        }
        ;;
    esac
  done

  if [[ -e $qps_final || -L $qps_final ]]; then
    if ! _qps_validate_immutable_source "$qps_final" "$qps_source_bytes"; then
      exec 8>&-
      return 1
    fi
    QEMU_IMMUTABLE_SOURCE_DISK=$qps_final
    exec 8>&-
    return 0
  fi

  qps_staging=$(mktemp "$QEMU_PERSISTENT_STORAGE_IMAGES_ROOT/.${qps_identity}.initializing.XXXXXX") || {
    exec 8>&-
    return 1
  }
  chmod 600 "$qps_staging" || return 1
  if ! "$qps_zstd" -d -f "$qps_compressed" -o "$qps_staging" >&2; then
    /bin/rm -f -- "$qps_staging"
    exec 8>&-
    _qps_fail 'cannot expand the bundled root disk'
    return 1
  fi
  chmod 600 "$qps_staging" || {
    /bin/rm -f -- "$qps_staging"
    exec 8>&-
    return 1
  }
  if ! _qps_validate_immutable_source "$qps_staging" "$qps_source_bytes"; then
    /bin/rm -f -- "$qps_staging"
    exec 8>&-
    return 1
  fi
  qps_actual_sha=$(/usr/bin/shasum -a 256 "$qps_staging" | awk '{ print $1 }') || {
    /bin/rm -f -- "$qps_staging"
    exec 8>&-
    return 1
  }
  if [[ $qps_actual_sha != "$qps_source_sha" ]]; then
    /bin/rm -f -- "$qps_staging"
    exec 8>&-
    _qps_fail 'expanded root disk does not match its signed manifest digest'
    return 1
  fi
  _qps_fsync "$qps_staging" || return 1
  /bin/mv "$qps_staging" "$qps_final" || return 1
  _qps_fsync "$QEMU_PERSISTENT_STORAGE_IMAGES_ROOT" || return 1
  QEMU_IMMUTABLE_SOURCE_DISK=$qps_final
  exec 8>&-
  _qps_error "materialized immutable base image ${qps_identity:0:12}"
}

_qps_remove_recognized_directory() {
  local qps_directory=$1
  local qps_identity=$2
  local qps_source_sha=$3
  local qps_source_bytes=$4
  local qps_working_bytes=$5
  local qps_allow_missing_disk=${6:-0}

  case "$qps_directory" in
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/$qps_identity"|\
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/.${qps_identity}.initializing."??????|\
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/.${qps_identity}.discarded."*) ;;
    *)
      _qps_fail "refusing to remove a path outside the identity-scoped storage contract: $qps_directory"
      return 1
      ;;
  esac

  _qps_validate_store_directory \
    "$qps_directory" \
    "$qps_identity" \
    "$qps_source_sha" \
    "$qps_source_bytes" \
    "$qps_working_bytes" \
    "$qps_allow_missing_disk" || return 1
  /bin/rm -rf "$qps_directory" || {
    _qps_fail "cannot remove recognized persistent-disk directory: $qps_directory"
    return 1
  }
}

_qps_reap_interrupted_work() {
  local qps_identity=$1
  local qps_source_sha=$2
  local qps_source_bytes=$3
  local qps_working_bytes=$4
  local qps_candidate=''
  local qps_name=''

  for qps_candidate in \
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT"/."$qps_identity".initializing.?????? \
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT"/."$qps_identity".discarded.*; do
    [[ -d $qps_candidate && ! -L $qps_candidate ]] || continue
    qps_name=${qps_candidate##*/}
    case "$qps_name" in
      ."$qps_identity".initializing.??????|."$qps_identity".discarded.*) ;;
      *) continue ;;
    esac
    if _qps_remove_recognized_directory \
      "$qps_candidate" \
      "$qps_identity" \
      "$qps_source_sha" \
      "$qps_source_bytes" \
      "$qps_working_bytes" \
      1; then
      _qps_error "removed interrupted storage transaction $qps_name"
    else
      _qps_error "left unrecognized interrupted storage path untouched: $qps_candidate"
    fi
  done
}

_qps_initialize_persistent_disk() {
  local qps_identity=$1
  local qps_source=$2
  local qps_source_sha=$3
  local qps_source_bytes=$4
  local qps_working_bytes=$5
  local qps_final="$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/$qps_identity"
  local qps_staging=''

  qps_staging=$(mktemp -d \
    "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/.${qps_identity}.initializing.XXXXXX") || {
    _qps_fail 'cannot create persistent-disk staging directory'
    return 1
  }
  chmod 700 "$qps_staging" || return 1
  _qps_assert_private_directory "$qps_staging" 'persistent-disk staging directory' || return 1

  if ! _qps_write_metadata \
    "$qps_staging/metadata.json" \
    "$qps_identity" \
    "$qps_source_sha" \
    "$qps_source_bytes"; then
    _qps_fail 'cannot write persistent-disk metadata'
    return 1
  fi
  if ! _qps_clone_disk "$qps_source" "$qps_staging/rootfs.ext4" "$qps_source_bytes"; then
    _qps_remove_recognized_directory \
      "$qps_staging" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
      "$qps_working_bytes" 1 || true
    return 1
  fi
  if ! _qps_expand_disk "$qps_staging/rootfs.ext4" "$qps_source_bytes" "$qps_working_bytes"; then
    _qps_remove_recognized_directory \
      "$qps_staging" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
      "$qps_working_bytes" 1 || true
    return 1
  fi
  _qps_validate_store_directory \
    "$qps_staging" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
    "$qps_working_bytes" || return 1
  _qps_fsync "$qps_staging" || {
    _qps_fail 'cannot flush persistent-disk staging directory'
    return 1
  }

  [[ ! -e $qps_final && ! -L $qps_final ]] || {
    _qps_fail "persistent-disk directory appeared during initialization: $qps_final"
    return 1
  }
  /bin/mv "$qps_staging" "$qps_final" || {
    _qps_fail 'cannot publish initialized persistent disk'
    return 1
  }
  _qps_fsync "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT" || {
    _qps_fail 'cannot flush persistent-disk parent directory'
    return 1
  }
  _qps_error "initialized persistent workspace ${qps_identity:0:12}"
}

_qps_reset_persistent_disk() {
  local qps_identity=$1
  local qps_source_sha=$2
  local qps_source_bytes=$3
  local qps_working_bytes=$4
  local qps_final="$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/$qps_identity"
  local qps_discarded=''

  [[ -e $qps_final || -L $qps_final ]] || return 0
  _qps_validate_store_directory \
    "$qps_final" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
    "$qps_working_bytes" || return 1

  qps_discarded="$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/.${qps_identity}.discarded.$$.$RANDOM$RANDOM"
  [[ ! -e $qps_discarded && ! -L $qps_discarded ]] || {
    _qps_fail 'cannot allocate reset transaction name'
    return 1
  }
  /bin/mv "$qps_final" "$qps_discarded" || {
    _qps_fail 'cannot detach persistent disk for reset'
    return 1
  }
  _qps_fsync "$QEMU_PERSISTENT_STORAGE_DISKS_ROOT" || return 1
  _qps_remove_recognized_directory \
    "$qps_discarded" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
    "$qps_working_bytes" || return 1
  _qps_error "reset persistent workspace ${qps_identity:0:12}"
}

_qps_select_persistent_disk() {
  local qps_mode=$1
  local qps_identity=$2
  local qps_source=$3
  local qps_source_sha=$4
  local qps_source_bytes=$5
  local qps_working_bytes=$6
  local qps_final=''

  _qps_prepare_state_root || return 1
  _qps_acquire_lock "$qps_identity" || return 1
  QEMU_PERSISTENT_STORAGE_IDENTITY=$qps_identity
  qps_final="$QEMU_PERSISTENT_STORAGE_DISKS_ROOT/$qps_identity"

  _qps_reap_interrupted_work \
    "$qps_identity" "$qps_source_sha" "$qps_source_bytes" "$qps_working_bytes"
  if [[ $qps_mode == reset ]]; then
    if ! _qps_reset_persistent_disk \
      "$qps_identity" "$qps_source_sha" "$qps_source_bytes" "$qps_working_bytes"; then
      qemu_persistent_storage_release_lock
      return 1
    fi
  fi
  if [[ ! -e $qps_final && ! -L $qps_final ]]; then
    if ! _qps_initialize_persistent_disk \
      "$qps_identity" "$qps_source" "$qps_source_sha" "$qps_source_bytes" \
      "$qps_working_bytes"; then
      qemu_persistent_storage_release_lock
      return 1
    fi
  fi
  if ! _qps_validate_store_directory \
    "$qps_final" "$qps_identity" "$qps_source_sha" "$qps_source_bytes" \
    "$qps_working_bytes"; then
    qemu_persistent_storage_release_lock
    return 1
  fi
  [[ $(_qps_file_identity "$qps_final/rootfs.ext4") != $(_qps_file_identity "$qps_source") ]] || {
    qemu_persistent_storage_release_lock
    _qps_fail 'persistent root disk aliases the immutable source disk'
    return 1
  }

  QEMU_SELECTED_DISK="$qps_final/rootfs.ext4"
  QEMU_SELECTED_STORAGE_MODE=persistent
  QEMU_PERSISTENT_STORAGE_DIRECTORY=$qps_final
}

_qps_select_ephemeral_disk() {
  local qps_source=$1
  local qps_source_bytes=$2
  local qps_work_directory=$3
  local qps_working_bytes=${4:-$qps_source_bytes}
  local qps_final="$qps_work_directory/rootfs.ext4"
  local qps_staging="$qps_work_directory/.rootfs.ext4.initializing.$$.$RANDOM$RANDOM"

  _qps_assert_private_directory "$qps_work_directory" 'ephemeral work directory' || return 1
  [[ ! -e $qps_final && ! -L $qps_final ]] || {
    _qps_fail "ephemeral root disk already exists: $qps_final"
    return 1
  }
  if ! _qps_clone_disk "$qps_source" "$qps_staging" "$qps_source_bytes"; then
    [[ ! -e $qps_staging && ! -L $qps_staging ]] || /bin/rm -f "$qps_staging"
    return 1
  fi
  if ! _qps_expand_disk "$qps_staging" "$qps_source_bytes" "$qps_working_bytes"; then
    [[ ! -e $qps_staging && ! -L $qps_staging ]] || /bin/rm -f "$qps_staging"
    return 1
  fi
  /bin/mv "$qps_staging" "$qps_final" || {
    _qps_fail 'cannot publish ephemeral root disk'
    return 1
  }
  _qps_fsync "$qps_work_directory" || return 1

  QEMU_SELECTED_DISK=$qps_final
  QEMU_SELECTED_STORAGE_MODE=ephemeral
  QEMU_PERSISTENT_STORAGE_DIRECTORY=''
  QEMU_PERSISTENT_STORAGE_IDENTITY=''
}

# Select and prepare a QEMU root disk.
#
# Arguments:
#   1. mode: persistent (default lifecycle), reset, or ephemeral
#   2. exact 64-character lowercase guest-manifest SHA-256
#   3. validated immutable source rootfs path
#   4. validated source-rootfs SHA-256 from the manifest
#   5. source-rootfs byte count from the manifest
#   6. private run directory (required only for ephemeral mode)
#   7. working rootfs byte count (optional; defaults to source size)
#
# On success, QEMU_SELECTED_DISK and QEMU_SELECTED_STORAGE_MODE are populated.
# Persistent/reset mode also holds FD 9 until the caller exits or explicitly
# calls qemu_persistent_storage_release_lock.
qemu_persistent_storage_select() {
  local qps_mode=${1:-}
  local qps_identity=${2:-}
  local qps_source=${3:-}
  local qps_source_sha=${4:-}
  local qps_source_bytes=${5:-}
  local qps_work_directory=${6:-}
  local qps_working_bytes=${7:-$qps_source_bytes}

  QEMU_SELECTED_DISK=''
  QEMU_SELECTED_STORAGE_MODE=''
  QEMU_PERSISTENT_STORAGE_DIRECTORY=''
  QEMU_PERSISTENT_STORAGE_IDENTITY=''
  QEMU_PERSISTENT_STORAGE_LOCK_PATH=''
  QEMU_PERSISTENT_STORAGE_WORKING_BYTES=''

  case "$qps_mode" in
    persistent|reset|ephemeral) ;;
    *)
      _qps_fail "storage mode must be persistent, reset, or ephemeral"
      return 1
      ;;
  esac
  _qps_is_identity "$qps_identity" || {
    _qps_fail 'bundle identity must be exactly 64 lowercase hexadecimal characters'
    return 1
  }
  _qps_is_identity "$qps_source_sha" || {
    _qps_fail 'source rootfs digest must be exactly 64 lowercase hexadecimal characters'
    return 1
  }
  _qps_is_positive_integer "$qps_source_bytes" || {
    _qps_fail 'source rootfs byte count must be a positive integer'
    return 1
  }
  _qps_is_positive_integer "$qps_working_bytes" || {
    _qps_fail 'working rootfs byte count must be a positive integer'
    return 1
  }
  (( qps_working_bytes >= qps_source_bytes )) || {
    _qps_fail 'working rootfs byte count cannot be smaller than the source'
    return 1
  }
  _qps_assert_source_disk "$qps_source" "$qps_source_bytes" || return 1
  QEMU_PERSISTENT_STORAGE_WORKING_BYTES=$qps_working_bytes

  if [[ $qps_mode == ephemeral ]]; then
    _qps_select_ephemeral_disk \
      "$qps_source" "$qps_source_bytes" "$qps_work_directory" "$qps_working_bytes"
  else
    _qps_select_persistent_disk \
      "$qps_mode" "$qps_identity" "$qps_source" "$qps_source_sha" \
      "$qps_source_bytes" "$qps_working_bytes"
  fi
}
