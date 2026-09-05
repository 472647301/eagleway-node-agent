import 'dotenv/config'
import { isIP } from 'node:net'
import { resolve } from 'node:path'

export interface AppConfig {
  env: 'development' | 'test' | 'production'
  port: number
  host: string
  nodeId: number
  allowedCidrs: string[]
  trustProxy: boolean
  centerApiUrl: string | null
  reportIntervalSeconds: number
  reportingEnabled: boolean
  serverBandwidthMbps: number
  stateDir: string
  stateKeyPath: string
  logDir: string
  xrayBinary: string
  xrayApiAddress: string
  acmeEmail: string | null
  privilegedHelper: string
  operationTimeoutSeconds: number
}

export const APP_CONFIG = Symbol('APP_CONFIG')

export function loadAppConfig(env = process.env): AppConfig {
  const runtimeEnv = enumValue(
    env.NODE_ENV ?? 'development',
    ['development', 'test', 'production'] as const,
    'NODE_ENV'
  )
  const nodeId = positiveInteger(env.NODE_ID, 'NODE_ID')
  const stateDir = resolve(
    env.STATE_DIR ??
      (runtimeEnv === 'production'
        ? '/var/lib/eagleway-node-agent'
        : './var/state')
  )
  const centerApiUrl = optionalHttpUrl(env.CENTER_API_URL, 'CENTER_API_URL')
  const reportingEnabled = booleanValue(
    env.REPORTING_ENABLED,
    runtimeEnv === 'production'
  )
  if (reportingEnabled && !centerApiUrl) {
    throw new Error('CENTER_API_URL is required when reporting is enabled')
  }
  return {
    env: runtimeEnv,
    port: boundedInteger(env.PORT, 8086, 1, 65_535, 'PORT'),
    host: env.HOST?.trim() || '0.0.0.0',
    nodeId,
    allowedCidrs: cidrList(env.ALLOWED_CIDRS),
    trustProxy: booleanValue(env.TRUST_PROXY, false),
    centerApiUrl,
    reportIntervalSeconds: boundedInteger(
      env.REPORT_INTERVAL_SECONDS,
      300,
      10,
      86_400,
      'REPORT_INTERVAL_SECONDS'
    ),
    reportingEnabled,
    serverBandwidthMbps: boundedInteger(
      env.SERVER_BANDWIDTH_MBPS,
      runtimeEnv === 'production' ? NaN : 1000,
      1,
      1_000_000,
      'SERVER_BANDWIDTH_MBPS'
    ),
    stateDir,
    stateKeyPath: resolve(
      env.STATE_KEY_PATH ??
        (runtimeEnv === 'production'
          ? '/etc/eagleway-node-agent/state.key'
          : `${stateDir}/state.key`)
    ),
    logDir: resolve(
      env.LOG_DIR ??
        (runtimeEnv === 'production'
          ? '/var/log/eagleway-node-agent'
          : './var/logs')
    ),
    xrayBinary: env.XRAY_BINARY?.trim() || '/usr/local/bin/xray',
    xrayApiAddress: xrayApiAddress(env.XRAY_API_ADDRESS),
    acmeEmail: env.ACME_EMAIL?.trim() || null,
    privilegedHelper:
      env.PRIVILEGED_HELPER?.trim() ||
      '/usr/local/libexec/eagleway-node-helper',
    operationTimeoutSeconds: boundedInteger(
      env.OPERATION_TIMEOUT_SECONDS,
      900,
      30,
      3600,
      'OPERATION_TIMEOUT_SECONDS'
    )
  }
}

function positiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} is required`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return parsed
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value == null || value === '') {
    if (Number.isNaN(fallback)) throw new Error(`${name} is required`)
    return fallback
  }
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

function xrayApiAddress(value: string | undefined): string {
  const address = value?.trim() || '127.0.0.1:10000'
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(address)
  const port = Number(match?.[1])
  if (!match || port > 65_535) {
    throw new Error('XRAY_API_ADDRESS must bind an IPv4 loopback port')
  }
  return address
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Boolean environment values must be true or false')
}

function optionalHttpUrl(
  value: string | undefined,
  name: string
): string | null {
  if (!value?.trim()) return null
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} contains unsupported URL components`)
  }
  return url.toString().replace(/\/$/, '')
}

function cidrList(value: string | undefined): string[] {
  const values = (value ?? '127.0.0.1/32')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!values.length) throw new Error('ALLOWED_CIDRS cannot be empty')
  for (const cidr of values) {
    const [address, prefixText, extra] = cidr.split('/')
    const family = isIP(address ?? '')
    const prefix = Number(prefixText)
    if (
      extra !== undefined ||
      !family ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    ) {
      throw new Error(`ALLOWED_CIDRS contains invalid CIDR: ${cidr}`)
    }
  }
  return values
}

function enumValue<const T extends readonly string[]>(
  value: string,
  allowed: T,
  name: string
): T[number] {
  if (!allowed.includes(value as T[number])) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value as T[number]
}
