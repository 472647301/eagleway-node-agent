# Xray-core 26.10.29 升级与回滚

适用于由 Eagleway 管理的 Ubuntu x64/arm64、Alibaba Cloud Linux 3 x64 节点。目标 Agent 为 0.2.2，固定核心为 [v26.10.29](https://github.com/XTLS/Xray-core/releases/tag/v26.10.29)。本次保持中心 API 契约不变，不提供中心下发核心升级的接口。

新装协议直接安装固定版本。存量节点部署新 Agent 后仍使用原核心；重复 install 和 config/apply 都不会替换二进制。不要通过 uninstall/install 升级生产节点，卸载会删除受管配置和用户映射。

以下是人工维护步骤，当前没有核心升级的自动回滚。先在测试节点演练，再逐批执行。升级会中断代理连接；运行时重启后，用户需要由 Agent 恢复。Agent release 回滚与核心回滚是两个独立操作。

兼容性变化：新核心的 Freedom 出站默认阻止上述三协议访问私网目标（包括 loopback），本项目保留该默认行为。依赖代理访问内网服务的节点需要先评估该变化，不能仅以配置校验成功判断兼容。真实核心测试只在隔离测试配置中放行精确的本机目标地址及端口。另一个变化是客户端 TLS 的 `allowInsecure` 已移除；本项目服务端配置不使用该字段。依据见官方 [Freedom 实现](https://github.com/XTLS/Xray-core/blob/v26.10.29/proxy/freedom/freedom.go)及 [TLS 配置实现](https://github.com/XTLS/Xray-core/blob/v26.10.29/infra/conf/transport_security.go)。

## 1. 准备和候选校验

按[操作手册第 9 节](operations-runbook.md#9-更新与发布)部署并验证 Agent 0.2.2，暂停中心对该节点的控制请求和用户分配。通过 status 确认没有活动操作，记录原状态（online 或 stopped）、runtimeVersion、用户数量、配置 revision 和 runtimeEpoch。若状态为 error 或安装中，先处理故障，不执行下面的替换。

以下命令在同一个 root Bash 会话中执行（`sudo bash`）。先下载和验证候选版本，现有 Xray 此时继续运行。所有备份与候选文件都放在新建的 root 私有目录，记下输出路径供回滚使用。

```bash
set -Eeuo pipefail
umask 077
AGENT_RELEASE="$(readlink -f /opt/eagleway-node-agent/current)"
XRAY_WORK_DIR="$(mktemp -d /var/tmp/eagleway-xray-upgrade.XXXXXXXX)"
printf '核心升级目录：%s\n' "$XRAY_WORK_DIR"
test "$(cat /etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent)" = 'eagleway-node-agent:xray:v1'
test -x /usr/local/bin/xray
test -f /etc/eagleway-node-agent/runtimes/xray/config.json

"$AGENT_RELEASE/runtime/bin/node" - "$AGENT_RELEASE" "$XRAY_WORK_DIR/xray.zip" <<'NODE'
const { join } = require('node:path')
const [release, target] = process.argv.slice(2)
const { xrayRelease, xrayArtifact } = require(join(release, 'dist/host/xray-release'))
const { downloadVerifiedArtifact } = require(join(release, 'dist/host/artifact-downloader'))
if (xrayRelease.version !== 'v26.10.29' ||
    process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Unexpected release or platform')
}
const artifact = xrayArtifact(process.arch)
downloadVerifiedArtifact({
  url: artifact.url, target, expectedHash: artifact.sha256,
  timeoutMs: 10 * 60 * 1000, maxBytes: 128 * 1024 * 1024
}).catch((error) => { console.error(error); process.exitCode = 1 })
NODE

mkdir "$XRAY_WORK_DIR/candidate"
unzip -q "$XRAY_WORK_DIR/xray.zip" xray -d "$XRAY_WORK_DIR/candidate"
chmod 0755 "$XRAY_WORK_DIR/candidate/xray"
"$XRAY_WORK_DIR/candidate/xray" version
test "$("$XRAY_WORK_DIR/candidate/xray" version | awk '/^Xray / {print $2; exit}')" = '26.10.29'
"$XRAY_WORK_DIR/candidate/xray" run -test -config /etc/eagleway-node-agent/runtimes/xray/config.json
```

下载、SHA-256、版本或配置校验任一失败即停止，原二进制不变。校验通过也不代表 gRPC、用户与公网流量已通过，仍须执行后续验收。

## 2. 停止与备份

原状态为 online 时，先让中心完成最后一轮流量采集与入账，再通过现有 `/api/{protocol}/stop` 停止 Xray，查询 status 确认 stopped。原状态为 stopped 时保持停止。调用方法与 nodeId 见[操作手册第 7 节](operations-runbook.md)。停止到切换期间继续暂停中心控制，避免其他请求启动运行时。不要只保存 `/traffic` 响应就假定中心已经入账。

接着停止 Agent，备份配置、state.key 与完整状态目录；不要在 Agent 写入期间只复制 state.db。

```bash
sudo -u eagleway-agent -H eagleway-agent-pm2 stop eagleway-node-agent
test "$(systemctl show --property=ActiveState --value eagleway-xray.service)" = inactive
mkdir "$XRAY_WORK_DIR/backup"
cp -a /usr/local/bin/xray "$XRAY_WORK_DIR/backup/xray.previous"
cp -a /etc/eagleway-node-agent "$XRAY_WORK_DIR/backup/config"
cp -a /var/lib/eagleway-node-agent "$XRAY_WORK_DIR/backup/state"
cp -a /etc/systemd/system/eagleway-xray.service "$XRAY_WORK_DIR/backup/eagleway-xray.service"
"$XRAY_WORK_DIR/backup/xray.previous" version > "$XRAY_WORK_DIR/backup/version.txt"
```

确认停止状态和备份完成后再替换。若备份失败，保留旧核心，恢复 Agent；原先在线的节点通过 start 恢复运行和用户。

## 3. 替换、恢复与验收

在目标目录内暂存并原子重命名，只替换核心文件，配置、证书、SQLite 与 systemd unit 保持原样。

```bash
XRAY_NEXT="$(mktemp /usr/local/bin/.eagleway-xray.XXXXXXXX)"
install -o root -g root -m 0755 "$XRAY_WORK_DIR/candidate/xray" "$XRAY_NEXT"
mv -fT "$XRAY_NEXT" /usr/local/bin/xray
/usr/local/bin/xray version
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent
```

原先在线的节点通过 `/api/{protocol}/start` 启动并恢复 SQLite 中的用户；原先停止的节点保持停止，不为升级擅自开启服务。如果 `requiresUserSync=true`，中心按事实源执行 `/api/{protocol}/user/sync` 完整同步，包括期望集合为空的情况。确认响应中每个用户均成功，不能只检查 HTTP 200。

恢复中心控制前核对：

- `status.runtimeVersion` 含 `26.10.29`，运行状态与升级前一致，配置 revision 不变。
- 在线节点的 `requiresUserSync=false`，用户集合与中心一致，实际客户端可完成 TLS 代理连接。
- 在线节点的 traffic、在线人数与实际上下行字节正常；重启后 runtimeEpoch 改变，中心正确处理计数器重置，避免重复或漏计。
- systemd、协议监听端口、loopback gRPC 与 Agent/Xray 日志正常；停止节点仍为 stopped。

保存新旧 Agent/core 版本、架构、校验值、验证结果与升级目录。至少保留旧核心和备份至灰度验收完成；目录包含密钥及加密用户状态，不应上传或公开。

## 4. 核心回滚

新版启动、用户恢复或真实连接验证失败时，继续暂停中心控制。若 Agent 可用，先通过 stop 停止核心；无法正常控制时，紧急使用 `systemctl stop eagleway-xray.service`，随后停止 Agent 并核对核心已停止。

在 root Bash 中将 `XRAY_WORK_DIR` 设为本次维护记录中的确切路径，执行：

```bash
test -x "$XRAY_WORK_DIR/backup/xray.previous"
sudo -u eagleway-agent -H eagleway-agent-pm2 stop eagleway-node-agent
systemctl stop eagleway-xray.service
"$XRAY_WORK_DIR/backup/xray.previous" run -test -config /etc/eagleway-node-agent/runtimes/xray/config.json
XRAY_ROLLBACK="$(mktemp /usr/local/bin/.eagleway-xray-rollback.XXXXXXXX)"
install -o root -g root -m 0755 "$XRAY_WORK_DIR/backup/xray.previous" "$XRAY_ROLLBACK"
mv -fT "$XRAY_ROLLBACK" /usr/local/bin/xray
/usr/local/bin/xray version
sudo -u eagleway-agent -H eagleway-agent-pm2 restart eagleway-node-agent
```

按原状态通过 Agent start 恢复在线节点和用户，再复查状态、流量及公网连接。上述升级未改配置与数据库，通常无需恢复它们；不要直接用旧 SQLite 覆盖维护后产生的新数据。只有确认配置/状态已损坏时，才按操作手册的备份恢复流程处理，并由中心重新同步用户。单独回滚 Agent 的 current 软链接不会恢复旧核心。
