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
      assignmentId: '10c970c5-7fa4-4389-a12f-3f6802aeeb79',
      encryptedCredential: encrypted,
      protocol: 'trojan',
      runtimeUserId:
        'trojan.10c970c5-7fa4-4389-a12f-3f6802aeeb79@eagleway.internal',
      syncedAt: '2026-09-04T00:00:00.000Z'
    })
    const stored = state.findManagedUser('10c970c5-7fa4-4389-a12f-3f6802aeeb79')
    assert.equal(stored?.protocol, 'trojan')
    assert.equal(
      vault.decrypt(stored!.encryptedCredential),
      'private-credential'
    )

    const first = state.nextReportedAt(new Date('2026-09-04T00:00:00.000Z'))
    const second = state.nextReportedAt(new Date('2026-09-03T00:00:00.000Z'))
    assert.ok(new Date(second).getTime() > new Date(first).getTime())

    state.setRuntimeConfig({
      revision: 4,
      protocol: 'trojan',
      port: 9443,
      domain: 'node.example.com',
      proxyUrl: null,
      configHash: 'a'.repeat(64)
    })
    assert.deepEqual(state.runtimeConfig(), {
      revision: 4,
      protocol: 'trojan',
      port: 9443,
      domain: 'node.example.com',
      proxyUrl: null,
      configHash: 'a'.repeat(64)
    })
    state.deleteRuntimeConfig()
    assert.equal(state.runtimeConfig(), null)
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
    serverBandwidthMbps: 1000,
    stateDir: directory,
    stateKeyPath: join(directory, 'state.key'),
    logDir: join(directory, 'logs'),
    xrayBinary: '/usr/local/bin/xray',
    xrayApiAddress: '127.0.0.1:10000',
    acmeEmail: null,
    privilegedHelper: '/usr/local/libexec/eagleway-node-helper',
    operationTimeoutSeconds: 900
  }
}
