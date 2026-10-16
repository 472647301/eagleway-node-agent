import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { downloadVerifiedArtifact } from '@/host/artifact-downloader'

test('artifact downloader streams a verified response into a private cache file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eagleway-download-'))
  const target = join(directory, 'artifact.zip')
  const content = Buffer.concat([
    Buffer.alloc(32 * 1024, 'a'),
    Buffer.alloc(32 * 1024, 'b')
  ])
  try {
    await downloadVerifiedArtifact({
      url: 'https://example.com/artifact.zip',
      target,
      expectedHash: createHash('sha256').update(content).digest('hex'),
      timeoutMs: 1_000,
      maxBytes: content.length,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(0, 32 * 1024))
              controller.enqueue(content.subarray(32 * 1024))
              controller.close()
            }
          }),
          {
            status: 200,
            headers: { 'content-length': String(content.length) }
          }
        )
    })

    assert.deepEqual(await readFile(target), content)
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(directory), ['artifact.zip'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('artifact downloader retries transient failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eagleway-download-'))
  const target = join(directory, 'artifact.zip')
  const content = Buffer.from('verified artifact')
  let calls = 0
  try {
    await downloadVerifiedArtifact({
      url: 'https://example.com/artifact.zip',
      target,
      expectedHash: createHash('sha256').update(content).digest('hex'),
      timeoutMs: 1_000,
      maxBytes: 1_024,
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) throw new DOMException('timed out', 'TimeoutError')
        if (calls === 2) return new Response(null, { status: 503 })
        return new Response(content, { status: 200 })
      }
    })

    assert.equal(calls, 3)
    assert.deepEqual(await readFile(target), content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('artifact downloader never promotes an oversized or corrupt response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eagleway-download-'))
  const target = join(directory, 'artifact.zip')
  try {
    await assert.rejects(
      downloadVerifiedArtifact({
        url: 'https://example.com/artifact.zip',
        target,
        expectedHash: createHash('sha256').update('expected').digest('hex'),
        timeoutMs: 1_000,
        maxBytes: 4,
        attempts: 1,
        fetchImpl: async () => new Response('too large', { status: 200 })
      }),
      /Runtime artifact is too large/
    )

    assert.deepEqual(await readdir(directory), [])

    await assert.rejects(
      downloadVerifiedArtifact({
        url: 'https://example.com/artifact.zip',
        target,
        expectedHash: createHash('sha256').update('expected').digest('hex'),
        timeoutMs: 1_000,
        maxBytes: 1_024,
        attempts: 1,
        fetchImpl: async () => new Response('corrupt', { status: 200 })
      }),
      /Runtime artifact checksum mismatch/
    )

    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
