#!/usr/bin/env python3
"""Validate executable observations and hashes; never issue card acceptance."""
import datetime, hashlib, json, pathlib, re

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
commands = ['policy-tests','terminal-tests','approval-bridge-tests','runtime-tests','runtime','sdk-consumers','sdk-typecheck','diff-check']
source = {}
for name in commands:
    receipt = json.loads((HERE/(name+'.json')).read_text())
    assert receipt['exit'] == 0 and receipt['sourceUnchangedDuringCommand'], name
    if name != 'diff-check': assert '--no-env-file' in receipt['argv'], name
    assert sha(HERE/receipt['log']) == receipt['logSha256'], name
    for file, digest in receipt['sourceAfter'].items():
        assert sha(ROOT/file) == digest, file
        source[file] = digest
runtime = json.loads((HERE/'runtime/observations.json').read_text())
assert runtime['providerCalls'] == 0 and len(runtime['observations']) == 13 and len(runtime['parserCorpus']) == 17
for row in runtime['observations']:
    assert len(row['approvals']) == 1
    assert row['commandSha256'] == hashlib.sha256(row['command'].encode()).hexdigest()
    assert row['approvals'][0]['classified']['rawCommand'] == row['command']
    assert row['approvals'][0]['classified']['executionContextHash']
    if not row['allowed']: assert row['trace'] == ''
    trace = pathlib.Path(runtime['invocationDir']) / row['name'] / 'trace.txt'
    assert (trace.read_text() if trace.exists() else '') == row['trace']
    assert hashlib.sha256(row['trace'].encode()).hexdigest() == row['traceSha256']
sdk = json.loads((HERE/'sdk-consumers/observations.json').read_text())
assert sdk['providerCalls'] == 0 and len(sdk['observations']) == 7
for row in sdk['observations']:
    assert len(row['approvals']) == row['approvalCalls']
    if not row['allowed']: assert row['trace'] == ''
    case = pathlib.Path(sdk['invocationDir']) / row['name']
    trace = case / 'trace.txt'
    assert (trace.read_text() if trace.exists() else '') == row['trace']
    stored = [json.loads(file.read_text()) for file in (case/'harness').rglob('*.json') if 'approvals' in file.parts]
    assert sorted(stored, key=lambda record:record['id']) == sorted(row['approvalRecords'], key=lambda record:record['id'])
    for record in row['approvalRecords']:
        assert record['consumedAt'] and record['snapshotId'] and record['runId'] and record['workspaceId'] and record['repositoryId']
        assert record['executionContextHash'] == row['approvals'][0]['executionContextHash']
        assert record['commandHash'] == hashlib.sha256(row['command'].encode()).hexdigest()
by_name = {row['name']: row for row in sdk['observations']}
assert by_name['approval_cancelled']['runOutcome']['termination'] == 'cancelled'
assert by_name['approval_cancelled']['approvalRecords'] == []
assert by_name['repeat_requires_new_decision']['trace'] == 'git:push --force origin feature\n'
assert len(by_name['repeat_requires_new_decision']['approvalRecords']) == 1
counts = {}
for name in commands[:4]:
    match = re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail', (HERE/(name+'.log')).read_text())
    assert match
    counts[name] = {'passed':int(match[1]), 'failed':int(match[2])}
manifest = {
    'schemaVersion':1, 'card':'B18', 'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'tier':'TypeScript scanner, harness approval, actual source SDK/terminal/ACP consumers with harmless local effects',
    'cardAcceptance':'independent_review_pending', 'reviewRole':'implementation-author verification; no independent or native acceptance claim',
    'counts':counts, 'runtimeCases':13, 'parserCorpusCases':17, 'actualSdkCases':7, 'providerCalls':0,
    'commands':[{'receipt':name+'.json','sha256':sha(HERE/(name+'.json'))} for name in commands],
    'sourceHashes':source,
    'limits':['Potential recognized effect roster is conservative, not actual effect ordering or a complete shell AST.', 'Unsupported shell interpretation requires approval except deliberate allow-all; scripts, aliases, executable lookup and arbitrary external effects are outside static effect completeness.', 'Terminal profiles and WeakMap tokens are cooperative TypeScript mechanisms, not OS isolation or cross-process fencing.', 'Actual child commands are harmless executable doubles; no remote push, deployment, package install, native parser, provider or installed-package claim.'],
    'history':['initial-cancellation-failure-* captures the initial denied-result cancellation counterexample; runtime-cancellation-failure-* captures the subsequent native malformed_result conversion. Neither is a passing acceptance command.', 'Only current observations.json and command receipts establish the final invocation; earlier UUID directories retain preliminary local fixture artifacts.'],
    'artifacts':{str(file.relative_to(HERE)):sha(file) for file in sorted(HERE.rglob('*')) if file.is_file() and file.name != 'manifest.json'},
}
(HERE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'counts':counts,'runtimeCases':13,'parserCases':17,'sdkCases':7,'boundFiles':len(source),'artifacts':len(manifest['artifacts']),'status':manifest['cardAcceptance']}))
