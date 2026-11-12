import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { request } from 'node:http'
import { existsSync } from 'node:fs'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { StateStoreService } from '@/state/state-store.service'
import { AgentError, invalidRequest } from '@/common/api/agent-error'
import { runtimeUserId, type XrayProtocol } from './xray.types'
import type { DownloadLimitSyncDto } from './xray.dto'

interface Snapshot {
  revision: number
  users: { email: string; mbps: number }[]
}

export interface DownloadLimitStatus {
  supported: true
  enabled: boolean
  state: 'disabled' | 'pending' | 'ready' | 'degraded'
  desiredRevision: number
  appliedRevision: number | null
  error?: string
}

@Injectable()
export class DownloadLimitsService implements OnModuleInit {
  private reconciling = false
  private applyErrorRevision: number | null = null

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly state: StateStoreService
  ) {}

  onModuleInit() {
    void this.reconcile()
  }

  async sync(protocol: XrayProtocol, input: DownloadLimitSyncDto) {
    const users = input.limits
      .map((item) => ({
        email: runtimeUserId(protocol, item.assignmentId),
        mbps: item.downloadLimitMbps
      }))
      .sort((a, b) => a.email.localeCompare(b.email))
    if (new Set(users.map((user) => user.email)).size !== users.length) {
      throw invalidRequest('Duplicate assignment in download limit snapshot')
    }
    const desired: Snapshot = { revision: input.revision, users }
    const current = this.desired()
    if (current && desired.revision < current.revision) {
      throw new AgentError('STALE_LIMIT_REVISION', 'Stale limit revision', 409)
    }
    if (
      current &&
      desired.revision === current.revision &&
      JSON.stringify(current) !== JSON.stringify(desired)
    ) {
      throw new AgentError(
        'LIMIT_REVISION_CONFLICT',
        'Limit revision conflict',
        409
      )
    }
    this.state.setMeta('downloadLimits.desired', JSON.stringify(desired))
    void this.reconcile()
    return this.status()
  }

  @Interval(30_000)
  async reconcile() {
    if (!this.config.speedLimitEnabled || this.reconciling) return
    this.reconciling = true
    try {
      let desired = this.desired()
      while (desired) {
        await this.apply(desired)
        const latest = this.desired()
        if (latest?.revision === desired.revision) break
        desired = latest
      }
    } finally {
      this.reconciling = false
    }
  }

  async status(): Promise<DownloadLimitStatus> {
    const desiredRevision = this.desired()?.revision ?? 0
    const base = {
      supported: true as const,
      enabled: !!this.config.speedLimitEnabled,
      desiredRevision
    }
    if (
      process.platform === 'linux' &&
      existsSync('/etc/eagleway-node-agent/speedlimit-error')
    ) {
      return {
        ...base,
        state: 'degraded',
        appliedRevision: null,
        error:
          'Incomplete deployment: check webhook configuration and kernel rule cleanup'
      }
    }
    if (!base.enabled)
      return { ...base, state: 'disabled', appliedRevision: null }
    try {
      const remote = (await socketRequest('GET', '/status')) as {
        state: string
        appliedRevision: number
        error?: string
      }
      if (!Number.isSafeInteger(remote.appliedRevision))
        throw new Error('Invalid service status')
      const state =
        remote.state === 'ready' &&
        remote.appliedRevision === desiredRevision &&
        desiredRevision > 0
          ? 'ready'
          : remote.state === 'degraded'
            ? 'degraded'
            : 'pending'
      if (
        this.applyErrorRevision === desiredRevision &&
        remote.appliedRevision !== desiredRevision
      ) {
        return {
          ...base,
          state: 'degraded',
          appliedRevision: remote.appliedRevision,
          error: 'Download limit service failed to accept the desired policy'
        }
      }
      return {
        ...base,
        state,
        appliedRevision: remote.appliedRevision,
        ...(remote.error ? { error: remote.error } : {})
      }
    } catch {
      return {
        ...base,
        state: 'degraded',
        appliedRevision: null,
        error: 'Download limit service is unavailable'
      }
    }
  }

  private desired(): Snapshot | null {
    const value = this.state.getMeta('downloadLimits.desired')
    return value ? (JSON.parse(value) as Snapshot) : null
  }

  private async apply(desired: Snapshot) {
    if (!this.config.speedLimitEnabled) return
    try {
      const remote = (await socketRequest('GET', '/status')) as {
        state: string
        appliedRevision: number
      }
      // The service audits kernel rules independently every 30 seconds.
      if (
        remote.state === 'ready' &&
        remote.appliedRevision === desired.revision
      )
        return
      await socketRequest('PUT', '/policies', desired)
      this.applyErrorRevision = null
    } catch {
      this.applyErrorRevision = desired.revision
      // Desired state is durable. The status endpoint exposes failure and the
      // next reconciliation retries without interrupting the proxy runtime.
    }
  }
}

function socketRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = request(
      {
        socketPath: '/run/eagleway-speedlimit/control.sock',
        path,
        method,
        headers: data
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data)
            }
          : {},
        timeout: method === 'GET' ? 2000 : 120000
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) {
            res.destroy(new Error('Oversized limit service response'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error('Limit service rejected snapshot'))
            return
          }
          try {
            const text = Buffer.concat(chunks).toString()
            resolve(text ? JSON.parse(text) : null)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Limit service timeout')))
    req.on('error', reject)
    req.end(data)
  })
}
