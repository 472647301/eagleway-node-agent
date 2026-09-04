import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap
} from '@nestjs/common'
import {
  AgentError,
  operationConflict,
  invalidRequest
} from '@/common/api/agent-error'
import { CredentialVaultService } from '@/state/credential-vault.service'
import { StateStoreService } from '@/state/state-store.service'
import type { NodeUserDto } from './trojan.dto'
import { TrojanGoClient, type TrojanProfile } from './trojan-go.client'

export interface NodeUserResult {
  assignmentKey: string
  hash?: string
  error?: string
}

@Injectable()
export class TrojanAssignmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrojanAssignmentsService.name)
  private serial = Promise.resolve()

  constructor(
    private readonly client: TrojanGoClient,
    private readonly state: StateStoreService,
    private readonly vault: CredentialVaultService
  ) {}

  onApplicationBootstrap(): void {
    if (process.platform !== 'linux' || !this.client.isInstalled()) return
    void this.exclusive(async () => {
      try {
        if (!(await this.client.isActive())) return
        const stored = this.state.listManagedUsers('trojan')
        if (!stored.length) {
          this.state.setMeta('trojan.requiresUserSync', 'true')
          return
        }
        await this.reconcileRuntime(
          stored.map((item) => ({
            assignmentKey: item.assignmentKey,
            credential: this.vault.decrypt(item.encryptedCredential),
            ipLimit: item.ipLimit,
            trafficLimitBytes: item.trafficLimitBytes,
            connectionOptions: null
          }))
        )
      } catch {
        this.state.setMeta('trojan.requiresUserSync', 'true')
        this.logger.error({ event: 'trojan.users_restore_failed' })
      }
    })
  }

  restoreStoredUsers(): Promise<void> {
    return this.exclusive(async () => {
      const stored = this.state.listManagedUsers('trojan')
      if (!stored.length) {
        this.state.setMeta('trojan.requiresUserSync', 'true')
        return
      }
      const results = await this.reconcileRuntime(
        stored.map((item) => ({
          assignmentKey: item.assignmentKey,
          credential: this.vault.decrypt(item.encryptedCredential),
          ipLimit: item.ipLimit,
          trafficLimitBytes: item.trafficLimitBytes,
          connectionOptions: null
        }))
      )
      this.state.setMeta(
        'trojan.requiresUserSync',
        results.some((item) => item.error) ? 'true' : 'false'
      )
    })
  }

  sync(users: NodeUserDto[]): Promise<NodeUserResult[]> {
    assertUniqueAssignments(users)
    return this.exclusive(async () => {
      await this.assertRuntimeMutable()
      const results = await this.reconcileRuntime(users)
      this.state.setMeta(
        'trojan.requiresUserSync',
        results.some((item) => item.error) ? 'true' : 'false'
      )
      return results
    })
  }

  add(users: NodeUserDto[]): Promise<NodeUserResult[]> {
    assertUniqueAssignments(users)
    return this.exclusive(async () => {
      await this.assertRuntimeMutable()
      const results: NodeUserResult[] = []
      for (const user of users) {
        try {
          const profile = await this.client.ensureUser(
            user.credential,
            user.ipLimit
          )
          this.saveUser(user, profile)
          results.push({
            assignmentKey: user.assignmentKey,
            hash: profile.hash
          })
        } catch {
          results.push({
            assignmentKey: user.assignmentKey,
            error: 'USER_UPDATE_FAILED'
          })
        }
      }
      return results
    })
  }

  remove(assignmentKeys: string[]): Promise<NodeUserResult[]> {
    const keys = [...new Set(assignmentKeys)]
    return this.exclusive(async () => {
      await this.assertRuntimeMutable()
      const results: NodeUserResult[] = []
      for (const assignmentKey of keys) {
        const stored = this.state.findManagedUser(assignmentKey)
        try {
          if (stored) await this.client.deleteByHash(stored.runtimeUserHash)
          this.state.deleteManagedUser(assignmentKey)
          results.push({ assignmentKey })
        } catch {
          results.push({ assignmentKey, error: 'USER_DELETE_FAILED' })
        }
      }
      return results
    })
  }

  async traffic(reportedAt: string) {
    const profiles = await this.client.listProfiles()
    const mappings = new Map(
      this.state
        .listManagedUsers('trojan')
        .map((item) => [item.runtimeUserHash, item])
    )
    const users = profiles.flatMap((profile) => {
      const mapping = mappings.get(profile.hash)
      if (!mapping) return []
      return [
        {
          assignmentKey: mapping.assignmentKey,
          uploadBytes: profile.uploadBytes,
          downloadBytes: profile.downloadBytes,
          uploadSpeedBytes: profile.uploadSpeedBytes,
          downloadSpeedBytes: profile.downloadSpeedBytes,
          ipLimit: profile.ipLimit
        }
      ]
    })
    return {
      reportedAt,
      online: profiles.reduce((sum, item) => sum + item.ipCurrent, 0),
      users
    }
  }

  private async reconcileRuntime(
    users: NodeUserDto[]
  ): Promise<NodeUserResult[]> {
    const desiredHashes = new Set<string>()
    const desiredKeys = new Set(users.map((item) => item.assignmentKey))
    const results: NodeUserResult[] = []
    for (const user of users) {
      try {
        const profile = await this.client.ensureUser(
          user.credential,
          user.ipLimit
        )
        desiredHashes.add(profile.hash)
        this.saveUser(user, profile)
        results.push({ assignmentKey: user.assignmentKey, hash: profile.hash })
      } catch {
        results.push({
          assignmentKey: user.assignmentKey,
          error: 'USER_SYNC_FAILED'
        })
      }
    }
    if (results.some((item) => item.error)) return results

    for (const profile of await this.client.listProfiles()) {
      if (!desiredHashes.has(profile.hash))
        await this.client.deleteByHash(profile.hash)
    }
    for (const stored of this.state.listManagedUsers('trojan')) {
      if (!desiredKeys.has(stored.assignmentKey)) {
        this.state.deleteManagedUser(stored.assignmentKey)
      }
    }
    return results
  }

  private saveUser(user: NodeUserDto, profile: TrojanProfile): void {
    this.state.upsertManagedUser({
      assignmentKey: user.assignmentKey,
      encryptedCredential: this.vault.encrypt(user.credential),
      protocol: 'trojan',
      runtime: 'trojan-go',
      runtimeUserHash: profile.hash,
      ipLimit: user.ipLimit,
      trafficLimitBytes: user.trafficLimitBytes,
      syncedAt: new Date().toISOString()
    })
  }

  private async assertRuntimeMutable(): Promise<void> {
    if (this.state.findActiveOperation('trojan')) {
      throw operationConflict('Protocol lifecycle operation is active')
    }
    if (!this.client.isInstalled())
      throw invalidRequest('Trojan is not installed')
    if (!(await this.client.isActive())) {
      throw new AgentError(
        'RUNTIME_UNAVAILABLE',
        'Trojan is not running',
        HttpStatus.SERVICE_UNAVAILABLE
      )
    }
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
  const keys = new Set<string>()
  for (const user of users) {
    if (keys.has(user.assignmentKey)) {
      throw invalidRequest('Duplicate assignmentKey in request')
    }
    keys.add(user.assignmentKey)
  }
}
