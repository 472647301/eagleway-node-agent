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
  assert.equal(config.xrayLogTimezone, 'Asia/Shanghai')
  assert.equal(config.xrayLogRetentionDays, 7)
})

test('Xray log rotation configuration validates time zone and retention', () => {
  const env = { NODE_ENV: 'test', NODE_ID: '1' }
  const config = loadAppConfig({
    ...env,
    XRAY_LOG_TIMEZONE: 'UTC',
    XRAY_LOG_RETENTION_DAYS: '14'
  })
  assert.equal(config.xrayLogTimezone, 'UTC')
  assert.equal(config.xrayLogRetentionDays, 14)
  assert.throws(
    () => loadAppConfig({ ...env, XRAY_LOG_TIMEZONE: 'invalid/timezone' }),
    /XRAY_LOG_TIMEZONE/
  )
  for (const value of ['0', '-1', '1.5', '3651']) {
    assert.throws(
      () => loadAppConfig({ ...env, XRAY_LOG_RETENTION_DAYS: value }),
      /XRAY_LOG_RETENTION_DAYS/
    )
  }
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

test('production configuration does not require local bandwidth', () => {
  const config = loadAppConfig({
    NODE_ENV: 'production',
    NODE_ID: '1',
    REPORTING_ENABLED: 'false'
  })
  assert.equal(config.env, 'production')
})
