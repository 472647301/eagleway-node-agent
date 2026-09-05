import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { Client, credentials, type ServiceError } from '@grpc/grpc-js'
import { existsSync } from 'node:fs'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import { ProcessRunnerService } from '@/host/process-runner.service'
import {
  protobufFields,
  protobufMessage,
  stringField,
  varintField
} from './protobuf'
import { inboundTag, runtimeUserId, type XrayProtocol } from './xray.types'

const managedRuntimeMarker =
  '/etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent'
const runtimeUnit = '/etc/systemd/system/eagleway-xray.service'

const accountTypes: Record<XrayProtocol, string> = {
  trojan: 'xray.proxy.trojan.Account',
  vless: 'xray.proxy.vless.Account',
  vmess: 'xray.proxy.vmess.Account'
}

@Injectable()
export class XrayClient implements OnModuleDestroy {
  private readonly grpc: Client

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processes: ProcessRunnerService
  ) {
    this.grpc = new Client(
      this.config.xrayApiAddress,
      credentials.createInsecure()
    )
  }

  onModuleDestroy(): void {
    this.grpc.close()
  }

  isInstalled(): boolean {
    return (
      this.hasManagedResources() &&
      existsSync(this.config.xrayBinary) &&
      existsSync(runtimeUnit)
    )
  }

  hasManagedResources(): boolean {
    return existsSync(managedRuntimeMarker)
  }

  async isActive(): Promise<boolean> {
    const result = await this.processes.run(
      '/usr/bin/systemctl',
      ['is-active', 'eagleway-xray.service'],
      { rejectOnNonZero: false, timeoutMs: 5000, maxOutputBytes: 4096 }
    )
    return result.code === 0 && result.stdout === 'active'
  }

  async invocationId(): Promise<string> {
    const result = await this.processes.run(
      '/usr/bin/systemctl',
      ['show', '--property=InvocationID', '--value', 'eagleway-xray.service'],
      { timeoutMs: 5000, maxOutputBytes: 4096 }
    )
    const value = result.stdout.trim().toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(value)) {
      throw new Error('Xray runtime invocation id is unavailable')
    }
    return value
  }

  async version(): Promise<string | null> {
    if (!this.isInstalled()) return null
    const result = await this.processes.run(
      this.config.xrayBinary,
      ['version'],
      {
        rejectOnNonZero: false,
        timeoutMs: 5000,
        maxOutputBytes: 4096
      }
    )
    const firstLine = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .find(Boolean)
    return firstLine?.slice(0, 120) ?? null
  }

  async listUserIds(protocol: XrayProtocol): Promise<string[]> {
    const response = await this.unary(
      '/xray.app.proxyman.command.HandlerService/GetInboundUsers',
      protobufMessage([[1, 'string', inboundTag(protocol)]])
    )
    return protobufFields(response)
      .filter((field) => field.number === 1 && Buffer.isBuffer(field.value))
      .map((field) => stringField(field.value as Buffer, 2))
      .filter((value): value is string => Boolean(value))
  }

  async addUser(
    protocol: XrayProtocol,
    assignmentId: string,
    credentialValue: string
  ): Promise<string> {
    validateCredential(protocol, credentialValue)
    const userId = runtimeUserId(protocol, assignmentId)
    const account = protobufMessage([[1, 'string', credentialValue]])
    const typedAccount = typedMessage(accountTypes[protocol], account)
    const user = protobufMessage([
      [2, 'string', userId],
      [3, 'message', typedAccount]
    ])
    const operation = protobufMessage([[1, 'message', user]])
    await this.alterInbound(
      protocol,
      typedMessage('xray.app.proxyman.command.AddUserOperation', operation)
    )
    return userId
  }

  async removeUser(protocol: XrayProtocol, userId: string): Promise<void> {
    const operation = protobufMessage([[1, 'string', userId]])
    await this.alterInbound(
      protocol,
      typedMessage('xray.app.proxyman.command.RemoveUserOperation', operation)
    )
  }

  async userTraffic(): Promise<
    Map<string, { upload: string; download: string }>
  > {
    const response = await this.unary(
      '/xray.app.stats.command.StatsService/QueryStats',
      protobufMessage([[1, 'string', 'user>>>']])
    )
    const traffic = new Map<string, { upload: string; download: string }>()
    for (const field of protobufFields(response)) {
      if (field.number !== 1 || !Buffer.isBuffer(field.value)) continue
      const name = stringField(field.value, 1)
      const value = varintField(field.value, 2)
      const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(
        name ?? ''
      )
      if (!match || value === null) continue
      const item = traffic.get(match[1]!) ?? { upload: '0', download: '0' }
      item[match[2] === 'uplink' ? 'upload' : 'download'] = value.toString()
      traffic.set(match[1]!, item)
    }
    return traffic
  }

  private alterInbound(protocol: XrayProtocol, operation: Buffer) {
    return this.unary(
      '/xray.app.proxyman.command.HandlerService/AlterInbound',
      protobufMessage([
        [1, 'string', inboundTag(protocol)],
        [2, 'message', operation]
      ])
    )
  }

  private unary(path: string, body: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.grpc.makeUnaryRequest(
        path,
        (value: Buffer) => value,
        (value: Buffer) => value,
        body,
        { deadline: Date.now() + 10_000 },
        (error: ServiceError | null, response?: Buffer) => {
          if (error) reject(error)
          else resolve(response ?? Buffer.alloc(0))
        }
      )
    })
  }
}

function typedMessage(type: string, value: Buffer): Buffer {
  return protobufMessage([
    [1, 'string', type],
    [2, 'bytes', value]
  ])
}

function validateCredential(protocol: XrayProtocol, value: string): void {
  if (protocol !== 'trojan' && !isUuid(value)) {
    throw new Error(`${protocol.toUpperCase()} credential must be a UUID`)
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}
