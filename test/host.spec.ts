import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  parseOsRelease,
  portAvailable,
  tcpTableHasListeningPort
} from '@/host/host-inspector.service'
import {
  EAGLEWAY_CERTBOT_HOOK_MARKER,
  certbotXrayDeployHook
} from '@/host/certificate-renewal'
import {
  EAGLEWAY_NGINX_MARKER,
  baotaAcmeConfigPath,
  baotaAcmeNginxConfig,
  baotaAcmeWebroot,
  inspectNginxDomain
} from '@/host/nginx-acme'

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

test('BaoTa Nginx parser finds an exact domain and quoted webroot', () => {
  const inspection = inspectNginxDomain(
    `server {
      server_name unrelated.example.com;
      root /www/wwwroot/unrelated;
    }
    server {
      server_name node.example.com www.node.example.com;
      root "/www/wwwroot/node";
    }`,
    'node.example.com'
  )

  assert.deepEqual(inspection, {
    matchesDomain: true,
    webroots: ['/www/wwwroot/node']
  })
})

test('BaoTa Nginx parser does not treat comments as active directives', () => {
  assert.deepEqual(
    inspectNginxDomain(
      `server {
        # server_name node.example.com;
        server_name other.example.com;
        root /www/wwwroot/other;
      }`,
      'node.example.com'
    ),
    { matchesDomain: false, webroots: [] }
  )
})

test('BaoTa ACME fallback uses an owned isolated vhost and webroot', () => {
  const domain = 'node.example.com'
  const webroot = baotaAcmeWebroot(domain)
  const config = baotaAcmeNginxConfig(domain, webroot)

  assert.equal(
    baotaAcmeConfigPath(domain),
    '/www/server/panel/vhost/nginx/eagleway-acme-node.example.com.conf'
  )
  assert.ok(config.startsWith(EAGLEWAY_NGINX_MARKER))
  assert.match(config, /server_name node\.example\.com;/)
  assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//)
  assert.match(config, /root \/var\/www\/eagleway-acme\/node\.example\.com;/)
  assert.match(config, /location \/ \{\s+return 404;/)
})

test('Certbot deploy hook only restarts Xray for its active certificate', () => {
  const hook = certbotXrayDeployHook()

  assert.ok(hook.startsWith(EAGLEWAY_CERTBOT_HOOK_MARKER))
  assert.match(hook, /RENEWED_LINEAGE/)
  assert.match(hook, /certificateFile/)
  assert.match(hook, /systemctl try-restart eagleway-xray\.service/)
})
