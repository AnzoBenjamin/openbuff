"""Independent B03 lineage, exact original command inputs and byte oracles."""
from pathlib import Path
import base64
import datetime
import difflib
import hashlib
import json

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir())
AUTHOR = '/root/b02_runtime_outcomes'

def read(path):
    return json.loads(Path(path).read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    return {'path': str(Path(path).relative_to(ROOT)), 'sha256': sha(path)}

def bind(row):
    path = ROOT / row['path']
    assert sha(path) == row['sha256'], row['path']
    return path

assert not (OUT / 'inspection.json').exists()
inputs = read(OUT / 'source-inputs.json')
sources = inputs['sourceContractHashes']
for path, digest in sources.items():
    assert sha(ROOT / path) == digest, path
prior = read(bind(inputs['historicalApproval']))
assert inputs['driftedPriorRows'] == ['sdk/src/serve/event-bridge.ts']
assert [path for path, digest in prior['sourceContractHashes'].items() if sources[path] != digest] == inputs['driftedPriorRows']
history = []
old = ROOT / 'docs/execution/body-roadmap/evidence/B03/post-route/independent-countersignature'
for filename in ['approval.json', 'review.json', 'inputs.json', 'inspection.json']:
    history.append(ref(old / filename))
for row in prior['commandReceipts']:
    original = read(bind(row))
    assert original['sourceBefore'] == original['sourceAfter']
    assert original['sourceBefore']['sdk/src/serve/event-bridge.ts'] != sources['sdk/src/serve/event-bridge.ts']
    bind(original['log'])
    history.append(row)

cleanup = ROOT / 'docs/execution/body-roadmap/evidence/integration/deslop-sdk-indexer-internal'
manifest = read(cleanup / 'manifest.json')
for row in manifest['files']:
    bind(row)
before = read(cleanup / 'bridge-before.json')
after = read(cleanup / 'bridge-after.json')
path = 'sdk/src/serve/event-bridge.ts'
assert before['sourceBefore'] == before['sourceAfter']
assert after['sourceBefore'] == after['sourceAfter']
assert before['sourceBefore'][path] == prior['sourceContractHashes'][path]
assert after['sourceAfter'][path] == sources[path]
for row in [before, after]:
    assert row['exitCode'] == 0 and row['counts']['pass'] == ['64'] and row['counts']['fail'] == ['0']
    bind(row['log'])
    for trace in row['networkTraces']:
        assert read(bind(trace)) == {'fetchCalls': 0}
for name, digest in after['sourceBefore'].items():
    assert sha(ROOT / name) == digest, name
current = (ROOT / path).read_text()
reconstructed = current.replace("      let failed = classified.outcome !== 'succeeded'\n", "      let failed = classified.outcome !== 'succeeded'\n      let mutation: MutationResultSummary | undefined\n", 1).replace("          if (parsed.outcome !== 'applied') failed = true\n", "          if (parsed.outcome !== 'applied') failed = true\n          mutation = parsed\n", 1)
assert hashlib.sha256(reconstructed.encode()).hexdigest() == before['sourceBefore'][path]
delta = ''.join(difflib.unified_diff(reconstructed.splitlines(keepends=True), current.splitlines(keepends=True), fromfile='a/' + path, tofile='b/' + path))
assert delta == (cleanup / 'cleanup-delta.diff').read_text()

# The earlier broad post-cleanup decision is historical after unrelated3D
# test fixture-budget drift; never rewrite or trim its original input maps.
superseded = read(bind(inputs['supersededBroadApproval']))
history.append(inputs['supersededBroadApproval'])
history.append(inputs['supersededBroadReview'])
bind(inputs['supersededBroadReview'])
drift = inputs['historicalContextDrift']
assert sha(ROOT / drift['path']) == drift['after']
for row in superseded['commandReceipts']:
    old_command = read(bind(row))
    assert old_command['sourceBefore'] == old_command['sourceAfter']
    assert old_command['sourceBefore'][drift['path']] == drift['before']
    history.append(row)
scope = read(OUT / 'dependency-scope.json')
assert scope['excludedUnrelatedTest'] == drift['path']
assert drift['path'] not in {row['path'] for row in scope['files']}
assert not {'evals/buffbench/statistics.ts', 'evals/buffbench/run-buffbench.ts', 'scripts/compare-buffbench-runs.ts'} & {row['path'] for row in scope['files']}
run = read(OUT / 'run-results.json')
assert run['allControlsPassed']
(OUT / 'commands').mkdir(exist_ok=False)
command_refs, contexts = [], []
for original_ref in run['commands']:
    original = read(bind(original_ref))
    assert original['exitCode'] == 0 and original['sourceStable']
    assert original['sourceBefore'] == original['sourceAfter']
    for name, digest in original['sourceBefore'].items():
        assert sha(ROOT / name) == digest, name
    assert all(original['sourceBefore'][name] == digest for name, digest in sources.items())
    for key in ['log', 'runner', 'preload', 'providerConfiguration']:
        bind(original[key])
    assert read(bind(original['providerConfiguration'])) == {}
    assert original['environment']['replacement']
    assert original['environment']['values']['BUN_OPTIONS'] == '--no-env-file'
    assert not Path(original['environment']['values']['HOME']).exists()
    if original['fetchLog']:
        bind(original['fetchLog'])
        observations = original['fetchObservation']
        assert observations[0]['event'] == 'guard-installed-before-imports'
        assert observations[-1]['event'] in ['test-after-all', 'process-exit']
        assert all(row['refused'] == row['forwarded'] == 0 for row in observations)
    normalized = {**original, 'provenance': original_ref, 'sourceMapDerivation': 'Exact fresh original command maps; no substituted inputs', 'normalizationOnly': True}
    file = OUT / 'commands' / (original['name'] + '.json')
    file.write_text(json.dumps(normalized, indent=2) + '\n')
    command_refs.append(ref(file))
    contexts.append({'name': original['name'], 'original': original_ref, 'receipt': command_refs[-1], 'sourceContextRows': len(original['sourceBefore']), 'counts': original['counts'], 'current': True})

# Independently reconstruct authority from raw persisted receipts and bytes.
def acknowledged(receipt):
    result = []
    for action in receipt['actions']:
        forward = action.get('forward')
        if action['status'] not in ['committed', 'rollback_failed'] or not forward or forward['outcome'] != 'applied':
            continue
        hashes = forward['afterHashes']
        target = action.get('destinationPath', action['path'])
        if hashes.get(target) != action['afterHash']:
            continue
        if action['action'] == 'move' and hashes.get(action['path'], 'missing') is not None:
            continue
        if all(name in receipt['finalHashes'] and receipt['finalHashes'][name] == digest for name, digest in hashes.items()):
            result.append(action)
    return result

report = read(OUT / 'fixture/mutation-report.json')
expected = {'rejected-then-recovered': [0, 1], 'thrown-partial': [0], 'retained-partial-forward': [1], 'successful-edit': [1]}
byte_count = 0
populations = []
for row in report['records']:
    for side in ['before', 'after']:
        for record in row[side].values():
            raw = base64.b64decode(record['base64'], validate=True)
            assert raw.decode() == record['utf8']
            assert 'sha256:' + hashlib.sha256(raw).hexdigest() == record['hash']
            byte_count += 1
    operation_ids, paths, counts = [], [], []
    for projection in row['projections']:
        mutation = projection['mutation']
        receipt = mutation['authorityReceipt']
        assert receipt['operationId'] == mutation['operationId'] and receipt['receiptId'] == mutation['receiptId']
        actions = acknowledged(receipt)
        assert [action['actionId'] for action in actions] == [action['actionId'] for action in projection['confirmed']] == [action['actionId'] for action in projection['cliConfirmed']]
        assert projection['summary']['filesEdited'] == len(actions)
        assert projection['headlessAction']['effect']['confirmedPaths'] == [action['path'] for action in actions]
        counts.append(len(actions))
        if actions:
            operation_ids.append(mutation['operationId'])
            paths.extend(action['path'] for action in actions)
        else:
            assert projection['headlessAction']['effect']['status'] != 'confirmed' and projection['cliOutcome']['tone'] != 'good'
    assert counts == expected[row['mode']]
    assert [observer['operationId'] for observer in row['observers']] == operation_ids
    assert [action['path'] for observer in row['observers'] for action in observer['actions']] == paths
    journals = list((OUT / 'fixture' / row['mode'] / 'harness').glob('*/workspace-journals/workspace.json'))
    if paths:
        assert len(journals) == 1
        changes = read(journals[0])['state']['changes']
        assert [change['operationId'] for change in changes] == operation_ids
        assert [action['path'] for change in changes for action in change['actions']] == paths
    else:
        assert not journals
    populations.append(counts)
assert not acknowledged(report['legacyRefusedRollback']['authorityReceipt'])
node = read(OUT / 'node-broker-probe.json')
for side in ['before', 'after']:
    raw = base64.b64decode(node[side]['base64'], validate=True)
    assert 'sha256:' + hashlib.sha256(raw).hexdigest() == node[side]['hash']
    byte_count += 1
assert byte_count == 18 and base64.b64decode(node['after']['base64']) == b'after\r\nkept\r\n'
assert len(acknowledged(node['mutation']['authorityReceipt'])) == 1
assert node['fetchObservation'] == {'attempted': 0, 'forwarded': 0}
assert report['fetch'] == {'attempted': 0, 'forwarded': 0}
assert report['fetchGuardControl']['attempted'] == report['fetchGuardControl']['refused'] == 1
assert report['fetchGuardControl']['forwarded'] == 0
consumer = read(OUT / 'consumer-probe.json')
assert consumer['rawUnbacked']['classified']['effect']['confirmedPaths'] == []
assert consumer['rawUnbacked']['cliOutcome'] == 'unconfirmed'
assert consumer['rawUnbacked']['summary']['filesEdited'] == 0
assert consumer['rawUnbacked']['acp']['status'] == 'failed'
assert [(row['name'], row['confirmation'], row['update']['status']) for row in consumer['cases']] == [('confirmed', 1, 'completed'), ('refused-rollback', 0, 'failed'), ('uncertain-rollback', 0, 'failed'), ('confirmed-delete', 1, 'completed')]
for row in consumer['cases']:
    wire = json.dumps({'update': row['update'], 'terminal': row['terminal']})
    assert 'B03_SYNTHETIC_VALUE' not in wire and 'sha256:synthetic-input-identity' not in wire
    for digest in [row['mutation']['actions'][0]['beforeHash'], row['mutation']['actions'][0]['afterHash']]:
        if digest:
            assert digest not in wire

result = {'schemaVersion': 1, 'type': 'body-current-independent-inspection', 'nodeId': 'B03', 'reviewer': AUTHOR, 'sourceContractHashes': sources, 'commandReceipts': command_refs, 'commandContexts': contexts, 'historicalEvidence': history, 'boundedDependencyScope': ref(OUT / 'dependency-scope.json'), 'historicalContextDrift': drift, 'cleanupLineage': {'manifest': ref(cleanup / 'manifest.json'), 'delta': ref(cleanup / 'cleanup-delta.diff'), 'before': ref(cleanup / 'bridge-before.json'), 'after': ref(cleanup / 'bridge-after.json'), 'inverseDeltaMatchesOriginalBeforeHash': True, 'onlyChangedContract': path}, 'independentOracleObservations': {'byteRecordsRecomputed': byte_count, 'confirmedPopulations': populations, 'observerAndJournalCorrelationsMatch': True, 'legacyRefusedRollbackConfirmations': 0, 'nodeExactCRLFConfirmation': 1, 'consumerConfirmedRefusedUncertainDeleteCases': 4, 'rawUnbackedConfirmedPaths': 0, 'codingFetchAttempts': 0, 'forwardedFetches': 0, 'positiveFetchRefusal': 1}, 'allCurrentSourceAndContextBindingsMatch': True, 'requiredProductReruns': [], 'productCommandsRunByThisReviewer': True, 'inspectedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
(OUT / 'inspection.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'nodeId': 'B03', 'allMatch': True, 'contractSources': len(sources), 'commands': len(command_refs), 'contextRows': contexts[0]['sourceContextRows'], 'oracle': result['independentOracleObservations']}))
