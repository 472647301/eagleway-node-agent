#!/bin/bash
set -Eeuo pipefail

readonly AGENT_USER="eagleway-agent"
readonly AGENT_HOME="/home/${AGENT_USER}"
readonly INSTALL_ROOT="/opt/eagleway-node-agent"
readonly CONFIG_ROOT="/etc/eagleway-node-agent"
readonly STATE_ROOT="/var/lib/eagleway-node-agent"
readonly LOG_ROOT="/var/log/eagleway-node-agent"
readonly APT_LOCK_TIMEOUT_SECONDS=600

run_apt_get() {
  echo "Running apt-get; waiting up to ${APT_LOCK_TIMEOUT_SECONDS}s for package manager locks..."
  apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

usage() {
  echo "Usage: sudo $0 [release-directory] [env-file]" >&2
  exit 2
}

[[ "${EUID}" -eq 0 ]] || { echo "Bootstrap must run as root" >&2; exit 1; }
[[ $# -le 2 ]] || usage

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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
[[ "${ID:-}" == "ubuntu" ]] || { echo "Only Ubuntu is supported" >&2; exit 1; }
[[ -f "${RELEASE_MANIFEST}" \
  && -f "${RELEASE_SOURCE_DIR}/package.json" \
  && -f "${RELEASE_SOURCE_DIR}/dist/main.js" \
  && -f "${RELEASE_SOURCE_DIR}/dist/helper.js" \
  && -f "${RELEASE_SOURCE_DIR}/ecosystem.config.cjs" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/deploy-ubuntu-release.sh" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/uninstall-ubuntu.sh" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/eagleway-node-helper" \
  && -f "${RELEASE_SOURCE_DIR}/scripts/eagleway-node-agent.sudoers" \
  && -d "${RELEASE_SOURCE_DIR}/node_modules" ]] || {
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

export DEBIAN_FRONTEND=noninteractive
run_apt_get update
run_apt_get install -y --no-install-recommends ca-certificates curl gnupg rsync sudo unzip

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
fi
if (( NODE_MAJOR < 22 )); then
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    --output /tmp/eagleway-nodesource.gpg.key
  gpg --dearmor --yes --output /etc/apt/keyrings/nodesource.gpg /tmp/eagleway-nodesource.gpg.key
  rm -f /tmp/eagleway-nodesource.gpg.key
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  run_apt_get update
  run_apt_get install -y --no-install-recommends nodejs
fi

node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
[[ -x /usr/bin/node ]] || {
  echo "Node.js 22 must be available at /usr/bin/node" >&2
  exit 1
}

RELEASE_COMMIT="$(RELEASE_MANIFEST="${RELEASE_MANIFEST}" node -e '
  const fs = require("node:fs")
  const manifest = JSON.parse(fs.readFileSync(process.env.RELEASE_MANIFEST, "utf8"))
  const nodeMajor = Number(process.versions.node.split(".")[0])
  if (manifest.formatVersion !== 1) throw new Error("Unsupported release manifest format")
  if (manifest.packageName !== "@eagleway/node-agent") throw new Error("Unexpected package name")
  if (manifest.platform !== process.platform) throw new Error(`Release platform ${manifest.platform} does not match ${process.platform}`)
  if (manifest.arch !== process.arch) throw new Error(`Release architecture ${manifest.arch} does not match ${process.arch}`)
  if (manifest.nodeMajor !== nodeMajor) throw new Error(`Release Node.js ${manifest.nodeMajor} does not match ${nodeMajor}`)
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("Invalid release commit")
  process.stdout.write(manifest.commit)
')"

PM2_MAJOR=0
if command -v pm2 >/dev/null 2>&1; then
  PM2_ENTRY="$(readlink -f "$(command -v pm2)")"
  PM2_PACKAGE_JSON="$(dirname "$(dirname "${PM2_ENTRY}")")/package.json"
  if [[ -f "${PM2_PACKAGE_JSON}" ]]; then
    PM2_MAJOR="$(PM2_PACKAGE_JSON="${PM2_PACKAGE_JSON}" node -p \
      'require(process.env.PM2_PACKAGE_JSON).version.split(".")[0]')"
  fi
fi
if [[ ! "${PM2_MAJOR}" =~ ^[0-9]+$ ]] || (( PM2_MAJOR < 6 )); then
  npm install --global pm2@6
fi

if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "${AGENT_USER}"
fi

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

(
  cd "${RELEASE_DIR}"
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" \
    /usr/bin/node -e "const Database = require('better-sqlite3'); new Database(':memory:').close()"
)

(
  cd "${RELEASE_DIR}"
  env -i PATH="${PATH}" DOTENV_CONFIG_PATH="${ENV_FILE}" \
    /usr/bin/node -e "require('./dist/config/app-config').loadAppConfig()"
)

ln -sfn "${RELEASE_DIR}" "${INSTALL_ROOT}/current"
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
  # PM2 passes its current directory to the daemon spawn. A deployment started
  # from /root would otherwise fail with "spawn /usr/bin/node EACCES" after
  # dropping privileges to the service user.
  cd "${AGENT_HOME}"
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" \
    pm2 delete eagleway-node-agent >/dev/null 2>&1 || true
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" \
    pm2 start "${INSTALL_ROOT}/current/ecosystem.config.cjs"
  runuser -u "${AGENT_USER}" -- env HOME="${AGENT_HOME}" pm2 save
)
(
  cd /
  pm2 startup systemd -u "${AGENT_USER}" --hp "${AGENT_HOME}" >/dev/null
)

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  IFS=',' read -ra CIDRS <<< "${ALLOWED_CIDRS}"
  for cidr in "${CIDRS[@]}"; do
    ufw allow from "${cidr}" to any port "${AGENT_PORT}" proto tcp
  done
fi

echo "Eagleway Node Agent installed in ${RELEASE_DIR}"
