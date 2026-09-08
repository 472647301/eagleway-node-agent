import { Injectable } from '@nestjs/common'
import { DatabaseService } from './database.service'
import type {
  ManagedUserRecord,
  OperationRecord,
  OperationState,
  OperationType,
  OwnedResourceRecord,
  RuntimeConfigRecord
} from './state.types'

type ManagedUserRow = {
  assignment_id: string
  encrypted_credential: string
  protocol: string
  runtime_user_id: string
  synced_at: string
}

type OperationRow = {
  operation_id: string
  operation_type: OperationType
  protocol: string
  request_fingerprint: string
  state: OperationState
  current_stage: string
  previous_runtime_state: string | null
  error_code: string | null
  error_message_safe: string | null
  started_at: string
  finished_at: string | null
}

@Injectable()
export class StateStoreService {
  constructor(private readonly database: DatabaseService) {}

  listManagedUsers(protocol: string): ManagedUserRecord[] {
    const rows = this.database.db
      .prepare(
        `SELECT assignment_id, encrypted_credential, protocol,
                runtime_user_id, synced_at
           FROM managed_users WHERE protocol = ? ORDER BY assignment_id`
      )
      .all(protocol) as ManagedUserRow[]
    return rows.map(mapManagedUser)
  }

  findManagedUser(assignmentId: string): ManagedUserRecord | null {
    const row = this.database.db
      .prepare(
        `SELECT assignment_id, encrypted_credential, protocol,
                runtime_user_id, synced_at
           FROM managed_users WHERE assignment_id = ?`
      )
      .get(assignmentId) as ManagedUserRow | undefined
    return row ? mapManagedUser(row) : null
  }

  upsertManagedUser(record: ManagedUserRecord): void {
    this.database.db
      .prepare(
        `INSERT INTO managed_users
          (assignment_id, encrypted_credential, protocol, runtime_user_id, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(assignment_id) DO UPDATE SET
           encrypted_credential = excluded.encrypted_credential,
           protocol = excluded.protocol,
           runtime_user_id = excluded.runtime_user_id,
           synced_at = excluded.synced_at`
      )
      .run(
        record.assignmentId,
        record.encryptedCredential,
        record.protocol,
        record.runtimeUserId,
        record.syncedAt
      )
  }

  deleteManagedUser(assignmentId: string): void {
    this.database.db
      .prepare('DELETE FROM managed_users WHERE assignment_id = ?')
      .run(assignmentId)
  }

  createOperation(record: OperationRecord): void {
    this.database.db
      .prepare(
        `INSERT INTO operations
          (operation_id, operation_type, protocol, request_fingerprint, state,
           current_stage, previous_runtime_state, error_code,
           error_message_safe, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.operationId,
        record.operationType,
        record.protocol,
        record.requestFingerprint,
        record.state,
        record.currentStage,
        record.previousRuntimeState,
        record.errorCode,
        record.errorMessageSafe,
        record.startedAt,
        record.finishedAt
      )
  }

  updateOperation(
    operationId: string,
    changes: Partial<
      Pick<
        OperationRecord,
        | 'state'
        | 'currentStage'
        | 'errorCode'
        | 'errorMessageSafe'
        | 'finishedAt'
      >
    >
  ): void {
    const entries = Object.entries(changes)
    if (!entries.length) return
    const columns: Record<string, string> = {
      state: 'state',
      currentStage: 'current_stage',
      errorCode: 'error_code',
      errorMessageSafe: 'error_message_safe',
      finishedAt: 'finished_at'
    }
    const set = entries.map(([key]) => `${columns[key]} = ?`).join(', ')
    this.database.db
      .prepare(`UPDATE operations SET ${set} WHERE operation_id = ?`)
      .run(...entries.map(([, value]) => value), operationId)
  }

  findActiveOperation(protocol: string): OperationRecord | null {
    const row = this.database.db
      .prepare(
        `SELECT * FROM operations
          WHERE protocol = ? AND state IN ('pending', 'running')
          ORDER BY started_at DESC LIMIT 1`
      )
      .get(protocol) as OperationRow | undefined
    return row ? mapOperation(row) : null
  }

  findMatchingOperation(
    protocol: string,
    type: OperationType,
    fingerprint: string
  ): OperationRecord | null {
    const row = this.database.db
      .prepare(
        `SELECT * FROM operations
          WHERE protocol = ? AND operation_type = ? AND request_fingerprint = ?
            AND state IN ('pending', 'running')
          ORDER BY started_at DESC LIMIT 1`
      )
      .get(protocol, type, fingerprint) as OperationRow | undefined
    return row ? mapOperation(row) : null
  }

  latestOperation(protocol: string): OperationRecord | null {
    const row = this.database.db
      .prepare(
        'SELECT * FROM operations WHERE protocol = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(protocol) as OperationRow | undefined
    return row ? mapOperation(row) : null
  }

  markInterruptedOperationsFailed(): number {
    return this.database.db
      .prepare(
        `UPDATE operations
            SET state = 'failed', current_stage = 'interrupted',
                error_code = 'OPERATION_INTERRUPTED',
                error_message_safe = 'Agent restarted during operation',
                finished_at = ?
          WHERE state IN ('pending', 'running')`
      )
      .run(new Date().toISOString()).changes
  }

  nextReportedAt(now = new Date()): string {
    return this.database.db.transaction(() => {
      const row = this.database.db
        .prepare('SELECT last_reported_at FROM report_state WHERE id = 1')
        .get() as { last_reported_at: string | null }
      const previous = row.last_reported_at
        ? new Date(row.last_reported_at).getTime()
        : 0
      const value = new Date(
        Math.max(now.getTime(), previous + 1)
      ).toISOString()
      this.database.db
        .prepare('UPDATE report_state SET last_reported_at = ? WHERE id = 1')
        .run(value)
      return value
    })()
  }

  markReportSuccess(at: string): void {
    this.database.db
      .prepare(
        `UPDATE report_state
            SET last_success_at = ?, consecutive_failures = 0, next_retry_at = NULL
          WHERE id = 1`
      )
      .run(at)
  }

  markReportFailure(nextRetryAt: string): void {
    this.database.db
      .prepare(
        `UPDATE report_state
            SET consecutive_failures = consecutive_failures + 1,
                next_retry_at = ?
          WHERE id = 1`
      )
      .run(nextRetryAt)
  }

  setMeta(key: string, value: string): void {
    this.database.db
      .prepare(
        `INSERT INTO agent_meta(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString())
  }

  getMeta(key: string): string | null {
    const row = this.database.db
      .prepare('SELECT value FROM agent_meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  deleteMeta(key: string): void {
    this.database.db.prepare('DELETE FROM agent_meta WHERE key = ?').run(key)
  }

  runtimeConfig(): RuntimeConfigRecord | null {
    const value = this.getMeta('xray.runtimeConfig')
    if (!value) return null
    try {
      const parsed = JSON.parse(value) as Partial<RuntimeConfigRecord>
      if (
        !Number.isSafeInteger(parsed.revision) ||
        Number(parsed.revision) < 1 ||
        typeof parsed.protocol !== 'string' ||
        !Number.isSafeInteger(parsed.port) ||
        Number(parsed.port) < 1 ||
        Number(parsed.port) > 65_535 ||
        typeof parsed.domain !== 'string' ||
        (parsed.proxyUrl !== null && typeof parsed.proxyUrl !== 'string') ||
        typeof parsed.configHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(parsed.configHash)
      ) {
        return null
      }
      return parsed as RuntimeConfigRecord
    } catch {
      return null
    }
  }

  setRuntimeConfig(config: RuntimeConfigRecord): void {
    this.setMeta('xray.runtimeConfig', JSON.stringify(config))
  }

  deleteRuntimeConfig(): void {
    this.deleteMeta('xray.runtimeConfig')
  }

  registerOwnedResource(record: OwnedResourceRecord): void {
    this.database.db
      .prepare(
        `INSERT INTO owned_resources
          (resource_type, resource_name, ownership_tag, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_name) DO UPDATE SET
           ownership_tag = excluded.ownership_tag,
           removed_at = excluded.removed_at`
      )
      .run(
        record.resourceType,
        record.resourceName,
        record.ownershipTag,
        record.createdAt,
        record.removedAt
      )
  }

  markOwnedResourcesRemoved(ownershipTag: string): void {
    this.database.db
      .prepare(
        `UPDATE owned_resources SET removed_at = ?
          WHERE ownership_tag = ? AND removed_at IS NULL`
      )
      .run(new Date().toISOString(), ownershipTag)
  }
}

function mapManagedUser(row: ManagedUserRow): ManagedUserRecord {
  return {
    assignmentId: row.assignment_id,
    encryptedCredential: row.encrypted_credential,
    protocol: row.protocol,
    runtimeUserId: row.runtime_user_id,
    syncedAt: row.synced_at
  }
}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    operationType: row.operation_type,
    protocol: row.protocol,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    currentStage: row.current_stage,
    previousRuntimeState: row.previous_runtime_state,
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}
