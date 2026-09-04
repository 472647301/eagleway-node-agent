import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAddress } from '@/security/ip-allowlist.guard'

test('IP normalization handles IPv4-mapped addresses without trusting chains', () => {
  assert.equal(normalizeAddress('::ffff:203.0.113.9'), '203.0.113.9')
  assert.equal(normalizeAddress('203.0.113.9, 10.0.0.1'), '')
})
