#!/bin/bash
# Sourced by bootstrap; never starts, enables, or reloads a firewall.

select_agent_firewall() {
  local requested="${1:-auto}"
  local ufw_available=false ufw_active=false firewalld_available=false
  local ufw_status
  AGENT_FIREWALL_SELECTED=none
  AGENT_FIREWALLD_ACTIVE=false
  case "${requested}" in
    auto|ufw|firewalld) ;;
    *) echo "AGENT_FIREWALL_MANAGER must be auto, ufw, or firewalld" >&2; return 1 ;;
  esac

  if command -v ufw >/dev/null 2>&1; then
    ufw_available=true
    ufw_status="$(LC_ALL=C ufw status)" || return 1
    if grep -q '^Status: active$' <<< "${ufw_status}"; then
      ufw_active=true
    elif ! grep -q '^Status: inactive$' <<< "${ufw_status}"; then
      echo "Unable to determine UFW status" >&2
      return 1
    fi
  fi
  if command -v firewall-cmd >/dev/null 2>&1 \
    || command -v firewall-offline-cmd >/dev/null 2>&1; then
    firewalld_available=true
    if systemctl is-active --quiet firewalld; then
      AGENT_FIREWALLD_ACTIVE=true
    fi
  fi
  if [[ "${ufw_active}" == true && "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
    echo "Multiple supported host firewalls are active" >&2
    return 1
  fi

  if [[ "${requested}" == auto ]]; then
    if [[ "${ufw_active}" == true ]]; then
      AGENT_FIREWALL_SELECTED=ufw
    elif [[ "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
      AGENT_FIREWALL_SELECTED=firewalld
    elif [[ "${ufw_available}" == true && "${firewalld_available}" == true ]]; then
      echo "Both firewalls are installed but inactive; set AGENT_FIREWALL_MANAGER=ufw or firewalld" >&2
      return 1
    elif [[ "${ufw_available}" == true ]]; then
      AGENT_FIREWALL_SELECTED=ufw
    elif [[ "${firewalld_available}" == true ]]; then
      AGENT_FIREWALL_SELECTED=firewalld
    fi
  elif [[ "${requested}" == ufw ]]; then
    if [[ "${ufw_available}" != true || "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
      echo "Cannot select UFW: it is unavailable or firewalld is active" >&2
      return 1
    fi
    AGENT_FIREWALL_SELECTED=ufw
  else
    if [[ "${firewalld_available}" != true || "${ufw_active}" == true ]]; then
      echo "Cannot select firewalld: it is unavailable or UFW is active" >&2
      return 1
    fi
    AGENT_FIREWALL_SELECTED=firewalld
  fi

  if [[ "${AGENT_FIREWALL_SELECTED}" == firewalld ]]; then
    if [[ "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
      command -v firewall-cmd >/dev/null 2>&1 || {
        echo "Active firewalld requires firewall-cmd" >&2
        return 1
      }
    else
      command -v firewall-offline-cmd >/dev/null 2>&1 || {
        echo "Inactive firewalld requires firewall-offline-cmd to persist rules" >&2
        return 1
      }
    fi
  fi
}

configure_agent_firewall() (
  set -Eeuo pipefail
  local requested="$1" port="$2" allowed_cidrs="$3" zone_file="$4"
  local zone cidr family rule comment saved_rules
  local cidrs=() permanent_command=()
  # Recheck immediately before writing: the service may have changed during deployment.
  select_agent_firewall "${requested}"
  if [[ "${AGENT_FIREWALL_SELECTED}" == none ]]; then
    echo "No supported host firewall installed; configure network access separately"
    return 0
  fi
  if [[ "${AGENT_FIREWALL_SELECTED}" == firewalld ]]; then
    if [[ "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
      zone="$(firewall-cmd --get-default-zone)"
      permanent_command=(firewall-cmd --permanent)
    else
      zone="$(firewall-offline-cmd --get-default-zone)"
      permanent_command=(firewall-offline-cmd)
    fi
    [[ "${zone}" =~ ^[A-Za-z0-9_-]+$ ]] || {
      echo "firewalld returned an invalid default zone" >&2
      return 1
    }
    printf '%s\n' "${zone}" > "${zone_file}"
    chown root:root "${zone_file}"
    chmod 0600 "${zone_file}"
  fi

  IFS=',' read -ra cidrs <<< "${allowed_cidrs}"
  for cidr in "${cidrs[@]}"; do
    cidr="$(printf '%s' "${cidr}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "${cidr}" ]] || continue
    if [[ "${AGENT_FIREWALL_SELECTED}" == ufw ]]; then
      # UFW persists even while disabled. A per-rule comment survives address
      # normalization (e.g. /32 removal and IPv6 compression) in `show added`.
      comment="eagleway-node-agent:control:${port}:${cidr}"
      LC_ALL=C ufw allow from "${cidr}" to any port "${port}" proto tcp comment "${comment}"
      saved_rules="$(LC_ALL=C ufw show added)"
      if ! awk -v marker="comment '${comment}'" \
        '$1 == "ufw" && $2 == "allow" && substr($0, length($0) - length(marker) + 1) == marker { found = 1 }
         END { exit !found }' <<< "${saved_rules}"; then
        echo "Failed to persist UFW rule for ${cidr}:${port}" >&2
        return 1
      fi
    else
      family=ipv4
      [[ "${cidr}" != *:* ]] || family=ipv6
      rule="rule family=\"${family}\" source address=\"${cidr}\" port port=\"${port}\" protocol=\"tcp\" accept"
      # Persist first, then make the same rule effective without a global reload.
      if ! "${permanent_command[@]}" --zone="${zone}" --query-rich-rule="${rule}" >/dev/null; then
        "${permanent_command[@]}" --zone="${zone}" --add-rich-rule="${rule}"
      fi
      "${permanent_command[@]}" --zone="${zone}" --query-rich-rule="${rule}" >/dev/null || {
        echo "Failed to persist firewalld rule for ${cidr}:${port}" >&2
        return 1
      }
      if [[ "${AGENT_FIREWALLD_ACTIVE}" == true ]]; then
        if ! firewall-cmd --zone="${zone}" --query-rich-rule="${rule}" >/dev/null; then
          firewall-cmd --zone="${zone}" --add-rich-rule="${rule}"
        fi
        firewall-cmd --zone="${zone}" --query-rich-rule="${rule}" >/dev/null || {
          echo "Failed to apply runtime firewalld rule for ${cidr}:${port}" >&2
          return 1
        }
      fi
    fi
  done
  echo "Agent firewall rules saved and verified (${AGENT_FIREWALL_SELECTED})"
)
