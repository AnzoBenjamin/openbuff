#!/usr/bin/env python3
"""Independent supplemental archive and exact staged-checkout review."""
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
    raise RuntimeError('Run the independent review with ordinary Python')
sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[6]
PUB = OUT.parents[1]
BASE = PUB / 'git-fixture'
TREE = Path('/tmp/openbuff-first-wave-index-z4vfoeq2')
PARENT_REPORT = PUB / 'selection/checkouts/16dc02621f5b/report.json'
SCRATCH = Path(tempfile.mkdtemp(prefix='openbuff-supplement-independent-'))
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def binding(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'bytes': path.stat().st_size}


def imported(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(destination):
    result = {}
    for path in sorted(destination.rglob('*')):
        name = str(path.relative_to(destination))
        result[name] = {'symlink': os.readlink(path)} if path.is_symlink() else {'sha256': sha(path)} if path.is_file() else {'directory': True}
    return result


def index_bytes():
    return subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=ROOT, capture_output=True, check=True).stdout


parent = json.loads(PARENT_REPORT.read_text())
before_index = index_bytes()
require(hashlib.sha256(before_index).hexdigest() == parent['stagedIndexSha256'], 'Index differs from parent materialization')
(OUT / 'reviewed-index.nul').write_bytes(before_index)
source_paths = list(sorted(BASE.iterdir())) + [PUB / 'curated-required-files.json', OUT / 'git-fixture-gap.json',
               ROOT / 'docs/execution/body-roadmap/validate-ledger.py', ROOT / 'docs/execution/body-roadmap/ledger.json',
               PUB / 'archive/rehydrate.py', PUB / 'archive/sealed-evidence.tar.gz',
               PUB / 'independent-review/archive-review-manifest.json', PARENT_REPORT,
               PUB / 'selection/materialize-index.py']
bindings = [binding(path) for path in source_paths]
source_snapshot = OUT / 'reviewed-supplement-source'
source_snapshot.mkdir()
for path in sorted(BASE.iterdir()):
    if path.suffix != '.gz':
        shutil.copyfile(path, source_snapshot / path.name)
manifest = json.loads((BASE / 'manifest.json').read_text())
inventory = json.loads((PUB / 'curated-required-files.json').read_text())
gap = json.loads((OUT / 'git-fixture-gap.json').read_text())
require(sha(BASE / 'manifest.json') == '6de54c8670bd9602051a421ba1b228e4d06bc5645fa9816fdcc8f98447f1bfcf', 'Manifest changed')
require(sha(BASE / 'sealed-git-fixture.tar.gz') == 'f298550c8f8f24965d9be2fd707cf6e0261716a33cce77ba1a49f7673de3b531', 'Archive changed')
require((BASE / 'sealed-git-fixture.tar.gz').stat().st_size == 12146, 'Wrong archive size')
expected = {entry['path']: entry for entry in gap['supplement']['files']}
require(len(expected) == len(manifest['files']) == 27, 'Wrong supplemental count')
require({entry['path'] for entry in manifest['files']} == set(expected), 'Wrong supplemental path set')
for entry in manifest['files']:
    require(entry['sha256'] == expected[entry['path']]['sha256'] and entry['bytes'] == expected[entry['path']]['bytes'], 'Wrong supplemental binding')
    require(sha(ROOT / entry['path']) == entry['sha256'], 'Original fixture changed')
for field in ['inventory', 'gapClassification', 'builder', 'archive']:
    reference = manifest[field]
    require(sha(ROOT / reference['path']) == reference['sha256'], 'Manifest reference differs: ' + field)
objects = {entry['sha256']: entry['bytes'] for entry in manifest['files']}
with tarfile.open(BASE / 'sealed-git-fixture.tar.gz', 'r:gz') as bundle:
    members = bundle.getmembers()
    require(len(members) == len(objects) == 25, 'Wrong object count')
    require(len({member.name for member in members}) == 25, 'Duplicate member')
    for member in members:
        require(member.isfile() and not member.pax_headers, 'Nonregular or extended member')
        require(member.name.startswith('sha256/'), 'Unexpected member path')
        digest = member.name.removeprefix('sha256/')
        require(digest in objects and member.size == objects[digest], 'Wrong member binding')
        require(hashlib.sha256(bundle.extractfile(member).read()).hexdigest() == digest, 'Wrong object payload')
require(sum(objects.values()) == 27759, 'Wrong distinct content bytes')
require(sum(entry['bytes'] for entry in manifest['files']) == 27922, 'Wrong restored byte count')

module = imported(BASE / 'rehydrate.py', 'independent_git_supplement')
controls = []
fresh = SCRATCH / 'fresh'
fresh.mkdir()
first = module.restore(fresh)
require(first['restored'] == 27 and first['alreadyPresent'] == 0, 'Fresh restoration incomplete')
for entry in manifest['files']:
    require(sha(fresh / entry['path']) == entry['sha256'], 'Fresh restored hash mismatch')
state = snapshot(fresh)
repeat = module.restore(fresh)
require(repeat['restored'] == 0 and snapshot(fresh) == state, 'Repeated restoration altered destination')
controls.append({'name': 'fresh-and-repeat', 'first': first, 'repeat': repeat, 'all27HashesMatch': True, 'repeatTreeUnchanged': True})

# Independently reproduce the builder in an owned copy using restored input bytes.
builder_tree = SCRATCH / 'builder-tree'
builder_tree.mkdir()
module.restore(builder_tree)
for source in [BASE / 'build-archive.py', BASE / 'manifest.json', BASE / 'sealed-git-fixture.tar.gz',
               PUB / 'curated-required-files.json', OUT / 'git-fixture-gap.json']:
    copied = builder_tree / source.relative_to(ROOT)
    copied.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, copied)
builder_before = snapshot(builder_tree)
builder_result = subprocess.run([sys.executable, '-B', str(builder_tree / (BASE / 'build-archive.py').relative_to(ROOT))],
                                cwd=builder_tree, env=ENV, capture_output=True, text=True, timeout=15)
require(builder_result.returncode == 0, 'Independent builder replay failed: ' + builder_result.stderr)
require(snapshot(builder_tree) == builder_before, 'Builder changed matching existing artifacts')
controls.append({'name': 'builder-reproduction', 'exitCode': builder_result.returncode, 'stdout': builder_result.stdout, 'treeUnchanged': True})


def refusal(label, destination, selected_module=module):
    before = snapshot(destination)
    try:
        selected_module.restore(destination)
    except ValueError as error:
        require(before == snapshot(destination), label + ' altered destination')
        controls.append({'name': label, 'rejected': True, 'reason': str(error), 'destinationUnchanged': True})
    else:
        raise RuntimeError(label + ' unexpectedly accepted')


name = manifest['files'][0]['path']
foreign = fresh / name
foreign.write_bytes(b'independent foreign bytes preserved\n')
refusal('ordinary-python-foreign-file', fresh)
for program in ['rehydrate.py', 'build-archive.py', 'verify-restoration.py']:
    for label, flags, extra in [('-O', ['-O'], {}), ('-OO', ['-OO'], {}), ('PYTHONOPTIMIZE=1', [], {'PYTHONOPTIMIZE': '1'}), ('PYTHONOPTIMIZE=2', [], {'PYTHONOPTIMIZE': '2'})]:
        argv = [sys.executable, *flags, '-B', str(BASE / program)]
        if program == 'rehydrate.py':
            argv.extend(['--destination', str(fresh)])
        before = snapshot(fresh)
        result = subprocess.run(argv, env={**ENV, **extra}, capture_output=True, text=True, timeout=15)
        require(result.returncode != 0 and 'optimized Python' in result.stderr, 'Optimized execution accepted')
        require(snapshot(fresh) == before, 'Optimized execution altered foreign tree')
        controls.append({'name': program + ':' + label, 'argv': argv, 'environmentOverrides': extra,
                         'exitCode': result.returncode, 'stderr': result.stderr, 'destinationUnchanged': True})

outside = SCRATCH / 'outside-sentinel'
outside.write_bytes(b'outside preserved\n')
for label, kind in [('leaf-symlink', 'link'), ('directory-instead-of-file', 'directory'), ('file-instead-of-ancestor', 'ancestor-file'), ('internal-ancestor-symlink', 'ancestor-link')]:
    destination = SCRATCH / label
    destination.mkdir()
    target = destination / name
    if kind == 'link':
        target.parent.mkdir(parents=True)
        target.symlink_to(outside)
    elif kind == 'directory':
        target.mkdir(parents=True)
    elif kind == 'ancestor-file':
        fixture = destination / module.PREFIX
        fixture.mkdir(parents=True)
        (fixture / '.git').write_bytes(b'ancestor retained\n')
    else:
        fixture = destination / module.PREFIX
        fixture.mkdir(parents=True)
        (fixture / 'internal-git').mkdir()
        (fixture / '.git').symlink_to(fixture / 'internal-git', target_is_directory=True)
    refusal(label, destination)
require(outside.read_bytes() == b'outside preserved\n', 'Outside sentinel changed')

encoded = io.BytesIO()
with gzip.GzipFile(filename='', fileobj=encoded, mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as bundle:
        for index in range(4096):
            member = tarfile.TarInfo('sha256/' + format(index, '064x'))
            member.size = 0
            bundle.addfile(member, io.BytesIO())
malformed = encoded.getvalue()
parser_calls = []
original_open = tarfile.open


def observed_open(*args, **kwargs):
    parser_calls.append([str(arg) for arg in args])
    return original_open(*args, **kwargs)


for label in ['modified-archive', 'modified-manifest-traversal', 'forged-matching-archive-manifest']:
    copied_root = SCRATCH / label
    for source in [BASE / 'rehydrate.py', BASE / 'manifest.json', BASE / 'sealed-git-fixture.tar.gz', PUB / 'curated-required-files.json', OUT / 'git-fixture-gap.json']:
        target = copied_root / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    copied_base = copied_root / BASE.relative_to(ROOT)
    if label != 'modified-manifest-traversal':
        (copied_base / 'sealed-git-fixture.tar.gz').write_bytes(malformed)
    if label != 'modified-archive':
        changed = copy.deepcopy(manifest)
        if label == 'modified-manifest-traversal':
            changed['files'][0]['path'] = '../../outside-sentinel'
        else:
            changed['archive']['sha256'] = hashlib.sha256(malformed).hexdigest()
            changed['archive']['bytes'] = len(malformed)
        (copied_base / 'manifest.json').write_text(json.dumps(changed))
    copied_module = imported(copied_base / 'rehydrate.py', label.replace('-', '_'))
    require(sha(copied_base / 'rehydrate.py') == sha(BASE / 'rehydrate.py'), 'Fixture helper differs')
    destination = SCRATCH / (label + '-destination')
    destination.mkdir()
    tarfile.open = observed_open
    try:
        refusal(label, destination, copied_module)
        require(not parser_calls, 'Malformed archive reached parser')
    finally:
        tarfile.open = original_open
controls.append({'name': 'malformed-4096-header-archive-before-parser', 'archiveHeaders': 4096, 'compressedBytes': len(malformed), 'tarfileOpenCalls': parser_calls})

# Verify every staged blob against the materialized bytes, independently of inventory.
entries = []
for raw in before_index.split(b'\0'):
    if not raw:
        continue
    metadata, raw_path = raw.split(b'\t', 1)
    mode, oid, stage = metadata.decode().split()
    name = raw_path.decode()
    require(stage == '0' and mode in ['100644', '100755', '120000'], 'Unmerged or Gitlink entry: ' + name)
    path = TREE / name
    if mode == '120000':
        require(path.is_symlink(), 'Expected staged symlink: ' + name)
        data = os.readlink(path).encode()
    else:
        require(path.is_file() and not path.is_symlink(), 'Missing/nonregular staged file: ' + name)
        data = path.read_bytes()
    actual_oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    require(actual_oid == oid, 'Materialized blob differs from staged index: ' + name)
    entries.append({'path': name, 'mode': mode, 'gitBlobOid': oid, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
with (OUT / 'materialized-staged-bindings.json').open('x') as output:
    json.dump({'indexSha256': hashlib.sha256(before_index).hexdigest(), 'entries': entries}, output, indent=2)
    output.write('\n')

require(sha(TREE / 'docs/execution/body-roadmap/validate-ledger.py') == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c', 'Frozen validator changed')
require(sha(TREE / 'docs/execution/body-roadmap/ledger.json') == '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758', 'Frozen ledger changed')
require(sha(TREE / (PUB / 'curated-required-files.json').relative_to(ROOT)) == sha(PUB / 'curated-required-files.json'), 'Materialized inventory differs')
for entry in inventory['files']:
    require(sha(TREE / entry['path']) == entry['sha256'] and (TREE / entry['path']).stat().st_size == entry['bytes'], 'Inventory path mismatch: ' + entry['path'])
for path in BASE.iterdir():
    require(sha(TREE / path.relative_to(ROOT)) == sha(path), 'Materialized supplemental source differs')
parent_log_bindings = []
for command in parent['commands']:
    for stream in ['stdout', 'stderr']:
        reference = command[stream]
        require(sha(ROOT / reference['path']) == reference['sha256'], 'Parent output receipt changed')
        parent_log_bindings.append(binding(ROOT / reference['path']))

commands = []
for label, relative in [('base-repeat', 'archive/rehydrate.py'), ('supplement-repeat', 'git-fixture/rehydrate.py')]:
    argv = [sys.executable, '-B', str(TREE / PUB.relative_to(ROOT) / relative)]
    result = subprocess.run(argv, cwd=TREE, env=ENV, capture_output=True, text=True, timeout=15)
    require(result.returncode == 0, label + ' failed: ' + result.stderr)
    value = json.loads(result.stdout)
    require(value['restored'] == 0 and value['verified'], label + ' unexpectedly wrote files')
    commands.append({'name': label, 'argv': argv, 'exitCode': result.returncode, 'result': value})

argv = [sys.executable, '-B', str(TREE / 'docs/execution/body-roadmap/validate-ledger.py')]
validation = subprocess.run(argv, cwd=TREE, env=ENV, capture_output=True, text=True, timeout=60)
for name, value in [('ledger-validation.stdout.log', validation.stdout), ('ledger-validation.stderr.log', validation.stderr)]:
    with (OUT / name).open('x') as output:
        output.write(value)
require(validation.returncode == 0, 'Independent frozen ledger failed: ' + validation.stdout + validation.stderr)
value = json.loads(validation.stdout)
require(value['valid'] and value['errors'] == [] and value['accepted'] == ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36'] and len(value['remaining']) == 31, 'Wrong ledger outcome')
commands.append({'name': 'independent-frozen-ledger', 'argv': argv, 'exitCode': validation.returncode, 'result': value,
                 'stdout': binding(OUT / 'ledger-validation.stdout.log'), 'stderr': binding(OUT / 'ledger-validation.stderr.log')})
for entry in inventory['files']:
    require(sha(TREE / entry['path']) == entry['sha256'], 'Materialized inventory changed during review')
for item in bindings:
    require(sha(ROOT / item['path']) == item['sha256'], 'Original reviewed binding changed')
for entry in manifest['files']:
    require(sha(ROOT / entry['path']) == entry['sha256'], 'Original fixture changed during review')
require(index_bytes() == before_index, 'Staged index changed during review')

report = {'schemaVersion': 1, 'type': 'independent-supplement-and-fresh-checkout-review',
          'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reviewer': '/root/b04_lock_cas',
          'scope': 'Supplemental archive/restoration and exact staged byte availability/frozen ledger consistency only. No product behavior, own inventory/implementation, staging, commit, or future-card acceptance.',
          'decision': 'approved-with-stated-filesystem-and-evidence-scope',
          'bindings': bindings, 'reviewScript': binding(Path(__file__)), 'parentLogBindings': parent_log_bindings,
          'supplement': {'paths': 27, 'restoredBytes': 27922, 'distinctContents': 25, 'distinctContentBytes': 27759,
                         'compressedBytes': 12146, 'allObjectsMatchFixedInventory': True, 'allOriginalFixtureFilesUnchanged': True,
                         'controls': controls, 'scratch': str(SCRATCH)},
          'freshCheckout': {'path': str(TREE), 'indexSha256': hashlib.sha256(before_index).hexdigest(),
                            'stagedIndexUnchangedDuringReview': True, 'stagedBlobCount': len(entries),
                            'allStagedBlobsMatch': True, 'gitlinkEntries': 0, 'requiredInventoryFiles': len(inventory['files']),
                            'requiredInventoryHashesMatchBeforeAndAfter': True, 'commands': commands,
                            'stagedBindings': binding(OUT / 'materialized-staged-bindings.json'),
                            'indexSnapshot': binding(OUT / 'reviewed-index.nul')},
          'limitations': ['Cooperative/quiescent filesystem only; concurrent ancestor replacement is not isolated.',
                          'Interrupted I/O can leave partial new files; neither archive provides a multi-file atomic transaction.',
                          'Archive parser bounds rely on exact pinned archive identity; no generic hostile-archive claim.',
                          'Fresh-checkout verification establishes byte availability and frozen ledger consistency, not executable/provider/installed-binary or future-card behavior.']}
with (OUT / 'supplement-and-checkout-review.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'supplementControls': len(controls), 'stagedBlobs': len(entries),
                  'inventoryFiles': len(inventory['files']), 'accepted': 8, 'remaining': 31,
                  'reportSha256': sha(OUT / 'supplement-and-checkout-review.json')}))
