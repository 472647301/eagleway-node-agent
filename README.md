# Eagleway Node Agent

Eagleway Node Agent 是 Eagleway Network VPN 代理应用部署在自有 VPS 上的节点控制代理。中心接口端位于私有仓库 `eagleway-network-api`；Agent 接收中心控制请求，管理本机协议运行时和用户，并向中心服务上报流量快照。

当前代码已实现节点 API、SQLite 状态、Xray-core 三协议用户适配、流量上报、日志读取、Ubuntu/Alibaba Cloud Linux 3/宝塔预检和受限提权 helper。当前发布包是否可投产，以目标 VPS 灰度及中心联调记录为准，见[上线验收](docs/release-acceptance.md)。

## 项目定位

- 项目名：`eagleway-node-agent`
- 当前版本协议：Trojan、VLESS、VMess
- 统一运行时：`xray-core`
- 中心服务：`eagleway-network-api`
- 部署方式：PM2 fork 单实例
- 本地状态：SQLite
- 当前版本操作系统：Ubuntu x64/arm64、Alibaba Cloud Linux 3 x64，以及两者的宝塔 Nginx 环境

Agent 不是中心数据库的副本。中心服务始终是节点配置、用户分配和流量账本的事实源；SQLite 仅用于保存本机执行状态、用户与运行时标识映射、上报游标和资源所有权。

## 当前版本范围

包含：

- Trojan、VLESS、VMess 安装、卸载、启动、停止和状态查询。
- 三协议用户全量同步、增量新增/更新和删除。
- 按用户累计上下行流量采集。
- 节点主动向中心上报流量和 Xray 实际用户数。
- 安全的本机日志文件列表和分页读取。
- 空白 Ubuntu/Alibaba Cloud Linux 3 VPS 与对应宝塔 Nginx 环境的预检和安装。
- 中断识别、幂等控制和结构化错误。

不包含：

- 通用 CentOS/RHEL、Alibaba Cloud Linux 2/4 支持。
- Shadowsocks 实现。
- 443 端口上的 TLS/SNI 多路复用。
- 流量超额禁用、删除或告警。
- HMAC、JWT 等应用层节点鉴权。
- 中心业务数据的本地复制。

## 文档

- [运维与服务器自测手册](docs/operations-runbook.md)
- [当前架构](docs/architecture.md)
- [节点 API 契约](docs/node-api-contract.md)
- [当前安装与运维边界](docs/installation-and-operations.md)
- [当前中心 API 集成](docs/central-api-integration.md)
- [上线验收清单](docs/release-acceptance.md)
- [文档索引与维护原则](docs/README.md)
- [当前运行边界](docs/decisions.md)

## 安全基线

当前版本使用中心固定出口 IP 白名单限制控制接口访问。公网传输仍建议使用 HTTPS；如果暂时使用 HTTP，必须同时在云安全组和主机防火墙限制来源，不得将控制端口开放给任意公网地址。

0.2.1 一并更新 Node.js 运行时及 compression、gRPC、proxy-addr、Multer、js-yaml 的安全依赖版本。CI 和发布流水线执行 `pnpm audit --prod`；具体锁定版本与验证边界见[上线验收](docs/release-acceptance.md)。

0.2.2 升级 Xray-core 至 v26.10.29，并定向更新 body-parser、Multer、qs 的受影响间接依赖版本，以通过当前发布审计。

用户 credential、证书私钥、完整连接配置和命令参数不得写入普通日志。`assignmentId` 是非秘密的稳定业务标识。

## 本地开发

```bash
cp .env.example .env
# 至少填写 NODE_ID，并在不测试上报时设置 REPORTING_ENABLED=false
pnpm install
pnpm verify
```

开发和 CI 使用 `.node-version` 指定的 Node.js 22.23.4；nvm 用户可先执行 `nvm install 22.23.4 && nvm use 22.23.4`。

Linux x64/arm64 在构建后运行 `bash scripts/test-xray-runtime.sh`，下载并校验固定核心，执行三协议真实核心集成测试。其他平台可自行校验对应官方 v26.10.29 核心后，使用 `XRAY_TEST_BINARY=/绝对路径/xray pnpm test:xray`。测试需要 OpenSSL 和本机 loopback 监听权限，不依赖 systemd 或生产证书；VPS 验收另按操作手册执行。

## 发布新版本

版本代码合并到 `main` 并确认工作区干净后，创建并推送一个新的 `v*` tag：

```bash
git switch main
git pull --ff-only
pnpm verify
git status --short
git push origin main
git tag -a v0.2.2 -m "release: v0.2.2"
git push origin v0.2.2
```

`git status --short` 应无输出。tag 推送后可在 [Release workflow](https://github.com/472647301/eagleway-node-agent/actions/workflows/release.yml) 查看构建进度；成功后产物会发布到 [GitHub Releases](https://github.com/472647301/eagleway-node-agent/releases)。已经发布的 tag 不要强制覆盖，修复后创建新的递增版本 tag。

## Linux Bootstrap

推送 `v*` tag 会触发 Release workflow，在 Linux x64 和 arm64 runner 上完成验证、Nest 构建和生产依赖安装，并发布以下带 SHA-256 校验文件的 GitHub Release assets。x64 包中的原生模块在 glibc 2.31 环境重建和加载验证，可用于 glibc 2.32 的 Alibaba Cloud Linux 3：

- `eagleway-node-agent-linux-x64.tar.gz`
- `eagleway-node-agent-linux-arm64.tar.gz`

也可以手动运行 Release workflow；手动运行的产物保留在对应 Actions run 中，不会创建 GitHub Release。

Release workflow 完成后，在 VPS 上只需下载同一个 tag 中的部署脚本并运行：

```bash
TAG=v0.2.2
curl -fsSL "https://raw.githubusercontent.com/472647301/eagleway-node-agent/${TAG}/scripts/deploy-ubuntu-release.sh" -o /tmp/eagleway-deploy.sh
bash /tmp/eagleway-deploy.sh "${TAG}"
```

脚本会自动识别 x64/arm64、下载 release 和校验文件、验证 SHA-256、解压并调用 Bootstrap。文件名为兼容旧版本仍保留 `ubuntu`，但脚本会读取 `/etc/os-release` 并支持 Ubuntu 与 Alibaba Cloud Linux 3。首次运行会创建 `~/.config/eagleway-node-agent/agent.env` 并打开编辑器；至少填写 `NODE_ID`、`ALLOWED_CIDRS` 和 `REPORTING_ENABLED`。服务器带宽由中心 API 自行维护，不需要写入 Agent 配置。后续升级只需：

```bash
bash /opt/eagleway-node-agent/current/scripts/deploy-ubuntu-release.sh v0.2.2
```

部署后常用检查：

主机防火墙

```bash
sudo ufw status verbose                   # Ubuntu
sudo firewall-cmd --state                 # Alibaba Cloud Linux 3
```

安装或修改 Xray 配置时，受限 helper 会在已启用的 UFW 或 firewalld 中自动放行 TCP 80 和当前协议端口；云安全组仍需在云平台配置。

```bash
sudo -u eagleway-agent -H eagleway-agent-pm2 status
sudo -u eagleway-agent -H eagleway-agent-pm2 describe eagleway-node-agent
sudo -u eagleway-agent -H eagleway-agent-pm2 logs eagleway-node-agent --nostream --lines 200
curl -fsS http://127.0.0.1:8086/api/health
```

Bootstrap 要求 Node.js `>=22.23.4 <23`，会优先复用调用者 PATH 中符合条件的已有 Node，再检查系统路径。Node 二进制、符号链接路径及目标的各级目录必须归 root 所有、不可由组或其他用户写入，且 `eagleway-agent` 能执行。低版本、其他主版本、用户可写的 nvm 安装或不可访问的路径会被跳过；没有合格版本时，从 nodejs.org 下载固定 SHA-256 校验的官方 22.23.4，安装到 `/opt/eagleway-node-agent/runtimes`。共享 Node 不会被升级、降级或删除。

可显式指定已有 Node，部署脚本会在 sudo 前保存路径，并在提权后检查；不合格时仍自动选择其他合格版本或专用运行时：

```bash
bash /tmp/eagleway-deploy.sh "${TAG}" --node-bin /usr/local/bin/node
```

PM2 7.1.0 随 release 打包，管理命令统一为 `eagleway-agent-pm2`。Bootstrap 校验平台、架构和原生模块 ABI，以服务用户加载 `better-sqlite3` 后才切换 release；选定的 Node 记录在 `current/runtime/node.json`，Agent、PM2 daemon、helper、卸载和 systemd 开机启动使用同一个运行时。升级会重建专用 PM2 daemon。服务器不执行 npm/pnpm 安装或 Nest/TypeScript 构建。应用发布目录和 helper 均归 root 所有，Agent 用户只有状态、密钥和日志目录所需权限。

旧节点应备份配置与 SQLite 后部署新 release；只重新运行旧版 Bootstrap 不会修复它对旧 Node 22 的跳过逻辑。部署后检查 PM2 显示的实际 Node 版本及健康接口。其他服务仍在使用的旧共享 Node，需要由运维单独安排安全更新。

首次部署、服务器本机全功能自测、与中心联调、源码升级和人工回滚的可执行步骤见[运维与服务器自测手册](docs/operations-runbook.md)。

## Linux 卸载

完整卸载 Agent 及其管理的 Xray 运行时：

```bash
sudo bash /opt/eagleway-node-agent/current/scripts/uninstall-ubuntu.sh
```

脚本执行前要求输入 `uninstall` 确认。自动化执行可加 `--yes`；需要保留 `/etc/eagleway-node-agent`、SQLite 状态、日志和服务用户时可加 `--keep-data`。脚本会保留共享的 Node.js、PM2、Nginx、Certbot、证书和非 Eagleway 网站。卸载前应先在中心停止控制请求和用户分配，卸载后还需从中心注销节点并检查云安全组规则。

安装协议时，受限 helper 会根据 VPS 架构直接下载源码中固定的 XTLS 官方 GitHub Release（当前为稳定版 `v26.10.29`），并使用源码内固定的 SHA-256 校验后再安装。控制请求和环境变量都不能改变下载地址、版本或校验值；0.2.2 将核心更新为 v26.10.29。部署新版 Agent 不会自动替换已安装的核心，重复 install 和 config/apply 也不会升级二进制；存量节点按[核心升级与回滚](docs/xray-core-upgrade.md)在维护窗口操作。

## 当前验收状态

- 当前类型检查、Nest 构建和自动化测试的入口为 `pnpm verify`；测试用例覆盖配置、SQLite、加密、日志边界、IP 处理以及 Xray protobuf 大整数计数。
- 当前发布包在 Ubuntu、Alibaba Cloud Linux 3 与宝塔环境的真实生命周期、中心联调和实际代理流量结果需按[上线验收](docs/release-acceptance.md)记录；历史源码或其他 release 的检查不能替代当前部署证据。
- 本次文档核对未重新运行服务器灰度或发布 workflow，不更新实测通过结论。
