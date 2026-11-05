import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const firewallScript = resolve(__dirname, '../scripts/agent-firewall.sh')

interface FirewallModel {
  ufwInstalled: boolean
  ufwActive: boolean
  firewalldInstalled: boolean
  firewalldActive: boolean
  offlineInstalled: boolean
  ufwStatusError: boolean
  discard: string
  ufwRules: { source: string; port: string; comment: string }[]
  permanent: string[]
  runtime: string[]
  calls: { command: string; args: string[] }[]
}

// Real Bash executes against stateful CLI substitutes. No host firewall/root access.
const fakeCli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.FIREWALL_MODEL;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
state.calls.push({ command, args });
function finish(code = 0, output = '') {
  fs.writeFileSync(file, JSON.stringify(state));
  if (output) process.stdout.write(output + '\\n');
  process.exit(code);
}
if (command === 'chown' || command === 'chmod') finish();
if (command === 'systemctl') {
  if (args.join(' ') !== 'is-active --quiet firewalld') finish(90);
  finish(state.firewalldActive ? 0 : 3);
}
if (command === 'ufw') {
  if (args.join(' ') === 'status') {
    if (state.ufwStatusError) finish(1);
    finish(0, 'Status: ' + (state.ufwActive ? 'active' : 'inactive'));
  }
  if (args[0] === 'allow') {
    const source = args[args.indexOf('from') + 1];
    const port = args[args.indexOf('port') + 1];
    const comment = args[args.indexOf('comment') + 1];
    if (args.join(' ') !== ['allow', 'from', source, 'to', 'any', 'port', port, 'proto', 'tcp', 'comment', comment].join(' ')) finish(91);
    if (state.discard !== 'ufw') {
      state.ufwRules = state.ufwRules.filter(r => r.source !== source || r.port !== port);
      state.ufwRules.push({ source, port, comment });
    }
    finish();
  }
  if (args.join(' ') === 'show added') {
    finish(0, state.ufwRules.map(r => {
      const address = r.source.replace(/\\/(32|128)$/, '').replace('2001:0db8:0:0:0:0:0:1', '2001:db8::1');
      return "ufw allow from " + address + " to any port " + r.port + " proto tcp comment '" + r.comment + "'";
    }).join('\\n'));
  }
  finish(92); // Includes enable/disable/reload/reset: these are never permitted.
}
if (command === 'firewall-cmd' || command === 'firewall-offline-cmd') {
  const offline = command === 'firewall-offline-cmd';
  if (offline === state.firewalldActive) finish(93);
  if (args.join(' ') === '--get-default-zone') finish(0, 'public');
  if (!args.includes('--zone=public')) finish(94);
  const store = offline || args.includes('--permanent') ? 'permanent' : 'runtime';
  if (offline && args.includes('--permanent')) finish(95);
  const query = args.find(a => a.startsWith('--query-rich-rule='));
  if (query) finish(state[store].includes(query.slice('--query-rich-rule='.length)) ? 0 : 1);
  const add = args.find(a => a.startsWith('--add-rich-rule='));
  if (add) {
    const rule = add.slice('--add-rich-rule='.length);
    if (state.discard !== store && !state[store].includes(rule)) state[store].push(rule);
    finish();
  }
}
finish(96);
`

function fixture(options: Partial<FirewallModel> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eagleway-firewall-'))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const model: FirewallModel = {
    ufwInstalled: false,
    ufwActive: false,
    firewalldInstalled: false,
    firewalldActive: false,
    offlineInstalled: true,
    ufwStatusError: false,
    discard: '',
    ufwRules: [],
    permanent: [],
    runtime: [],
    calls: [],
    ...options
  }
  const stateFile = join(directory, 'state.json')
  writeFileSync(stateFile, JSON.stringify(model))
  for (const command of ['grep', 'sed', 'awk']) {
    symlinkSync(`/usr/bin/${command}`, join(bin, command))
  }
  const commands = ['systemctl', 'chown', 'chmod']
  if (model.ufwInstalled) commands.push('ufw')
  if (model.firewalldInstalled) {
    commands.push('firewall-cmd')
    if (model.offlineInstalled) commands.push('firewall-offline-cmd')
  }
  for (const command of commands) {
    writeFileSync(join(bin, command), fakeCli, { mode: 0o755 })
  }
  return {
    run: (
      manager = 'auto',
      cidrs = ' 127.0.0.1/32, 203.0.113.9/32,2001:0db8:0:0:0:0:0:1/128 '
    ) =>
      spawnSync(
        '/bin/bash',
        [
          '-c',
          'set -Eeuo pipefail; source "$1"; configure_agent_firewall "$2" 8086 "$3" "$4"',
          'firewall-test',
          firewallScript,
          manager,
          cidrs,
          join(directory, 'zone')
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: bin, FIREWALL_MODEL: stateFile }
        }
      ),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as FirewallModel,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

for (const active of [false, true]) {
  test(`UFW ${active ? 'active' : 'inactive'} saves restricted IPv4/IPv6 rules idempotently without changing service state`, (t) => {
    const f = fixture({ ufwInstalled: true, ufwActive: active })
    t.after(f.cleanup)
    for (let i = 0; i < 2; i++) {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
    }
    const state = f.state()
    assert.equal(state.ufwActive, active)
    assert.equal(state.ufwRules.length, 3)
    assert.deepEqual(
      state.ufwRules.map((r) => r.source),
      ['127.0.0.1/32', '203.0.113.9/32', '2001:0db8:0:0:0:0:0:1/128']
    )
    assert.ok(state.ufwRules.every((r) => r.port === '8086'))
    assert.ok(
      state.calls.every(
        (c) =>
          c.command === 'ufw' &&
          ['status', 'allow', 'show'].includes(c.args[0]!)
      )
    )
  })
}

test('UFW save verification rejects successful commands that did not persist the requested rule', (t) => {
  const f = fixture({
    ufwInstalled: true,
    discard: 'ufw',
    ufwRules: [
      {
        source: '127.0.0.1/32',
        port: '8087',
        comment: 'eagleway-node-agent:control:8087:127.0.0.1/32'
      }
    ]
  })
  t.after(f.cleanup)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Failed to persist UFW rule/)
})

for (const active of [false, true]) {
  test(`firewalld ${active ? 'active' : 'inactive'} persists rules and only updates runtime while active`, (t) => {
    const f = fixture({ firewalldInstalled: true, firewalldActive: active })
    t.after(f.cleanup)
    for (let i = 0; i < 2; i++) {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
    }
    const state = f.state()
    assert.equal(state.permanent.length, 3)
    assert.equal(state.runtime.length, active ? 3 : 0)
    assert.ok(state.permanent[2]?.includes('family="ipv6"'))
    assert.ok(
      state.calls
        .filter((c) => c.command === 'systemctl')
        .every((c) => c.args.join(' ') === 'is-active --quiet firewalld')
    )
  })
}

for (const active of [false, true]) {
  test(`firewalld ${active ? 'online' : 'offline'} save failures abort deployment`, (t) => {
    const f = fixture({
      firewalldInstalled: true,
      firewalldActive: active,
      discard: 'permanent'
    })
    t.after(f.cleanup)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Failed to persist firewalld rule/)
    assert.equal(f.state().runtime.length, 0)
  })
}

test('active firewall wins over an installed inactive alternative', (t) => {
  for (const manager of ['ufw', 'firewalld']) {
    const f = fixture({
      ufwInstalled: true,
      firewalldInstalled: true,
      ufwActive: manager === 'ufw',
      firewalldActive: manager === 'firewalld'
    })
    t.after(f.cleanup)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const state = f.state()
    assert.equal(state.ufwRules.length, manager === 'ufw' ? 3 : 0)
    assert.equal(state.permanent.length, manager === 'firewalld' ? 3 : 0)
  }
})

test('two inactive managers require an explicit selection and configure only that manager', (t) => {
  const ambiguous = fixture({ ufwInstalled: true, firewalldInstalled: true })
  t.after(ambiguous.cleanup)
  assert.match(ambiguous.run().stderr, /set AGENT_FIREWALL_MANAGER/)
  assert.equal(ambiguous.state().ufwRules.length, 0)
  assert.equal(ambiguous.state().permanent.length, 0)
  for (const manager of ['ufw', 'firewalld']) {
    const f = fixture({ ufwInstalled: true, firewalldInstalled: true })
    t.after(f.cleanup)
    const result = f.run(manager)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.state().ufwRules.length, manager === 'ufw' ? 3 : 0)
    assert.equal(f.state().permanent.length, manager === 'firewalld' ? 3 : 0)
  }
})

test('conflicting, unavailable, and invalid managers fail before any rules are written', (t) => {
  const cases: [Partial<FirewallModel>, string][] = [
    [
      {
        ufwInstalled: true,
        firewalldInstalled: true,
        ufwActive: true,
        firewalldActive: true
      },
      'auto'
    ],
    [
      { ufwInstalled: true, firewalldInstalled: true, firewalldActive: true },
      'ufw'
    ],
    [
      { ufwInstalled: true, firewalldInstalled: true, ufwActive: true },
      'firewalld'
    ],
    [{}, 'ufw'],
    [{}, 'firewalld'],
    [{}, 'invalid'],
    [{ ufwInstalled: true, ufwStatusError: true }, 'auto'],
    [{ firewalldInstalled: true, offlineInstalled: false }, 'auto']
  ]
  for (const [options, manager] of cases) {
    const f = fixture(options)
    t.after(f.cleanup)
    assert.notEqual(
      f.run(manager).status,
      0,
      JSON.stringify([options, manager])
    )
    assert.equal(f.state().ufwRules.length, 0)
    assert.equal(f.state().permanent.length, 0)
  }
})

test('hosts without a supported firewall keep their existing network setup', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No supported host firewall/)
  assert.deepEqual(f.state().calls, [])
})
