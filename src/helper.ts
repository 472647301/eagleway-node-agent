import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate
} from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

const stateDir = resolve(
  process.env.STATE_DIR || '/var/lib/eagleway-node-agent'
)
const runtimeDir = '/etc/eagleway-node-agent/runtimes/xray'
const runtimeBinary = '/usr/local/bin/xray'
const unitPath = '/etc/systemd/system/eagleway-xray.service'
const runtimeMarker = join(runtimeDir, '.managed-by-eagleway-node-agent')
const runtimeMarkerValue = 'eagleway-node-agent:xray:v1\n'
const nginxMarker = '# Managed by eagleway-node-agent\n'
const xrayRelease = {
  version: 'v26.3.27',
  assets: {
    x64: {
      fileName: 'Xray-linux-64.zip',
      sha256: '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae'
    },
    arm64: {
      fileName: 'Xray-linux-arm64-v8a.zip',
      sha256: '4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c'
    }
  }
} as const

type InstallPlan = {
  schemaVersion: 1
  action: 'install'
  nodeId: number
  protocol: 'trojan' | 'vless' | 'vmess'
  hostProfile: 'ubuntu' | 'ubuntu-baota'
  architecture: keyof typeof xrayRelease.assets
  port: number
  domain: string
  proxyUrl: string | null
  apiAddress: string
  acmeEmail: string | null
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('Helper must run as root on Linux')
  }
  const [action, argument, extra] = process.argv.slice(2)
  if (extra) fail('Too many arguments')
  switch (action) {
    case 'xray-install':
      if (!argument) fail('Install plan is required')
      await install(readPlan(argument))
      break
    case 'xray-uninstall':
      assertNoArgument(argument)
      uninstall()
      break
    case 'xray-start':
      assertNoArgument(argument)
      systemctl('start', 'eagleway-xray.service')
      break
    case 'xray-stop':
      assertNoArgument(argument)
      systemctl('stop', 'eagleway-xray.service')
      break
    default:
      fail('Unsupported helper action')
  }
}

async function install(plan: InstallPlan): Promise<void> {
  assertUbuntu()
  assertManagedResourceBoundary()
  const artifact = xrayArtifact(plan.architecture)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  atomicWrite(runtimeMarker, runtimeMarkerValue, 0o600)
  mkdirSync(join(stateDir, 'artifacts'), { recursive: true, mode: 0o700 })
  mkdirSync(join(stateDir, 'extract'), { recursive: true, mode: 0o700 })
  const archivePath = join(stateDir, 'artifacts', artifact.cacheName)
  if (!existsSync(archivePath) || sha256(archivePath) !== artifact.sha256) {
    await download(artifact.url, archivePath, artifact.sha256)
  }
  const extractDir = join(stateDir, 'extract', artifact.sha256)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true, mode: 0o700 })
  run(
    '/usr/bin/unzip',
    ['-j', '-o', archivePath, '*/xray', '-d', extractDir],
    false
  )
  const extracted = join(extractDir, 'xray')
  if (!existsSync(extracted)) {
    run('/usr/bin/unzip', ['-j', '-o', archivePath, 'xray', '-d', extractDir])
  }
  if (!existsSync(extracted)) fail('Xray archive does not contain xray')
  copyFileSync(extracted, runtimeBinary)
  chmodSync(runtimeBinary, 0o755)

  const certificate = ensureCertificate(plan)
  atomicWrite(
    join(runtimeDir, 'config.json'),
    `${JSON.stringify(xrayConfig(plan, certificate), null, 2)}\n`,
    0o600
  )
  run(runtimeBinary, [
    'run',
    '-test',
    '-config',
    join(runtimeDir, 'config.json')
  ])
  atomicWrite(unitPath, systemdUnit(), 0o644)
  systemctl('daemon-reload')
  systemctl('enable', 'eagleway-xray.service')
  systemctl('restart', 'eagleway-xray.service')
  run('/usr/bin/systemctl', ['is-active', '--quiet', 'eagleway-xray.service'])
  rmSync(extractDir, { recursive: true, force: true })
}

function uninstall(): void {
  if (!isManagedRuntime()) return
  run(
    '/usr/bin/systemctl',
    ['disable', '--now', 'eagleway-xray.service'],
    false
  )
  safeRemove(unitPath)
  safeRemove(runtimeBinary)
  for (const directory of ['/etc/nginx/conf.d']) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (/^eagleway-acme-[A-Za-z0-9.-]+\.conf$/.test(name)) {
        const path = join(directory, name)
        if (readFileSync(path, 'utf8').startsWith(nginxMarker)) safeRemove(path)
      }
    }
  }
  systemctl('daemon-reload')
  if (existsSync('/usr/sbin/nginx')) {
    run('/usr/sbin/nginx', ['-t'], false)
    run('/usr/bin/systemctl', ['reload', 'nginx'], false)
  }
  rmSync(runtimeDir, { recursive: true, force: true })
}

function ensureCertificate(plan: InstallPlan): { cert: string; key: string } {
  const candidates = [
    {
      cert: `/www/server/panel/vhost/cert/${plan.domain}/fullchain.pem`,
      key: `/www/server/panel/vhost/cert/${plan.domain}/privkey.pem`
    },
    {
      cert: `/etc/letsencrypt/live/${plan.domain}/fullchain.pem`,
      key: `/etc/letsencrypt/live/${plan.domain}/privkey.pem`
    }
  ]
  const existing = candidates.find(
    (item) => existsSync(item.cert) && existsSync(item.key)
  )
  if (existing) {
    validateCertificate(existing, plan.domain)
    return existing
  }
  if (plan.hostProfile === 'ubuntu-baota') {
    fail('BaoTa certificate is unavailable; issue it in BaoTa before retrying')
  }

  run('/usr/bin/apt-get', ['update'])
  run('/usr/bin/apt-get', [
    'install',
    '-y',
    '--no-install-recommends',
    'nginx',
    'certbot'
  ])
  const webroot = '/var/www/eagleway-acme'
  mkdirSync(webroot, { recursive: true, mode: 0o755 })
  const nginxPath = `/etc/nginx/conf.d/eagleway-acme-${plan.domain}.conf`
  if (
    existsSync(nginxPath) &&
    !readFileSync(nginxPath, 'utf8').startsWith(nginxMarker)
  ) {
    fail('Existing Nginx configuration is not owned by Eagleway')
  }
  atomicWrite(nginxPath, nginxConfig(plan, webroot), 0o644)
  run('/usr/sbin/nginx', ['-t'])
  systemctl('enable', 'nginx')
  const nginxActive =
    run('/usr/bin/systemctl', ['is-active', '--quiet', 'nginx'], false)
      .status === 0
  systemctl(nginxActive ? 'reload' : 'start', 'nginx')
  const certbotArgs = [
    'certonly',
    '--webroot',
    '-w',
    webroot,
    '-d',
    plan.domain,
    '--non-interactive',
    '--agree-tos',
    '--keep-until-expiring'
  ]
  if (plan.acmeEmail) certbotArgs.push('--email', plan.acmeEmail)
  else certbotArgs.push('--register-unsafely-without-email')
  run('/usr/bin/certbot', certbotArgs)
  const issued = candidates[1]!
  if (!existsSync(issued.cert) || !existsSync(issued.key)) {
    fail('Certificate issuance did not create expected files')
  }
  validateCertificate(issued, plan.domain)
  return issued
}

function nginxConfig(plan: InstallPlan, webroot: string): string {
  const upstream = plan.proxyUrl
    ? `    proxy_set_header Host $host;\n    proxy_ssl_server_name on;\n    proxy_pass ${plan.proxyUrl};`
    : '    root /var/www/html;\n    try_files $uri $uri/ =404;'
  return `${nginxMarker}server {
  listen 80;
  listen [::]:80;
  server_name ${plan.domain};

  location ^~ /.well-known/acme-challenge/ {
    root ${webroot};
  }

  location / {
${upstream}
  }
}
`
}

function xrayConfig(
  plan: InstallPlan,
  certificate: { cert: string; key: string }
) {
  const settings: Record<string, unknown> =
    plan.protocol === 'trojan'
      ? { users: [], fallbacks: [{ dest: 80 }] }
      : plan.protocol === 'vless'
        ? { clients: [], decryption: 'none', fallbacks: [{ dest: 80 }] }
        : { clients: [] }
  return {
    log: {
      access: '/var/log/eagleway-node-agent/xray-access.log',
      error: '/var/log/eagleway-node-agent/xray-error.log',
      loglevel: 'warning'
    },
    api: {
      tag: 'api',
      listen: plan.apiAddress,
      services: ['HandlerService', 'StatsService']
    },
    stats: {},
    policy: {
      levels: {
        '0': { statsUserUplink: true, statsUserDownlink: true }
      }
    },
    inbounds: [
      {
        tag: `eagleway-${plan.protocol}`,
        listen: '::',
        port: plan.port,
        protocol: plan.protocol,
        settings,
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: {
            serverName: plan.domain,
            alpn: ['http/1.1'],
            certificates: [
              {
                certificateFile: certificate.cert,
                keyFile: certificate.key
              }
            ]
          }
        }
      }
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }]
  }
}

function systemdUnit(): string {
  return `[Unit]
Description=Eagleway Xray Runtime
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -config /etc/eagleway-node-agent/runtimes/xray/config.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/etc/letsencrypt /www/server/panel/vhost/cert
ReadWritePaths=/var/log/eagleway-node-agent
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
}

function readPlan(path: string): InstallPlan {
  const staging = realpathSync(join(stateDir, 'staging'))
  const actual = realpathSync(path)
  const fromRoot = relative(staging, actual)
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    basename(actual) !== basename(path)
  ) {
    fail('Install plan path is outside staging directory')
  }
  const value = JSON.parse(readFileSync(actual, 'utf8')) as Record<
    string,
    unknown
  >
  const allowedKeys = new Set([
    'schemaVersion',
    'action',
    'nodeId',
    'protocol',
    'hostProfile',
    'architecture',
    'port',
    'domain',
    'proxyUrl',
    'apiAddress',
    'acmeEmail'
  ])
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    fail('Install plan has unknown fields')
  if (value.schemaVersion !== 1 || value.action !== 'install')
    fail('Install plan version is invalid')
  if (!Number.isSafeInteger(value.nodeId) || Number(value.nodeId) <= 0)
    fail('nodeId is invalid')
  if (!['trojan', 'vless', 'vmess'].includes(String(value.protocol)))
    fail('Protocol is invalid')
  if (!['ubuntu', 'ubuntu-baota'].includes(String(value.hostProfile)))
    fail('Host profile is invalid')
  if (!['x64', 'arm64'].includes(String(value.architecture)))
    fail('Architecture is unsupported')
  if (value.architecture !== process.arch)
    fail('Architecture does not match host')
  if (
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65_535
  )
    fail('Port is invalid')
  if (typeof value.domain !== 'string' || !validDomain(value.domain))
    fail('Domain is invalid')
  if (value.proxyUrl !== null) validateProxyUrl(value.proxyUrl)
  if (
    typeof value.apiAddress !== 'string' ||
    !/^127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value.apiAddress) ||
    Number(value.apiAddress.split(':')[1]) > 65_535
  )
    fail('Xray API address is invalid')
  if (
    value.acmeEmail !== null &&
    (typeof value.acmeEmail !== 'string' ||
      !/^[^\s@]+@[^\s@]+$/.test(value.acmeEmail))
  )
    fail('ACME email is invalid')
  return value as unknown as InstallPlan
}

async function download(
  url: string,
  target: string,
  expectedHash: string
): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000)
  })
  if (!response.ok || !response.body) fail('Runtime artifact download failed')
  if (new URL(response.url).protocol !== 'https:')
    fail('Runtime artifact redirected outside HTTPS')
  const length = Number(response.headers.get('content-length') || 0)
  if (length > 128 * 1024 * 1024) fail('Runtime artifact is too large')
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > 128 * 1024 * 1024) fail('Runtime artifact is too large')
  if (createHash('sha256').update(data).digest('hex') !== expectedHash)
    fail('Runtime artifact checksum mismatch')
  atomicWriteBuffer(target, data, 0o600)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function atomicWrite(path: string, value: string, mode: number): void {
  atomicWriteBuffer(path, Buffer.from(value), mode)
}

function atomicWriteBuffer(path: string, value: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, value, { mode, flag: 'wx' })
  renameSync(temporary, path)
  chmodSync(path, mode)
}

function systemctl(...args: string[]): void {
  run('/usr/bin/systemctl', args)
}

function run(
  executable: string,
  args: string[],
  required = true
): SpawnSyncReturns<string> {
  const result = spawnSync(executable, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 1024 * 1024
  })
  if (required && (result.error || result.status !== 0))
    fail('Privileged host command failed')
  return result
}

function assertUbuntu(): void {
  const release = readFileSync('/etc/os-release', 'utf8')
  if (!/^ID=ubuntu$/m.test(release) && !/^ID="ubuntu"$/m.test(release)) {
    fail('Only Ubuntu is supported')
  }
}

function validDomain(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
      value
    )
  )
}

function validateProxyUrl(value: unknown): void {
  if (typeof value !== 'string') fail('Proxy URL is invalid')
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    /[\s{};]/.test(value)
  )
    fail('Proxy URL is invalid')
}

function xrayArtifact(architecture: InstallPlan['architecture']) {
  const asset = xrayRelease.assets[architecture]
  return {
    url: `https://github.com/XTLS/Xray-core/releases/download/${xrayRelease.version}/${asset.fileName}`,
    sha256: asset.sha256,
    cacheName: `xray-${xrayRelease.version}-${architecture}-${asset.sha256}.zip`
  }
}

function assertManagedResourceBoundary(): void {
  if (isManagedRuntime()) return
  if (
    existsSync(runtimeDir) ||
    existsSync(runtimeBinary) ||
    existsSync(unitPath)
  ) {
    fail('Existing Xray resources are not owned by Eagleway')
  }
}

function isManagedRuntime(): boolean {
  return (
    existsSync(runtimeMarker) &&
    readFileSync(runtimeMarker, 'utf8') === runtimeMarkerValue
  )
}

function validateCertificate(
  certificate: { cert: string; key: string },
  domain: string
): void {
  try {
    const parsed = new X509Certificate(readFileSync(certificate.cert))
    if (!parsed.checkHost(domain)) fail('Certificate does not match domain')
    if (new Date(parsed.validTo).getTime() < Date.now() + 7 * 86_400_000) {
      fail('Certificate expires too soon')
    }
    const certKey = parsed.publicKey.export({ type: 'spki', format: 'der' })
    const privateKey = createPublicKey(
      createPrivateKey(readFileSync(certificate.key))
    ).export({ type: 'spki', format: 'der' })
    if (!Buffer.from(certKey).equals(Buffer.from(privateKey))) {
      fail('Certificate and private key do not match')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Certificate')) {
      throw error
    }
    fail('Certificate validation failed')
  }
}

function assertNoArgument(value: string | undefined): void {
  if (value !== undefined) fail('This action does not accept arguments')
}

function safeRemove(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

void main().catch(() => fail('Privileged helper failed'))
