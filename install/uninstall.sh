#!/bin/sh
set -eu

INSTALL_DIR=${VLP_INSTALL_DIR:-$HOME/.local/bin}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DATA_DIR=${DATA_HOME}/vlp-cli
BIN_LINK=${INSTALL_DIR}/vlp
CURRENT_LINK=${DATA_DIR}/current

say() {
  printf '%s\n' "$*"
}

owned_link_target() {
  link_path=$1
  [ -L "$link_path" ] || return 1
  target=$(readlink "$link_path" || true)
  [ -n "$target" ] || return 1
  case "$target" in
    ${DATA_DIR}/*)
      printf '%s\n' "$target"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if owned_link_target "$BIN_LINK" >/dev/null 2>&1; then
  rm -f "$BIN_LINK"
fi

version_target=$(owned_link_target "$CURRENT_LINK" || true)
if [ -n "$version_target" ]; then
  rm -rf "$version_target"
fi
rm -f "$CURRENT_LINK"

if [ -d "$DATA_DIR" ]; then
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -exec rm -rf {} + 2>/dev/null || true
  rmdir "$DATA_DIR" 2>/dev/null || true
fi

say 'Removed VLP-owned install paths.'
