import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseLogLine, readNewestLines } from '@/logs/log-reader.service'

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
