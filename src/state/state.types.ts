export type OperationType = 'install' | 'uninstall' | 'reconfigure'
export type OperationState = 'pending' | 'running' | 'succeeded' | 'failed'

export interface ManagedUserRecord {
  assignmentId: string
  encryptedCredential: string
  protocol: string
  runtimeUserId: string
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

export interface RuntimeConfigRecord {
  revision: number
  protocol: string
  port: number
  domain: string
  proxyUrl: string | null
  configHash: string
}
