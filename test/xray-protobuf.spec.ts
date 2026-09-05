import assert from 'node:assert/strict'
import test from 'node:test'
import {
  protobufFields,
  protobufMessage,
  stringField,
  varintField
} from '@/protocols/xray/protobuf'
import {
  assignmentIdFromRuntimeUserId,
  runtimeUserId
} from '@/protocols/xray/xray.types'

test('protobuf codec preserves Xray int64 traffic counters', () => {
  const stat = protobufMessage([
    [1, 'string', 'user>>>vmess.id@eagleway.internal>>>traffic>>>uplink'],
    [2, 'varint', 9_007_199_254_740_993n]
  ])
  const response = protobufMessage([[1, 'message', stat]])
  const encodedStat = protobufFields(response)[0]?.value
  assert.ok(Buffer.isBuffer(encodedStat))
  assert.equal(
    stringField(encodedStat, 1),
    'user>>>vmess.id@eagleway.internal>>>traffic>>>uplink'
  )
  assert.equal(varintField(encodedStat, 2), 9_007_199_254_740_993n)
})

test('runtime user ids are unique across all phase-one protocols', () => {
  const assignmentId = '10c970c5-7fa4-4389-a12f-3f6802aeeb79'
  const userIds = [
    runtimeUserId('trojan', assignmentId),
    runtimeUserId('vless', assignmentId),
    runtimeUserId('vmess', assignmentId)
  ]
  assert.equal(new Set(userIds).size, 3)
  assert.equal(
    assignmentIdFromRuntimeUserId('trojan', userIds[0]!),
    assignmentId
  )
  assert.equal(assignmentIdFromRuntimeUserId('trojan', userIds[1]!), null)
})
