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

export interface TrojanInstallInput {
  nodeId: number
  port: number
  domain: string
  proxyUrl: string | null
}

@Injectable()
export class TrojanProvisioningService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly inspector: HostInspectorService,
    private readonly helper: PrivilegedHelperService,
    private readonly state: StateStoreService
  ) {}

  async preflight(input: TrojanInstallInput): Promise<HostInspection> {
    const host = this.inspector.inspect()
    await this.inspector.assertDomainReady(input.domain)
    await this.inspector.assertPortAvailable(input.port)
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
    if (!this.config.trojanGoArchiveUrl || !this.config.trojanGoArchiveSha256) {
      throw new AgentError(
        'INVALID_REQUEST',
        'Trojan-Go artifact URL and SHA-256 are not configured',
        400
      )
    }
    return host
  }

  async install(
    input: TrojanInstallInput,
    host: HostInspection
  ): Promise<void> {
    const createsAcmeConfig =
      host.profile === 'ubuntu' &&
      !this.inspector.certificateAvailable(input.domain)
    const planPath = this.writePlan({
      schemaVersion: 1,
      action: 'install',
      nodeId: input.nodeId,
      hostProfile: host.profile,
      architecture: host.architecture,
      port: input.port,
      domain: input.domain,
      proxyUrl: input.proxyUrl,
      acmeEmail: this.config.acmeEmail
    })
    try {
      await this.helper.run('trojan-install', planPath)
      const resources = [
        ['systemd-unit', 'eagleway-trojan.service'],
        ['runtime-binary', '/usr/local/bin/trojan-go'],
        [
          'runtime-config',
          '/etc/eagleway-node-agent/runtimes/trojan-go/config.json'
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
          ownershipTag: 'eagleway-node-agent:trojan',
          createdAt: new Date().toISOString(),
          removedAt: null
        })
      }
      this.state.setMeta('trojan.requiresUserSync', 'true')
    } finally {
      safeUnlink(planPath)
    }
  }

  async uninstall(): Promise<void> {
    await this.helper.run('trojan-uninstall')
    for (const user of this.state.listManagedUsers('trojan')) {
      this.state.deleteManagedUser(user.assignmentKey)
    }
    this.state.setMeta('trojan.requiresUserSync', 'true')
    this.state.markOwnedResourcesRemoved('eagleway-node-agent:trojan')
  }

  start() {
    return this.helper.run('trojan-start')
  }

  stop() {
    return this.helper.run('trojan-stop')
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
