import { Inject, Injectable } from '@nestjs/common'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { invalidRequest } from '@/common/api/agent-error'
import { APP_CONFIG, type AppConfig } from '@/config/app-config'
import type { LogPageDto } from './log.dto'

const chunkSize = 64 * 1024
const maximumLineBytes = 16 * 1024
const safeLogFilename = /^(?!.*\.\.)[A-Za-z0-9_.-]+\.log$/
const sensitiveKeys = new Set([
  'assignmentkey',
  'authorization',
  'connectionoptions',
  'cookie',
  'credential',
  'password',
  'privatekey',
  'secret',
  'token'
])

export interface ParsedLogLine {
  timestamp: string
  level: string
  category: string
  message: string
  raw: string
}

export interface RawLogPage {
  lines: string[]
  total: number
}

export interface LogPage {
  data: ParsedLogLine[]
  total: number
}

@Injectable()
export class LogReaderService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  files(): string[] {
    let root: string
    try {
      root = realpathSync(this.config.logDir)
    } catch {
      return []
    }

    let filenames: string[]
    try {
      filenames = readdirSync(root)
    } catch {
      return []
    }

    return filenames
      .filter((filename) => safeLogFilename.test(filename))
      .filter((filename) => {
        try {
          const path = safeRealLogPath(root, filename)
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
      .sort()
  }

  page(body: LogPageDto): LogPage {
    if (!safeLogFilename.test(body.filename)) {
      throw invalidRequest('Invalid log filename')
    }

    let root: string
    try {
      root = realpathSync(this.config.logDir)
    } catch {
      throw invalidRequest('Log file not found')
    }

    let path: string
    try {
      path = safeRealLogPath(root, body.filename)
      if (!statSync(path).isFile()) throw new Error('Not a regular file')
    } catch {
      throw invalidRequest('Log file not found')
    }

    const page = readNewestLines(path, body.page, body.pageSize)
    return {
      data: page.lines.map((line) => parseLogLine(line)),
      total: page.total
    }
  }
}

export function readNewestLines(
  path: string,
  page: number,
  pageSize: number
): RawLogPage {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new RangeError('pageSize must be between 1 and 500')
  }

  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = fstatSync(file)
    if (!stats.isFile()) throw new Error('Log path is not a regular file')
    if (stats.size === 0) return { lines: [], total: 0 }

    const firstResultIndex = (page - 1) * pageSize
    const lastResultIndex = firstResultIndex + pageSize
    const lines: string[] = []
    let position = stats.size
    let total = 0
    let pending: Buffer = Buffer.alloc(0)
    let pendingTruncated = false
    let firstCandidate = true

    const consume = (bytes: Buffer, truncated: boolean): void => {
      if (firstCandidate) {
        firstCandidate = false
        if (bytes.length === 0) return
      }

      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1)
      if (total >= firstResultIndex && total < lastResultIndex) {
        const decoded = decodeUtf8(bytes)
        lines.push(truncated ? `[truncated] ${decoded}` : decoded)
      }
      total += 1
    }

    while (position > 0) {
      const length = Math.min(chunkSize, position)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const count = readSync(
          file,
          chunk,
          bytesRead,
          length - bytesRead,
          position + bytesRead
        )
        if (count === 0) throw new Error('Log file changed while being read')
        bytesRead += count
      }
      let segmentEnd = length

      for (let index = length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 10) continue
        const combined = prependBounded(
          chunk.subarray(index + 1, segmentEnd),
          pending,
          pendingTruncated
        )
        consume(combined.bytes, combined.truncated)
        pending = Buffer.alloc(0)
        pendingTruncated = false
        segmentEnd = index
      }

      const combined = prependBounded(
        chunk.subarray(0, segmentEnd),
        pending,
        pendingTruncated
      )
      pending = combined.bytes
      pendingTruncated = combined.truncated
    }

    consume(pending, pendingTruncated)
    return { lines, total }
  } finally {
    closeSync(file)
  }
}

export function parseLogLine(logLine: string): ParsedLogLine {
  const structured = parseStructuredLine(logLine)
  if (structured) return structured

  const raw = sanitizeText(logLine)
  const legacy = raw.match(/^\[(.*?)\]\s+\[(.*?)\]\s+(.*?)\s+-\s*(.*)$/)
  if (legacy) {
    return {
      timestamp: normalizeTimestamp(legacy[1] ?? ''),
      level: (legacy[2] ?? 'UNKNOWN').toUpperCase(),
      category: legacy[3] ?? 'N/A',
      message: legacy[4] ?? '',
      raw
    }
  }

  return {
    timestamp: new Date().toISOString(),
    level: 'UNKNOWN',
    category: 'N/A',
    message: raw.trim(),
    raw
  }
}

function safeRealLogPath(root: string, filename: string): string {
  if (!safeLogFilename.test(filename)) throw new Error('Unsafe filename')
  const path = realpathSync(join(root, filename))
  const childPath = relative(root, path)
  if (
    childPath === '' ||
    childPath === '..' ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    throw new Error('Log path escapes configured directory')
  }
  return path
}

function prependBounded(
  prefix: Buffer,
  suffix: Buffer,
  alreadyTruncated: boolean
): { bytes: Buffer; truncated: boolean } {
  const totalLength = prefix.length + suffix.length
  if (totalLength <= maximumLineBytes && !alreadyTruncated) {
    return { bytes: Buffer.concat([prefix, suffix]), truncated: false }
  }

  if (prefix.length >= maximumLineBytes) {
    return {
      bytes: Buffer.from(prefix.subarray(0, maximumLineBytes)),
      truncated: true
    }
  }

  return {
    bytes: Buffer.concat([
      prefix,
      suffix.subarray(0, maximumLineBytes - prefix.length)
    ]),
    truncated: true
  }
}

function decodeUtf8(bytes: Buffer): string {
  let start = 0
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

function parseStructuredLine(logLine: string): ParsedLogLine | null {
  let value: unknown
  try {
    value = JSON.parse(logLine)
  } catch {
    return null
  }
  if (!isRecord(value)) return null

  const sanitized = sanitizeValue(value) as Record<string, unknown>
  const raw = JSON.stringify(sanitized)
  const messageValue = sanitized.message ?? sanitized.event ?? ''
  return {
    timestamp: normalizeTimestamp(sanitized.timestamp ?? sanitized.time ?? ''),
    level: stringValue(sanitized.level, 'UNKNOWN').toUpperCase(),
    category: stringValue(
      sanitized.category ?? sanitized.context ?? sanitized.logger,
      'N/A'
    ),
    message:
      typeof messageValue === 'string'
        ? messageValue
        : JSON.stringify(messageValue),
    raw
  }
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const raw = String(value)
  const parsed = new Date(
    raw.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})$/, '$1T$2')
  )
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeValue(childValue, childKey)
    ])
  )
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
  return (
    sensitiveKeys.has(normalized) ||
    ['credential', 'password', 'privatekey', 'secret', 'token'].some((suffix) =>
      normalized.endsWith(suffix)
    )
  )
}

function sanitizeText(value: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return '[REDACTED PRIVATE KEY]'
  }
  return value
    .replace(
      /(["']?(?:authorization|connectionOptions|cookie|privateKey)["']?\s*[:=]\s*).*$/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(["']?(?:credential|password|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
      '$1[REDACTED]'
    )
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
