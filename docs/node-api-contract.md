# 当前节点 API 契约

状态：当前源码说明

核对日期：2026-10-14

本文档描述当前 Agent Controller、DTO 和 Service 的实际协议，并与当前中心 NodeClient 对照。代码入口见 `src/protocols/xray`、`src/logs`、`src/reporting` 和 `src/common/api`；设备及部署结果见[上线验收](release-acceptance.md)。

## 1. 基础约定

- 节点基础地址来自中心 `nodes.apiEndpoint`。
- 当前版本允许 HTTP 或 HTTPS；公网生产环境建议 HTTPS。
- 控制端口必须限制为中心固定出口 IP。
- 所有请求和响应使用 JSON。
- install/config/apply/uninstall 由 Controller 固定返回 HTTP 202，包括幂等结果；start/stop、用户、状态、流量和日志返回 HTTP 200。
- DTO 拒绝未知字段。
- nodeId 必须与 Agent 本机配置的 NODE_ID 一致。
- 中心默认请求超时应区分短操作和长任务接受请求。

## 2. 响应格式

成功：

```json
{
  "code": 0,
  "data": {},
  "message": "可选的成功说明"
}
```

失败：

```json
{
  "code": 422,
  "errorCode": "DNS_NOT_READY",
  "message": "Domain is not ready for certificate issuance"
}
```

错误 message 必须适合展示和记录，不得包含命令原文、credential、私钥或完整运行时配置。

## 3. 错误码

| HTTP | errorCode | 含义 |
|---|---|---|
| 400 | INVALID_REQUEST | DTO 或配置值非法 |
| 403 | NODE_ID_MISMATCH | 请求 nodeId 与本机配置不一致 |
| 409 | INVALID_STATE | 当前运行状态不允许该操作 |
| 409 | OPERATION_CONFLICT | 存在冲突的主机修改操作 |
| 409 | PORT_IN_USE | 目标端口已被其他服务占用 |
| 409 | CONFIG_MISMATCH | 已安装配置与 install 请求不同，应使用 config/apply |
| 409 | STALE_CONFIG_REVISION | 请求版本旧于节点已生效版本 |
| 409 | CONFIG_REVISION_CONFLICT | 相同版本对应了不同配置内容 |
| 422 | UNSUPPORTED_OS | 操作系统不在支持范围 |
| 422 | UNSUPPORTED_HOST_PROFILE | 宝塔/Web 服务组合未支持 |
| 422 | DNS_NOT_READY | 域名尚未满足安装条件 |
| 422 | CERTIFICATE_UNAVAILABLE | 无法获取或复用证书 |
| 500 | OPERATION_FAILED | 本机操作失败，详情见 operationId |
| 500 | STATE_STORE_FAILED | SQLite 状态读写失败 |
| 503 | RUNTIME_UNAVAILABLE | 运行时 API 暂时不可用 |

## 4. 控制接口

### 4.1 安装

`POST /api/{protocol}/install`

请求：

```json
{
  "nodeId": 12,
  "revision": 1,
  "port": 8443,
  "domain": "node.example.com",
  "proxyUrl": "https://example.org"
}
```

当前版本 `{protocol}` 接受 `trojan`、`vless`、`vmess`。一台 VPS 同时只安装其中一个协议，但三者统一由 Xray-core 提供。

处理顺序：

1. 校验 nodeId 和 DTO。
2. 执行只读预检。
3. 预检全部通过后创建持久化操作。
4. 返回 HTTP 202。
5. 后台执行安装，中心通过 status 轮询。

响应：

```json
{
  "code": 0,
  "data": {
    "operationId": "80a73fbb-44b0-43ba-a46f-d64d1a89eab9",
    "state": "installing"
  }
}
```

相同安装已在执行时返回同一个 operationId。已经以相同配置安装时返回当前状态，不重复安装；已安装但配置内容不同时返回 `CONFIG_MISMATCH`。

### 4.2 应用配置

`POST /api/{protocol}/config/apply`

请求字段与 install 一致。revision 必须单调递增；相同 revision 和相同配置幂等成功，相同 revision 和不同配置返回冲突。Agent 会先检查端口、域名和证书，验证候选 Xray 配置后原子切换。运行时重启失败时恢复旧配置。

成功接受返回 HTTP 202：

```json
{
  "code": 0,
  "data": {
    "operationId": "80a73fbb-44b0-43ba-a46f-d64d1a89eab9",
    "state": "reconfiguring",
    "acceptedRevision": 4
  }
}
```

### 4.3 卸载

`POST /api/{protocol}/uninstall`

请求只包含 nodeId，未知字段被 DTO 拒绝。卸载异步执行，只删除 Agent 拥有的运行时资源、配置和映射；不得卸载共享 Nginx、宝塔或全局 ACME 工具。

成功接受返回 HTTP 202 和 operationId。

### 4.4 启动

`POST /api/{protocol}/start`

请求为 `{ "nodeId": 12 }`。启动是同步操作。helper 执行 systemd start，确认 Xray 活动并恢复持久化用户后返回 `online`；当前 start 不另行检查外部协议端口或真实代理请求。

### 4.5 停止

`POST /api/{protocol}/stop`

请求为 `{ "nodeId": 12 }`。停止是同步操作。helper 执行 systemd stop，确认 Xray 不活动后返回 `stopped`；目标端口释放需在服务器验收中独立核验。

## 5. 用户接口

### 5.1 全量同步

`POST /api/{protocol}/user/sync`

```json
{
  "nodeId": 12,
  "users": [
    {
      "assignmentId": "10c970c5-7fa4-4389-a12f-3f6802aeeb79",
      "credential": "credential"
    }
  ]
}
```

语义：

- users 是完整期望集合。
- 本地缺失用户必须创建。
- 已存在且凭证不变的用户保持原累计计数；凭证变化时替换该运行时用户。
- 本地多余用户必须删除。
- 空数组必须删除全部协议用户，包括安装 bootstrap 用户。

响应：

```json
{
  "code": 0,
  "data": [
    {
      "assignmentId": "10c970c5-7fa4-4389-a12f-3f6802aeeb79"
    }
  ]
}
```

响应不得返回 credential。

### 5.2 新增或更新

`POST /api/{protocol}/user/update`

```json
{
  "nodeId": 12,
  "action": "add",
  "users": [
    {
      "assignmentId": "10c970c5-7fa4-4389-a12f-3f6802aeeb79",
      "credential": "credential"
    }
  ]
}
```

add 表示 upsert。重复请求不得创建重复运行时用户。

### 5.3 删除

`POST /api/{protocol}/user/update`

```json
{
  "nodeId": 12,
  "action": "delete",
  "assignmentIds": ["10c970c5-7fa4-4389-a12f-3f6802aeeb79"]
}
```

删除不存在的用户仍返回成功。运行时删除与 SQLite 映射删除必须作为一个可恢复操作处理。

## 6. 状态接口

`POST /api/{protocol}/status`

请求：

```json
{
  "nodeId": 12
}
```

响应：

```json
{
  "code": 0,
  "data": {
    "nodeId": 12,
    "protocol": "trojan",
    "runtime": "xray-core",
    "runtimeVersion": "pinned-version",
    "state": "installing",
    "startedAt": null,
    "configState": "applying",
    "appliedConfigRevision": null,
    "requiresUserSync": false,
    "activeOperation": {
      "operationId": "80a73fbb-44b0-43ba-a46f-d64d1a89eab9",
      "type": "install",
      "stage": "certificate",
      "startedAt": "2026-09-04T01:00:00.000Z"
    },
    "lastError": null
  }
}
```

Agent 不返回 offline。中心请求超时或连接失败时，由中心将节点判断为 offline。

安装失败后 state 为 error，lastError 包含安全错误码、消息及 finishedAt。修复外部条件后可重试 install。配置应用的过渡状态通过 configState 和 activeOperation 表达；config/apply 接受响应可返回 reconfiguring，status 生命周期不使用它。

当前 startedAt 固定为 null；中心在线查询会使用其已记录或首次确认在线的时间补齐，不代表 Agent 已返回运行时实际启动时间。Agent 重启会将未完成操作标记为 OPERATION_INTERRUPTED，不自动续跑全部阶段。

## 7. 流量查询

`POST /api/{protocol}/traffic`

```json
{
  "nodeId": 12
}
```

响应 data：

```json
{
  "reportedAt": "2026-09-04T01:05:00.000Z",
  "runtimeEpoch": "6f01dc9dc1294fd3a463f521cb24f1ee",
  "managedUserCount": 2,
  "onlineUserCount": 1,
  "users": [
    {
      "assignmentId": "10c970c5-7fa4-4389-a12f-3f6802aeeb79",
      "uploadBytes": "1024",
      "downloadBytes": "2048"
    }
  ]
}
```

- `runtimeEpoch` 是 `eagleway-xray.service` 的 systemd InvocationID。
- 服务器带宽由中心 API 自行维护，不属于 Agent 流量响应。
- `managedUserCount` 是 Xray HandlerService 返回的目标入站实际用户条目数，不是中心数据库计数，也不是在线连接数。
- `onlineUserCount` 是采样时至少有一个活动连接的受管 Xray 用户数，不是连接数或设备数。
- `users` 只包含 email 符合受管格式且能严格解析出 UUID assignmentId 的实际运行时用户。

## 8. 日志接口

### 文件列表

`POST /api/log/files`

仅返回允许目录中的 `.log` 文件 basename，不返回绝对路径。

### 分页读取

`POST /api/log/pages`

```json
{
  "filename": "agent.log",
  "page": 1,
  "pageSize": 100
}
```

要求：

- filename 必须匹配安全 basename。
- realpath 必须位于允许日志目录内。
- page 为大于等于 1 的整数。
- pageSize 范围为 1 至 500。
- 第一页返回最新日志。
- 不得为分页一次性加载无上限的大文件。

## 9. 节点主动上报

Agent 调用：

`POST {CENTER_API}/api/v1/node/traffic-report`

Body 与流量查询 data 一致，但不包含 nodeId。中心反向代理覆盖来源 IP Header，并按 `nodes.reportSourceIp` 匹配节点。中心通过该接口写入运行时用户数和流量快照；服务器带宽由中心自己的节点配置维护，不从 Agent 上报 Body 读取。

上报规则：

- `REPORT_INTERVAL_SECONDS` 默认 300 秒，范围 10–86400 秒；启用上报时须配置 `CENTER_API_URL`。
- reportedAt 严格单调递增。
- 网络失败设置有上限的指数退避门槛，实际再次尝试由后续周期触发；当前没有为每次退避另建短周期定时器。
- 204 表示中心接受请求，不代表 Agent 能判断来源 IP 是否匹配。
- 上报日志不得记录 users 正文。

## 10. 安装预检与实际边界

`XrayProvisioningService.preflight` 当前检查：

- Linux Ubuntu、x64/arm64，宝塔存在时必须为 Nginx 组合。
- 协议端口不是 80 或本机 Xray API 端口；修改端口时确认新端口可用。
- domain 至少可解析 A 或 AAAA。
- 普通 Ubuntu 缺少可复用证书且标准 Nginx 未活动时检查 80 端口可用。

预检发生在持久化异步任务创建前，不写运行配置。证书匹配、签发、Nginx 配置、runtime artifact 下载和 helper 操作属于后续异步阶段，失败会记录任务错误。当前没有完整磁盘/内存容量预检，不能声称所有安装条件都已在无副作用阶段验证。

## 11. 访问与字段边界

协议和日志接口使用 `ALLOWED_CIDRS`；健康接口当前不使用来源守卫。`TRUST_PROXY=true` 时只信任 loopback 代理。控制请求当前不要求 HMAC/JWT Header。

用户数组最多 10000 项；assignmentId 为 UUID，credential 为 1–256 字符。协议 DTO 对 nodeId、revision 和端口做整数转换及范围校验；未知字段被拒绝。日志参数默认 page=1、pageSize=100，安全 basename 和 realpath 均校验。

本文为代码行为说明，真实 Ubuntu/宝塔安装、权限、签名 artifact、证书续期及中心流量入账仍需当前 release 的实测证据。
