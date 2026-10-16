import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { promises as dns } from 'node:dns'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { AgentError } from '@/common/api/agent-error'
import { BAOTA_NGINX_BINARY, BAOTA_NGINX_PID_PATH } from './nginx-acme'
import { ProcessRunnerService } from './process-runner.service'
import {
  hostProfileFor,
  hostProfileOsId,
  type HostProfile
} from './host-profile'

export type { HostProfile } from './host-profile'

export interface HostInspection {
  profile: HostProfile
  osId: string
  osVersion: string
  architecture: NodeJS.Architecture
  baota: boolean
}

@Injectable()
export class HostInspectorService {
  private readonly logger = new Logger(HostInspectorService.name)

  constructor(private readonly processes: ProcessRunnerService) {}

  inspect(): HostInspection {
    if (process.platform !== 'linux') {
      throw new AgentError(
        'UNSUPPORTED_OS',
        'Only Ubuntu and Alibaba Cloud Linux 3 are supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    const release = parseOsRelease(readFileSync('/etc/os-release', 'utf8'))
    const baota = existsSync('/www/server/panel')
    const profile = hostProfileFor(release, baota)
    if (!profile) {
      throw new AgentError(
        'UNSUPPORTED_OS',
        'Only Ubuntu and Alibaba Cloud Linux 3 are supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    if (!['x64', 'arm64'].includes(process.arch)) {
      throw new AgentError(
        'UNSUPPORTED_HOST_PROFILE',
        'Only x64 and arm64 hosts are supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    if (release.ID === 'alinux' && process.arch !== 'x64') {
      throw new AgentError(
        'UNSUPPORTED_HOST_PROFILE',
        'Alibaba Cloud Linux 3 is supported only on x64 hosts',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    if (
      baota &&
      (!existsSync('/www/server/nginx') || !existsSync(BAOTA_NGINX_BINARY))
    ) {
      throw new AgentError(
        'UNSUPPORTED_HOST_PROFILE',
        'Only BaoTa with Nginx is supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    return {
      profile,
      osId: hostProfileOsId(profile),
      osVersion: release.VERSION_ID ?? 'unknown',
      architecture: process.arch,
      baota
    }
  }

  async assertDomainReady(domain: string): Promise<void> {
    const [ipv4, ipv6] = await Promise.all([
      dns.resolve4(domain).catch(() => []),
      dns.resolve6(domain).catch(() => [])
    ])
    if (!ipv4.length && !ipv6.length) {
      throw new AgentError(
        'DNS_NOT_READY',
        'Domain has no resolvable A or AAAA record',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
  }

  async assertPortAvailable(port: number): Promise<void> {
    let available: boolean
    try {
      available = await portAvailable(port)
    } catch (error) {
      this.logger.error({
        event: 'host.port_probe_failed',
        port,
        errorCode: systemErrorCode(error)
      })
      throw new AgentError(
        'OPERATION_FAILED',
        'Requested protocol port could not be checked',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
    if (!available) {
      throw new AgentError(
        'PORT_IN_USE',
        `Port ${port} is already in use`,
        HttpStatus.CONFLICT
      )
    }
  }

  async standardNginxActive(): Promise<boolean> {
    if (!existsSync('/usr/sbin/nginx')) return false
    const result = await this.processes.run(
      '/usr/bin/systemctl',
      ['is-active', '--quiet', 'nginx'],
      { rejectOnNonZero: false, timeoutMs: 5000, maxOutputBytes: 4096 }
    )
    return result.code === 0
  }

  baotaNginxActive(): boolean {
    try {
      return pidFileProcessActive(readFileSync(BAOTA_NGINX_PID_PATH, 'utf8'))
    } catch {
      return false
    }
  }

  certificateAvailable(domain: string): boolean {
    return [
      {
        cert: `/www/server/panel/vhost/cert/${domain}/fullchain.pem`,
        key: `/www/server/panel/vhost/cert/${domain}/privkey.pem`
      },
      {
        cert: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
        key: `/etc/letsencrypt/live/${domain}/privkey.pem`
      }
    ].some((item) => existsSync(item.cert) && existsSync(item.key))
  }
}

export function parseOsRelease(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    let item = line.slice(separator + 1).trim()
    if (
      (item.startsWith('"') && item.endsWith('"')) ||
      (item.startsWith("'") && item.endsWith("'"))
    ) {
      item = item.slice(1, -1)
    }
    result[key] = item.replace(/\\([\\"'$`])/g, '$1')
  }
  return result
}

export async function portAvailable(port: number): Promise<boolean> {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probePort(port)
      return true
    } catch (error) {
      const errorCode = systemErrorCode(error)
      if (errorCode === 'EACCES' && process.platform === 'linux') {
        return !linuxTcpPortListening(port)
      }
      if (errorCode !== 'EADDRINUSE') throw error
      if (attempt === attempts) return false
      await delay(100)
    }
  }
  return false
}

function probePort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '::', port, exclusive: true }, () => {
      server.close(() => resolve())
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function linuxTcpPortListening(port: number): boolean {
  return ['/proc/net/tcp', '/proc/net/tcp6'].some((path) => {
    try {
      return tcpTableHasListeningPort(readFileSync(path, 'utf8'), port)
    } catch (error) {
      if (systemErrorCode(error) === 'ENOENT') return false
      throw error
    }
  })
}

export function tcpTableHasListeningPort(value: string, port: number): boolean {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, '0')
  return value.split(/\r?\n/).some((line) => {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4 || columns[3] !== '0A') return false
    return columns[1]?.split(':').at(-1)?.toUpperCase() === expectedPort
  })
}

export function pidFileProcessActive(
  value: string,
  signalProcess: (pid: number, signal: 0) => boolean = (pid, signal) =>
    process.kill(pid, signal)
): boolean {
  const pid = value.trim()
  if (!/^[1-9]\d*$/.test(pid)) return false
  try {
    signalProcess(Number(pid), 0)
    return true
  } catch (error) {
    // The agent runs unprivileged while BaoTa's Nginx master is root-owned.
    // kill(pid, 0) reports EPERM when that process exists but cannot be signalled.
    return systemErrorCode(error) === 'EPERM'
  }
}

function systemErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code)
  }
  return 'UNKNOWN'
}
