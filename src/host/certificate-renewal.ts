export const CERTBOT_XRAY_DEPLOY_HOOK =
  '/etc/letsencrypt/renewal-hooks/deploy/eagleway-node-agent-xray'
export const EAGLEWAY_CERTBOT_HOOK_MARKER =
  '#!/bin/sh\n# Managed by eagleway-node-agent\n'

export function certbotXrayDeployHook(): string {
  return `${EAGLEWAY_CERTBOT_HOOK_MARKER}set -eu

runtime_config=/etc/eagleway-node-agent/runtimes/xray/config.json
[ -n "\${RENEWED_LINEAGE:-}" ] || exit 0
[ -f "$runtime_config" ] || exit 0

certificate_file="\${RENEWED_LINEAGE}/fullchain.pem"
if /usr/bin/grep -Fq -- "\"certificateFile\": \"$certificate_file\"" "$runtime_config"; then
  /usr/bin/systemctl try-restart eagleway-xray.service
fi
`
}
