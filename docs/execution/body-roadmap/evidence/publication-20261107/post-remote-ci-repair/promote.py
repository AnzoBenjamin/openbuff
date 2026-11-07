#!/usr/bin/env python3
"""Promote the exact independently approved CI-repair ledger candidate."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

if not __debug__:
    raise RuntimeError('Refusing CI-repair promotion with optimized Python.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
CANDIDATE = BASE / 'acceptance/candidate-ledger.json'
LIVE = ROOT / 'docs/execution/body-roadmap/ledger.json'
REVIEW = BASE / 'acceptance-independent-review/review.json'
MANIFEST = BASE / 'acceptance-independent-review/manifest.json'
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
EXPECTED_OLD = '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
EXPECTED_NEW = 'fe0e337cb0675613310f1b86dd58d823f187e0672b0ea5b8a4a8060121f7e83c'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


assert sha(LIVE) == EXPECTED_OLD and sha(CANDIDATE) == EXPECTED_NEW
assert sha(REVIEW) == 'b9e91c9c566bc46f227c68260433afb7f69eae7a4c16e41cb0f2239ac6471c98'
assert sha(MANIFEST) == '5d1706fe76b9cb5c9ef18f3cbbdf6d2a82111645db8a9ae2c154dda8d144e48f'
assert sha(VALIDATOR) == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
manifest = json.loads(MANIFEST.read_text())
assert manifest['files']
for entry in manifest['files']:
    assert sha(ROOT / entry['path']) == entry['sha256']
approval = json.loads(REVIEW.read_text())
assert approval['decision'] == 'approve-exact-candidate-for-byte-preserving-promotion'
assert approval['candidateSha256'] == EXPECTED_NEW
assert approval['previousLiveSha256'] == EXPECTED_OLD
assert [entry['nodeId'] for entry in approval['changedNodes']] == ['B01', 'B36']
assert all(entry['implementationContractsUnchanged'] and entry['behaviorEvidenceUnchanged']
           for entry in approval['changedNodes'])
assert approval['other37NodesIdentical']
assert (BASE / 'acceptance/previous-ledger.json').read_bytes() == LIVE.read_bytes()

descriptor, temporary = tempfile.mkstemp(prefix='.approved-ci-repair-', dir=LIVE.parent)
with os.fdopen(descriptor, 'wb') as output:
    output.write(CANDIDATE.read_bytes())
    output.flush()
    os.fsync(output.fileno())
os.chmod(temporary, LIVE.stat().st_mode & 0o777)
assert sha(LIVE) == EXPECTED_OLD
os.replace(temporary, LIVE)
assert LIVE.read_bytes() == CANDIDATE.read_bytes()

started = datetime.datetime.now(datetime.timezone.utc).isoformat()
tick = time.monotonic()
argv = [sys.executable, '-B', str(VALIDATOR)]
result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=60)
for name, payload in [('promotion-validation.stdout.log', result.stdout),
                      ('promotion-validation.stderr.log', result.stderr)]:
    with (BASE / name).open('xb') as output:
        output.write(payload)
validation = json.loads(result.stdout)
assert result.returncode == 0 and validation['valid'] and not validation['errors']
assert len(validation['accepted']) == 8 and len(validation['remaining']) == 31
report = {
    'schemaVersion': 1, 'type': 'approved-ci-repair-ledger-promotion',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - tick,
    'previousLedger': ref(BASE / 'acceptance/previous-ledger.json'),
    'candidate': ref(CANDIDATE), 'liveLedger': ref(LIVE), 'approval': ref(MANIFEST),
    'promoter': ref(Path(__file__)), 'validation': validation, 'argv': argv,
    'candidatePromotedByteForByte': True,
    'scope': 'Renew only the two stale shared-typecheck credits after the reviewed documentation guard repair; no additional implementation or completion-node acceptance.',
}
with (BASE / 'promotion.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'valid': True, 'changedNodes': ['B01', 'B36'],
                  'liveLedgerSha256': sha(LIVE), 'accepted': 8, 'remaining': 31}))

