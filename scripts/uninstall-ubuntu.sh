#!/bin/bash
set -Eeuo pipefail

readonly AGENT_USER="eagleway-agent"
readonly INSTALL_ROOT="/opt/eagleway-node-agent"
readonly CONFIG_ROOT="/etc/eagleway-node-agent"
readonly STATE_ROOT="/var/lib/eagleway-node-agent"
readonly LOG_ROOT="/var/log/eagleway-node-agent"
readonly HELPER_PATH="/usr/local/libexec/eagleway-node-helper"
readonly SUDOERS_PATH="/etc/sudoers.d/eagleway-node-agent"
readonly PM2_UNIT="pm2-eagleway-agent.service"
readonly PM2_UNIT_PATH="/etc/systemd/system/${PM2_UNIT}"
readonly XRAY_MARKER="${CONFIG_ROOT}/runtimes/xray/.managed-by-eagleway-node-agent"

ASSUME_YES=false
KEEP_DATA=false

usage() {
  local exit_code="${1:-2}"
  cat >&2 <<'EOF'
Usage: sudo bash uninstall-ubuntu.sh [--yes] [--keep-data]

  --yes        Skip the interactive confirmation.
  --keep-data  Keep configuration, state, logs, and the eagleway-agent user.
EOF
  exit "${exit_code}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      ASSUME_YES=true
      ;;
    --keep-data)
      KEEP_DATA=true
      ;;
    -h | --help)
      usage 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
  shift
done

[[ "${EUID}" -eq 0 ]] || {
  echo "Uninstaller must run as root" >&2
  exit 1
}

if [[ "${ASSUME_YES}" != "true" ]]; then
  [[ -t 0 ]] || {
    echo "Interactive confirmation is unavailable; rerun with --yes" >&2
    exit 2
  }
  echo "This will stop and remove Eagleway Node Agent and its managed Xray runtime."
  if [[ "${KEEP_DATA}" == "true" ]]; then
    echo "Configuration, SQLite state, logs, and the service user will be kept."
  else
    echo "Configuration, SQLite state, logs, releases, and the service user will be deleted."
  fi
  echo "Shared Node.js, PM2, Nginx, Certbot, certificates, and unrelated sites will be kept."
  read -r -p "Type uninstall to continue: " confirmation
  [[ "${confirmation}" == "uninstall" ]] || {
    echo "Uninstall cancelled"
    exit 2
  }
fi

env_value() {
  local key="$1"
  local env_file="${CONFIG_ROOT}/agent.env"
  local line
  [[ -f "${env_file}" ]] || return 1
  line="$(awk -v key="${key}" '
    {
      sub(/\r$/, "")
      if ($0 ~ "^[[:space:]]*" key "[[:space:]]*=") value = $0
    }
    END {
      if (value == "") exit 1
      print value
    }
  ' "${env_file}")" || return 1
  line="${line#*=}"
  line="$(printf '%s' "${line}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ ${#line} -ge 2 ]]; then
    if [[ "${line:0:1}" == '"' && "${line: -1}" == '"' ]]; then
      line="${line:1:${#line}-2}"
    elif [[ "${line:0:1}" == "'" && "${line: -1}" == "'" ]]; then
      line="${line:1:${#line}-2}"
    fi
  fi
  printf '%s' "${line}"
}

AGENT_PORT="$(env_value PORT || true)"
ALLOWED_CIDRS="$(env_value ALLOWED_CIDRS || true)"

echo "Stopping Eagleway Node Agent..."
if id "${AGENT_USER}" >/dev/null 2>&1 && command -v pm2 >/dev/null 2>&1; then
  runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" \
    pm2 delete eagleway-node-agent >/dev/null 2>&1 || true
  runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" \
    pm2 save --force >/dev/null 2>&1 || true
  runuser -u "${AGENT_USER}" -- env HOME="/home/${AGENT_USER}" \
    pm2 kill >/dev/null 2>&1 || true
fi
systemctl disable --now "${PM2_UNIT}" >/dev/null 2>&1 || true

if [[ -e "${XRAY_MARKER}" ]]; then
  echo "Removing the managed Xray runtime..."
  if [[ -x "${HELPER_PATH}" ]]; then
    "${HELPER_PATH}" xray-uninstall
  elif [[ -f "${INSTALL_ROOT}/current/dist/helper.js" && -x /usr/bin/node ]]; then
    /usr/bin/node "${INSTALL_ROOT}/current/dist/helper.js" xray-uninstall
  else
    echo "Managed Xray resources exist, but the trusted helper is unavailable." >&2
    echo "Restore the matching release/helper and rerun the uninstaller." >&2
    exit 1
  fi
fi

if command -v ufw >/dev/null 2>&1 \
  && [[ "${AGENT_PORT}" =~ ^[0-9]+$ ]] \
  && [[ -n "${ALLOWED_CIDRS}" ]]; then
  IFS=',' read -ra CIDRS <<< "${ALLOWED_CIDRS}"
  for cidr in "${CIDRS[@]}"; do
    cidr="$(printf '%s' "${cidr}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "${cidr}" ]] || continue
    ufw --force delete allow from "${cidr}" to any port "${AGENT_PORT}" proto tcp \
      >/dev/null 2>&1 || true
  done
fi

rm -f -- "${SUDOERS_PATH}" "${HELPER_PATH}" "${PM2_UNIT_PATH}"
systemctl daemon-reload
systemctl reset-failed "${PM2_UNIT}" >/dev/null 2>&1 || true
rm -rf -- "${INSTALL_ROOT}"

if [[ "${KEEP_DATA}" != "true" ]]; then
  rm -rf -- "${CONFIG_ROOT}" "${STATE_ROOT}" "${LOG_ROOT}"

  CALLER_USER="${SUDO_USER:-root}"
  CALLER_HOME="$(getent passwd "${CALLER_USER}" | awk -F: 'NR == 1 { print $6 }' || true)"
  if [[ -n "${CALLER_HOME}" && "${CALLER_HOME}" == /* ]]; then
    rm -rf -- "${CALLER_HOME}/.config/eagleway-node-agent"
  fi

  if id "${AGENT_USER}" >/dev/null 2>&1; then
    userdel --remove "${AGENT_USER}" >/dev/null 2>&1 || {
      echo "Could not remove ${AGENT_USER}; remove it manually after checking its processes." >&2
    }
  fi
fi

echo "Eagleway Node Agent has been uninstalled."
if [[ "${KEEP_DATA}" == "true" ]]; then
  echo "Preserved: ${CONFIG_ROOT}, ${STATE_ROOT}, ${LOG_ROOT}, and ${AGENT_USER}."
fi
echo "Review cloud security-group rules and run 'ufw status numbered' for any historical rules."
