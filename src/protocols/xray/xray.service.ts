import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import { AgentError, invalidRequest } from '@/common/api/agent-error'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { OperationCoordinatorService } from '@/operations/operation-coordinator.service'
import { StateStoreService } from '@/state/state-store.service'
import { XrayAssignmentsService } from './xray-assignments.service'
import { XrayClient } from './xray.client'
import type {
  NodeRequestDto,
  ProtocolControlDto,
  ProtocolUserSyncDto,
  ProtocolUserUpdateDto
} from './xray.dto'
import { XrayProvisioningService } from './xray-provisioning.service'
import { isXrayProtocol, type XrayProtocol } from './xray.types'

@Injectable()
export class XrayService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: XrayClient,
    private readonly provisioning: XrayProvisioningService,
    private readonly assignments: XrayAssignmentsService,
    private readonly operations: OperationCoordinatorService,
    private readonly state: StateStoreService
  ) {}

  async install(protocolValue: string, body: ProtocolControlDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    if (!body.port) throw invalidRequest('port is required for install')
    if (!body.domain) throw invalidRequest('domain is required for install')
    const installedProtocol = this.installedProtocol()
    if (
      this.client.hasManagedResources() &&
      installedProtocol &&
      installedProtocol !== protocol
    ) {
      throw invalidRequest(
        `Xray is already installed for ${installedProtocol}; uninstall it before changing protocol`
      )
    }
    const latest = this.state.latestOperation('xray')
    if (this.client.isInstalled() && latest?.state !== 'failed') {
      return { operationId: null, state: await this.runtimeState(protocol) }
    }
    const input = {
      nodeId: body.nodeId,
      protocol,
      port: body.port,
      domain: body.domain,
      proxyUrl: body.proxyUrl ?? null
    }
    const host = await this.provisioning.preflight(input)
    const operation = this.operations.start(
      'xray',
      'install',
      input,
      async (context) => {
        context.stage('installing-runtime')
        await this.provisioning.install(input, host)
      },
      'not_installed'
    )
    return { operationId: operation.operationId, state: 'installing' }
  }

  async uninstall(protocolValue: string, body: NodeRequestDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    this.assertInstalledProtocol(protocol, false)
    if (!this.client.hasManagedResources()) {
      return { operationId: null, state: 'not_installed' }
    }
    const previous = await this.runtimeState(protocol)
    const operation = this.operations.start(
      'xray',
      'uninstall',
      { nodeId: body.nodeId, protocol },
      async (context) => {
        context.stage('removing-runtime')
        await this.provisioning.uninstall()
      },
      previous
    )
    return { operationId: operation.operationId, state: 'uninstalling' }
  }

  async start(protocolValue: string, body: NodeRequestDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    this.assertNoLifecycleOperation()
    this.assertInstalledProtocol(protocol)
    await this.provisioning.start()
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Xray failed to start',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    await this.assignments.restoreStoredUsers(protocol)
    this.state.setMeta('xray.lastControlSuccessAt', new Date().toISOString())
    return { operationId: null, state: 'online' }
  }

  async stop(protocolValue: string, body: NodeRequestDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    this.assertNoLifecycleOperation()
    this.assertInstalledProtocol(protocol)
    await this.provisioning.stop()
    if (await this.client.isActive()) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Xray failed to stop',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    this.state.setMeta('xray.lastControlSuccessAt', new Date().toISOString())
    return { operationId: null, state: 'stopped' }
  }

  async syncUsers(protocolValue: string, body: ProtocolUserSyncDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    return this.assignments.sync(protocol, body.users)
  }

  async updateUsers(protocolValue: string, body: ProtocolUserUpdateDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    if (body.action === 'add') {
      if (!body.users) throw invalidRequest('users is required for add')
      if (body.assignmentIds) {
        throw invalidRequest('assignmentIds is not allowed for add')
      }
      return this.assignments.add(protocol, body.users)
    }
    if (!body.assignmentIds) {
      throw invalidRequest('assignmentIds is required for delete')
    }
    if (body.users) throw invalidRequest('users is not allowed for delete')
    return this.assignments.remove(protocol, body.assignmentIds)
  }

  async status(protocolValue: string, body: NodeRequestDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    const active = this.state.findActiveOperation('xray')
    const latest = this.state.latestOperation('xray')
    const observedRuntimeState = await this.runtimeState(protocol)
    if (
      !active &&
      latest?.state === 'failed' &&
      latest.errorCode === 'OPERATION_INTERRUPTED' &&
      ((latest.operationType === 'install' &&
        observedRuntimeState === 'online') ||
        (latest.operationType === 'uninstall' &&
          !this.client.hasManagedResources()))
    ) {
      this.state.updateOperation(latest.operationId, {
        state: 'succeeded',
        currentStage: 'recovered',
        errorCode: null,
        errorMessageSafe: null,
        finishedAt: new Date().toISOString()
      })
      latest.state = 'succeeded'
      latest.errorCode = null
      latest.errorMessageSafe = null
    }
    const controlSuccessAt = this.state.getMeta('xray.lastControlSuccessAt')
    const unresolvedFailure =
      latest?.state === 'failed' &&
      (!controlSuccessAt ||
        !latest.finishedAt ||
        latest.finishedAt > controlSuccessAt)
    const runtimeState = active
      ? active.operationType === 'install'
        ? 'installing'
        : 'uninstalling'
      : unresolvedFailure
        ? 'error'
        : observedRuntimeState
    return {
      nodeId: this.config.nodeId,
      protocol,
      runtime: 'xray-core',
      runtimeVersion: await this.client.version(),
      state: runtimeState,
      startedAt: null,
      requiresUserSync:
        this.state.getMeta(`${protocol}.requiresUserSync`) !== 'false',
      activeOperation: active
        ? {
            operationId: active.operationId,
            type: active.operationType,
            stage: active.currentStage,
            startedAt: active.startedAt
          }
        : null,
      lastError: unresolvedFailure
        ? {
            errorCode: latest.errorCode,
            message: latest.errorMessageSafe,
            finishedAt: latest.finishedAt
          }
        : null
    }
  }

  async traffic(protocolValue: string, body: NodeRequestDto) {
    const protocol = this.protocol(protocolValue)
    this.assertNode(body.nodeId)
    this.assertInstalledProtocol(protocol)
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Xray is not running',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    return this.trafficReport(protocol)
  }

  trafficReport(protocol: XrayProtocol) {
    return this.assignments
      .traffic(protocol, this.state.nextReportedAt())
      .then((report) => ({
        ...report,
        bandwidthMbps: this.config.serverBandwidthMbps
      }))
  }

  getInstalledProtocol(): XrayProtocol | null {
    return this.installedProtocol()
  }

  private assertNode(nodeId: number): void {
    if (nodeId !== this.config.nodeId) {
      throw new AgentError(
        'NODE_ID_MISMATCH',
        'Request nodeId does not match this agent',
        HttpStatus.FORBIDDEN
      )
    }
  }

  private assertNoLifecycleOperation(): void {
    if (this.state.findActiveOperation('xray')) {
      throw new AgentError(
        'OPERATION_CONFLICT',
        'Protocol lifecycle operation is active',
        HttpStatus.CONFLICT
      )
    }
  }

  private assertInstalledProtocol(
    protocol: XrayProtocol,
    requireResources = true
  ): void {
    const installed = this.installedProtocol()
    if (installed && installed !== protocol) {
      throw invalidRequest(
        `Xray is installed for ${installed}, not ${protocol}`
      )
    }
    if (
      requireResources &&
      (!this.client.isInstalled() || installed !== protocol)
    ) {
      throw invalidRequest(`${protocol.toUpperCase()} is not installed`)
    }
  }

  private installedProtocol(): XrayProtocol | null {
    const value = this.state.getMeta('xray.protocol')
    return value && isXrayProtocol(value) ? value : null
  }

  private protocol(value: string): XrayProtocol {
    if (!isXrayProtocol(value)) throw invalidRequest('Protocol is unsupported')
    return value
  }

  private async runtimeState(
    protocol: XrayProtocol
  ): Promise<'not_installed' | 'stopped' | 'online'> {
    if (!this.client.isInstalled() || this.installedProtocol() !== protocol) {
      return 'not_installed'
    }
    return (await this.client.isActive()) ? 'online' : 'stopped'
  }
}
