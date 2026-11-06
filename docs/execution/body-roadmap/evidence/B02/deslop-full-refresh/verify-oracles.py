from pathlib import Path
import datetime, hashlib, json, re, sqlite3, sys

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}
assert not (here / 'oracle-verification.original.json').exists()
plan = json.loads((here / 'plan.json').read_text())
inputs = [*plan['sourceBefore'], str(Path(__file__).resolve().relative_to(root))]
before = {path: sha(root / path) for path in inputs}
assert all(before[path] == value for path, value in plan['sourceBefore'].items())
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
verified = []
for name in plan['commands']:
    original = here / (name + '.original.json')
    receipt = json.loads(original.read_text())
    assert receipt['exitCode'] == 0 and receipt['sourceBefore'] == receipt['sourceAfter'] == plan['sourceBefore']
    assert sha(root / receipt['log']['path']) == receipt['log']['sha256']
    assert sha(Path(receipt['toolchain']['path'])) == receipt['toolchain']['sha256']
    for artifact in [*receipt['artifacts'], *receipt['networkTraces']]:
        assert sha(root / artifact['path']) == artifact['sha256'], artifact['path']
    if 'tests' in name:
        expected = 239 if name == 'consumer-tests' else 436
        counts = receipt['testCounts']
        assert counts['passed'] == [str(expected)] and counts['failed'] == ['0'] and counts['files'] == ['10']
        log = (root / receipt['log']['path']).read_text()
        assert len(re.findall(r'^\(pass\)', log, re.M)) == expected
        assert '(fail)' not in log
        assert receipt['networkTraces'] and all(trace['observed'] == {'fetchCalls': 0} for trace in receipt['networkTraces'])
    verified.append(ref(original))
actual = json.loads((here / 'actual-consumers/observations.json').read_text())
assert actual['providerCalls'] == 0 and len(actual['observations']) == 9
sqlite_checks = []
terminations = {'happy_generator': 'completed', 'fatal_generator': 'failed', 'awaited_rejection': 'failed', 'pre_cancel': 'cancelled', 'mid_cancel': 'cancelled', 'zero_cost': 'budget_exhausted', 'zero_steps': 'step_exhausted', 'recovered_accepted': 'completed', 'completed_rejected': 'completed'}
assert {row['name'] for row in actual['observations']} == set(terminations)
for row in actual['observations']:
    name = row['name']
    assert row['runOutcome']['termination'] == terminations[name]
    assert row['exitCode'] == (0 if name in ['happy_generator', 'recovered_accepted'] else 1)
    assert row['cliMessage']['runOutcome'] == row['runOutcome']
    assert row['cliMessage']['taskAcceptance'] == row['taskAcceptance']
    assert row['cliMessage']['actionOutcomes'] == row['actionOutcomes']
    database = Path(row['journalPath'])
    assert database.is_relative_to(here)
    database_before = sha(database)
    connection = sqlite3.connect(f'file:{database.resolve()}?mode=ro', uri=True)
    terminal = [payload for (raw,) in connection.execute("select payload from run_events where event_type='step_boundary' order by seq") if (payload := json.loads(raw)).get('terminal') is True]
    connection.close()
    assert sha(database) == database_before
    assert len(terminal) == (0 if name == 'pre_cancel' else 1)
    if terminal:
        assert terminal[0]['runOutcome'] == row['runOutcome']
        assert terminal[0]['taskAcceptance'] == row['taskAcceptance']
        assert terminal[0]['actionOutcomes'] == row['actionOutcomes']
    if row.get('receipt'):
        assert row['receipt']['runOutcome'] == row['runOutcome']
    if name == 'recovered_accepted':
        assert row['taskAcceptance']['status'] == 'accepted' and row['actionOutcomes'][0]['outcome'] == 'failed'
        assert (database.parent / 'recovery.txt').read_text() == 'recovered'
    if name == 'completed_rejected':
        assert row['taskAcceptance']['status'] == 'rejected'
    if name in ['pre_cancel', 'zero_cost', 'zero_steps']:
        assert row['awaitedCalls'] == 0
    if name in ['mid_cancel', 'awaited_rejection']:
        assert row['awaitedCalls'] == 1
    sqlite_checks.append({'name': name, 'sqlite': ref(database), 'terminalEvents': len(terminal), 'runOutcome': row['runOutcome'], 'fullCliTaskActionAndJournalEquality': True})
approval = json.loads((here / 'approval-cancellation/observations.json').read_text())
assert approval['providerCalls'] == 0 and len(approval['observations']) == 7
for row in approval['observations']:
    assert len(row['approvals']) == row['approvalCalls']
    assert bool(row['trace']) == row['allowed']
    if row['allowed']:
        expected = row['command'].replace('git ', 'git:', 1) + '\n' if row['command'].startswith('git push') else 'git:commit -m a  b\nrm:-rf fixture\n'
        assert row['trace'] == expected
    assert len(row['approvalRecords']) == (1 if row['approve'] and row['allowed'] else 0)
    for request in row['approvals']:
        assert request['rawCommand'] == row['command'] and request['risk'] == 'high'
        assert request['executionContextHash'] and request['effects']
    for record in row['approvalRecords']:
        assert record['consumedAt'] and record['snapshotId'] and record['runId'] and record['repositoryId'] and record['workspaceId']
        assert record['executionContextHash'] == row['approvals'][0]['executionContextHash']
    if row['name'] == 'approval_cancelled':
        assert row['runOutcome']['termination'] == 'cancelled'
        assert row['actionOutcomes'][0]['outcome'] == 'cancelled'
        assert not row['trace'] and not row['approvalRecords']
counterexamples = json.loads((here / 'counterexample-observations.json').read_text())
assert len(counterexamples['observations']) == 9
for row in counterexamples['observations']:
    if row['name'] in ['max_tokens', 'max_turn_requests']:
        assert row['result']['runOutcome']['termination'] == ('budget_exhausted' if row['name'] == 'max_tokens' else 'step_exhausted')
    elif row['name'] == 'rejected-task':
        assert row['result']['runOutcome']['termination'] == 'completed'
        assert row['result']['taskAcceptance']['status'] == 'rejected'
    elif row['name'] in ['failed-json', 'conflicting-action']:
        tool = next(event for event in row['events'] if event['type'] == 'tool_result')
        assert any(part.get('type') == 'json' and part.get('value', {}).get('errorMessage') for part in tool['output'])
        if row['name'] == 'conflicting-action':
            assert tool['actionOutcome']['outcome'] == 'failed'
            assert row['result']['actionOutcomes'][0]['outcome'] == 'failed'
        assert row['result']['runOutcome']['termination'] == 'completed'
    else:
        assert row['exitCode'] == (0 if row['name'] == 'accepted-headless' else 1)
after = {path: sha(root / path) for path in inputs}
assert before == after
observation = here / 'independent-oracle-observations.json'
observation.write_text(json.dumps({'schemaVersion': 1, 'sqliteChecks': sqlite_checks, 'sdkCases': 9, 'approvalCases': 7, 'counterexamples': 9, 'providerCalls': 0, 'scope': 'Source TS/Bun actual SDK/headless/SQLite/CLI and in-memory ACP. No provider/native/OS isolation claim.'}, indent=2) + '\n')
summary = {'sdkCases': 9, 'sqliteCases': 9, 'approvalCases': 7, 'counterexamples': 9, 'verifiedCurrentCommands': len(verified), 'providerCalls': 0, 'sourceStable': True}
log = here / 'oracle-verification.log'
log.write_text(json.dumps(summary) + '\n')
receipt = {'schemaVersion': 1, 'nodeId': 'B02', 'author': '/root/b03_mutation_evidence', 'name': 'oracle-verification', 'argv': [sys.executable, str(Path(__file__).resolve())], 'cwd': str(root), 'startedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': 0, 'log': ref(log), 'sourceBefore': before, 'sourceAfter': after, 'artifacts': [ref(observation), *verified], 'scope': 'Independent read-only oracle assertions and actual SQLite reopen; no repeated product tests.'}
(here / 'oracle-verification.original.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(summary))
