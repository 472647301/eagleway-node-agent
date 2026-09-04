import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppConfig } from '@/config/app-config'
import { CredentialVaultService } from '@/state/credential-vault.service'
import { DatabaseService } from '@/state/database.service'
import { StateStoreService } from '@/state/state-store.service'

test('SQLite state persists encrypted user mappings and monotonic report time', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-state-'))
  try {
    const config = fixtureConfig(directory)
    const database = new DatabaseService(config)
    const vault = new CredentialVaultService(config)
    database.onApplicationBootstrap()
    vault.onApplicationBootstrap()
    const state = new StateStoreService(database)
    const encrypted = vault.encrypt('private-credential')
    assert.notEqual(encrypted, 'private-credential')
    assert.equal(vault.decrypt(encrypted), 'private-credential')

    state.upsertManagedUser({
      assignmentKey: 'assignment_1',
      encryptedCredential: encrypted,
      protocol: 'trojan',
      runtime: 'trojan-go',
      runtimeUserHash: 'a'.repeat(56),
      ipLimit: 2,
      trafficLimitBytes: '9007199254740993',
      syncedAt: '2026-09-04T00:00:00.000Z'
    })
    const stored = state.findManagedUser('assignment_1')
    assert.equal(stored?.trafficLimitBytes, '9007199254740993')
    assert.equal(
      vault.decrypt(stored!.encryptedCredential),
      'private-credential'
    )

    const first = state.nextReportedAt(new Date('2026-09-04T00:00:00.000Z'))
    const second = state.nextReportedAt(new Date('2026-09-03T00:00:00.000Z'))
    assert.ok(new Date(second).getTime() > new Date(first).getTime())
    database.onApplicationShutdown()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixtureConfig(directory: string): AppConfig {
  return {
    env: 'test',
    port: 8086,
    host: '127.0.0.1',
    nodeId: 1,
    allowedCidrs: ['127.0.0.1/32'],
    trustProxy: false,
    centerApiUrl: null,
    reportIntervalSeconds: 300,
    reportingEnabled: false,
    stateDir: directory,
    stateKeyPath: join(directory, 'state.key'),
    logDir: join(directory, 'logs'),
    trojanGoBinary: '/usr/local/bin/trojan-go',
    trojanGoApiAddress: '127.0.0.1:10000',
    trojanGoPolicyPath: join(directory, 'runtime-policy.json'),
    trojanGoArchiveUrl: null,
    trojanGoArchiveSha256: null,
    acmeEmail: null,
    privilegedHelper: '/usr/local/libexec/eagleway-node-helper',
    operationTimeoutSeconds: 900
  }
}
