# 节点 API 契约

状态：Draft v0.1  
更新时间：2026-09-04

本文档定义 Eagleway Network API 与 Eagleway Node Agent 之间的目标契约。新项目不兼容旧 `trojan-api`。

## 1. 基础约定

- 节点基础地址来自中心 `nodes.apiEndpoint`。
- 第一阶段允许 HTTP 或 HTTPS；公网生产环境建议 HTTPS。
- 控制端口必须限制为中心固定出口 IP。
- 所有请求和响应使用 JSON。
- 除异步 install/uninstall 外，成功响应使用 HTTP 200；异步接受使用 HTTP 202。
- DTO 拒绝未知字段。
- nodeId 必须与 Agent 本机配置的 NODE_ID 一致。
- 中心默认请求超时应区分短操作和长任务接受请求。

## 2. 响应格式

成功：

```json
{
  "code": 0,
  "data": {},
  "message": "success"
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
  "port": 8443,
  "domain": "node.example.com",
  "proxyUrl": "https://example.org"
}
```

第一阶段 `{protocol}` 接受 `trojan`、`vless`、`vmess`。一台 VPS 同时只安装其中一个协议，但三者统一由 Xray-core 提供。

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
    "operationId": "01J...",
    "state": "installing"
  }
}
```

相同安装已在执行时返回同一个 operationId。已经以相同配置安装时返回当前状态，不重复安装。

### 4.2 卸载

`POST /api/{protocol}/uninstall`

请求至少包含 nodeId。卸载异步执行，只删除 Agent 拥有的运行时资源、配置和映射；不得卸载共享 Nginx、宝塔或全局 ACME 工具。

成功接受返回 HTTP 202 和 operationId。

### 4.3 启动

`POST /api/{protocol}/start`

启动是同步操作。只有运行时服务启动成功、目标端口符合预期后才返回 `online`。

### 4.4 停止

`POST /api/{protocol}/stop`

停止是同步操作。只有 systemd 服务停止且目标监听已释放后才返回 `stopped`。

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
    "requiresUserSync": false,
    "activeOperation": {
      "operationId": "01J...",
      "type": "install",
      "stage": "certificate",
      "startedAt": "2026-09-04T01:00:00.000Z"
    },
    "lastError": null
  }
}
```

Agent 不返回 offline。中心请求超时或连接失败时，由中心将节点判断为 offline。

安装失败后 state 为 error，lastError 只包含安全错误码和安全消息。修复外部条件后允许重新 install。

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
  "bandwidthMbps": 1000,
  "managedUserCount": 2,
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
- `bandwidthMbps` 是 VPS 本机显式配置的线路带宽，不由中心后台填写。
- `managedUserCount` 是 Xray HandlerService 返回的目标入站实际用户条目数，不是中心数据库计数，也不是在线连接数。
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

Body 与流量查询 data 一致，但不包含 nodeId。中心反向代理覆盖来源 IP Header，并按 `nodes.reportSourceIp` 匹配节点。中心仅通过该接口写入服务器带宽、运行时用户数和流量快照。

上报规则：

- 默认周期建议 300 秒，可配置。
- reportedAt 严格单调递增。
- 网络失败进行有上限的指数退避。
- 204 表示中心接受请求，不代表 Agent 能判断来源 IP 是否匹配。
- 上报日志不得记录 users 正文。

## 10. 安装预检

预检是 install 内部无副作用阶段，至少检查：

- OS 和版本。
- 是否为支持的宝塔组合。
- CPU 架构。
- 磁盘和内存基本条件。
- systemd、curl、证书工具等能力。
- domain DNS 状态。
- 80、443、目标协议端口和 Agent 控制端口。
- 现有 Nginx/宝塔站点冲突。
- 已有证书是否可复用。
- Agent 是否有权调用受限 helper。

任何一项失败都不得创建或覆盖运行时配置。
