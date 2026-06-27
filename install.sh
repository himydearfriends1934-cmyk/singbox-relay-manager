#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${RELAYKIT_INSTALL_DIR:-/opt/relaykit}"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || { printf '安装目录必须是安全的绝对路径。\n' >&2; exit 1; }

green='\033[0;32m'; yellow='\033[1;33m'; red='\033[0;31m'; reset='\033[0m'
info() { printf "${green}✓${reset} %s\n" "$*"; }
warn() { printf "${yellow}!${reset} %s\n" "$*"; }
die() { printf "${red}错误：${reset}%s\n" "$*" >&2; exit 1; }

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "请使用 root 运行：sudo bash install.sh"
fi

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$@"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$@"
  else
    die "无法识别系统包管理器，不能自动安装依赖"
  fi
}

check_base_dependencies() {
  printf '\n正在检查安装依赖……\n'
  local missing=()
  for command_name in curl tar openssl; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  if ((${#missing[@]} > 0)); then
    warn "缺少依赖：${missing[*]}，正在自动安装"
    install_packages ca-certificates "${missing[@]}"
  fi
  for command_name in curl tar openssl; do
    command -v "$command_name" >/dev/null 2>&1 || die "依赖安装失败：$command_name"
  done
  info "基础依赖检查完成"
}

has_compose() {
  docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1
}

install_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "未检测到 Docker，正在自动安装"
    if command -v apt-get >/dev/null 2>&1; then install_packages docker.io
    elif command -v apk >/dev/null 2>&1; then install_packages docker
    else install_packages docker; fi
  fi
  if ! has_compose; then
    warn "未检测到 Docker Compose，正在自动安装"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
    elif command -v apk >/dev/null 2>&1; then install_packages docker-cli-compose
    else install_packages docker-compose-plugin; fi
  fi
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; else service docker start; fi
  command -v docker >/dev/null 2>&1 || die "Docker 安装失败"
  has_compose || die "Docker Compose 安装失败"
  info "Docker 与 Docker Compose 已就绪"
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'; fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q . && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$" && return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq "[:.]${port}->" && return 0
  fi
  (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1 && return 0
  return 1
}

next_available_port() {
  local candidate="$1"
  while ((candidate <= 65535)); do
    if ! port_in_use "$candidate"; then printf '%s' "$candidate"; return 0; fi
    candidate=$((candidate + 1))
  done
  return 1
}

prompt_settings() {
  printf '\n安装参数（直接回车使用括号内默认值）\n'
  printf '%s\n' '--------------------------------------'
  read -r -p '面板端口 [8787]: ' panel_port
  panel_port="${panel_port:-8787}"
  [[ "$panel_port" =~ ^[0-9]+$ ]] && ((panel_port >= 1 && panel_port <= 65535)) || die "端口必须是 1-65535"
  while port_in_use "$panel_port"; do
    suggested_port="$(next_available_port "$((panel_port + 1))")" || die "没有找到可用端口"
    warn "端口 $panel_port 已被占用"
    read -r -p "改用可用端口 [$suggested_port]: " panel_port
    panel_port="${panel_port:-$suggested_port}"
    [[ "$panel_port" =~ ^[0-9]+$ ]] && ((panel_port >= 1 && panel_port <= 65535)) || die "端口必须是 1-65535"
  done
  info "面板将使用可用端口 $panel_port"

  read -r -s -p '面板密码 [回车自动生成]: ' panel_password; printf '\n'
  if [[ -z "$panel_password" ]]; then panel_password="$(random_hex 12)"; fi
  [[ "$panel_password" =~ ^[A-Za-z0-9._@%+=:-]+$ ]] || die "面板密码只能使用字母、数字和 ._@%+=:-"
  read -r -p '订阅令牌 [回车自动生成]: ' subscription_token
  subscription_token="${subscription_token:-$(random_hex 20)}"
  [[ "$subscription_token" =~ ^[A-Za-z0-9._~-]+$ ]] || die "订阅令牌只能使用字母、数字和 ._~-"

  read -r -p '安装后立即录入节点？[Y/n]: ' configure_nodes
  configure_nodes="${configure_nodes:-Y}"
  hk_link=''; us_ids=(); us_links=()
  if [[ "$configure_nodes" =~ ^[Yy]$ ]]; then
    read -r -p '香港中转分享链接 [回车跳过，稍后在面板填写]: ' hk_link
    while true; do
      read -r -p '美国落地分享链接 [回车结束节点录入]: ' us_link
      [[ -z "$us_link" ]] && break
      read -r -p '该落地节点 ID [us-main]: ' us_id
      us_ids+=("${us_id:-us-main}"); us_links+=("$us_link")
      read -r -p '继续添加美国落地？[y/N]: ' add_more
      [[ "${add_more:-N}" =~ ^[Yy]$ ]] || break
    done
  fi
}

copy_application() {
  install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/dist"
  if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
    cp -a "$SOURCE_DIR/src" "$SOURCE_DIR/public" "$INSTALL_DIR/"
    cp -a "$SOURCE_DIR/package.json" "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR/compose.yaml" "$INSTALL_DIR/"
    cp -a "$SOURCE_DIR/install.sh" "$SOURCE_DIR/uninstall.sh" "$SOURCE_DIR/setup.sh" "$SOURCE_DIR/info.sh" "$INSTALL_DIR/"
  fi
  chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh" "$INSTALL_DIR/setup.sh" "$INSTALL_DIR/info.sh"
  cat >"$INSTALL_DIR/.env" <<EOF
RELAYKIT_PASSWORD=$panel_password
RELAYKIT_TOKEN=$subscription_token
RELAYKIT_PORT=$panel_port
EOF
  chmod 600 "$INSTALL_DIR/.env"
}

import_nodes() {
  [[ -n "$hk_link" ]] && docker exec relaykit node src/cli.js import hk --link "$hk_link"
  local index
  for index in "${!us_links[@]}"; do
    docker exec relaykit node src/cli.js add-us "${us_ids[$index]}" --link "${us_links[$index]}"
  done
}

check_base_dependencies
install_docker
prompt_settings
copy_application
cd "$INSTALL_DIR"
compose up -d --build

for _ in {1..30}; do
  if docker inspect -f '{{.State.Running}}' relaykit 2>/dev/null | grep -q true; then break; fi
  sleep 1
done
docker inspect -f '{{.State.Running}}' relaykit 2>/dev/null | grep -q true || die "容器启动失败，请运行：cd $INSTALL_DIR && docker compose logs"
import_nodes

ln -sf "$INSTALL_DIR/uninstall.sh" /usr/local/bin/relaykit-uninstall
ln -sf "$INSTALL_DIR/info.sh" /usr/local/bin/relaykit-info
ln -sf "$INSTALL_DIR/setup.sh" /usr/local/bin/rk
bash "$INSTALL_DIR/info.sh" >"$INSTALL_DIR/relaykit-info.txt"
chmod 600 "$INSTALL_DIR/relaykit-info.txt"

printf '\n'
info "RelayKit 安装完成"
cat "$INSTALL_DIR/relaykit-info.txt"
printf '卸载命令：  relaykit-uninstall\n'
printf '查看信息：  relaykit-info\n'
printf '快捷菜单：  rk\n'
printf '信息文件：  %s/relaykit-info.txt\n' "$INSTALL_DIR"
printf '\n请保存以上信息，并在 VPS 防火墙放行 TCP 端口 %s。\n' "$panel_port"
