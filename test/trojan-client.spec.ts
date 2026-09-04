import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppConfig } from '@/config/app-config'
import type {
  ProcessOptions,
  ProcessResult
} from '@/host/process-runner.service'
import { TrojanGoClient } from '@/protocols/trojan/trojan-go.client'

test('Trojan-Go list preserves counters beyond JavaScript safe integer', async () => {
  const hash = 'a'.repeat(56)
  const runner = new FakeRunner([
    {
      code: 0,
      stdout: `[{"status":{"user":{"hash":"${hash}"},"traffic_total":{"upload_traffic":9007199254740993,"download_traffic":4},"speed_current":{"upload_speed":5,"download_speed":6},"ip_current":2,"ip_limit":3}}]`,
      stderr: ''
    }
  ])
  const client = new TrojanGoClient(fixtureConfig(), runner as never)
  const [profile] = await client.listProfiles()
  assert.equal(profile?.uploadBytes, '9007199254740993')
  assert.equal(profile?.ipCurrent, 2)
  assert.deepEqual(runner.calls[0]?.args.slice(0, 3), [
    '-api-addr',
    '127.0.0.1:10000',
    '-api'
  ])
})

test('Trojan-Go credentials are passed as an argument rather than a shell command', async () => {
  const hash = 'b'.repeat(56)
  const profile = JSON.stringify({ status: { user: { hash } } })
  const runner = new FakeRunner([
    { code: 1, stdout: '', stderr: 'not found' },
    { code: 0, stdout: 'Done', stderr: '' },
    { code: 0, stdout: 'Done', stderr: '' },
    { code: 0, stdout: profile, stderr: '' }
  ])
  const client = new TrojanGoClient(fixtureConfig(), runner as never)
  await client.ensureUser('value;touch /tmp/pwned', 2)
  assert.equal(runner.calls[1]?.executable, '/usr/local/bin/trojan-go')
  assert.ok(runner.calls[1]?.args.includes('value;touch /tmp/pwned'))
})

class FakeRunner {
  readonly calls: Array<{
    executable: string
    args: readonly string[]
    options: ProcessOptions
  }> = []

  constructor(private readonly results: ProcessResult[]) {}

  async run(
    executable: string,
    args: readonly string[],
    options: ProcessOptions
  ): Promise<ProcessResult> {
    this.calls.push({ executable, args, options })
    const result = this.results.shift()
    if (!result) throw new Error('Missing fake process result')
    return result
  }
}

function fixtureConfig(): AppConfig {
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
    stateDir: './var/state',
    stateKeyPath: './var/state.key',
    logDir: './var/logs',
    trojanGoBinary: '/usr/local/bin/trojan-go',
    trojanGoApiAddress: '127.0.0.1:10000',
    trojanGoPolicyPath: './runtime-policy.json',
    trojanGoArchiveUrl: null,
    trojanGoArchiveSha256: null,
    acmeEmail: null,
    privilegedHelper: '/usr/local/libexec/eagleway-node-helper',
    operationTimeoutSeconds: 900
  }
}
