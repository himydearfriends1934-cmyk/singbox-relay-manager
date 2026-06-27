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
  docker compose version >/dev/null 2>&1
}

install_compose_plugin() {
  local machine compose_arch compose_version plugin_dir temp_file
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) compose_arch="x86_64" ;;
    aarch64|arm64) compose_arch="aarch64" ;;
    armv7l|armv7) compose_arch="armv7" ;;
    *) die "暂不支持自动安装 Compose 的 CPU 架构：$machine" ;;
  esac
  compose_version="v5.1.2"
  plugin_dir="/usr/local/lib/docker/cli-plugins"
  temp_file="$(mktemp)"
  install -d -m 755 "$plugin_dir"
  curl -fSL "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${compose_arch}" -o "$temp_file"
  install -m 755 "$temp_file" "$plugin_dir/docker-compose"
  rm -f "$temp_file"
}

install_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "未检测到 Docker，正在自动安装"
    if command -v apt-get >/dev/null 2>&1; then install_packages docker.io
    elif command -v apk >/dev/null 2>&1; then install_packages docker
    else install_packages docker; fi
  fi
  if ! has_compose; then
    warn "未检测到 Docker Compose v2，正在自动安装"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin 2>/dev/null || true
    elif command -v apk >/dev/null 2>&1; then
      install_packages docker-cli-compose || true
    else
      install_packages docker-compose-plugin || true
    fi
    has_compose || install_compose_plugin
  fi
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; else service docker start; fi
  command -v docker >/dev/null 2>&1 || die "Docker 安装失败"
  has_compose || die "Docker Compose 安装失败"
  info "Docker 与 Docker Compose 已就绪"
}

compose() {
  docker compose "$@"
}

cleanup_stale_containers() {
  local stale_ids id name
  stale_ids="$(docker ps -aq \
    --filter 'label=com.docker.compose.project=relaykit' \
    --filter 'label=com.docker.compose.service=relaykit' 2>/dev/null || true)"
  while read -r id name; do
    [[ -n "$id" ]] || continue
    case "$name" in
      relaykit|*_relaykit) stale_ids="$stale_ids $id" ;;
    esac
  done < <(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null || true)

  if [[ -n "${stale_ids//[[:space:]]/}" ]]; then
    warn "正在清理上次安装遗留的 RelayKit 容器"
    for id in $stale_ids; do docker rm -f "$id" >/dev/null 2>&1 || true; done
  fi
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

configure_settings() {
  hk_link="${RELAYKIT_HK_LINK:-}"
  us_ids=(); us_links=()
  [[ -n "${RELAYKIT_US_LINK:-}" ]] && { us_ids+=("${RELAYKIT_US_ID:-us-main}"); us_links+=("$RELAYKIT_US_LINK"); }

  if [[ -f "$INSTALL_DIR/.env" ]]; then
    # Preserve credentials and port during unattended updates.
    set -a
    # shellcheck disable=SC1090
    source "$INSTALL_DIR/.env"
    set +a
    panel_port="${RELAYKIT_PORT:-8787}"
    panel_password="${RELAYKIT_PASSWORD:-$(random_hex 12)}"
    subscription_token="${RELAYKIT_TOKEN:-$(random_hex 20)}"
    info "检测到已有安装，自动保留端口、密码和订阅令牌"
  else
    panel_port="${RELAYKIT_PORT:-8787}"
    while port_in_use "$panel_port"; do
      panel_port="$(next_available_port "$((panel_port + 1))")" || die "没有找到可用端口"
    done
    panel_password="${RELAYKIT_PASSWORD:-$(random_hex 12)}"
    subscription_token="${RELAYKIT_TOKEN:-$(random_hex 20)}"
    info "已自动生成安装参数"
  fi

  [[ "$panel_port" =~ ^[0-9]+$ ]] && ((panel_port >= 1 && panel_port <= 65535)) || die "端口必须是 1-65535"
  [[ "$panel_password" =~ ^[A-Za-z0-9._@%+=:-]+$ ]] || die "面板密码格式无效"
  [[ "$subscription_token" =~ ^[A-Za-z0-9._~-]+$ ]] || die "订阅令牌格式无效"
  info "面板端口：$panel_port；节点将在面板中配置"
}

copy_application() {
  install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/dist"
  if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
    cp -a "$SOURCE_DIR/src" "$SOURCE_DIR/public" "$INSTALL_DIR/"
    cp -a "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR/compose.yaml" "$SOURCE_DIR/.dockerignore" "$INSTALL_DIR/"
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

install_shortcuts() {
  install -d -m 755 /usr/local/bin
  ln -sf "$INSTALL_DIR/setup.sh" /usr/local/bin/rk
  ln -sf "$INSTALL_DIR/info.sh" /usr/local/bin/relaykit-info
  ln -sf "$INSTALL_DIR/uninstall.sh" /usr/local/bin/relaykit-uninstall
  info "快捷命令已创建：rk"
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
configure_settings
copy_application
install_shortcuts
cd "$INSTALL_DIR"
cleanup_stale_containers
compose up -d --build

for _ in {1..30}; do
  if docker inspect -f '{{.State.Running}}' relaykit 2>/dev/null | grep -q true; then break; fi
  sleep 1
done
docker inspect -f '{{.State.Running}}' relaykit 2>/dev/null | grep -q true || die "容器启动失败，请运行：cd $INSTALL_DIR && docker compose logs"
import_nodes
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
