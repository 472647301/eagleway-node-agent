import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { promises as dns } from 'node:dns'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { AgentError } from '@/common/api/agent-error'

export type HostProfile = 'ubuntu' | 'ubuntu-baota'

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

  inspect(): HostInspection {
    if (process.platform !== 'linux') {
      throw new AgentError(
        'UNSUPPORTED_OS',
        'Only Ubuntu Linux is supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    const release = parseOsRelease(readFileSync('/etc/os-release', 'utf8'))
    if (release.ID !== 'ubuntu') {
      throw new AgentError(
        'UNSUPPORTED_OS',
        'Only Ubuntu Linux is supported',
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
    const baota = existsSync('/www/server/panel')
    if (baota && !existsSync('/www/server/nginx')) {
      throw new AgentError(
        'UNSUPPORTED_HOST_PROFILE',
        'Only BaoTa with Nginx is supported',
        HttpStatus.UNPROCESSABLE_ENTITY
      )
    }
    return {
      profile: baota ? 'ubuntu-baota' : 'ubuntu',
      osId: release.ID,
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
      if (systemErrorCode(error) !== 'EADDRINUSE') throw error
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

function systemErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code)
  }
  return 'UNKNOWN'
}
