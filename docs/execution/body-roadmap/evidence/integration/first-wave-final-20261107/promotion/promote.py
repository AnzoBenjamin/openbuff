#!/usr/bin/env python3
"""Promote the independently approved candidate without altering its bytes."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

OUT = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[7]
BASE = ROOT / 'docs/execution/body-roadmap'
CANDIDATE = OUT.parent / 'acceptance/candidate-ledger.json'
LIVE = BASE / 'ledger.json'
EXPECTED = '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
OLD = '3329b89e270b32354771de7c7d0c31f6cd7e0aceed8397f891316c793104bd76'
ARCH = BASE / 'evidence/integration/architect-first-wave/final-integration/review.json'
RWEB = BASE / 'evidence/RWEB/planning-review/review.json'
VALIDATOR = BASE / 'validate-ledger.py'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


assert sha(CANDIDATE) == EXPECTED and sha(LIVE) == OLD
assert sha(ARCH) == 'e8585047cef48e8ec217c7ad7dcbc96eba0172b6e4bd5a2900a00b59a4f6a841'
assert sha(RWEB) == '424f5fe0d7ce44ee5ff14d077dbe4ad6829977c8f5dd7504b0c33b987da32f0c'
assert sha(VALIDATOR) == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
architecture = json.loads(ARCH.read_text())
assert architecture['decision'] == 'approve' and architecture['independent'] is True
assert architecture['candidate'] == ref(CANDIDATE)
assert architecture['wholePlanComplete'] is False and not architecture['blockingFindings']
research_plan = json.loads(RWEB.read_text())
assert research_plan['decision'] == 'approve'
assert research_plan['implementationAccepted'] is False
assert not research_plan['blockingFindings']

previous = OUT / 'ledger-before.json'
with previous.open('xb') as handle:
    handle.write(LIVE.read_bytes())
assert sha(previous) == OLD
descriptor, temporary = tempfile.mkstemp(prefix='.approved-ledger-', dir=BASE)
with os.fdopen(descriptor, 'wb') as handle:
    handle.write(CANDIDATE.read_bytes())
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, LIVE.stat().st_mode & 0o777)
assert sha(LIVE) == OLD
os.replace(temporary, LIVE)
assert sha(LIVE) == sha(CANDIDATE) == EXPECTED

argv = [sys.executable, str(VALIDATOR), '--ledger', str(LIVE)]
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=60)
for name, data in [('validation.stdout.log', result.stdout),
                   ('validation.stderr.log', result.stderr)]:
    with (OUT / name).open('xb') as handle:
        handle.write(data)
assert result.returncode == 0
validation = json.loads(result.stdout)
assert validation['valid'] is True and validation['errors'] == []
assert validation['accepted'] == architecture['acceptedCards']
assert len(validation['remaining']) == 31
with (OUT / 'live-ledger.validation.json').open('x') as handle:
    json.dump(validation, handle, indent=2)
    handle.write('\n')
receipt = {
    'schemaVersion': 1,
    'type': 'body-first-wave-approved-ledger-promotion',
    'promotedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'candidate': ref(CANDIDATE), 'liveLedger': ref(LIVE),
    'previousLedger': ref(previous), 'architectureApproval': ref(ARCH),
    'researcherPlanningApproval': ref(RWEB), 'validator': ref(VALIDATOR),
    'byteForByteCandidatePromotion': True,
    'acceptedCards': validation['accepted'],
    'remainingCompletionNodes': len(validation['remaining']),
    'validation': {'argv': argv, 'cwd': str(ROOT), 'startedAt': started,
                   'elapsedSeconds': time.monotonic() - start,
                   'exitCode': result.returncode,
                   'stdout': ref(OUT / 'validation.stdout.log'),
                   'stderr': ref(OUT / 'validation.stderr.log'),
                   'report': ref(OUT / 'live-ledger.validation.json')},
    'scope': 'Promoted exactly eight independently reviewed cards at their stated coverage tiers; no whole-plan, native or researcher implementation completion.',
}
with (OUT / 'promotion.json').open('x') as handle:
    json.dump(receipt, handle, indent=2)
    handle.write('\n')
print(json.dumps({'promoted': True, 'sha256': EXPECTED,
                  'accepted': validation['accepted'], 'remaining': 31}))
