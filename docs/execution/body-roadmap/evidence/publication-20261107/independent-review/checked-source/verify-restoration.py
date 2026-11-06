#!/usr/bin/env python3
"""Replay byte restoration and verify refusals leave existing data untouched."""

import datetime
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import time

if not __debug__:
    raise RuntimeError('Refusing verification controls with optimized Python; remove -O or PYTHONOPTIMIZE.')

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
module_path = BASE / 'rehydrate.py'
spec = importlib.util.spec_from_file_location('evidence_rehydrator', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = json.loads((BASE / 'archive-manifest.checked.json').read_text())
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
scratch = Path(tempfile.mkdtemp(prefix='openbuff-evidence-restore-'))
results = []


def refusal(name, destination, manifest_path=None):
    before = sorted(str(path.relative_to(destination)) for path in destination.rglob('*'))
    try:
        module.restore(destination, manifest_path or BASE / 'archive-manifest.checked.json')
    except (AssertionError, ValueError) as error:
        after = sorted(str(path.relative_to(destination)) for path in destination.rglob('*'))
        assert before == after
        results.append({'name': name, 'rejected': True, 'reason': str(error),
                        'pathsUnchanged': True})
    else:
        raise AssertionError(('unexpected restoration acceptance', name))


fresh = scratch / 'fresh'
fresh.mkdir()
first = module.restore(fresh)
assert first['restored'] == 186 and first['alreadyPresent'] == 0
for entry in manifest['files']:
    assert module.sha(fresh / entry['path']) == entry['sha256']
repeat = module.restore(fresh)
assert repeat['restored'] == 0 and repeat['alreadyPresent'] == 186
results.append({'name': 'fresh-and-idempotent-restoration', 'restored': first['restored'],
                'allHashesMatch': True, 'repeatWrites': repeat['restored']})

conflict = scratch / 'conflict'
conflict.mkdir()
name = manifest['files'][0]['path']
target = conflict / name
target.parent.mkdir(parents=True)
target.write_bytes(b'foreign retained bytes')
refusal('foreign-existing-file', conflict)
assert target.read_bytes() == b'foreign retained bytes'

linked = scratch / 'symlink'
linked.mkdir()
outside = scratch / 'outside-retained.txt'
outside.write_bytes(b'outside retained bytes')
link = linked / name
link.parent.mkdir(parents=True)
link.symlink_to(outside)
refusal('symlink-destination', linked)
assert link.is_symlink() and outside.read_bytes() == b'outside retained bytes'

bad_manifest = json.loads(json.dumps(manifest))
bad_manifest['archive']['sha256'] = '0' * 64
bad_path = scratch / 'wrong-archive-hash.json'
bad_path.write_text(json.dumps(bad_manifest))
bad_target = scratch / 'wrong-hash'
bad_target.mkdir()
refusal('archive-hash-mismatch', bad_target, bad_path)
assert not list(bad_target.rglob('*'))

bad_manifest = json.loads(json.dumps(manifest))
bad_manifest['files'][0]['path'] = '../../outside-retained.txt'
bad_path = scratch / 'traversal.json'
bad_path.write_text(json.dumps(bad_manifest))
bad_target = scratch / 'traversal-target'
bad_target.mkdir()
refusal('non-inventoried-traversal-path', bad_target, bad_path)
assert outside.read_bytes() == b'outside retained bytes'

for name, argv, environment in [
    ('python-O-refusal', [sys.executable, '-O', '-B', str(module_path), '--destination', str(conflict)],
     {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}),
    ('PYTHONOPTIMIZE-refusal', [sys.executable, '-B', str(module_path), '--destination', str(conflict)],
     {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONOPTIMIZE': '1'}),
]:
    command = subprocess.run(argv, env=environment, capture_output=True, timeout=10)
    assert command.returncode != 0 and 'optimized Python' in command.stderr.decode()
    assert target.read_bytes() == b'foreign retained bytes'
    results.append({'name': name, 'rejected': True, 'exitCode': command.returncode,
                    'foreignBytesUnchanged': True})

report = {
    'schemaVersion': 1, 'type': 'sealed-evidence-restoration-controls',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
    'scratchDirectory': str(scratch), 'controls': results,
    'rehydratorSha256': module.sha(module_path),
    'archiveManifestSha256': module.sha(BASE / 'archive-manifest.checked.json'),
    'archiveSha256': module.sha(BASE / 'sealed-evidence.tar.gz'),
    'passed': True,
    'scope': 'Exact missing-byte restoration and bounded refusal controls; no original evidence, source files or task acceptance changed.',
}
with (BASE / 'restoration-controls.checked.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'controls': len(results), 'restoredFiles': 186,
                  'repeatWrites': 0, 'scratch': str(scratch)}))
