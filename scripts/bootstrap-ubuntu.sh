#!/bin/bash
set -Eeuo pipefail

readonly AGENT_USER="eagleway-agent"
readonly INSTALL_ROOT="/opt/eagleway-node-agent"
readonly CONFIG_ROOT="/etc/eagleway-node-agent"
readonly STATE_ROOT="/var/lib/eagleway-node-agent"
readonly LOG_ROOT="/var/log/eagleway-node-agent"

usage() {
  echo "Usage: sudo $0 [source-directory]" >&2
  exit 2
}

[[ "${EUID}" -eq 0 ]] || { echo "Bootstrap must run as root" >&2; exit 1; }
[[ $# -le 1 ]] || usage

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(realpath "${1:-${SCRIPT_DIR}/..}")"
ENV_FILE="${SOURCE_DIR}/.env"

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

[[ -f "${ENV_FILE}" ]] || { echo "Missing environment file: ${ENV_FILE}" >&2; exit 1; }

RUNTIME_ENV="$(required_env NODE_ENV)"
AGENT_PORT="$(required_env PORT)"
NODE_ID="$(required_env NODE_ID)"
ALLOWED_CIDRS="$(required_env ALLOWED_CIDRS)"
REPORTING_ENABLED="$(required_env REPORTING_ENABLED)"
SERVER_BANDWIDTH_MBPS="$(required_env SERVER_BANDWIDTH_MBPS)"
CENTER_API_URL="$(env_value CENTER_API_URL || true)"

[[ -f /etc/os-release ]] || { echo "Missing /etc/os-release" >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || { echo "Only Ubuntu is supported" >&2; exit 1; }
[[ -f "${SOURCE_DIR}/package.json" && -f "${SOURCE_DIR}/pnpm-lock.yaml" ]] || {
  echo "Source directory is not an Eagleway Node Agent checkout" >&2
  exit 1
}
[[ "${RUNTIME_ENV}" == "production" ]] || { echo "NODE_ENV must be production" >&2; exit 1; }
[[ "${NODE_ID}" =~ ^[1-9][0-9]*$ ]] || { echo "NODE_ID is invalid" >&2; exit 1; }
[[ "${SERVER_BANDWIDTH_MBPS}" =~ ^[1-9][0-9]*$ ]] || {
  echo "SERVER_BANDWIDTH_MBPS is invalid" >&2
  exit 1
}
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
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync sudo unzip build-essential python3

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
  apt-get update
  apt-get install -y --no-install-recommends nodejs
fi

node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
corepack enable
corepack prepare pnpm@11.22.0 --activate
npm install --global pm2@6

if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "${AGENT_USER}"
fi

install -d -o root -g root -m 0755 "${INSTALL_ROOT}/releases"
install -d -o root -g "${AGENT_USER}" -m 0750 "${CONFIG_ROOT}"
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0700 "${STATE_ROOT}"
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0750 "${LOG_ROOT}"

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${INSTALL_ROOT}/releases/${RELEASE_ID}"
install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${RELEASE_DIR}"
rsync -a --delete \
  --exclude .git \
  --exclude .env \
  --exclude node_modules \
  --exclude dist \
  --exclude var \
  "${SOURCE_DIR}/" "${RELEASE_DIR}/"
chown -R "${AGENT_USER}:${AGENT_USER}" "${RELEASE_DIR}"

runuser -u "${AGENT_USER}" -- bash -lc \
  "cd '${RELEASE_DIR}' && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod"

(
  cd "${RELEASE_DIR}"
  env -i PATH="${PATH}" DOTENV_CONFIG_PATH="${ENV_FILE}" \
    /usr/bin/node -e "require('./dist/config/app-config').loadAppConfig()"
)

chown -R root:root "${RELEASE_DIR}"
chmod -R go-w "${RELEASE_DIR}"

ln -sfn "${RELEASE_DIR}" "${INSTALL_ROOT}/current"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 \
  "${RELEASE_DIR}/scripts/eagleway-node-helper" \
  /usr/local/libexec/eagleway-node-helper
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

runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" \
  pm2 delete eagleway-node-agent >/dev/null 2>&1 || true
runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" \
  pm2 start "${INSTALL_ROOT}/current/ecosystem.config.cjs"
runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" pm2 save
pm2 startup systemd -u "${AGENT_USER}" --hp "/home/${AGENT_USER}" >/dev/null

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  IFS=',' read -ra CIDRS <<< "${ALLOWED_CIDRS}"
  for cidr in "${CIDRS[@]}"; do
    ufw allow from "${cidr}" to any port "${AGENT_PORT}" proto tcp
  done
fi

echo "Eagleway Node Agent installed in ${RELEASE_DIR}"
