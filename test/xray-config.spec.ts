import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppConfig } from '@/config/app-config'
import { runtimeConfigHash, XrayService } from '@/protocols/xray/xray.service'

const desired = {
  nodeId: 7,
  protocol: 'trojan' as const,
  revision: 4,
  port: 9443,
  domain: 'node.example.com',
  proxyUrl: null
}

test('runtime configuration hash excludes transport revision metadata', () => {
  assert.equal(
    runtimeConfigHash(desired),
    runtimeConfigHash({ ...desired, nodeId: 99, revision: 12 })
  )
})

test('install rejects a silently different configuration', async () => {
  const service = fixtureService({
    ...desired,
    port: 8443,
    configHash: runtimeConfigHash({ ...desired, port: 8443 })
  })
  await assert.rejects(service.install('trojan', desired), (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'errorCode' in error &&
      error.errorCode === 'CONFIG_MISMATCH'
    )
  )
})

test('config apply rejects stale revisions before changing the host', async () => {
  const service = fixtureService({
    ...desired,
    revision: 5,
    configHash: runtimeConfigHash(desired)
  })
  await assert.rejects(
    service.applyConfig('trojan', desired),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === 'object' &&
        'errorCode' in error &&
        error.errorCode === 'STALE_CONFIG_REVISION'
      )
  )
})

test('install cleans a stale partial runtime before preflight', async () => {
  const calls: string[] = []
  const service = fixtureService(null, {
    findActiveOperation: () => null,
    cleanupPartialInstall: async () => {
      calls.push('cleanup')
    },
    preflight: async () => {
      calls.push('preflight')
      return {}
    }
  })

  await service.install('trojan', desired)
  assert.deepEqual(calls, ['cleanup', 'preflight'])
})

function fixtureService(
  runtimeConfig: object | null,
  overrides: {
    findActiveOperation?: () => object | null
    cleanupPartialInstall?: () => Promise<void>
    preflight?: () => Promise<object>
  } = {}
): XrayService {
  const config = { nodeId: 7 } as AppConfig
  const client = {
    hasManagedResources: () => true,
    isInstalled: () => runtimeConfig !== null,
    isActive: async () => true
  }
  const state = {
    getMeta: (key: string) => (key === 'xray.protocol' ? 'trojan' : null),
    runtimeConfig: () => runtimeConfig,
    findActiveOperation: overrides.findActiveOperation ?? (() => null)
  }
  const provisioning = {
    cleanupPartialInstall:
      overrides.cleanupPartialInstall ?? (async () => undefined),
    preflight: overrides.preflight ?? (async () => ({}))
  }
  const operations = {
    start: () => ({ operationId: 'operation-id' })
  }
  return new XrayService(
    config,
    client as never,
    provisioning as never,
    {} as never,
    operations as never,
    state as never
  )
}
