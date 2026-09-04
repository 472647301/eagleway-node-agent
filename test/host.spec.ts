import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOsRelease } from '@/host/host-inspector.service'

test('Ubuntu os-release parser handles quoted values', () => {
  assert.deepEqual(
    parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n'),
    { ID: 'ubuntu', VERSION_ID: '24.04', NAME: 'Ubuntu' }
  )
})
