# SingBox Relay Manager

面向家用 OpenWrt + OpenClash 的小工具：记录香港中转和美国落地两个 sing-box 节点，生成带 `dialer-proxy` 的 OpenClash/Mihomo 配置。终端设备不用装软件，只连家里的软路由。

## 适用结构

```text
手机 / 电脑 / 平板
        ↓
OpenWrt + OpenClash
        ↓
HK-Relay
        ↓
US-via-HK
        ↓
美国出口
```

节点安装继续使用你熟悉的 `fscarmen/sing-box` 一键脚本。本项目只负责记录参数、生成订阅和替换机器。

## 快速开始

```bash
node src/cli.js init
node src/cli.js import hk --link "ss://..."
node src/cli.js import us --link "ss://..."
node src/cli.js add-us us-west --link "ss://..."
node src/cli.js add-us us-east --link "ss://..."
node src/cli.js gen
```

生成文件：

```text
dist/openclash.yaml
```

把这个 YAML 导入 OpenClash，日常选择 `PROXY` 组里的 `US-via-HK`。

也可以安装成全局命令：

```bash
npm link
relaykit status
```

如果 Windows PowerShell 禁止运行 `npm.ps1`，可以直接继续用：

```bash
node src/cli.js status
```

## 换机器

新 VPS 先用 `fscarmen/sing-box` 一键安装，拿到新节点链接后替换对应角色：

```bash
node src/cli.js replace hk --link "ss://..."
node src/cli.js replace us --link "vmess://..."
node src/cli.js replace-us us-west --link "vmess://..."
```

`replace us` 是默认美国出口 `us-main` 的快捷写法。多台美国出口建议用明确 ID：

```bash
node src/cli.js add-us us-west --link "ss://..."
node src/cli.js add-us us-east --link "ss://..."
node src/cli.js add-us us-la --link "trojan://..."
```

删除某台美国出口：

```bash
node src/cli.js remove-us us-la
```

命令会自动更新：

```text
data/relaykit.json
dist/openclash.yaml
```

OpenClash 重新拉取订阅后，家里所有设备都不用改。

## OpenClash 里怎么用

生成的订阅里默认有 3 个节点：

```text
HK-Relay    香港中转节点
US-Direct   美国落地直连，主要用于排查
US-via-HK   美国落地通过香港拨出，日常使用这个
```

如果添加多个美国出口，会自动生成：

```text
US-WEST-via-HK
US-WEST-Direct
US-EAST-via-HK
US-EAST-Direct
```

默认策略组：

```text
PROXY
```

如果你只想强制全部走链式出口，在 OpenClash 里选择 `US-via-HK` 即可。

## 支持导入的链接

当前支持常见分享链接：

```text
ss://
vmess://
vless://
trojan://
hysteria2:// / hy2://
tuic://
```

如果 fscarmen 输出的是 Clash/Mihomo YAML，也可以用 `set` 手动录入：

```bash
node src/cli.js set hk --type ss --server 1.2.3.4 --port 443 --cipher aes-128-gcm --password "secret"
node src/cli.js set us --type vmess --server 5.6.7.8 --port 443 --uuid "uuid" --tls true --network ws --host example.com --path /ws
node src/cli.js set-us us-west --type ss --server 5.6.7.8 --port 443 --cipher aes-128-gcm --password "secret"
```

## 本地订阅服务

需要让 OpenClash 用 URL 拉取时，可以临时启动 HTTP 服务：

```bash
node src/cli.js serve --port 8787 --token "change-me"
```

订阅地址：

```text
http://你的控制机IP:8787/openclash.yaml?token=change-me
```

正式使用时更建议放在自己的 HTTPS 域名后面，或者把生成的 `dist/openclash.yaml` 上传到你自己的私有位置。

## 常用命令

```bash
node src/cli.js status
node src/cli.js validate
node src/cli.js gen --output dist/openclash.yaml
```

## 设计原则

- 节点名固定：`HK-Relay`、`US-Exit`、`US-via-HK`
- 换机器只换参数，不换 OpenClash 里的使用习惯
- 第一版不做大面板，不做多用户，不接管 fscarmen 安装过程
- 优先保证配置少、替换快、容易看懂

## 文件说明

```text
data/relaykit.json              真实节点参数，本地生成，不提交
dist/openclash.yaml             生成给 OpenClash 的订阅，本地生成，不提交
examples/relaykit.example.json  示例配置
examples/openclash.example.yaml 示例订阅
```
