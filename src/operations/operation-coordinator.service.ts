import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { operationConflict } from '@/common/api/agent-error'
import { StateStoreService } from '@/state/state-store.service'
import type { OperationRecord, OperationType } from '@/state/state.types'

export interface OperationContext {
  operationId: string
  stage(name: string): void
}

@Injectable()
export class OperationCoordinatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OperationCoordinatorService.name)
  private running = false

  constructor(private readonly state: StateStoreService) {}

  onApplicationBootstrap(): void {
    const count = this.state.markInterruptedOperationsFailed()
    if (count) {
      this.logger.warn({ event: 'operation.interrupted_recovered', count })
    }
  }

  start(
    protocol: string,
    type: OperationType,
    input: unknown,
    handler: (context: OperationContext) => Promise<void>,
    previousRuntimeState: string | null = null
  ): OperationRecord {
    const fingerprint = createHash('sha256')
      .update(stableStringify(input))
      .digest('hex')
    const matching = this.state.findMatchingOperation(
      protocol,
      type,
      fingerprint
    )
    if (matching) return matching
    const active = this.state.findActiveOperation(protocol)
    if (active || this.running) {
      throw operationConflict('Another host-changing operation is active')
    }
    const now = new Date().toISOString()
    const operation: OperationRecord = {
      operationId: randomUUID(),
      operationType: type,
      protocol,
      requestFingerprint: fingerprint,
      state: 'pending',
      currentStage: 'queued',
      previousRuntimeState,
      errorCode: null,
      errorMessageSafe: null,
      startedAt: now,
      finishedAt: null
    }
    this.state.createOperation(operation)
    this.running = true
    void this.execute(operation, handler)
    return operation
  }

  private async execute(
    operation: OperationRecord,
    handler: (context: OperationContext) => Promise<void>
  ): Promise<void> {
    const context: OperationContext = {
      operationId: operation.operationId,
      stage: (name) => {
        this.state.updateOperation(operation.operationId, {
          state: 'running',
          currentStage: name
        })
      }
    }
    try {
      context.stage('starting')
      await handler(context)
      this.state.updateOperation(operation.operationId, {
        state: 'succeeded',
        currentStage: 'complete',
        finishedAt: new Date().toISOString()
      })
      this.logger.log({
        event: 'operation.succeeded',
        operationId: operation.operationId,
        protocol: operation.protocol,
        type: operation.operationType
      })
    } catch (error) {
      const safe = operationFailure(error)
      this.state.updateOperation(operation.operationId, {
        state: 'failed',
        currentStage: 'failed',
        errorCode: safe.errorCode,
        errorMessageSafe: safe.message,
        finishedAt: new Date().toISOString()
      })
      this.logger.error({
        event: 'operation.failed',
        operationId: operation.operationId,
        protocol: operation.protocol,
        type: operation.operationType,
        errorCode: safe.errorCode
      })
    } finally {
      this.running = false
    }
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function operationFailure(error: unknown): {
  errorCode: string
  message: string
} {
  if (
    error &&
    typeof error === 'object' &&
    'errorCode' in error &&
    typeof error.errorCode === 'string'
  ) {
    return {
      errorCode: error.errorCode,
      message:
        'safeMessage' in error && typeof error.safeMessage === 'string'
          ? error.safeMessage
          : 'Operation failed'
    }
  }
  return { errorCode: 'OPERATION_FAILED', message: 'Operation failed' }
}
