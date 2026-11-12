import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import { SchedulerRegistry } from '@nestjs/schedule'
import { AppModule } from '../src/app.module'
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config'
import { DatabaseService } from '../src/state/database.service'
import { DownloadLimitsService } from '../src/protocols/xray/download-limits.service'
import {
  updateDownloadLimitRouting,
  xrayConfig
} from '../src/protocols/xray/runtime-config'
import { StateStoreService } from '../src/state/state-store.service'

test('enabled download limits bootstrap after SQLite for fresh and persisted state', async (t) => {
  for (const persisted of [false, true]) {
    await t.test(
      persisted ? 'restart with saved policies' : 'first startup',
      async (t) => {
        const directory = mkdtempSync(
          join(tmpdir(), 'eagleway-limit-bootstrap-')
        )
        const config = loadAppConfig({
          NODE_ENV: 'test',
          NODE_ID: '42',
          REPORTING_ENABLED: 'false',
          AGENT_ENABLE_SPEED_LIMIT: 'true',
          STATE_DIR: directory,
          STATE_KEY_PATH: join(directory, 'state.key'),
          LOG_DIR: join(directory, 'logs')
        })
        mkdirSync(config.logDir)
        const snapshot = JSON.stringify({ revision: 7, users: [] })
        if (persisted) {
          const database = new DatabaseService(config)
          try {
            database.onApplicationBootstrap()
            new StateStoreService(database).setMeta(
              'downloadLimits.desired',
              snapshot
            )
          } finally {
            database.onApplicationShutdown()
          }
        }
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(APP_CONFIG)
          .useValue(config)
          .compile()
        const app = module.createNestApplication()
        app.useLogger(false)
        t.after(async () => {
          await app.close()
          rmSync(directory, { recursive: true, force: true })
        })
        // Exercise a missing limiter without contacting a real Unix socket.
        const remote = t.mock.method(http, 'request', () => {
          throw new Error('limiter unavailable')
        })
        const database = app.get(DatabaseService)
        const initializeDatabase =
          database.onApplicationBootstrap.bind(database)
        let databaseReady = false
        t.mock.method(database, 'onApplicationBootstrap', () => {
          initializeDatabase()
          databaseReady = true
        })
        const state = app.get(StateStoreService)
        const getMeta = state.getMeta.bind(state)
        let limitReads = 0
        let prematureReads = 0
        t.mock.method(state, 'getMeta', (key: string) => {
          if (key === 'downloadLimits.desired') {
            limitReads++
            if (!databaseReady) prematureReads++
            assert.equal(database.db.open, true)
          }
          return getMeta(key)
        })

        await app.init()
        // Allow fire-and-forget reconciliation to settle so rejections fail the test.
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.ok(limitReads > 0, 'startup must read the saved policy')
        assert.equal(
          prematureReads,
          0,
          'SQLite must be ready before limit reads'
        )
        assert.ok(
          app.get(SchedulerRegistry).getInterval('xray-download-limits')
        )
        assert.equal(
          state.getMeta('downloadLimits.desired'),
          persisted ? snapshot : null
        )
        assert.equal(remote.mock.callCount(), persisted ? 1 : 0)
        const limits = app.get(DownloadLimitsService)
        const status = await limits.status()
        assert.equal(status.state, 'degraded')
        assert.equal(status.desiredRevision, persisted ? 7 : 0)
        assert.equal(status.appliedRevision, null)
        await limits.reconcile()
        assert.equal(remote.mock.callCount(), persisted ? 3 : 1)
      }
    )
  }
})

test('download limiting is opt-in and only adds a non-deduplicated routing webhook', () => {
  assert.equal(loadAppConfig({ NODE_ID: '1' }).speedLimitEnabled, false)
  assert.equal(
    loadAppConfig({ NODE_ID: '1', AGENT_ENABLE_SPEED_LIMIT: 'true' })
      .speedLimitEnabled,
    true
  )
  assert.throws(() =>
    loadAppConfig({ NODE_ID: '1', AGENT_ENABLE_SPEED_LIMIT: 'yes' })
  )
  const plan = {
    protocol: 'vless' as const,
    apiAddress: '127.0.0.1:10000',
    port: 443,
    domain: 'example.com'
  }
  const certificate = { cert: '/cert', key: '/key' }
  assert.equal(xrayConfig(plan, certificate).routing, undefined)
  const enabled = xrayConfig({ ...plan, speedLimitEnabled: true }, certificate)
  assert.equal(enabled.routing?.rules[0]?.webhook.deduplication, 0)
  assert.deepEqual(enabled.inbounds, xrayConfig(plan, certificate).inbounds)
})

test('toggling the webhook preserves existing routing and never replaces a custom rule', () => {
  const options = { domainStrategy: 'AsIs' }
  const managed = updateDownloadLimitRouting('vless', true, options)!
  assert.deepEqual(updateDownloadLimitRouting('vless', false, managed), options)
  const custom = {
    type: 'field',
    outboundTag: 'blocked',
    ip: ['geoip:private']
  }
  const customRouting = { ...options, rules: [custom] }
  assert.deepEqual(
    updateDownloadLimitRouting('vless', false, customRouting),
    customRouting
  )
  assert.throws(
    () => updateDownloadLimitRouting('vless', true, customRouting),
    /custom Xray routing/
  )
  assert.deepEqual(
    updateDownloadLimitRouting('vless', false, {
      ...managed,
      rules: [custom, ...(managed.rules ?? [])]
    }),
    customRouting
  )
})

test('disabled agents persist desired limits without reporting them applied; revisions cannot roll back', async () => {
  const meta = new Map<string, string>()
  const state = {
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: string) => meta.set(key, value)
  } as unknown as StateStoreService
  const config = loadAppConfig({ NODE_ID: '1' })
  const service = new DownloadLimitsService(config, state)
  const body = {
    nodeId: 1,
    revision: 2,
    limits: [
      {
        assignmentId: '11111111-1111-4111-8111-111111111111',
        downloadLimitMbps: 10
      }
    ]
  }
  assert.deepEqual(await service.sync('vless', body), {
    supported: true,
    enabled: false,
    state: 'disabled',
    desiredRevision: 2,
    appliedRevision: null
  })
  await service.sync('vless', body)
  await assert.rejects(service.sync('vless', { ...body, revision: 1 }))
  await assert.rejects(service.sync('vless', { ...body, limits: [] }))
  await assert.rejects(
    service.sync('vless', {
      ...body,
      revision: 3,
      limits: [body.limits[0]!, body.limits[0]!]
    })
  )
  assert.equal(
    (await new DownloadLimitsService(config, state).status()).desiredRevision,
    2
  )
})
