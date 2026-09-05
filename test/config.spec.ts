import assert from 'node:assert/strict'
import test from 'node:test'
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

test('production configuration requires VPS bandwidth', () => {
  assert.throws(
    () =>
      loadAppConfig({
        NODE_ENV: 'production',
        NODE_ID: '1',
        REPORTING_ENABLED: 'false'
      }),
    /SERVER_BANDWIDTH_MBPS/
  )
})
