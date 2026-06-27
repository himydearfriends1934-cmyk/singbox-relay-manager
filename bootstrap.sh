#!/usr/bin/env bash
set -Eeuo pipefail

archive_url="https://codeload.github.com/himydearfriends1934-cmyk/singbox-relay-manager/tar.gz/refs/heads/master"
temp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$temp_dir"; }
trap cleanup EXIT

if ! command -v tar >/dev/null 2>&1; then
  printf '未检测到 tar，正在自动安装……\n'
  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y tar
  elif command -v dnf >/dev/null 2>&1; then dnf install -y tar
  elif command -v yum >/dev/null 2>&1; then yum install -y tar
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache tar
  else printf '错误：无法自动安装 tar。\n' >&2; exit 1; fi
fi

printf '正在下载 RelayKit……\n'
curl -fsSL "$archive_url" | tar -xz -C "$temp_dir" --strip-components=1
bash "$temp_dir/setup.sh"
