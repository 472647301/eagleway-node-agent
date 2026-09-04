# 中心 API 配套改造

状态：Draft v0.1  
更新时间：2026-09-04

目标项目：`eagleway-network-api`

## 1. 改造原因

现有中心已经具备协议路由构造、用户同步、状态查询、流量查询和日志转发，但以下行为不足以支撑新的 Agent：

- install/uninstall 成功返回后只设置过渡状态，没有后台收敛。
- 节点 4xx 错误统一被转换为 Bad Gateway，管理端无法知道 DNS 或端口问题。
- 命令响应 data 目前是 string，不适合承载 operationId 和状态。
- status/traffic 响应缺少稳定业务 Schema。
- start 被中心直接乐观设置为 online，需要以 Agent 验证后的状态为准。

## 2. NodeControlController

路由保持：

- POST `/manage/nodes/:nodeId/control/install`
- POST `/manage/nodes/:nodeId/control/uninstall`
- POST `/manage/nodes/:nodeId/control/start`
- POST `/manage/nodes/:nodeId/control/stop`
- POST `/manage/nodes/:nodeId/control/users/sync`
- POST `/manage/nodes/:nodeId/control/users/remove`
- POST `/manage/nodes/:nodeId/control/users/:assignmentId`
- GET `/manage/nodes/:nodeId/control/status`
- GET `/manage/nodes/:nodeId/control/traffic`
- GET `/manage/nodes/:nodeId/control/logs/files`
- GET `/manage/nodes/:nodeId/control/logs`

建议变化：

- install/uninstall 管理端响应使用 HTTP 202。
- 命令响应 DTO 改为 operation/state 结构。
- status 返回类型化的 AgentStatus。
- traffic 返回类型化的流量快照。
- 管理端仍只接触 nodeId，不接触 Agent 内部运行时标识。

## 3. NodeClientService

需要增加：

- 区分节点网络失败、节点 4xx 业务错误和节点 5xx 故障。
- 对允许的错误字段进行白名单解析。
- 将 `DNS_NOT_READY`、`PORT_IN_USE` 等映射为可展示的中心错误。
- 不透传节点返回的任意 details、命令输出或路径。
- 校验 success 和 error envelope。
- 对 status/traffic/user results 做运行时 Schema 校验。
- start/stop 根据 Agent 返回 state 更新数据库，而不是仅依据 HTTP 2xx 乐观更新。

重试规则：

- 网络错误和 5xx 可以有限重试。
- 4xx 不重试。
- install/uninstall 的网络重试依赖 Agent 幂等 operation fingerprint。
- status/traffic 可以重试，但不能造成状态修改。

## 4. 状态收敛任务

新增中心后台任务，轮询以下节点：

- status 为 installing。
- status 为 uninstalling。
- 最近存在活动 operation。
- requiresUserSync 为 true。

建议流程：

```text
取一批待收敛节点
→ 获取数据库任务锁
→ 调用 Agent status
→ 校验响应
→ 更新节点最终状态和 startupTime
→ requiresUserSync 时触发完整用户同步
→ 记录结构化日志
```

轮询建议指数退避并设置最长安装观察时间。连接失败时标记 offline 或记录探测失败，但不能立即把进行中的安装判定为失败。

状态映射：

| Agent state | 中心 NodeStatus |
|---|---|
| not_installed | not_installed |
| installing | installing |
| stopped | stopped |
| online | online |
| uninstalling | uninstalling |
| error | 建议新增 error，或保存 lastOperationError 并回到稳定状态 |
| 无法连接 | offline |

推荐中心新增 `error` 状态，避免安装失败与网络离线混淆。

## 5. 用户同步

- 中心发送 assignmentKey 和 credential，两者即使当前相同也保持独立字段。
- 全量同步发送该节点全部有效 assignment。
- 没有 assignment 时也必须发送空数组，不能跳过请求。
- Agent 返回的 hash 按 nodeId + assignmentKey 保存。
- 单项 error 不得包含 credential。
- 中心删除 assignment 与外部节点用户删除仍通过同一业务事务 + Outbox 完成。

第一阶段不增加流量超额删除任务。

## 6. 流量上报

现有 `/api/v1/node/traffic-report` 路径和按可信来源 IP 匹配的设计保持不变。

需要确保：

- 反向代理覆盖 NODE_REPORT_IP_HEADER。
- nodes.reportSourceIp 与 Agent 实际出口 IP 一致。
- 无匹配来源仍返回 204 的策略在运维文档中明确。
- 中心不接受 Body 或路径中的 nodeId。
- 继续使用 bigint 字符串和乱序快照保护。
- 不增加 trafficLimitBytes 超额动作。

## 7. 配置字段

Node.connectionOptions 第一阶段建议规范为：

- port：Trojan 对外端口。
- domain：Trojan 证书域名。
- proxyUrl：可选伪装站点上游。
- 其余字段需要进入明确 DTO 后才能传给 Agent，禁止无限制透传任意系统配置。

Node.apiEndpoint 是 Agent 控制 API 地址，与 Trojan 客户端连接地址不是同一概念。

## 8. 安全与日志

- 中心 NodeClient 日志仅记录 endpoint origin，不记录完整 URL 查询参数。
- 不记录请求 Body。
- 不记录 assignmentKey、credential 和 connectionOptions。
- 节点错误只保留白名单 errorCode 和安全 message。
- IP 白名单变更应具备先验证新地址再撤销旧地址的运维流程。

## 9. 中心验收测试

- 路由按 Node.protocol 正确生成。
- install 接受 operation 响应并写入 installing。
- status 轮询将 installing 收敛为 stopped/online/error。
- 节点 `PORT_IN_USE` 不被错误包装为 502。
- 节点网络失败仍映射为 Bad Gateway/offline。
- 空用户数组仍调用 users/sync。
- 大整数流量不丢精度。
- requiresUserSync 触发完整同步且不会并发重复执行。

