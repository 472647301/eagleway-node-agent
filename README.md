# Eagleway Node Agent

Eagleway Node Agent 是 Eagleway Network VPN 代理应用部署在自有 VPS 上的节点控制代理。中心接口端位于私有仓库 `eagleway-network-api`；Agent 接收中心控制请求，管理本机协议运行时和用户，并向中心服务上报流量快照。

项目当前已经进入 MVP 实施阶段。已实现节点 API、SQLite 状态、Xray-core 三协议用户适配、流量上报、日志读取、Ubuntu/宝塔预检和受限提权 helper；真实 Ubuntu 与宝塔 VPS 灰度仍是发布前门槛。

## 项目定位

- 项目名：`eagleway-node-agent`
- 第一阶段协议：Trojan、VLESS、VMess
- 统一运行时：`xray-core`
- 中心服务：`eagleway-network-api`
- 部署方式：PM2 fork 单实例
- 本地状态：SQLite
- 第一阶段操作系统：Ubuntu、Ubuntu + 宝塔

Agent 不是中心数据库的副本。中心服务始终是节点配置、用户分配和流量账本的事实源；SQLite 仅用于保存本机执行状态、用户与运行时标识映射、上报游标和资源所有权。

## 第一阶段范围

包含：

- Trojan、VLESS、VMess 安装、卸载、启动、停止和状态查询。
- 三协议用户全量同步、增量新增/更新和删除。
- 按用户累计上下行流量采集。
- 节点主动向中心上报流量和 Xray 实际用户数。
- 安全的本机日志文件列表和分页读取。
- 空白 Ubuntu VPS 与 Ubuntu 宝塔环境的预检和安装。
- 中断识别、幂等控制和结构化错误。

不包含：

- 对旧 `trojan-api` 的接口兼容。
- CentOS/RHEL 支持。
- Shadowsocks 实现。
- 443 端口上的 TLS/SNI 多路复用。
- 流量超额禁用、删除或告警。
- HMAC、JWT 等应用层节点鉴权。
- 中心业务数据的本地复制。

## 文档

- [运维与服务器自测手册](docs/operations-runbook.md)
- [架构设计](docs/architecture.md)
- [节点 API 契约](docs/node-api-contract.md)
- [安装与运维设计](docs/installation-and-operations.md)
- [中心 API 配套改造](docs/central-api-integration.md)
- [实施与验收计划](docs/implementation-plan.md)
- [已确认的设计决策](docs/decisions.md)

## 安全基线

第一阶段使用中心固定出口 IP 白名单限制控制接口访问。公网传输仍建议使用 HTTPS；如果暂时使用 HTTP，必须同时在云安全组和主机防火墙限制来源，不得将控制端口开放给任意公网地址。

用户 credential、证书私钥、完整连接配置和命令参数不得写入普通日志。`assignmentId` 是非秘密的稳定业务标识。

## 本地开发

```bash
cp .env.example .env
# 至少填写 NODE_ID，并在不测试上报时设置 REPORTING_ENABLED=false
pnpm install
pnpm verify
```

## 发布新版本

版本代码合并到 `main` 并确认工作区干净后，创建并推送一个新的 `v*` tag：

```bash
git switch main
git pull --ff-only
pnpm verify
git status --short
git push origin main
git tag -a v0.1.7 -m "release: v0.1.7"
git push origin v0.1.7
```

`git status --short` 应无输出。tag 推送后可在 [Release workflow](https://github.com/472647301/eagleway-node-agent/actions/workflows/release.yml) 查看构建进度；成功后产物会发布到 [GitHub Releases](https://github.com/472647301/eagleway-node-agent/releases)。已经发布的 tag 不要强制覆盖，修复后创建新的递增版本 tag。

## Ubuntu Bootstrap

推送 `v*` tag 会触发 Release workflow，在 Ubuntu x64 和 arm64 runner 上完成验证、Nest 构建和生产依赖安装，并发布以下带 SHA-256 校验文件的 GitHub Release assets：

- `eagleway-node-agent-linux-x64.tar.gz`
- `eagleway-node-agent-linux-arm64.tar.gz`

也可以手动运行 Release workflow；手动运行的产物保留在对应 Actions run 中，不会创建 GitHub Release。

Release workflow 完成后，在 VPS 上只需下载同一个 tag 中的部署脚本并运行：

```bash
TAG=v0.1.7
curl -fsSL "https://raw.githubusercontent.com/472647301/eagleway-node-agent/${TAG}/scripts/deploy-ubuntu-release.sh" -o /tmp/eagleway-deploy.sh
bash /tmp/eagleway-deploy.sh "${TAG}"
```

脚本会自动识别 x64/arm64、下载 release 和校验文件、验证 SHA-256、解压并调用 Bootstrap。首次运行会创建 `~/.config/eagleway-node-agent/agent.env` 并打开编辑器；至少填写 `NODE_ID`、`ALLOWED_CIDRS` 和 `REPORTING_ENABLED`。服务器带宽由中心 API 自行维护，不需要写入 Agent 配置。后续升级只需：

```bash
bash /opt/eagleway-node-agent/current/scripts/deploy-ubuntu-release.sh v0.1.7
```

部署后常用检查：

Ubuntu 防火墙
```bash
sudo ufw status verbose
```

安装或修改 Xray 配置时，受限 helper 会在已启用的 UFW 或 firewalld 中自动放行 TCP 80 和当前协议端口；云安全组仍需在云平台配置。

```bash
sudo -u eagleway-agent -H pm2 status
sudo -u eagleway-agent -H pm2 describe eagleway-node-agent
sudo -u eagleway-agent -H pm2 logs eagleway-node-agent --nostream --lines 200
curl -fsS http://127.0.0.1:8086/api/health
```

Bootstrap 会校验 release manifest、平台、CPU 架构和 Node.js 主版本，创建低权限用户，安装 Node.js 22 和 PM2，复制 CI 构建产物，安装受限 helper 并配置单实例开机启动；服务器不再运行 `pnpm install` 或 Nest/TypeScript 构建。应用发布目录和 helper 均归 root 所有，Agent 用户只有状态、密钥和日志目录所需权限。

首次部署、服务器本机全功能自测、与中心联调、源码升级和人工回滚的可执行步骤见[运维与服务器自测手册](docs/operations-runbook.md)。

## Ubuntu 卸载

完整卸载 Agent 及其管理的 Xray 运行时：

```bash
sudo bash /opt/eagleway-node-agent/current/scripts/uninstall-ubuntu.sh
```

脚本执行前要求输入 `uninstall` 确认。自动化执行可加 `--yes`；需要保留 `/etc/eagleway-node-agent`、SQLite 状态、日志和服务用户时可加 `--keep-data`。脚本会保留共享的 Node.js、PM2、Nginx、Certbot、证书和非 Eagleway 网站。卸载前应先在中心停止控制请求和用户分配，卸载后还需从中心注销节点并检查云安全组规则。

安装协议时，受限 helper 会根据 VPS 架构直接下载源码中固定的 XTLS 官方 GitHub Release（当前为稳定版 `v26.3.27`），并使用源码内固定的 SHA-256 校验后再安装。控制请求和环境变量都不能改变下载地址、版本或校验值；升级 Xray-core 需要发布新版 Agent。

## 当前验收状态

- 本地类型检查、Nest 构建和自动化测试已覆盖配置、SQLite、加密、日志边界、IP 处理以及 Xray protobuf 大整数计数。
- 普通 Ubuntu 和宝塔的真实 VPS 生命周期灰度尚未完成，因此当前版本是可联调 MVP，不应直接批量投产。
