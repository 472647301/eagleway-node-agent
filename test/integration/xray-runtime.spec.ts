import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as httpServer, get } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppConfig } from '@/config/app-config'
import { ProcessRunnerService } from '@/host/process-runner.service'
import { xrayRelease } from '@/host/xray-release'
import { xrayConfig } from '@/protocols/xray/runtime-config'
import { XrayClient } from '@/protocols/xray/xray.client'
import { XrayAssignmentsService } from '@/protocols/xray/xray-assignments.service'
import { XRAY_PROTOCOLS, runtimeUserId } from '@/protocols/xray/xray.types'

// Explicit integration entry point: never silently pass without a real core.
assert.ok(
  process.env.XRAY_TEST_BINARY,
  'Set XRAY_TEST_BINARY to a verified core'
)
const binary = resolve(process.env.XRAY_TEST_BINARY)
const processes = new ProcessRunnerService()

for (const protocol of XRAY_PROTOCOLS) {
  test(
    `${protocol}: pinned core config, users, TLS traffic, stats and restore`,
    { timeout: 60_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'eagleway-xray-test-'))
      const children: ChildProcess[] = []
      const origin = httpServer((_req, res) => {
        res.writeHead(200)
        res.write('eagleway-xray-smoke\n')
        // Keep the connection active while checking online and traffic stats.
      })
      const apiPort = await unusedPort()
      const port = await unusedPort()
      const proxyPort = await unusedPort()
      const client = new XrayClient(
        { xrayApiAddress: `127.0.0.1:${apiPort}` } as AppConfig,
        processes
      )
      let closeRequest: (() => void) | undefined
      let succeeded = false
      t.after(async () => {
        closeRequest?.()
        client.onModuleDestroy()
        await Promise.all(children.map(stop))
        origin.closeAllConnections()
        await new Promise<void>((done) => origin.close(() => done()))
        for (const name of succeeded
          ? []
          : ['xray-error.log', 'client-error.log', 'xray-access.log']) {
          const errors = await readFile(join(directory, name), 'utf8').catch(
            () => ''
          )
          if (errors.trim()) t.diagnostic(`${name}: ${errors.slice(-12000)}`)
        }
        await rm(directory, { recursive: true, force: true })
      })

      const version = await processes.run(binary, ['version'])
      assert.ok(
        version.stdout.startsWith(`Xray ${xrayRelease.version.slice(1)} `),
        version.stdout
      )
      const certificate = {
        cert: join(directory, 'cert.pem'),
        key: join(directory, 'key.pem')
      }
      await processes.run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        certificate.key,
        '-out',
        certificate.cert,
        '-days',
        '1',
        '-subj',
        '/CN=node.example.test'
      ])
      const config = xrayConfig(
        {
          protocol,
          apiAddress: `127.0.0.1:${apiPort}`,
          port,
          domain: 'node.example.test'
        },
        certificate,
        directory
      )
      const configPath = join(directory, 'server.json')
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
      await validateConfig(configPath)
      const originPort = await listen(origin)
      // New cores block private targets by default. Only this isolated test config
      // permits the exact loopback origin; production retains the core default.
      const testConfig = {
        ...config,
        log: { ...config.log, loglevel: 'debug' },
        inbounds: config.inbounds.map((inbound) => ({
          ...inbound,
          listen: '127.0.0.1'
        })),
        outbounds: [
          {
            ...config.outbounds[0],
            settings: {
              finalRules: [
                { action: 'allow', ip: ['127.0.0.1/32'], port: originPort }
              ]
            }
          }
        ]
      }
      await writeFile(configPath, JSON.stringify(testConfig), { mode: 0o600 })
      const start = (path: string) => {
        const child = spawn(binary, ['run', '-config', path], {
          stdio: 'ignore'
        })
        children.push(child)
        return child
      }
      const server = start(configPath)
      await eventually(async () =>
        assert.deepEqual(await client.listUserIds(protocol), [])
      )

      const assignmentId = '10c970c5-7fa4-4389-a12f-3f6802aeeb79'
      const credential = 'cc5ca960-4a38-40cc-b9bd-f971068150af'
      const userId = await client.addUser(protocol, assignmentId, credential)
      assert.equal(userId, runtimeUserId(protocol, assignmentId))
      assert.deepEqual(await client.listUserIds(protocol), [userId])
      // Xray excludes 127.0.0.1 from online counts. Linux can bind another
      // loopback address without changing host networking; macOS cannot.
      const sourceAddress =
        process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1'
      const settings =
        protocol === 'trojan'
          ? { servers: [{ address: '127.0.0.1', port, password: credential }] }
          : {
              vnext: [
                {
                  address: '127.0.0.1',
                  port,
                  users: [
                    {
                      id: credential,
                      ...(protocol === 'vless'
                        ? { encryption: 'none' }
                        : { security: 'auto' })
                    }
                  ]
                }
              ]
            }
      const proxyPath = join(directory, 'client.json')
      await writeFile(
        proxyPath,
        JSON.stringify({
          log: {
            loglevel: 'debug',
            error: join(directory, 'client-error.log')
          },
          inbounds: [
            {
              listen: '127.0.0.1',
              port: proxyPort,
              protocol: 'dokodemo-door',
              settings: {
                address: '127.0.0.1',
                port: originPort,
                network: 'tcp'
              }
            }
          ],
          outbounds: [
            {
              protocol,
              settings,
              sendThrough: sourceAddress,
              streamSettings: {
                network: 'tcp',
                security: 'tls',
                tlsSettings: {
                  serverName: 'node.example.test',
                  pinnedPeerCertSha256: new X509Certificate(
                    await readFile(certificate.cert)
                  ).fingerprint256
                }
              }
            }
          ]
        }),
        { mode: 0o600 }
      )
      await validateConfig(proxyPath)
      start(proxyPath)
      await eventually(async () => {
        closeRequest = await openTunnelRequest(proxyPort)
      })
      await eventually(async () => {
        const traffic = (await client.userTraffic()).get(userId)
        assert.ok(
          traffic &&
            BigInt(traffic.upload) > 0n &&
            BigInt(traffic.download) > 0n
        )
        assert.deepEqual(
          await client.listOnlineUserIds(),
          process.platform === 'linux' ? [userId] : []
        )
      })
      closeRequest?.()
      await client.removeUser(protocol, userId)
      assert.deepEqual(await client.listUserIds(protocol), [])
      await client.addUser(protocol, assignmentId, credential)

      await stop(server)
      start(configPath)
      await eventually(async () =>
        assert.deepEqual(await client.listUserIds(protocol), [])
      )
      const metadata = new Map<string, string>()
      const stored = {
        assignmentId,
        protocol,
        runtimeUserId: userId,
        encryptedCredential: credential
      }
      // Only persistence is stubbed; restoration uses the production reconciler and live gRPC.
      const assignments = new XrayAssignmentsService(
        client,
        {
          listManagedUsers: () => [stored],
          findManagedUser: () => stored,
          upsertManagedUser: () => undefined,
          setMeta: (key: string, value: string) => metadata.set(key, value)
        } as never,
        {
          decrypt: (value: string) => value,
          encrypt: (value: string) => value
        } as never
      )
      await assignments.restoreStoredUsers(protocol)
      assert.equal(metadata.get(`${protocol}.requiresUserSync`), 'false')
      assert.deepEqual(await client.listUserIds(protocol), [userId])
      await eventually(async () => {
        closeRequest = await openTunnelRequest(proxyPort)
      })
      assert.match(
        await readFile(join(directory, 'xray-access.log'), 'utf8'),
        /accepted/
      )
      succeeded = true
    }
  )
}

async function validateConfig(path: string): Promise<void> {
  const result = await processes.run(
    binary,
    ['run', '-test', '-config', path],
    {
      rejectOnNonZero: false
    }
  )
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 12_000
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(100)
    }
  }
}

function openTunnelRequest(proxyPort: number): Promise<() => void> {
  return new Promise((resolveRequest, reject) => {
    const req = get(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/',
        agent: false
      },
      (res) => {
        res.on('error', reject)
        res.once('data', (data: Buffer) => {
          if (
            res.statusCode !== 200 ||
            !data.toString().includes('eagleway-xray-smoke')
          ) {
            req.destroy()
            reject(new Error('Unexpected proxy response'))
            return
          }
          req.setTimeout(0)
          resolveRequest(() => req.destroy())
        })
      }
    )
    req.setTimeout(3000, () =>
      req.destroy(new Error('Proxy request timed out'))
    )
    req.on('error', reject)
  })
}
