"""Read-only verification; writes only the new independent full-suite review."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

if not __debug__:
    raise RuntimeError('Optimized review is unsupported')
OUT = Path(__file__).resolve().parent
BASE = OUT.parent
ROOT = BASE.parents[5]


def binding(path):
    path = Path(path)
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def check(row):
    current = binding(ROOT / row['path'])
    assert current['sha256'] == row['sha256'], row['path']
    if 'bytes' in row:
        assert current['bytes'] == row['bytes'], row['path']
    return current


def read(name):
    return json.loads((BASE / name).read_text())


def receipt(name):
    doc = read(name)
    assert doc['sourceBefore'] == doc['sourceAfter'], name
    for path, digest in doc['sourceAfter'].items():
        check({'path': path, 'sha256': digest})
    artifacts = [check(row) for row in doc.get('artifacts', [])]
    if 'log' in doc:
        artifacts.append(check(doc['log']))
    if 'fetchLog' in doc:
        artifacts.append(check(doc['fetchLog']))
    return doc, {'receipt': binding(BASE / name), 'exitCode': doc['exitCode'],
                 'counts': doc['counts'], 'stableCurrentInputCount': len(doc['sourceBefore']),
                 'artifacts': artifacts}


full, full_observation = receipt('full-agents-unrestricted/full-agents.json')
target, target_observation = receipt('after-file-picker/receipt.json')
negative = []
negative_docs = {}
for name in ['full-agents/full-agents.json', 'after-agents-ci.json',
             'before-file-picker/receipt.json', 'diagnostic/receipt.json']:
    doc, observed = receipt(name)
    assert doc['exitCode'] == 1
    negative_docs[name] = doc
    negative.append(observed)
assert full['exitCode'] == target['exitCode'] == 0
assert full['counts'] == {'pass': 1359, 'skip': 5, 'fail': 0}
assert target['counts'] == {'pass': ['4'], 'skip': [], 'fail': ['0'], 'assertions': ['15']}
assert full['tests'] == 1364 and full['files'] == 56
assert len(full['sourceBefore']) == 135
assert target['sourceBefore'] == negative_docs['before-file-picker/receipt.json']['sourceBefore']
assert target['argv'] == negative_docs['before-file-picker/receipt.json']['argv']
log = (ROOT / full['log']['path']).read_text()
assert '1359 pass\n 5 skip\n 0 fail\n 2 snapshots, 9109 expect() calls\nRan 1364 tests across 56 files.' in log
assert not re.search(r'^\(fail\)', log, re.M)
headers = re.findall(r'^([^\n:]+\.test\.tsx?):$', log, re.M)
discovered = sorted('agents/' + path for path in headers)
current = sorted(subprocess.check_output(['rg', '--files', 'agents', '-g', '*.test.ts',
                                         '-g', '*.test.tsx', '-g', '!**/node_modules/**'],
                                        cwd=ROOT, text=True).splitlines())
assert discovered == current and len(current) == 56
assert sum(path.startswith('agents/__tests__/') for path in current) == 45
assert sum(path.startswith('agents/e2e/') for path in current) == 8
file_counts = {}
current_header = None
for line in log.splitlines():
    match = re.fullmatch(r'([^\n:]+\.test\.tsx?):', line)
    if match:
        current_header = match[1]
        file_counts[current_header] = {'pass': 0, 'skip': 0, 'fail': 0}
    match = re.match(r'\((pass|skip|fail)\)', line)
    if match and current_header and not line.startswith('(skip) Base Deep'):
        file_counts[current_header][match[1]] += 1
for path, count in [('e2e/gate-aux-ordering.e2e.test.ts', 24),
                    ('e2e/gate-lifecycle.e2e.test.ts', 8),
                    ('e2e/file-explorer.e2e.test.ts', 4)]:
    assert file_counts[path] == {'pass': count, 'skip': 0, 'fail': 0}
full_fetch = [json.loads(line) for line in (BASE / 'full-agents-unrestricted/fetch.jsonl').read_text().splitlines()]
assert full_fetch == full['fetchObservation']
assert [row['event'] for row in full_fetch] == ['guard-installed-before-imports', 'test-after-all']
assert all(row['refused'] == row['forwarded'] == 0 for row in full_fetch)
assert len({row['pid'] for row in full_fetch}) == 1
target_fetch = [json.loads(line) for line in (BASE / 'after-file-picker/fetch.jsonl').read_text().splitlines()]
assert [row['event'] for row in target_fetch] == ['guard-installed-before-imports', 'test-after-all']
assert all(row['refused'] == row['forwarded'] == 0 for row in target_fetch)
assert (BASE / 'provider-config.json').read_text() == '{}\n'
toolchain = full['toolchain']
assert hashlib.sha256(Path(toolchain['executable']).read_bytes()).hexdigest() == toolchain['sha256']
assert toolchain['sha256'] == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
assert toolchain['version'] == '1.3.5'
fixture_review = read('independent-fixture-review/review.json')
for row in fixture_review['sourceBindings']:
    check(row)
    assert full['sourceAfter'][row['path']] == row['sha256']
file_explorer = 'agents/e2e/file-explorer.e2e.test.ts'
assert full['sourceAfter'][file_explorer] == 'b7ac93cac7f1fd2e1d38334ffaf483c473b9e1e5cb7b1a97a1f78c2238d8c48b'
assert hashlib.sha256(subprocess.check_output(['git', 'show', 'HEAD:' + file_explorer], cwd=ROOT)).hexdigest() == full['sourceAfter'][file_explorer]
diagnostic = [json.loads(line) for line in (BASE / 'diagnostic/observations.jsonl').read_text().splitlines()]
assert [row['explicitModel'] for row in diagnostic] == [False, True]
socket_observations = []
for row in diagnostic:
    assert row['fetches'] == 0 and row['output'] == {'type': 'structuredOutput', 'value': None}
    tool_result = next(event for event in row['events'] if event['type'] == 'tool_result')
    child = tool_result['output'][0]['value'][0]
    assert 'Failed to listen at ' in child['value']['errorMessage'] and '/rpc.sock' in child['value']['errorMessage']
    assert child['agentReceipt']['status'] == 'partial' and child['agentReceipt']['outcome'] == 'crashed'
    assert not any('No model configured' in message for message in row['messages'])
    socket_observations.append({'explicitModel': row['explicitModel'], 'fetches': row['fetches'],
                                'error': child['value']['errorMessage'],
                                'childReceiptStatus': child['agentReceipt']['status']})
coverage = read('independent-scope/coverage-schedules.json')
assert coverage['currentAgentsTestFiles'] == current
historical_receipt = check(coverage['historicalReceipt'])
historical_log = check(coverage['historicalLog'])
oldlog = (ROOT / historical_log['path']).read_text()
assert '$ bun test __tests__' in oldlog and 'Ran 1284 tests across 45 files.' in oldlog
assert len(re.findall(r'^([^\n:]+\.test\.tsx?):$', oldlog, re.M)) == 45
seals = []
for name, expected in [('independent-fixture-review/manifest.json', 'de4ef5dbe5538e334bc2f299111c2d238be6c7130854089ac78679efb2cd8a09'),
                       ('independent-scope/manifest.json', '528f275029fcda6507efe693841237727a8ad0dbaac03254c37966ae26cac3d7')]:
    seal = binding(BASE / name)
    assert seal['sha256'] == expected
    for row in read(name)['files']:
        check(row)
    seals.append(seal)
ledger = binding(ROOT / 'docs/execution/body-roadmap/ledger.json')
assert ledger['sha256'] == '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
result = {'schemaVersion': 1, 'type': 'independent-managed-agents-suite-ci-review',
          'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'reviewer': '/root/b04_lock_cas', 'decision': 'approve-bounded-full-agents-ci-evidence',
          'scope': 'Managed agents discovery CI result only, separate from two-file semantic approval; no product/card acceptance renewal or entire pre-push approval.',
          'fullSuite': full_observation, 'assertions': 9109,
          'unmodifiedFileExplorerControl': target_observation,
          'declaredMapLimit': '135 declared full-suite inputs are stable/current; this is not universal runtime dependency tracing. The exact targeted file-explorer control separately binds 17 inputs including sdk/dist/index.mjs.',
          'sourceBindings': fixture_review['sourceBindings'] + [binding(ROOT / file_explorer)],
          'matchedManagedDiscoveryFiles': current,
          'relevantPassingFileCounts': {p: file_counts[p] for p in ['e2e/gate-aux-ordering.e2e.test.ts', 'e2e/gate-lifecycle.e2e.test.ts', 'e2e/file-explorer.e2e.test.ts']},
          'historicalUnitScope': {'files': 45, 'pass': 1284, 'receipt': historical_receipt, 'log': historical_log},
          'parentFetchObservation': full_fetch, 'parentFetchLog': binding(BASE / 'full-agents-unrestricted/fetch.jsonl'),
          'barrierLimit': 'The preload replaces fetch in the test parent and does not delegate. Observed refused and forwarded calls are zero. This is not an OS network barrier or an independently instrumented child-wide network trace.',
          'executionContext': full['executionContext'],
          'socketDiagnosis': socket_observations,
          'diagnosticInterpretation': 'Both model variants reached supervised spawn and failed at the Unix socket. Their provisional model assertions failed and are preserved. The exact unchanged fixture then passed with required sandbox escalation; no explicit-model source correction was made.',
          'preservedNegativeReceipts': negative, 'priorSealsVerified': seals, 'ledger': ledger,
          'sourceLedgerStagingOrPriorArtifactsEdited': False, 'productTestsRerunByReviewer': False}
with (OUT / 'review.json').open('x') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps(binding(OUT / 'review.json')))
