import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const runtimeScript = resolve(__dirname, '../scripts/node-runtime.sh')

// Model Linux ownership without requiring root or changing the developer's machine.
const filesystemModel = `
stat() {
  local entry="\${@: -1}"
  case "$entry" in
    /usr/bin/node | /usr/local/bin/node | "$UNTRUSTED_ROOT"*) echo '1000 755' ;;
    "$WRITABLE_ROOT"*) echo '0 775' ;;
    *) echo '0 755' ;;
  esac
}
realpath() {
  if [[ "$1" == -ms ]]; then
    printf '%s\\n' "$3"
  else
    env -u NODE_OPTIONS -u NODE_PATH "$TEST_NODE" -e \
      'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$3"
  fi
}
`

function bash(body: string, env: NodeJS.ProcessEnv = {}, model = true) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -Eeuo pipefail\nsource "$1"\n${model ? filesystemModel : ''}\n${body}`,
      'node-runtime-test',
      runtimeScript
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_NODE: process.execPath,
        UNTRUSTED_ROOT: '/nonexistent-untrusted-fixture',
        WRITABLE_ROOT: '/nonexistent-writable-fixture',
        ...env
      }
    }
  )
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'eagleway-node-')))
  const node = (name: string, details: string, marker?: string) => {
    const path = join(directory, name, 'node')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      `#!/bin/sh
[ -z "\${NODE_OPTIONS:-}" ] && [ -z "\${NODE_PATH:-}" ] || exit 90
${marker ? `touch '${marker}'` : ''}
printf '%s\\n' '${details}'
`,
      { mode: 0o755 }
    )
    return path
  }
  return {
    directory,
    node,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('Node runtime accepts patched stable 22 releases and rejects old/other/prerelease versions', () => {
  for (const version of ['22.23.4', 'v22.23.4', '22.23.10', '22.24.0']) {
    const result = bash('node_version_supported "$VERSION"', {
      VERSION: version
    })
    assert.equal(result.status, 0, `${version}: ${result.stderr}`)
  }
  for (const version of [
    '22.0.0',
    '22.23.3',
    '22.22.99',
    '20.20.0',
    '24.22.1',
    '26.12.1',
    '22.23.4-rc.1',
    'garbage'
  ]) {
    assert.notEqual(
      bash('node_version_supported "$VERSION"', { VERSION: version }).status,
      0,
      version
    )
  }
})

test('runtime reuses a compatible custom Node and removes injected Node options', () => {
  const f = fixture()
  try {
    const candidate = f.node('custom', '22.23.4 linux x64 127')
    const result = bash(
      `select_node_runtime "$CANDIDATE" "$INSTALL_ROOT" x64
printf '%s %s %s' "$NODE_BIN" "$NODE_VERSION" "$NODE_ABI"`,
      {
        CANDIDATE: candidate,
        INSTALL_ROOT: join(f.directory, 'install'),
        NODE_OPTIONS: '--invalid-injected-option',
        NODE_PATH: '/untrusted-modules'
      }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${candidate} 22.23.4 127`)
    assert.equal(existsSync(join(f.directory, 'install')), false)
  } finally {
    f.cleanup()
  }
})

test('runtime rejects writable and non-root-owned paths before executing them', () => {
  const f = fixture()
  try {
    for (const kind of ['untrusted', 'writable']) {
      const marker = join(f.directory, `executed-${kind}`)
      const candidate = f.node(kind, '22.23.4 linux x64 127', marker)
      const result = bash('probe_node_runtime "$CANDIDATE" x64', {
        CANDIDATE: candidate,
        UNTRUSTED_ROOT: join(f.directory, 'untrusted'),
        WRITABLE_ROOT: join(f.directory, 'writable')
      })
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(marker), false)
    }
  } finally {
    f.cleanup()
  }
})

test('runtime checks both a symlink path and its resolved target', () => {
  const f = fixture()
  try {
    const marker = join(f.directory, 'executed')
    const candidate = f.node('untrusted', '22.23.4 linux x64 127', marker)
    const alias = join(f.directory, 'trusted-alias')
    symlinkSync(candidate, alias)
    const result = bash('probe_node_runtime "$CANDIDATE" x64', {
      CANDIDATE: alias,
      UNTRUSTED_ROOT: join(f.directory, 'untrusted')
    })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(marker), false)
  } finally {
    f.cleanup()
  }
})

test('runtime rejects incorrect platforms, architectures and missing native ABI', () => {
  const f = fixture()
  try {
    for (const [index, details] of [
      '22.23.4 darwin x64 127',
      '22.23.4 linux arm64 127',
      '22.23.4 linux x64'
    ].entries()) {
      const result = bash('probe_node_runtime "$CANDIDATE" x64', {
        CANDIDATE: f.node(String(index), details)
      })
      assert.notEqual(result.status, 0)
    }
  } finally {
    f.cleanup()
  }
})

const simulatedInstall = `
install_managed_node() {
  local destination="$1/runtimes/node-v22.23.4-linux-$2/bin"
  mkdir -p "$destination"
  cp "$SAFE_NODE" "$destination/node"
}
`

test('old, other-major and absent Node candidates fall back without modifying shared Node', () => {
  const f = fixture()
  try {
    const safe = f.node('safe', '22.23.4 linux x64 127')
    for (const version of ['22.23.3', '24.22.1', 'missing']) {
      const candidate =
        version === 'missing'
          ? join(f.directory, 'missing-node')
          : f.node(version, `${version} linux x64 127`)
      const before = existsSync(candidate) ? readFileSync(candidate) : null
      const installRoot = join(f.directory, `install-${version}`)
      const result = bash(
        `${simulatedInstall}
select_node_runtime "$CANDIDATE" "$INSTALL_ROOT" x64
printf '%s' "$NODE_BIN"`,
        { CANDIDATE: candidate, SAFE_NODE: safe, INSTALL_ROOT: installRoot }
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(
        result.stdout,
        join(installRoot, 'runtimes/node-v22.23.4-linux-x64/bin/node')
      )
      if (before) assert.deepEqual(readFileSync(candidate), before)
    }
  } finally {
    f.cleanup()
  }
})

test('Node inaccessible to the service user falls back to the private runtime', () => {
  const f = fixture()
  try {
    const candidate = f.node('inaccessible', '22.23.4 linux x64 127')
    const safe = f.node('safe', '22.23.4 linux x64 127')
    const result = bash(
      `${simulatedInstall}
runuser() {
  [[ "$*" != *"$CANDIDATE"* ]] || return 1
  shift 3
  "$@"
}
select_node_runtime "$CANDIDATE" "$INSTALL_ROOT" x64 eagleway-agent
printf '%s' "$NODE_BIN"`,
      {
        CANDIDATE: candidate,
        SAFE_NODE: safe,
        INSTALL_ROOT: join(f.directory, 'install')
      }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stdout,
      /runtimes\/node-v22\.23\.4-linux-x64\/bin\/node$/
    )
  } finally {
    f.cleanup()
  }
})

test('checksum failure never extracts or promotes Node, even when installation is used in a conditional', () => {
  const f = fixture()
  try {
    const result = bash(
      `install() { mkdir -p "\${@: -1}"; }
curl() {
  while [[ "$1" != --output ]]; do shift; done
  printf 'corrupted download' > "$2"
}
sha256sum() { command shasum -a 256 --check; }
tar() { touch "$EXTRACT_MARKER"; }
if install_managed_node "$INSTALL_ROOT" x64; then exit 99; else exit 17; fi`,
      {
        INSTALL_ROOT: join(f.directory, 'install'),
        EXTRACT_MARKER: join(f.directory, 'extracted')
      }
    )
    assert.equal(result.status, 17, result.stderr)
    assert.equal(existsSync(join(f.directory, 'extracted')), false)
    assert.deepEqual(readdirSync(join(f.directory, 'install/runtimes')), [])
  } finally {
    f.cleanup()
  }
})

test(
  'Linux trust checks accept root system binaries and reject user-owned files',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture()
    try {
      const trusted = bash('trusted_node_path /usr/bin/true', {}, false)
      assert.equal(trusted.status, 0, trusted.stderr)
      assert.equal(trusted.stdout.trim(), realpathSync('/usr/bin/true'))
      const untrusted = bash(
        'trusted_node_path "$CANDIDATE"',
        {
          CANDIDATE: f.node('user', '22.23.4 linux x64 127')
        },
        false
      )
      assert.notEqual(untrusted.status, 0)
    } finally {
      f.cleanup()
    }
  }
)
