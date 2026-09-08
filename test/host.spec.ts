import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  parseOsRelease,
  portAvailable,
  tcpTableHasListeningPort
} from '@/host/host-inspector.service'

test('Ubuntu os-release parser handles quoted values', () => {
  assert.deepEqual(
    parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n'),
    { ID: 'ubuntu', VERSION_ID: '24.04', NAME: 'Ubuntu' }
  )
})

test('port probe distinguishes an occupied port from a released port', async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '::', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  assert.equal(await portAvailable(address.port), false)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  assert.equal(await portAvailable(address.port), true)
})

test('Linux TCP table parser only recognizes listening ports', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue',
    '   0: 00000000:0050 00000000:0000 0A 00000000:00000000',
    '   1: 0100007F:24E3 0100007F:01BB 01 00000000:00000000'
  ].join('\n')
  assert.equal(tcpTableHasListeningPort(table, 80), true)
  assert.equal(tcpTableHasListeningPort(table, 9443), false)
})
