import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Server, ServerCredentials, type handleUnaryCall } from '@grpc/grpc-js'
import type { AppConfig } from '@/config/app-config'
import { XrayAssignmentsService } from '@/protocols/xray/xray-assignments.service'
import { XrayClient } from '@/protocols/xray/xray.client'
import { XrayService } from '@/protocols/xray/xray.service'
import { runtimeUserId } from '@/protocols/xray/xray.types'

test('starting a stopped node waits for gRPC before restoring users', async (t) => {
  const initialServer = new Server()
  const restartedServer = new Server()
  let restored = 0
  for (const server of [initialServer, restartedServer]) {
    register(server, 'GetInboundUsers', (_call, callback) =>
      callback(null, Buffer.alloc(0))
    )
  }
  register(restartedServer, 'AlterInbound', (_call, callback) => {
    restored += 1
    callback(null, Buffer.alloc(0))
  })
  const port = await bind(initialServer, '127.0.0.1:0')
  const config = { nodeId: 7, xrayApiAddress: `127.0.0.1:${port}` } as AppConfig
  let active = true
  let binding: Promise<number> | undefined
  const client = new XrayClient(config, {} as never)
  client.isInstalled = () => true
  client.isActive = async () => active
  t.after(async () => {
    client.onModuleDestroy()
    initialServer.forceShutdown()
    await binding
    restartedServer.forceShutdown()
  })
  await client.listUserIds('trojan')

  const assignmentId = '10c970c5-7fa4-4389-a12f-3f6802aeeb79'
  const stored = {
    assignmentId,
    protocol: 'trojan',
    runtimeUserId: runtimeUserId('trojan', assignmentId),
    encryptedCredential: 'stored-credential'
  }
  const metadata = new Map([['xray.protocol', 'trojan']])
  const state = {
    getMeta: (key: string) => metadata.get(key),
    setMeta: (key: string, value: string) => metadata.set(key, value),
    findActiveOperation: () => null,
    listManagedUsers: () => [stored],
    findManagedUser: () => stored,
    upsertManagedUser: () => undefined
  }
  const assignments = new XrayAssignmentsService(
    client,
    state as never,
    {
      decrypt: (value: string) => value,
      encrypt: (value: string) => value
    } as never
  )
  const provisioning = {
    stop: async () => {
      initialServer.forceShutdown()
      active = false
    },
    start: async () => {
      active = true
      binding = delay(300).then(() =>
        bind(restartedServer, config.xrayApiAddress)
      )
    }
  }
  const service = new XrayService(
    config,
    client,
    provisioning as never,
    assignments,
    {} as never,
    state as never
  )

  assert.deepEqual(await service.stop('trojan', { nodeId: 7 }), {
    operationId: null,
    state: 'stopped'
  })
  assert.deepEqual(await service.start('trojan', { nodeId: 7 }), {
    operationId: null,
    state: 'online'
  })
  assert.equal(restored, 1)
  assert.equal(metadata.get('trojan.requiresUserSync'), 'false')
})

function register(
  server: Server,
  method: string,
  handler: handleUnaryCall<Buffer, Buffer>
): void {
  server.register(
    `/xray.app.proxyman.command.HandlerService/${method}`,
    handler,
    (value) => value,
    (value) => value,
    'unary'
  )
}

function bind(server: Server, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      ServerCredentials.createInsecure(),
      (error, port) => {
        if (error) reject(error)
        else resolve(port)
      }
    )
  })
}
