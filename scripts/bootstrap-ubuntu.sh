#!/bin/bash
set -Eeuo pipefail

readonly AGENT_USER="eagleway-agent"
readonly INSTALL_ROOT="/opt/eagleway-node-agent"
readonly CONFIG_ROOT="/etc/eagleway-node-agent"
readonly STATE_ROOT="/var/lib/eagleway-node-agent"
readonly LOG_ROOT="/var/log/eagleway-node-agent"

usage() {
  echo "Usage: sudo $0 <source-directory> <node-id> <allowed-cidrs> <bandwidth-mbps> [center-api-url] [port]" >&2
  exit 2
}

[[ "${EUID}" -eq 0 ]] || { echo "Bootstrap must run as root" >&2; exit 1; }
[[ $# -ge 4 && $# -le 6 ]] || usage

SOURCE_DIR="$(realpath "$1")"
NODE_ID="$2"
ALLOWED_CIDRS="$3"
SERVER_BANDWIDTH_MBPS="$4"
CENTER_API_URL="${5:-}"
AGENT_PORT="${6:-8086}"

[[ -f /etc/os-release ]] || { echo "Missing /etc/os-release" >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || { echo "Only Ubuntu is supported" >&2; exit 1; }
[[ -f "${SOURCE_DIR}/package.json" && -f "${SOURCE_DIR}/pnpm-lock.yaml" ]] || {
  echo "Source directory is not an Eagleway Node Agent checkout" >&2
  exit 1
}
[[ "${NODE_ID}" =~ ^[1-9][0-9]*$ ]] || { echo "node-id is invalid" >&2; exit 1; }
[[ "${SERVER_BANDWIDTH_MBPS}" =~ ^[1-9][0-9]*$ ]] || {
  echo "bandwidth-mbps is invalid" >&2
  exit 1
}
[[ "${AGENT_PORT}" =~ ^[0-9]+$ ]] && (( AGENT_PORT >= 1 && AGENT_PORT <= 65535 )) || {
  echo "port is invalid" >&2
  exit 1
}

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
  --exclude node_modules \
  --exclude dist \
  --exclude var \
  "${SOURCE_DIR}/" "${RELEASE_DIR}/"
chown -R "${AGENT_USER}:${AGENT_USER}" "${RELEASE_DIR}"

runuser -u "${AGENT_USER}" -- bash -lc \
  "cd '${RELEASE_DIR}' && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod"
chown -R root:root "${RELEASE_DIR}"
chmod -R go-w "${RELEASE_DIR}"

ln -sfn "${RELEASE_DIR}" "${INSTALL_ROOT}/current"
install -o root -g root -m 0755 \
  "${RELEASE_DIR}/scripts/eagleway-node-helper" \
  /usr/local/libexec/eagleway-node-helper
install -o root -g root -m 0440 \
  "${RELEASE_DIR}/scripts/eagleway-node-agent.sudoers" \
  /etc/sudoers.d/eagleway-node-agent
visudo -cf /etc/sudoers.d/eagleway-node-agent

cat > "${CONFIG_ROOT}/agent.env" <<EOF
NODE_ENV=production
PORT=${AGENT_PORT}
HOST=0.0.0.0
NODE_ID=${NODE_ID}
ALLOWED_CIDRS=${ALLOWED_CIDRS}
TRUST_PROXY=false
CENTER_API_URL=${CENTER_API_URL}
REPORT_INTERVAL_SECONDS=300
REPORTING_ENABLED=$([[ -n "${CENTER_API_URL}" ]] && echo true || echo false)
SERVER_BANDWIDTH_MBPS=${SERVER_BANDWIDTH_MBPS}
STATE_DIR=${STATE_ROOT}
STATE_KEY_PATH=${CONFIG_ROOT}/state.key
LOG_DIR=${LOG_ROOT}
XRAY_BINARY=/usr/local/bin/xray
XRAY_API_ADDRESS=127.0.0.1:10000
PRIVILEGED_HELPER=/usr/local/libexec/eagleway-node-helper
OPERATION_TIMEOUT_SECONDS=900
ACME_EMAIL=
EOF
chown "root:${AGENT_USER}" "${CONFIG_ROOT}/agent.env"
chmod 0640 "${CONFIG_ROOT}/agent.env"
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
