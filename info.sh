#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${RELAYKIT_INSTALL_DIR:-/opt/relaykit}"
ENV_FILE="$INSTALL_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  printf '未找到 RelayKit 安装信息，请先运行一键安装。\n' >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

server_ip=''
if command -v curl >/dev/null 2>&1; then
  server_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -z "$server_ip" ]]; then
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
server_ip="${server_ip:-你的VPS-IP}"
panel_port="${RELAYKIT_PORT:-8787}"

cat <<EOF

RelayKit 面板信息
=================
面板地址：  http://$server_ip:$panel_port
面板用户名：任意填写
面板密码：  ${RELAYKIT_PASSWORD:-未设置}
订阅地址：  http://$server_ip:$panel_port/openclash.yaml?token=${RELAYKIT_TOKEN:-未设置}
安装目录：  $INSTALL_DIR

EOF
