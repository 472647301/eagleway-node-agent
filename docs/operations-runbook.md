# Eagleway Node Agent 运维与服务器自测手册

状态：当前操作手册

核对日期：2026-10-29

本文面向负责 Eagleway Network 节点服务器的基础运维人员，描述当前版本可以实际执行的部署、验证、升级、回滚和故障定位流程。接口字段说明见[当前节点契约](node-api-contract.md)，变更时同时核对 Controller/DTO/Service。上线证据见[当前验收清单](release-acceptance.md)，未勾选不代表已完成。

## 1. 系统关系与责任边界

~~~text
Eagleway Network 客户端
        │ VPN 代理流量
        ▼
节点 VPS 上的 Xray-core
        ▲
        │ 本机生命周期、用户与统计控制
Eagleway Node Agent
        ▲                         │
        │ 控制 API                │ 主动上报流量
        │                         ▼
私有仓库 eagleway-network-api / 中心 API
~~~

- eagleway-network-api 是中心事实源，负责节点、用户分配和流量账本。
- Node Agent 只管理当前 VPS 上的运行时、用户映射、操作状态和上报游标。
- SQLite 是可重建的本机状态，不是中心数据库副本。
- 一台 VPS 同时只运行 Trojan、VLESS、VMess 中的一种协议。
- 协议 install/uninstall 管理 Xray 资源，不安装或删除 Agent 自身。
- 当前版本支持 Ubuntu x64/arm64、Alibaba Cloud Linux 3 x64 及其宝塔 Nginx 环境；不支持通用 CentOS/RHEL、Alibaba Cloud Linux 2/4、宝塔 Apache、Shadowsocks 和 443 SNI 多路复用。
- 当前版本没有 HMAC/JWT 节点鉴权，控制面依赖中心固定出口 IP 白名单、云安全组和主机防火墙。

服务器本机自测不能证明以下事项：

- 云安全组和公网防火墙已允许客户端访问协议端口。
- 域名从公网解析到正确的 VPS 公网 IP。
- Eagleway Network 客户端能够完成真实代理连接。
- 中心收到 HTTP 204 后确实按来源 IP 找到节点并写入账本。

这些项目必须在中心侧或另一台外部主机补验。

## 2. 固定资源

| 资源 | 位置或名称 | 所有者/用途 |
|---|---|---|
| Agent 进程 | eagleway-node-agent | eagleway-agent 用户下的 PM2 fork 单实例 |
| 当前发布 | /opt/eagleway-node-agent/current | 指向带时间戳 release 的软链接 |
| Node 入口与记录 | current/runtime/bin/node、current/runtime/node.json | 绑定该 release 选定的 Node；root 管理 |
| 专用 Node | /opt/eagleway-node-agent/runtimes | 无合格共享 Node 时安装的官方运行时 |
| PM2 管理命令 | /usr/local/bin/eagleway-agent-pm2 | 以 eagleway-agent 执行，使用 release 内 PM2 与 Node |
| 历史发布 | /opt/eagleway-node-agent/releases | 用于人工回滚，不自动清理 |
| 运行配置 | /etc/eagleway-node-agent/agent.env | root:eagleway-agent，0640 |
| 加密密钥 | /etc/eagleway-node-agent/state.key | eagleway-agent，0600 |
| SQLite 状态 | /var/lib/eagleway-node-agent/state.db | 操作、用户映射和上报游标 |
| Agent 日志 | /var/log/eagleway-node-agent | PM2 和 Xray 日志 |
| 提权 helper | /usr/local/libexec/eagleway-node-helper | root:root，Agent 不可修改 |
| sudo 规则 | /etc/sudoers.d/eagleway-node-agent | 只允许固定 helper 动作 |
| Xray unit | eagleway-xray.service | Agent 管理的 systemd 服务 |
| Xray 配置 | /etc/eagleway-node-agent/runtimes/xray | Agent 管理 |
| Xray 程序 | /usr/local/bin/xray | Agent 管理 |

不要直接修改 current 下的构建产物。源码更新必须产生新 release，再由 PM2 切换。

## 3. 部署前准备

### 3.1 中心侧

1. 先在 eagleway-network-api 对应环境创建节点记录并取得正整数 nodeId。
2. 确认节点协议、域名、协议端口和可选 proxyUrl。
3. 记录中心访问节点控制 API 时使用的固定出口 IP。
4. 如果启用流量上报，确认中心 traffic-report 路由可用，并将节点 reportSourceIp 配置为 VPS 实际出口 IP。

Node.apiEndpoint 是 Agent 控制地址，例如 http://node-ip:8086；它不是客户端连接的 Trojan/VLESS/VMess 地址。

### 3.2 VPS 和网络

- Ubuntu 22.04/24.04（x64 或 arm64），或 Alibaba Cloud Linux 3.2104（x64），systemd 正常运行。
- root 或 sudo 权限。
- 能访问系统 apt/dnf 源、nodejs.org、nginx.org、EPEL 和 XTLS GitHub Release；生产部署不需要 npm/NodeSource 源。
- 域名具有 A 或 AAAA 记录。
- 云安全组按需放行 TCP 80、Agent 控制端口和协议端口；已启用的 UFW 或 firewalld 由 Agent 自动放行 80 和协议端口。
- Agent 控制端口只允许中心出口 IP，不得对整个公网开放。
- 普通系统首次签发证书时需要 TCP 80；已有可复用证书时可跳过签发。Alibaba Cloud Linux 3 空白系统会配置 nginx.org CentOS 8 仓库并从 EPEL 安装 Certbot。
- 宝塔环境缺少证书时，Agent 会优先复用目标域名站点的 Nginx WebRoot；如果不存在该域名站点，则在宝塔 vhost 目录创建带所有权标记的最小 ACME 站点，再执行 HTTP-01。`bt` 命令没有稳定的按域名签发接口，Agent 不调用版本相关的菜单编号。
- 目标协议端口不能被其他进程占用。
- 如果已有非 Eagleway 管理的 /usr/local/bin/xray、Xray unit 或运行时目录，安装会拒绝覆盖。

检查示例：

~~~bash
cat /etc/os-release
uname -m
systemctl is-system-running
getent ahostsv4 node.example.com
getent ahostsv6 node.example.com
sudo ss -ltnp 'sport = :80'
sudo ss -ltnp 'sport = :9443'
~~~

## 4. 配置 .env

Bootstrap 接受独立 env 文件路径，并把验证后的文件安装到 /etc/eagleway-node-agent/agent.env。它不会以 root 身份 source env 文件，也不会把该文件复制进 release。便捷部署脚本默认长期维护 `~/.config/eagleway-node-agent/agent.env`，首次运行时会自动创建并打开该文件。

最小的独立自测配置：

~~~dotenv
NODE_ENV=production
PORT=8086
HOST=0.0.0.0
NODE_ID=1
ALLOWED_CIDRS=127.0.0.1/32
TRUST_PROXY=false
CENTER_API_URL=
REPORT_INTERVAL_SECONDS=300
REPORTING_ENABLED=false
STATE_DIR=/var/lib/eagleway-node-agent
STATE_KEY_PATH=/etc/eagleway-node-agent/state.key
LOG_DIR=/var/log/eagleway-node-agent
XRAY_BINARY=/usr/local/bin/xray
XRAY_API_ADDRESS=127.0.0.1:10000
ACME_EMAIL=
PRIVILEGED_HELPER=/usr/local/libexec/eagleway-node-helper
OPERATION_TIMEOUT_SECONDS=900
~~~

接入中心时：

~~~dotenv
ALLOWED_CIDRS=127.0.0.1/32,203.0.113.10/32
CENTER_API_URL=https://api.example.com
REPORTING_ENABLED=true
~~~

说明：

- NODE_ID、PORT、ALLOWED_CIDRS 和 REPORTING_ENABLED 是 bootstrap 必填项。
- REPORTING_ENABLED=true 时 CENTER_API_URL 必填。
- 服务器带宽由中心 API 自行维护，不写入 Agent 配置，也不由 Agent 上报。
- 必须保留 127.0.0.1/32，才能在服务器本机执行本文的 curl 自测。
- STATE_DIR、STATE_KEY_PATH、LOG_DIR、XRAY_BINARY 和 PRIVILEGED_HELPER 如果显式配置，必须使用项目固定路径。
- 修改 /etc 下的运行配置只能作为应急操作；下次 bootstrap 会用传入的 env 文件覆盖它，因此最终修改必须回写长期维护的 env 文件。
- 中心出口 IP 变化时，先追加新 CIDR并验证，再删除旧 CIDR。
- Bootstrap 只新增当前 CIDR 对应的 UFW allow 或 firewalld rich rule，不会自动删除配置变更后遗留的历史规则；确认新来源可用后需要人工清理旧规则。

## 5. 发布与首次部署

### 5.1 创建发布 tag

在开发机确认待发布代码已经合并到 `main`、本地验证通过且工作区没有未提交修改，然后创建带注释的版本 tag：

~~~bash
git switch main
git pull --ff-only
pnpm verify
git status --short
git push origin main
git tag -a v0.2.2 -m "release: v0.2.2"
git push origin v0.2.2
~~~

`git status --short` 应无输出。推送 `v*` tag 后，在以下地址查看构建进度：

- https://github.com/472647301/eagleway-node-agent/actions/workflows/release.yml
- https://github.com/472647301/eagleway-node-agent/releases

不要移动或强制覆盖已经发布的 tag。发布内容需要修正时，提交修复并创建新的递增版本 tag，例如 `v0.2.2`。

### 5.2 VPS 首次部署

Release workflow 在 Linux x64/arm64 runner 上构建对应架构的生产发布包。x64 包的 `better-sqlite3` 在 Node 22 + Debian Bullseye（glibc 2.31）容器内强制重建并加载验证，以兼容 glibc 2.32 的 Alibaba Cloud Linux 3。推送 `v*` tag 会同时创建或更新 GitHub Release；手动运行 workflow 时，发布包位于该 Actions run 的 artifacts 中，保留 30 天。

等待 GitHub Release 中出现 x64 和 arm64 产物后，在 VPS 执行：

~~~bash
TAG=v0.2.2
curl -fsSL "https://raw.githubusercontent.com/472647301/eagleway-node-agent/${TAG}/scripts/deploy-ubuntu-release.sh" -o /tmp/eagleway-deploy.sh
bash /tmp/eagleway-deploy.sh "${TAG}"
~~~

脚本自动识别 `x86_64`/`aarch64`，从公开 GitHub Release 下载对应包和 `.sha256` 文件，完成校验、解压和 Bootstrap。首次运行会创建 `~/.config/eagleway-node-agent/agent.env` 并优先使用 Vim 打开，未安装完整 Vim 时回退到 vi；保存配置后会继续部署。校验失败时脚本不会执行包内 Bootstrap。

Bootstrap 安装基础系统工具，优先复用 root 所有、组/其他用户不可写且服务用户可执行的 Node.js `>=22.23.4 <23`，依次检查调用者 PATH 中的候选、`/usr/bin/node`、`/usr/local/bin/node` 和现有专用运行时。低版本、其他主版本及用户可写/不可访问路径会被跳过；没有合格版本时，将固定版本/固定 SHA-256 的官方 Node 安装到 `/opt/eagleway-node-agent/runtimes`。可追加 `--node-bin /绝对路径/node` 指定首选候选，普通用户执行部署时会在 sudo 前传递该路径。共享 Node 不被覆盖或降级；其他服务使用的旧共享版本仍需单独更新。

PM2 7.1.0 随 CI release 打包。manifest v2 校验平台、架构、最低 Node 版本及原生模块 ABI。以服务用户加载 `better-sqlite3` 和校验配置完成后才停止旧 daemon、切换 current，并用 `eagleway-agent-pm2` 重建单实例与 systemd 开机启动。VPS 不安装 npm/pnpm 依赖、TypeScript、Nest CLI 或编译工具。重复执行保留 SQLite、state.key、证书和 Xray 用户状态。

旧节点从 0.2.0 升级时，备份步骤中的管理命令仍使用旧版全局 `pm2`；完成新版部署后改用 `eagleway-agent-pm2`。仅重跑旧 Bootstrap 会继续跳过已有旧 Node 22，必须部署新 release。

部署后立即检查：

~~~bash
readlink -f /opt/eagleway-node-agent/current
cat /opt/eagleway-node-agent/current/runtime/node.json
sudo -u eagleway-agent -H eagleway-agent-pm2 status
sudo -u eagleway-agent -H eagleway-agent-pm2 describe eagleway-node-agent
curl -sS http://127.0.0.1:8086/api/health
sudo -u eagleway-agent -H sudo -n -l
~~~

期望：

- PM2 状态为 online、exec mode 为 fork、instances 为 1。
- PM2 describe 中实际 Node 版本至少为 22.23.4；`systemctl show pm2-eagleway-agent.service -p MainPID` 对应进程的 `/proc/<PID>/exe` 应指向选定 Node。不能只根据登录终端的 `node -v` 判断升级完成。
- 健康接口返回 code=0 和 status=ok。
- sudo 列表只包含 eagleway-node-helper 的固定动作。

## 6. 运维命令速查

仅重启 Agent，不发布新源码：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent
~~~

修改了 /etc/eagleway-node-agent/agent.env 后重载环境：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent --update-env
~~~

查看状态和日志：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 status
sudo -u eagleway-agent -H eagleway-agent-pm2 describe eagleway-node-agent
sudo -u eagleway-agent -H eagleway-agent-pm2 logs eagleway-node-agent --nostream --lines 200
sudo -u eagleway-agent -H eagleway-agent-pm2 logs eagleway-node-agent --lines 200
sudo tail -n 200 /var/log/eagleway-node-agent/agent-error.log
sudo tail -F /var/log/eagleway-node-agent/agent.log
sudo journalctl -u eagleway-xray.service -n 200 --no-pager
~~~

不带 `--nostream` 的 `pm2 logs` 和 `tail -F` 会持续跟踪日志，按 `Ctrl+C` 只退出查看，不会停止 Agent。标准输出位于 `/var/log/eagleway-node-agent/agent.log`，错误输出位于 `/var/log/eagleway-node-agent/agent-error.log`。

检查端口和服务：

~~~bash
sudo systemctl status eagleway-xray.service --no-pager
sudo ss -ltnp
sudo nginx -t
sudo certbot certificates
~~~

### 6.1 Xray 运行状态与配置检查

Eagleway 管理的 Xray systemd unit 是 `eagleway-xray.service`，不是上游安装脚本常用的 `xray.service`；配置文件固定为 `/etc/eagleway-node-agent/runtimes/xray/config.json`。

查看服务状态、实际启动参数和日志：

~~~bash
sudo systemctl status eagleway-xray.service --no-pager -l
sudo systemctl is-enabled eagleway-xray.service
sudo systemctl is-active eagleway-xray.service
sudo systemctl show eagleway-xray.service -p ExecStart -p FragmentPath
sudo systemctl cat eagleway-xray.service
sudo journalctl -u eagleway-xray.service -n 200 --no-pager
~~~

检查程序、配置、所有权标记和监听端口：

~~~bash
sudo test -x /usr/local/bin/xray && echo 'xray binary: ok' || echo 'xray binary: missing'
sudo test -f /etc/eagleway-node-agent/runtimes/xray/config.json && echo 'xray config: ok' || echo 'xray config: missing'
sudo -u eagleway-agent test -e /etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent && echo 'ownership marker: visible' || echo 'ownership marker: missing or unreadable'
sudo /usr/local/bin/xray version
sudo ss -lntup | grep -E 'xray|:10000'
~~~

仅在服务器本机查看并验证配置：

~~~bash
sudo less /etc/eagleway-node-agent/runtimes/xray/config.json
sudo /usr/local/bin/xray run -test -config /etc/eagleway-node-agent/runtimes/xray/config.json
~~~

配置可能包含 UUID、密码、证书路径或私钥，禁止粘贴到聊天、日志或工单。如果 `eagleway-xray.service`、Xray 程序和配置文件均不存在，通常表示 Agent 已部署但协议尚未通过中心的 install 接口安装；此时 status 应为 `not_installed`。不要手工创建 `xray.service`，应通过中心安装 Trojan、VLESS 或 VMess，让 Agent 创建和管理运行时资源。

不要在 install/uninstall 的 activeOperation 非空时重启 Agent、执行 bootstrap 或重启服务器。

## 7. 服务器本机全功能自测

以下命令只从 127.0.0.1 调用 Agent，不经过 eagleway-network-api。测试前确保 .env 的 ALLOWED_CIDRS 包含 127.0.0.1/32。

完整生命周期和用户增删测试只应在专用测试节点执行。生产节点上的用户事实源是中心 API，不要用临时 credential 覆盖真实分配。

### 7.1 初始化测试变量

~~~bash
API_BASE=http://127.0.0.1:8086
NODE_ID=1
PROTOCOL=trojan
DOMAIN=node.example.com
PROTOCOL_PORT=9443

post_agent() {
  local path="$1"
  local body="$2"
  curl -sS -X POST "$API_BASE$path" -H 'Content-Type: application/json' --data "$body" --write-out '\nHTTP %{http_code}\n'
}
~~~

PROTOCOL 可替换为 trojan、vless 或 vmess。DOMAIN 必须替换为真实域名。

### 7.2 健康和初始状态

~~~bash
curl -sS "$API_BASE/api/health"
post_agent "/api/$PROTOCOL/status" "{\"nodeId\":$NODE_ID}"
~~~

全新节点应为 not_installed。健康接口只证明 Agent HTTP 进程可用，不证明 Xray 或公网链路可用。

### 7.3 安装协议

~~~bash
post_agent "/api/$PROTOCOL/install" "{\"nodeId\":$NODE_ID,\"port\":$PROTOCOL_PORT,\"domain\":\"$DOMAIN\"}"
~~~

需要测试伪装站点时，可在 JSON 中增加 proxyUrl，例如 https://www.example.com。proxyUrl 只允许 HTTP(S)，不能包含认证信息、fragment 或 Shell 特殊字符。

成功接受时 HTTP 状态为 202，data.state 为 installing，并返回 operationId。安装为异步操作，不要因为暂时仍是 installing 就重复提交。

轮询：

~~~bash
while true; do
  post_agent "/api/$PROTOCOL/status" "{\"nodeId\":$NODE_ID}"
  sleep 3
done
~~~

按 Ctrl+C 结束。最终应为 online；如果为 error，检查 lastError 和第 12 节。

安装完成后再次提交 install 应直接返回当前稳定状态，不重复覆盖。修改同一协议的域名、端口或 proxyUrl 前，应先 uninstall 并等待 not_installed，再用新配置 install。

操作系统侧验证：

~~~bash
sudo systemctl is-enabled eagleway-xray.service
sudo systemctl is-active eagleway-xray.service
sudo ss -ltnp "sport = :$PROTOCOL_PORT"
sudo ss -ltnp 'sport = :10000'
sudo test -x /usr/local/bin/xray && echo 'xray binary: ok'
sudo test -f /etc/eagleway-node-agent/runtimes/xray/config.json && echo 'xray config: ok'
sudo -u eagleway-agent test -e /etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent && echo 'ownership marker: visible'
~~~

本机 TLS 握手检查：

~~~bash
openssl s_client -connect "127.0.0.1:$PROTOCOL_PORT" -servername "$DOMAIN" </dev/null
~~~

检查输出中的证书域名和 Verify return code。TLS 成功不等于协议鉴权和代理流量成功。

### 7.4 全量同步用户

生成两个 assignmentId：

~~~bash
ASSIGNMENT_ONE="$(cat /proc/sys/kernel/random/uuid)"
ASSIGNMENT_TWO="$(cat /proc/sys/kernel/random/uuid)"
~~~

Trojan credential 使用高熵随机串：

~~~bash
CREDENTIAL_ONE="$(openssl rand -hex 24)"
CREDENTIAL_TWO="$(openssl rand -hex 24)"
~~~

VLESS/VMess credential 必须改用 UUID：

~~~bash
CREDENTIAL_ONE="$(cat /proc/sys/kernel/random/uuid)"
CREDENTIAL_TWO="$(cat /proc/sys/kernel/random/uuid)"
~~~

同步一个用户：

~~~bash
post_agent "/api/$PROTOCOL/user/sync" "{\"nodeId\":$NODE_ID,\"users\":[{\"assignmentId\":\"$ASSIGNMENT_ONE\",\"credential\":\"$CREDENTIAL_ONE\"}]}"
~~~

成功响应只返回 assignmentId，不得返回 credential。再次查询 status，requiresUserSync 应为 false。

### 7.5 增量新增、更新和删除

新增第二个用户：

~~~bash
post_agent "/api/$PROTOCOL/user/update" "{\"nodeId\":$NODE_ID,\"action\":\"add\",\"users\":[{\"assignmentId\":\"$ASSIGNMENT_TWO\",\"credential\":\"$CREDENTIAL_TWO\"}]}"
~~~

重复执行同一个 add 应保持幂等，不应创建重复运行时用户。

要测试 credential 更新，生成一个符合当前协议要求的新 credential，并对同一个 ASSIGNMENT_ONE 再执行 action=add；运行时用户应被替换，但 assignmentId 保持不变。

删除第二个用户：

~~~bash
post_agent "/api/$PROTOCOL/user/update" "{\"nodeId\":$NODE_ID,\"action\":\"delete\",\"assignmentIds\":[\"$ASSIGNMENT_TWO\"]}"
~~~

重复删除不存在的用户也应成功。

验证空数组清空全部用户：

~~~bash
post_agent "/api/$PROTOCOL/user/sync" "{\"nodeId\":$NODE_ID,\"users\":[]}"
~~~

完成后可再次同步 ASSIGNMENT_ONE，供流量测试使用。

### 7.6 流量和运行时用户数

~~~bash
post_agent "/api/$PROTOCOL/traffic" "{\"nodeId\":$NODE_ID}"
~~~

检查：

- runtimeEpoch 是 32 位十六进制 systemd InvocationID。
- managedUserCount 与 Xray 实际入站用户数一致。
- onlineUserCount 与采样时存在活动连接的受管用户数一致。
- uploadBytes 和 downloadBytes 是十进制字符串，不是 JSON number。
- 本机没有真实代理请求时，计数为 0 是正常的。

要验证在线人数和计数增长，必须从外部客户端使用同步后的 credential 建立真实 Trojan/VLESS/VMess 连接并产生上下行流量，然后再次查询；断开所有连接后 onlineUserCount 应恢复为 0。

### 7.7 日志 API

列出日志：

~~~bash
post_agent "/api/log/files" '{}'
~~~

读取最新 100 行：

~~~bash
post_agent "/api/log/pages" '{"filename":"agent.log","page":1,"pageSize":100}'
~~~

再测试 xray-error.log 等 files 接口实际返回的文件。接口必须拒绝 ../、绝对路径、软链接逃逸和 pageSize 大于 500。

### 7.8 停止和启动

~~~bash
post_agent "/api/$PROTOCOL/stop" "{\"nodeId\":$NODE_ID}"
post_agent "/api/$PROTOCOL/status" "{\"nodeId\":$NODE_ID}"
sudo systemctl is-active eagleway-xray.service

post_agent "/api/$PROTOCOL/start" "{\"nodeId\":$NODE_ID}"
post_agent "/api/$PROTOCOL/status" "{\"nodeId\":$NODE_ID}"
sudo systemctl is-active eagleway-xray.service
~~~

stop 后应为 stopped，start 后应为 online。start 会尝试恢复 SQLite 中保存的用户。

### 7.9 基础错误与安全检查

错误 nodeId：

~~~bash
post_agent "/api/$PROTOCOL/status" '{"nodeId":999999}'
~~~

期望 HTTP 403 和 NODE_ID_MISMATCH。

不支持的协议：

~~~bash
post_agent '/api/shadowsocks/status' "{\"nodeId\":$NODE_ID}"
~~~

期望 HTTP 400 和 INVALID_REQUEST。

未知字段：

~~~bash
post_agent "/api/$PROTOCOL/status" "{\"nodeId\":$NODE_ID,\"unexpected\":true}"
~~~

期望 HTTP 400。非白名单来源测试必须从另一台主机发起，期望 HTTP 403。

### 7.10 卸载和重新安装

~~~bash
post_agent "/api/$PROTOCOL/uninstall" "{\"nodeId\":$NODE_ID}"
~~~

成功接受时为 HTTP 202 和 uninstalling。轮询 status，最终应为 not_installed。

验证 Agent 自有 Xray 资源已删除：

~~~bash
sudo systemctl status eagleway-xray.service --no-pager
sudo test ! -e /usr/local/bin/xray && echo 'xray binary removed'
sudo test ! -e /etc/eagleway-node-agent/runtimes/xray && echo 'runtime directory removed'
sudo ss -ltnp "sport = :$PROTOCOL_PORT"
curl -sS "$API_BASE/api/health"
~~~

Agent、Node.js、PM2、Nginx、Certbot、证书和其他网站应保留。重复 uninstall 应返回 not_installed 且不报错。随后重新执行 install、用户 sync 和 traffic，验证可重装。

## 8. 与 eagleway-network-api 联调

1. 将中心固定出口 IP 加入 ALLOWED_CIDRS，同时保留 localhost。
2. 云安全组和 UFW/firewalld 只对该出口 IP 开放 Agent 控制端口。
3. 设置 CENTER_API_URL 和 REPORTING_ENABLED=true。
4. 使用独立 env 文件重新运行 bootstrap，或核对 `/etc/eagleway-node-agent/agent.env` 后使用 --update-env 重启；不要依赖源码目录的 .env。
5. 在中心发起 install，确认中心状态从 installing 收敛到 online。
6. 确认 requiresUserSync=true 时中心发送完整 users/sync，即使期望集合为空也必须发送空数组。
7. 从中心执行用户新增、删除、start、stop、status、traffic 和日志读取。
8. 产生真实客户端流量并核对中心账本。

流量上报注意：

- Agent 启动约 5 秒后会尝试首次上报；如果当时 Xray 尚未安装，下一次按 REPORT_INTERVAL_SECONDS 执行。
- 协议安装完成后，可以重启一次 Agent 触发 5 秒后的测试上报。
- Agent 日志中的 traffic.report_succeeded 只证明中心返回 204。
- 中心对未知来源 IP 也可能返回 204，因此必须在中心日志、数据库或管理接口确认该节点确实入账。
- 上报 Body 不包含 nodeId，中心只能依据可信来源 IP 匹配节点。

## 9. 更新与发布

当前项目没有远程自更新服务。CI 负责验证、构建和打包，bootstrap 只安装经过校验的 release artifact；它不是零停机发布工具，应在维护窗口执行。

### 9.1 发布前

1. 暂停中心对该节点的 install/uninstall/start/stop 和用户修改。
2. 查询 status，确认 activeOperation 为 null。
3. 记录当前 release 和构建 manifest。

~~~bash
readlink -f /opt/eagleway-node-agent/current
cat /opt/eagleway-node-agent/current/release-manifest.json
~~~

### 9.2 备份

确认没有活动操作后停止 Agent。Xray systemd 服务会继续承载已有代理流量，但维护期间中心不能控制节点。

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 stop eagleway-node-agent
BACKUP_DIR="/var/backups/eagleway-node-agent/$(date -u +%Y%m%d%H%M%S)"
sudo install -d -m 0700 "$BACKUP_DIR"
sudo cp -a /etc/eagleway-node-agent "$BACKUP_DIR/config"
sudo cp -a /var/lib/eagleway-node-agent "$BACKUP_DIR/state"
printf '%s\n' "$BACKUP_DIR"
~~~

备份包含 state.key 和用户加密状态，必须按敏感数据保护。不要在 Agent 正在写 SQLite 时只复制 state.db 单文件。

### 9.3 获取 CI 发布包

为待发布提交创建 `v*` tag，由 Release workflow 生成 x64 和 arm64 包并发布到 GitHub Release。紧急验证也可以手动运行 workflow 并从 Actions run 下载 artifact，但该方式不会创建 GitHub Release，且 artifact 只保留 30 天。

公开仓库无需 deploy key、源码 checkout、pnpm 或开发依赖。确认对应 tag 的 Release workflow 成功后执行：

~~~bash
bash /opt/eagleway-node-agent/current/scripts/deploy-ubuntu-release.sh v0.2.2
~~~

脚本会自动选择本机架构并验证 SHA-256。需要部署指定配置文件时，将其作为第二个参数传入。

### 9.4 创建并切换 release

便捷部署脚本会自动调用 Bootstrap 并切换 release，无需再手工执行解压或 Bootstrap 命令。

如果 bootstrap 在 PM2 切换前失败，可恢复旧 Agent（首次从 0.2.0 升级且新版命令尚未安装时，用原全局 `pm2`）：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent
~~~

如果下载、校验、解压或 bootstrap 失败，也应立即执行上述命令恢复旧 Agent，再处理发布包问题。

### 9.5 发布后检查

~~~bash
readlink -f /opt/eagleway-node-agent/current
sudo -u eagleway-agent -H eagleway-agent-pm2 describe eagleway-node-agent
curl -sS http://127.0.0.1:8086/api/health
sudo systemctl is-active eagleway-xray.service
~~~

随后执行：

- status 应与发布前实际状态一致。
- 已安装协议的 runtimeVersion 不应为 null。
- requiresUserSync 应在用户恢复后变为 false；否则由中心执行完整 sync。
- traffic 应能返回 runtimeEpoch 和用户集合。
- 检查 Agent 和 Xray 日志。
- 从中心执行一次 status。
- 从外部客户端验证代理连接。

历史 release 不会自动删除。至少保留当前和上一个已验证版本，确认稳定后再按明确路径人工清理更旧版本。

### 9.6 Xray-core 升级

0.2.2 固定安装 Xray-core v26.10.29。存量节点先按第 9.3–9.5 节部署新版 Agent，再在维护窗口通过中心 API 卸载协议、重新安装并全量同步用户。仅部署 Agent、重复 install 或 config/apply 都不会升级已安装的核心。

维护期间保持节点启用、中心后台任务正常运行，避免并发控制和用户分配变更；先部署中心的 runtimeEpoch 流量基线修复。以下请求使用中心已有管理员鉴权，安装配置及用户凭据由中心从数据库读取。

1. 调用 `POST /api/v1/manage/nodes/:nodeId/control/uninstall`。等待 Agent 无活动操作、状态为 `not_installed`，且中心节点详情中的 `status` 也变为 `not_installed`；只收到 HTTP 202 不代表卸载完成。
2. 调用 `POST /api/v1/manage/nodes/:nodeId/control/install`。等待安装完成，确认状态为 `online`、无活动操作，且 `runtimeVersion` 包含目标核心版本。
3. 调用 `POST /api/v1/manage/nodes/:nodeId/control/users/sync`。确认全量用户同步成功、`requiresUserSync=false`。
4. 验证用户连接和中心流量入账；原先停止的节点在验证后通过中心 stop 恢复停止状态。

通过 `GET /api/v1/manage/nodes/:nodeId/control/status` 查询 Agent 实际状态，通过 `GET /api/v1/manage/nodes/:nodeId` 查询中心保存的节点状态。卸载重装会中断代理连接，并保留中心的节点配置、用户分配、原凭据和历史流量；失败时修复原因后重试对应步骤。

## 10. 人工回滚

本节回滚 Agent release。需要回退 Xray-core 时，部署固定目标核心版本的 Agent，再按第 9.6 节通过中心 API 卸载、重新安装并同步用户。

仅当旧代码兼容当前 SQLite schema 时执行。若新版本执行了不可逆数据库迁移，必须按该版本的迁移说明处理。以下命令仅适用于具有 `runtime/bin/node`、新版 helper 与随包 PM2 的新格式 release。0.2.0 及之前的 release 会恢复对 `/usr/bin/node` 的依赖，需先用安全运行时重新打包验证，不直接切回旧格式。

列出 release 并明确选择目标，禁止使用模糊通配符：

~~~bash
ls -1dt /opt/eagleway-node-agent/releases/*
PREVIOUS_RELEASE=/opt/eagleway-node-agent/releases/20261022000000-0123456789ab
sudo test -f "$PREVIOUS_RELEASE/ecosystem.config.cjs"
sudo test -f "$PREVIOUS_RELEASE/dist/main.js"
sudo test -x "$PREVIOUS_RELEASE/runtime/bin/node"
sudo test -f "$PREVIOUS_RELEASE/node_modules/pm2/bin/pm2"
sudo -u eagleway-agent -H "$PREVIOUS_RELEASE/runtime/bin/node" -p 'process.versions.node'
~~~

切换：

~~~bash
sudo systemctl stop pm2-eagleway-agent.service
sudo ln -sfn "$PREVIOUS_RELEASE" /opt/eagleway-node-agent/current
sudo ln -sfn /etc/eagleway-node-agent/agent.env "$PREVIOUS_RELEASE/.env"
sudo install -o root -g root -m 0755 "$PREVIOUS_RELEASE/scripts/eagleway-node-helper" /usr/local/libexec/eagleway-node-helper
sudo install -o root -g root -m 0755 "$PREVIOUS_RELEASE/scripts/eagleway-agent-pm2" /usr/local/bin/eagleway-agent-pm2
sudo install -o root -g root -m 0644 "$PREVIOUS_RELEASE/scripts/pm2-eagleway-agent.service" /etc/systemd/system/pm2-eagleway-agent.service
sudo install -o root -g root -m 0440 "$PREVIOUS_RELEASE/scripts/eagleway-node-agent.sudoers" /etc/sudoers.d/eagleway-node-agent
sudo visudo -cf /etc/sudoers.d/eagleway-node-agent
sudo -u eagleway-agent env HOME=/home/eagleway-agent eagleway-agent-pm2 start /opt/eagleway-node-agent/current/ecosystem.config.cjs
sudo -u eagleway-agent env HOME=/home/eagleway-agent eagleway-agent-pm2 save
sudo -u eagleway-agent -H eagleway-agent-pm2 kill
sudo systemctl daemon-reload
sudo systemctl start pm2-eagleway-agent.service
~~~

按第 9.5 节重新验证。只有确认需要且不存在新版本写入后，才考虑停止 Agent 并恢复备份的配置/SQLite；中心是业务事实源，恢复旧 SQLite 后通常还需要中心再次完整同步用户。

## 11. 重启与重启恢复

Agent 重启：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent
~~~

Xray 重启必须通过 Agent API start/stop；不要用 systemctl 绕过 Agent 进行日常控制。紧急排障后如果直接操作过 systemctl，必须再次查询 Agent status 和 traffic。

服务器重启前：

~~~bash
sudo -u eagleway-agent -H eagleway-agent-pm2 save
systemctl is-enabled pm2-eagleway-agent.service
systemctl is-enabled eagleway-xray.service
~~~

服务器恢复后检查 PM2、健康接口、Xray、status、用户数和 runtimeEpoch。Agent 启动时会把未完成操作标为 OPERATION_INTERRUPTED，并尝试根据真实主机状态收敛；中心随后应重新轮询和按 requiresUserSync 决定是否全量同步。

## 12. 常见故障

| 现象/错误 | 首要检查 | 处理方向 |
|---|---|---|
| Agent 无法启动 | PM2 日志、agent.env、state.key 权限 | 修正配置后使用 --update-env 重启 |
| 403 Source IP is not allowed | ALLOWED_CIDRS、请求来源、TRUST_PROXY | 先追加正确 CIDR并验证，避免锁死控制面 |
| NODE_ID_MISMATCH | .env NODE_ID 与中心节点记录 | 修正配置，禁止复用其他节点 ID |
| PORT_IN_USE | ss 检查具体端口 | 更换协议端口或处理占用进程 |
| DNS_NOT_READY | getent/dig 和公网 DNS | 修正 A/AAAA，等待 TTL 生效 |
| CERTIFICATE_UNAVAILABLE | 宝塔证书路径、Eagleway ACME vhost、80 端口公网可达性 | 修复证书或 HTTP-01 条件后重试安装 |
| OPERATION_CONFLICT | status.activeOperation | 等待当前操作结束，不并发修改主机 |
| RUNTIME_UNAVAILABLE | systemctl、journalctl、Xray 配置 | 修复 Xray 后通过 API start |
| OPERATION_FAILED | Agent、Xray、Nginx、Certbot 日志 | 检查下载、校验、证书和 helper |
| traffic.report_failed | 中心 URL、DNS、TLS、中心状态 | 恢复后 Agent 自动退避重试 |
| Xray active 但 status=not_installed | 当前 release、受管标记、运行配置及目录权限 | 核对实际部署与当前 helper 生成的权限，保留日志后按当前部署流程修复 |

Xray 发布包下载采用流式写入，单次下载超时为 10 分钟，并对网络错误、HTTP 408、429 和 5xx 最多尝试 3 次。下载完成后必须通过固定 SHA-256 校验才会进入缓存；失败或超限的临时文件会自动清理。如果仍出现 `Runtime artifact download timed out`，优先检查服务器到 `github.com` 和 `release-assets.githubusercontent.com` 的 DNS、IPv4/IPv6 路由及出口策略。

基础故障采集：

~~~bash
readlink -f /opt/eagleway-node-agent/current
sudo -u eagleway-agent -H eagleway-agent-pm2 describe eagleway-node-agent
sudo -u eagleway-agent -H eagleway-agent-pm2 logs eagleway-node-agent --nostream --lines 200
sudo systemctl status eagleway-xray.service --no-pager -l
sudo journalctl -u eagleway-xray.service -n 200 --no-pager
sudo ss -ltnp
command -v nginx >/dev/null && sudo nginx -t
command -v certbot >/dev/null && sudo certbot certificates
~~~

日志和工单中不得粘贴 credential、私钥、完整 Xray 配置、state.key 或 SQLite 文件。

## 13. 监控与周期维护

建议监控：

- 每分钟检查 Agent 健康接口和 PM2 状态。
- 中心按既定周期轮询 status，并对长期 installing/uninstalling、error 和连续离线告警。
- 已安装节点监控 eagleway-xray.service、协议监听端口和 PM2 restart 次数。
- 对磁盘空间、/var/log/eagleway-node-agent 增长、历史 release 数量和 artifact 缓存告警。
- 对证书剩余 30 天、traffic.report_failed 连续出现和 requiresUserSync 长期为 true 告警。

基础检查：

~~~bash
curl -fsS http://127.0.0.1:8086/api/health
sudo -u eagleway-agent -H eagleway-agent-pm2 status
sudo systemctl is-active eagleway-xray.service
df -h /opt /var /etc
du -sh /opt/eagleway-node-agent/releases /var/lib/eagleway-node-agent /var/log/eagleway-node-agent
~~~

证书检查示例：

~~~bash
sudo openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -subject -issuer -dates
sudo openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -checkend 2592000
systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
~~~

宝塔证书请替换为 /www/server/panel/vhost/cert 下的实际路径。Agent 使用或签发 Certbot 证书时会安装受管 deploy hook；续期成功后，仅当当前 Xray 配置引用该证书 lineage 时才尝试重启运行时。宝塔面板自行管理的证书不经过 Certbot hook，续期成功后仍必须在维护窗口重启 Xray 并验证 TLS，避免进程继续使用旧证书。

当前 bootstrap 也没有安装日志轮转策略。生产环境应由系统 logrotate 管理 /var/log/eagleway-node-agent/*.log，例如：

~~~text
/var/log/eagleway-node-agent/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 eagleway-agent eagleway-agent
    copytruncate
}
~~~

上线前应由运维将经过评审的规则写入 /etc/logrotate.d/eagleway-node-agent，并用 logrotate debug/dry-run 验证。不要未经检查直接删除当前日志或整个日志目录。

## 14. 备份与恢复原则

- 至少备份 /etc/eagleway-node-agent 和 /var/lib/eagleway-node-agent。
- state.key 与 state.db 必须成对保存；丢失 state.key 后无法解密已保存 credential。
- 备份前停止 Agent 或使用 SQLite 在线备份 API，禁止只复制正在写入的 state.db。
- Xray 证书通常位于 /etc/letsencrypt 或宝塔证书目录，由现有证书备份策略负责。
- 中心始终是事实源。SQLite 丢失或重建后，节点必须标记 requiresUserSync，并由中心执行完整 users/sync。
- 恢复后必须验证文件所有者、0600/0640 权限、PM2、status 和用户同步。

## 15. Agent 下线与卸载

节点下线的安全顺序是：

1. 在中心停止新的控制请求和用户分配。
2. 如需留档，备份 agent.env、state.key、SQLite 和日志。
3. 在节点上运行发布包内的卸载脚本。
4. 检查云安全组和 UFW/firewalld 中是否还有该节点的历史控制端口规则。
5. 从中心注销节点。

交互式完整卸载：

~~~bash
sudo bash /opt/eagleway-node-agent/current/scripts/uninstall-ubuntu.sh
~~~

输入 `uninstall` 后，脚本会停止并删除 PM2 进程和 startup unit，通过受限 helper 删除带 Eagleway 所有权标记的 Xray 资源以及 UFW/firewalld 规则，然后删除 helper、sudoers、release、配置、state.key、SQLite、日志和 `eagleway-agent` 用户。脚本可重复执行；如果检测到受管 Xray 标记但可信 helper 已丢失，会停止而不是盲目删除系统资源。

无人值守或保留数据：

~~~bash
sudo bash /opt/eagleway-node-agent/current/scripts/uninstall-ubuntu.sh --yes
sudo bash /opt/eagleway-node-agent/current/scripts/uninstall-ubuntu.sh --keep-data
~~~

`--yes` 跳过交互确认。`--keep-data` 保留 `/etc/eagleway-node-agent`、`/var/lib/eagleway-node-agent`、`/var/log/eagleway-node-agent` 和服务用户，便于审计或恢复；程序、PM2 注册和受管 Xray 仍会移除。卸载脚本不会删除共享 Node.js、全局 PM2、Nginx、Certbot、宝塔、证书或非 Eagleway 网站。Bootstrap 早期版本或配置变更后遗留的防火墙规则可能无法自动识别，仍需执行 `sudo ufw status numbered` 或 `sudo firewall-cmd --list-rich-rules` 人工核对；云安全组规则始终需要在云平台删除。

## 16. 上线验收清单

- [ ] 记录源码 commit、release 路径、nodeId、域名和端口。
- [ ] PM2 单实例 online，重启次数无异常增长。
- [ ] 健康接口正常，控制端口仅中心和 localhost 可访问。
- [ ] 云安全组与 UFW/firewalld 规则一致。
- [ ] install 最终收敛为 online，runtimeVersion 非空。
- [ ] Xray systemd 服务、协议端口和 loopback API 正常。
- [ ] 证书域名正确且有效期满足要求。
- [ ] 全量用户 sync 成功，requiresUserSync=false。
- [ ] 增量 add/delete 和空数组 sync 已验证。
- [ ] stop/start、traffic、日志 API 已验证。
- [ ] uninstall、重复 uninstall 和 reinstall 已在测试节点验证。
- [ ] 中心状态轮询正确收敛。
- [ ] Agent 主动上报在中心确实入账。
- [ ] 外部 Eagleway Network 客户端连接与真实上下行流量正常。
- [ ] Agent/服务器重启后状态和用户恢复正常。
- [ ] 证书续期、续期后 Xray 重启和到期告警已配置。
- [ ] 日志轮转、磁盘和 PM2/Xray 服务告警已配置。
- [ ] 备份、旧 release 和回滚步骤可用。
- [ ] 日志中没有 credential、私钥或完整连接配置。
