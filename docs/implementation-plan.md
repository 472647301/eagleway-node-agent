# 实施与验收计划

状态：Draft v0.1  
更新时间：2026-09-04

## 1. 实施原则

- 先冻结契约，再实现 Agent，最后接入真实 VPS。
- 不复制旧 trojan-api 的模块结构、旧 DTO 或旧内部回调。
- 旧安装脚本只能作为需求参考，不能直接进入新项目。
- 每一阶段都有可独立验证的退出条件。
- Agent 和中心 API 的契约测试应共享固定 JSON fixtures 或 OpenAPI 校验结果。

## 2. 阶段划分

### 阶段 0：契约冻结

产出：

- 审核 node-api-contract.md。
- 确认 Agent errorCode、status state 和 operation response。
- 确认中心 NodeStatus 是否新增 error。
- 确认 NODE_ID、控制端口、上报周期和中心出口 IP 配置方式。

退出条件：中心和 Agent 的请求、响应、错误及状态机无未决字段。

### 阶段 1：项目基础

范围：

- NestJS 项目骨架。
- 强类型环境变量和启动校验。
- 标准成功/错误响应。
- 结构化日志和敏感字段清洗。
- 健康检查。
- PM2 fork 单实例配置。
- SQLite 连接、迁移、WAL 和权限检查。

退出条件：应用能以非 root 用户启动，错误配置时拒绝监听，数据库迁移可重复执行。

### 阶段 2：只读主机探测

范围：

- Ubuntu 识别。
- 宝塔/Nginx 探测。
- CPU 架构、端口、DNS、证书和 WebRoot 检查。
- 不支持组合的结构化错误。

退出条件：在普通 Ubuntu、Ubuntu 宝塔和不支持系统上得到确定结果，且没有系统副作用。

### 阶段 3：安全执行与操作协调

范围：

- 无 shell 的进程执行器。
- privileged helper 和最小 sudo 权限。
- operations 持久化状态机。
- 主机修改互斥锁。
- 中断恢复、幂等和冲突处理。

退出条件：重复、并发和进程重启测试不会产生重复资源或越权命令。

### 阶段 4：Trojan 运行时

范围：

- 固定版本 artifact 及校验。
- Xray-core 三协议配置生成和校验。
- systemd unit 生命周期。
- 普通 Ubuntu 安装/卸载。
- Ubuntu 宝塔安装/卸载。
- status、start、stop。

退出条件：安装失败可恢复；卸载不影响共享 Nginx/宝塔；生命周期操作幂等。

### 阶段 5：用户协调

范围：

- managed_users。
- credential 加密。
- assignmentId ↔ Xray email 映射。
- 全量 sync。
- 增量 add/delete。
- 空数组清理和临时 bootstrap 用户移除。

退出条件：实际运行时用户集合与中心期望集合完全一致，进程重启后映射仍可使用。

### 阶段 6：流量与上报

范围：

- 累计字节和速度采集。
- managedUserCount 与 Xray 入站用户列表一致性验证。
- bigint 字符串转换。
- reportedAt 单调性。
- 中心 204 上报、超时和退避。
- traffic 查询接口。

退出条件：超过 2^53 的计数不丢精度，失败重试不重复计算中心增量。

### 阶段 7：日志 API

范围：

- 文件白名单。
- realpath 边界。
- 最新优先分页。
- 大文件有界读取。
- 操作日志敏感信息清洗。

退出条件：路径穿越、软链接逃逸和超大文件测试通过。

### 阶段 8：中心配套改造

范围：

- NodeClient 响应校验和安全错误映射。
- 命令响应 DTO。
- status/traffic DTO。
- 过渡状态轮询任务。
- requiresUserSync 自动全量同步。
- 管理端状态和错误展示所需数据。

退出条件：中心与模拟 Agent 的契约测试全部通过。

### 阶段 9：真实 VPS 灰度

顺序：

1. 全新 Ubuntu 测试 VPS。
2. 无业务的 Ubuntu 宝塔 VPS。
3. 已有测试站点且使用非 443 Trojan 端口的宝塔 VPS。
4. 单个低风险正式节点。
5. 分批扩大。

每一批都必须验证安装、同步、上报、重启恢复、卸载和重新安装。

## 3. 必测场景

### 安全

- domain、proxyUrl、credential 中包含 shell 特殊字符。
- 请求未知字段。
- nodeId 不匹配。
- 非白名单 IP 请求。
- 日志 `../`、绝对路径和软链接逃逸。
- 日志与错误中搜索 credential 和私钥片段。

### 生命周期

- 重复 install/uninstall/start/stop。
- install 期间再次 install。
- install 期间 uninstall。
- 每个安装阶段强制杀死 Agent 后重启。
- DNS 未解析、证书失败、端口冲突、Nginx 配置错误。
- PM2 重启和主机重启。

### 用户

- 0、1、大批量用户完整同步。
- 删除全部用户。
- 已存在用户 upsert。
- 删除不存在用户。
- runtime 已有未知用户时完整同步。
- SQLite 丢失后中心重新完整同步。

### 流量

- 首次快照。
- 正常增长。
- runtime 计数器重置。
- 超过 JavaScript 安全整数。
- 上报乱序和同一时间戳。
- 中心不可用后恢复。
- Xray 重启后 runtimeEpoch 变化，中心从新计数器零点继续累计。

### 宝塔

- 443 空闲。
- 443 被网站占用。
- 使用其他 Trojan 端口。
- 已有证书。
- 域名未解析。
- 宝塔 Nginx 配置检查失败。
- 卸载后已有网站仍正常。

## 4. 验收门槛

- 无高危命令注入、路径穿越或凭证日志问题。
- 所有主机修改均可确定资源所有权。
- 单实例和操作互斥可被自动测试证明。
- 中心状态最终收敛，不长期停留在 installing/uninstalling。
- Agent 重启不丢用户映射和活动操作。
- 普通 Ubuntu 与 Ubuntu 宝塔分别完成全生命周期演练。
- 卸载不会删除共享 Nginx、宝塔、证书工具或非 Agent 站点。
- 中心流量账本在重试、乱序和计数器重置场景下正确。

## 5. 后续版本候选

- xray-core Runtime Adapter。
- Shadowsocks 协议。
- RHEL 系 Host Adapter。
- HMAC 或 mTLS 节点鉴权。
- 443 TLS/SNI 多路复用。
- 远程 Agent 自更新。
- 流量额度与超额处置。
