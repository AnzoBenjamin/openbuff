#!/usr/bin/env python3
"""Inspect the pinned upstream MCP catalog without launching a browser."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import time

OUT = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
toolchain = json.loads((OUT / 'toolchain.json').read_text())
workspace = Path(toolchain['workspace'])
native = toolchain['native']['path']
chrome = Path('/opt/google/chrome/chrome')
assert chrome.is_file()
for name in ['browser-tmp', 'mcp']:
    (workspace / name).mkdir(mode=0o700)
environment = {
    'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(workspace / 'home'),
    'XDG_CONFIG_HOME': str(workspace / 'config'),
    'XDG_CACHE_HOME': str(workspace / 'cache'),
    'XDG_DATA_HOME': str(workspace / 'data'),
    'XDG_RUNTIME_DIR': str(workspace / 'runtime'),
    'TMPDIR': str(workspace / 'browser-tmp'), 'LANG': 'C.UTF-8', 'TERM': 'dumb',
    'AGENT_BROWSER_NO_VERSION_CHECK': '1', 'AGENT_BROWSER_NO_WEBMCP': '1',
}
session_command = [native, 'session', 'id', '--scope', 'worktree', '--prefix', 'openbuff-rweb']
session_result = subprocess.run(session_command, cwd=ROOT, env=environment,
                                capture_output=True, timeout=10)
assert session_result.returncode == 0
session = session_result.stdout.decode().strip()
assert re.fullmatch(r'[A-Za-z0-9_-]+', session)
environment['AGENT_BROWSER_SESSION'] = session
config = OUT / 'mcp-config.json'
with config.open('x') as handle:
    json.dump({'executablePath': str(chrome), 'allowedDomains': ['127.0.0.1'],
               'maxOutput': 8192, 'namespace': session}, handle, indent=2)
    handle.write('\n')
environment['AGENT_BROWSER_CONFIG'] = str(config)
argv = [native, '--session', session, '--config', str(config), 'mcp', '--tools', 'core']
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
stderr_path = OUT / 'mcp-inspection.stderr.log'
transcript = []
responses = []
buffer = b''
request_id = 0


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


with stderr_path.open('xb') as stderr:
    process = subprocess.Popen(argv, cwd=workspace / 'mcp', env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=stderr, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def send(method, params=None, notification=False):
        global request_id, buffer
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
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if b'\n' not in buffer:
                if not selector.select(max(0, deadline - time.monotonic())):
                    raise TimeoutError(method)
                block = os.read(process.stdout.fileno(), 65536)
                if not block:
                    raise RuntimeError(('MCP stdout closed', process.poll()))
                buffer += block
                assert len(buffer) <= 2 * 1024 * 1024
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

    try:
        initialization = send('initialize', {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'openbuff-rweb-feasibility', 'version': '0'},
        })
        assert initialization['serverInfo']['version'] == toolchain['version']
        send('notifications/initialized', notification=True)
        tools = []
        cursor = None
        while True:
            page = send('tools/list', {'cursor': cursor} if cursor else {})
            tools.extend(page['tools'])
            cursor = page.get('nextCursor')
            if not cursor:
                break
        names = [tool['name'] for tool in tools]
        assert len(names) == len(set(names))
        assert {'agent_browser_open', 'agent_browser_snapshot',
                'agent_browser_screenshot', 'agent_browser_close'} <= set(names)
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        selector.close()
        with (OUT / 'mcp-inspection-transcript.json').open('x') as handle:
            json.dump(transcript, handle, indent=2)
            handle.write('\n')
    assert process.returncode == 0

for name, value in [('mcp-initialize.json', initialization),
                    ('mcp-catalog.json', {'tools': tools})]:
    with (OUT / name).open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
for name in ['commands', 'session-management', 'trust-boundaries']:
    content = workspace / f'package/skill-data/core/references/{name}.md'
    with (OUT / f'{name}-reference.md').open('xb') as handle:
        handle.write(content.read_bytes())
chrome_result = subprocess.run([str(chrome), '--version'], env=environment,
                               capture_output=True, timeout=10)
assert chrome_result.returncode == 0
browser_files = [{'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}
                 for path in sorted(chrome.parent.rglob('*')) if path.is_file()]
result = {
    'schemaVersion': 1, 'type': 'researcher-browser-upstream-mcp-discovery',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
    'argv': argv, 'cwd': str(workspace / 'mcp'), 'pid': process.pid,
    'exitCode': process.returncode, 'session': session,
    'toolCount': len(tools), 'toolNames': names,
    'browser': {'path': str(chrome), 'sha256': sha(chrome),
                'version': chrome_result.stdout.decode().strip(), 'files': browser_files},
    'environment': {'replacement': True, 'keys': sorted(environment)},
    'artifacts': [{'path': str(OUT / name), 'sha256': sha(OUT / name)} for name in [
        'mcp-config.json', 'mcp-initialize.json', 'mcp-catalog.json',
        'mcp-inspection-transcript.json', 'mcp-inspection.stderr.log',
        'commands-reference.md', 'session-management-reference.md',
        'trust-boundaries-reference.md',
    ]],
    'scope': 'Exact core MCP catalog and local browser/toolchain identity; no browser or Openbuff researcher action executed.',
    'researcherImplementationAccepted': False,
}
with (OUT / 'mcp-inspection.json').open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
print(json.dumps({'toolCount': len(tools), 'session': session,
                  'browserVersion': result['browser']['version'], 'exitCode': process.returncode}))
