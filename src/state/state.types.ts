export type OperationType = 'install' | 'uninstall'
export type OperationState = 'pending' | 'running' | 'succeeded' | 'failed'

export interface ManagedUserRecord {
  assignmentKey: string
  encryptedCredential: string
  protocol: string
  runtime: string
  runtimeUserHash: string
  ipLimit: number
  trafficLimitBytes: string | null
  syncedAt: string
}

export interface OperationRecord {
  operationId: string
  operationType: OperationType
  protocol: string
  requestFingerprint: string
  state: OperationState
  currentStage: string
  previousRuntimeState: string | null
  errorCode: string | null
  errorMessageSafe: string | null
  startedAt: string
  finishedAt: string | null
}

export interface OwnedResourceRecord {
  resourceType: string
  resourceName: string
  ownershipTag: string
  createdAt: string
  removedAt: string | null
}
