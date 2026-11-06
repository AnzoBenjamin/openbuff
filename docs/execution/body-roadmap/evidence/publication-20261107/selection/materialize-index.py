#!/usr/bin/env python3
"""Check the exact staged source/evidence tree after archive restoration."""

import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

if not __debug__:
    raise RuntimeError('Refusing staged-source verification with optimized Python.')

ROOT = Path(__file__).resolve().parents[6]
BASE = Path(__file__).resolve().parent
OUT = BASE / 'checkouts' / uuid.uuid4().hex[:12]
OUT.mkdir(parents=True)
destination = Path(tempfile.mkdtemp(prefix='openbuff-first-wave-index-'))


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def index():
    return subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=ROOT,
                          capture_output=True, check=True).stdout


before = index()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
checkout_argv = ['git', 'checkout-index', '--all', '--prefix', str(destination) + '/']
checkout = subprocess.run(checkout_argv, cwd=ROOT, capture_output=True, timeout=60)
assert checkout.returncode == 0, checkout.stderr.decode()
environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'PYTHONDONTWRITEBYTECODE': '1'}
commands = []


def run(name, argv):
    tick = time.monotonic()
    result = subprocess.run(argv, cwd=destination, env=environment,
                            capture_output=True, timeout=60)
    for label, value in [('stdout', result.stdout), ('stderr', result.stderr)]:
        with (OUT / f'{name}.{label}.log').open('xb') as output:
            output.write(value)
    commands.append({'name': name, 'argv': argv, 'cwd': str(destination),
                     'elapsedSeconds': time.monotonic() - tick, 'exitCode': result.returncode,
                     'stdout': {'path': str((OUT / f'{name}.stdout.log').relative_to(ROOT)),
                                'sha256': sha(OUT / f'{name}.stdout.log')},
                     'stderr': {'path': str((OUT / f'{name}.stderr.log').relative_to(ROOT)),
                                'sha256': sha(OUT / f'{name}.stderr.log')}})
    assert result.returncode == 0, result.stderr.decode() or result.stdout.decode()
    return json.loads(result.stdout)


restoration = run('restoration', [sys.executable, str(destination /
    'docs/execution/body-roadmap/evidence/publication-20261107/archive/rehydrate.py')])
assert restoration['restored'] == 186
git_fixture_restoration = run('git-fixture-restoration', [sys.executable, str(destination /
    'docs/execution/body-roadmap/evidence/publication-20261107/git-fixture/rehydrate.py')])
assert git_fixture_restoration['restored'] == 27
validation = run('ledger-validation', [sys.executable, str(destination /
    'docs/execution/body-roadmap/validate-ledger.py')])
assert validation['valid'] and validation['errors'] == []
assert len(validation['accepted']) == 8 and len(validation['remaining']) == 31
inventory = json.loads((ROOT / 'docs/execution/body-roadmap/evidence/'
                       'publication-20261107/curated-required-files.json').read_text())
for entry in inventory['files']:
    assert sha(destination / entry['path']) == entry['sha256'], entry['path']
after = index()
assert before == after
report = {
    'schemaVersion': 1, 'type': 'staged-first-wave-source-materialization',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
    'destination': str(destination), 'checkoutArgv': checkout_argv,
    'stagedIndexSha256': hashlib.sha256(before).hexdigest(),
    'stagedIndexUnchangedDuringCheck': True,
    'restoration': restoration, 'gitFixtureRestoration': git_fixture_restoration,
    'validation': validation,
    'requiredFileHashesVerified': len(inventory['files']),
    'commands': commands,
    'originalLedgerSha256': sha(ROOT / 'docs/execution/body-roadmap/ledger.json'),
    'materializedLedgerSha256': sha(destination / 'docs/execution/body-roadmap/ledger.json'),
    'passed': True,
    'scope': 'Exact staged-source/evidence availability and frozen ledger consistency after restoration; no product/provider/installed-binary replay or future-card acceptance.',
}
with (OUT / 'report.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'requiredFiles': len(inventory['files']),
                  'accepted': 8, 'remaining': 31, 'destination': str(destination),
                  'report': str((OUT / 'report.json').relative_to(ROOT))}))
