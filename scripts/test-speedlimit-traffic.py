"""Linux CI smoke test. Run inside a fresh netns, with the pinned Xray binary."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from uuid import uuid4


def run(*args, **options):
    return subprocess.run(args, check=True, timeout=25, **options)


def wait_for(probe, label):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except (OSError, ValueError, subprocess.CalledProcessError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for {label}")


class Origin(BaseHTTPRequestHandler):
    def do_GET(self):
        # Let the asynchronous webhook mark the authenticated transport before
        # timing bulk transfer. There is no rate guarantee for the handshake.
        time.sleep(0.2)
        data = b'x' * (1024 * 1024) if self.path == '/download' else b'ok'
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        size = int(self.headers['Content-Length'])
        if len(self.rfile.read(size)) != size:
            self.send_error(400)
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def verify(xray, limiter, folder, stack, protocol):
    if os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise RuntimeError('refusing to run outside a temporary network namespace')

    def start(*args):
        child = subprocess.Popen(args)
        stack.callback(stop, child)
        return child

    peer = start('unshare', '--net', 'sleep', '180')
    peer_ns = f'/proc/{peer.pid}/ns/net'
    wait_for(lambda: os.readlink(peer_ns) != os.readlink('/proc/self/ns/net'), 'client namespace')
    client = ['nsenter', f'--net={peer_ns}']
    run('ip', 'link', 'add', 'ew-server', 'type', 'veth', 'peer', 'name', 'ew-client')
    stack.callback(run, 'ip', 'link', 'del', 'ew-server')
    run('ip', 'link', 'set', 'ew-client', 'netns', str(peer.pid))
    for prefix, device, address in [([], 'ew-server', '192.0.2.1/30'), (client, 'ew-client', '192.0.2.2/30')]:
        run(*prefix, 'ip', 'link', 'set', 'lo', 'up')
        run(*prefix, 'ip', 'addr', 'add', address, 'dev', device)
        run(*prefix, 'ip', 'link', 'set', device, 'up')

    origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    stack.callback(origin.server_close)
    stack.callback(origin.shutdown)
    origin_port = origin.server_port
    sock = folder / 'control.sock'
    service_args = [limiter, '-interface', 'ew-server', '-socket', sock, '-state', folder / 'state']
    daemon = start(*service_args)

    def control(path, *args):
        return run('curl', '--silent', '--fail', '--max-time', '3', '--unix-socket', sock,
                   *args, 'http://localhost/' + path, capture_output=True).stdout

    def ready():
        return json.loads(control('status'))['state'] == 'ready'

    wait_for(ready, 'limiter')
    credentials = [str(uuid4()), str(uuid4())]
    emails = [f'{protocol}.{uuid4()}@eagleway.internal' for _ in credentials]

    def sync(revision, rate):
        snapshot = {'revision': revision, 'users': [{'email': emails[0], 'mbps': rate}, {'email': emails[1], 'mbps': 0}]}
        control('policies', '-X', 'PUT', '-d', json.dumps(snapshot))
        assert json.loads(control('status'))['appliedRevision'] == revision

    sync(1, 4)
    certificate, key = folder / 'cert.pem', folder / 'key.pem'
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=node.example.test',
        '-keyout', key, '-out', certificate, capture_output=True)
    fingerprint = run('openssl', 'x509', '-in', certificate, '-noout', '-sha256', '-fingerprint', capture_output=True).stdout.decode().strip().split('=')[1]
    inbound_tag = 'eagleway-' + protocol
    credential_field = 'password' if protocol == 'trojan' else 'id'
    accounts = [{credential_field: uid, 'email': email} for uid, email in zip(credentials, emails)]
    server_settings = {'clients': accounts}
    if protocol == 'vless':
        server_settings['decryption'] = 'none'
    server = {
        'inbounds': [{'tag': inbound_tag, 'listen': '192.0.2.1', 'port': 1443, 'protocol': protocol,
                      'settings': server_settings,
                      'streamSettings': {'network': 'tcp', 'security': 'tls', 'tlsSettings': {'certificates': [{'certificateFile': str(certificate), 'keyFile': str(key)}]}}}],
        'outbounds': [{'protocol': 'freedom', 'tag': 'direct', 'settings': {'finalRules': [{'action': 'allow', 'ip': ['127.0.0.1/32'], 'port': origin_port}]}}],
        'routing': {'rules': [{'inboundTag': [inbound_tag], 'outboundTag': 'direct', 'webhook': {'url': f'{sock}:/webhook/xray', 'deduplication': 0}}]},
    }
    def start_core(name, config, prefix):
        config_file = folder / f'{name}.json'
        config_file.write_text(json.dumps(config))
        run(*prefix, xray, 'run', '-test', '-config', config_file)
        return start(*prefix, xray, 'run', '-config', config_file)

    core = start_core('server', server, [])
    for index, credential in enumerate(credentials):
        endpoint = {'address': '192.0.2.1', 'port': 1443}
        if protocol == 'trojan':
            client_settings = {'servers': [{**endpoint, 'password': credential}]}
        else:
            security = {'encryption': 'none'} if protocol == 'vless' else {'security': 'auto'}
            client_settings = {'vnext': [{**endpoint, 'users': [{'id': credential, **security}]}]}
        config = {
            'inbounds': [{'protocol': 'dokodemo-door', 'listen': '127.0.0.1', 'port': 11000 + index,
                          'settings': {'address': '127.0.0.1', 'port': origin_port, 'network': 'tcp'}}],
            'outbounds': [{'protocol': protocol, 'settings': client_settings, 'streamSettings': {'network': 'tcp', 'security': 'tls',
                           'tlsSettings': {'serverName': 'node.example.test', 'pinnedPeerCertSha256': fingerprint}}}],
        }
        start_core(f'client-{index}', config, client)

    def transfer(port, path, upload=None):
        opts = ['--data-binary', '@' + str(upload)] if upload else []
        run(*client, 'curl', '--silent', '--fail', '--noproxy', '*', '--max-time', '15', '-o', '/dev/null',
            *opts, f'http://127.0.0.1:{port}/{path}')
        return True

    for port in (11000, 11001):
        wait_for(lambda: transfer(port, 'ping'), 'TLS proxy')

    def duration(port, upload=None):
        before = time.monotonic()
        with ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(transfer, port, 'download', upload) for _ in range(2)]
            for request in requests:
                request.result()
        return time.monotonic() - before

    limited = duration(11000)
    unlimited = duration(11001)
    upload_file = folder / 'upload'
    upload_file.write_bytes(b'u' * (1024 * 1024))
    upload = duration(11000, upload_file)
    print(f'{protocol} 2 × 1 MiB: limited download {limited:.2f}s, separate assignment {unlimited:.2f}s, upload {upload:.2f}s', flush=True)
    assert 3.1 < limited < 9, 'parallel connections must share the 4 Mbps class'
    assert max(unlimited, upload) < limited * 0.65, 'second assignment and upload must stay independent'
    assert json.loads(control('status'))['failedWebhooks'] == 0
    stop(daemon)
    assert transfer(11000, 'ping') and core.poll() is None
    daemon = start(*service_args)
    wait_for(ready, 'restored limiter')
    assert json.loads(control('status'))['appliedRevision'] == 1
    sync(2, 0)
    assert duration(11000) < limited * 0.65, 'clearing a policy must release the limit'
    stop(daemon)
    run(*service_args, '-cleanup')
    assert transfer(11000, 'ping') and core.poll() is None


if __name__ == '__main__':
    for transport in ('vless', 'vmess', 'trojan'):
        with tempfile.TemporaryDirectory(prefix='ew-limit-') as tmp, ExitStack() as resources:
            verify(sys.argv[1], sys.argv[2], Path(tmp), resources, transport)
