#!/usr/bin/env python3
"""Seal the independently identified embedded Git fixture without changing it."""

import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

if not __debug__:
    raise RuntimeError('Refusing Git-fixture verification with optimized Python.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
INVENTORY = BASE.parent / 'curated-required-files.json'
GAP = BASE.parent / 'independent-review/fresh-checkout/git-fixture-gap.json'
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
EXPECTED_GAP = '75f1292ba660dec30045250f03359a2adc6e0f421cb7127bfb78f1ede7041e1b'
PREFIX = 'docs/execution/body-roadmap/evidence/B30/post-build/independent-review-b02/isolation-fixture/repo/'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


assert sha(INVENTORY) == EXPECTED_INVENTORY
assert sha(GAP) == EXPECTED_GAP
inventory = json.loads(INVENTORY.read_text())
selected = sorted((entry for entry in inventory['files']
                   if entry['path'].startswith(PREFIX + '.git/')
                   or entry['path'] == PREFIX + 'README.md'), key=lambda entry: entry['path'])
gap = json.loads(GAP.read_text())
assert selected == sorted(gap['supplement']['files'], key=lambda entry: entry['path'])
assert len(selected) == 27 and sum(entry['bytes'] for entry in selected) == 27922
objects = {}
files = []
for entry in selected:
    path = ROOT / entry['path']
    assert path.is_file() and not path.is_symlink()
    payload = path.read_bytes()
    assert len(payload) == entry['bytes']
    assert hashlib.sha256(payload).hexdigest() == entry['sha256']
    objects.setdefault(entry['sha256'], payload)
    files.append({'path': entry['path'], 'sha256': entry['sha256'],
                  'bytes': entry['bytes'], 'mode': path.stat().st_mode & 0o777})

with io.BytesIO() as output:
    with gzip.GzipFile(filename='', fileobj=output, mode='wb', compresslevel=9, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as bundle:
            for digest, payload in sorted(objects.items()):
                member = tarfile.TarInfo('sha256/' + digest)
                member.size = len(payload)
                member.mode = 0o400
                member.mtime = 0
                bundle.addfile(member, io.BytesIO(payload))
    encoded = output.getvalue()
archive = BASE / 'sealed-git-fixture.tar.gz'
if archive.exists():
    assert archive.read_bytes() == encoded
else:
    with archive.open('xb') as output:
        output.write(encoded)

manifest = {
    'schemaVersion': 1, 'type': 'sealed-git-fixture-restoration-supplement',
    'inventory': {'path': str(INVENTORY.relative_to(ROOT)), 'sha256': EXPECTED_INVENTORY},
    'gapClassification': {'path': str(GAP.relative_to(ROOT)), 'sha256': EXPECTED_GAP},
    'builder': {'path': str(Path(__file__).relative_to(ROOT)), 'sha256': sha(Path(__file__))},
    'archive': {'path': str(archive.relative_to(ROOT)), 'sha256': sha(archive),
                'bytes': archive.stat().st_size, 'format': 'content-addressed USTAR + gzip'},
    'originalPathCount': len(files), 'distinctContentCount': len(objects),
    'bytesAcrossOriginalPaths': sum(entry['bytes'] for entry in files),
    'distinctContentBytes': sum(len(payload) for payload in objects.values()),
    'files': files, 'historicalBytesUnchanged': True,
    'scope': '27 exact B30 toy-repository files omitted by direct Git publication. The original inventory, 186-file archive and reviews retain their sealed bytes.',
}
manifest_path = BASE / 'manifest.json'
encoded_manifest = (json.dumps(manifest, indent=2) + '\n').encode()
if manifest_path.exists():
    assert manifest_path.read_bytes() == encoded_manifest
else:
    with manifest_path.open('xb') as output:
        output.write(encoded_manifest)
for entry in selected:
    assert sha(ROOT / entry['path']) == entry['sha256']
print(json.dumps({'paths': len(files), 'contents': len(objects),
                  'archiveBytes': archive.stat().st_size, 'archiveSha256': sha(archive),
                  'manifestSha256': sha(manifest_path)}))
