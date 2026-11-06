"""Read-only final architecture evidence verification, scoped to eight cards."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[7]
OUT = Path(__file__).resolve().parent
BASE = ROOT / 'docs/execution/body-roadmap/evidence/integration/first-wave-final-20261107'
CANDIDATE = BASE / 'acceptance/candidate-ledger.json'
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
EXPECTED = ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36']

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def read(path):
    return json.loads(Path(path).read_text())

def refs(value):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str) and isinstance(value.get('sha256'), str):
            yield value
        for child in value.values():
            yield from refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from refs(child)

verified = {}
def verify(path, expected):
    full = ROOT / path
    actual = sha(full)
    assert actual == expected, f'Changed binding: {path}'
    verified[str(path)] = actual

def verify_refs(data):
    for reference in refs(data):
        verify(reference['path'], reference['sha256'])

def verify_map(mapping):
    for path, expected in mapping.items():
        verify(path, expected)

assert sha(CANDIDATE) == '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
assert sha(VALIDATOR) == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
protected_paths = [CANDIDATE, VALIDATOR, ROOT / 'docs/execution/body-roadmap/ledger.json',
    ROOT / '.agents/sessions/body-capability-review-2026-11-05/PLAN.md',
    ROOT / '.agents/sessions/body-capability-review-2026-11-05/SPEC.md',
    OUT.parent / 'PROVISIONAL.md', OUT.parent / 'post-comparator-repair/REVIEW.md',
    OUT.parent / 'post-comparator-repair/review.json']
protected = {str(path.relative_to(ROOT)): sha(path) for path in protected_paths}
started = datetime.now(timezone.utc).isoformat()
candidate = read(CANDIDATE)
accepted = sorted(node['nodeId'] for node in candidate['nodes'] if node['status'] == 'accepted')
pending = [node for node in candidate['nodes'] if node['status'] == 'pending']
assert accepted == EXPECTED and len(pending) == 31 and len(candidate['nodes']) == 39
live_nodes = {node['nodeId']: node for node in read(ROOT / 'docs/execution/body-roadmap/ledger.json')['nodes']}
assert all(node == live_nodes[node['nodeId']] for node in pending)
inputs = read(BASE / 'acceptance/inputs.json')
assert sorted(item['nodeId'] for item in inputs) == EXPECTED
review_counts = []
command_count = 0
for item in inputs:
    node = next(node for node in candidate['nodes'] if node['nodeId'] == item['nodeId'])
    verify_map(node['sourceContractHashes'])
    verify_refs(node)
    selections = node['verification']['independentReviews']
    assert [entry['evidence']['path'] for entry in selections] == item['reviews']
    for path in item['reviews']:
        review = read(ROOT / path)
        assert review['nodeId'] == item['nodeId'] and review['decision'] == 'approve'
        assert review['reviewer'] not in review['implementationOwners']
        verify_refs(review)
        verify_map(review['sourceContractHashes'])
        original = read(ROOT / review['provenance']['path'])
        for key in ['nodeId', 'reviewer', 'implementationOwners', 'scope', 'decision', 'sourceContractHashes', 'commandReceipts']:
            assert review[key] == original[key], f'Original review authority differs: {path}, {key}'
        for ref in review['commandReceipts']:
            command = read(ROOT / ref['path'])
            assert command['exitCode'] == 0
            assert command['sourceBefore'] == command['sourceAfter']
            verify_map(command['sourceAfter'])
            verify_refs(command)
            command_count += 1
    review_counts.append({'nodeId': item['nodeId'], 'reviews': len(item['reviews']),
                         'sourceBindings': len(node['sourceContractHashes']),
                         'commandCredits': node['verification']['requiredCommandCount']})

prior = BASE / 'candidate-independent-review-b04'
verify_refs(read(prior / 'manifest.json'))
verify_map(read(prior / 'inspection.json')['activeEvidenceHashes'])
assert command_count == 54

argv = ['python3', '-B', str(VALIDATOR.relative_to(ROOT)), '--ledger', str(CANDIDATE.relative_to(ROOT))]
result = subprocess.run(argv, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
(OUT / 'validator.stdout.json').write_text(result.stdout)
(OUT / 'validator.stderr.log').write_text(result.stderr)
verdict = json.loads(result.stdout)
assert result.returncode == 0 and verdict['valid'] and verdict['accepted'] == EXPECTED
assert len(verdict['remaining']) == 31 and not verdict['errors']

checks = []
for relative in ['post-build/typecheck.json', 'post-build/agents-suite.json',
                 'post-build-cli-outside/cli-tests.json'] + [
                 f'post-build/guard-{name}.json' for name in ['byok-wording', 'dependency-provenance',
                 'determinism', 'memory-drift', 'mock-module', 'project-root', 'sync-agent-config', 'types-declaration']]:
    path = BASE / relative
    data = read(path)
    assert data['exitCode'] == 0 and data['sourceBefore'] == data['sourceAfter']
    verify_map(data['sourceAfter'])
    verify(data['log'], data['logSha256'])
    log = (ROOT / data['log']).read_text()
    row = {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'exitCode': 0,
           'sourceCount': len(data['sourceAfter']), 'sourceStableAndCurrent': True, 'counts': data.get('counts')}
    if relative.endswith('typecheck.json'):
        codes = re.findall(r'Exited with code (\d+)', log)
        assert codes == ['0'] * 11, codes
        row['workspaceExitCodes'] = codes
    if relative.endswith('cli-tests.json'):
        assert re.search(r'4436 pass', log) and re.search(r'146 skip', log) and re.search(r'0 fail', log)
        row['observedCounts'] = {'pass': 4436, 'skip': 146, 'fail': 0}
    checks.append(row)

build = read(BASE / 'build-retry/cli-build.json')
assert build['exitCode'] == 0 and build['sourceUnchangedDuringCommand'] is False
verify_map(build['sourceAfter'])
verify(build['log'], build['logSha256'])
binary = Path('/home/ben/.local/share/openbuff-test/openbuff-branch')
assert sha(binary) == '5597a243d8676c345ba7cece90565705adb2a384d621436482084937a42d6241'
installed = []
for name in ['help', 'version', 'run-help', 'opentui', 'tree-sitter']:
    path = BASE / f'post-build/installed-{name}.json'
    data = read(path)
    assert data['argv'][0] == str(binary) and data['exitCode'] == 0 and data['binaryUnchanged']
    assert data['binarySha256'] == sha(binary)
    verify(data['log'], data['logSha256'])
    log = Path(data['log']).read_text()
    assert data['expectedMarker'] in log
    assert not re.search(r'(?im)^.*(?:panic:|fatal error|segmentation fault|undefined symbol).*$', log)
    installed.append({'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'name': name,
                      'argv': data['argv'], 'cwd': data['cwd'], 'exitCode': 0, 'markerVerified': True})

sdkpath = ROOT / 'docs/execution/body-roadmap/evidence/integration/3d-commit-ci-regression/sdk-ci-repaired-outside.json'
sdk = read(sdkpath)
verify_refs(read(sdkpath.parent / 'manifest.json'))
assert sdk['exitCode'] == 0 and sdk['sourceBefore'] == sdk['sourceAfter']
sdk_drift = [name for name, expected in sdk['sourceAfter'].items() if not (ROOT / name).is_file() or sha(ROOT / name) != expected]
for path, digest in protected.items():
    verify(path, digest)
report = {'schemaVersion': 1, 'type': 'independent-final-architecture-evidence-inspection',
          'reviewer': '/root/first_wave_architect', 'startedAt': started,
          'finishedAt': datetime.now(timezone.utc).isoformat(),
          'candidate': {'path': str(CANDIDATE.relative_to(ROOT)), 'sha256': sha(CANDIDATE)},
          'validator': {'path': str(VALIDATOR.relative_to(ROOT)), 'sha256': sha(VALIDATOR),
                        'argv': argv, 'exitCode': result.returncode, 'valid': verdict['valid']},
          'accepted': accepted, 'pendingCount': len(pending), 'reviewCounts': review_counts,
          'commandCredits': command_count, 'currentBindingsVerified': len(verified),
          'checks': checks, 'build': {'path': str((BASE / 'build-retry/cli-build.json').relative_to(ROOT)),
           'exitCode': 0, 'sourceUnchangedDuringCommand': False, 'postimageCurrent': True},
          'installed': {'binary': str(binary), 'sha256': sha(binary), 'probes': installed},
          'sdkHistoricalContext': {'path': str(sdkpath.relative_to(ROOT)), 'sha256': sha(sdkpath),
            'counts': sdk['counts'], 'sourceStableDuringOriginalRun': True, 'currentMapDrift': sdk_drift,
            'credit': 'Historical broad regression context; selected card commands are current and separately verified'},
          'protectedFilesUnchanged': protected, 'currentBindingHashes': verified,
          'productCommandsRerun': False}
with (OUT / 'inspection.json').open('x') as handle:
    json.dump(report, handle, indent=2)
    handle.write('\n')
print(json.dumps({key: value for key, value in report.items() if key not in ['currentBindingHashes', 'protectedFilesUnchanged']}, indent=2))
