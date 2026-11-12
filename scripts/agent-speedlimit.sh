#!/bin/bash
# Sourced by the root bootstrap/uninstaller. No effects merely from sourcing.

prepare_agent_speedlimit() {
  local enabled="$1" iface="$2" release="$3"
  [[ "${enabled}" == true ]] || return 0
  local binary="${release}/services/speedlimit/bin/eagleway-speedlimit"
  local unit=/etc/systemd/system/eagleway-speedlimit.service
  [[ -x "${binary}" ]] || { echo "Release lacks the speed limit binary" >&2; return 1; }
  if [[ -z "${iface}" ]]; then
    iface="$( { ip -o route show default; ip -o -6 route show default; } | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | sort -u)"
  fi
  [[ "${iface}" =~ ^[a-zA-Z0-9_.:-]{1,15}$ && "${iface}" != lo ]] || {
    echo "Set AGENT_SPEED_LIMIT_INTERFACE to one client-facing interface; auto detection was ambiguous" >&2; return 1;
  }
  if [[ -e "${unit}" ]] && ! head -n 1 "${unit}" | grep -qx '# Managed by eagleway-node-agent speedlimit v1'; then
    echo "Refusing to replace an unowned speed limit unit" >&2; return 1
  fi
  install -d -o root -g root -m 0700 /var/lib/eagleway-speedlimit
  local had_unit=false
  if [[ -f "${unit}" ]]; then cp -p "${unit}" "${unit}.previous"; had_unit=true; fi
  cat > "${unit}" <<EOF
# Managed by eagleway-node-agent speedlimit v1
[Unit]
Description=Eagleway download limits
After=network-online.target
Wants=network-online.target
Before=eagleway-xray.service
[Service]
Type=simple
User=root
Group=eagleway-agent
RuntimeDirectory=eagleway-speedlimit
RuntimeDirectoryMode=0750
ExecStart=${binary} -interface ${iface}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/eagleway-speedlimit /run/eagleway-speedlimit
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW
UMask=0027
[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${unit}"
  systemctl daemon-reload
  local ready=false
  if systemctl restart eagleway-speedlimit.service; then
    for ((attempt=0; attempt<60; attempt++)); do
      if curl --silent --fail --max-time 2 --unix-socket /run/eagleway-speedlimit/control.sock http://localhost/status |
        "${release}/runtime/bin/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).state==="ready"?0:1)}catch{process.exit(1)}})'; then ready=true; break; fi
      sleep 1
    done
  fi
  if [[ "${ready}" != true ]]; then
    echo "Speed limit preflight failed; Xray and Agent release have not been switched. Inspect journalctl -u eagleway-speedlimit." >&2
    systemctl stop eagleway-speedlimit.service
    if [[ "${had_unit}" == true ]]; then
      mv -f "${unit}.previous" "${unit}"
      systemctl daemon-reload
      systemctl start eagleway-speedlimit.service
    else
      "${binary}" -interface "${iface}" -cleanup || return 1
      rm -f -- "${unit}"
      systemctl daemon-reload
    fi
    return 1
  fi
  rm -f -- "${unit}.previous"
  systemctl enable eagleway-speedlimit.service
}

disable_agent_speedlimit() {
  local release="$1" unit=/etc/systemd/system/eagleway-speedlimit.service
  local journal=/var/lib/eagleway-speedlimit/ownership.json
  [[ -e "${unit}" || -e "${journal}" ]] || return 0
  if [[ -e "${unit}" ]]; then
    head -n 1 "${unit}" | grep -qx '# Managed by eagleway-node-agent speedlimit v1' || {
      echo "Refusing to stop an unowned speed limit service" >&2; return 1;
    }
    systemctl disable --now eagleway-speedlimit.service || return 1
  fi
  if [[ -e "${journal}" ]]; then
    local iface
    iface="$("${release}/runtime/bin/node" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).interface)' "${journal}")" || return 1
    "${release}/services/speedlimit/bin/eagleway-speedlimit" -interface "${iface}" -cleanup || return 1
  fi
  rm -f -- "${unit}" || return 1
  systemctl daemon-reload
}
