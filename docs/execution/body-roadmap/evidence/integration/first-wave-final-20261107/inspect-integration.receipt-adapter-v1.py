#!/usr/bin/env python3
"""Bind existing final verification without rerunning or rewriting its history."""

import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
BASE = ROOT / 'docs/execution/body-roadmap'
OUT = Path(__file__).resolve().parent
artifacts = {}


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def ref(path, expected=None):
    path = Path(path)
    absolute = path if path.is_absolute() else ROOT / path
    digest = sha(absolute)
    assert expected is None or digest == expected, ('hash mismatch', str(path))
    name = str(absolute.relative_to(ROOT))
    artifacts[name] = digest
    return {'path': name, 'sha256': digest}


def load(path):
    ref(path)
    return json.loads((ROOT / path).read_text())


def check_receipt(path, current_required):
    doc = load(path)
    assert doc['exitCode'] == 0, ('failed command', path)
    log = doc['log']
    log_path = log['path'] if isinstance(log, dict) else log
    log_hash = log.get('sha256') if isinstance(log, dict) else doc['logSha256']
    log_ref = ref(log_path, log_hash)
    after = doc['sourceAfter']
    drift = [name for name, digest in after.items()
             if not (ROOT / name).is_file() or sha(ROOT / name) != digest]
    if current_required:
        assert doc['sourceBefore'] == after
        assert doc['sourceUnchangedDuringCommand'] is True
        assert not drift, ('current input drift', path, drift)
    return {
        'receipt': ref(path),
        'exitCode': doc['exitCode'],
        'counts': doc.get('counts'),
        'log': log_ref,
        'inputCount': len(after),
        'sourceUnchangedDuringCommand': doc['sourceUnchangedDuringCommand'],
        'currentInputsRequired': current_required,
        'currentInputDrift': drift,
        'freshProductInvocation': False,
    }


candidate_path = str(OUT.relative_to(ROOT) / 'acceptance/candidate-ledger.json')
candidate_ref = ref(candidate_path,
    '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758')
candidate = load(candidate_path)
accepted = [node for node in candidate['nodes'] if node['status'] == 'accepted']
assert [node['nodeId'] for node in accepted] == [
    'B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36',
]
assert len(candidate['nodes']) == 39
contracts = {}
for node in accepted:
    for name, digest in node['sourceContractHashes'].items():
        ref(name, digest)
        assert name not in contracts or contracts[name] == digest
        contracts[name] = digest
assert len(contracts) == 246

prefix = str(OUT.relative_to(ROOT))
checks = [check_receipt(f'{prefix}/{path}', True) for path in [
    'post-build/typecheck.json',
    'post-build/agents-suite.json',
    'post-build-cli-outside/cli-tests.json',
    *[f'post-build/guard-{name}.json' for name in [
        'memory-drift', 'sync-agent-config', 'determinism', 'mock-module',
        'project-root', 'byok-wording', 'dependency-provenance', 'types-declaration',
    ]],
]]
build = check_receipt(f'{prefix}/build-retry/cli-build.json', False)
assert not build['currentInputDrift']
sdk = check_receipt(
    'docs/execution/body-roadmap/evidence/integration/3d-commit-ci-regression/sdk-ci-repaired-outside.json', False,
)
assert sdk['counts'] == {'pass': 2613, 'fail': 0}
assert len(sdk['currentInputDrift']) == 6

installation = load(f'{prefix}/post-build/installation.json')
binary = Path(installation['binary'])
binary_hash = sha(binary)
assert binary_hash == '5597a243d8676c345ba7cece90565705adb2a384d621436482084937a42d6241'
assert len(installation['files']) == 33
for item in installation['files']:
    assert sha(Path(item['target'])) == item['installedSha256']
smoke = load(f'{prefix}/post-build/installed-smoke.json')
assert smoke['passed'] is True and smoke['binarySha256'] == binary_hash
assert len(smoke['checks']) == 5
for item in smoke['checks']:
    assert item['exitCode'] == 0 and item['markerPresent'] and item['binaryUnchanged']
    assert item['binarySha256'] == binary_hash
    ref(item['log'], item['logSha256'])

for path in [
    'acceptance/inputs.json', 'INTEGRATION.md', 'inspect-integration.py',
    'inspect-integration.initial.py', 'integration-inspector-initial-failure.json',
    'candidate-independent-review-b04/review.json',
    'candidate-independent-review-b04/REVIEW.md',
    'candidate-independent-review-b04/manifest.json',
    'acceptance/candidate-ledger.validation.json',
]:
    ref(f'{prefix}/{path}')
ref('docs/execution/body-roadmap/validate-ledger.py',
    '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c')

manifest = {
    'schemaVersion': 1,
    'type': 'body-first-wave-integration-evidence',
    'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'candidate': candidate_ref,
    'acceptedCards': [node['nodeId'] for node in accepted],
    'remainingCompletionNodes': len(candidate['nodes']) - len(accepted),
    'distinctCurrentSourceContracts': len(contracts),
    'checks': checks,
    'build': build,
    'sdkHistoricalContext': sdk,
    'installedBinary': {'path': str(binary), 'sha256': binary_hash},
    'installedAssetCount': len(installation['files']),
    'installedChecks': [item['name'] for item in smoke['checks']],
    'artifacts': [{'path': name, 'sha256': digest}
                  for name, digest in sorted(artifacts.items())],
    'scope': 'Existing declared source/CLI evidence inspected; final architecture review and live-ledger promotion are separate steps. No future card, native enforcement or researcher implementation credit.',
}
with (OUT / 'integration-manifest.json').open('x') as handle:
    json.dump(manifest, handle, indent=2)
    handle.write('\n')
print(json.dumps({'verified': True, 'accepted': len(accepted),
                  'checks': len(checks), 'sdkHistoricalDriftPaths': sdk['currentInputDrift']}))
