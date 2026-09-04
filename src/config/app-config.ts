import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
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
  stateDir: string
  stateKeyPath: string
  logDir: string
  trojanGoBinary: string
  trojanGoApiAddress: string
  trojanGoPolicyPath: string
  trojanGoArchiveUrl: string | null
  trojanGoArchiveSha256: string | null
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
  const trojanGoPolicyPath = resolve(
    env.TROJAN_GO_POLICY_PATH ??
      (runtimeEnv === 'production'
        ? '/etc/eagleway-node-agent/runtime-policy.json'
        : './runtime-policy.json')
  )
  const artifactPolicy = loadArtifactPolicy(
    trojanGoPolicyPath,
    runtimeEnv === 'production'
      ? {}
      : {
          archiveUrl: env.TROJAN_GO_ARCHIVE_URL,
          archiveSha256: env.TROJAN_GO_ARCHIVE_SHA256
        }
  )

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
    trojanGoBinary: env.TROJAN_GO_BINARY?.trim() || '/usr/local/bin/trojan-go',
    trojanGoApiAddress: env.TROJAN_GO_API_ADDRESS?.trim() || '127.0.0.1:10000',
    trojanGoPolicyPath,
    trojanGoArchiveUrl: optionalHttpsUrl(
      artifactPolicy.archiveUrl,
      'runtime policy archiveUrl'
    ),
    trojanGoArchiveSha256: optionalSha256(
      artifactPolicy.archiveSha256,
      'runtime policy archiveSha256'
    ),
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

function optionalHttpsUrl(
  value: string | undefined,
  name: string
): string | null {
  if (!value?.trim()) return null
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`)
  }
  return url.toString()
}

function optionalSha256(
  value: string | undefined,
  name = 'TROJAN_GO_ARCHIVE_SHA256'
): string | null {
  if (!value?.trim()) return null
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must be 64 hexadecimal characters`)
  }
  return normalized
}

function loadArtifactPolicy(
  path: string,
  fallback: { archiveUrl?: string; archiveSha256?: string }
): { archiveUrl?: string; archiveSha256?: string } {
  if (!existsSync(path)) return fallback
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Trojan-Go runtime policy is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trojan-Go runtime policy must be an object')
  }
  const policy = value as Record<string, unknown>
  const allowed = new Set(['archiveUrl', 'archiveSha256'])
  if (Object.keys(policy).some((key) => !allowed.has(key))) {
    throw new Error('Trojan-Go runtime policy contains unknown fields')
  }
  for (const key of allowed) {
    if (
      policy[key] !== undefined &&
      policy[key] !== null &&
      typeof policy[key] !== 'string'
    ) {
      throw new Error(
        `Trojan-Go runtime policy ${key} must be a string or null`
      )
    }
  }
  return {
    archiveUrl:
      typeof policy.archiveUrl === 'string' ? policy.archiveUrl : undefined,
    archiveSha256:
      typeof policy.archiveSha256 === 'string'
        ? policy.archiveSha256
        : undefined
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
  if (value == null || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
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
