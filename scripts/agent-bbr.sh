#!/bin/bash
# Sourced by bootstrap/uninstall. Only manages its own sysctl drop-in;
# never replaces a kernel, restarts a service, or changes a live interface qdisc.

agent_bbr_config() {
  printf '%s\n' \
    '# Managed by eagleway-node-agent: BBR v1' \
    "# previous_tcp_congestion_control=$1" \
    "# previous_default_qdisc=$2" \
    'net.core.default_qdisc=fq' \
    'net.ipv4.tcp_congestion_control=bbr'
}

agent_bbr_set() {
  local key="$1" value="$2"
  [[ "$(sysctl -n "${key}")" != "${value}" ]] || return 0
  sysctl -q -w "${key}=${value}" || return 1
  [[ "$(sysctl -n "${key}")" == "${value}" ]] || {
    echo "Failed to verify ${key}=${value}" >&2
    return 1
  }
}

configure_agent_bbr() (
  set -Eeuo pipefail
  local enabled="$1" config_file="$2"
  local previous_cc="" previous_qdisc="" current_cc current_qdisc available
  local target_cc target_qdisc temporary="" rollback=false status
  case "${enabled}" in
    true|false) ;;
    *) echo 'AGENT_ENABLE_BBR must be true or false' >&2; return 1 ;;
  esac

  if [[ -e "${config_file}" || -L "${config_file}" ]]; then
    if [[ ! -f "${config_file}" || -L "${config_file}" ]]; then
      echo "Refusing non-regular BBR configuration: ${config_file}" >&2
      return 1
    fi
    previous_cc="$(sed -n 's/^# previous_tcp_congestion_control=//p' "${config_file}")"
    previous_qdisc="$(sed -n 's/^# previous_default_qdisc=//p' "${config_file}")"
    if [[ ! "${previous_cc}" =~ ^[a-zA-Z0-9_]+$ \
      || ! "${previous_qdisc}" =~ ^[a-zA-Z0-9_]+$ ]] \
      || ! cmp -s "${config_file}" <(agent_bbr_config "${previous_cc}" "${previous_qdisc}"); then
      echo "Refusing modified or unmanaged BBR configuration: ${config_file}" >&2
      return 1
    fi
  elif [[ "${enabled}" == false ]]; then
    echo 'BBR management disabled; existing host settings left unchanged.'
    return 0
  fi

  command -v sysctl >/dev/null 2>&1 || {
    echo 'BBR configuration requires sysctl (procps/procps-ng).' >&2
    return 1
  }
  current_cc="$(sysctl -n net.ipv4.tcp_congestion_control)"
  current_qdisc="$(sysctl -n net.core.default_qdisc)"
  [[ "${current_cc}" =~ ^[a-zA-Z0-9_]+$ && "${current_qdisc}" =~ ^[a-zA-Z0-9_]+$ ]] || {
    echo 'Cannot read current TCP congestion control and default qdisc.' >&2
    return 1
  }

  if [[ "${enabled}" == true ]]; then
    available="$(sysctl -n net.ipv4.tcp_available_congestion_control)"
    if [[ " ${available} " != *' bbr '* ]]; then
      # Built-in BBR needs no modprobe; a loadable module does.
      if command -v modprobe >/dev/null 2>&1; then
        modprobe tcp_bbr || true
      fi
      available="$(sysctl -n net.ipv4.tcp_available_congestion_control)"
      if [[ " ${available} " != *' bbr '* ]]; then
        echo 'AGENT_ENABLE_BBR=true, but BBR is unavailable in the running kernel after attempting to load tcp_bbr.' >&2
        echo 'Install a supported kernel/module separately, or set AGENT_ENABLE_BBR=false and redeploy. No kernel replacement or reboot was attempted.' >&2
        return 1
      fi
    fi
    if command -v modprobe >/dev/null 2>&1; then
      # May be built in; the sysctl write below is the authoritative check.
      modprobe sch_fq 2>/dev/null || true
    fi
    previous_cc="${previous_cc:-${current_cc}}"
    previous_qdisc="${previous_qdisc:-${current_qdisc}}"
    target_cc=bbr
    target_qdisc=fq
  else
    # Preserve settings changed by an administrator since enablement.
    target_cc="${current_cc}"
    target_qdisc="${current_qdisc}"
    [[ "${current_cc}" != bbr ]] || target_cc="${previous_cc}"
    [[ "${current_qdisc}" != fq ]] || target_qdisc="${previous_qdisc}"
  fi

  # Persist only after both live writes succeed. On failure keep the original
  # drop-in and restore this invocation's live values, including on re-deploy.
  trap '
    status=$?
    trap - EXIT
    if [[ "${rollback}" == true ]]; then
      agent_bbr_set net.ipv4.tcp_congestion_control "${current_cc}" || echo "WARNING: failed to restore TCP congestion control to ${current_cc}" >&2
      agent_bbr_set net.core.default_qdisc "${current_qdisc}" || echo "WARNING: failed to restore default qdisc to ${current_qdisc}" >&2
    fi
    if [[ -n "${temporary}" ]]; then rm -f -- "${temporary}"; fi
    exit "${status}"
  ' EXIT

  if [[ "${enabled}" == true ]]; then
    temporary="$(mktemp "${config_file}.XXXXXXXX")"
    agent_bbr_config "${previous_cc}" "${previous_qdisc}" > "${temporary}"
    chown root:root "${temporary}"
    chmod 0644 "${temporary}"
  fi
  rollback=true
  agent_bbr_set net.core.default_qdisc "${target_qdisc}"
  agent_bbr_set net.ipv4.tcp_congestion_control "${target_cc}"
  if [[ "${enabled}" == true ]]; then
    mv -f -- "${temporary}" "${config_file}"
    temporary=""
    echo "BBR enabled for the host TCP default; persisted in ${config_file}."
  else
    rm -- "${config_file}"
    echo 'Removed Eagleway BBR configuration and restored unchanged managed defaults.'
  fi
  rollback=false
  echo 'No system reboot required. Existing TCP sockets/listeners retain their algorithm.'
  echo 'For an installed Xray, use the Agent stop/start APIs in a maintenance window to restart and restore users; reconnect clients and verify with ss -tin.'
  echo 'Existing interface queues were not replaced; inspect them separately with tc qdisc show. default_qdisc is not the live interface qdisc.'
)
