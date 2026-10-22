import assert from 'node:assert/strict'
import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { type NestExpressApplication } from '@nestjs/platform-express'
import {
  Server,
  ServerCredentials,
  type ServiceDefinition,
  type ServerUnaryCall,
  type sendUnaryData
} from '@grpc/grpc-js'
import compression from 'compression'
import type { Request, Response } from 'express'
import { createServer, get } from 'node:http'
import { mock, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import zlib from 'node:zlib'
import request from 'supertest'
import { APP_CONFIG, loadAppConfig } from '@/config/app-config'
import { IpAllowlistGuard } from '@/security/ip-allowlist.guard'
import { XrayClient } from '@/protocols/xray/xray.client'
import { protobufMessage, stringField } from '@/protocols/xray/protobuf'

@Controller()
@UseGuards(IpAllowlistGuard)
class SourceAddressController {
  @Get('source')
  source(@Req() req: Request) {
    return { ip: req.ip }
  }
}

test('HTTP allowlist keeps proxy trust boundaries after Express dependency updates', async () => {
  const module = await Test.createTestingModule({
    controllers: [SourceAddressController],
    providers: [
      IpAllowlistGuard,
      {
        provide: APP_CONFIG,
        useValue: loadAppConfig({
          NODE_ENV: 'test',
          NODE_ID: '42',
          REPORTING_ENABLED: 'false',
          ALLOWED_CIDRS: '203.0.113.9/32'
        })
      }
    ]
  }).compile()
  const app = module.createNestApplication<NestExpressApplication>()
  app.useLogger(false)

  try {
    await app.init()
    app.set('trust proxy', false)
    await request(app.getHttpServer())
      .get('/source')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(403)

    app.set('trust proxy', 'loopback')
    const accepted = await request(app.getHttpServer())
      .get('/source')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200)
    assert.deepEqual(accepted.body, { ip: '203.0.113.9' })

    await request(app.getHttpServer())
      .get('/source')
      .set('X-Forwarded-For', '203.0.113.9, 198.51.100.9')
      .expect(403)
  } finally {
    await app.close()
  }
})

test('compression releases its gzip stream when a client aborts a response', async () => {
  const createGzip = zlib.createGzip
  let stream: zlib.Gzip | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const spy = mock.method(
    zlib,
    'createGzip',
    (...args: Parameters<typeof createGzip>) => {
      stream = createGzip(...args)
      stream.once('close', resolveClosed)
      return stream
    }
  )
  const compress = compression()
  const server = createServer((req, res) => {
    compress(req as Request, res as Response, () => {
      const response = res as Response
      res.setHeader('Content-Type', 'text/plain')
      res.write(Buffer.alloc(64 * 1024, 'a'))
      response.flush()
    })
  })
  const timeout = new AbortController()

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${address.port}/`,
        { headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          res.once('data', () => {
            res.destroy()
            if (res.headers['content-encoding'] !== 'gzip') {
              reject(new Error('Expected a compressed response'))
            } else {
              resolve()
            }
          })
          res.once('error', reject)
        }
      )
      req.once('error', reject)
    })
    await Promise.race([
      closed,
      setTimeout(2_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(
          'Aborted response did not release its compression stream'
        )
      })
    ])
    assert.equal(stream?.destroyed, true)
  } finally {
    timeout.abort()
    stream?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    spy.mock.restore()
  }
})

test('Xray gRPC client retains protobuf traffic counters over a local connection', async () => {
  const server = new Server()
  const service: ServiceDefinition = {
    queryStats: {
      path: '/xray.app.stats.command.StatsService/QueryStats',
      requestStream: false,
      responseStream: false,
      requestSerialize: (value: Buffer) => value,
      requestDeserialize: (value: Buffer) => value,
      responseSerialize: (value: Buffer) => value,
      responseDeserialize: (value: Buffer) => value
    }
  }
  const userId = 'trojan.example@eagleway.internal'
  const upload = 9_007_199_254_740_993n
  let query: string | null = null
  server.addService(service, {
    queryStats(
      call: ServerUnaryCall<Buffer, Buffer>,
      callback: sendUnaryData<Buffer>
    ) {
      query = stringField(call.request, 1)
      const response = protobufMessage([
        [
          1,
          'message',
          protobufMessage([
            [1, 'string', `user>>>${userId}>>>traffic>>>uplink`],
            [2, 'varint', upload]
          ])
        ]
      ])
      callback(null, response)
    }
  })
  let client: XrayClient | undefined

  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) reject(error)
          else resolve(port)
        }
      )
    })
    client = new XrayClient(
      loadAppConfig({
        NODE_ENV: 'test',
        NODE_ID: '42',
        REPORTING_ENABLED: 'false',
        XRAY_API_ADDRESS: `127.0.0.1:${port}`
      }),
      {} as never
    )
    const traffic = await client.userTraffic()
    assert.equal(query, 'user>>>')
    assert.deepEqual(traffic.get(userId), {
      upload: upload.toString(),
      download: '0'
    })
  } finally {
    client?.onModuleDestroy()
    server.forceShutdown()
  }
})
