#!/bin/sh
set -eu

REPO_OWNER=arexgill
REPO_NAME=vlp-cli
RELEASE_BASE_URL=${VLP_RELEASE_BASE_URL:-https://github.com/$REPO_OWNER/$REPO_NAME/releases/download}
RELEASE_API_URL=${VLP_RELEASE_API_URL:-https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest}
INSTALL_DIR=${VLP_INSTALL_DIR:-$HOME/.local/bin}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DATA_DIR=${DATA_HOME}/vlp-cli

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
  if [ -n "${VLP_VERSION:-}" ]; then
    printf '%s\n' "${VLP_VERSION#v}"
    return 0
  fi

  payload=$(fetch_text "$DOWNLOADER" "$RELEASE_API_URL") || fail "Unable to resolve the latest VLP release"
  version=$(printf '%s' "$payload" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "Unable to parse the latest VLP release version"
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
  temp_link=$2.tmp.$$

  rm -f "$temp_link"
  ln -s "$source_path" "$temp_link"
  rm -f "$target_path"
  mv "$temp_link" "$target_path"
}

require_command tar
NODE_BIN=$(resolve_node || true)
[ -n "$NODE_BIN" ] || fail 'VLP requires Node 20+ via node, node20, or nodejs.'
DOWNLOADER=$(resolve_downloader || true)
[ -n "$DOWNLOADER" ] || fail 'VLP requires curl or wget.'
VERSION=$(resolve_version)
ASSET_NAME=vlp-cli-node-v${VERSION}.tar.gz
CHECKSUM_NAME=${ASSET_NAME}.sha256
ASSET_URL=${RELEASE_BASE_URL}/v${VERSION}/${ASSET_NAME}
CHECKSUM_URL=${RELEASE_BASE_URL}/v${VERSION}/${CHECKSUM_NAME}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vlp-install.XXXXXX")
ARCHIVE_PATH=${TMP_DIR}/${ASSET_NAME}
CHECKSUM_PATH=${TMP_DIR}/${CHECKSUM_NAME}
EXTRACT_DIR=${TMP_DIR}/extract
STAGING_DIR=${DATA_DIR}/.${VERSION}.install.$$
VERSION_DIR=${DATA_DIR}/${VERSION}
CURRENT_LINK=${DATA_DIR}/current
BIN_LINK=${INSTALL_DIR}/vlp

cleanup() {
  rm -rf "$TMP_DIR" "$STAGING_DIR"
}
trap cleanup EXIT INT TERM HUP

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$EXTRACT_DIR"
fetch_file "$DOWNLOADER" "$ASSET_URL" "$ARCHIVE_PATH" || fail "Failed to download ${ASSET_NAME}"
fetch_file "$DOWNLOADER" "$CHECKSUM_URL" "$CHECKSUM_PATH" || fail "Failed to download ${CHECKSUM_NAME}"
EXPECTED_SUM=$(awk '{print $1}' "$CHECKSUM_PATH")
[ -n "$EXPECTED_SUM" ] || fail 'Downloaded checksum file is empty.'
ACTUAL_SUM=$(checksum_value "$ARCHIVE_PATH")
[ "$EXPECTED_SUM" = "$ACTUAL_SUM" ] || fail 'Checksum verification failed.'

tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR" || fail "Failed to extract ${ASSET_NAME}"
[ -d "${EXTRACT_DIR}/vlp-cli-node-v${VERSION}" ] || fail 'Release archive had an unexpected layout.'
rm -rf "$STAGING_DIR"
mv "${EXTRACT_DIR}/vlp-cli-node-v${VERSION}" "$STAGING_DIR"
rm -rf "$VERSION_DIR"
mv "$STAGING_DIR" "$VERSION_DIR"
replace_symlink "$VERSION_DIR" "$CURRENT_LINK"
replace_symlink "$CURRENT_LINK/bin/vlp" "$BIN_LINK"

say "Installed vlp ${VERSION} to ${BIN_LINK}"
say "Using Node command: ${NODE_BIN}"
