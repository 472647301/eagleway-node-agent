# Eagleway Node Agent

Eagleway Node Agent 是部署在自有 VPS 上的节点控制代理。它接收 Eagleway Network API 的控制请求，管理本机协议运行时和用户，并向中心服务上报流量快照。

项目当前已经进入 MVP 实施阶段。已实现节点 API、SQLite 状态、Trojan-Go 用户适配、流量上报、日志读取、Ubuntu/宝塔预检和受限提权 helper；真实 Ubuntu 与宝塔 VPS 灰度仍是发布前门槛。

## 项目定位

- 项目名：`eagleway-node-agent`
- 首个协议：Trojan
- 首个运行时：`trojan-go`
- 后续运行时：计划通过适配器接入 `xray-core`
- 中心服务：`eagleway-network-api`
- 部署方式：PM2 fork 单实例
- 本地状态：SQLite
- 第一阶段操作系统：Ubuntu、Ubuntu + 宝塔

Agent 不是中心数据库的副本。中心服务始终是节点配置、用户分配和流量账本的事实源；SQLite 仅用于保存本机执行状态、用户与运行时标识映射、上报游标和资源所有权。

## 第一阶段范围

包含：

- Trojan 安装、卸载、启动、停止和状态查询。
- Trojan 用户全量同步、增量新增/更新和删除。
- 用户累计流量与速度采集。
- 节点主动向中心上报流量。
- 安全的本机日志文件列表和分页读取。
- 空白 Ubuntu VPS 与 Ubuntu 宝塔环境的预检和安装。
- 中断识别、幂等控制和结构化错误。

不包含：

- 对旧 `trojan-api` 的接口兼容。
- CentOS/RHEL 支持。
- VLESS、VMess、Shadowsocks 实现。
- 443 端口上的 TLS/SNI 多路复用。
- 流量超额禁用、删除或告警。
- HMAC、JWT 等应用层节点鉴权。
- 中心业务数据的本地复制。

## 文档

- [架构设计](docs/architecture.md)
- [节点 API 契约](docs/node-api-contract.md)
- [安装与运维设计](docs/installation-and-operations.md)
- [中心 API 配套改造](docs/central-api-integration.md)
- [实施与验收计划](docs/implementation-plan.md)
- [已确认的设计决策](docs/decisions.md)

## 安全基线

第一阶段使用中心固定出口 IP 白名单限制控制接口访问。公网传输仍建议使用 HTTPS；如果暂时使用 HTTP，必须同时在云安全组和主机防火墙限制来源，不得将控制端口开放给任意公网地址。

用户 credential、assignmentKey、证书私钥、完整连接配置和命令参数不得写入普通日志。

## 本地开发

```bash
cp .env.example .env
# 至少填写 NODE_ID，并在不测试上报时设置 REPORTING_ENABLED=false
pnpm install
pnpm verify
```

## Ubuntu Bootstrap

在准备好的源码目录执行：

```bash
sudo ./scripts/bootstrap-ubuntu.sh \
  /path/to/eagleway-node-agent \
  <node-id> \
  <center-ip/32> \
  <center-api-url>
```

Bootstrap 会创建低权限用户、安装 PM2、构建项目、安装受限 helper 并配置单实例开机启动。应用发布目录和 helper 均归 root 所有，Agent 用户只有状态、密钥和日志目录所需权限。

完成后还必须由 root 在 `/etc/eagleway-node-agent/runtime-policy.json` 配置 Trojan-Go artifact 的 HTTPS 地址和 SHA-256，然后重启 Agent。helper 只信任这个不可由 Agent 修改的策略文件，不接受控制请求指定下载物：

```json
{
  "archiveUrl": "https://example.com/trojan-go-linux-amd64.zip",
  "archiveSha256": "64-character-lowercase-sha256"
}
```

## 当前验收状态

- 本地类型检查、Nest 构建和自动化测试已覆盖配置、SQLite、加密、日志边界、IP 处理以及 Trojan-Go 大整数/无 shell 参数调用。
- 普通 Ubuntu 和宝塔的真实 VPS 生命周期灰度尚未完成，因此当前版本是可联调 MVP，不应直接批量投产。

