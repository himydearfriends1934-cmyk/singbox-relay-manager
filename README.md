# RelayKit 中转面板

面向 OpenWrt + OpenClash 的香港中转 / 美国落地配置面板。浏览器中填入节点分享链接或手动参数，保存后自动生成带 `dialer-proxy` 的 Mihomo/OpenClash 订阅。

## 🚀 一键安装入口

在香港 VPS 的 **root 终端**运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/himydearfriends1934-cmyk/singbox-relay-manager/master/bootstrap.sh)
```

脚本启动后的执行顺序：

1. 检查 `curl`、`tar`、`openssl`、Docker 和 Docker Compose v2；旧版 `docker-compose 1.x` 不会被继续使用。
2. 发现缺失依赖时，根据 Debian/Ubuntu、CentOS/RHEL 或 Alpine 的包管理器自动安装。
3. 自动清理旧版 Compose 失败安装遗留的 RelayKit 容器，不删除持久化配置。
4. 依赖全部就绪后，检查面板端口；端口被占用时自动推荐下一个可用端口。
5. 进入密码、订阅令牌和节点配置。
6. 带默认值的选项直接回车即可；节点链接回车表示稍后在面板填写。

> 上面的远程入口本身需要系统已有 `curl` 才能下载脚本；绝大多数 VPS 镜像默认自带。若没有，先执行 `apt-get update && apt-get install -y curl`，之后其余依赖均由安装器自动处理。

安装完成后，随时输入以下简易命令即可重新打开管理菜单：

```bash
rk
```

```text
手机 / 电脑 → OpenWrt + OpenClash → 香港中转 → 美国落地 → 美国出口
```

## 香港 VPS 部署（推荐 Docker）

### 安装菜单与卸载

把项目上传或克隆到 VPS 后，以 root 运行菜单：

```bash
bash setup.sh
```

菜单提供：

```text
1. 一键安装 / 更新
2. 一键卸载
3. 一键查看面板地址信息
```

安装成功后会创建全局快捷命令 `rk`，作用等同于重新运行一键安装入口，但不需要再次输入长网址。

安装时会询问面板端口、密码、订阅令牌和节点分享链接。每个带默认值的项目直接回车即可采用推荐设置；节点链接回车则跳过，之后可在面板填写。安装成功后会显示面板地址、密码和完整订阅地址。

也可以直接执行：

```bash
sudo bash install.sh
sudo bash uninstall.sh
```

安装完成后，任意目录都可以运行 `relaykit-uninstall`。卸载默认询问是否保留 `data/` 与 `dist/`；无人值守并彻底删除可执行：

```bash
sudo relaykit-uninstall --yes --purge
```

安装成功时会显示面板地址、登录密码和订阅地址，并保存到仅 root 可读的 `/opt/relaykit/relaykit-info.txt`。以后可重新运行一键安装命令选择菜单 `3`，或直接执行：

```bash
relaykit-info
```

VPS 安装好 Docker 后，在项目目录执行：

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

然后打开：

```text
http://香港VPS的IP:8787
```

用户名可以任意填写，密码是 `.env` 中的 `RELAYKIT_PASSWORD`。建议在防火墙只放行自己的 IP，正式长期使用时再通过 Caddy/Nginx 配置 HTTPS。

订阅地址：

```text
http://香港VPS的IP:8787/openclash.yaml?token=你的RELAYKIT_TOKEN
```

`data/` 保存面板配置，`dist/` 保存生成的订阅；两者都通过 volume 持久化，重建容器不会丢失。

更新项目后：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f relaykit
```

## 不使用 Docker

需要 Node.js 20 或更高版本：

```bash
RELAYKIT_PASSWORD='强密码' \
RELAYKIT_TOKEN='长随机令牌' \
node src/panel.js
```

可选环境变量：`RELAYKIT_HOST`（默认 `0.0.0.0`）、`RELAYKIT_PORT`（默认 `8787`）。对外监听时，面板密码和订阅 token 都是必填项。

## 面板使用

默认首页采用三步简易模式：填写一个香港中转、添加一个或多个美国落地，然后选择输出格式。订阅批量导入、策略分组和实时控制器统一收进“高级设置”。

- 订阅自动导入：分别填写香港和美国订阅 URL，可识别普通分享链接列表、Base64 订阅以及 Clash/Mihomo YAML。订阅 URL 也可直接粘贴到普通分享链接框，系统会按 `http/https` 自动切换导入方式。香港默认使用第一个有效节点，美国自动导入全部有效节点，并显示订阅总数、导入数和过滤数。
- 香港中转：粘贴一条分享链接，或展开“手动参数”编辑 JSON。
- 美国落地：支持多台，每台使用唯一 ID，例如 `us-west`、`us-east`。
- 业务分组：可添加 GPT AI、视频、其他兜底或自定义域名组；每组支持纯自动或“自动 + 手动选择”。
- 支持 `ss`、`vmess`、`vless`、`trojan`、`hysteria2/hy2`、`tuic` 分享链接。
- 每次保存都会校验参数；香港与至少一台美国节点齐全时，自动刷新 `dist/openclash.yaml`。
- YAML 文件：配置完整后可点击面板底部“下载 YAML”，直接获得 `openclash.yaml` 并手动上传到 OpenClash。
- 输出格式：支持 V2Ray Base64 订阅、OpenClash 完整 YAML、Clash Proxy Provider YAML 和通用原始链接列表。
- 页面密码输入框只是替换链接，留空会保留页面中显示的当前参数。
- 实时状态：填写 OpenClash/Mihomo 的 `external-controller` 地址与 Secret 后，面板每 3 秒显示各策略组当前节点和活跃连接链路。香港 VPS 需要能访问该控制器，推荐使用 Tailscale/WireGuard 内网地址，不要把控制器无保护地暴露到公网。

### 更换出口 VPS 时不再操作软路由

软路由首次部署时，把固定订阅地址加入 OpenClash，并开启配置订阅定时更新。以后在面板中保留原节点 ID（如 `us-main`），只粘贴新 VPS 的分享链接并保存。订阅 URL、节点显示名和策略组名保持不变，OpenClash 下次自动更新后切换到新出口；已选策略也会通过 `profile.store-selected` 保留。

## 命令行仍然可用

```bash
node src/cli.js init
node src/cli.js import hk --link "ss://..."
node src/cli.js add-us us-west --link "ss://..."
node src/cli.js gen
node src/cli.js status
```

运行测试：

```bash
node --test test/*.test.js
```

## 文件说明

```text
data/relaykit.json   节点参数（含密钥，不提交 Git）
dist/openclash.yaml  生成的订阅（含密钥，不提交 Git）
public/              面板前端
src/panel.js         面板与订阅 HTTP 服务
```
