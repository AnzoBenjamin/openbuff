from pathlib import Path
import datetime, hashlib, json

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}
old_path = here.parent / 'independent-approval/approval.json'
old = json.loads(old_path.read_text())
plan = json.loads((here / 'plan.json').read_text())
assert set(plan['sourceContractHashes']) == set(old['sourceContractHashes'])
assert [path for path, value in plan['sourceContractHashes'].items() if old['sourceContractHashes'][path] != value] == ['sdk/src/serve/event-bridge.ts']
assert all(sha(root / path) == value for path, value in plan['sourceBefore'].items())
assert sha(old_path) == plan['originalAuthority']['sha256']
assert all(sha(root / item['path']) == item['sha256'] for item in old['artifacts'])
command_names = [*plan['commands'], 'oracle-verification']
commands = []
artifacts = [here / 'README.md', here / 'plan.json', here / 'run-check.py', here / 'verify-oracles.py', Path(__file__).resolve(), here / 'network-guard-test.ts', here / 'counterexamples.ts', *[root / path for path in plan['sourceContractHashes']]]
for name in command_names:
    original_path = here / (name + '.original.json')
    original = json.loads(original_path.read_text())
    assert original['exitCode'] == 0 and original['sourceBefore'] == original['sourceAfter']
    assert all(sha(root / path) == value for path, value in original['sourceBefore'].items())
    log = root / original['log']['path']
    assert sha(log) == original['log']['sha256']
    normalized = {'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': 'B02', 'name': name, 'argv': original['argv'], 'cwd': original['cwd'], 'startedAt': original['startedAt'], 'finishedAt': original['finishedAt'], 'exitCode': original['exitCode'], 'log': original['log'], 'sourceBefore': original['sourceBefore'], 'sourceAfter': original['sourceAfter'], 'sourceBindingScope': 'Exact source/config/toolchain/helper maps sampled by this original invocation before and after execution; no rewritten older maps.', 'provenance': ref(original_path), 'artifacts': [ref(original_path), ref(log), *original.get('artifacts', [])]}
    for key in ['environment', 'toolchain', 'testCounts', 'networkTraces']:
        if key in original:
            normalized[key] = original[key]
    for artifact in [*original.get('artifacts', []), *original.get('networkTraces', [])]:
        path = root / artifact['path']
        assert sha(path) == artifact['sha256']
        artifacts.append(path)
    destination = here / 'commands' / (name + '.json')
    destination.parent.mkdir(exist_ok=True)
    assert not destination.exists()
    destination.write_text(json.dumps(normalized, indent=2) + '\n')
    commands.append(ref(destination))
    artifacts.extend([original_path, log, destination])
bounded = here.parent / 'deslop-event-bridge-review'
artifacts.extend([bounded / 'audit.json', bounded / 'README.md', bounded / 'event-bridge-before.ts.txt', root / 'docs/execution/body-roadmap/evidence/integration/deslop-sdk-indexer-internal/cleanup-delta.diff'])
scope = old['scope'] + ' The current refresh also approves b04’s exact two dead-statement deletions in event-bridge.ts; original B02 implementation scope is otherwise unchanged.'
limits = [
    'No B01 main specialist/gate acceptance and no B03 mutation, B36 diagnostic or other-card implementation approval; whole-file hashes on shared files bind B02 integrity only.',
    'Additional command/audit inputs are current integrity and typecheck context only, outside independent B02 implementation approval.',
    'No native/installed-package/provider/OS-fence/process-tree/cross-process-budget or universal trusted-generator isolation assurance.',
    'Only the recorded ten-file runtime subset and orders are credited; not the full 138-file runtime CI schedule.',
    'Initial multifile failures and before-correction commands remain uncredited historical evidence; no whole-plan/card-ledger completion is implied.',
    'All ten commandReceipts are required exactly once. All 28 old command maps drifted and have been replaced, never rewritten.',
]
original = {'schemaVersion': 1, 'type': 'body-independent-approval', 'nodeId': 'B02', 'reviewer': '/root/b03_mutation_evidence', 'implementationOwners': ['/root/b02_runtime_outcomes', '/root', '/root/b04_lock_cas'], 'independent': True, 'decision': 'approve', 'scope': scope, 'sourceContractHashes': plan['sourceContractHashes'], 'commandReceipts': commands, 'reviewedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scopeLimits': limits, 'artifacts': [ref(path) for path in dict.fromkeys(artifacts)], 'supportingEvidence': [dict(ref(old_path), credit='raw-data-only', reason='Original independent B02 authority and its 162 immutable seals were verified; old command maps are historical, not current passing credit.'), dict(ref(here / 'oracle-first-failure.json'), credit='raw-data-only', reason='Independent verifier assumption corrected after inspection; no product failure or current command credit.'), dict(ref(here / 'verify-oracles-first-failure.py.txt'), credit='raw-data-only', reason='Exact first failing helper bytes preserved.')], 'supportingEvidencePolicy': 'Historical original authorities and failed helper records are raw context only; actual current producer/consumer oracles are directly attached in artifacts.'}
for name in ['approval.json', 'review.json']:
    assert not (here / name).exists()
(here / 'approval.json').write_text(json.dumps(original, indent=2) + '\n')
canonical = ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']
normalized = {key: original[key] for key in canonical}
normalized.update({'type': 'body-implementation-review', 'provenance': ref(here / 'approval.json'), 'artifacts': [*original['artifacts'], ref(here / 'approval.json')], 'supportingEvidence': original['supportingEvidence']})
(here / 'review.json').write_text(json.dumps(normalized, indent=2) + '\n')
assert all(normalized[key] == original[key] for key in canonical)
behavior = [{'criterion': 'Runtime producer termination, cancellation, budgets and retained per-attempt outcomes in both preserved orders.', 'evidence': [ref(here / 'multifile-producer-tests.log'), ref(here / 'ci-sorted-producer-tests.log'), ref(root / 'packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts')]}, {'criterion': 'SDK/serve/CLI/common/replay consumers preserve separate execution/action/task identity and ACP hard stops.', 'evidence': [ref(here / 'consumer-tests.log'), ref(root / 'sdk/src/__tests__/acp-outcomes.test.ts'), ref(root / 'sdk/src/__tests__/serve-bridge.test.ts'), ref(root / 'sdk/src/serve/__tests__/event-bridge.test.ts')]}, {'criterion': 'Actual SDK, headless, SQLite and CLI agree on nine full run/task/action outcomes including cancellation causes and failed-action recovery.', 'evidence': [ref(here / 'actual-consumers/observations.json'), ref(here / 'independent-oracle-observations.json'), ref(root / 'test/fixtures/body/runtime-outcomes.ts')]}, {'criterion': 'Actual SDK approval cancellation performs no effect or grant; repeat needs another decision and exact command/context identity is retained.', 'evidence': [ref(here / 'approval-cancellation/observations.json'), ref(root / 'scripts/body-fixtures/sdk-terminal-approval-identity.ts')]}, {'criterion': 'Independent actual in-memory ACP and headless counterexamples preserve hard stops, task rejection, empty failure and failed transport metadata.', 'evidence': [ref(here / 'counterexample-observations.json'), ref(here / 'counterexamples.ts')]}]
(here / 'behavior-evidence.json').write_text(json.dumps(behavior, indent=2) + '\n')
sealed = {(item['path'], item['sha256']) for item in original['artifacts']}
assert all((item['path'], item['sha256']) in sealed for row in behavior for item in row['evidence'])
print(json.dumps({name: ref(here / name) for name in ['approval.json', 'review.json', 'behavior-evidence.json']}, indent=2))
