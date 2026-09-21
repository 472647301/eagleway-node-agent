import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '@/config/app-config'
import { PrivilegedHelperService } from '@/host/privileged-helper.service'
import {
  ProcessExecutionError,
  ProcessRunnerService
} from '@/host/process-runner.service'

test('process runner retains bounded command output on failure', async () => {
  const runner = new ProcessRunnerService()
  await assert.rejects(
    runner.run(process.execPath, [
      '-e',
      "process.stderr.write('Certificate issuance failed\\n'); process.exit(1)"
    ]),
    (error: unknown) =>
      error instanceof ProcessExecutionError &&
      error.exitCode === 1 &&
      error.stderr === 'Certificate issuance failed'
  )
})

test('process runner reports timeouts distinctly', async () => {
  const runner = new ProcessRunnerService()
  await assert.rejects(
    runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 20
    }),
    (error: unknown) =>
      error instanceof ProcessExecutionError &&
      error.safeMessage === 'Host command timed out'
  )
})

test(
  'process runner timeout terminates descendant host commands',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eagleway-process-tree-'))
    const marker = join(directory, 'descendant-finished')
    try {
      const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 500)`
      const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
      const runner = new ProcessRunnerService()
      await assert.rejects(
        runner.run(process.execPath, ['-e', parent], { timeoutMs: 150 }),
        (error: unknown) =>
          error instanceof ProcessExecutionError &&
          error.safeMessage === 'Host command timed out'
      )
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('privileged helper exposes only a single safe helper error line', async () => {
  const failure = new ProcessExecutionError(
    '/usr/local/libexec/eagleway-node-helper',
    1,
    'Host command failed',
    '',
    'Certificate issuance failed'
  )
  const processes = {
    run: async () => Promise.reject(failure)
  }
  const service = new PrivilegedHelperService(
    {
      privilegedHelper: '/usr/local/libexec/eagleway-node-helper',
      operationTimeoutSeconds: 900
    } as AppConfig,
    processes as never
  )

  await assert.rejects(
    service.run('xray-install', '/var/lib/plan.json'),
    (error: unknown) =>
      error instanceof ProcessExecutionError &&
      error.safeMessage === 'Certificate issuance failed'
  )
})

test('privileged helper includes bounded stderr in host command failures', async () => {
  const failure = new ProcessExecutionError(
    '/usr/local/libexec/eagleway-node-helper',
    1,
    'Host command failed',
    '',
    'Certificate issuance failed: DNS problem second detail'
  )
  const processes = {
    run: async () => Promise.reject(failure)
  }
  const service = new PrivilegedHelperService(
    {
      privilegedHelper: '/usr/local/libexec/eagleway-node-helper',
      operationTimeoutSeconds: 900
    } as AppConfig,
    processes as never
  )

  await assert.rejects(
    service.run('xray-install', '/var/lib/plan.json'),
    (error: unknown) =>
      error instanceof ProcessExecutionError &&
      error.safeMessage ===
        'Certificate issuance failed: DNS problem second detail'
  )
})
