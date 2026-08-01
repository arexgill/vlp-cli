#!/bin/sh
set -eu

REPO_OWNER=arexgill
REPO_NAME=monkeypaw
RELEASE_BASE_URL=${MONKEYPAW_RELEASE_BASE_URL:-https://github.com/$REPO_OWNER/$REPO_NAME/releases/download}
RELEASE_API_URL=${MONKEYPAW_RELEASE_API_URL:-https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest}
INSTALL_DIR=${MONKEYPAW_INSTALL_DIR:-$HOME/.local/bin}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DATA_DIR=${DATA_HOME}/monkeypaw

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

resolve_node() {
  for candidate in node node20 nodejs; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    version=$($candidate --version 2>/dev/null | sed 's/^v//')
    major=${version%%.*}
    case "$major" in
      ''|*[!0-9]*)
        continue
        ;;
    esac
    if [ "$major" -ge 20 ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_downloader() {
  if command -v curl >/dev/null 2>&1; then
    printf '%s\n' curl
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    printf '%s\n' wget
    return 0
  fi
  return 1
}

fetch_text() {
  downloader=$1
  url=$2

  case "$downloader" in
    curl)
      curl -fsSL "$url"
      ;;
    wget)
      wget -qO- "$url"
      ;;
    *)
      fail "Unsupported downloader: $downloader"
      ;;
  esac
}

fetch_file() {
  downloader=$1
  url=$2
  destination=$3

  case "$downloader" in
    curl)
      curl -fsSL "$url" -o "$destination"
      ;;
    wget)
      wget -qO "$destination" "$url"
      ;;
    *)
      fail "Unsupported downloader: $downloader"
      ;;
  esac
}

resolve_version() {
  if [ -n "${MONKEYPAW_VERSION:-}" ]; then
    printf '%s\n' "${MONKEYPAW_VERSION#v}"
    return 0
  fi

  payload=$(fetch_text "$DOWNLOADER" "$RELEASE_API_URL") || fail "Unable to resolve the latest Monkeypaw release"
  version=$(printf '%s' "$payload" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "Unable to parse the latest Monkeypaw release version"
  printf '%s\n' "$version"
}

checksum_value() {
  file_path=$1

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file_path" | awk '{print $NF}'
    return 0
  fi

  fail 'Unable to verify checksums: install shasum, sha256sum, or openssl.'
}

replace_symlink() {
  source_path=$1
  target_path=$2
  temp_link=$(mktemp "${target_path}.tmp.XXXXXX") || return 1

  rm -f "$temp_link"
  if ln -s "$source_path" "$temp_link"; then
    :
  else
    status=$?
    rm -f "$temp_link"
    return "$status"
  fi

  if "$NODE_BIN" --input-type=module -e '
    import { renameSync } from "node:fs";
    const [tempPath, targetPath] = process.argv.slice(1);
    renameSync(tempPath, targetPath);
  ' "$temp_link" "$target_path"; then
    return 0
  fi

  status=$?
  rm -f "$temp_link"
  return "$status"
}

owned_link_target() {
  link_path=$1
  [ -L "$link_path" ] || return 1
  target=$(readlink "$link_path" || true)
  [ -n "$target" ] || return 1
  case "$target" in
    "$DATA_DIR"/*)
      printf '%s\n' "$target"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_owned_dir() {
  dir_path=$1
  [ -n "$dir_path" ] || return 0
  case "$dir_path" in
    "$DATA_DIR"/*)
      rm -rf "$dir_path"
      ;;
  esac
}

copy_staged_file() {
  source_path=$1
  target_path=$2

  cp "$source_path" "$target_path"
  chmod 755 "$target_path"
}

require_command tar
require_command mv
require_command ln
require_command rm
require_command cp
require_command chmod
require_command readlink
require_command mktemp
NODE_BIN=$(resolve_node || true)
[ -n "$NODE_BIN" ] || fail 'Monkeypaw requires Node 20+ via node, node20, or nodejs.'
DOWNLOADER=$(resolve_downloader || true)
[ -n "$DOWNLOADER" ] || fail 'Monkeypaw requires curl or wget.'
VERSION=$(resolve_version)
ASSET_NAME=monkeypaw-node-v${VERSION}.tar.gz
CHECKSUM_NAME=${ASSET_NAME}.sha256
UNINSTALL_NAME=uninstall.sh
UNINSTALL_CHECKSUM_NAME=${UNINSTALL_NAME}.sha256
ASSET_URL=${RELEASE_BASE_URL}/v${VERSION}/${ASSET_NAME}
CHECKSUM_URL=${RELEASE_BASE_URL}/v${VERSION}/${CHECKSUM_NAME}
UNINSTALL_URL=${RELEASE_BASE_URL}/v${VERSION}/${UNINSTALL_NAME}
UNINSTALL_CHECKSUM_URL=${RELEASE_BASE_URL}/v${VERSION}/${UNINSTALL_CHECKSUM_NAME}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/monkeypaw-install.XXXXXX")
ARCHIVE_PATH=${TMP_DIR}/${ASSET_NAME}
CHECKSUM_PATH=${TMP_DIR}/${CHECKSUM_NAME}
UNINSTALL_PATH=${TMP_DIR}/${UNINSTALL_NAME}
UNINSTALL_CHECKSUM_PATH=${TMP_DIR}/${UNINSTALL_CHECKSUM_NAME}
EXTRACT_DIR=${TMP_DIR}/extract
NEW_GENERATION_DIR=
PREVIOUS_CURRENT_TARGET=
SWITCHED=0
CURRENT_LINK=${DATA_DIR}/current
BIN_LINK=${INSTALL_DIR}/monkeypaw
UNINSTALL_INSTALL_PATH=${DATA_DIR}/${UNINSTALL_NAME}
UNINSTALL_STAGE_PATH=${TMP_DIR}/${UNINSTALL_NAME}.stage

cleanup() {
  status=$1
  rm -rf "$TMP_DIR"
  if [ "$status" -ne 0 ]; then
    if [ "$SWITCHED" -eq 1 ]; then
      rollback_after_switch
      return
    fi
    remove_owned_dir "$NEW_GENERATION_DIR"
  fi
}
trap 'cleanup $?' EXIT INT TERM HUP

rollback_after_switch() {
  if [ -n "$PREVIOUS_CURRENT_TARGET" ]; then
    replace_symlink "$PREVIOUS_CURRENT_TARGET" "$CURRENT_LINK"
    replace_symlink "$CURRENT_LINK/bin/monkeypaw" "$BIN_LINK"
  else
    rm -f "$BIN_LINK"
    rm -f "$CURRENT_LINK"
  fi
  remove_owned_dir "$NEW_GENERATION_DIR"
  SWITCHED=0
}

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$EXTRACT_DIR"
fetch_file "$DOWNLOADER" "$ASSET_URL" "$ARCHIVE_PATH" || fail "Failed to download ${ASSET_NAME}"
fetch_file "$DOWNLOADER" "$CHECKSUM_URL" "$CHECKSUM_PATH" || fail "Failed to download ${CHECKSUM_NAME}"
fetch_file "$DOWNLOADER" "$UNINSTALL_URL" "$UNINSTALL_PATH" || fail "Failed to download ${UNINSTALL_NAME}"
fetch_file "$DOWNLOADER" "$UNINSTALL_CHECKSUM_URL" "$UNINSTALL_CHECKSUM_PATH" || fail "Failed to download ${UNINSTALL_CHECKSUM_NAME}"
EXPECTED_SUM=$(awk '{print $1}' "$CHECKSUM_PATH")
[ -n "$EXPECTED_SUM" ] || fail 'Downloaded checksum file is empty.'
ACTUAL_SUM=$(checksum_value "$ARCHIVE_PATH")
[ "$EXPECTED_SUM" = "$ACTUAL_SUM" ] || fail 'Checksum verification failed.'
UNINSTALL_EXPECTED_SUM=$(awk '{print $1}' "$UNINSTALL_CHECKSUM_PATH")
[ -n "$UNINSTALL_EXPECTED_SUM" ] || fail 'Downloaded uninstall checksum file is empty.'
UNINSTALL_ACTUAL_SUM=$(checksum_value "$UNINSTALL_PATH")
[ "$UNINSTALL_EXPECTED_SUM" = "$UNINSTALL_ACTUAL_SUM" ] || fail 'Uninstall checksum verification failed.'

tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR" || fail "Failed to extract ${ASSET_NAME}"
[ -d "${EXTRACT_DIR}/monkeypaw-node-v${VERSION}" ] || fail 'Release archive had an unexpected layout.'
NEW_GENERATION_DIR=$(mktemp -d "${DATA_DIR}/${VERSION}.generation.XXXXXX")
rmdir "$NEW_GENERATION_DIR"
mv "${EXTRACT_DIR}/monkeypaw-node-v${VERSION}" "$NEW_GENERATION_DIR"
PREVIOUS_CURRENT_TARGET=$(owned_link_target "$CURRENT_LINK" || true)
replace_symlink "$NEW_GENERATION_DIR" "$CURRENT_LINK"
replace_symlink "$CURRENT_LINK/bin/monkeypaw" "$BIN_LINK"
SWITCHED=1

if ! "$BIN_LINK" --version >/dev/null 2>&1; then
  rollback_after_switch
  fail "Smoke test failed after installing ${VERSION}."
fi

if ! copy_staged_file "$UNINSTALL_PATH" "$UNINSTALL_STAGE_PATH"; then
  rollback_after_switch
  fail "Failed to stage uninstall script."
fi
if ! mv -f "$UNINSTALL_STAGE_PATH" "$UNINSTALL_INSTALL_PATH"; then
  rollback_after_switch
  fail "Failed to install uninstall script."
fi

if [ -n "$PREVIOUS_CURRENT_TARGET" ]; then
  if ! remove_owned_dir "$PREVIOUS_CURRENT_TARGET"; then
    rollback_after_switch
    fail "Failed to remove previous generation."
  fi
fi

say "Installed monkeypaw ${VERSION} to ${BIN_LINK}"
say "Using Node command: ${NODE_BIN}"
say "Installed uninstall script to ${UNINSTALL_INSTALL_PATH}"
