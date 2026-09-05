# 架构设计

状态：Draft v0.1  
更新时间：2026-09-04

## 1. 目标

Eagleway Node Agent 在一台 VPS 上只运行一个实例，承担中心控制面与本机协议运行时之间的适配职责。

设计目标：

- 对中心提供稳定、与具体运行时解耦的协议 API。
- 安全、幂等地修改本机服务和配置。
- 在进程重启后恢复未完成操作和用户映射。
- 定期向中心上报可信、不会丢失整数精度的累计流量快照。
- 支持普通 Ubuntu 和 Ubuntu 宝塔两种主机环境。
- 第一阶段以一套 Xray 适配器实现 Trojan、VLESS、VMess。

## 2. 非目标

- Agent 不管理 Eagleway 用户、Group、套餐或中心流量账本。
- Agent 不直接连接中心数据库。
- Agent 不抓取外部节点。
- Agent 不作为通用远程 Shell。
- Agent 不删除自己未创建的系统资源。
- 第一阶段不执行流量额度策略。

## 3. 系统关系

```text
管理端
  │
  ▼
Eagleway Network API
  │  节点控制、用户同步、状态轮询
  ▼
Eagleway Node Agent
  ├─ Host Adapter ─────── systemd / PM2 / Nginx / 宝塔 / ACME
  ├─ Runtime Adapter ──── Xray-core（Trojan / VLESS / VMess）
  ├─ State Store ──────── SQLite
  └─ Reporter ─────────── traffic-report → Network API
```

中心服务保存期望状态，Agent 保存本机执行状态。发生差异时，以中心发出的完整用户同步为准。

## 4. 模块边界

```text
src/
├─ bootstrap/                  启动、全局管道、异常和退出处理
├─ config/                     强类型配置及启动校验
├─ common/
│  ├─ api/                     标准响应和错误模型
│  ├─ logging/                 结构化日志及敏感字段清洗
│  └─ concurrency/             互斥、取消和超时
├─ control-api/                对中心暴露的 HTTP Controller 和 DTO
├─ operations/                 安装/卸载任务、幂等和恢复
├─ protocols/
│  ├─ protocol-registry        protocol → runtime 映射
│  └─ xray/                    三协议应用用例与 protobuf API 适配
├─ runtimes/
│  ├─ runtime-driver           运行时统一能力边界
│  └─ xray/                    Xray HandlerService / StatsService
├─ host/
│  ├─ host-inspector           OS、端口和能力探测
│  ├─ ubuntu/                  普通 Ubuntu 适配
│  ├─ baota/                   Ubuntu 宝塔适配
│  └─ privileged-helper        固定白名单的提权操作
├─ assignments/               用户全量协调和增量修改
├─ reporting/                 流量采集、调度、重试和中心客户端
├─ state/                     SQLite、迁移和本地仓储
└─ logs/                      安全日志读取
```

Controller 只负责路由、DTO、节点 ID 校验和返回状态；操作编排进入 application service；系统命令、文件、运行时 API、DNS 和 HTTP 调用都由适配器封装。

## 5. 协议与运行时解耦

中心路由使用协议名称，例如 `/api/trojan/*`。Agent 内部通过注册表找到实现该协议的运行时：

| 协议 | 第一阶段运行时 | 未来可能运行时 |
|---|---|---|
| trojan | xray-core | - |
| vless | xray-core | - |
| vmess | xray-core | - |

协议层定义中心可理解的用户、状态和流量模型；运行时层负责把这些模型转换成 Xray 配置和 gRPC API。中心不依赖 Xray 的内部 protobuf 类型。

## 6. 操作模型

### 6.1 单写者

Agent 是主机控制面的单写者：

- PM2 只能启动一个实例。
- 任意时刻最多执行一个会修改主机或运行时的操作。
- status、traffic 和日志读取可以并发，但必须读取一致快照。
- 用户同步与 install/uninstall/start/stop 不能并发修改同一运行时。

### 6.2 幂等

- 已安装时再次 install 返回当前状态，不重复覆盖配置。
- 相同 install 正在运行时返回相同 operationId。
- 正在 uninstall 时收到 install 返回 `OPERATION_CONFLICT`。
- 已删除用户再次删除仍返回成功。
- 全量同步重复执行得到相同本地用户集合。

### 6.3 异步任务

install/uninstall 持久化到 operations 表后快速返回。后台执行器按阶段更新状态，每个有副作用的阶段记录完成标记。进程重启后：

- 可安全重试的阶段继续执行。
- 状态不确定的阶段先探测实际主机状态再决定继续或回滚。
- 不自动执行无法判断所有权的删除动作。

start/stop 应在中心默认超时内完成，并验证 systemd 与监听端口后返回。

## 7. SQLite 状态模型

SQLite 文件建议位于 `/var/lib/eagleway-node-agent/state.db`。

### managed_users

保存中心 assignment 与运行时用户的映射：

- assignment_id
- encrypted_credential
- protocol
- runtime_user_id
- synced_at

`assignmentId` 是非秘密 UUID；credential 使用应用层 AES-GCM 加密，密钥位于独立的 `/etc/eagleway-node-agent/state.key`。

### operations

- operation_id
- operation_type
- protocol
- request_fingerprint
- state
- current_stage
- previous_runtime_state
- error_code
- error_message_safe
- started_at
- finished_at

### report_state

- last_reported_at
- last_success_at
- consecutive_failures
- next_retry_at

### owned_resources

- resource_type
- absolute_path_or_name
- ownership_tag
- created_at
- removed_at

卸载只能操作 owned_resources 中登记的资源。共享软件包可以保留，不要求卸载。

### SQLite 运行要求

- schema 通过显式迁移版本管理。
- 启动时迁移失败则不开放控制接口。
- 启用 WAL 和 busy timeout。
- 所有用户协调和操作状态变化使用事务。
- 数据库目录权限为 0700，数据库、WAL、SHM 和密钥文件权限为 0600。
- SQLite 不作为长期流量账本，不要求远程备份。

## 8. 主机适配器

### 普通 Ubuntu

- 使用 apt 安装经过允许的基础依赖。
- 使用 systemd 管理协议运行时。
- Nginx 配置使用独立文件，不覆盖主配置。
- 防火墙优先使用云安全组，主机侧兼容 ufw。

### Ubuntu 宝塔

- 探测宝塔目录、Web 服务类型和实际配置路径。
- 第一阶段只支持宝塔管理的 Nginx；检测到 Apache 等未验证组合时预检失败。
- 复用宝塔已有站点和证书时只读引用，不接管其生命周期。
- Agent 创建的 vhost/include 使用独立命名，并登记所有权。
- 不通过停止宝塔站点解决端口冲突。

### 未支持系统

CentOS/RHEL 或未知系统返回 `UNSUPPORTED_OS`，不得继续执行包安装、证书申请或配置写入。

## 9. 安全边界

- 控制端口仅允许中心固定出口 IP。
- Node ID 必须与本机配置一致。
- 不提供任意命令、任意文件读取或任意路径参数。
- 进程调用使用 executable + args，不经过 shell 字符串拼接。
- 提权 helper 只接受固定动作和经过校验的参数。
- 日志清洗 credential、私钥、Authorization、Cookie 和 connectionOptions。
- 日志文件读取必须同时检查 basename、真实路径边界和允许扩展名。
- HTTP 请求正文不得直接写入访问日志。

## 10. 状态模型

Agent 可返回：

- `not_installed`
- `installing`
- `stopped`
- `online`
- `uninstalling`
- `error`

`offline` 由中心在无法连接 Agent 时计算，不由可响应请求的 Agent 自报。

状态响应同时携带活动操作、最后安全错误和 `requiresUserSync`。中心轮询过渡状态并持久化最终结果。

## 11. 流量模型

- Agent 采集每个运行时用户的累计上传和累计下载。
- 从受管 Xray email 的固定格式直接解析 assignmentId；SQLite 只负责持久化可恢复的凭据和同步状态。
- 所有字节累计值序列化为非负十进制字符串。
- reportedAt 使用 UTC ISO 8601，并保证相对本 Agent 上次上报单调递增。
- runtimeEpoch 使用 systemd InvocationID，中心据此识别整个 Xray 进程的计数器重置。
- `bandwidthMbps` 来自 VPS 的 `SERVER_BANDWIDTH_MBPS`，不使用网卡协商速率或测速结果猜测。
- `managedUserCount` 来自 Xray HandlerService 当前入站用户列表。
- 上报失败指数退避，不修改累计计数器。
- 中心以来源 IP 匹配节点，Body 不包含 nodeId。

## 12. 可观测性

结构化日志至少包含：

- event
- requestId
- nodeId
- protocol
- operationId
- stage
- durationMs
- result
- errorCode

禁止包含用户秘密。安装输出应保存为受限操作日志，并通过日志 API 只返回清洗后的内容。
