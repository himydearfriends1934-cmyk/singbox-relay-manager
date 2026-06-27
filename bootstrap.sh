#!/usr/bin/env bash
set -Eeuo pipefail

archive_url="https://github.com/himydearfriends1934-cmyk/singbox-relay-manager/archive/refs/heads/master.tar.gz"
temp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$temp_dir"; }
trap cleanup EXIT

command -v curl >/dev/null 2>&1 || { printf '错误：系统需要 curl。\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '错误：系统需要 tar。\n' >&2; exit 1; }

printf '正在下载 RelayKit……\n'
curl -fsSL "$archive_url" | tar -xz -C "$temp_dir" --strip-components=1
bash "$temp_dir/setup.sh"
