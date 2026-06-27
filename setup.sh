#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED_PATH="$(readlink -f "$SCRIPT_PATH" 2>/dev/null || true)"
  [[ -n "$RESOLVED_PATH" ]] && SCRIPT_PATH="$RESOLVED_PATH"
fi
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPOSITORY_ARCHIVE="https://codeload.github.com/himydearfriends1934-cmyk/singbox-relay-manager/tar.gz/refs/heads/master"

install_or_update() {
  # First install runs from a downloaded source tree. The installed rk command
  # must download fresh sources instead of rebuilding the old local copy.
  if [[ "$ROOT_DIR" != "${RELAYKIT_INSTALL_DIR:-/opt/relaykit}" ]]; then
    exec bash "$ROOT_DIR/install.sh"
  fi

  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  printf '正在从 GitHub 获取最新版……\n'
  curl -fsSL "$REPOSITORY_ARCHIVE" | tar -xz -C "$temp_dir" --strip-components=1
  bash "$temp_dir/install.sh"
}

printf '\nRelayKit 香港中转管理\n'
printf '=====================\n'
printf '1. 一键安装 / 更新\n'
printf '2. 一键卸载\n'
printf '3. 一键查看面板地址信息\n'
printf '0. 退出\n\n'
read -r -p '请选择 [1]: ' choice

case "${choice:-1}" in
  1) install_or_update ;;
  2) exec bash "$ROOT_DIR/uninstall.sh" ;;
  3) exec bash "$ROOT_DIR/info.sh" ;;
  0) exit 0 ;;
  *) printf '无效选项。\n' >&2; exit 1 ;;
esac
