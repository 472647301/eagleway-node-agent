import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { XrayProtocol } from './xray.types'

interface XrayConfigInput {
  protocol: XrayProtocol
  apiAddress: string
  port: number
  domain: string
  speedLimitEnabled?: boolean
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
    ...speedLimitRouting(plan.protocol, plan.speedLimitEnabled === true),
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

export function speedLimitRouting(protocol: string, enabled: boolean) {
  return enabled
    ? {
        routing: {
          rules: [
            {
              type: 'field',
              inboundTag: [`eagleway-${protocol}`],
              outboundTag: 'direct',
              webhook: {
                url: '/run/eagleway-speedlimit/control.sock:/webhook/xray',
                deduplication: 0
              }
            }
          ]
        }
      }
    : {}
}

interface RuntimeRouting {
  rules?: unknown[]
  [key: string]: unknown
}

/** Preserve routing added outside the Agent when toggling an existing runtime. */
export function updateDownloadLimitRouting(
  protocol: string,
  enabled: boolean,
  previous?: RuntimeRouting
): RuntimeRouting | undefined {
  const managed = speedLimitRouting(protocol, true).routing!
  if (!previous) return enabled ? managed : undefined
  const rules = previous.rules ?? []
  const isManaged = (rule: unknown) => isDeepStrictEqual(rule, managed.rules[0])
  const matches = rules.some(isManaged)
  if (enabled) {
    if (matches) return previous
    if (rules.length) {
      throw new Error(
        'Cannot enable the download webhook over custom Xray routing rules'
      )
    }
    return { ...previous, rules: managed.rules }
  }
  if (!matches) return previous
  const retained = rules.filter((rule) => !isManaged(rule))
  if (retained.length) return { ...previous, rules: retained }
  const { rules: _removed, ...options } = previous
  return Object.keys(options).length ? options : undefined
}
