"""Recompute B18 hashes from persisted observations without production helpers."""
from pathlib import Path
import hashlib, json

OUT = Path(__file__).resolve().parent
BASE = OUT.parents[1]
def sha(value): return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()
def read(path): return json.loads(path.read_text())
def context_hash(context):
    ordered = {'version': 1, 'permissionProfile': context['permissionProfile'], 'cwd': context['cwd'], 'projectRoot': context['projectRoot'],
        'allowedPaths': context.get('allowedPaths', []), 'processType': context['processType'], 'detach': context.get('detach', False), 'mode': context.get('mode', 'assistant')}
    return sha(json.dumps(ordered, separators=(',', ':'), ensure_ascii=False))
sdk = read(OUT / 'sdk-fixture/observations.json')
old_sdk = read(BASE / 'sdk-consumers/observations.json')
assert sdk['providerCalls'] == 0
assert len(sdk['observations']) == 7
assert [row['name'] for row in sdk['observations']] == [row['name'] for row in old_sdk['observations']]
sdk_rows = []
for row, old in zip(sdk['observations'], old_sdk['observations']):
    cwd = str(Path(sdk['invocationDir']) / row['name'])
    digest = sha(row['command'])
    expected_context = context_hash({'permissionProfile': 'full-access', 'cwd': cwd, 'projectRoot': cwd, 'processType': 'SYNC'})
    assert row['command'] == old['command'] and row['trace'] == old['trace']
    assert len(row['approvals']) == row['approvalCalls'] == len(old['approvals'])
    actual_trace = Path(cwd) / 'trace.txt'
    assert (actual_trace.read_text() if actual_trace.exists() else '') == row['trace']
    records = row['approvalRecords']
    actual_records = [read(file) for file in sorted((Path(cwd) / 'harness').rglob('*.json')) if file.parent.name == 'approvals']
    assert records == actual_records
    assert len(records) == (1 if row['approve'] and row['allowed'] else 0)
    for approval in row['approvals']:
        assert approval['rawCommand'] == row['command']
        assert approval['commandHash'] == digest
        assert approval['executionContextHash'] == expected_context
        assert approval['effects'] and approval['risk'] == 'high'
    for record in records:
        assert record['commandHash'] == digest
        assert record['executionContextHash'] == expected_context
        assert record['revision'] == 1 and record['consumedAt']
        assert all(record[field] for field in ['repositoryId', 'workspaceId', 'runId', 'snapshotId'])
        assert record['action'] == row['approvals'][0]['action']
        assert record['target'] == row['approvals'][0]['target']
    cancelled = row['name'] == 'approval_cancelled'
    assert row['runOutcome']['termination'] == ('cancelled' if cancelled else 'completed')
    if cancelled:
        assert not row['trace'] and not records
    sdk_rows.append({'name': row['name'], 'exactCommandHash': digest, 'executionContextHash': expected_context,
        'approvalCalls': len(row['approvals']), 'receiptCount': len(records), 'traceHash': sha(row['trace']),
        'termination': row['runOutcome']['termination'], 'historicalBehaviorMatches': True, 'persistedRecordsMatch': True})
launcher = read(OUT / 'launcher-fixture/observations.json')
old_launcher = read(BASE / 'runtime/observations.json')
assert launcher['providerCalls'] == 0
assert len(launcher['observations']) == 13 and len(launcher['parserCorpus']) == 17
launcher_rows = []
for row, old in zip(launcher['observations'], old_launcher['observations']):
    assert row['name'] == old['name'] and row['command'] == old['command']
    assert row['trace'] == old['trace'] and row['allowed'] == old['allowed']
    assert row['commandSha256'] == sha(row['command'])
    assert row['traceSha256'] == sha(row['trace'])
    cwd = str(Path(launcher['invocationDir']) / row['name'])
    trace_path = Path(cwd) / 'trace.txt'
    assert (trace_path.read_text() if trace_path.exists() else '') == row['trace']
    assert len(row['approvals']) == 1
    classified = row['approvals'][0]['classified']
    assert classified['rawCommand'] == row['command'] and classified['commandHash'] == sha(row['command'])
    assert classified['executionContextHash'] == context_hash({'permissionProfile': 'full-access', 'cwd': cwd, 'projectRoot': cwd, 'processType': 'SYNC'})
    assert (row['output'][0]['value'].get('permissionDenied') is True) == (not row['allowed'])
    if not row['allowed']: assert not row['trace']
    launcher_rows.append({'name': row['name'], 'allowed': row['allowed'], 'exactCommandHash': sha(row['command']), 'traceHash': sha(row['trace']), 'historicalBehaviorMatches': True})
parser_rows = []
for row, old in zip(launcher['parserCorpus'], old_launcher['parserCorpus']):
    assert row == old
    assert row['commandSha256'] == sha(row['command'])
    assert (row['bashSyntaxExit'] == 0) == row['syntax']
    assert (row['classified'] or {}).get('parseStatus', 'complete') == row['status']
    parser_rows.append({'commandHash': row['commandSha256'], 'syntax': row['syntax'], 'status': row['status'], 'historicalBehaviorMatches': True})
corrupt = read(OUT / 'approval-store-observations.json')
assert corrupt['fetchCalls'] == 0 and len(corrupt['observations']) == 4
for row in corrupt['observations']:
    assert row['wins'] == 0 and len(row['errors']) == 3 and row['noConsumedCorruptRecord']
    assert row['action']['commandHash'] == sha(row['command'])
    assert row['action']['executionContextHash'] == context_hash(row['context'])
    assert row['corruptBytesSha256'] == row['quarantinedBytesSha256'] == sha(Path(row['diagnostic']['quarantinedPath']).read_bytes())
healthy = corrupt['healthy']
assert healthy['action']['commandHash'] == sha(healthy['command'])
assert healthy['action']['executionContextHash'] == context_hash(healthy['context'])
assert healthy['mismatchControls'] == 7 and healthy['unchangedBytesAfterMismatch']
assert healthy['consumed'] == healthy['persisted'] and healthy['persisted']['consumedAt'] and healthy['persisted']['revision'] == 1
result = {'allPass': True, 'providerCalls': 0, 'sdkCases': sdk_rows, 'launcherCases': launcher_rows, 'parserCases': parser_rows,
    'corruptApprovalCases': [{'scenario': row['scenario'], 'wins': row['wins'], 'refusals': len(row['errors']), 'quarantinedBytesHash': row['quarantinedBytesSha256']} for row in corrupt['observations']],
    'healthyMismatchControls': healthy['mismatchControls'], 'healthySingleConsumption': True}
(OUT / 'assessment.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'allPass': True, 'sdkCases': 7, 'launcherCases': 13, 'parserCases': 17, 'corruptApprovalCases': 4, 'healthyMismatchControls': 7, 'providerCalls': 0}))
