import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  parseOsRelease,
  pidFileProcessActive,
  portAvailable,
  tcpTableHasListeningPort
} from '@/host/host-inspector.service'
import {
  hostProfileFor,
  hostProfileOsId,
  isBaotaHostProfile
} from '@/host/host-profile'
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
import {
  XRAY_FIREWALL_COMMENT,
  ufwAllowTcpPortArgs,
  ufwAllowsTcpPort,
  ufwIsActive,
  ufwOwnedRuleNumbers
} from '@/host/firewall-rules'

test('Ubuntu os-release parser handles quoted values', () => {
  assert.deepEqual(
    parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n'),
    { ID: 'ubuntu', VERSION_ID: '24.04', NAME: 'Ubuntu' }
  )
})

test('host profiles recognize Ubuntu and Alibaba Cloud Linux 3', () => {
  assert.equal(
    hostProfileFor({ ID: 'ubuntu', VERSION_ID: '24.04' }, false),
    'ubuntu'
  )
  assert.equal(
    hostProfileFor({ ID: 'ubuntu', VERSION_ID: '22.04' }, true),
    'ubuntu-baota'
  )
  assert.equal(
    hostProfileFor({ ID: 'alinux', VERSION_ID: '3' }, false),
    'alinux'
  )
  assert.equal(
    hostProfileFor({ ID: 'alinux', VERSION_ID: '3' }, true),
    'alinux-baota'
  )
  assert.equal(hostProfileFor({ ID: 'alinux', VERSION_ID: '2' }, false), null)
  assert.equal(hostProfileOsId('alinux-baota'), 'alinux')
  assert.equal(isBaotaHostProfile('ubuntu-baota'), true)
  assert.equal(isBaotaHostProfile('alinux'), false)
})

test('Alibaba Cloud Linux 3.2104 os-release selects the alinux profile', () => {
  const release = parseOsRelease(`NAME="Alibaba Cloud Linux"
VERSION="3 (OpenAnolis Edition)"
ID="alinux"
ID_LIKE="rhel fedora centos anolis"
VERSION_ID="3"
VARIANT_ID="openanolis"
ALINUX_MINOR_ID="2104"
ALINUX_UPDATE_ID="12"
PLATFORM_ID="platform:al8"
`)

  assert.equal(hostProfileFor(release, false), 'alinux')
  assert.equal(release.ALINUX_UPDATE_ID, '12')
})

test('BaoTa PID probe treats root-owned active processes as running', () => {
  const permissionError = Object.assign(new Error('not permitted'), {
    code: 'EPERM'
  })
  assert.equal(
    pidFileProcessActive('123\n', () => {
      throw permissionError
    }),
    true
  )
  assert.equal(
    pidFileProcessActive('', () => true),
    false
  )
  assert.equal(
    pidFileProcessActive('123', () => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    }),
    false
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

test('UFW parser distinguishes existing and Eagleway-owned TCP rules', () => {
  const status = [
    'Status: active',
    '',
    '     To                         Action      From',
    '     --                         ------      ----',
    '[ 1] 22/tcp                     ALLOW IN    Anywhere',
    '[ 2] 80/tcp                     ALLOW IN    Anywhere                   # existing',
    `[ 3] 9443/tcp                   ALLOW IN    Anywhere                   # ${XRAY_FIREWALL_COMMENT}`,
    `[ 4] 9443/tcp (v6)              ALLOW IN    Anywhere (v6)              # ${XRAY_FIREWALL_COMMENT}`
  ].join('\n')

  assert.equal(ufwIsActive(status), true)
  assert.equal(ufwAllowsTcpPort(status, 80), true)
  assert.equal(ufwAllowsTcpPort(status, 9443), true)
  assert.equal(ufwAllowsTcpPort(status, 443), false)
  assert.deepEqual(ufwOwnedRuleNumbers(status, 9443), [4, 3])
  assert.deepEqual(ufwOwnedRuleNumbers(status, 80), [])
})

test('UFW allow arguments use rule syntax without the interactive force flag', () => {
  assert.deepEqual(ufwAllowTcpPortArgs(18020), [
    'allow',
    '18020/tcp',
    'comment',
    XRAY_FIREWALL_COMMENT
  ])
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
