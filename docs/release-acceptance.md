# 当前 Agent 上线验收

更新日期：2026-10-29。当前源码包版本见 `package.json`（0.2.2）；以实际发布的 commit、tag 和 release-manifest 为验收对象。本轮代码修改没有执行 VPS 灰度，也没有发布 release。

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

## Xray-core 26.10.29 升级

0.2.2 将固定核心从 v26.3.27 更新为 v26.10.29，两个 Linux 架构沿用原官方附件名。已下载 Linux x64/arm64 和本机测试用 macOS arm64 安装包，分别计算 SHA-256，与官方 Release 元数据及 `.dgst` 文件交叉验证一致。固定值见 `src/host/xray-release.ts`。

已对比两个 tag 的 HandlerService、StatsService、User、TypedMessage 与三协议 Account protobuf；现用 RPC 和字段保持兼容，StatsService 新增的 GetUsersStats 不在本次接入范围。中心与节点 API 契约保持不变。

新增 `pnpm test:xray` 真实核心集成测试，使用与 helper 相同的配置生成器，检查三协议配置校验、gRPC 用户增删/列表、TLS 代理流量、上下行统计、在线用户和核心重启后的用户恢复。Linux CI 与 x64/arm64 Release job 在 `pnpm verify` 后运行 `bash scripts/test-xray-runtime.sh`，按 helper 的固定来源下载并校验核心；任一集成测试失败会阻止打包。

2026-10-29 本机 macOS arm64、Node.js 22.23.4、pnpm 11.22.0 验证通过：`pnpm verify`（59 项通过、1 项 Linux 权限用例跳过）、三协议真实 v26.10.29 核心集成测试、Shell 语法及文档命令语法检查。另对比确认配置生成器提取前后三协议默认 JSON 完全一致，编译后的两架构校验值与实际下载包一致。核心测试使用临时自签证书及固定证书指纹，只绑定本机端口，不操作生产目录。

核心在线统计主动排除来源 `127.0.0.1`，因此 macOS 测试验证该来源的在线列表为空；Linux 测试用 `127.0.0.2` 来源验证非零在线人数。新版默认禁止三协议代理访问私网，测试仅放行精确本机目标；生产保持核心默认策略，使用代理访问私网目标的节点须在升级前验证业务兼容性。

同日发布审计发现已有锁定依赖的 3 项公告（2 high、1 moderate），通过 `pnpm-workspace.yaml` 的受影响版本范围 override 定向修复，锁文件仅变更以下三个依赖，修复后 `pnpm audit --prod` 为 0 项已知告警：

| 依赖 | 原版本 | 修复版本 | 公告 |
|---|---|---|---|
| body-parser | 2.3.0 | 2.4.0 | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| multer | 2.4.0 | 2.5.0 | [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) |
| qs | 6.16.0 | 6.16.1 | [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) |

本轮 Linux CI、systemd、runtimeEpoch 与 VPS 灰度结果尚待实测，不能用 macOS 的运行结果替代。存量节点通过中心 API 卸载重装升级核心，步骤见[操作手册第 9.6 节](operations-runbook.md#96-xray-core-升级)。

## 当前发布待实测

- [ ] 保存 Agent 与中心提交、tag、manifest、架构、artifact SHA-256、部署路径和环境。
- [ ] 验证已有安全 Node 22 复用，旧 22/其他主版本/无 Node 时专用安装，用户可写或服务用户不可访问路径回退；记录 runtime/node.json 与 PM2 daemon/Agent 实际 Node 版本。
- [ ] 验证 Node 下载校验失败、架构/ABI/原生模块预检失败时不切换 current、不停止原 Agent；验证新版卸载与新格式 release 回滚。
- [ ] 在普通 Ubuntu、Ubuntu 宝塔 Nginx、Alibaba Cloud Linux 3 x64 与其宝塔 Nginx 环境验证首次 Bootstrap、独立 env、权限、helper 和 PM2 自启动。
- [ ] 在 Alibaba Cloud Linux 3 的 `5.10.134-17.2.al8` 与 `5.10.134-19.1.al8` 节点验证 DNF、Node.js 22、EPEL Certbot、标准/宝塔 Nginx、`better-sqlite3` 和 firewalld inactive/active 两种路径。
- [ ] 核验 ALLOWED_CIDRS、可信 loopback 代理、云安全组及主机防火墙；非允许来源被拒绝。
- [ ] 在 Linux x64/arm64 通过真实 v26.10.29 核心集成测试，并核对新装及存量节点的 runtimeVersion；验证中心 API 卸载、重装、同步用户的升级流程及失败恢复。
- [ ] 三协议分别验证安装、证书获取/复用、start/stop、状态、日志、卸载/重复卸载及重装。
- [ ] 验证配置应用、修订幂等/冲突、失败恢复及中心生效配置收敛。
- [ ] 验证用户全量/增量、凭据更换、删除不存在用户和空数组清空全部用户。
- [ ] 使用外部客户端产生真实流量，检查人数、字节字符串、runtimeEpoch 与中心日/月/总账本。
- [ ] 验证未知上报来源同样返回 204，中心确实入账时再标记联调通过。
- [ ] 验证 Agent/主机重启、操作中断标记、requiresUserSync、无网及服务恢复。
- [ ] 按操作手册备份后升级，完成发布后检查与人工回滚；保存数据库/密钥恢复结果。
- [ ] 验证日志大小维护、证书续期、权限及 Agent 下线后共享网站保持可用。

执行步骤见[操作手册](operations-runbook.md)。每项记录日期、执行人、版本、前置条件、步骤、预期/实际结果与日志证据。旧项目、旧版接口、早期设计计划或其他 release 的测试均不作为当前通过依据。
