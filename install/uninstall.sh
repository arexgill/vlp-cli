#!/bin/sh
set -eu

INSTALL_DIR=${MONKEYPAW_INSTALL_DIR:-$HOME/.local/bin}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DATA_DIR=${DATA_HOME}/monkeypaw
BIN_LINK=${INSTALL_DIR}/monkeypaw
CURRENT_LINK=${DATA_DIR}/current
UNINSTALL_SCRIPT=${DATA_DIR}/uninstall.sh

say() {
  printf '%s\n' "$*"
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

if owned_link_target "$BIN_LINK" >/dev/null 2>&1; then
  rm -f "$BIN_LINK"
fi

current_target=$(owned_link_target "$CURRENT_LINK" || true)
if [ -n "$current_target" ]; then
  remove_owned_dir "$current_target"
fi
rm -f "$CURRENT_LINK"
rm -f "$UNINSTALL_SCRIPT"

if [ -d "$DATA_DIR" ]; then
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 -type d \( -name '*.generation.*' -o -name '.*.install.*' \) -exec rm -rf {} + 2>/dev/null || true
  rmdir "$DATA_DIR" 2>/dev/null || true
fi

say 'Removed Monkeypaw-owned install paths.'
