#!/usr/bin/env python3
"""Exercise the real pinned browser/MCP on key-free local fixtures."""

import base64
import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import selectors
import struct
import subprocess
import sys
import threading
import time
import traceback
import uuid

BASE = Path(__file__).resolve().parent
toolchain = json.loads((BASE / 'toolchain.json').read_text())
discovery = json.loads((BASE / 'mcp-inspection.json').read_text())
workspace = Path(toolchain['workspace'])
native = toolchain['native']['path']
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
OUT = BASE / 'attempts' / f'{stamp}-{uuid.uuid4().hex[:8]}'
OUT.mkdir(parents=True)
socket_directory = Path('/tmp') / f"rw-{OUT.name[-8:]}"
socket_directory.mkdir(mode=0o700)
ARTICLE = 'The Kestrel fixture release preserves exactly 42 source observations.'
SECOND = 'The second chapter requires fresh navigation observations.'
DOCUMENT = '# Fixture guide\n\nA known document remains usable while another source is throttled.\n'
encoded_article = base64.b64encode(ARTICLE.encode()).decode()
HTML = f'''<!doctype html><html><head><title>Local research fixture</title></head>
<body><main><h1>Delayed article</h1><article id="article">Loading article</article>
<a href="/second">Second chapter</a></main><script>
setTimeout(() => {{document.querySelector('#article').textContent=atob('{encoded_article}');}}, 150);
</script></body></html>'''.encode()
SECOND_HTML = f'<!doctype html><title>Second chapter</title><main><h1>Second chapter</h1><p>{SECOND}</p></main>'.encode()
requests = []
request_lock = threading.Lock()


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def save(name, value):
    with (OUT / name).open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = self.path.split('?')[0]
        if route == '/doc':
            status, content_type, body = 200, 'text/markdown; charset=utf-8', DOCUMENT.encode()
        elif route == '/dynamic':
            status, content_type, body = 200, 'text/html; charset=utf-8', HTML
        elif route == '/second':
            status, content_type, body = 200, 'text/html; charset=utf-8', SECOND_HTML
        elif route == '/blocked':
            status, content_type, body = 429, 'text/plain; charset=utf-8', b'Fixture rate limit'
        else:
            status, content_type, body = 404, 'text/plain; charset=utf-8', b'Fixture not found'
        with request_lock:
            requests.append({'path': self.path, 'status': status,
                             'accept': self.headers.get('Accept'),
                             'bodySha256': hashlib.sha256(body).hexdigest(),
                             'retryAfter': '15' if status == 429 else None,
                             'observedAt': time.monotonic()})
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if status == 429:
            self.send_header('Retry-After', '15')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def owned_processes():
    result = []
    for path in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            args = path.read_bytes().replace(b'\0', b' ').decode(errors='replace')
            if str(workspace) not in args:
                continue
            pid = int(path.parent.name)
            state = (path.parent / 'stat').read_text().rsplit(') ', 1)[1].split()[0]
            if state != 'Z':
                result.append({'pid': pid, 'argv': args})
        except (OSError, ValueError, IndexError):
            pass
    return sorted(result, key=lambda item: item['pid'])


environment = {
    'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(workspace / 'home'),
    'XDG_CONFIG_HOME': str(workspace / 'config'),
    'XDG_CACHE_HOME': str(workspace / 'cache'),
    'XDG_DATA_HOME': str(workspace / 'data'),
    'XDG_RUNTIME_DIR': str(workspace / 'runtime'),
    'TMPDIR': str(workspace / 'browser-tmp'), 'LANG': 'C.UTF-8', 'TERM': 'dumb',
    'AGENT_BROWSER_NO_VERSION_CHECK': '1', 'AGENT_BROWSER_NO_WEBMCP': '1',
    'AGENT_BROWSER_CONFIG': str(BASE / 'mcp-config.json'),
    'AGENT_BROWSER_SOCKET_DIR': str(socket_directory),
}
session_a = f"{discovery['session']}-a-{OUT.name[-8:]}"
session_b = f"{discovery['session']}-b-{OUT.name[-8:]}"
environment['AGENT_BROWSER_SESSION'] = session_a
argv = [native, '--session', session_a, '--config', environment['AGENT_BROWSER_CONFIG'],
        'mcp', '--tools', 'core']
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
transcript = []
checks = {}
cleanup = []
process = None
server = None
selector = None
buffer = b''
request_id = 0
error = None
stderr_path = OUT / 'mcp.stderr.log'
print(json.dumps({'attempt': str(OUT), 'phase': 'starting'}), flush=True)

try:
    # A denied loopback bind leaves a new attempt record for an authorized retry.
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    save('fixture.json', {'origin': origin, 'article': ARTICLE, 'second': SECOND,
                          'document': DOCUMENT, 'dynamicHtmlSha256': hashlib.sha256(HTML).hexdigest(),
                          'secondHtmlSha256': hashlib.sha256(SECOND_HTML).hexdigest()})
    stderr = stderr_path.open('xb')
    process = subprocess.Popen(argv, cwd=workspace / 'mcp', env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=stderr, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def rpc(method, params=None, notification=False):
        global buffer, request_id
        message = {'jsonrpc': '2.0', 'method': method}
        if not notification:
            request_id += 1
            message['id'] = request_id
        if params is not None:
            message['params'] = params
        transcript.append({'direction': 'request', 'message': message})
        process.stdin.write((json.dumps(message) + '\n').encode())
        process.stdin.flush()
        if notification:
            return None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if b'\n' not in buffer:
                if not selector.select(max(0, deadline - time.monotonic())):
                    raise TimeoutError(method)
                block = os.read(process.stdout.fileno(), 65536)
                if not block:
                    raise RuntimeError(('MCP stdout closed', process.poll()))
                buffer += block
                assert len(buffer) <= 4 * 1024 * 1024
                continue
            line, buffer = buffer.split(b'\n', 1)
            if not line.strip():
                continue
            response = json.loads(line)
            transcript.append({'direction': 'response', 'message': response})
            if response.get('id') == message['id']:
                assert 'error' not in response, response
                return response['result']
        raise TimeoutError(method)

    def call(name, fields=None, session=session_a, healthy=True):
        arguments = {'session': session, 'namespace': discovery['session'],
                     'timeoutMs': 20000, **(fields or {})}
        result = rpc('tools/call', {'name': name, 'arguments': arguments})
        if healthy:
            assert not result.get('isError'), (name, result)
            assert result['structuredContent']['response']['success'] is True, (name, result)
        return result

    def data(result):
        return result['structuredContent']['response']['data']

    initialization = rpc('initialize', {
        'protocolVersion': '2025-11-25', 'capabilities': {},
        'clientInfo': {'name': 'openbuff-rweb-local-probe', 'version': '0'},
    })
    assert initialization['serverInfo']['version'] == toolchain['version']
    rpc('notifications/initialized', notification=True)

    blocked = call('agent_browser_read', {'url': origin + '/blocked', 'readTimeoutMs': 2000},
                   healthy=False)
    save('blocked-result.json', blocked)
    assert blocked.get('isError') is True
    assert '429' in json.dumps(blocked), blocked
    known = call('agent_browser_read', {'url': origin + '/doc', 'readTimeoutMs': 2000})
    save('known-document-result.json', known)
    assert DOCUMENT.strip() in json.dumps(data(known)).replace('\\n', '\n')
    checks['blockedThenKnownDocument'] = True

    baseline = call('agent_browser_read', {'url': origin + '/dynamic', 'readTimeoutMs': 2000})
    save('static-baseline-result.json', baseline)
    assert ARTICLE not in json.dumps(data(baseline))
    checks['staticBaselineDoesNotObserveRenderedArticle'] = True
    print(json.dumps({'phase': 'static-and-blocked-probes-pass'}), flush=True)

    opened = call('agent_browser_open', {'url': origin + '/dynamic', 'webmcp': False})
    save('open-a-result.json', opened)
    call('agent_browser_wait_for_text', {'text': ARTICLE, 'waitTimeoutMs': 5000})
    rendered = call('agent_browser_read')
    save('rendered-result.json', rendered)
    assert ARTICLE in json.dumps(data(rendered))
    checks['renderedArticleObserved'] = True
    full_snapshot = call('agent_browser_snapshot', {'interactive': False, 'includeUrls': True})
    save('full-snapshot-result.json', full_snapshot)
    interactive = call('agent_browser_snapshot', {'interactive': True, 'includeUrls': True})
    save('interactive-snapshot-result.json', interactive)
    refs = data(interactive)['refs']
    link = next(key for key, value in refs.items() if value.get('name') == 'Second chapter')
    selector_ref = link if link.startswith('@') else '@' + link
    screenshot_path = OUT / 'article.png'
    screenshot = call('agent_browser_screenshot', {'path': str(screenshot_path), 'format': 'png'})
    save('screenshot-result.json', screenshot)
    png = screenshot_path.read_bytes()
    assert png[:8] == b'\x89PNG\r\n\x1a\n'
    width, height = struct.unpack('>II', png[16:24])
    assert width > 0 and height > 0
    checks['screenshotBytesDelivered'] = {'sha256': sha(screenshot_path),
                                         'bytes': len(png), 'width': width, 'height': height}
    call('agent_browser_click', {'selector': selector_ref})
    call('agent_browser_wait_for_text', {'text': SECOND, 'waitTimeoutMs': 5000})
    fresh_snapshot = call('agent_browser_snapshot', {'interactive': False})
    save('fresh-navigation-snapshot-result.json', fresh_snapshot)
    second_read = call('agent_browser_read')
    save('second-chapter-result.json', second_read)
    assert SECOND in json.dumps(data(second_read))
    checks['FreshReferenceNavigationAndRead'] = True
    print(json.dumps({'phase': 'rendered-navigation-and-screenshot-pass'}), flush=True)

    call('agent_browser_open', {'url': origin + '/doc', 'webmcp': False}, session=session_b)
    both_live = owned_processes()
    save('both-sessions-processes.json', both_live)
    call('agent_browser_close', session=session_a)
    survivor = call('agent_browser_get_url', session=session_b)
    save('surviving-session-result.json', survivor)
    assert origin + '/doc' in json.dumps(data(survivor))
    checks['ClosingOneSessionPreservesOther'] = True
    call('agent_browser_close', session=session_b)

    denied_session = session_a
    denial_argv = [native, '--session', denied_session, '--config', environment['AGENT_BROWSER_CONFIG'],
                   '--profile', str(workspace / 'disallowed-profile'), '--json', 'open', origin + '/doc']
    denial = subprocess.run(denial_argv, cwd=workspace / 'mcp', env=environment,
                            capture_output=True, timeout=30)
    save('profile-egress-incompatibility.json', {
        'argv': denial_argv, 'exitCode': denial.returncode,
        'stdout': denial.stdout.decode(), 'stderr': denial.stderr.decode(),
    })
    assert denial.returncode != 0
    assert 'profile' in (denial.stdout + denial.stderr).decode().lower(), denial.stdout
    assert 'allowed-domains' in (denial.stdout + denial.stderr).decode().lower(), denial.stdout
    checks['ExplicitProfileWithAllowlistRefuses'] = True
except Exception as exc:
    error = {'type': type(exc).__name__, 'message': str(exc), 'traceback': traceback.format_exc()}
finally:
    if process is not None and process.poll() is None:
        for session in [session_a, session_b]:
            try:
                result = call('agent_browser_close', session=session, healthy=False)
                cleanup.append({'session': session, 'result': result})
            except Exception as exc:
                cleanup.append({'session': session, 'error': str(exc)})
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        selector.close()
        stderr.close()
    if server is not None:
        server.shutdown()
        server.server_close()
    # Observe only this probe's unique extracted-toolchain/profile paths.
    deadline = time.monotonic() + 5
    remaining = owned_processes()
    while remaining and time.monotonic() < deadline:
        time.sleep(0.05)
        remaining = owned_processes()
    save('transcript.json', transcript)
    save('requests.json', requests)
    save('cleanup.json', {'commands': cleanup, 'remainingProcesses': remaining,
                          'mcpExitCode': process.returncode if process else None})
    result = {
        'schemaVersion': 1, 'type': 'researcher-browser-local-feasibility-probe',
        'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
        'argv': argv, 'cwd': str(workspace / 'mcp'),
        'environment': {'replacement': True, 'keys': sorted(environment), 'providerCalls': 0},
        'toolchain': {'version': toolchain['version'], 'nativeSha256': toolchain['native']['sha256'],
                      'browser': discovery['browser']['version'],
                      'browserSha256': discovery['browser']['sha256']},
        'sessions': [session_a, session_b], 'checks': checks, 'error': error,
        'socketDirectory': str(socket_directory),
        'probeScriptSha256': sha(Path(__file__)),
        'remainingOwnedProcesses': remaining,
        'passed': error is None and not remaining,
        'artifacts': [{'path': str(path), 'sha256': sha(path)}
                      for path in sorted(OUT.iterdir()) if path.is_file()],
        'scope': 'Actual upstream MCP/native/Chrome local fixture feasibility only. Openbuff researcher strategy, SDK/installed CLI delivery, host authority and deadline cleanup remain future RWEB/B19/B20/B28/B33 work.',
        'researcherImplementationAccepted': False,
    }
    save('result.json', result)
    print(json.dumps({'attempt': str(OUT), 'passed': result['passed'],
                      'checks': list(checks), 'error': error['message'] if error else None,
                      'remainingOwnedProcesses': len(remaining)}), flush=True)
    if not result['passed']:
        sys.exit(1)
