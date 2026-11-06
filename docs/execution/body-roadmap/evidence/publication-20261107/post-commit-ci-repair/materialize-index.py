#!/usr/bin/env python3
"""Verify the staged repaired checkout with the three approved baseline deltas."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

if not __debug__:
    raise RuntimeError('Refusing repaired-checkout verification with optimized Python.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
INVENTORY = BASE.parent / 'curated-required-files.json'
DELTA = BASE / 'required-path-delta.json'
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
EXPECTED_DELTA = '4450aed4a38b1630fe5715ddf6cb00785a5e718475dcb35c9a06c49e557fc30e'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def index():
    return subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=ROOT)


assert sha(INVENTORY) == EXPECTED_INVENTORY
assert sha(DELTA) == EXPECTED_DELTA
inventory = json.loads(INVENTORY.read_text())
delta = json.loads(DELTA.read_text())
expected = {entry['path']: {'sha256': entry['sha256'], 'bytes': entry['bytes']}
            for entry in inventory['files']}
assert len(expected) == 2644
assert {entry['path'] for entry in delta['changes']} == {
    'scripts/memory-drift-guard.ts', 'scripts/__tests__/memory-drift-guard.test.ts',
    'docs/execution/body-roadmap/ledger.json'}
for entry in delta['changes']:
    assert expected[entry['path']]['sha256'] == entry['previousSha256']
    expected[entry['path']] = {'sha256': entry['sha256'], 'bytes': entry['bytes']}

out = BASE / 'checkouts' / uuid.uuid4().hex[:12]
out.mkdir(parents=True)
destination = Path(tempfile.mkdtemp(prefix='openbuff-ci-repair-index-'))
before = index()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
tick = time.monotonic()
argv = ['git', 'checkout-index', '--all', '--prefix', str(destination) + '/']
subprocess.run(argv, cwd=ROOT, check=True, capture_output=True, timeout=60)
with (out / 'reviewed-index.nul').open('xb') as output:
    output.write(before)
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'PYTHONDONTWRITEBYTECODE': '1'}
commands = []


def run(name, relative):
    command = [sys.executable, '-B', str(destination / relative)]
    result = subprocess.run(command, cwd=destination, env=environment,
                            capture_output=True, timeout=60)
    logs = {}
    for label, payload in [('stdout', result.stdout), ('stderr', result.stderr)]:
        path = out / (name + '.' + label + '.log')
        with path.open('xb') as output:
            output.write(payload)
        logs[label] = {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}
    commands.append({'name': name, 'argv': command, 'exitCode': result.returncode, **logs})
    assert result.returncode == 0, result.stderr.decode() or result.stdout.decode()
    return json.loads(result.stdout)


restoration = run('base-restoration',
    'docs/execution/body-roadmap/evidence/publication-20261107/archive/rehydrate.py')
fixture = run('git-fixture-restoration',
    'docs/execution/body-roadmap/evidence/publication-20261107/git-fixture/rehydrate.py')
validation = run('ledger-validation', 'docs/execution/body-roadmap/validate-ledger.py')
assert restoration['restored'] == 186 and fixture['restored'] == 27
assert validation['valid'] and not validation['errors']
assert validation['accepted'] == ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36']
assert len(validation['remaining']) == 31
for name, entry in expected.items():
    path = destination / name
    assert path.stat().st_size == entry['bytes'] and sha(path) == entry['sha256'], name

object_format = subprocess.check_output(['git', 'rev-parse', '--show-object-format'],
                                        cwd=ROOT, text=True).strip()
entries = 0
for row in before.split(b'\0'):
    if not row:
        continue
    metadata, encoded_name = row.split(b'\t', 1)
    mode, object_id, stage = metadata.decode().split()
    assert stage == '0' and mode in {'100644', '100755', '120000'}
    path = destination / os.fsdecode(encoded_name)
    if mode == '120000':
        assert path.is_symlink()
        payload = os.fsencode(os.readlink(path))
    else:
        assert path.is_file() and not path.is_symlink()
        payload = path.read_bytes()
        assert bool(path.stat().st_mode & 0o111) == (mode == '100755')
    digest = hashlib.new(object_format)
    digest.update(b'blob ' + str(len(payload)).encode() + b'\0' + payload)
    assert digest.hexdigest() == object_id, str(path)
    entries += 1
assert before == index()
report = {
    'schemaVersion': 1, 'type': 'repaired-staged-source-materialization',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - tick,
    'destination': str(destination), 'checkoutArgv': argv,
    'stagedIndexSha256': hashlib.sha256(before).hexdigest(), 'stagedEntriesVerified': entries,
    'stagedIndexUnchangedDuringCheck': True,
    'historicalInventory': {'path': str(INVENTORY.relative_to(ROOT)), 'sha256': EXPECTED_INVENTORY},
    'requiredPathDelta': {'path': str(DELTA.relative_to(ROOT)), 'sha256': EXPECTED_DELTA},
    'unchangedHistoricalRequiredPaths': 2641, 'approvedChangedRequiredPaths': 3,
    'requiredFileHashesVerifiedAgainstInventoryAndDelta': len(expected),
    'restoration': restoration, 'gitFixtureRestoration': fixture, 'validation': validation,
    'materializedLedgerSha256': sha(destination / 'docs/execution/body-roadmap/ledger.json'),
    'commands': commands, 'passed': True,
    'scope': 'Exact staged byte/mode availability and frozen validator consistency after the approved guard/typecheck repair. Original inventory remains historical; no product/provider replay or further card acceptance.',
}
with (out / 'report.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'stagedEntries': entries, 'requiredPaths': len(expected),
                  'baselineDeltas': 3, 'accepted': 8, 'remaining': 31,
                  'destination': str(destination), 'report': str((out / 'report.json').relative_to(ROOT))}))
