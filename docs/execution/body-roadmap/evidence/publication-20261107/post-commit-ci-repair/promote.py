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
EXPECTED_OLD = '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
EXPECTED_NEW = '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


assert sha(LIVE) == EXPECTED_OLD and sha(CANDIDATE) == EXPECTED_NEW
assert sha(REVIEW) == '9768f0726c1c5f36f922b337d7d08beb12970d95cc04b0c0f45b06e42b733649'
assert sha(MANIFEST) == '3bf4729d1976ee85ceae40f4f4ef169d14da9a2431f498e04de6e42f9f90e25b'
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
    'initialCheckRefusal': 'An earlier inline check treated changedNodes as names rather than objects and stopped before writing; the original live ledger remained unchanged.',
    'scope': 'Renew only the two stale shared-typecheck credits after the reviewed documentation guard repair; no additional implementation or completion-node acceptance.',
}
with (BASE / 'promotion.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'valid': True, 'changedNodes': ['B01', 'B36'],
                  'liveLedgerSha256': sha(LIVE), 'accepted': 8, 'remaining': 31}))
