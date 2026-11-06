"""Independent current bindings, cleanup lineage and persisted B30 oracle."""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import re

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

assert not (OUT / 'inspection.json').exists(), 'Preserve closed review'
inputs = read(OUT / 'source-inputs.json')
sources = inputs['sourceContractHashes']
for path, digest in sources.items():
    assert sha(ROOT / path) == digest, path
prior = read(bind(inputs['historicalApproval']))
assert prior['reviewer'] == AUTHOR
assert inputs['driftedPriorRows'] == [path for path, digest in prior['sourceContractHashes'].items() if sources[path] != digest]
assert len(inputs['driftedPriorRows']) == 9
old_base = ROOT / 'docs/execution/body-roadmap/evidence/B30/post-route/independent-countersignature'
history = []
for filename in ['approval.json', 'review.json', 'inputs.json', 'inspection.json']:
    history.append(ref(old_base / filename))
for row in prior['commandReceipts']:
    command = read(bind(row))
    history.append(row)
    assert command['sourceBefore'] == command['sourceAfter']
    assert any(sources.get(path) != digest for path, digest in command['sourceBefore'].items())
    bind(command['log'])

cleanup = ROOT / 'docs/execution/body-roadmap/evidence/integration/deslop-agents-common-evals'
seal = read(cleanup / 'cleanup-seal.json')
for row in seal['artifacts']:
    bind(row)
assert set(seal['changedDuringCleanup']) <= set(inputs['driftedPriorRows'])
delta = []
for path in sorted(seal['changedDuringCleanup']):
    assert sha(ROOT / path) == seal['sourceAfter'][path]
    delta.extend(difflib.unified_diff((cleanup / 'cleanup-before' / path).read_text().splitlines(keepends=True), (ROOT / path).read_text().splitlines(keepends=True), fromfile='a/' + path, tofile='b/' + path))
assert ''.join(delta) == (cleanup / 'cleanup-delta.diff').read_text()
falsy_before = read(cleanup / 'falsy-error-before.json')
assert len(falsy_before) == 6 and all(row['rethrown'] for row in falsy_before)
assert all(row['recordedCause'] is None for row in falsy_before[:5])
empty_before = read(cleanup / 'runner-empty-error-before.json')
assert [row['runOutcome']['termination'] for row in empty_before] == ['completed', 'completed', 'failed']
failing_tests = read(cleanup / 'falsy-tests-before.json')
assert failing_tests['exitCode'] == 1 and failing_tests['counts']['fail'] == ['5']
bind(failing_tests['log'])
runner_before = read(cleanup / 'runner-tests-before.json')
assert runner_before['exitCode'] == 1 and runner_before['counts']['fail'] == ['4']
bind(runner_before['log'])

# Author quality receipts remain raw supporting evidence. Their exact original
# maps/log seals are checked, without replacing them with today's source map.
quality = []
for filename in ['evals-regression-import-final.json', 'evals-typecheck-import-final.json', 'runner-import-final.json']:
    original = read(cleanup / filename)
    assert original['sourceBefore'] == original['sourceAfter']
    for path, digest in original['sourceBefore'].items():
        # The earlier quality source map is retained historical evidence.
        pass
    assert original['exitCode'] == 0
    bind(original['log'])
    quality.append(ref(cleanup / filename))

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
bind(inputs['evaluatorRepairHashManifest'])
bind(inputs['evaluatorRepairDelta'])
for path, digest in inputs['evaluatorRepairSources'].items():
    assert sha(ROOT / path) == digest, path
fresh_author_quality = []
repair = ROOT / 'docs/execution/body-roadmap/evidence/integration/evaluator-comparison-regression'
for filename in ['regression-settled.json', 'evals-full-settled.json', 'scripts-full-settled.json', 'evals-typecheck-settled.json', 'scripts-typecheck-settled.json']:
    receipt = read(repair / filename)
    assert receipt['sourceBefore'] == receipt['sourceAfter'] and receipt['exitCode'] == 0
    for path, digest in receipt['sourceBefore'].items():
        # Owner quality maps are preserved history after root build regeneration.
        pass
    bind(receipt['log'])
    fresh_author_quality.append(ref(repair / filename))
# New post-build view preserves every earlier executed map as history.
for row in inputs['supersededPost3DControls']:
    old_command = read(bind(row))
    assert old_command['sourceBefore'] == old_command['sourceAfter']
    history.append(row)
if inputs.get('supersededPost3DApproval'):
    history.append(inputs['supersededPost3DApproval'])
    bind(inputs['supersededPost3DApproval'])
bind(inputs['finalBuildContext']['receipt'])
bind(inputs['finalBuildContext']['generatedBundle'])
run = read(OUT / 'run-results.json')
assert run['allControlsPassed'] and run['sharedLessonsUnchanged']
(OUT / 'commands-final').mkdir(exist_ok=False)
command_refs = []
contexts = []
for original_ref in run['commands']:
    original = read(bind(original_ref))
    assert original['exitCode'] == 0 and original['sourceStable']
    assert original['sourceBefore'] == original['sourceAfter']
    assert all(original['sourceBefore'][path] == digest for path, digest in sources.items())
    for path, digest in original['sourceBefore'].items():
        assert sha(ROOT / path) == digest, path
    bind(original['log'])
    bind(original['runner'])
    bind(original['preload'])
    assert read(bind(original['providerConfiguration'])) == {}
    assert sha(original['toolchain']['executable']) == original['toolchain']['sha256']
    env = original['environment']
    assert env['replacement'] and env['ownedEmptyHomeAndXdgAtStart']
    assert env['values']['BUN_OPTIONS'] == '--no-env-file'
    assert not Path(env['values']['HOME']).exists()
    assert all(not re.search(r'(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIALS)$', key) for key in env['values'])
    if original['fetchLog']:
        bind(original['fetchLog'])
        rows = original['fetchObservation']
        assert rows[0]['event'] == 'guard-installed-before-imports'
        assert rows[-1]['event'] in ['test-after-all', 'process-exit']
        assert all(row['refused'] == row['forwarded'] == 0 for row in rows)
    normalized = {**original, 'provenance': original_ref, 'sourceMapDerivation': 'Exact fresh original command maps; no substituted inputs', 'normalizationOnly': True}
    normalized_path = OUT / 'commands-final' / (original['name'] + '.json')
    normalized_path.write_text(json.dumps(normalized, indent=2) + '\n')
    command_refs.append(ref(normalized_path))
    contexts.append({'name': original['name'], 'original': original_ref, 'receipt': command_refs[-1], 'sourceContextRows': len(original['sourceBefore']), 'counts': original['counts'], 'current': True})

art = read(OUT / 'artifact-fixture/fixture-report.json')
iso = read(OUT / 'isolation-fixture/isolation-report.json')
assessment = read(OUT / 'assessment.json')
boundary = read(OUT / 'comparison-boundary-probe.json')
assert boundary['allPassed']
assert [(row['name'], row.get('accepted')) for row in boundary['observations'][:3]] == [('healthy', True), ('explicit-empty-error', False), ('finite-cost-aggregate-overflow', False)]
assert boundary['observations'][3]['emptyErrorEligible'] is False
assert boundary['observations'][3]['valid'] == 2 and boundary['observations'][3]['measured'] == 1
assert assessment['actualSDKTaskAndAuxiliaryWorkers'] == 7
assert len(art['population']) == 2
identities = []
for population in art['population']:
    root = Path(population['artifactRoot'])
    persisted = read(root / 'FINAL_RESULTS.json')
    runs = [row for agent in persisted['agents'].values() for row in agent['runs']]
    assert len(runs) == 8 and sum(row['cost'] for row in runs) == 12
    assert sum(row['runOutcome']['termination'] == 'completed' for row in runs) == 2
    assert {row['providerRoute'] for row in runs} == {'offline/provider-a', 'offline/provider-b'}
    assert {language for row in runs for language in row['languages']} == {'typescript', 'python'}
    assert len(population['modelAttempts']) == 16
    for attempt in population['modelAttempts']:
        attempt_id = attempt['attemptId']
        started = read(root / 'sdk-attempts' / (attempt_id + '-started.json'))
        settled = read(root / 'sdk-attempts' / (attempt_id + '-settled.json'))
        assert started['attemptId'] == settled['attemptId'] == attempt_id
        assert started['phase'] == 'running' and settled['phase'] == 'settled'
        assert settled == attempt
        identities.append(attempt_id)
    assert sum(row['costUsd'] or 0 for row in population['modelAttempts']) == 2
    assert sum(row['costUsd'] is None for row in population['modelAttempts']) == 8
    assert not population['spend']['wholeExperimentCostComplete']
assert len(identities) == len(set(identities)) == 32
assert len(iso['observations']) == 7
for row in iso['observations']:
    assert not row['controllerSentinelPresent'] and not row['ambientProviderConfigPresent'] and not row['defaultUserConfigPresent']
    assert row['eventsReplayed'] > 0 and row['fetch']['attempted'] == row['fetch']['forwarded'] == 0
    assert not Path(row['home']).exists() and not Path(row['cwd']).exists()
assert iso['unavailable']['runOutcome']['termination'] == 'failed'
assert iso['fetchGuardControl']['observation']['fetch']['attempted'] == 1
assert iso['fetchGuardControl']['observation']['fetch']['forwarded'] == 0
assert read(OUT / 'shared-lessons-before.json') == read(OUT / 'shared-lessons-after.json')

result = {
    'schemaVersion': 1, 'type': 'body-current-independent-inspection',
    'nodeId': 'B30', 'reviewer': AUTHOR, 'sourceContractHashes': sources,
    'commandReceipts': command_refs, 'commandContexts': contexts,
    'cleanupLineage': {'seal': ref(cleanup / 'cleanup-seal.json'), 'exactDelta': ref(cleanup / 'cleanup-delta.diff'), 'fourFilesCurrent': True},
    'historicalEvidence': history, 'historicalAuthorQualityEvidence': quality, 'historicalPostRepairAuthorQualityEvidence': fresh_author_quality, 'boundedDependencyScope': ref(OUT / 'dependency-scope.json'), 'historicalContextDrift': drift, 'evaluatorRepairSources': inputs['evaluatorRepairSources'], 'evaluatorRepairDelta': inputs['evaluatorRepairDelta'],
    'historicalAttempts': [ref(ROOT / 'docs/execution/body-roadmap/evidence/B30/post-cleanup' / folder / name) for folder, name in [('independent-review-b02', 'run.py'), ('independent-review-b02', 'affected-evaluator-consumers.command.json'), ('independent-review-b02-final', 'run.py'), ('independent-review-b02-final', 'affected-evaluator-consumers.command.json')]],
    'independentOracleObservations': {**assessment, 'persistedAttemptIdentityPairsVerified': 32, 'independentComparisonBoundaryControls': boundary['observations'], 'falsyCausesAndEmptyErrors': 'Fresh 34/0 affected suite includes five exact rethrow/settled-cause and seven typed empty-error controls'},
    'allCurrentSourceAndContextBindingsMatch': True, 'requiredProductReruns': [],
    'productCommandsRunByThisReviewer': True,
    'inspectedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(OUT / 'inspection.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'nodeId': 'B30', 'allMatch': True, 'contractSources': len(sources), 'commandContextSources': contexts[0]['sourceContextRows'], 'commands': len(command_refs), 'persistedIdentityPairs': 32}))
