import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppConfig } from '@/config/app-config'
import {
  LogReaderService,
  parseLogLine,
  readNewestLines
} from '@/logs/log-reader.service'

test('log reader returns newest lines without loading ordering incorrectly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-logs-'))
  try {
    const path = join(directory, 'agent.log')
    writeFileSync(path, 'first\nsecond\nthird\nfourth\n')
    assert.deepEqual(readNewestLines(path, 1, 2), {
      lines: ['fourth', 'third'],
      total: 4
    })
    assert.deepEqual(readNewestLines(path, 2, 2), {
      lines: ['second', 'first'],
      total: 4
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('log parser accepts structured JSON lines', () => {
  const parsed = parseLogLine(
    JSON.stringify({
      timestamp: '2026-09-04T00:00:00.000Z',
      level: 'info',
      context: 'Reporter',
      message: 'sent'
    })
  )
  assert.equal(parsed.level, 'INFO')
  assert.equal(parsed.category, 'Reporter')
  assert.equal(parsed.message, 'sent')
})

test('log parser accepts legacy lines and redacts recognizable secrets', () => {
  const legacy = parseLogLine(
    '[2026-09-04T00:00:00.000Z] [warn] Reporter - retrying'
  )
  assert.equal(legacy.timestamp, '2026-09-04T00:00:00.000Z')
  assert.equal(legacy.level, 'WARN')
  assert.equal(legacy.category, 'Reporter')
  assert.equal(legacy.message, 'retrying')

  const structured = parseLogLine(
    JSON.stringify({
      level: 'error',
      credential: 'credential-secret',
      nested: { accessToken: 'access-token-secret' },
      message: 'authorization=Bearer header-secret'
    })
  )
  assert.equal(structured.message, 'authorization=[REDACTED]')
  assert.ok(!structured.raw.includes('credential-secret'))
  assert.ok(!structured.raw.includes('access-token-secret'))
  assert.ok(!structured.raw.includes('header-secret'))
})

test('log reader handles CRLF, files without a trailing newline and empty files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-log-lines-'))
  try {
    const path = join(directory, 'agent.log')
    writeFileSync(path, 'first\r\nsecond\r\nthird')
    assert.deepEqual(readNewestLines(path, 1, 2), {
      lines: ['third', 'second'],
      total: 3
    })
    assert.deepEqual(readNewestLines(path, 2, 2), {
      lines: ['first'],
      total: 3
    })

    writeFileSync(path, '')
    assert.deepEqual(readNewestLines(path, 1, 100), { lines: [], total: 0 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('log reader preserves UTF-8 across chunks and bounds oversized lines', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-logs-'))
  try {
    const path = join(directory, 'agent.log')
    const unicodeLine = '跨块日志'.repeat(25)
    writeFileSync(path, `${unicodeLine}\n${'z'.repeat(65_400)}\n`)
    assert.deepEqual(readNewestLines(path, 2, 1).lines, [unicodeLine])
    const oversized = readNewestLines(path, 1, 1).lines[0]
    assert.ok(oversized?.startsWith('[truncated]'))
    assert.ok(Buffer.byteLength(oversized!) <= 16 * 1024 + 20)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('log service only exposes real log files inside the configured directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-log-root-'))
  try {
    const logDirectory = join(directory, 'logs')
    mkdirSync(logDirectory)
    writeFileSync(join(logDirectory, 'agent.log'), 'inside\n')
    writeFileSync(join(logDirectory, 'notes.txt'), 'not a log\n')
    writeFileSync(join(directory, 'outside.log'), 'outside\n')
    symlinkSync(
      join(directory, 'outside.log'),
      join(logDirectory, 'escape.log')
    )
    symlinkSync(
      join(logDirectory, 'agent.log'),
      join(logDirectory, 'inside.log')
    )

    const service = new LogReaderService({ logDir: logDirectory } as AppConfig)
    assert.deepEqual(service.files(), ['agent.log', 'inside.log'])
    assert.equal(
      service.page({ filename: 'inside.log', page: 1, pageSize: 10 }).data[0]
        ?.message,
      'inside'
    )
    assert.throws(
      () => service.page({ filename: 'escape.log', page: 1, pageSize: 10 }),
      /Log file not found/
    )
    assert.throws(
      () => service.page({ filename: '../outside.log', page: 1, pageSize: 10 }),
      /Invalid log filename/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
