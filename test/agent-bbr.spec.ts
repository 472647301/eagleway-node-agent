import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const bbrScript = resolve(__dirname, '../scripts/agent-bbr.sh')

// Execute the real Bash implementation, but replace every host-facing command.
// The model persists sysctl state across deployments; no root/Linux host needed.
const hostModel = `
sysctl() {
  printf 'sysctl %s\\n' "$*" >> "$BBR_TEST_ROOT/calls"
  if [[ "$1" == -n ]]; then
    case "$2" in
      net.ipv4.tcp_congestion_control) cat "$BBR_TEST_ROOT/cc" ;;
      net.core.default_qdisc) cat "$BBR_TEST_ROOT/qdisc" ;;
      net.ipv4.tcp_available_congestion_control) cat "$BBR_TEST_ROOT/available" ;;
      *) return 90 ;;
    esac
  elif [[ "$1" == -q && "$2" == -w ]]; then
    local assignment="$3" file
    [[ "$assignment" != "\${BBR_FAIL_WRITE:-}" ]] || return 1
    [[ "$assignment" != "\${BBR_DISCARD_WRITE:-}" ]] || return 0
    case "\${assignment%%=*}" in
      net.ipv4.tcp_congestion_control) file=cc ;;
      net.core.default_qdisc) file=qdisc ;;
      *) return 91 ;;
    esac
    printf '%s' "\${assignment#*=}" > "$BBR_TEST_ROOT/$file"
  else
    return 92
  fi
}
modprobe() {
  printf 'modprobe %s\\n' "$*" >> "$BBR_TEST_ROOT/calls"
  if [[ "$1" == tcp_bbr && "\${BBR_LOADABLE:-false}" == true ]]; then
    printf '%s' 'reno cubic bbr' > "$BBR_TEST_ROOT/available"
    return 0
  fi
  return 1
}
chown() { :; }
mv() {
  [[ "\${BBR_FAIL_RENAME:-false}" != true ]] || return 1
  command mv "$@"
}
systemctl() { echo 'Unexpected service mutation' >&2; return 93; }
tc() { echo 'Unexpected interface mutation' >&2; return 94; }
reboot() { echo 'Unexpected reboot' >&2; return 95; }
`

function fixture(
  cc = 'cubic',
  qdisc = 'fq_codel',
  available = 'reno cubic bbr'
) {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-bbr-'))
  const config = join(directory, '99-eagleway-bbr.conf')
  for (const [name, value] of Object.entries({
    cc,
    qdisc,
    available,
    calls: ''
  })) {
    writeFileSync(join(directory, name), value)
  }
  return {
    config,
    run: (enabled: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -Eeuo pipefail\nsource "$1"\n${hostModel}\nconfigure_agent_bbr "$2" "$BBR_TEST_ROOT/99-eagleway-bbr.conf"`,
          'bbr-test',
          bbrScript.replaceAll('\\', '/'),
          enabled
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            BBR_TEST_ROOT: directory.replaceAll('\\', '/'),
            ...env
          }
        }
      ),
    read: (name: string) => readFileSync(join(directory, name), 'utf8'),
    write: (name: string, value: string) =>
      writeFileSync(join(directory, name), value),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('disabled BBR leaves existing host tuning untouched without probing the kernel', (t) => {
  const f = fixture('bbr', 'fq')
  t.after(f.cleanup)
  const result = f.run('false')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read('calls'), '')
  assert.equal(f.read('cc'), 'bbr')
  assert.equal(existsSync(f.config), false)
})

test('built-in BBR enables idempotently and disable restores the first defaults', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  for (let i = 0; i < 2; i++) {
    const result = f.run('true')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Existing TCP sockets\/listeners retain/)
    assert.equal(f.read('cc'), 'bbr')
    assert.equal(f.read('qdisc'), 'fq')
    assert.match(
      f.read('99-eagleway-bbr.conf'),
      /previous_tcp_congestion_control=cubic/
    )
  }
  assert.doesNotMatch(f.read('calls'), /modprobe tcp_bbr/)
  const disabled = f.run('false')
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.equal(f.read('cc'), 'cubic')
  assert.equal(f.read('qdisc'), 'fq_codel')
  assert.equal(existsSync(f.config), false)
  assert.equal(f.run('false').status, 0)
})

test('BBR loads an available tcp_bbr module', (t) => {
  const f = fixture('cubic', 'fq_codel', 'reno cubic')
  t.after(f.cleanup)
  const result = f.run('true', { BBR_LOADABLE: 'true' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(f.read('calls'), /modprobe tcp_bbr/)
  assert.equal(f.read('cc'), 'bbr')
})

test('unsupported BBR fails without writing sysctls or persistence', (t) => {
  const f = fixture('cubic', 'fq_codel', 'reno cubic')
  t.after(f.cleanup)
  const result = f.run('true')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BBR is unavailable in the running kernel/)
  assert.doesNotMatch(f.read('calls'), /sysctl -q -w/)
  assert.equal(existsSync(f.config), false)
})

for (const env of [
  { BBR_FAIL_WRITE: 'net.core.default_qdisc=fq' },
  { BBR_FAIL_WRITE: 'net.ipv4.tcp_congestion_control=bbr' },
  { BBR_DISCARD_WRITE: 'net.ipv4.tcp_congestion_control=bbr' },
  { BBR_FAIL_RENAME: 'true' }
]) {
  test(`BBR enable rolls back after ${JSON.stringify(env)}`, (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const result = f.run('true', env)
    assert.notEqual(result.status, 0)
    assert.equal(f.read('cc'), 'cubic')
    assert.equal(f.read('qdisc'), 'fq_codel')
    assert.equal(existsSync(f.config), false)
  })
}

test('failed BBR removal retains the recovery record and rolls back partial writes', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  assert.equal(f.run('true').status, 0)
  const before = f.read('99-eagleway-bbr.conf')
  const result = f.run('false', {
    BBR_FAIL_WRITE: 'net.ipv4.tcp_congestion_control=cubic'
  })
  assert.notEqual(result.status, 0)
  assert.equal(f.read('cc'), 'bbr')
  assert.equal(f.read('qdisc'), 'fq')
  assert.equal(f.read('99-eagleway-bbr.conf'), before)
})

test('disable preserves administrator changes and pre-existing BBR', (t) => {
  const f = fixture('bbr', 'fq')
  t.after(f.cleanup)
  assert.equal(f.run('true').status, 0)
  assert.equal(f.run('false').status, 0)
  assert.equal(f.read('cc'), 'bbr')
  assert.equal(f.read('qdisc'), 'fq')
  assert.equal(f.run('true').status, 0)
  f.write('cc', 'reno')
  f.write('qdisc', 'cake')
  assert.equal(f.run('false').status, 0)
  assert.equal(f.read('cc'), 'reno')
  assert.equal(f.read('qdisc'), 'cake')
})

test('BBR rejects invalid switches and refuses unmanaged or edited drop-ins', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  assert.notEqual(f.run('yes').status, 0)
  for (const content of [
    'net.ipv4.tcp_congestion_control=cubic\n',
    '# Managed by eagleway-node-agent: BBR v1\n# previous_tcp_congestion_control=$(touch unwanted)\n'
  ]) {
    writeFileSync(f.config, content)
    for (const enabled of ['true', 'false']) {
      const result = f.run(enabled)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Refusing modified or unmanaged/)
      assert.equal(f.read('99-eagleway-bbr.conf'), content)
    }
  }
  assert.equal(f.read('calls'), '')
})
