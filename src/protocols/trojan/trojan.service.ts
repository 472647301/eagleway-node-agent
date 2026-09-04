import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import { AgentError, invalidRequest } from '@/common/api/agent-error'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { OperationCoordinatorService } from '@/operations/operation-coordinator.service'
import { StateStoreService } from '@/state/state-store.service'
import { TrojanAssignmentsService } from './trojan-assignments.service'
import type {
  NodeRequestDto,
  TrojanControlDto,
  TrojanUserSyncDto,
  TrojanUserUpdateDto
} from './trojan.dto'
import { TrojanGoClient } from './trojan-go.client'
import { TrojanProvisioningService } from './trojan-provisioning.service'

@Injectable()
export class TrojanService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: TrojanGoClient,
    private readonly provisioning: TrojanProvisioningService,
    private readonly assignments: TrojanAssignmentsService,
    private readonly operations: OperationCoordinatorService,
    private readonly state: StateStoreService
  ) {}

  async install(body: TrojanControlDto) {
    this.assertNode(body.nodeId)
    if (!body.port) throw invalidRequest('port is required for install')
    if (!body.domain) throw invalidRequest('domain is required for install')
    const latest = this.state.latestOperation('trojan')
    if (this.client.isInstalled() && latest?.state !== 'failed') {
      return { operationId: null, state: await this.runtimeState() }
    }
    const input = {
      nodeId: body.nodeId,
      port: body.port,
      domain: body.domain,
      proxyUrl: body.proxyUrl ?? null
    }
    const host = await this.provisioning.preflight(input)
    const operation = this.operations.start(
      'trojan',
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

  async uninstall(body: NodeRequestDto) {
    this.assertNode(body.nodeId)
    if (!this.client.hasManagedResources()) {
      return { operationId: null, state: 'not_installed' }
    }
    const previous = await this.runtimeState()
    const operation = this.operations.start(
      'trojan',
      'uninstall',
      { nodeId: body.nodeId },
      async (context) => {
        context.stage('removing-runtime')
        await this.provisioning.uninstall()
      },
      previous
    )
    return { operationId: operation.operationId, state: 'uninstalling' }
  }

  async start(body: NodeRequestDto) {
    this.assertNode(body.nodeId)
    this.assertNoLifecycleOperation()
    if (!this.client.isInstalled())
      throw invalidRequest('Trojan is not installed')
    await this.provisioning.start()
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Trojan failed to start',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    await this.assignments.restoreStoredUsers()
    this.state.setMeta('trojan.lastControlSuccessAt', new Date().toISOString())
    return { operationId: null, state: 'online' }
  }

  async stop(body: NodeRequestDto) {
    this.assertNode(body.nodeId)
    this.assertNoLifecycleOperation()
    if (!this.client.isInstalled())
      throw invalidRequest('Trojan is not installed')
    await this.provisioning.stop()
    if (await this.client.isActive()) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Trojan failed to stop',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    this.state.setMeta('trojan.lastControlSuccessAt', new Date().toISOString())
    return { operationId: null, state: 'stopped' }
  }

  async syncUsers(body: TrojanUserSyncDto) {
    this.assertNode(body.nodeId)
    return this.assignments.sync(body.users)
  }

  async updateUsers(body: TrojanUserUpdateDto) {
    this.assertNode(body.nodeId)
    if (body.action === 'add') {
      if (!body.users) throw invalidRequest('users is required for add')
      if (body.assignmentKeys)
        throw invalidRequest('assignmentKeys is not allowed for add')
      return this.assignments.add(body.users)
    }
    if (!body.assignmentKeys) {
      throw invalidRequest('assignmentKeys is required for delete')
    }
    if (body.users) throw invalidRequest('users is not allowed for delete')
    return this.assignments.remove(body.assignmentKeys)
  }

  async status(body: NodeRequestDto) {
    this.assertNode(body.nodeId)
    const active = this.state.findActiveOperation('trojan')
    const latest = this.state.latestOperation('trojan')
    const observedRuntimeState = await this.runtimeState()
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
    const controlSuccessAt = this.state.getMeta('trojan.lastControlSuccessAt')
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
      protocol: 'trojan',
      runtime: 'trojan-go',
      runtimeVersion: await this.client.version(),
      state: runtimeState,
      startedAt: null,
      requiresUserSync:
        this.state.getMeta('trojan.requiresUserSync') !== 'false',
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

  async traffic(body: NodeRequestDto) {
    this.assertNode(body.nodeId)
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Trojan is not running',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
    return this.assignments.traffic(this.state.nextReportedAt())
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
    if (this.state.findActiveOperation('trojan')) {
      throw new AgentError(
        'OPERATION_CONFLICT',
        'Protocol lifecycle operation is active',
        HttpStatus.CONFLICT
      )
    }
  }

  private async runtimeState(): Promise<
    'not_installed' | 'stopped' | 'online'
  > {
    if (!this.client.isInstalled()) return 'not_installed'
    return (await this.client.isActive()) ? 'online' : 'stopped'
  }
}
