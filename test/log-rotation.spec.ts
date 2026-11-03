import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAppConfig } from '@/config/app-config'
import { LogReaderService } from '@/logs/log-reader.service'
import { LogRotationService } from '@/logs/log-rotation.service'
import type { StateStoreService } from '@/state/state-store.service'

test('the daily schedule waits for midnight instead of polling every minute', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: new Date('2026-11-02T15:58:00Z')
  })
  const { config, service, state, dates } = fixture(t)
  dates.set('logs.rotation.xray-access.log.date', '2026-11-02')
  const reads = t.mock.method(state, 'getMeta')
  writeFileSync(join(config.logDir, 'xray-access.log'), 'before midnight\n')
  service.onApplicationBootstrap()
  await service.trigger()
  const initialCalls = reads.mock.callCount()
  t.mock.timers.tick(60_000)
  assert.equal(reads.mock.callCount(), initialCalls)
  t.mock.timers.tick(60_000)
  assert.ok(reads.mock.callCount() > initialCalls)
  await service.trigger()
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access-2026-11-02.log'), 'utf8'),
    'before midnight\n'
  )
})

test('daily archives remain readable while Xray keeps appending to the same file', async (t) => {
  const { config, service } = fixture(t)
  const path = join(config.logDir, 'xray-access.log')
  const content = '2026/11/02 12:00:00 accepted tcp:example.com:443\n'.repeat(
    7000
  )
  const writer = await open(path, 'a', 0o640)
  try {
    await writer.writeFile(content)
    const original = await writer.stat()
    writeFileSync(join(config.logDir, 'xray-error.log'), 'warning\n')
    await service.trigger(new Date('2026-11-02T16:00:00Z'))

    assert.equal(
      readFileSync(join(config.logDir, 'xray-access-2026-11-02.log'), 'utf8'),
      content
    )
    assert.equal(readFileSync(path, 'utf8'), '')
    assert.equal(statSync(path).ino, original.ino)
    assert.equal(statSync(path).mode, original.mode)
    await writer.write('new connection\n')
    assert.equal(readFileSync(path, 'utf8'), 'new connection\n')

    const reader = new LogReaderService(config)
    assert.deepEqual(reader.files(), [
      'xray-access-2026-11-02.log',
      'xray-access.log',
      'xray-error-2026-11-02.log',
      'xray-error.log'
    ])
    const page = reader.page({
      filename: 'xray-access-2026-11-02.log',
      page: 1,
      pageSize: 2
    })
    assert.equal(page.total, 7000)
    assert.equal(page.data.length, 2)
    assert.equal(page.data[0]?.raw, content.split('\n')[0])
    assert.equal(
      readdirSync(config.logDir).some((name) => name.endsWith('.tmp')),
      false
    )
  } finally {
    await writer.close()
  }
})

test('rotation follows the configured time zone and handles year boundaries', async (t) => {
  const { config, service, dates } = fixture(t)
  dates.set('logs.rotation.xray-access.log.date', '2026-12-31')
  writeFileSync(join(config.logDir, 'xray-access.log'), 'last year\n')
  await service.trigger(new Date('2026-12-31T15:59:59Z'))
  assert.deepEqual(readdirSync(config.logDir), ['xray-access.log'])
  await service.trigger(new Date('2026-12-31T16:00:00Z'))
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access-2026-12-31.log'), 'utf8'),
    'last year\n'
  )
  assert.equal(dates.get('logs.rotation.xray-access.log.date'), '2027-01-01')

  const utc = fixture(t, { XRAY_LOG_TIMEZONE: 'UTC' })
  utc.dates.set('logs.rotation.xray-access.log.date', '2026-12-31')
  writeFileSync(join(utc.config.logDir, 'xray-access.log'), 'UTC\n')
  await utc.service.trigger(new Date('2026-12-31T16:00:00Z'))
  assert.equal(readdirSync(utc.config.logDir).length, 1)
  await utc.service.trigger(new Date('2027-01-01T00:00:00Z'))
  assert.equal(
    readFileSync(join(utc.config.logDir, 'xray-access-2026-12-31.log'), 'utf8'),
    'UTC\n'
  )
})

test('restart after several days creates one previous-day archive and does not rotate again that day', async (t) => {
  const { config, service, state, dates } = fixture(t)
  dates.set('logs.rotation.xray-access.log.date', '2026-11-01')
  const path = join(config.logDir, 'xray-access.log')
  writeFileSync(path, 'November 1\nNovember 2\nNovember 3\n')
  await service.trigger(new Date('2026-11-03T04:00:00Z'))
  assert.deepEqual(readdirSync(config.logDir), [
    'xray-access-2026-11-02.log',
    'xray-access.log'
  ])
  writeFileSync(path, 'today\n')
  const restarted = new LogRotationService(config, state)
  await restarted.trigger(new Date('2026-11-03T08:00:00Z'))
  assert.equal(readFileSync(path, 'utf8'), 'today\n')
  assert.equal(readdirSync(config.logDir).length, 2)
})

test('empty or absent logs create no archives and logs installed later rotate the next day', async (t) => {
  const { config, service } = fixture(t)
  const path = join(config.logDir, 'xray-access.log')
  writeFileSync(path, '')
  await service.trigger(new Date('2026-11-03T04:00:00Z'))
  writeFileSync(join(config.logDir, 'xray-error.log'), 'installed today\n')
  await service.trigger(new Date('2026-11-03T08:00:00Z'))
  assert.deepEqual(readdirSync(config.logDir), [
    'xray-access.log',
    'xray-error.log'
  ])
  await service.trigger(new Date('2026-11-04T04:00:00Z'))
  assert.equal(
    readFileSync(join(config.logDir, 'xray-error-2026-11-03.log'), 'utf8'),
    'installed today\n'
  )
  assert.equal(
    existsSync(join(config.logDir, 'xray-access-2026-11-03.log')),
    false
  )
})

test('first upgrade replaces an interrupted temporary copy without overwriting an archive', async (t) => {
  const { config, service } = fixture(t)
  writeFileSync(join(config.logDir, 'xray-access.log'), 'current\n')
  writeFileSync(join(config.logDir, 'xray-access-2026-11-02.log'), 'existing\n')
  writeFileSync(join(config.logDir, '.xray-access.log.rotation.tmp'), 'partial')
  await service.trigger(new Date('2026-11-03T04:00:00Z'))
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access-2026-11-02.log'), 'utf8'),
    'existing\n'
  )
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access-2026-11-02-1.log'), 'utf8'),
    'current\n'
  )
  assert.equal(
    existsSync(join(config.logDir, '.xray-access.log.rotation.tmp')),
    false
  )
})

test('a failed archive preserves the active log, retries, and does not block the other log', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: new Date('2026-11-03T04:00:00Z')
  })
  const { config, service, state, dates } = fixture(t)
  const reads = t.mock.method(state, 'getMeta')
  const temporary = join(config.logDir, '.xray-access.log.rotation.tmp')
  const path = join(config.logDir, 'xray-access.log')
  mkdirSync(temporary)
  writeFileSync(path, 'must survive\n')
  writeFileSync(join(config.logDir, 'xray-error.log'), 'warning\n')
  await service.trigger()
  assert.equal(readFileSync(path, 'utf8'), 'must survive\n')
  assert.equal(dates.has('logs.rotation.xray-access.log.date'), false)
  assert.equal(
    existsSync(join(config.logDir, 'xray-access-2026-11-02.log')),
    false
  )
  assert.equal(
    existsSync(join(config.logDir, 'xray-error-2026-11-02.log')),
    true
  )
  rmdirSync(temporary)
  const failedCalls = reads.mock.callCount()
  t.mock.timers.tick(60_000)
  assert.ok(reads.mock.callCount() > failedCalls)
  await service.trigger()
  assert.equal(readFileSync(path, 'utf8'), '')
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access-2026-11-02.log'), 'utf8'),
    'must survive\n'
  )
  const successfulCalls = reads.mock.callCount()
  t.mock.timers.tick(60_000)
  assert.equal(reads.mock.callCount(), successfulCalls)
})

test('retention removes only expired managed archives, including collision suffixes', async (t) => {
  const { config, service } = fixture(t)
  const expired = ['xray-access-2026-11-02.log', 'xray-error-2026-11-02-1.log']
  const kept = [
    'xray-access-2026-11-03.log',
    'xray-error-2026-11-09.log',
    'xray-access-2026-11-11.log',
    'agent-2026-11-01.log',
    'xray-access-2026-11-01.log.gz',
    'xray-access-custom.log'
  ]
  for (const name of [...expired, ...kept]) {
    writeFileSync(join(config.logDir, name), 'archive\n')
  }
  const directoryName = 'xray-access-2026-11-01.log'
  mkdirSync(join(config.logDir, directoryName))
  await service.trigger(new Date('2026-11-10T04:00:00Z'))
  assert.deepEqual(
    readdirSync(config.logDir).sort(),
    [...kept, directoryName].sort()
  )
})

test('symlinks cannot redirect rotation or retention to files outside the log directory', async (t) => {
  const { config, service, directory } = fixture(t)
  const outside = join(directory, 'outside.log')
  writeFileSync(outside, 'outside\n')
  try {
    symlinkSync(outside, join(config.logDir, 'xray-access.log'))
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    ) {
      t.skip(
        'Windows file symlinks require privileges; Linux CI runs this case'
      )
      return
    }
    throw error
  }
  symlinkSync(outside, join(config.logDir, 'xray-error-2026-11-01.log'))
  await service.trigger(new Date('2026-11-10T04:00:00Z'))
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n')
  assert.equal(
    existsSync(join(config.logDir, 'xray-error-2026-11-01.log')),
    true
  )
  assert.equal(
    existsSync(join(config.logDir, 'xray-access-2026-11-09.log')),
    false
  )
})

test('overlapping checks share one rotation and shutdown waits for it', async (t) => {
  const { config, service, dates } = fixture(t)
  writeFileSync(join(config.logDir, 'xray-access.log'), 'before shutdown\n')
  const now = new Date('2026-11-03T04:00:00Z')
  const pending = service.trigger(now)
  assert.equal(service.trigger(now), pending)
  await service.onModuleDestroy()
  assert.equal(dates.get('logs.rotation.xray-access.log.date'), '2026-11-03')
  writeFileSync(join(config.logDir, 'xray-access.log'), 'after shutdown\n')
  await service.trigger(new Date('2026-11-04T04:00:00Z'))
  assert.equal(
    readFileSync(join(config.logDir, 'xray-access.log'), 'utf8'),
    'after shutdown\n'
  )
  assert.equal(
    existsSync(join(config.logDir, 'xray-access-2026-11-03.log')),
    false
  )
})

function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-log-rotation-'))
  const config = loadAppConfig({
    NODE_ENV: 'test',
    NODE_ID: '1',
    STATE_DIR: directory,
    LOG_DIR: join(directory, 'logs'),
    ...env
  })
  mkdirSync(config.logDir)
  const dates = new Map<string, string>()
  const state = {
    getMeta: (key: string) => dates.get(key) ?? null,
    setMeta: (key: string, value: string) => dates.set(key, value)
  } as unknown as StateStoreService
  const service = new LogRotationService(config, state)
  t.after(async () => {
    await service.onModuleDestroy()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, config, dates, state, service }
}
