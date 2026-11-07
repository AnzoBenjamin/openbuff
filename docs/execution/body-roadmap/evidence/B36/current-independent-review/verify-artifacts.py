#!/usr/bin/env python3
"""Verify current B36 evidence while preserving original independent authorship."""
import datetime
import difflib
import hashlib
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]
BASE = HERE.parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


prior_path = BASE / 'independent-review/manifest-check.json'
prior = read(prior_path)
assert prior['reviewer'] == '/root/b03_mutation_evidence'
assert sha(BASE / 'manifest.json') == prior['producerManifestHash']
prior_checks = []
for entry in prior['independentArtifacts']:
    path = BASE / 'independent-review' / entry['file']
    assert sha(path) == entry['sha256'], str(path)
    prior_checks.append({'path': str(path.relative_to(ROOT)), 'sha256': sha(path)})
for entry in prior['producerArtifactChecks']:
    path = BASE / entry['file']
    assert sha(path) == entry['expected'], str(path)
    prior_checks.append({'path': str(path.relative_to(ROOT)), 'sha256': sha(path)})

refresh_path = BASE / 'final-binding/manifest.json'
refresh = read(refresh_path)
for name, digest in refresh['artifacts'].items():
    assert sha(refresh_path.parent / name) == digest, name

b02_path = BASE.parent / 'B02/final-binding/manifest.json'
b02 = read(b02_path)
for name, digest in b02['artifacts'].items():
    assert sha(b02_path.parent / name) == digest, name
for name, digest in b02['sourceHashes'].items():
    assert sha(ROOT / name) == digest, name

sources = {}
commands = []
for name in ['integration-tests', 'fixture', 'sdk-typecheck']:
    receipt_path = HERE / (name + '.json')
    receipt = read(receipt_path)
    assert receipt['exit'] == 0, name
    assert receipt['sourceUnchangedDuringCommand'], name
    assert receipt['sourceBefore'] == receipt['sourceAfter'], name
    assert '--no-env-file' in receipt['argv'], name
    assert receipt['environment']['replacement'], name
    assert not receipt['environment']['bunEnvFileLoading'], name
    assert receipt['bun']['version'] == '1.3.5', name
    assert receipt['bun']['sha256'] == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
    assert sha(pathlib.Path(receipt['bun']['path'])) == receipt['bun']['sha256']
    assert sha(HERE / receipt['log']) == receipt['logSha256'], name
    assert (HERE / (name + '.exit')).read_text().strip() == '0', name
    for file, digest in receipt['sourceAfter'].items():
        assert sha(ROOT / file) == digest, file
        sources[file] = digest
    commands.append({'receipt': name + '.json', 'sha256': sha(receipt_path)})

delta = [
    {'path': entry['file'], 'previous': entry['actual'], 'current': sources[entry['file']]}
    for entry in prior['sourceChecks']
    if sources[entry['file']] != entry['actual']
]
assert [entry['path'] for entry in delta] == ['sdk/src/run.ts']
assert sources == refresh['sourceHashes']
assert sources['sdk/src/run.ts'] == b02['sourceHashes']['sdk/src/run.ts']
old_sdk_hash = next(entry['actual'] for entry in prior['sourceChecks'] if entry['file'] == 'sdk/src/run.ts')
assert sha(HERE / 'prior-reviewed-run.ts') == old_sdk_hash
expected_diff = ''.join(difflib.unified_diff(
    (HERE / 'prior-reviewed-run.ts').read_text().splitlines(keepends=True),
    (ROOT / 'sdk/src/run.ts').read_text().splitlines(keepends=True),
    fromfile='prior-independently-reviewed/sdk/src/run.ts',
    tofile='current/sdk/src/run.ts',
))
assert (HERE / 'shared-integration-delta.diff').read_text() == expected_diff

test_log = (HERE / 'integration-tests.log').read_text()
counts = re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail\n\s+(\d+) expect\(\) calls', test_log)
assert counts and tuple(map(int, counts.groups())) == (22, 0, 143)
assert '$ tsc --noEmit -p .' in (HERE / 'sdk-typecheck.log').read_text()
expected = {
    'empty': ('passed', 'passed'),
    'preexisting': ('passed', 'passed'),
    'shifted': ('passed', 'passed'),
    'severity-escalation': ('new_errors', 'failed'),
    'timeout': ('failed', 'failed'),
    'exit127': ('unavailable', 'unknown'),
    'cancelled': ('cancelled', 'failed'),
    'missing-tool': ('unavailable', 'unknown'),
    'missing-language': ('unavailable', 'unknown'),
    'capped': ('incomplete', 'unknown'),
    'partial': ('unknown', 'unknown'),
    'unknown': ('unknown', 'unknown'),
}
records = read(HERE / 'sdk-client-observations.json')['records']
assert len(records) == len(expected) == 12
assert {row['name'] for row in records} == set(expected)
observations = []
for row in records:
    status, classification = expected[row['name']]
    assert row['expectedStatus'] == status, row['name']
    diagnostic = next(value for value in row['sdkOutput'][0]['value'] if value.get('hookName') == 'diagnostic-delta')
    assert diagnostic['diagnosticStatus'] == status, row['name']
    assert row['clientClassification'] == classification, row['name']
    observations.append({'name': row['name'], 'sdkDiagnosticStatus': status, 'cliClassification': classification, 'launches': row['launches']})

manifest = {
    'schemaVersion': 1,
    'card': 'B36',
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'reviewer': '/root/b04_lock_cas',
    'status': 'prior_independent_diagnostic_approval_preserved_current_integration_reattested',
    'recommendation': 'preserve_declared_diagnostic_truth_tier_with_current_shared_integration_binding',
    'independence': {
        'originalImplementationAuthoredByCurrentReviewer': True,
        'currentSharedDeltaAuthoredByCurrentReviewer': False,
        'newFullCardIndependentApproval': False,
        'originalIndependentReviewer': prior['reviewer'],
        'basis': 'Original independent B36 diagnostic review plus independent B02 shared-source seal; current author-affiliated integration reruns are separately disclosed.',
        'fullIndependentCountersignatureRequiredIfGateDemandsIt': True,
    },
    'cardAcceptance': 'leader_owned',
    'originalIndependentReview': {'path': str(prior_path.relative_to(ROOT)), 'sha256': sha(prior_path), 'decision': prior['independentDecision']},
    'previousAuthorRefresh': {'path': str(refresh_path.relative_to(ROOT)), 'sha256': sha(refresh_path)},
    'currentB02IndependentSeal': {'path': str(b02_path.relative_to(ROOT)), 'sha256': sha(b02_path), 'recommendation': b02['recommendation'], 'sdkRunSha256': b02['sourceHashes']['sdk/src/run.ts']},
    'sourceDelta': delta,
    'sourceHashes': sources,
    'unchangedReviewedSourceCount': 14,
    'freshTests': {'passed': 22, 'failed': 0, 'assertions': 143},
    'realChildCases': 12,
    'fixtureCases': observations,
    'sdkTypecheckExit': 0,
    'noProviderRequests': 'Fixed local diagnostic child fixture and replacement empty-provider command environment; no provider workload executed.',
    'commands': commands,
    'priorArtifactChecks': prior_checks,
    'scope': prior['scope'],
    'historicalCountsNotRerun': {'tests': 188, 'postimageControls': 10},
    'artifacts': {str(path.relative_to(HERE)): sha(path) for path in sorted(HERE.rglob('*')) if path.is_file() and path.name != 'manifest.json'},
}
(HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sources': len(sources), 'changed': [row['path'] for row in delta], 'tests': manifest['freshTests'], 'realChildCases': 12, 'sdkTypecheckExit': 0, 'newFullCardIndependentApproval': False, 'recommendation': manifest['recommendation']}))
