# 当前 Agent 上线验收

更新日期：2026-10-17。当前源码包版本见 `package.json`（0.2.0）；以实际发布的 commit、tag 和 release-manifest 为验收对象。本轮代码修改没有执行 VPS 灰度，也没有发布 release。

## 本地与 CI 入口

```sh
pnpm verify
```

该脚本依次执行格式、类型、测试和构建。Release workflow 在 Linux x64/arm64 各自执行验证并打包；本机通过不能替代另一架构 CI 结果或服务器运行结果。

## 当前发布待实测

- [ ] 保存 Agent 与中心提交、tag、manifest、架构、artifact SHA-256、部署路径和环境。
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
