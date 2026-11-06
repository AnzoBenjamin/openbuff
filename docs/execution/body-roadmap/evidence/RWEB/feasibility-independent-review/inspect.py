#!/usr/bin/env python3
"""Read-only independent RWEB-0 artifact/oracle reconstruction; JSON to stdout.

Does not launch the browser, source the probe, modify its artifacts, or signal
processes. Replays assertions against the recorded real native/MCP fixture.
"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tarfile
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[5]
BASE = HERE.parent / 'feasibility'
ATTEMPT = BASE / 'attempts/20261106T223317Z-ba7cba52'


def read(path):
    return json.loads(Path(path).read_text())


def digest(path, algorithm='sha256'):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def require(condition, description):
    if not condition:
        raise ValueError(description)


def verify_ref(ref, prefix=None):
    path = (prefix / ref['path']) if prefix else Path(ref['path'])
    require(digest(path) == ref['sha256'], f'hash mismatch: {path}')
    if 'bytes' in ref:
        require(path.stat().st_size == ref['bytes'], f'size mismatch: {path}')


before = read(HERE / 'before.json')['sha256']
for path, expected in before.items():
    require(digest(ROOT / path) == expected, f'protected file changed: {path}')
toolchain = read(BASE / 'toolchain.json')
discovery = read(BASE / 'mcp-inspection.json')
result = read(ATTEMPT / 'result.json')
package = Path(toolchain['workspace']) / 'package'
metadata = read(BASE / 'published-package.json')
archive = Path('/tmp/openbuff-agent-browser-0.41.2.tgz')
require(digest(archive) == toolchain['distribution']['sha256'], 'tar SHA256')
sri = 'sha512-' + base64.b64encode(bytes.fromhex(digest(archive, 'sha512'))).decode()
require(sri == metadata['dist']['integrity'] == toolchain['distribution']['integrity'], 'npm SRI')
require(digest(archive, 'sha1') == metadata['dist']['shasum'], 'npm SHA1')
verify_ref(toolchain['distribution']['packageMetadata'])
require(metadata['version'] == toolchain['version'] == '0.41.2', 'release version')
require(metadata['engines'] == toolchain['distribution']['engines'], 'published engines')
require(metadata['engines']['node'] == '>=24.0.0', 'published Node requirement')
require(metadata['license'] == 'Apache-2.0', 'license')
require(read(package / 'package.json')['engines'] == metadata['engines'], 'archive engines')

package_files = {item['path']: item for item in toolchain['packageFiles']}
require(len(package_files) == len(toolchain['packageFiles']) == 45, '45 unique package files')
require(set(package_files) == {str(p.relative_to(package)) for p in package.rglob('*') if p.is_file()}, 'extracted file inventory')
with tarfile.open(archive) as tar:
    regular = {member.name.removeprefix('package/'): member for member in tar.getmembers() if member.isfile()}
    require(set(regular) == set(package_files), 'archive file inventory')
    for name, ref in package_files.items():
        verify_ref(ref, package)
        with tar.extractfile(regular[name]) as stream:
            require(hashlib.file_digest(stream, 'sha256').hexdigest() == ref['sha256'], f'archive bytes: {name}')
    require(regular['bin/agent-browser-linux-x64'].mode == toolchain['native']['archiveMode'] == 0o644, 'archive native mode')
require(Path(toolchain['native']['path']).stat().st_mode & 0o777 == toolchain['native']['activeMode'] == 0o755, 'activated native mode')
verify_ref(toolchain['native'])
verify_ref(toolchain['wrapper'])
for command in toolchain['commands']:
    require(command['exitCode'] == 0 and command['environment']['replacement'], 'toolchain command result')
    verify_ref(command['stdout'])
    verify_ref(command['stderr'])
require((BASE / 'core-guide.md').read_bytes() == (BASE / 'wrapper-core-guide.md').read_bytes(), 'matching guides')
for ref in discovery['browser']['files']:
    verify_ref(ref)
verify_ref(discovery['browser'])
require(len(discovery['browser']['files']) == 245, 'browser asset inventory size')
for ref in discovery['artifacts'] + result['artifacts']:
    verify_ref(ref)
require(digest(BASE / 'run-local-probes.py') == result['probeScriptSha256'], 'executed probe script hash')

catalog = read(BASE / 'mcp-catalog.json')['tools']
catalog_names = [tool['name'] for tool in catalog]
require(len(catalog_names) == len(set(catalog_names)) == discovery['toolCount'] == 29, '29 unique tools')
require(catalog_names == discovery['toolNames'], 'catalog names')
catalog_transcript = read(BASE / 'mcp-inspection-transcript.json')
catalog_observed = []
for record in catalog_transcript:
    if record['direction'] == 'response':
        catalog_observed.extend(record['message'].get('result', {}).get('tools', []))
require(catalog_observed == catalog, 'catalog matches raw MCP responses')
common_fields = sorted(set.intersection(*(set(t['inputSchema']['properties']) for t in catalog)))
required_common = {'session', 'namespace', 'extraArgs', 'allowedDomains', 'caCert', 'clearCaCert', 'useSystemCa', 'idleTimeout', 'timeoutMs', 'restore', 'restoreCheckFn', 'restoreCheckText', 'restoreCheckUrl', 'restoreSave'}
require(set(common_fields) == required_common, 'shared authority-sensitive fields')
schema = {t['name']: t['inputSchema']['properties'] for t in catalog}
require('all' in schema['agent_browser_close'], 'close-all schema exposure')
require({'path', 'screenshotDir'} <= set(schema['agent_browser_screenshot']), 'screenshot path schema exposure')
require('script' in schema['agent_browser_eval'], 'eval schema exposure')

transcript = read(ATTEMPT / 'transcript.json')
requests = {}
responses = {}
for record in transcript:
    message = record['message']
    if 'id' not in message:
        continue
    target = requests if record['direction'] == 'request' else responses
    require(message['id'] not in target, 'unique JSON-RPC IDs')
    target[message['id']] = message
require(set(requests) == set(responses), 'every request has a response')
require(responses[1]['result']['serverInfo']['version'] == '0.41.2', 'actual initialized version')
for identifier, request in requests.items():
    if request['method'] != 'tools/call':
        continue
    require(request['params']['name'] in catalog_names, 'called tool is in catalog')
    response = responses[identifier]['result']
    structured = response['structuredContent']
    require(json.loads(structured['stdout']) == structured['response'], 'stdout/structured response equality')
    require(response['isError'] == (not structured['response']['success']), 'error envelope fidelity')
    require(response['isError'] == (structured['exitCode'] != 0), 'exit/error fidelity')
bindings = {
    2: 'blocked-result.json', 3: 'known-document-result.json',
    4: 'static-baseline-result.json', 5: 'open-a-result.json',
    7: 'rendered-result.json', 8: 'full-snapshot-result.json',
    9: 'interactive-snapshot-result.json', 10: 'screenshot-result.json',
    13: 'fresh-navigation-snapshot-result.json', 14: 'second-chapter-result.json',
    17: 'surviving-session-result.json',
}
for identifier, name in bindings.items():
    require(responses[identifier]['result'] == read(ATTEMPT / name), f'artifact/raw response equality: {name}')


def data(identifier):
    return responses[identifier]['result']['structuredContent']['response']['data']


fixture = read(ATTEMPT / 'fixture.json')
origin = fixture['origin']
article = 'The Kestrel fixture release preserves exactly 42 source observations.'
second = 'The second chapter requires fresh navigation observations.'
require(fixture['article'] == article and fixture['second'] == second, 'fixture oracles')
require(responses[2]['result']['isError'] and '429' in json.dumps(responses[2]), 'blocked 429')
require(data(3)['content'] == fixture['document'] and data(3)['finalUrl'] == origin + '/doc', 'known document oracle')
require('Loading article' in data(4)['content'] and article not in data(4)['content'], 'static baseline oracle')
require(data(4)['source'] == 'html-fallback', 'static read provenance')
require(data(7)['content'] == f'# Delayed article\n\n{article}\n\nSecond chapter', 'rendered article oracle')
require(data(7)['source'] == 'active-tab-html' and data(7)['finalUrl'] == origin + '/dynamic' and data(7)['truncated'] is False, 'rendered provenance/coverage')
rendered_hash = hashlib.sha256(data(7)['content'].encode()).hexdigest()
require(rendered_hash == result['checks']['renderedArticleObserved']['contentSha256'], 'rendered content digest')
require(data(9)['refs']['e2'] == {'name': 'Second chapter', 'role': 'link'}, 'fresh link observation')
require(requests[11]['params']['arguments']['selector'] == '@e2', 'click uses observed ref')
require(data(13)['origin'] == origin + '/second' and '@e2' in data(13)['removedRefs'], 'navigation invalidates old ref')
require(data(14)['content'] == f'# Second chapter\n\n{second}' and data(14)['finalUrl'] == origin + '/second', 'second source oracle')
require(article not in data(9)['snapshot'] and article in data(8)['snapshot'], 'interactive/full snapshot evidence distinction')
session_a, session_b = result['sessions']
require(session_a != session_b, 'distinct session IDs')
require(requests[15]['params']['arguments']['session'] == session_b and data(15)['url'] == origin + '/doc', 'second session opened')
require(requests[16]['params']['arguments']['session'] == session_a and data(16)['closed'], 'first session closed')
require(requests[17]['params']['arguments']['session'] == session_b and data(17)['url'] == origin + '/doc', 'second session survives closure')
require(requests[18]['params']['arguments']['session'] == session_b and data(18)['closed'], 'second session closed')
processes = read(ATTEMPT / 'both-sessions-processes.json')
profiles = {re.search(r'--user-data-dir=(\S+)', p['argv'])[1] for p in processes if p['argv'].startswith('/opt/google/chrome/chrome ') and '--type=' not in p['argv']}
require(len(profiles) == 2, 'two observed independent Chrome profiles')

png = (ATTEMPT / 'article.png').read_bytes()
images = [c for c in responses[10]['result']['content'] if c['type'] == 'image']
require(len(images) == 1 and images[0]['mimeType'] == 'image/png', 'MCP image content')
require(base64.b64decode(images[0]['data'], validate=True) == png, 'delivered PNG equals stored bytes')
require(png[:8] == b'\x89PNG\r\n\x1a\n', 'PNG signature')
width, height = struct.unpack('>II', png[16:24])
require((width, height, len(png)) == (1280, 633, 13575), 'PNG dimensions/size')
offset = 8
chunk_types = []
while offset < len(png):
    length = struct.unpack('>I', png[offset:offset + 4])[0]
    kind = png[offset + 4:offset + 8]
    payload = png[offset + 8:offset + 8 + length]
    crc = struct.unpack('>I', png[offset + 8 + length:offset + 12 + length])[0]
    require(zlib.crc32(kind + payload) == crc, 'PNG chunk CRC')
    chunk_types.append(kind.decode())
    offset += length + 12
require(offset == len(png) and chunk_types[-1] == 'IEND', 'complete PNG')

server_requests = read(ATTEMPT / 'requests.json')
require(server_requests[0]['path'] == '/blocked' and server_requests[0]['status'] == 429 and server_requests[0]['retryAfter'] == '15', 'server 429/Retry-After oracle')
require('retry' not in json.dumps(responses[2]).lower(), 'Retry-After absent from MCP')
dynamic = [r for r in server_requests if r['path'] == '/dynamic']
require(len(dynamic) == 2 and all(r['bodySha256'] == fixture['dynamicHtmlSha256'] for r in dynamic), 'same static/rendered source body')
require(any(r['path'] == '/second' and r['bodySha256'] == fixture['secondHtmlSha256'] for r in server_requests), 'second navigation source body')
denial = read(ATTEMPT / 'profile-egress-incompatibility.json')
require(denial['exitCode'] != 0 and '--allowed-domains is not supported with --profile' in denial['stdout'], 'profile denial')
cleanup = read(ATTEMPT / 'cleanup.json')
require(cleanup['commands'][0]['result'] == responses[19]['result'], 'raw rejected close preserved')
require(cleanup['commands'][1]['result'] == responses[20]['result'], 'raw second close preserved')
require(any(c.get('signal') == 'SIGTERM via pidfd' and c.get('scopeVerified') and c.get('socketDirectory') == result['socketDirectory'] for c in cleanup['commands']), 'recorded scoped fallback')
require(cleanup['remainingProcesses'] == result['remainingOwnedProcesses'] == [] and cleanup['mcpExitCode'] == 0, 'recorded bounded cleanup observation')
require(result['passed'] and result['error'] is None and len(result['checks']) == 7, 'producer result consistent')

current_matches = []
unreadable = 0
for proc in Path('/proc').glob('[0-9]*'):
    if int(proc.name) == os.getpid():
        continue
    try:
        argv = (proc / 'cmdline').read_bytes()
        if toolchain['workspace'].encode() not in argv:
            continue
        state = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()[0]
        if state != 'Z':
            current_matches.append(int(proc.name))
    except (OSError, ValueError, IndexError):
        unreadable += 1
require(not current_matches, 'current workspace-matching process observation')
for path, expected in before.items():
    require(digest(ROOT / path) == expected, f'protected file changed during inspection: {path}')

print(json.dumps({
    'schemaVersion': 1, 'reviewer': '/root/first_wave_architect',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'passed': True, 'method': 'Independent recorded-oracle reconstruction and current input hashing; no browser replay or process signals',
    'archiveSha256': digest(archive), 'npmSRI': sri, 'npmSHA1': digest(archive, 'sha1'),
    'packageFilesVerified': 45, 'chromeAssetsVerified': 245,
    'nodeRequirement': metadata['engines']['node'], 'coreGuideSha256': digest(BASE / 'core-guide.md'),
    'nativeSha256': digest(toolchain['native']['path']),
    'chromeSha256': digest(discovery['browser']['path']),
    'catalogToolsVerified': 29, 'commonSchemaFields': common_fields,
    'probeArtifactsVerified': len(result['artifacts']), 'rpcPairsVerified': len(requests),
    'attempt': str(ATTEMPT.relative_to(ROOT)), 'attemptResultSha256': digest(ATTEMPT / 'result.json'),
    'probeScriptSha256': digest(BASE / 'run-local-probes.py'),
    'oracles': {'blockedKnownDocument': True, 'staticVsRendered': True,
        'renderedTextSha256': rendered_hash, 'freshNavigation': True,
        'twoObservedChromeProfiles': sorted(profiles), 'survivingSession': True,
        'pngBytes': len(png), 'pngDimensions': [width, height], 'pngSha256': digest(ATTEMPT / 'article.png'),
        'profileRefusal': True, 'normalCloseAndScopedFallbackRecorded': True},
    'processObservation': {'workspaceMatchingNonZombiePids': current_matches, 'unreadableOrRacedProcEntries': unreadable,
        'limit': 'Only visible /proc cmdlines containing the private workspace; not a descendant or OS containment guarantee'},
    'protectedFilesUnchanged': len(before), 'implementationAccepted': False,
}, indent=2))
