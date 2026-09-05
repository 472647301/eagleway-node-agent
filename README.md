# Eagleway Node Agent

Eagleway Node Agent 是部署在自有 VPS 上的节点控制代理。它接收 Eagleway Network API 的控制请求，管理本机协议运行时和用户，并向中心服务上报流量快照。

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
- 节点主动向中心上报流量、服务器带宽和 Xray 实际用户数。
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

## Ubuntu Bootstrap

在准备好的源码目录执行：

```bash
sudo ./scripts/bootstrap-ubuntu.sh \
  /path/to/eagleway-node-agent \
  <node-id> \
  <center-ip/32> \
  <bandwidth-mbps> \
  <center-api-url>
```

Bootstrap 会创建低权限用户、安装 PM2、构建项目、安装受限 helper 并配置单实例开机启动。应用发布目录和 helper 均归 root 所有，Agent 用户只有状态、密钥和日志目录所需权限。

安装协议时，受限 helper 会根据 VPS 架构直接下载源码中固定的 XTLS 官方 GitHub Release（当前为稳定版 `v26.3.27`），并使用源码内固定的 SHA-256 校验后再安装。控制请求和环境变量都不能改变下载地址、版本或校验值；升级 Xray-core 需要发布新版 Agent。

## 当前验收状态

- 本地类型检查、Nest 构建和自动化测试已覆盖配置、SQLite、加密、日志边界、IP 处理以及 Xray protobuf 大整数计数。
- 普通 Ubuntu 和宝塔的真实 VPS 生命周期灰度尚未完成，因此当前版本是可联调 MVP，不应直接批量投产。
