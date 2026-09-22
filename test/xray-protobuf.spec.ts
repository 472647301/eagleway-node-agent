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
import { XrayAssignmentsService } from '@/protocols/xray/xray-assignments.service'
import { parseOnlineUserIds } from '@/protocols/xray/xray.client'

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

test('online user response parser ignores unrelated Xray stats names', () => {
  const response = protobufMessage([
    [1, 'string', 'user>>>trojan.first@eagleway.internal>>>online'],
    [1, 'string', 'user>>>trojan.second@eagleway.internal>>>online'],
    [1, 'string', 'user>>>trojan.first@eagleway.internal>>>traffic>>>uplink']
  ])

  assert.deepEqual(parseOnlineUserIds(response), [
    'trojan.first@eagleway.internal',
    'trojan.second@eagleway.internal'
  ])
})

test('traffic report keeps managed and online user counts separate', async () => {
  const first = '10c970c5-7fa4-4389-a12f-3f6802aeeb79'
  const second = 'd476442c-6227-4e0e-81cd-2372f9d799a8'
  const firstRuntimeId = runtimeUserId('trojan', first)
  const secondRuntimeId = runtimeUserId('trojan', second)
  const client = {
    listUserIds: async () => [firstRuntimeId, secondRuntimeId],
    userTraffic: async () => new Map(),
    invocationId: async () => 'a'.repeat(32),
    listOnlineUserIds: async () => [
      firstRuntimeId,
      firstRuntimeId,
      'trojan.unknown@eagleway.internal'
    ]
  }
  const service = new XrayAssignmentsService(
    client as never,
    {} as never,
    {} as never
  )

  const report = await service.traffic('trojan', '2026-09-22T00:00:00.000Z')

  assert.equal(report.managedUserCount, 2)
  assert.equal(report.onlineUserCount, 1)
  assert.deepEqual(
    report.users.map((user) => user.assignmentId),
    [first, second]
  )
})
