#!/usr/bin/env python3
"""Independent fixed-snapshot archive review; writes only owned review evidence/tmp."""
import copy
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

if not __debug__:
    raise RuntimeError('Run independent review with ordinary Python')
sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
BASE = OUT.parent / 'archive'
ROOT = OUT.parents[5]
SCRATCH = Path(tempfile.mkdtemp(prefix='openbuff-checked-archive-independent-'))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def binding(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': digest(path), 'bytes': path.stat().st_size}


def snapshot(root):
    values = {}
    for path in sorted(root.rglob('*')):
        name = str(path.relative_to(root))
        if path.is_symlink():
            values[name] = {'symlink': os.readlink(path)}
        elif path.is_file():
            values[name] = {'sha256': digest(path), 'bytes': path.stat().st_size}
        elif path.is_dir():
            values[name] = {'directory': True}
        else:
            values[name] = {'other': True}
    return values


def load_helper(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


source_names = ['rehydrate.py', 'build-archive.py', 'verify-restoration.py',
                'archive-manifest.checked.json', 'restoration-controls.checked.json',
                'archive-manifest.json', 'restoration-controls.json', 'repair-history.json',
                'build-archive.initial.py', 'rehydrate.initial.py', 'verify-restoration.initial.py']
bindings = [binding(BASE / name) for name in source_names]
bindings.extend([binding(BASE / 'sealed-evidence.tar.gz'), binding(OUT.parent / 'curated-required-files.json')])
snapshot_dir = OUT / 'checked-source'
snapshot_dir.mkdir()
for name in source_names:
    shutil.copyfile(BASE / name, snapshot_dir / name)

inventory = json.loads((OUT.parent / 'curated-required-files.json').read_text())
selected = {item['path']: item for item in inventory['files'] if item['disposition'] != 'direct_publication_file'}
manifest = json.loads((BASE / 'archive-manifest.checked.json').read_text())
require(len(selected) == len(manifest['files']) == 186, 'Wrong selected count')
require({item['path'] for item in manifest['files']} == set(selected), 'Wrong selected path set')
for entry in manifest['files']:
    require(all(entry[key] == selected[entry['path']][key] for key in ['sha256', 'bytes', 'disposition']), 'Wrong entry binding')
    require(digest(ROOT / entry['path']) == entry['sha256'], 'Original selected file changed')
for key in ['inventory', 'archive', 'builder', 'originalGeneratorManifest', 'originalBuilderSource']:
    reference = manifest[key]
    require(digest(ROOT / reference['path']) == reference['sha256'], 'Manifest reference hash mismatch: ' + key)

archive = BASE / 'sealed-evidence.tar.gz'
require(digest(archive) == '301f2e8ef2e17a1b0416b54b907328b186947fd5f76f261ee7457ddcc66e4271', 'Wrong pinned archive')
require(archive.stat().st_size == 6305471, 'Wrong pinned compressed size')
objects = {item['sha256']: item['bytes'] for item in manifest['files']}
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    require(len(members) == len(objects) == 119, 'Wrong archive object count')
    require(len({member.name for member in members}) == 119, 'Duplicate object name')
    for member in members:
        require(member.isfile() and not member.pax_headers, 'Nonregular/PAX object')
        require(member.name.startswith('sha256/'), 'Wrong object name')
        expected_hash = member.name.removeprefix('sha256/')
        require(expected_hash in objects and member.size == objects[expected_hash], 'Wrong object size')
        data = bundle.extractfile(member).read()
        require(hashlib.sha256(data).hexdigest() == expected_hash, 'Wrong object bytes')
require(sum(objects.values()) == 42467666, 'Wrong distinct content size')

helper = load_helper(BASE / 'rehydrate.py', 'independent_checked_helper')
controls = []
fresh = SCRATCH / 'fresh'
fresh.mkdir()
first = helper.restore(fresh)
require(first['restored'] == 186 and first['alreadyPresent'] == 0, 'Incomplete fresh restore')
for entry in manifest['files']:
    require(digest(fresh / entry['path']) == entry['sha256'], 'Fresh restored hash mismatch')
before_repeat = snapshot(fresh)
repeat = helper.restore(fresh)
require(repeat['restored'] == 0 and repeat['alreadyPresent'] == 186, 'Non-idempotent repeated restore')
require(before_repeat == snapshot(fresh), 'Repeat changed destination')
controls.append({'name': 'fresh-and-repeat', 'first': first, 'repeat': repeat, 'all186HashesMatch': True, 'repeatTreeUnchanged': True})

target_name = 'cli/src/agents/bundled-agents.generated.ts'
target = fresh / target_name
target.write_bytes(b'foreign bytes retained by independent negative control\n')
foreign_state = snapshot(fresh)
for program in ['rehydrate.py', 'build-archive.py', 'verify-restoration.py']:
    for label, flags, extra_env in [
        ('-O', ['-O'], {}), ('-OO', ['-OO'], {}),
        ('PYTHONOPTIMIZE=1', [], {'PYTHONOPTIMIZE': '1'}),
        ('PYTHONOPTIMIZE=2', [], {'PYTHONOPTIMIZE': '2'}),
    ]:
        argv = [sys.executable, *flags, '-B', str(BASE / program)]
        if program == 'rehydrate.py':
            argv.extend(['--destination', str(fresh)])
        command = subprocess.run(argv, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', **extra_env}, capture_output=True, text=True, timeout=15)
        require(command.returncode != 0 and 'optimized Python' in command.stderr, 'Optimized execution not rejected')
        require(foreign_state == snapshot(fresh), 'Optimized mode altered destination')
        controls.append({'name': program + ':' + label, 'argv': argv, 'environmentOverrides': extra_env,
                         'exitCode': command.returncode, 'stderr': command.stderr, 'destinationUnchanged': True})


def expect_refusal(name, destination, custom_manifest=None, module=helper):
    before = snapshot(destination)
    try:
        module.restore(destination, custom_manifest or BASE / 'archive-manifest.checked.json')
    except (AssertionError, ValueError) as error:
        require(before == snapshot(destination), name + ' changed destination')
        controls.append({'name': name, 'rejected': True, 'exception': type(error).__name__, 'message': str(error), 'destinationUnchanged': True})
    else:
        raise RuntimeError(name + ' unexpectedly accepted')


expect_refusal('ordinary-python-foreign-existing-file', fresh)
outside = SCRATCH / 'outside-retained.txt'
outside.write_bytes(b'outside retained bytes')
linked = SCRATCH / 'linked'
linked.mkdir()
link = linked / target_name
link.parent.mkdir(parents=True)
link.symlink_to(outside)
expect_refusal('external-leaf-symlink', linked)
require(outside.read_bytes() == b'outside retained bytes', 'Outside sentinel changed')

internal = SCRATCH / 'internal-linked'
internal.mkdir()
internal_object = internal / 'matching-object'
internal_object.write_bytes((ROOT / target_name).read_bytes())
internal_link = internal / target_name
internal_link.parent.mkdir(parents=True)
internal_link.symlink_to(internal_object)
expect_refusal('matching-internal-leaf-symlink', internal)

ancestor = SCRATCH / 'ancestor-linked'
ancestor.mkdir()
(ancestor / 'internal-cli').mkdir()
(ancestor / 'cli').symlink_to(ancestor / 'internal-cli', target_is_directory=True)
expect_refusal('missing-target-through-internal-ancestor-symlink', ancestor)

for label, mutation in [
    ('non-inventoried-traversal', lambda m: m['files'][0].update(path='../../outside-retained.txt')),
    ('wrong-archive-manifest-hash', lambda m: m['archive'].update(sha256='0' * 64)),
]:
    changed = copy.deepcopy(manifest)
    mutation(changed)
    path = SCRATCH / (label + '.json')
    path.write_text(json.dumps(changed))
    destination = SCRATCH / label
    destination.mkdir()
    expect_refusal(label, destination, path)

# Replay the original 4,096-header probe against exact repaired helper bytes in a copied tree.
fixture_root = SCRATCH / 'parser-fixture'
fixture_base = fixture_root / BASE.relative_to(ROOT)
fixture_base.mkdir(parents=True)
for name in ['rehydrate.py', 'archive-manifest.checked.json']:
    shutil.copyfile(BASE / name, fixture_base / name)
shutil.copyfile(OUT.parent / 'curated-required-files.json', fixture_base.parent / 'curated-required-files.json')
encoded = io.BytesIO()
with gzip.GzipFile(filename='', fileobj=encoded, mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as bundle:
        for index in range(4096):
            member = tarfile.TarInfo('sha256/' + format(index, '064x'))
            member.size = 0
            bundle.addfile(member, io.BytesIO())
malformed = encoded.getvalue()
(fixture_base / 'sealed-evidence.tar.gz').write_bytes(malformed)
fixture_helper = load_helper(fixture_base / 'rehydrate.py', 'independent_parser_fixture_helper')
require(digest(fixture_base / 'rehydrate.py') == digest(BASE / 'rehydrate.py'), 'Fixture helper differs')
parser_calls = []
original_open = tarfile.open


def observed_open(*args, **kwargs):
    parser_calls.append({'args': [str(arg) for arg in args], 'kwargs': kwargs})
    return original_open(*args, **kwargs)


tarfile.open = observed_open
try:
    for label, modify_manifest in [('modified-bytes-pinned-manifest', False), ('modified-bytes-matching-forged-manifest', True)]:
        altered = copy.deepcopy(manifest)
        if modify_manifest:
            altered['archive']['sha256'] = hashlib.sha256(malformed).hexdigest()
            altered['archive']['bytes'] = len(malformed)
        fixture_manifest = fixture_base / (label + '.json')
        fixture_manifest.write_text(json.dumps(altered))
        destination = SCRATCH / label
        destination.mkdir()
        expect_refusal(label, destination, fixture_manifest, fixture_helper)
        require(not parser_calls, 'Malformed archive reached parser')
finally:
    tarfile.open = original_open
controls.append({'name': 'original-4096-header-parser-control', 'actualHeaders': 4096,
                 'compressedBytes': len(malformed), 'sha256': hashlib.sha256(malformed).hexdigest(),
                 'tarfileOpenCalls': parser_calls, 'helperBytesExact': True, 'zeroDestinationWrites': True})

for item in bindings:
    require(digest(ROOT / item['path']) == item['sha256'], 'Reviewed binding changed during controls')
for entry in manifest['files']:
    require(digest(ROOT / entry['path']) == entry['sha256'], 'Original selected file changed during controls')

report = {'schemaVersion': 1, 'type': 'independent-checked-archive-review',
          'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'scratch': str(SCRATCH), 'reviewer': '/root/b04_lock_cas',
          'scope': 'Archive/restoration correctness only; inventory is a supplied fixed input, not self-approved. No product, ledger/card, cleanup or commit approval.',
          'bindings': bindings, 'reviewScript': binding(Path(__file__)),
          'archive': {'originalPaths': 186, 'distinctObjects': 119, 'distinctContentBytes': 42467666,
                      'compressedBytes': 6305471, 'allArchiveObjectsMatchInventory': True,
                      'all186OriginalFilesUnchanged': True, 'manifestReferencesMatch': True},
          'controls': controls,
          'decision': 'approved-for-fixed-snapshot-restoration-on-cooperative-quiescent-filesystem',
          'limitations': ['Concurrent ancestor replacement is not isolated by dirfd-based traversal.',
                          'Interrupted I/O can leave partial new files; restoration is not a multi-file atomic transaction.',
                          'Existing matching files through internal ancestor aliases can be accepted; universal directory-symlink rejection is not claimed.',
                          'Archive parser boundedness rests on exact archive digest/size pinning, not a generic hostile-archive parser.',
                          'Staged fresh-checkout validation is separate and pending parent-provided materialization.']}
with (OUT / 'checked-archive-review.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'controls': len(controls), 'scratch': str(SCRATCH),
                  'report': str(OUT / 'checked-archive-review.json'), 'reportSha256': digest(OUT / 'checked-archive-review.json')}))
