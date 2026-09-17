export const EAGLEWAY_NGINX_MARKER = '# Managed by eagleway-node-agent\n'
export const BAOTA_NGINX_BINARY = '/www/server/nginx/sbin/nginx'
export const BAOTA_NGINX_VHOST_DIRECTORY = '/www/server/panel/vhost/nginx'

export interface NginxDomainInspection {
  matchesDomain: boolean
  webroots: string[]
}

export function inspectNginxDomain(
  content: string,
  domain: string
): NginxDomainInspection {
  const expected = domain.toLowerCase()
  const webroots: string[] = []
  let matchesDomain = false
  const uncommented = content.replace(/(^|\s)#[^\r\n]*/g, '$1')

  for (const block of uncommented.split(/\bserver\s*\{/i).slice(1)) {
    const names = [...block.matchAll(/\bserver_name\s+([^;{}]+);/gi)]
      .flatMap((match) => match[1]?.trim().split(/\s+/) ?? [])
      .map((name) => name.toLowerCase())
    if (!names.includes(expected)) continue
    matchesDomain = true
    for (const match of block.matchAll(
      /\broot\s+(?:"([^"]+)"|'([^']+)'|([^;\s{}]+))\s*;/gi
    )) {
      const root = match[1] ?? match[2] ?? match[3]
      if (root && !root.includes('$') && !webroots.includes(root)) {
        webroots.push(root)
      }
    }
  }

  return { matchesDomain, webroots }
}

export function baotaAcmeConfigPath(domain: string): string {
  return `${BAOTA_NGINX_VHOST_DIRECTORY}/eagleway-acme-${domain}.conf`
}

export function baotaAcmeWebroot(domain: string): string {
  return `/var/www/eagleway-acme/${domain}`
}

export function baotaAcmeNginxConfig(domain: string, webroot: string): string {
  return `${EAGLEWAY_NGINX_MARKER}server {
  listen 80;
  listen [::]:80;
  server_name ${domain};

  location ^~ /.well-known/acme-challenge/ {
    root ${webroot};
    default_type text/plain;
  }

  location / {
    return 404;
  }
}
`
}
