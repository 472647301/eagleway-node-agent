# 当前运行边界

核对日期：2026-10-14。本文列出当前源码和部署配置的边界；未来能力需单独确定需求并实现，不能由历史方案推定存在。

- 支持 Ubuntu x64/arm64、Ubuntu 宝塔 Nginx，运行协议为 Trojan/VLESS/VMess，共用 Xray。每台 VPS 同时一种协议。
- Agent 为 PM2 fork 单实例，Xray 为 systemd 服务；不使用中心数据库，本地 SQLite 保存执行状态及加密凭据。
- 中心业务事实和完整期望用户集合由当前 API 维护；users/sync 的空数组删除运行时全部用户。
- 配置应用、安装和卸载异步，启停同步；配置修订和生命周期状态分别维护。
- 控制及日志接口按来源 CIDR 限制，未实现应用层 HMAC/JWT；健康接口当前不应用 CIDR 守卫。
- 上报累计字节和 runtimeEpoch，并报告实际受管用户条目数和有活动连接的用户数；不执行额度超限删除或实时速率策略。
- 当前 status.startedAt 为 null；中心展示的启动时间可能为首次确认在线的估计。
- 中断操作标记失败，状态查询可收敛实际结果；没有通用阶段续跑、数据库损坏自动修复或部署自动回滚。
- 当前不实现 Shadowsocks、CentOS/RHEL、443 TLS/SNI 多路复用或 Agent 远程自更新。

代码入口见[架构](architecture.md)，协议见[节点契约](node-api-contract.md)，实际运维见[操作手册](operations-runbook.md)。
