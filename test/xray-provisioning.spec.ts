import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppConfig } from '@/config/app-config'
import { ProcessExecutionError } from '@/host/process-runner.service'
import {
  XrayProvisioningService,
  type XrayInstallInput
} from '@/protocols/xray/xray-provisioning.service'

const input: XrayInstallInput = {
  nodeId: 7,
  protocol: 'trojan',
  revision: 1,
  port: 9443,
  domain: 'node.example.com',
  proxyUrl: null
}

test('failed install invokes managed cleanup and removes its staging plan', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-provisioning-'))
  const actions: string[] = []
  try {
    const helper = {
      run: async (action: string) => {
        actions.push(action)
        if (action === 'xray-install') {
          throw new ProcessExecutionError(
            '/usr/local/libexec/eagleway-node-helper',
            1,
            'Certificate issuance failed'
          )
        }
      }
    }
    const inspector = {
      certificateAvailable: () => true
    }
    const service = new XrayProvisioningService(
      fixtureConfig(directory),
      inspector as never,
      helper as never,
      {} as never
    )

    await assert.rejects(
      service.install(input, {
        profile: 'ubuntu',
        osId: 'ubuntu',
        osVersion: '24.04',
        architecture: 'x64',
        baota: false
      }),
      (error: unknown) =>
        error instanceof ProcessExecutionError &&
        error.safeMessage === 'Certificate issuance failed'
    )
    assert.deepEqual(actions, ['xray-install', 'xray-uninstall'])
    assert.deepEqual(readdirSync(join(directory, 'staging')), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preflight reuses an active standard Nginx listener for ACME', async () => {
  const checkedPorts: number[] = []
  const inspector = {
    inspect: () => ({
      profile: 'ubuntu',
      osId: 'ubuntu',
      osVersion: '24.04',
      architecture: 'x64',
      baota: false
    }),
    assertDomainReady: async () => undefined,
    assertPortAvailable: async (port: number) => {
      checkedPorts.push(port)
    },
    certificateAvailable: () => false,
    standardNginxActive: async () => true
  }
  const service = new XrayProvisioningService(
    fixtureConfig('/tmp/eagleway-provisioning-unused'),
    inspector as never,
    {} as never,
    {} as never
  )

  await service.preflight(input)
  assert.deepEqual(checkedPorts, [9443])
})

function fixtureConfig(stateDir: string): AppConfig {
  return {
    nodeId: 7,
    stateDir,
    xrayApiAddress: '127.0.0.1:10000',
    acmeEmail: null
  } as AppConfig
}
