# Eagleway Node Agent 运维与服务器自测手册

状态：MVP Runbook  
更新时间：2026-09-08

本文面向负责 Eagleway Network 节点服务器的基础运维人员，描述当前版本可以实际执行的部署、验证、升级、回滚和故障定位流程。接口字段的权威定义仍以 [节点 API 契约](node-api-contract.md) 为准。

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
- 第一阶段只支持 Ubuntu 和 Ubuntu + 宝塔 Nginx，不支持 CentOS/RHEL、宝塔 Apache、Shadowsocks 和 443 SNI 多路复用。
- 第一阶段没有 HMAC/JWT 节点鉴权，控制面依赖中心固定出口 IP 白名单、云安全组和主机防火墙。

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

- Ubuntu x64 或 arm64，systemd 正常运行。
- root 或 sudo 权限。
- 能访问系统 apt 源、npm 源和 XTLS GitHub Release。
- 域名具有 A 或 AAAA 记录。
- 云安全组按需放行 TCP 80、Agent 控制端口和协议端口。
- Agent 控制端口只允许中心出口 IP，不得对整个公网开放。
- 普通 Ubuntu 首次签发证书时需要 TCP 80；已有可复用证书时可跳过签发。
- 宝塔环境必须先在宝塔签发目标域名证书。
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

Bootstrap 默认读取源码仓库根目录的 .env，并把验证后的文件安装到 /etc/eagleway-node-agent/agent.env。它不会以 root 身份 source .env，也不会把 .env 复制进 release。

首次部署：

~~~bash
cd /home/eagleway-node-agent
cp .env.example .env
nano .env
~~~

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
SERVER_BANDWIDTH_MBPS=1000
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

- NODE_ID、PORT、ALLOWED_CIDRS、REPORTING_ENABLED 和 SERVER_BANDWIDTH_MBPS 是 bootstrap 必填项。
- REPORTING_ENABLED=true 时 CENTER_API_URL 必填。
- 必须保留 127.0.0.1/32，才能在服务器本机执行本文的 curl 自测。
- STATE_DIR、STATE_KEY_PATH、LOG_DIR、XRAY_BINARY 和 PRIVILEGED_HELPER 如果显式配置，必须使用项目固定路径。
- 修改 /etc 下的运行配置只能作为应急操作；下次 bootstrap 会用源码目录 .env 覆盖它，因此最终修改必须回写源码目录 .env。
- 中心出口 IP 变化时，先追加新 CIDR并验证，再删除旧 CIDR。
- Bootstrap 只新增当前 CIDR 对应的 UFW allow 规则，不会自动删除历史规则；确认新来源可用后需要人工清理旧规则。

## 5. 首次部署

在仓库根目录执行：

~~~bash
sudo ./scripts/bootstrap-ubuntu.sh
~~~

从其他目录执行时，可以显式给出源码目录：

~~~bash
sudo ./scripts/bootstrap-ubuntu.sh /home/eagleway-node-agent
~~~

Bootstrap 会安装依赖、Node.js 22、pnpm 11.22.0 和 PM2 6，创建低权限用户，构建不可变 release，安装 helper 和 sudo 规则，注册 PM2 开机启动并启动 Agent。重复执行会产生新的 release，不会删除 SQLite、state.key、证书或 Xray 用户状态。

部署后立即检查：

~~~bash
readlink -f /opt/eagleway-node-agent/current
sudo -u eagleway-agent -H pm2 status
sudo -u eagleway-agent -H pm2 describe eagleway-node-agent
curl -sS http://127.0.0.1:8086/api/health
sudo -u eagleway-agent -H sudo -n -l
~~~

期望：

- PM2 状态为 online、exec mode 为 fork、instances 为 1。
- 健康接口返回 code=0 和 status=ok。
- sudo 列表只包含 eagleway-node-helper 的固定动作。

## 6. 运维命令速查

仅重启 Agent，不发布新源码：

~~~bash
sudo -u eagleway-agent -H pm2 restart eagleway-node-agent
~~~

修改了 /etc/eagleway-node-agent/agent.env 后重载环境：

~~~bash
sudo -u eagleway-agent -H pm2 restart eagleway-node-agent --update-env
~~~

查看状态和日志：

~~~bash
sudo -u eagleway-agent -H pm2 status
sudo -u eagleway-agent -H pm2 logs eagleway-node-agent --nostream --lines 200
sudo journalctl -u eagleway-xray.service -n 200 --no-pager
~~~

检查端口和服务：

~~~bash
sudo systemctl status eagleway-xray.service --no-pager
sudo ss -ltnp
sudo nginx -t
sudo certbot certificates
~~~

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
- uploadBytes 和 downloadBytes 是十进制字符串，不是 JSON number。
- 本机没有真实代理请求时，计数为 0 是正常的。

要验证计数增长，必须从外部客户端使用同步后的 credential 建立真实 Trojan/VLESS/VMess 连接并产生上下行流量，然后再次查询。

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
2. 云安全组和 UFW 只对该出口 IP 开放 Agent 控制端口。
3. 设置 CENTER_API_URL 和 REPORTING_ENABLED=true。
4. 重新运行 bootstrap，或同步修改源码 .env 与 /etc 配置后使用 --update-env 重启。
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

## 9. 源码更新与发布

当前项目没有远程自更新服务。bootstrap 同时承担首次安装和从源码构建新 release 的职责；它不是零停机发布工具，应在维护窗口执行。

### 9.1 发布前

1. 暂停中心对该节点的 install/uninstall/start/stop 和用户修改。
2. 查询 status，确认 activeOperation 为 null。
3. 记录当前 release 和 Git 提交。

~~~bash
readlink -f /opt/eagleway-node-agent/current
cd /home/eagleway-node-agent
git rev-parse HEAD
git status --short
~~~

如果 git status 显示非预期源码修改，停止发布，不要使用 git reset --hard 覆盖现场。

### 9.2 备份

确认没有活动操作后停止 Agent。Xray systemd 服务会继续承载已有代理流量，但维护期间中心不能控制节点。

~~~bash
sudo -u eagleway-agent -H pm2 stop eagleway-node-agent
BACKUP_DIR="/var/backups/eagleway-node-agent/$(date -u +%Y%m%d%H%M%S)"
sudo install -d -m 0700 "$BACKUP_DIR"
sudo cp -a /etc/eagleway-node-agent "$BACKUP_DIR/config"
sudo cp -a /var/lib/eagleway-node-agent "$BACKUP_DIR/state"
printf '%s\n' "$BACKUP_DIR"
~~~

备份包含 state.key 和用户加密状态，必须按敏感数据保护。不要在 Agent 正在写 SQLite 时只复制 state.db 单文件。

### 9.3 更新私有仓库

服务器应预先配置只读 deploy key 或受限凭证：

~~~bash
cd /home/eagleway-node-agent
git fetch --prune origin
git status --short
git pull --ff-only
git rev-parse HEAD
~~~

.env 已被 .gitignore 忽略，正常 git pull 不会覆盖它。不要把私钥、访问令牌或 .env 提交到仓库。

在源码目录执行发布前验证：

~~~bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install --frozen-lockfile
pnpm verify
~~~

### 9.4 创建并切换 release

~~~bash
sudo ./scripts/bootstrap-ubuntu.sh
~~~

如果 bootstrap 在 PM2 切换前失败，可恢复旧 Agent：

~~~bash
sudo -u eagleway-agent -H pm2 restart eagleway-node-agent
~~~

如果 git 更新、依赖安装或 verify 在执行 bootstrap 之前失败，也应立即执行上述命令恢复旧 Agent，再处理源码问题。

### 9.5 发布后检查

~~~bash
readlink -f /opt/eagleway-node-agent/current
sudo -u eagleway-agent -H pm2 describe eagleway-node-agent
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

## 10. 人工回滚

仅当旧代码兼容当前 SQLite schema 时执行。若新版本执行了不可逆数据库迁移，必须按该版本的迁移说明处理。

列出 release 并明确选择目标，禁止使用模糊通配符：

~~~bash
ls -1dt /opt/eagleway-node-agent/releases/*
PREVIOUS_RELEASE=/opt/eagleway-node-agent/releases/20260908054133
sudo test -f "$PREVIOUS_RELEASE/ecosystem.config.cjs"
sudo test -f "$PREVIOUS_RELEASE/dist/main.js"
~~~

切换：

~~~bash
sudo -u eagleway-agent -H pm2 delete eagleway-node-agent
sudo ln -sfn "$PREVIOUS_RELEASE" /opt/eagleway-node-agent/current
sudo ln -sfn /etc/eagleway-node-agent/agent.env "$PREVIOUS_RELEASE/.env"
sudo install -o root -g root -m 0755 "$PREVIOUS_RELEASE/scripts/eagleway-node-helper" /usr/local/libexec/eagleway-node-helper
sudo install -o root -g root -m 0440 "$PREVIOUS_RELEASE/scripts/eagleway-node-agent.sudoers" /etc/sudoers.d/eagleway-node-agent
sudo visudo -cf /etc/sudoers.d/eagleway-node-agent
sudo -u eagleway-agent env HOME=/home/eagleway-agent pm2 start /opt/eagleway-node-agent/current/ecosystem.config.cjs
sudo -u eagleway-agent env HOME=/home/eagleway-agent pm2 save
~~~

按第 9.5 节重新验证。只有确认需要且不存在新版本写入后，才考虑停止 Agent 并恢复备份的配置/SQLite；中心是业务事实源，恢复旧 SQLite 后通常还需要中心再次完整同步用户。

## 11. 重启与重启恢复

Agent 重启：

~~~bash
sudo -u eagleway-agent -H pm2 restart eagleway-node-agent
~~~

Xray 重启必须通过 Agent API start/stop；不要用 systemctl 绕过 Agent 进行日常控制。紧急排障后如果直接操作过 systemctl，必须再次查询 Agent status 和 traffic。

服务器重启前：

~~~bash
sudo -u eagleway-agent -H pm2 save
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
| 旧版错误只写 Requested protocol port | 同时检查目标端口和 80 | 更新 Agent；无证书时 80 也会被预检 |
| DNS_NOT_READY | getent/dig 和公网 DNS | 修正 A/AAAA，等待 TTL 生效 |
| CERTIFICATE_UNAVAILABLE | 宝塔证书路径和有效期 | 先在宝塔签发匹配域名证书 |
| OPERATION_CONFLICT | status.activeOperation | 等待当前操作结束，不并发修改主机 |
| RUNTIME_UNAVAILABLE | systemctl、journalctl、Xray 配置 | 修复 Xray 后通过 API start |
| OPERATION_FAILED | Agent、Xray、Nginx、Certbot 日志 | 检查下载、校验、证书和 helper |
| traffic.report_failed | 中心 URL、DNS、TLS、中心状态 | 恢复后 Agent 自动退避重试 |
| Xray active 但 status=not_installed | 运行时目录和所有权标记权限 | 使用下方旧版本修复并更新 Agent |

旧 release 的运行时目录权限修复：

~~~bash
sudo chmod 0711 /etc/eagleway-node-agent/runtimes
sudo chmod 0711 /etc/eagleway-node-agent/runtimes/xray
sudo -u eagleway-agent test -e /etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent && echo 'ownership marker: visible'
~~~

该操作只增加目录穿越权限；agent.env 的父目录仍限制其他用户，Xray config 和 marker 文件仍保持 0600。修复后无需重启即可重新查询 status。

基础故障采集：

~~~bash
readlink -f /opt/eagleway-node-agent/current
sudo -u eagleway-agent -H pm2 describe eagleway-node-agent
sudo -u eagleway-agent -H pm2 logs eagleway-node-agent --nostream --lines 200
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
sudo -u eagleway-agent -H pm2 status
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

宝塔证书请替换为 /www/server/panel/vhost/cert 下的实际路径。Xray 在启动时加载证书；当前项目没有在证书续期后自动重启 Xray，续期成功后必须在维护窗口重启运行时并验证 TLS，避免进程继续使用旧证书。

当前 bootstrap 也没有安装日志轮转策略。生产环境应由系统 logrotate 管理 /var/log/eagleway-node-agent/*.log，例如：

~~~text
/var/log/eagleway-node-agent/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
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

## 15. Agent 下线边界

当前没有正式的 Agent decommission 脚本。节点下线的安全顺序是：

1. 在中心停止新的控制请求和用户分配。
2. 调用协议 uninstall 并等待 not_installed。
3. 验证 Eagleway 自有 Xray unit、二进制和配置已删除。
4. 备份或按数据保留策略处理 agent.env、state.key、SQLite 和日志。
5. 再人工删除 PM2 进程、PM2 startup、helper、sudoers、Agent release、状态目录和 eagleway-agent 用户。
6. 人工删除云安全组和 UFW 中该节点的控制端口规则。
7. 从中心注销节点。

不要自动删除共享 Node.js、PM2、Nginx、Certbot、宝塔、证书或非 Eagleway 网站。正式批量下线前应先实现并评审专用 decommission 脚本。

## 16. 上线验收清单

- [ ] 记录源码 commit、release 路径、nodeId、域名和端口。
- [ ] PM2 单实例 online，重启次数无异常增长。
- [ ] 健康接口正常，控制端口仅中心和 localhost 可访问。
- [ ] 云安全组与 UFW 规则一致。
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
