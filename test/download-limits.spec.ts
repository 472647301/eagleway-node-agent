import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAppConfig } from '../src/config/app-config'
import { DownloadLimitsService } from '../src/protocols/xray/download-limits.service'
import {
  updateDownloadLimitRouting,
  xrayConfig
} from '../src/protocols/xray/runtime-config'
import type { StateStoreService } from '../src/state/state-store.service'

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
