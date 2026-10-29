import { join } from 'node:path'
import type { XrayProtocol } from './xray.types'

interface XrayConfigInput {
  protocol: XrayProtocol
  apiAddress: string
  port: number
  domain: string
}

export function xrayConfig(
  plan: XrayConfigInput,
  certificate: { cert: string; key: string },
  logDirectory = '/var/log/eagleway-node-agent'
) {
  const settings: Record<string, unknown> =
    plan.protocol === 'trojan'
      ? { users: [], fallbacks: [{ dest: 80 }] }
      : plan.protocol === 'vless'
        ? { clients: [], decryption: 'none', fallbacks: [{ dest: 80 }] }
        : { clients: [] }
  return {
    log: {
      access: join(logDirectory, 'xray-access.log'),
      error: join(logDirectory, 'xray-error.log'),
      loglevel: 'warning'
    },
    api: {
      tag: 'api',
      listen: plan.apiAddress,
      services: ['HandlerService', 'StatsService']
    },
    stats: {},
    policy: {
      levels: {
        '0': {
          statsUserUplink: true,
          statsUserDownlink: true,
          statsUserOnline: true
        }
      }
    },
    inbounds: [
      {
        tag: `eagleway-${plan.protocol}`,
        listen: '::',
        port: plan.port,
        protocol: plan.protocol,
        settings,
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: {
            serverName: plan.domain,
            alpn: ['http/1.1'],
            certificates: [
              {
                certificateFile: certificate.cert,
                keyFile: certificate.key
              }
            ]
          }
        }
      }
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }]
  }
}
