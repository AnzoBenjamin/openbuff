#!/usr/bin/env python3
"""Verify exact fixture restoration and refusal before writes or tar parsing."""

import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if not __debug__:
    raise RuntimeError('Refusing Git-fixture controls with optimized Python.')

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
scratch = Path(tempfile.mkdtemp(prefix='openbuff-git-fixture-controls-'))
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
controls = []


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def imported(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(destination):
    return [(str(path.relative_to(destination)),
             ('link', str(path.readlink())) if path.is_symlink()
             else ('file', sha(path)) if path.is_file() else ('directory', None))
            for path in sorted(destination.rglob('*'))]


def refused(name, module, destination):
    before = snapshot(destination)
    try:
        module.restore(destination)
    except ValueError as error:
        assert snapshot(destination) == before
        controls.append({'name': name, 'rejected': True, 'reason': str(error),
                         'pathsAndExistingBytesUnchanged': True})
    else:
        raise AssertionError(('Unexpected restoration acceptance', name))


module = imported(BASE / 'rehydrate.py', 'fixture_rehydrator')
manifest = json.loads((BASE / 'manifest.json').read_text())
original_hashes = {entry['path']: sha(ROOT / entry['path']) for entry in manifest['files']}
fresh = scratch / 'fresh'
fresh.mkdir()
first = module.restore(fresh)
assert first['restored'] == 27 and first['alreadyPresent'] == 0
for entry in manifest['files']:
    assert sha(fresh / entry['path']) == entry['sha256']
repeat = module.restore(fresh)
assert repeat['restored'] == 0 and repeat['alreadyPresent'] == 27
controls.append({'name': 'fresh-and-idempotent-restoration', 'restored': 27,
                 'allHashesMatch': True, 'repeatWrites': 0})

name = manifest['files'][0]['path']
conflict = scratch / 'conflict'
target = conflict / name
target.parent.mkdir(parents=True)
target.write_bytes(b'foreign retained bytes')
refused('foreign-existing-file', module, conflict)

linked = scratch / 'linked-target'
target = linked / name
target.parent.mkdir(parents=True)
outside = scratch / 'outside-retained.txt'
outside.write_bytes(b'outside retained bytes')
target.symlink_to(outside)
refused('symlink-destination', module, linked)
assert outside.read_bytes() == b'outside retained bytes'

ancestor = scratch / 'linked-ancestor'
fixture = ancestor / module.PREFIX
fixture.mkdir(parents=True)
outside_directory = scratch / 'outside-directory'
outside_directory.mkdir()
(fixture / '.git').symlink_to(outside_directory, target_is_directory=True)
refused('symlink-ancestor', module, ancestor)
assert not list(outside_directory.iterdir())

directory = scratch / 'directory-collision'
(directory / name).mkdir(parents=True)
refused('directory-in-place-of-file', module, directory)

for label in ['modified-manifest', 'modified-archive']:
    copied_root = scratch / label
    for source in [BASE / 'rehydrate.py', BASE / 'manifest.json',
                   BASE / 'sealed-git-fixture.tar.gz',
                   BASE.parent / 'curated-required-files.json',
                   BASE.parent / 'independent-review/fresh-checkout/git-fixture-gap.json']:
        copied = copied_root / source.relative_to(ROOT)
        copied.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, copied)
    copied_base = copied_root / BASE.relative_to(ROOT)
    copied_module = imported(copied_base / 'rehydrate.py', label.replace('-', '_'))
    destination = scratch / (label + '-destination')
    destination.mkdir()
    if label == 'modified-manifest':
        bad_manifest = json.loads((copied_base / 'manifest.json').read_text())
        bad_manifest['files'][0]['path'] = '../../outside-retained.txt'
        (copied_base / 'manifest.json').write_text(json.dumps(bad_manifest))
        refused(label, copied_module, destination)
    else:
        (copied_base / 'sealed-git-fixture.tar.gz').write_bytes(b'invalid archive')
        original_open = copied_module.tarfile.open

        def parsing_is_forbidden(*args, **kwargs):
            raise AssertionError('Modified archive reached tar parsing')

        copied_module.tarfile.open = parsing_is_forbidden
        try:
            refused(label + '-before-parsing', copied_module, destination)
        finally:
            copied_module.tarfile.open = original_open

environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'PYTHONDONTWRITEBYTECODE': '1'}
for entry_point in ['rehydrate.py', 'build-archive.py', 'verify-restoration.py']:
    for label, arguments, settings in [
        ('python-O', ['-O'], environment),
        ('PYTHONOPTIMIZE', [], {**environment, 'PYTHONOPTIMIZE': '1'}),
    ]:
        before = snapshot(conflict)
        result = subprocess.run([sys.executable, *arguments, '-B', str(BASE / entry_point)],
                                env=settings, capture_output=True, timeout=10)
        assert result.returncode != 0 and b'optimized Python' in result.stderr
        assert snapshot(conflict) == before
        controls.append({'name': entry_point + ':' + label, 'rejected': True,
                         'exitCode': result.returncode})

assert all(sha(ROOT / path) == digest for path, digest in original_hashes.items())
report = {
    'schemaVersion': 1, 'type': 'git-fixture-restoration-controls',
    'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
    'scratchDirectory': str(scratch), 'controls': controls,
    'originalFixtureHashesUnchanged': True,
    'rehydratorSha256': sha(BASE / 'rehydrate.py'),
    'manifestSha256': sha(BASE / 'manifest.json'),
    'archiveSha256': sha(BASE / 'sealed-git-fixture.tar.gz'),
    'passed': True,
    'scope': 'Exact historical toy-repository restoration and refusal controls only.',
}
with (BASE / 'restoration-controls.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'controls': len(controls), 'restoredFiles': 27,
                  'repeatWrites': 0, 'scratch': str(scratch)}))
