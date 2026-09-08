import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentError } from '@/common/api/agent-error'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import {
  HostInspectorService,
  type HostInspection
} from '@/host/host-inspector.service'
import { PrivilegedHelperService } from '@/host/privileged-helper.service'
import { StateStoreService } from '@/state/state-store.service'
import { XRAY_PROTOCOLS, type XrayProtocol } from './xray.types'

export interface XrayInstallInput {
  nodeId: number
  protocol: XrayProtocol
  revision: number
  port: number
  domain: string
  proxyUrl: string | null
}

@Injectable()
export class XrayProvisioningService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly inspector: HostInspectorService,
    private readonly helper: PrivilegedHelperService,
    private readonly state: StateStoreService
  ) {}

  async preflight(
    input: XrayInstallInput,
    currentPort: number | null = null
  ): Promise<HostInspection> {
    const apiPort = Number(this.config.xrayApiAddress.split(':')[1])
    if (input.port === 80 || input.port === apiPort) {
      throw new AgentError(
        'INVALID_REQUEST',
        'Protocol port conflicts with an Agent-managed local service',
        400
      )
    }
    const host = this.inspector.inspect()
    await this.inspector.assertDomainReady(input.domain)
    if (currentPort !== input.port) {
      await this.inspector.assertPortAvailable(input.port)
    }
    const certificateAvailable = this.inspector.certificateAvailable(
      input.domain
    )
    if (host.profile === 'ubuntu-baota' && !certificateAvailable) {
      throw new AgentError(
        'CERTIFICATE_UNAVAILABLE',
        'Issue a certificate for this domain in BaoTa before installing',
        422
      )
    }
    if (host.profile === 'ubuntu' && !certificateAvailable) {
      await this.inspector.assertPortAvailable(80)
    }
    return host
  }

  async install(input: XrayInstallInput, host: HostInspection): Promise<void> {
    const createsAcmeConfig =
      host.profile === 'ubuntu' &&
      !this.inspector.certificateAvailable(input.domain)
    const planPath = this.writePlan({
      schemaVersion: 1,
      action: 'install',
      nodeId: input.nodeId,
      protocol: input.protocol,
      revision: input.revision,
      hostProfile: host.profile,
      architecture: host.architecture,
      port: input.port,
      domain: input.domain,
      proxyUrl: input.proxyUrl,
      apiAddress: this.config.xrayApiAddress,
      acmeEmail: this.config.acmeEmail
    })
    try {
      await this.helper.run('xray-install', planPath)
      const resources = [
        ['systemd-unit', 'eagleway-xray.service'],
        ['runtime-binary', '/usr/local/bin/xray'],
        [
          'runtime-config',
          '/etc/eagleway-node-agent/runtimes/xray/config.json'
        ],
        ...(createsAcmeConfig
          ? ([
              [
                'nginx-config',
                `/etc/nginx/conf.d/eagleway-acme-${input.domain}.conf`
              ]
            ] as string[][])
          : [])
      ]
      for (const [resourceType, resourceName] of resources) {
        this.state.registerOwnedResource({
          resourceType: resourceType!,
          resourceName: resourceName!,
          ownershipTag: 'eagleway-node-agent:xray',
          createdAt: new Date().toISOString(),
          removedAt: null
        })
      }
      this.state.setMeta('xray.protocol', input.protocol)
      this.state.setMeta(`${input.protocol}.requiresUserSync`, 'true')
    } finally {
      safeUnlink(planPath)
    }
  }

  async applyConfig(
    input: XrayInstallInput,
    host: HostInspection
  ): Promise<void> {
    const createsAcmeConfig =
      host.profile === 'ubuntu' &&
      !this.inspector.certificateAvailable(input.domain)
    const planPath = this.writePlan({
      schemaVersion: 1,
      action: 'apply-config',
      nodeId: input.nodeId,
      protocol: input.protocol,
      revision: input.revision,
      hostProfile: host.profile,
      architecture: host.architecture,
      port: input.port,
      domain: input.domain,
      proxyUrl: input.proxyUrl,
      apiAddress: this.config.xrayApiAddress,
      acmeEmail: this.config.acmeEmail
    })
    try {
      await this.helper.run('xray-apply-config', planPath)
      if (createsAcmeConfig) {
        this.state.registerOwnedResource({
          resourceType: 'nginx-config',
          resourceName: `/etc/nginx/conf.d/eagleway-acme-${input.domain}.conf`,
          ownershipTag: 'eagleway-node-agent:xray',
          createdAt: new Date().toISOString(),
          removedAt: null
        })
      }
    } finally {
      safeUnlink(planPath)
    }
  }

  async uninstall(): Promise<void> {
    await this.helper.run('xray-uninstall')
    for (const protocol of XRAY_PROTOCOLS) {
      for (const user of this.state.listManagedUsers(protocol)) {
        this.state.deleteManagedUser(user.assignmentId)
      }
      this.state.setMeta(`${protocol}.requiresUserSync`, 'true')
    }
    this.state.deleteMeta('xray.protocol')
    this.state.deleteRuntimeConfig()
    this.state.markOwnedResourcesRemoved('eagleway-node-agent:xray')
  }

  start() {
    return this.helper.run('xray-start')
  }

  stop() {
    return this.helper.run('xray-stop')
  }

  private writePlan(value: object): string {
    const directory = join(this.config.stateDir, 'staging')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `install-${randomUUID()}.json`)
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    return path
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
}
