#!/bin/bash
set -Eeuo pipefail

readonly AGENT_USER="eagleway-agent"
readonly AGENT_HOME="/home/${AGENT_USER}"
readonly INSTALL_ROOT="/opt/eagleway-node-agent"
readonly CONFIG_ROOT="/etc/eagleway-node-agent"
readonly STATE_ROOT="/var/lib/eagleway-node-agent"
readonly LOG_ROOT="/var/log/eagleway-node-agent"
readonly AGENT_FIREWALL_ZONE_FILE="${CONFIG_ROOT}/agent-firewall-zone"
readonly APT_LOCK_TIMEOUT_SECONDS=600

run_apt_get() {
  echo "Running apt-get; waiting up to ${APT_LOCK_TIMEOUT_SECONDS}s for package manager locks..."
  apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

run_dnf() {
  echo "Running dnf..."
  dnf "$@"
}

ensure_epel_repository() {
  if rpm -q epel-aliyuncs-release >/dev/null 2>&1 \
    || rpm -q epel-release >/dev/null 2>&1; then
    return
  fi

  if dnf --quiet list --available epel-aliyuncs-release >/dev/null 2>&1; then
    run_dnf install -y epel-aliyuncs-release
  else
    run_dnf install -y epel-release
  fi
}

usage() {
  echo "Usage: sudo $0 [release-directory] [env-file] [--node-bin /absolute/path/node]" >&2
  exit 2
}

[[ "${EUID}" -eq 0 ]] || { echo "Bootstrap must run as root" >&2; exit 1; }
NODE_BIN_INPUT="$(command -v node || true)"
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-bin)
      [[ $# -ge 2 && "$2" == /* ]] || usage
      NODE_BIN_INPUT="$2"
      shift 2
      ;;
    -*) usage ;;
    *) POSITIONAL_ARGS+=("$1"); shift ;;
  esac
done
[[ ${#POSITIONAL_ARGS[@]} -le 2 ]] || usage
set -- "${POSITIONAL_ARGS[@]}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=node-runtime.sh
. "${SCRIPT_DIR}/node-runtime.sh"
RELEASE_SOURCE_DIR="$(realpath "${1:-${SCRIPT_DIR}/..}")"
ENV_FILE_INPUT="${2:-${RELEASE_SOURCE_DIR}/.env}"
[[ -f "${ENV_FILE_INPUT}" ]] || { echo "Missing environment file: ${ENV_FILE_INPUT}" >&2; exit 1; }
ENV_FILE="$(realpath "${ENV_FILE_INPUT}")"
RELEASE_MANIFEST="${RELEASE_SOURCE_DIR}/release-manifest.json"

env_value() {
  local key="$1"
  local line
  local value
  line="$(awk -v key="${key}" '
    {
      sub(/\r$/, "")
      if ($0 ~ "^[[:space:]]*" key "[[:space:]]*=") value = $0
    }
    END {
      if (value == "") exit 1
      print value
    }
  ' "${ENV_FILE}")" || return 1
  value="${line#*=}"
  value="$(printf '%s' "${value}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "${value}"
}

required_env() {
  local key="$1"
  local value
  if ! value="$(env_value "${key}")" || [[ -z "${value}" ]]; then
    echo "${ENV_FILE}: ${key} is required" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

assert_fixed_env() {
  local key="$1"
  local expected="$2"
  local value
  if value="$(env_value "${key}")" && [[ "${value}" != "${expected}" ]]; then
    echo "${ENV_FILE}: ${key} must be ${expected}" >&2
    exit 1
  fi
}

RUNTIME_ENV="$(required_env NODE_ENV)"
AGENT_PORT="$(required_env PORT)"
NODE_ID="$(required_env NODE_ID)"
ALLOWED_CIDRS="$(required_env ALLOWED_CIDRS)"
REPORTING_ENABLED="$(required_env REPORTING_ENABLED)"
CENTER_API_URL="$(env_value CENTER_API_URL || true)"

[[ -f /etc/os-release ]] || { echo "Missing /etc/os-release" >&2; exit 1; }
. /etc/os-release
case "${ID:-}" in
  ubuntu)
    OS_FAMILY="ubuntu"
    ;;
  alinux)
    [[ "${VERSION_ID:-}" == "3" ]] || {
      echo "Only Alibaba Cloud Linux 3 is supported" >&2
      exit 1
    }
    [[ "$(uname -m)" == "x86_64" ]] || {
      echo "Alibaba Cloud Linux 3 is supported only on x86_64" >&2
      exit 1
    }
    OS_FAMILY="alinux"
    ;;
  *)
    echo "Only Ubuntu and Alibaba Cloud Linux 3 are supported" >&2
    exit 1
    ;;
esac
[[ -f "${RELEASE_MANIFEST}" \
  && -f "${RELEASE_SOURCE_DIR}/package.json" \
  && -f "${RELEASE_SOURCE_DIR}/dist/main.js" \
  && -f "${RELEASE_SOURCE_DIR}/dist/helper.js" \
  && -f "${RELEASE_SOURCE_DIR}/ecosystem.config.cjs" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/deploy-ubuntu-release.sh" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/uninstall-ubuntu.sh" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/node-runtime.sh" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/eagleway-agent-pm2" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/pm2-eagleway-agent.service" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/eagleway-node-helper" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/eagleway-node-agent.sudoers" \
  && -f "${RELEASE_SOURCE_DIR}/node_modules/pm2/bin/pm2" ]] || {
  echo "Release directory is incomplete; use a CI-built Eagleway release artifact" >&2
  exit 1
}
[[ "${RUNTIME_ENV}" == "production" ]] || { echo "NODE_ENV must be production" >&2; exit 1; }
[[ "${NODE_ID}" =~ ^[1-9][0-9]*$ ]] || { echo "NODE_ID is invalid" >&2; exit 1; }
[[ "${AGENT_PORT}" =~ ^[0-9]+$ ]] && (( AGENT_PORT >= 1 && AGENT_PORT <= 65535 )) || {
  echo "PORT is invalid" >&2
  exit 1
}
[[ "${REPORTING_ENABLED}" == "true" || "${REPORTING_ENABLED}" == "false" ]] || {
  echo "REPORTING_ENABLED must be true or false" >&2
  exit 1
}
if [[ "${REPORTING_ENABLED}" == "true" && -z "${CENTER_API_URL}" ]]; then
  echo "CENTER_API_URL is required when REPORTING_ENABLED=true" >&2
  exit 1
fi
assert_fixed_env STATE_DIR "${STATE_ROOT}"
assert_fixed_env STATE_KEY_PATH "${CONFIG_ROOT}/state.key"
assert_fixed_env LOG_DIR "${LOG_ROOT}"
assert_fixed_env XRAY_BINARY /usr/local/bin/xray
assert_fixed_env PRIVILEGED_HELPER /usr/local/libexec/eagleway-node-helper

if [[ "${OS_FAMILY}" == "ubuntu" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  run_apt_get update
  run_apt_get install -y --no-install-recommends ca-certificates curl rsync sudo unzip xz-utils
else
  run_dnf install -y ca-certificates curl rsync shadow-utils sudo unzip util-linux xz
  ensure_epel_repository
fi

case "$(uname -m)" in
  x86_64) RELEASE_ARCH=x64 ;;
  aarch64 | arm64) RELEASE_ARCH=arm64 ;;
  *) echo "Unsupported CPU architecture" >&2; exit 1 ;;
esac
# Refuse an existing writable installation before placing root-executed files in it.
TRUSTED_PARENT="${INSTALL_ROOT}"
while [[ ! -e "${TRUSTED_PARENT}" && ! -L "${TRUSTED_PARENT}" ]]; do
  TRUSTED_PARENT="$(dirname -- "${TRUSTED_PARENT}")"
done
trusted_path_chain "${TRUSTED_PARENT}" || {
  echo "Installation path must be root-owned and not writable by other users: ${TRUSTED_PARENT}" >&2
  exit 1
}
trusted_path_chain "$(realpath -e -- "${TRUSTED_PARENT}")" || exit 1
if [[ -e "${INSTALL_ROOT}/runtimes" || -L "${INSTALL_ROOT}/runtimes" ]]; then
  trusted_path_chain "${INSTALL_ROOT}/runtimes" || exit 1
  trusted_path_chain "$(realpath -e -- "${INSTALL_ROOT}/runtimes")" || exit 1
fi
if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "${AGENT_USER}"
fi
select_node_runtime "${NODE_BIN_INPUT}" "${INSTALL_ROOT}" "${RELEASE_ARCH}" "${AGENT_USER}"

RELEASE_COMMIT="$(RELEASE_MANIFEST="${RELEASE_MANIFEST}" MIN_NODE_VERSION="${EAGLEWAY_NODE_MIN_VERSION}" "${NODE_BIN}" -e '
  const fs = require("node:fs")
  const manifest = JSON.parse(fs.readFileSync(process.env.RELEASE_MANIFEST, "utf8"))
  const nodeMajor = Number(process.versions.node.split(".")[0])
  if (manifest.formatVersion !== 2) throw new Error("Unsupported release manifest format")
  if (manifest.packageName !== "@eagleway/node-agent") throw new Error("Unexpected package name")
  if (manifest.platform !== process.platform) throw new Error(`Release platform ${manifest.platform} does not match ${process.platform}`)
  if (manifest.arch !== process.arch) throw new Error(`Release architecture ${manifest.arch} does not match ${process.arch}`)
  if (manifest.nodeMajor !== nodeMajor) throw new Error(`Release Node.js ${manifest.nodeMajor} does not match ${nodeMajor}`)
  if (manifest.nodeModuleVersion !== process.versions.modules) throw new Error("Release native module ABI does not match Node.js")
  if (manifest.minNodeVersion !== process.env.MIN_NODE_VERSION) throw new Error("Unexpected minimum Node.js version")
  const current = process.versions.node.split(".").map(Number)
  const minimum = manifest.minNodeVersion.split(".").map(Number)
  if (current[1] < minimum[1] || (current[1] === minimum[1] && current[2] < minimum[2])) throw new Error("Node.js is below the release minimum")
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("Invalid release commit")
  process.stdout.write(manifest.commit)
')"

install -d -o root -g root -m 0755 "${INSTALL_ROOT}/releases"
install -d -o root -g "${AGENT_USER}" -m 0750 "${CONFIG_ROOT}"
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0700 "${STATE_ROOT}"
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0750 "${LOG_ROOT}"

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${RELEASE_COMMIT:0:12}"
RELEASE_DIR="${INSTALL_ROOT}/releases/${RELEASE_ID}"
install -d -o root -g root -m 0755 "${RELEASE_DIR}"
RSYNC_EXCLUDES=(--exclude=/.env)
if [[ "${ENV_FILE}" == "${RELEASE_SOURCE_DIR}/"* ]]; then
  RSYNC_EXCLUDES+=(--exclude="/${ENV_FILE#"${RELEASE_SOURCE_DIR}/"}")
fi
rsync -a --delete "${RSYNC_EXCLUDES[@]}" \
  "${RELEASE_SOURCE_DIR}/" "${RELEASE_DIR}/"
chown -R root:root "${RELEASE_DIR}"
chmod -R go-w "${RELEASE_DIR}"
install -d -o root -g root -m 0755 "${RELEASE_DIR}/runtime/bin"
ln -s "${NODE_BIN}" "${RELEASE_DIR}/runtime/bin/node"
NODE_BIN="${NODE_BIN}" RELEASE_DIR="${RELEASE_DIR}" "${NODE_BIN}" -e '
  const fs = require("node:fs")
  fs.writeFileSync(`${process.env.RELEASE_DIR}/runtime/node.json`, JSON.stringify({
    nodePath: process.env.NODE_BIN,
    nodeVersion: process.versions.node,
    nodeModuleVersion: process.versions.modules
  }, null, 2) + "\n")
'
RELEASE_NODE="${RELEASE_DIR}/runtime/bin/node"
PM2_CLI="${RELEASE_DIR}/node_modules/pm2/bin/pm2"
"${RELEASE_NODE}" -e 'if (require(process.argv[1]).version !== "7.1.0") throw new Error("Unexpected bundled PM2 version")' \
  "${RELEASE_DIR}/node_modules/pm2/package.json"

(
  cd "${RELEASE_DIR}"
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" \
    "${RELEASE_NODE}" -e "const Database = require('better-sqlite3'); new Database(':memory:').close()"
)

(
  cd "${RELEASE_DIR}"
  env -i PATH="${PATH}" DOTENV_CONFIG_PATH="${ENV_FILE}" \
    "${RELEASE_NODE}" -e "require('./dist/config/app-config').loadAppConfig()"
)

# Stop the old daemon too: replacing Node on disk does not update a running PM2.
if systemctl cat pm2-eagleway-agent.service >/dev/null 2>&1; then
  systemctl stop pm2-eagleway-agent.service
fi
(
  cd "${AGENT_HOME}"
  runuser -u "${AGENT_USER}" -- env -i HOME="${AGENT_HOME}" \
    PM2_HOME="${AGENT_HOME}/.pm2" PATH="${RELEASE_DIR}/runtime/bin:${PATH}" \
    "${RELEASE_NODE}" "${PM2_CLI}" kill
)
ln -sfn "${RELEASE_DIR}" "${INSTALL_ROOT}/current"
install -o root -g root -m 0755 \
  "${RELEASE_DIR}/scripts/eagleway-agent-pm2" /usr/local/bin/eagleway-agent-pm2
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 \
  "${RELEASE_DIR}/scripts/eagleway-node-helper" \
  /usr/local/libexec/eagleway-node-helper
/usr/local/libexec/eagleway-node-helper xray-prepare-logs
install -o root -g root -m 0440 \
  "${RELEASE_DIR}/scripts/eagleway-node-agent.sudoers" \
  /etc/sudoers.d/eagleway-node-agent
visudo -cf /etc/sudoers.d/eagleway-node-agent

install -o root -g "${AGENT_USER}" -m 0640 \
  "${ENV_FILE}" "${CONFIG_ROOT}/agent.env"
if [[ ! -f "${CONFIG_ROOT}/state.key" ]]; then
  dd if=/dev/urandom of="${CONFIG_ROOT}/state.key" bs=32 count=1 status=none
fi
chown "${AGENT_USER}:${AGENT_USER}" "${CONFIG_ROOT}/state.key"
chmod 0600 "${CONFIG_ROOT}/state.key"
ln -sfn "${CONFIG_ROOT}/agent.env" "${INSTALL_ROOT}/current/.env"

(
  # PM2 inherits cwd when spawning its daemon; use a service-user-accessible directory.
  cd "${AGENT_HOME}"
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" \
    /usr/local/bin/eagleway-agent-pm2 start "${INSTALL_ROOT}/current/ecosystem.config.cjs"
  runuser -u "${AGENT_USER}" -- /usr/local/bin/eagleway-agent-pm2 save --force
  runuser -u "${AGENT_USER}" -- /usr/local/bin/eagleway-agent-pm2 kill
)
install -o root -g root -m 0644 "${RELEASE_DIR}/scripts/pm2-eagleway-agent.service" \
  /etc/systemd/system/pm2-eagleway-agent.service
systemctl daemon-reload
systemctl enable pm2-eagleway-agent.service
systemctl start pm2-eagleway-agent.service
systemctl is-active --quiet pm2-eagleway-agent.service

UFW_ACTIVE=false
FIREWALLD_ACTIVE=false
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  UFW_ACTIVE=true
fi
if command -v firewall-cmd >/dev/null 2>&1 \
  && systemctl is-active --quiet firewalld; then
  FIREWALLD_ACTIVE=true
fi
if [[ "${UFW_ACTIVE}" == "true" && "${FIREWALLD_ACTIVE}" == "true" ]]; then
  echo "Multiple supported host firewalls are active" >&2
  exit 1
fi
if [[ "${UFW_ACTIVE}" == "true" ]]; then
  IFS=',' read -ra CIDRS <<< "${ALLOWED_CIDRS}"
  for cidr in "${CIDRS[@]}"; do
    cidr="$(printf '%s' "${cidr}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "${cidr}" ]] || continue
    ufw allow from "${cidr}" to any port "${AGENT_PORT}" proto tcp
  done
elif [[ "${FIREWALLD_ACTIVE}" == "true" ]]; then
  FIREWALL_ZONE="$(firewall-cmd --get-default-zone)"
  [[ "${FIREWALL_ZONE}" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "firewalld returned an invalid default zone" >&2
    exit 1
  }
  printf '%s\n' "${FIREWALL_ZONE}" > "${AGENT_FIREWALL_ZONE_FILE}"
  chown root:root "${AGENT_FIREWALL_ZONE_FILE}"
  chmod 0600 "${AGENT_FIREWALL_ZONE_FILE}"
  IFS=',' read -ra CIDRS <<< "${ALLOWED_CIDRS}"
  for cidr in "${CIDRS[@]}"; do
    cidr="$(printf '%s' "${cidr}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "${cidr}" ]] || continue
    if [[ "${cidr}" == *:* ]]; then
      FIREWALL_FAMILY="ipv6"
    else
      FIREWALL_FAMILY="ipv4"
    fi
    FIREWALL_RULE="rule family=\"${FIREWALL_FAMILY}\" source address=\"${cidr}\" port port=\"${AGENT_PORT}\" protocol=\"tcp\" accept"
    if ! firewall-cmd --zone="${FIREWALL_ZONE}" --query-rich-rule="${FIREWALL_RULE}" >/dev/null; then
      firewall-cmd --zone="${FIREWALL_ZONE}" --add-rich-rule="${FIREWALL_RULE}"
    fi
    if ! firewall-cmd --permanent --zone="${FIREWALL_ZONE}" --query-rich-rule="${FIREWALL_RULE}" >/dev/null; then
      firewall-cmd --permanent --zone="${FIREWALL_ZONE}" --add-rich-rule="${FIREWALL_RULE}"
    fi
  done
fi

echo "Eagleway Node Agent installed in ${RELEASE_DIR}"
echo "Runtime: Node.js ${NODE_VERSION} (${NODE_BIN}); PM2: /usr/local/bin/eagleway-agent-pm2"
