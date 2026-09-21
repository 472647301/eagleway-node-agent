import { Inject, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { AgentError } from '@/common/api/agent-error'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import {
  HostInspectorService,
  type HostInspection,
  type HostProfile
} from '@/host/host-inspector.service'
import {
  CERTBOT_XRAY_DEPLOY_HOOK,
  EAGLEWAY_CERTBOT_HOOK_MARKER
} from '@/host/certificate-renewal'
import { EAGLEWAY_NGINX_MARKER, baotaAcmeConfigPath } from '@/host/nginx-acme'
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
  private readonly logger = new Logger(XrayProvisioningService.name)

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
    if (
      host.profile === 'ubuntu' &&
      !certificateAvailable &&
      !(await this.inspector.standardNginxActive())
    ) {
      await this.inspector.assertPortAvailable(80)
    }
    return host
  }

  async install(input: XrayInstallInput, host: HostInspection): Promise<void> {
    const acmeConfigPath = this.acmeConfigCandidate(host.profile, input.domain)
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
      try {
        await this.helper.run('xray-install', planPath)
      } catch (error) {
        await this.cleanupFailedInstall()
        throw error
      }
      const resources = [
        ['systemd-unit', 'eagleway-xray.service'],
        ['runtime-binary', '/usr/local/bin/xray'],
        [
          'runtime-config',
          '/etc/eagleway-node-agent/runtimes/xray/config.json'
        ],
        ...(isManagedFile(
          CERTBOT_XRAY_DEPLOY_HOOK,
          EAGLEWAY_CERTBOT_HOOK_MARKER
        )
          ? ([['certbot-hook', CERTBOT_XRAY_DEPLOY_HOOK]] as string[][])
          : []),
        ...(acmeConfigPath && isManagedNginxConfig(acmeConfigPath)
          ? ([['nginx-config', acmeConfigPath]] as string[][])
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
    const acmeConfigPath = this.acmeConfigCandidate(host.profile, input.domain)
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
      if (acmeConfigPath && isManagedNginxConfig(acmeConfigPath)) {
        this.state.registerOwnedResource({
          resourceType: 'nginx-config',
          resourceName: acmeConfigPath,
          ownershipTag: 'eagleway-node-agent:xray',
          createdAt: new Date().toISOString(),
          removedAt: null
        })
      }
      if (
        isManagedFile(CERTBOT_XRAY_DEPLOY_HOOK, EAGLEWAY_CERTBOT_HOOK_MARKER)
      ) {
        this.state.registerOwnedResource({
          resourceType: 'certbot-hook',
          resourceName: CERTBOT_XRAY_DEPLOY_HOOK,
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

  async cleanupPartialInstall(): Promise<void> {
    await this.helper.run('xray-uninstall')
  }

  start() {
    return this.helper.run('xray-start')
  }

  stop() {
    return this.helper.run('xray-stop')
  }

  private acmeConfigCandidate(
    hostProfile: HostProfile,
    domain: string
  ): string | null {
    if (this.inspector.certificateAvailable(domain)) return null
    return hostProfile === 'ubuntu-baota'
      ? baotaAcmeConfigPath(domain)
      : `/etc/nginx/conf.d/eagleway-acme-${domain}.conf`
  }

  private writePlan(value: object): string {
    const directory = join(this.config.stateDir, 'staging')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `install-${randomUUID()}.json`)
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    return path
  }

  private async cleanupFailedInstall(): Promise<void> {
    try {
      await this.helper.run('xray-uninstall')
    } catch (error) {
      this.logger.error({
        event: 'xray.install_cleanup_failed',
        errorCode: operationErrorCode(error)
      })
    }
  }
}

function operationErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'errorCode' in error &&
    typeof error.errorCode === 'string'
  ) {
    return error.errorCode
  }
  return 'OPERATION_FAILED'
}

function isManagedNginxConfig(path: string): boolean {
  return isManagedFile(path, EAGLEWAY_NGINX_MARKER)
}

function isManagedFile(path: string, marker: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, 'utf8').startsWith(marker)
  } catch {
    return false
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
