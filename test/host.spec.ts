import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  parseOsRelease,
  portAvailable
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
