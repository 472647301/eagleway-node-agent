# 当前中心 API 集成

核对日期：2026-10-14。中心仓库为 `/Users/zhuwenbo/Documents/Eagleway/eagleway-network-api`。本文对照其当前 NodeControlController、NodeClientService、NodeStatusReconcileService 与 NodeReportController，不使用旧服务作对照。

## 管理端到中心

基础路径 `/api/v1/manage/nodes/:nodeId/control`，当前路由：

| 方法 | 相对路径 | 行为 |
| --- | --- | --- |
| POST | install、config/apply、uninstall | 202，提交 Agent 异步操作 |
| POST | start、stop | 200，确认实际启停状态 |
| POST | users/sync、users/remove、users/:assignmentId | 200，完整同步或单项变更 |
| GET | status、traffic、logs/files、logs | 查询当前 Agent |

节点写操作要求 NodesControl 权限，读取要求 NodesRead；管理员守卫和审计在中心执行。

## 中心到 Agent

中心根据 nodes.protocol 构造 `/api/{protocol}/*`，日志用 `/api/log/*`。安装和配置应用提交 nodeId/revision/port/domain/proxyUrl，其他生命周期操作只提交 nodeId。具体字段和包装见[节点契约](node-api-contract.md)。

中心从 desiredConnectionOptions 和 desiredConfigRevision 取期望配置，缺少时按当前代码回退生效配置及修订。网络或 5xx 有限重试，4xx 不重试；成功结构及允许的错误字段均检查。

当前 Agent 仅支持 Trojan、VLESS、VMess。中心虽然保留 Shadowsocks 枚举，但不能向当前 Agent 部署该协议。协议切换必须先卸载并收敛为 not_installed。

## 状态、配置及同步

中心每 30 秒查询最多 100 个启用且处于 installing/uninstalling/online/stopped/offline 的节点；连续失败 3 次标记 offline，计数为任务实例内存状态。Agent error 在卸载过渡时映射为 stopped，其他情况下映射为 not_installed。

配置状态独立维护，修订匹配后更新生效连接配置和 Outbox；online 且 requiresUserSync 时进行完整同步，空分配也发送空数组。

Agent 当前 startedAt=null。中心用已保存或首次确认在线的时间补齐并展示，这不是 Xray 实际启动时间。需要实际时间的监控应另核对 systemd，而不能由文档推定接口已经提供。

## 流量入账

Agent 向 `{CENTER_API_URL}/api/v1/node/traffic-report` 发送累计快照，Body 不带 nodeId。中心可信代理覆盖来源 Header，并按 nodes.reportSourceIp 精确识别。

204 仅证明中心接受 HTTP 请求；来源不匹配时同样返回 204。必须检查中心日志及实际节点日/月/总账本，使用真实代理连接验证计数、人数和重启后的 runtimeEpoch。

## 验收证据

两仓库单元测试可以验证各自结构和状态处理，真实跨服务安装、证书、配置回滚、用户同步及账本仍按[上线验收](release-acceptance.md)执行并记录双方提交和部署版本。
