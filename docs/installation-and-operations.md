# 当前安装与运维边界

核对日期：2026-10-29。可执行步骤见[操作手册](operations-runbook.md)，本页说明当前脚本能做什么和需要人工完成什么。

## 发布与 Bootstrap

当前 `.github/workflows/release.yml` 在 v* tag 或手动触发时验证并构建 Linux x64/arm64 release，包含生产依赖、dist、manifest、Bootstrap 与 helper，并生成 SHA-256 文件。

0.2.1 同时包含 Node.js 运行时更新和生产依赖安全补丁。源码与锁文件更新后，由 CI/Release 执行生产依赖审计及项目验证，服务器直接升级新 release；生产机不自行修改 `node_modules`。当前修复版本与本地验证结果见[上线验收](release-acceptance.md)。

生产 deploy 显式关闭 pnpm 的 `optimisticRepeatInstall`，避免重复打包时因源工作区已是最新而跳过新发布目录的依赖安装；打包后还会检查 PM2、原生模块与开发依赖隔离。

`scripts/deploy-ubuntu-release.sh` 下载和校验对应架构 artifact，维护独立 env 文件，随后调用 `scripts/bootstrap-ubuntu.sh`。两个文件名为兼容旧发布保留，实际支持 Ubuntu 与 Alibaba Cloud Linux 3。Bootstrap 通过 apt/dnf 安装基础系统工具，优先复用 root 所有且服务用户可执行的 Node.js `>=22.23.4 <23`，无合格版本时下载固定版本/校验和的官方 Node 到 `/opt/eagleway-node-agent/runtimes`，不覆盖共享 Node。可用 `--node-bin /绝对路径/node` 指定候选；nvm 用户可写路径不能用于 root helper，会自动跳过。

PM2 7.1.0 是发布包的生产依赖，服务器不再安装全局 PM2/npm。manifest v2 记录构建 Node 版本、最低版本和原生模块 ABI；Bootstrap 校验后创建低权限用户、配置/状态/日志目录和 root 所有的 release。每个 release 的 `runtime/bin/node` 固定到选定 Node，`runtime/node.json` 记录版本和路径；Agent、helper、`eagleway-agent-pm2` 与 `pm2-eagleway-agent.service` 共同使用该入口。切换时停止旧 PM2 daemon，并用新运行时重建、保存单实例及注册开机启动。

主要路径为 `/opt/eagleway-node-agent/releases`、`/opt/eagleway-node-agent/current`、`/etc/eagleway-node-agent`、`/var/lib/eagleway-node-agent`、`/var/log/eagleway-node-agent`。数据库与 state.key 需要一起备份；发布目录不可由 Agent 用户改写。

当前 Bootstrap 不自动备份 SQLite，不执行部署健康检查后的自动回滚。更新前备份、发布后健康与接口检查、失败时人工回滚均按操作手册执行。

## 协议安装与配置

Agent install/config/apply 操作调用固定 helper；Xray 官方 artifact 版本和 SHA-256 固定在 `src/host/xray-release.ts`，由 helper 引用；0.2.2 固定为 v26.10.29，不能通过控制请求或环境变量更改。部署新版 Agent 不会自动替换已安装的核心；相同配置的 install 直接返回，config/apply 只更新配置。存量节点按[核心升级与回滚](xray-core-upgrade.md)在维护窗口替换并验证，中心 API 契约不变。

Ubuntu、Alibaba Cloud Linux 3 及其宝塔 Nginx 环境支持复用现有证书；宝塔缺少证书时使用现有目标站点 WebRoot，或创建带所有权标记的 ACME vhost 后签发。Alibaba Cloud Linux 3 使用 EPEL Certbot；空白系统的标准 Nginx 来自带 GPG 校验的 nginx.org CentOS 8 仓库。Certbot 续期 hook 仅在证书被当前配置引用时重启运行时；宝塔自行续期后按手册核验并重启。

不覆盖共享网站主配置，不通过停止网站抢占端口。预检范围以[节点契约](node-api-contract.md)为准，完整证书和安装能力由异步执行阶段确认。

## 卸载与故障恢复

协议 uninstall 与 Agent 下线分离。协议卸载只处理受管 runtime 资源、用户与状态，保留 Agent；下线使用 `scripts/uninstall-ubuntu.sh`，按手册选择是否保留数据。

Agent 重启将未完成操作标记为失败并在状态查询时核对实际运行状态；不存在通用阶段自动续跑能力。SQLite 初始化失败阻止正常启动；损坏数据的隔离、恢复和中心重新同步需要运维处理。

## 网络访问

云安全组、主机防火墙和 ALLOWED_CIDRS 同时核对中心出口来源。Bootstrap 为已启用 UFW 或 firewalld 添加当前控制端口来源规则，不自动删除配置变更后遗留的历史规则。TRUST_PROXY=true 时应用仅信任 loopback 代理。

以上行为依据当前 scripts、host、helper、state 与 operations 源码；当前 release 的真实服务器结果见[上线验收](release-acceptance.md)。
