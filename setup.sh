#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

printf '\nRelayKit 香港中转管理\n'
printf '=====================\n'
printf '1. 一键安装 / 更新\n'
printf '2. 一键卸载\n'
printf '3. 一键查看面板地址信息\n'
printf '0. 退出\n\n'
read -r -p '请选择 [1]: ' choice

case "${choice:-1}" in
  1) exec bash "$ROOT_DIR/install.sh" ;;
  2) exec bash "$ROOT_DIR/uninstall.sh" ;;
  3) exec bash "$ROOT_DIR/info.sh" ;;
  0) exit 0 ;;
  *) printf '无效选项。\n' >&2; exit 1 ;;
esac
