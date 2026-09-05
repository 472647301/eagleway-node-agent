import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap
} from '@nestjs/common'
import {
  AgentError,
  invalidRequest,
  operationConflict
} from '@/common/api/agent-error'
import { CredentialVaultService } from '@/state/credential-vault.service'
import { StateStoreService } from '@/state/state-store.service'
import type { NodeUserDto } from './xray.dto'
import { XrayClient } from './xray.client'
import {
  assignmentIdFromRuntimeUserId,
  isXrayProtocol,
  runtimeUserId,
  type XrayProtocol
} from './xray.types'

export interface NodeUserResult {
  assignmentId: string
  error?: string
}

@Injectable()
export class XrayAssignmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(XrayAssignmentsService.name)
  private serial = Promise.resolve()

  constructor(
    private readonly client: XrayClient,
    private readonly state: StateStoreService,
    private readonly vault: CredentialVaultService
  ) {}

  onApplicationBootstrap(): void {
    const protocol = this.installedProtocol()
    if (
      process.platform !== 'linux' ||
      !protocol ||
      !this.client.isInstalled()
    ) {
      return
    }
    void this.exclusive(async () => {
      try {
        if (!(await this.client.isActive())) return
        await this.restore(protocol)
      } catch {
        this.requiresSync(protocol, true)
        this.logger.error({
          event: 'xray.users_restore_failed',
          protocol
        })
      }
    })
  }

  restoreStoredUsers(protocol: XrayProtocol): Promise<void> {
    return this.exclusive(() => this.restore(protocol))
  }

  sync(
    protocol: XrayProtocol,
    users: NodeUserDto[]
  ): Promise<NodeUserResult[]> {
    assertUniqueAssignments(users)
    return this.exclusive(async () => {
      await this.assertRuntimeMutable(protocol)
      const results = await this.reconcileRuntime(protocol, users)
      this.requiresSync(
        protocol,
        results.some((item) => item.error)
      )
      return results
    })
  }

  add(protocol: XrayProtocol, users: NodeUserDto[]): Promise<NodeUserResult[]> {
    assertUniqueAssignments(users)
    return this.exclusive(async () => {
      await this.assertRuntimeMutable(protocol)
      const runtimeUsers = new Set(await this.client.listUserIds(protocol))
      const results: NodeUserResult[] = []
      for (const user of users) {
        try {
          await this.ensureUser(protocol, user, runtimeUsers)
          results.push({ assignmentId: user.assignmentId })
        } catch {
          results.push({
            assignmentId: user.assignmentId,
            error: 'USER_UPDATE_FAILED'
          })
        }
      }
      return results
    })
  }

  remove(
    protocol: XrayProtocol,
    assignmentIds: string[]
  ): Promise<NodeUserResult[]> {
    const ids = [...new Set(assignmentIds)]
    return this.exclusive(async () => {
      await this.assertRuntimeMutable(protocol)
      const runtimeUsers = new Set(await this.client.listUserIds(protocol))
      const results: NodeUserResult[] = []
      for (const assignmentId of ids) {
        const stored = this.state.findManagedUser(assignmentId)
        const userId =
          stored?.runtimeUserId ?? runtimeUserId(protocol, assignmentId)
        try {
          if (runtimeUsers.has(userId))
            await this.client.removeUser(protocol, userId)
          this.state.deleteManagedUser(assignmentId)
          results.push({ assignmentId })
        } catch {
          results.push({ assignmentId, error: 'USER_DELETE_FAILED' })
        }
      }
      return results
    })
  }

  async traffic(protocol: XrayProtocol, reportedAt: string) {
    const [runtimeUsers, counters, runtimeEpoch] = await Promise.all([
      this.client.listUserIds(protocol),
      this.client.userTraffic(),
      this.client.invocationId()
    ])
    const users = runtimeUsers.flatMap((userId) => {
      const assignmentId = assignmentIdFromRuntimeUserId(protocol, userId)
      if (!assignmentId) return []
      const traffic = counters.get(userId)
      return [
        {
          assignmentId,
          uploadBytes: traffic?.upload ?? '0',
          downloadBytes: traffic?.download ?? '0'
        }
      ]
    })
    return {
      reportedAt,
      runtimeEpoch,
      managedUserCount: runtimeUsers.length,
      users
    }
  }

  private async restore(protocol: XrayProtocol): Promise<void> {
    const stored = this.state.listManagedUsers(protocol)
    if (!stored.length) {
      this.requiresSync(protocol, true)
      return
    }
    const results = await this.reconcileRuntime(
      protocol,
      stored.map((item) => ({
        assignmentId: item.assignmentId,
        credential: this.vault.decrypt(item.encryptedCredential)
      }))
    )
    this.requiresSync(
      protocol,
      results.some((item) => item.error)
    )
  }

  private async reconcileRuntime(
    protocol: XrayProtocol,
    users: NodeUserDto[]
  ): Promise<NodeUserResult[]> {
    const runtimeUsers = new Set(await this.client.listUserIds(protocol))
    const desiredRuntimeIds = new Set<string>()
    const desiredAssignmentIds = new Set(users.map((item) => item.assignmentId))
    const results: NodeUserResult[] = []
    for (const user of users) {
      try {
        const userId = await this.ensureUser(protocol, user, runtimeUsers)
        desiredRuntimeIds.add(userId)
        results.push({ assignmentId: user.assignmentId })
      } catch {
        results.push({
          assignmentId: user.assignmentId,
          error: 'USER_SYNC_FAILED'
        })
      }
    }
    if (results.some((item) => item.error)) return results

    for (const userId of runtimeUsers) {
      if (!desiredRuntimeIds.has(userId)) {
        await this.client.removeUser(protocol, userId)
      }
    }
    for (const stored of this.state.listManagedUsers(protocol)) {
      if (!desiredAssignmentIds.has(stored.assignmentId)) {
        this.state.deleteManagedUser(stored.assignmentId)
      }
    }
    return results
  }

  private async ensureUser(
    protocol: XrayProtocol,
    user: NodeUserDto,
    runtimeUsers: Set<string>
  ): Promise<string> {
    const userId = runtimeUserId(protocol, user.assignmentId)
    const stored = this.state.findManagedUser(user.assignmentId)
    const credentialUnchanged =
      stored?.protocol === protocol &&
      stored.runtimeUserId === userId &&
      this.vault.decrypt(stored.encryptedCredential) === user.credential

    if (!credentialUnchanged && runtimeUsers.has(userId)) {
      await this.client.removeUser(protocol, userId)
      runtimeUsers.delete(userId)
    }
    if (!runtimeUsers.has(userId)) {
      await this.client.addUser(protocol, user.assignmentId, user.credential)
      runtimeUsers.add(userId)
    }
    this.state.upsertManagedUser({
      assignmentId: user.assignmentId,
      encryptedCredential: this.vault.encrypt(user.credential),
      protocol,
      runtimeUserId: userId,
      syncedAt: new Date().toISOString()
    })
    return userId
  }

  private async assertRuntimeMutable(protocol: XrayProtocol): Promise<void> {
    if (this.state.findActiveOperation('xray')) {
      throw operationConflict('Protocol lifecycle operation is active')
    }
    if (!this.client.isInstalled() || this.installedProtocol() !== protocol) {
      throw invalidRequest(`${protocol.toUpperCase()} is not installed`)
    }
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Xray is not running',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
  }

  private requiresSync(protocol: XrayProtocol, required: boolean): void {
    this.state.setMeta(`${protocol}.requiresUserSync`, String(required))
  }

  private installedProtocol(): XrayProtocol | null {
    const value = this.state.getMeta('xray.protocol')
    return value && isXrayProtocol(value) ? value : null
  }

  private exclusive<T>(handler: () => Promise<T>): Promise<T> {
    const next = this.serial.then(handler, handler)
    this.serial = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}

function assertUniqueAssignments(users: NodeUserDto[]): void {
  const ids = new Set<string>()
  for (const user of users) {
    if (ids.has(user.assignmentId)) {
      throw invalidRequest('Duplicate assignmentId in request')
    }
    ids.add(user.assignmentId)
  }
}
