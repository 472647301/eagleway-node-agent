# 安装与运维设计

状态：Draft v0.1  
更新时间：2026-09-04

## 1. 两层安装模型

### 1.1 Agent Bootstrap

一台空白 VPS 在接受中心控制前，必须先完成一次 bootstrap。Bootstrap 由管理员以 root 执行，负责：

- 识别 Ubuntu 和宝塔环境。
- 安装受支持的 Node.js 运行时和 PM2。
- 创建专用运行用户、配置目录、状态目录和日志目录。
- 安装 Eagleway Node Agent 构建产物。
- 安装固定动作的 privileged helper。
- 配置 NODE_ID、监听地址、中心地址和允许来源 IP。
- 配置云安全组之外的主机防火墙规则。
- 启动 PM2 单实例并保存开机启动配置。

Bootstrap 不创建中心业务数据。节点记录应先在中心创建，再把 nodeId 写入本机配置。

### 1.2 协议安装

中心调用 `/api/trojan/install` 后，Agent 安装和配置 trojan-go。该操作不负责安装或升级 Agent 自身。

## 2. 目录与权限

建议目录：

```text
/opt/eagleway-node-agent/                只读应用构建产物
/etc/eagleway-node-agent/                环境配置和状态加密密钥
/var/lib/eagleway-node-agent/            SQLite 和操作状态
/var/log/eagleway-node-agent/            Agent 与操作日志
/etc/systemd/system/                      Agent 创建的协议 unit
/etc/nginx/conf.d/                        普通 Ubuntu 的独立配置
/www/server/panel/vhost/nginx/            宝塔 Nginx 独立配置
```

要求：

- 应用进程使用专用低权限用户。
- 配置和状态目录不得允许其他普通用户读取。
- Agent 不直接拥有任意 sudo 权限。
- privileged helper 文件必须由 root 拥有且不可被 Agent 用户修改。

## 3. PM2 运行方式

固定要求：

- 进程名：`eagleway-node-agent`
- exec mode：fork
- instances：1
- 自动重启：开启
- watch：关闭
- 优雅停止：等待当前数据库事务结束，不启动新操作
- 启动前：完成配置校验和 SQLite 迁移

不使用 cluster。Agent 是主机状态协调器，不是需要横向扩展的无状态 Web 服务。

## 4. 提权模型

协议安装和 systemd 操作需要 root 权限，但 HTTP 服务不应以 root 身份长期运行。

privileged helper 只提供固定动作，例如：

- 安装经过固定版本和校验和验证的 runtime artifact。
- 原子写入预定义目录中的配置。
- daemon-reload。
- start、stop、restart 指定白名单 unit。
- 校验和 reload Nginx。
- 添加或删除 Agent 自己的防火墙规则。

helper 不接受任意命令字符串、任意 unit、任意目标路径或 shell 表达式。

## 5. 普通 Ubuntu 安装流程

1. 执行无副作用预检。
2. 获取固定版本的 trojan-go artifact。
3. 校验 SHA-256 和支持的 CPU 架构。
4. 写入临时目录。
5. 原子安装二进制、配置和 systemd unit。
6. 获取或引用证书。
7. 写入独立 Nginx 配置；先执行配置检查，再 reload。
8. 启动 trojan-go 并验证 systemd、端口和本地 API。
9. 记录 owned_resources。
10. 标记 operation 完成。

禁止覆盖 `/etc/nginx/nginx.conf`，禁止关闭 SELinux（第一阶段也不支持 RHEL），禁止执行来自网络的未固定脚本。

## 6. 宝塔安装流程

1. 探测宝塔目录和 Web 服务。
2. 第一阶段只接受已验证的 Ubuntu + 宝塔 Nginx。
3. 枚举目标端口监听和相关 vhost。
4. 如果目标 Trojan 端口被占用，返回 `PORT_IN_USE`。
5. 查找目标域名已有证书；存在时只读引用。
6. 不存在证书时，验证 DNS 和 WebRoot ACME 条件。
7. 以独立文件写入 Agent 配置，不覆盖宝塔已有站点。
8. 执行 Nginx 配置检查，通过后 reload。
9. 启动并验证 trojan-go。
10. 只登记 Agent 自己创建的文件和服务。

不实现停止网站抢占 443，也不自动配置 TLS/SNI 多路复用。

## 7. DNS 与证书失败

域名不保证在节点创建时已经就绪，因此 install 必须先预检：

- domain 有合法 A 或 AAAA 记录。
- DNS 结果满足当前证书方案。
- HTTP-01 WebRoot 可用，或者存在可复用证书。
- 证书私钥和证书链匹配。
- 证书剩余有效期满足最小要求。

失败时：

- 不写正式配置。
- 不启动协议服务。
- 不修改现有网站。
- operation 记录安全错误。
- 中心最终状态收敛为 error 或 not_installed。

## 8. 原子配置和回滚

- 所有配置先写同目录临时文件。
- 校验通过后执行原子 rename。
- 修改现有 Agent 自有文件前保存上一有效版本。
- Nginx reload 前必须执行配置检查。
- systemd 启动失败时恢复上一有效配置。
- 失败回滚不得删除操作开始前已存在且所有权不明的资源。

## 9. 卸载

卸载依据 owned_resources 执行：

- 停止并禁用 Agent 创建的协议 unit。
- 删除 Agent 创建的协议配置和独立 Nginx 配置。
- 删除本协议的 managed_users 映射。
- 保留共享 Nginx、宝塔、Node.js、PM2、ACME 客户端和非 Agent 证书。
- 默认保留 Agent 自身，使中心仍可查询 not_installed 并再次安装。

删除 Agent 本身属于独立的 decommission 流程，不由 `/api/trojan/uninstall` 执行。

## 10. IP 白名单

至少设置两层：

- VPS 云厂商安全组：控制端口只允许中心固定出口 IP。
- 主机防火墙：同样只允许中心固定出口 IP。

可再增加应用层 CIDR 校验作为防误配置保护。经过反向代理时必须明确可信代理层级，并由代理覆盖来源 IP Header。

中心出口 IP 变更时采用先加新 IP、验证连接、再删旧 IP 的顺序，避免失联。

## 11. 更新和回滚

Agent 更新与协议安装分离：

- Agent 使用带版本号的不可变发布目录。
- 更新前执行 SQLite 备份快照和配置校验。
- PM2 切换到新版本并执行健康检查。
- 健康检查失败恢复上一发布目录。
- 数据库迁移必须标记是否可回滚；不可回滚迁移需要先完成兼容版本过渡。

trojan-go 更新同样固定版本、校验 SHA-256，并在更新后验证运行时 API、端口和用户映射。

## 12. 故障恢复

- SQLite 无法打开：Agent 不接受修改请求，只提供最小健康信息。
- SQLite 确认损坏：隔离旧文件、新建数据库、设置 requiresUserSync。
- 中心看到 requiresUserSync 后执行完整 users/sync。
- 安装操作中断：根据 operations.current_stage 和实际主机状态恢复。
- 上报失败：指数退避；恢复后继续发送当前累计快照，不伪造流量增量。

