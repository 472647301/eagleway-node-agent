import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAppConfig } from '@/config/app-config'

test('configuration validates node identity and network boundaries', () => {
  const config = loadAppConfig({
    NODE_ENV: 'test',
    NODE_ID: '42',
    REPORTING_ENABLED: 'false',
    ALLOWED_CIDRS: '127.0.0.1/32,2001:db8::/32',
    STATE_DIR: './tmp/state',
    STATE_KEY_PATH: './tmp/key',
    LOG_DIR: './tmp/logs'
  })
  assert.equal(config.nodeId, 42)
  assert.deepEqual(config.allowedCidrs, ['127.0.0.1/32', '2001:db8::/32'])
  assert.equal(config.reportingEnabled, false)
})

test('configuration requires a center URL when reporting is enabled', () => {
  assert.throws(
    () =>
      loadAppConfig({
        NODE_ENV: 'production',
        NODE_ID: '1',
        REPORTING_ENABLED: 'true'
      }),
    /CENTER_API_URL/
  )
})

test('configuration rejects malformed CIDR entries', () => {
  assert.throws(
    () =>
      loadAppConfig({
        NODE_ENV: 'test',
        NODE_ID: '1',
        REPORTING_ENABLED: 'false',
        ALLOWED_CIDRS: '0.0.0.0/99'
      }),
    /invalid CIDR/
  )
})

test('configuration loads the pinned runtime artifact from a policy file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-agent-policy-'))
  try {
    const policyPath = join(directory, 'runtime-policy.json')
    writeFileSync(
      policyPath,
      JSON.stringify({
        archiveUrl: 'https://example.com/trojan-go.zip',
        archiveSha256: 'a'.repeat(64)
      })
    )
    const config = loadAppConfig({
      NODE_ENV: 'production',
      NODE_ID: '1',
      REPORTING_ENABLED: 'false',
      TROJAN_GO_POLICY_PATH: policyPath,
      TROJAN_GO_ARCHIVE_URL: 'https://attacker.invalid/runtime.zip',
      TROJAN_GO_ARCHIVE_SHA256: 'b'.repeat(64)
    })
    assert.equal(config.trojanGoArchiveUrl, 'https://example.com/trojan-go.zip')
    assert.equal(config.trojanGoArchiveSha256, 'a'.repeat(64))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
