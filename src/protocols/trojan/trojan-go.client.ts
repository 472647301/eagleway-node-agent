import { Inject, Injectable } from '@nestjs/common'
import { existsSync } from 'node:fs'
import JSONbigFactory from 'json-bigint'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { ProcessRunnerService } from '@/host/process-runner.service'

const JSONbig = JSONbigFactory({ storeAsString: true, strict: true })
const managedRuntimeMarker =
  '/etc/eagleway-node-agent/runtimes/trojan-go/.managed-by-eagleway-node-agent'
const runtimeUnit = '/etc/systemd/system/eagleway-trojan.service'

export interface TrojanProfile {
  hash: string
  uploadBytes: string
  downloadBytes: string
  uploadSpeedBytes: number
  downloadSpeedBytes: number
  ipCurrent: number
  ipLimit: number
}

@Injectable()
export class TrojanGoClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processes: ProcessRunnerService
  ) {}

  isInstalled(): boolean {
    return (
      this.hasManagedResources() &&
      existsSync(this.config.trojanGoBinary) &&
      existsSync(runtimeUnit)
    )
  }

  hasManagedResources(): boolean {
    return existsSync(managedRuntimeMarker)
  }

  async isActive(): Promise<boolean> {
    const result = await this.processes.run(
      '/usr/bin/systemctl',
      ['is-active', 'eagleway-trojan.service'],
      { rejectOnNonZero: false, timeoutMs: 5000, maxOutputBytes: 4096 }
    )
    return result.code === 0 && result.stdout === 'active'
  }

  async version(): Promise<string | null> {
    if (!this.isInstalled()) return null
    const result = await this.processes.run(
      this.config.trojanGoBinary,
      ['-version'],
      {
        rejectOnNonZero: false,
        timeoutMs: 5000,
        maxOutputBytes: 4096
      }
    )
    const firstLine = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .find(Boolean)
    return firstLine?.slice(0, 120) ?? null
  }

  async listProfiles(): Promise<TrojanProfile[]> {
    const result = await this.api(['list'])
    const parsed = JSONbig.parse(result.stdout) as unknown
    if (!Array.isArray(parsed))
      throw new Error('Trojan-Go list response is invalid')
    return parsed
      .map(parseProfile)
      .filter((item): item is TrojanProfile => !!item)
  }

  async findByCredential(credential: string): Promise<TrojanProfile | null> {
    const result = await this.api(
      ['get', '-target-password', credential],
      false
    )
    if (result.code !== 0 || !result.stdout) return null
    try {
      return parseProfile(JSONbig.parse(result.stdout) as unknown)
    } catch {
      return null
    }
  }

  async ensureUser(
    credential: string,
    ipLimit: number
  ): Promise<TrojanProfile> {
    let profile = await this.findByCredential(credential)
    if (!profile) {
      await this.api(['set', '-add-profile', '-target-password', credential])
    }
    await this.api([
      'set',
      '-modify-profile',
      '-target-password',
      credential,
      '-ip-limit',
      String(ipLimit),
      '-upload-speed-limit',
      '0',
      '-download-speed-limit',
      '0'
    ])
    profile = await this.findByCredential(credential)
    if (!profile?.hash) throw new Error('Trojan-Go user hash is unavailable')
    return profile
  }

  async deleteByHash(hash: string): Promise<void> {
    const result = await this.api(
      ['set', '-delete-profile', '-target-hash', hash],
      false
    )
    if (result.code !== 0 && !isMissingUser(result.stderr)) {
      throw new Error('Trojan-Go user deletion failed')
    }
  }

  private api(args: readonly string[], rejectOnNonZero = true) {
    return this.processes.run(
      this.config.trojanGoBinary,
      ['-api-addr', this.config.trojanGoApiAddress, '-api', ...args],
      {
        rejectOnNonZero,
        timeoutMs: 20_000,
        maxOutputBytes: 8 * 1024 * 1024
      }
    )
  }
}

function parseProfile(value: unknown): TrojanProfile | null {
  if (!value || typeof value !== 'object') return null
  const root = value as Record<string, unknown>
  const status =
    root.status && typeof root.status === 'object'
      ? (root.status as Record<string, unknown>)
      : root
  const user = objectValue(status.user)
  const traffic = objectValue(status.traffic_total)
  const speed = objectValue(status.speed_current)
  const hash = stringValue(user.hash)
  if (!hash || !/^[a-fA-F0-9]{56}$/.test(hash)) return null
  return {
    hash: hash.toLowerCase(),
    uploadBytes: unsignedIntegerString(traffic.upload_traffic),
    downloadBytes: unsignedIntegerString(traffic.download_traffic),
    uploadSpeedBytes: safeInteger(speed.upload_speed),
    downloadSpeedBytes: safeInteger(speed.download_speed),
    ipCurrent: safeInteger(status.ip_current),
    ipLimit: safeInteger(status.ip_limit)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function unsignedIntegerString(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return '0'
}

function safeInteger(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' &&
    Number.isSafeInteger(parsed) &&
    parsed >= 0
    ? parsed
    : 0
}

function isMissingUser(value: string): boolean {
  return /not found|does not exist|no such user/i.test(value)
}
