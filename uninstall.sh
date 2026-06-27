#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${RELAYKIT_INSTALL_DIR:-/opt/relaykit}"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || { printf '卸载目录不安全。\n' >&2; exit 1; }
assume_yes=0; purge=0
for arg in "$@"; do
  [[ "$arg" == "--yes" || "$arg" == "-y" ]] && assume_yes=1
  [[ "$arg" == "--purge" ]] && purge=1
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '错误：请使用 root 运行卸载。\n' >&2; exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  printf 'RelayKit 未安装在 %s。\n' "$INSTALL_DIR"
  exit 0
fi

if ((assume_yes == 0)); then
  printf '即将停止并删除 RelayKit 容器和程序。\n'
  read -r -p '确认卸载？[y/N]: ' answer
  [[ "${answer:-N}" =~ ^[Yy]$ ]] || { printf '已取消。\n'; exit 0; }
  read -r -p '保留节点配置和订阅文件？[Y/n]: ' keep_data
  [[ "${keep_data:-Y}" =~ ^[Nn]$ ]] && purge=1
fi

cd "$INSTALL_DIR"
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    docker compose down --rmi local --remove-orphans || true
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose down --rmi local --remove-orphans || true
  fi
fi

if ((purge == 1)); then
  rm -rf -- "$INSTALL_DIR"
  printf 'RelayKit 已完全卸载，配置数据也已删除。\n'
else
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name dist ! -name .env -exec rm -rf -- {} +
  printf 'RelayKit 已卸载，配置保留在 %s/data 和 %s/dist。\n' "$INSTALL_DIR" "$INSTALL_DIR"
fi
rm -f /usr/local/bin/relaykit-uninstall
rm -f /usr/local/bin/relaykit-info
