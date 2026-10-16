import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

type ArtifactFetch = (
  input: string,
  init: { redirect: 'follow'; signal: AbortSignal }
) => Promise<Response>

export interface ArtifactDownloadOptions {
  url: string
  target: string
  expectedHash: string
  timeoutMs: number
  maxBytes: number
  attempts?: number
  retryDelayMs?: number
  fetchImpl?: ArtifactFetch
}

class ArtifactDownloadFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = ArtifactDownloadFailure.name
  }
}

export async function downloadVerifiedArtifact(
  options: ArtifactDownloadOptions
): Promise<void> {
  const attempts = options.attempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 1_000
  const fetchImpl = options.fetchImpl ?? fetch
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Artifact download attempts must be a positive integer')
  }

  let lastFailure: ArtifactDownloadFailure | null = null
  let attempted = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attempted = attempt
    const temporary = `${options.target}.download-${process.pid}-${randomUUID()}`
    try {
      await downloadAttempt(options, temporary, fetchImpl)
      await rename(temporary, options.target)
      return
    } catch (error) {
      lastFailure = normalizeFailure(error, options.timeoutMs)
      if (!lastFailure.retryable || attempt === attempts) break
      await delay(retryDelayMs * attempt)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  const suffix = attempted > 1 ? ` after ${attempted} attempts` : ''
  throw new Error(
    `${lastFailure?.message ?? 'Artifact download failed'}${suffix}`
  )
}

async function downloadAttempt(
  options: ArtifactDownloadOptions,
  temporary: string,
  fetchImpl: ArtifactFetch
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(options.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    throw normalizeFailure(error, options.timeoutMs)
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel()
    const status = response.status
    throw new ArtifactDownloadFailure(
      status
        ? `Runtime artifact download failed with HTTP ${status}`
        : 'Runtime artifact download returned an empty response',
      status === 408 || status === 429 || status >= 500
    )
  }
  if (
    new URL(options.url).protocol !== 'https:' ||
    (response.url && new URL(response.url).protocol !== 'https:')
  ) {
    await response.body.cancel()
    throw new ArtifactDownloadFailure(
      'Runtime artifact redirected outside HTTPS',
      false
    )
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > options.maxBytes) {
    await response.body.cancel()
    throw new ArtifactDownloadFailure('Runtime artifact is too large', false)
  }

  const hash = createHash('sha256')
  let receivedBytes = 0
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length
      if (receivedBytes > options.maxBytes) {
        callback(
          new ArtifactDownloadFailure('Runtime artifact is too large', false)
        )
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      verifier,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    )
  } catch (error) {
    throw normalizeFailure(error, options.timeoutMs)
  }

  if (hash.digest('hex') !== options.expectedHash) {
    throw new ArtifactDownloadFailure(
      'Runtime artifact checksum mismatch',
      true
    )
  }
}

function normalizeFailure(
  error: unknown,
  timeoutMs: number
): ArtifactDownloadFailure {
  if (error instanceof ArtifactDownloadFailure) return error
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new ArtifactDownloadFailure(
      `Runtime artifact download timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
      true
    )
  }
  const detail =
    error instanceof Error
      ? error.message.replace(/\s+/g, ' ').trim().slice(0, 200)
      : ''
  return new ArtifactDownloadFailure(
    detail
      ? `Runtime artifact download failed: ${detail}`
      : 'Runtime artifact download failed',
    !hasPermanentSystemError(error)
  )
}

function hasPermanentSystemError(error: unknown): boolean {
  const permanentCodes = new Set([
    'EACCES',
    'EDQUOT',
    'EISDIR',
    'ENOENT',
    'ENOSPC',
    'EPERM',
    'EROFS'
  ])
  let candidate = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== 'object') return false
    if (
      'code' in candidate &&
      typeof candidate.code === 'string' &&
      permanentCodes.has(candidate.code)
    ) {
      return true
    }
    candidate = 'cause' in candidate ? candidate.cause : null
  }
  return false
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
