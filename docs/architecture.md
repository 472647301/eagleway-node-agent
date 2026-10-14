# 当前 Node Agent 架构

核对日期：2026-10-14。当前包版本为 0.1.7（发布时重新读取 `package.json`）。本文是源码说明，服务器部署证据见[上线验收](release-acceptance.md)。

## 实际模块

```text
src/
├─ main.ts / app.module.ts       Nest 启动、全局校验和异常处理
├─ config/                      配置与启动校验
├─ common/api/                  成功/错误包装
├─ health/                      GET /api/health
├─ security/                    来源 CIDR 守卫
├─ protocols/xray/              三协议 Controller、DTO、生命周期、用户和 gRPC
├─ operations/                  持久化异步操作与互斥
├─ host/                        Ubuntu/宝塔探测、受限 helper、Nginx/证书/防火墙
├─ reporting/                   定期流量上报
├─ state/                       SQLite、凭据加密和状态存储
├─ logs/                        安全日志读取
└─ helper.ts                    root helper 的固定动作实现
```

中心服务保存节点配置、用户分配和流量账本；Agent SQLite 保存本机映射、操作、报告游标及资源所有权。中心通过完整用户同步协调实际集合。当前没有独立的 protocol-registry、runtimes 或 assignments 目录，Xray 相关职责在 `protocols/xray` 内实现。

## 运行与访问

- PM2 `fork`、单实例，配置见[ecosystem.config.cjs](../ecosystem.config.cjs)。Xray 由 `eagleway-xray.service` 管理。
- `/api/{protocol}/*` 和 `/api/log/*` 使用来源 CIDR 守卫；`/api/health` 当前不使用该守卫。
- `TRUST_PROXY=true` 时只信任 loopback 代理；未知 DTO 字段拒绝，nodeId 必须匹配本机 NODE_ID。
- Ubuntu x64/arm64 与 Ubuntu 宝塔 Nginx 是当前支持范围。其他系统或宝塔非 Nginx 组合预检失败。

## 生命周期与配置

- install、config/apply、uninstall 创建持久化操作并异步执行；start/stop 同步执行并确认服务活动状态。端口与实际代理流量仍须独立验收。
- OperationCoordinator 对主机修改任务互斥，记录 fingerprint、stage、结果及安全错误；用户协调另检查活动生命周期操作。
- 启动时将 pending/running 操作标记为 `OPERATION_INTERRUPTED` 失败。status 可依据实际运行状态收敛已完成的生命周期操作；当前没有通用阶段续跑器。
- 配置修订保存在 SQLite meta，修订递增、相同版本幂等和冲突拒绝由 XrayService 实现；helper 校验配置并切换，失败时尝试恢复上一配置。
- 安装前的无副作用检查包括系统、架构、DNS、协议端口及必要的 80 端口。完整证书处理和运行时安装在异步 helper 阶段执行。

## 持久化与恢复

DatabaseService 初始化 `state.db`，开启 WAL、busy timeout、外键和 FULL synchronous；schema 使用 SQLite user_version，当前为 2。表为 `managed_users`、`operations`、`report_state`、`owned_resources`、`agent_meta`。

credential 由 CredentialVault 加密保存，密钥与数据库分离。Bootstrap 为状态目录和密钥设置权限。SQLite 初始化/迁移失败会阻止正常启动；源码没有自动隔离损坏数据库并提供只读控制服务的流程，需按[操作手册](operations-runbook.md)人工恢复。

## 状态与流量

Agent 状态、配置状态和 operation 分别描述生命周期及配置处理。offline 由中心连接探测判断。当前 status 的 `startedAt` 为 null，中心使用估计启动时间；不应解释为 Xray 真实启动时刻。

累计字节使用十进制字符串；runtimeEpoch 使用 systemd InvocationID；实际入站用户条目与有活动连接的受管用户分别形成 managedUserCount/onlineUserCount。Reporter 默认 300 秒周期，失败设置指数退避门槛；中心按可信来源 IP 识别上报，不接收 Body nodeId。

## 代码依据

[配置](../src/config/app-config.ts)、[生命周期](../src/protocols/xray/xray.service.ts)、[操作协调](../src/operations/operation-coordinator.service.ts)、[数据库](../src/state/database.service.ts)、[上报](../src/reporting/traffic-reporter.service.ts)、[helper](../src/helper.ts)。接口细节见[节点契约](node-api-contract.md)。
