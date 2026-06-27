# RelayKit 中转面板

面向 OpenWrt + OpenClash 的香港中转 / 美国落地配置面板。浏览器中填入节点分享链接或手动参数，保存后自动生成带 `dialer-proxy` 的 Mihomo/OpenClash 订阅。

```text
手机 / 电脑 → OpenWrt + OpenClash → 香港中转 → 美国落地 → 美国出口
```

## 香港 VPS 部署（推荐 Docker）

### 一键安装 / 卸载

在香港 VPS 的 root 终端直接执行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/himydearfriends1934-cmyk/singbox-relay-manager/master/bootstrap.sh)
```

这个命令会下载最新版并打开安装/卸载菜单。请使用上面的 `<(...)` 写法，安装过程才能正常接收键盘输入。

把项目上传或克隆到 VPS 后，以 root 运行菜单：

```bash
bash setup.sh
```

菜单提供：

```text
1. 一键安装 / 更新
2. 一键卸载
```

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

- 香港中转：粘贴一条分享链接，或展开“手动参数”编辑 JSON。
- 美国落地：支持多台，每台使用唯一 ID，例如 `us-west`、`us-east`。
- 业务分组：可添加 GPT AI、视频、其他兜底或自定义域名组；每组支持纯自动或“自动 + 手动选择”。
- 支持 `ss`、`vmess`、`vless`、`trojan`、`hysteria2/hy2`、`tuic` 分享链接。
- 每次保存都会校验参数；香港与至少一台美国节点齐全时，自动刷新 `dist/openclash.yaml`。
- 页面密码输入框只是替换链接，留空会保留页面中显示的当前参数。

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
