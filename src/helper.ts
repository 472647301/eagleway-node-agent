import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  CERTBOT_XRAY_DEPLOY_HOOK,
  EAGLEWAY_CERTBOT_HOOK_MARKER,
  certbotXrayDeployHook
} from './host/certificate-renewal'
import {
  BAOTA_NGINX_BINARY,
  BAOTA_NGINX_VHOST_DIRECTORY,
  EAGLEWAY_NGINX_MARKER,
  baotaAcmeConfigPath,
  baotaAcmeNginxConfig,
  baotaAcmeWebroot,
  inspectNginxDomain
} from './host/nginx-acme'
import {
  XRAY_FIREWALL_COMMENT,
  ufwAllowsTcpPort,
  ufwIsActive,
  ufwOwnedRuleNumbers
} from './host/firewall-rules'

const stateDir = resolve(
  process.env.STATE_DIR || '/var/lib/eagleway-node-agent'
)
const runtimesDir = '/etc/eagleway-node-agent/runtimes'
const runtimeDir = '/etc/eagleway-node-agent/runtimes/xray'
const runtimeBinary = '/usr/local/bin/xray'
const unitPath = '/etc/systemd/system/eagleway-xray.service'
const runtimeConfigPath = join(runtimeDir, 'config.json')
const runtimeMarker = join(runtimeDir, '.managed-by-eagleway-node-agent')
const runtimeMarkerValue = 'eagleway-node-agent:xray:v1\n'
const firewallManifestPath = join(runtimeDir, 'firewall-rules.json')
const runtimeLogDir = '/var/log/eagleway-node-agent'
const runtimeLogPaths = [
  join(runtimeLogDir, 'xray-access.log'),
  join(runtimeLogDir, 'xray-error.log')
]
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
  action: 'install' | 'apply-config'
  nodeId: number
  protocol: 'trojan' | 'vless' | 'vmess'
  revision: number
  hostProfile: 'ubuntu' | 'ubuntu-baota'
  architecture: keyof typeof xrayRelease.assets
  port: number
  domain: string
  proxyUrl: string | null
  apiAddress: string
  acmeEmail: string | null
}

type FirewallRule =
  | {
      manager: 'ufw'
      port: number
    }
  | {
      manager: 'firewalld'
      port: number
      zone: string
      runtimeAdded: boolean
      permanentAdded: boolean
    }

interface FirewallManifest {
  schemaVersion: 1
  rules: FirewallRule[]
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
      await install(readPlan(argument, 'install'))
      break
    case 'xray-apply-config':
      if (!argument) fail('Configuration plan is required')
      await applyConfig(readPlan(argument, 'apply-config'))
      break
    case 'xray-uninstall':
      assertNoArgument(argument)
      uninstall()
      break
    case 'xray-start':
      assertNoArgument(argument)
      prepareRuntimeLogs()
      systemctl('start', 'eagleway-xray.service')
      break
    case 'xray-stop':
      assertNoArgument(argument)
      systemctl('stop', 'eagleway-xray.service')
      break
    case 'xray-prepare-logs':
      assertNoArgument(argument)
      prepareRuntimeLogs()
      break
    default:
      fail('Unsupported helper action')
  }
}

async function install(plan: InstallPlan): Promise<void> {
  assertUbuntu()
  assertManagedResourceBoundary()
  const artifact = xrayArtifact(plan.architecture)
  mkdirSync(runtimesDir, { recursive: true, mode: 0o711 })
  chmodSync(runtimesDir, 0o711)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o711 })
  chmodSync(runtimeDir, 0o711)
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
    false,
    'Runtime archive extraction failed'
  )
  const extracted = join(extractDir, 'xray')
  if (!existsSync(extracted)) {
    run(
      '/usr/bin/unzip',
      ['-j', '-o', archivePath, 'xray', '-d', extractDir],
      true,
      'Runtime archive extraction failed'
    )
  }
  if (!existsSync(extracted)) fail('Xray archive does not contain xray')
  copyFileSync(extracted, runtimeBinary)
  chmodSync(runtimeBinary, 0o755)

  const previousFirewall = readFirewallManifest()
  try {
    ensureFirewallPorts([80, plan.port])
    const certificate = ensureCertificate(plan)
    atomicWrite(
      runtimeConfigPath,
      `${JSON.stringify(xrayConfig(plan, certificate), null, 2)}\n`,
      0o600
    )
    prepareRuntimeLogs()
    run(
      runtimeBinary,
      ['run', '-test', '-config', runtimeConfigPath],
      true,
      'Generated Xray configuration is invalid'
    )
    atomicWrite(unitPath, systemdUnit(), 0o644)
    systemctl('daemon-reload')
    systemctl('enable', 'eagleway-xray.service')
    systemctl('restart', 'eagleway-xray.service')
    run(
      '/usr/bin/systemctl',
      ['is-active', '--quiet', 'eagleway-xray.service'],
      true,
      'Xray runtime failed to start'
    )
    reconcileFirewallPorts([80, plan.port])
    rmSync(extractDir, { recursive: true, force: true })
  } catch (error) {
    restoreFirewallManifest(previousFirewall)
    throw error
  }
}

async function applyConfig(plan: InstallPlan): Promise<void> {
  assertUbuntu()
  if (!isManagedRuntime() || !existsSync(runtimeConfigPath)) {
    fail('Managed Xray runtime is not installed')
  }
  const previousFirewall = readFirewallManifest()
  try {
    ensureFirewallPorts([80, plan.port])
    const certificate = ensureCertificate(plan)
    const candidatePath = join(runtimeDir, `.config.next-${process.pid}.json`)
    const backupPath = join(runtimeDir, `.config.backup-${process.pid}.json`)
    atomicWrite(
      candidatePath,
      `${JSON.stringify(xrayConfig(plan, certificate), null, 2)}\n`,
      0o600
    )
    prepareRuntimeLogs()
    const validation = run(
      runtimeBinary,
      ['run', '-test', '-config', candidatePath],
      false
    )
    if (validation.error || validation.status !== 0) {
      safeRemove(candidatePath)
      fail('Candidate Xray configuration is invalid')
    }

    const wasActive =
      run(
        '/usr/bin/systemctl',
        ['is-active', '--quiet', 'eagleway-xray.service'],
        false
      ).status === 0
    copyFileSync(runtimeConfigPath, backupPath)
    chmodSync(backupPath, 0o600)
    renameSync(candidatePath, runtimeConfigPath)
    chmodSync(runtimeConfigPath, 0o600)
    if (wasActive) {
      const restarted = run(
        '/usr/bin/systemctl',
        ['restart', 'eagleway-xray.service'],
        false
      )
      const active = run(
        '/usr/bin/systemctl',
        ['is-active', '--quiet', 'eagleway-xray.service'],
        false
      )
      if (
        restarted.error ||
        restarted.status !== 0 ||
        active.error ||
        active.status !== 0
      ) {
        copyFileSync(backupPath, runtimeConfigPath)
        chmodSync(runtimeConfigPath, 0o600)
        run('/usr/bin/systemctl', ['restart', 'eagleway-xray.service'], false)
        safeRemove(backupPath)
        fail('Xray configuration update failed and was rolled back')
      }
    }
    safeRemove(backupPath)
    reconcileFirewallPorts([80, plan.port])
  } catch (error) {
    restoreFirewallManifest(previousFirewall)
    throw error
  }
}

function uninstall(): void {
  if (!isManagedRuntime()) return
  run(
    '/usr/bin/systemctl',
    ['disable', '--now', 'eagleway-xray.service'],
    false
  )
  removeManagedFirewallRules()
  safeRemove(unitPath)
  safeRemove(runtimeBinary)
  if (
    existsSync(CERTBOT_XRAY_DEPLOY_HOOK) &&
    readFileSync(CERTBOT_XRAY_DEPLOY_HOOK, 'utf8').startsWith(
      EAGLEWAY_CERTBOT_HOOK_MARKER
    )
  ) {
    safeRemove(CERTBOT_XRAY_DEPLOY_HOOK)
  }
  let standardNginxChanged = false
  let baotaNginxChanged = false
  for (const directory of ['/etc/nginx/conf.d', BAOTA_NGINX_VHOST_DIRECTORY]) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (/^eagleway-acme-[A-Za-z0-9.-]+\.conf$/.test(name)) {
        const path = join(directory, name)
        if (readFileSync(path, 'utf8').startsWith(EAGLEWAY_NGINX_MARKER)) {
          safeRemove(path)
          if (directory === BAOTA_NGINX_VHOST_DIRECTORY) {
            baotaNginxChanged = true
          } else {
            standardNginxChanged = true
          }
        }
      }
    }
  }
  systemctl('daemon-reload')
  if (standardNginxChanged && existsSync('/usr/sbin/nginx')) {
    run('/usr/sbin/nginx', ['-t'], false)
    run('/usr/bin/systemctl', ['reload', 'nginx'], false)
  }
  if (baotaNginxChanged && existsSync(BAOTA_NGINX_BINARY)) {
    run(BAOTA_NGINX_BINARY, ['-t'], false)
    run(BAOTA_NGINX_BINARY, ['-s', 'reload'], false)
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
    if (existing === candidates[1]) ensureCertbotDeployHook()
    return existing
  }

  if (plan.hostProfile === 'ubuntu') {
    run(
      '/usr/bin/apt-get',
      ['update'],
      true,
      'System package index update failed'
    )
    run(
      '/usr/bin/apt-get',
      ['install', '-y', '--no-install-recommends', 'nginx', 'certbot'],
      true,
      'Required package installation failed'
    )
  } else if (!existsSync('/usr/bin/certbot')) {
    run(
      '/usr/bin/apt-get',
      ['update'],
      true,
      'System package index update failed'
    )
    run(
      '/usr/bin/apt-get',
      ['install', '-y', '--no-install-recommends', 'certbot'],
      true,
      'Required package installation failed'
    )
  }
  const webroot =
    plan.hostProfile === 'ubuntu-baota'
      ? ensureBaotaAcmeWebroot(plan.domain)
      : '/var/www/eagleway-acme'
  mkdirSync(webroot, { recursive: true, mode: 0o755 })
  const nginxPath = `/etc/nginx/conf.d/eagleway-acme-${plan.domain}.conf`
  if (plan.hostProfile === 'ubuntu') {
    if (
      existsSync(nginxPath) &&
      !readFileSync(nginxPath, 'utf8').startsWith(EAGLEWAY_NGINX_MARKER)
    ) {
      fail('Existing Nginx configuration is not owned by Eagleway')
    }
    atomicWrite(nginxPath, nginxConfig(plan, webroot), 0o644)
    run(
      '/usr/sbin/nginx',
      ['-t'],
      true,
      'Nginx configuration validation failed'
    )
    systemctl('enable', 'nginx')
    const nginxActive =
      run('/usr/bin/systemctl', ['is-active', '--quiet', 'nginx'], false)
        .status === 0
    systemctl(nginxActive ? 'reload' : 'start', 'nginx')
  }
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
  run('/usr/bin/certbot', certbotArgs, true, 'Certificate issuance failed')
  const issued = candidates[1]!
  if (!existsSync(issued.cert) || !existsSync(issued.key)) {
    fail('Certificate issuance did not create expected files')
  }
  validateCertificate(issued, plan.domain)
  ensureCertbotDeployHook()
  return issued
}

function ensureCertbotDeployHook(): void {
  if (
    existsSync(CERTBOT_XRAY_DEPLOY_HOOK) &&
    !readFileSync(CERTBOT_XRAY_DEPLOY_HOOK, 'utf8').startsWith(
      EAGLEWAY_CERTBOT_HOOK_MARKER
    )
  ) {
    fail('Existing Certbot deploy hook is not owned by Eagleway')
  }
  atomicWrite(CERTBOT_XRAY_DEPLOY_HOOK, certbotXrayDeployHook(), 0o755)
}

function ensureBaotaAcmeWebroot(domain: string): string {
  const directory = BAOTA_NGINX_VHOST_DIRECTORY
  if (!existsSync(directory)) {
    fail('BaoTa Nginx vhost directory is unavailable')
  }
  const configPath = baotaAcmeConfigPath(domain)
  let matchingSite = false
  let managedConfigMatches = false
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.conf')) continue
    const path = join(directory, name)
    const content = readFileSync(path, 'utf8')
    const inspection = inspectNginxDomain(content, domain)
    if (!inspection.matchesDomain) continue
    matchingSite = true
    if (path === configPath && content.startsWith(EAGLEWAY_NGINX_MARKER)) {
      managedConfigMatches = true
    }
    const root = inspection.webroots.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isDirectory()
    )
    if (root) return root
  }
  if (matchingSite && !managedConfigMatches) {
    fail(`BaoTa Nginx site root is unavailable for ${domain}`)
  }

  const webroot = baotaAcmeWebroot(domain)
  const previousConfig = existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : null
  if (previousConfig && !previousConfig.startsWith(EAGLEWAY_NGINX_MARKER)) {
    fail('Existing BaoTa Nginx configuration is not owned by Eagleway')
  }
  if (!existsSync(BAOTA_NGINX_BINARY)) {
    fail('BaoTa Nginx binary is unavailable')
  }
  mkdirSync(webroot, { recursive: true, mode: 0o755 })
  atomicWrite(configPath, baotaAcmeNginxConfig(domain, webroot), 0o644)
  const validation = run(BAOTA_NGINX_BINARY, ['-t'], false)
  if (validation.error || validation.status !== 0) {
    restoreManagedNginxConfig(configPath, previousConfig)
    fail('BaoTa Nginx configuration validation failed')
  }
  const reload = run(BAOTA_NGINX_BINARY, ['-s', 'reload'], false)
  if (reload.error || reload.status !== 0) {
    restoreManagedNginxConfig(configPath, previousConfig)
    run(BAOTA_NGINX_BINARY, ['-t'], false)
    run(BAOTA_NGINX_BINARY, ['-s', 'reload'], false)
    fail('BaoTa Nginx reload failed')
  }
  return webroot
}

function restoreManagedNginxConfig(
  path: string,
  previousConfig: string | null
): void {
  if (previousConfig === null) {
    safeRemove(path)
  } else {
    atomicWrite(path, previousConfig, 0o644)
  }
}

function nginxConfig(plan: InstallPlan, webroot: string): string {
  const upstream = plan.proxyUrl
    ? `    proxy_set_header Host $host;\n    proxy_ssl_server_name on;\n    proxy_pass ${plan.proxyUrl};`
    : '    root /var/www/html;\n    try_files $uri $uri/ =404;'
  return `${EAGLEWAY_NGINX_MARKER}server {
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
      access: runtimeLogPaths[0],
      error: runtimeLogPaths[1],
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
        '0': {
          statsUserUplink: true,
          statsUserDownlink: true,
          statsUserOnline: true
        }
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
ExecStartPre=/usr/local/libexec/eagleway-node-helper xray-prepare-logs
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

function prepareRuntimeLogs(): void {
  const owner = statSync(runtimeLogDir)
  for (const path of runtimeLogPaths) {
    const file = openSync(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o640
    )
    try {
      if (!fstatSync(file).isFile()) fail('Xray log path is not a regular file')
      fchownSync(file, owner.uid, owner.gid)
      fchmodSync(file, 0o640)
    } finally {
      closeSync(file)
    }
  }
}

function ensureFirewallPorts(ports: number[]): void {
  const required = normalizedFirewallPorts(ports)
  const manager = activeFirewallManager()
  if (!manager) return
  const manifest = readFirewallManifest()

  if (manager.type === 'ufw') {
    for (const port of required) {
      let status = ufwStatus(manager.path)
      if (ufwOwnedRuleNumbers(status, port).length) {
        if (!hasFirewallRule(manifest, { manager: 'ufw', port })) {
          manifest.rules.push({ manager: 'ufw', port })
          writeFirewallManifest(manifest)
        }
        continue
      }
      if (ufwAllowsTcpPort(status, port)) continue
      run(
        manager.path,
        ['--force', 'allow', `${port}/tcp`, 'comment', XRAY_FIREWALL_COMMENT],
        true,
        `Failed to open TCP port ${port} with UFW`
      )
      manifest.rules.push({ manager: 'ufw', port })
      writeFirewallManifest(manifest)
      status = ufwStatus(manager.path)
      if (!ufwOwnedRuleNumbers(status, port).length) {
        fail(`UFW did not open TCP port ${port}`)
      }
    }
    return
  }

  for (const port of required) {
    const runtimeOpen = firewalldPortOpen(
      manager.path,
      manager.zone,
      port,
      false
    )
    const permanentOpen = firewalldPortOpen(
      manager.path,
      manager.zone,
      port,
      true
    )
    if (runtimeOpen && permanentOpen) continue
    let rule = manifest.rules.find(
      (item): item is Extract<FirewallRule, { manager: 'firewalld' }> =>
        item.manager === 'firewalld' &&
        item.port === port &&
        item.zone === manager.zone
    )
    if (!rule) {
      rule = {
        manager: 'firewalld',
        port,
        zone: manager.zone,
        runtimeAdded: false,
        permanentAdded: false
      }
      manifest.rules.push(rule)
    }
    if (!permanentOpen) {
      run(
        manager.path,
        ['--permanent', `--zone=${manager.zone}`, `--add-port=${port}/tcp`],
        true,
        `Failed to persist TCP port ${port} with firewalld`
      )
      rule.permanentAdded = true
      writeFirewallManifest(manifest)
    }
    if (!runtimeOpen) {
      run(
        manager.path,
        [`--zone=${manager.zone}`, `--add-port=${port}/tcp`],
        true,
        `Failed to open TCP port ${port} with firewalld`
      )
      rule.runtimeAdded = true
      writeFirewallManifest(manifest)
    }
  }
}

function reconcileFirewallPorts(ports: number[]): void {
  const required = new Set(normalizedFirewallPorts(ports))
  const manifest = readFirewallManifest()
  const obsolete = manifest.rules.filter((rule) => !required.has(rule.port))
  for (const rule of obsolete) removeFirewallRule(rule)
  manifest.rules = manifest.rules.filter((rule) => required.has(rule.port))
  writeFirewallManifest(manifest)
}

function restoreFirewallManifest(previous: FirewallManifest): void {
  const current = readFirewallManifest()
  for (const rule of current.rules) {
    const prior = previous.rules.find(
      (item) => firewallRuleKey(item) === firewallRuleKey(rule)
    )
    if (!prior) {
      removeFirewallRule(rule)
      continue
    }
    if (rule.manager === 'firewalld' && prior.manager === 'firewalld') {
      const addedDuringOperation: FirewallRule = {
        ...rule,
        runtimeAdded: rule.runtimeAdded && !prior.runtimeAdded,
        permanentAdded: rule.permanentAdded && !prior.permanentAdded
      }
      if (
        addedDuringOperation.runtimeAdded ||
        addedDuringOperation.permanentAdded
      ) {
        removeFirewallRule(addedDuringOperation)
      }
    }
  }
  writeFirewallManifest(previous)
}

function removeManagedFirewallRules(): void {
  const manifest = readFirewallManifest()
  for (const rule of manifest.rules) removeFirewallRule(rule)
  safeRemove(firewallManifestPath)
}

function removeFirewallRule(rule: FirewallRule): void {
  if (rule.manager === 'ufw') {
    const executable = ufwExecutable()
    if (!executable) fail('UFW is unavailable while removing managed rules')
    const numbers = ufwOwnedRuleNumbers(ufwStatus(executable), rule.port)
    for (const number of numbers) {
      run(
        executable,
        ['--force', 'delete', String(number)],
        true,
        `Failed to remove managed UFW rule for TCP port ${rule.port}`
      )
    }
    return
  }

  const executable = firewalldExecutable()
  if (!executable) {
    fail('firewalld is unavailable while removing managed rules')
  }
  if (
    rule.runtimeAdded &&
    firewalldPortOpen(executable, rule.zone, rule.port, false)
  ) {
    run(
      executable,
      [`--zone=${rule.zone}`, `--remove-port=${rule.port}/tcp`],
      true,
      `Failed to remove managed firewalld rule for TCP port ${rule.port}`
    )
  }
  if (
    rule.permanentAdded &&
    firewalldPortOpen(executable, rule.zone, rule.port, true)
  ) {
    run(
      executable,
      ['--permanent', `--zone=${rule.zone}`, `--remove-port=${rule.port}/tcp`],
      true,
      `Failed to remove managed permanent firewalld rule for TCP port ${rule.port}`
    )
  }
}

function activeFirewallManager():
  | { type: 'ufw'; path: string }
  | { type: 'firewalld'; path: string; zone: string }
  | null {
  const ufw = ufwExecutable()
  const ufwActive = Boolean(ufw && ufwIsActive(ufwStatus(ufw)))
  const firewalld = firewalldExecutable()
  const firewalldActive = Boolean(
    firewalld &&
    run('/usr/bin/systemctl', ['is-active', '--quiet', 'firewalld'], false)
      .status === 0
  )
  if (ufwActive && firewalldActive) {
    fail('Multiple supported host firewalls are active')
  }
  if (ufwActive) return { type: 'ufw', path: ufw! }
  if (!firewalldActive) return null
  const zone = runCapture(
    firewalld!,
    ['--get-default-zone'],
    true,
    'Failed to determine the active firewalld zone'
  ).stdout.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(zone)) {
    fail('firewalld returned an invalid default zone')
  }
  return { type: 'firewalld', path: firewalld!, zone }
}

function ufwStatus(executable: string): string {
  return runCapture(
    executable,
    ['status', 'numbered'],
    true,
    'Failed to inspect UFW rules'
  ).stdout
}

function firewalldPortOpen(
  executable: string,
  zone: string,
  port: number,
  permanent: boolean
): boolean {
  const args = [
    ...(permanent ? ['--permanent'] : []),
    `--zone=${zone}`,
    `--query-port=${port}/tcp`
  ]
  return runCapture(executable, args, false).status === 0
}

function ufwExecutable(): string | null {
  return ['/usr/sbin/ufw', '/usr/bin/ufw'].find(existsSync) ?? null
}

function firewalldExecutable(): string | null {
  return existsSync('/usr/bin/firewall-cmd') ? '/usr/bin/firewall-cmd' : null
}

function normalizedFirewallPorts(ports: number[]): number[] {
  const unique = [...new Set(ports)].sort((left, right) => left - right)
  if (
    unique.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    fail('Firewall port is invalid')
  }
  return unique
}

function readFirewallManifest(): FirewallManifest {
  if (!existsSync(firewallManifestPath)) {
    return { schemaVersion: 1, rules: [] }
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(firewallManifestPath, 'utf8'))
  } catch {
    fail('Managed firewall manifest is invalid')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    !Array.isArray((value as Record<string, unknown>).rules)
  ) {
    fail('Managed firewall manifest is invalid')
  }
  const rules = (value as { rules: unknown[] }).rules
  if (!rules.every(isFirewallRule)) {
    fail('Managed firewall manifest contains an invalid rule')
  }
  return { schemaVersion: 1, rules }
}

function isFirewallRule(value: unknown): value is FirewallRule {
  if (!value || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  if (
    !Number.isInteger(rule.port) ||
    Number(rule.port) < 1 ||
    Number(rule.port) > 65_535
  ) {
    return false
  }
  if (rule.manager === 'ufw') {
    return Object.keys(rule).every((key) => ['manager', 'port'].includes(key))
  }
  return (
    rule.manager === 'firewalld' &&
    typeof rule.zone === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(rule.zone) &&
    typeof rule.runtimeAdded === 'boolean' &&
    typeof rule.permanentAdded === 'boolean' &&
    Object.keys(rule).every((key) =>
      ['manager', 'port', 'zone', 'runtimeAdded', 'permanentAdded'].includes(
        key
      )
    )
  )
}

function writeFirewallManifest(manifest: FirewallManifest): void {
  if (!manifest.rules.length) {
    safeRemove(firewallManifestPath)
    return
  }
  atomicWrite(
    firewallManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600
  )
}

function hasFirewallRule(
  manifest: FirewallManifest,
  expected: FirewallRule
): boolean {
  return manifest.rules.some(
    (rule) => firewallRuleKey(rule) === firewallRuleKey(expected)
  )
}

function firewallRuleKey(rule: FirewallRule): string {
  return rule.manager === 'ufw'
    ? `${rule.manager}:${rule.port}`
    : `${rule.manager}:${rule.zone}:${rule.port}`
}

function readPlan(
  path: string,
  expectedAction: InstallPlan['action']
): InstallPlan {
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
    'revision',
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
  if (value.schemaVersion !== 1 || value.action !== expectedAction)
    fail('Install plan version is invalid')
  if (!Number.isSafeInteger(value.nodeId) || Number(value.nodeId) <= 0)
    fail('nodeId is invalid')
  if (!['trojan', 'vless', 'vmess'].includes(String(value.protocol)))
    fail('Protocol is invalid')
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    fail('Configuration revision is invalid')
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
  required = true,
  failureMessage = 'Privileged host command failed'
): SpawnSyncReturns<string> {
  const result = spawnSync(executable, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 1024 * 1024
  })
  if (required && (result.error || result.status !== 0)) {
    const detail = result.stderr?.replace(/\s+/g, ' ').trim().slice(-500)
    fail(detail ? `${failureMessage}: ${detail}` : failureMessage)
  }
  return result
}

function runCapture(
  executable: string,
  args: string[],
  required = true,
  failureMessage = 'Privileged host command failed'
): SpawnSyncReturns<string> {
  const result = spawnSync(executable, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (required && (result.error || result.status !== 0)) {
    const detail = result.stderr?.replace(/\s+/g, ' ').trim().slice(-500)
    fail(detail ? `${failureMessage}: ${detail}` : failureMessage)
  }
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

class HelperFailure extends Error {}

function fail(message: string): never {
  throw new HelperFailure(message)
}

void main().catch((error) => {
  const message =
    error instanceof HelperFailure
      ? error.message
      : error instanceof Error && error.message
        ? `Privileged helper failed: ${error.message}`
        : 'Privileged helper failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
