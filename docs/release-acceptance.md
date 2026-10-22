# 当前 Agent 上线验收

更新日期：2026-10-22。当前源码包版本见 `package.json`（0.2.1）；以实际发布的 commit、tag 和 release-manifest 为验收对象。本轮代码修改没有执行 VPS 灰度，也没有发布 release。

## 本地与 CI 入口

```sh
pnpm verify
```

该脚本依次执行格式、类型、测试和构建。Release workflow 在 Linux x64/arm64 各自执行验证并打包；本机通过不能替代另一架构 CI 结果或服务器运行结果。

2026-10-22 本地使用官方 Node.js 22.23.4 与 pnpm 11.22.0 通过格式、类型、构建及 59 项测试；1 项 Linux 原生权限检查因本机 macOS 跳过。新增回归覆盖真实 HTTP 代理白名单、压缩响应中断后的 gzip 资源释放，以及真实本地 gRPC 的 protobuf 大整数计数；压缩用例在旧 1.8.1 上复现失败，在 1.8.2 上通过。已在私有临时目录验证 PM2 6 daemon 退出、PM2 7.1.0 接管、save/kill/resurrect 及固定 Node 入口。PM2 6 的安全公告修复从 7.0.0 开始，因此本次随包版本改为 7.1.0，见[公告](https://github.com/advisories/GHSA-x5gf-qvw8-r2rm)。

同日已将原有生产依赖的 10 项公告（1 critical、5 high、2 moderate、2 low）一并修复到尚未发布的 0.2.1；更新后 `pnpm audit --prod` 报告 0 项已知告警。锁定版本如下：

| 依赖 | 原锁定版本 | 修复后锁定版本 |
|---|---|---|
| compression | 1.8.1 | 1.8.2 |
| @grpc/grpc-js | 1.14.4 | 1.14.6 |
| express → proxy-addr | 2.0.7 | 2.0.8 |
| @nestjs/platform-express → multer | 2.2.0 | 2.4.0 |
| @nestjs/swagger → js-yaml | 5.3.0 | 5.4.1 |

NestJS common/core/platform-express/testing 统一到 11.2.7，带入 Multer 2.4.0。Express 的 proxy-addr 在原有兼容范围内更新到 2.0.8；Swagger 11.4.7 固定的 js-yaml 5.3.0 通过 `pnpm-workspace.yaml` 中的定向 override 更新为 5.4.1，其他依赖使用的 js-yaml 4.3.2 保留。CI 和 Release workflow 均执行 `pnpm audit --prod`，发现生产依赖告警时阻止继续验证/发布。审计结论以执行时的公告数据库为准。

已按 CI 参数在本机组装生产包，核验上述实际依赖版本、SQLite 原生模块加载、无开发依赖及 `.env`、无绝对符号链接，并在私有临时目录启动打包后的 Agent，健康与状态接口均通过。该验证基于 macOS，Linux x64/arm64 构建及 VPS 生命周期验收仍按下列清单执行。

## 当前发布待实测

- [ ] 保存 Agent 与中心提交、tag、manifest、架构、artifact SHA-256、部署路径和环境。
- [ ] 验证已有安全 Node 22 复用，旧 22/其他主版本/无 Node 时专用安装，用户可写或服务用户不可访问路径回退；记录 runtime/node.json 与 PM2 daemon/Agent 实际 Node 版本。
- [ ] 验证 Node 下载校验失败、架构/ABI/原生模块预检失败时不切换 current、不停止原 Agent；验证新版卸载与新格式 release 回滚。
- [ ] 在普通 Ubuntu、Ubuntu 宝塔 Nginx、Alibaba Cloud Linux 3 x64 与其宝塔 Nginx 环境验证首次 Bootstrap、独立 env、权限、helper 和 PM2 自启动。
- [ ] 在 Alibaba Cloud Linux 3 的 `5.10.134-17.2.al8` 与 `5.10.134-19.1.al8` 节点验证 DNF、Node.js 22、EPEL Certbot、标准/宝塔 Nginx、`better-sqlite3` 和 firewalld inactive/active 两种路径。
- [ ] 核验 ALLOWED_CIDRS、可信 loopback 代理、云安全组及主机防火墙；非允许来源被拒绝。
- [ ] 三协议分别验证安装、证书获取/复用、start/stop、状态、日志、卸载/重复卸载及重装。
- [ ] 验证配置应用、修订幂等/冲突、失败恢复及中心生效配置收敛。
- [ ] 验证用户全量/增量、凭据更换、删除不存在用户和空数组清空全部用户。
- [ ] 使用外部客户端产生真实流量，检查人数、字节字符串、runtimeEpoch 与中心日/月/总账本。
- [ ] 验证未知上报来源同样返回 204，中心确实入账时再标记联调通过。
- [ ] 验证 Agent/主机重启、操作中断标记、requiresUserSync、无网及服务恢复。
- [ ] 按操作手册备份后升级，完成发布后检查与人工回滚；保存数据库/密钥恢复结果。
- [ ] 验证日志大小维护、证书续期、权限及 Agent 下线后共享网站保持可用。

执行步骤见[操作手册](operations-runbook.md)。每项记录日期、执行人、版本、前置条件、步骤、预期/实际结果与日志证据。旧项目、旧版接口、早期设计计划或其他 release 的测试均不作为当前通过依据。
