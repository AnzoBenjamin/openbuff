#!/usr/bin/env python3
"""Archive only the independently inventoried historical and context bytes."""

import datetime
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

OUT = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
INVENTORY = OUT.parent / 'curated-required-files.json'
EXPECTED = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


assert sha(INVENTORY) == EXPECTED
inventory = json.loads(INVENTORY.read_text())
selected = [item for item in inventory['files']
            if item['disposition'] != 'direct_publication_file']
assert len(selected) == 186
objects = {}
files = []
for item in selected:
    path = ROOT / item['path']
    payload = path.read_bytes()
    assert len(payload) == item['bytes']
    assert hashlib.sha256(payload).hexdigest() == item['sha256']
    objects.setdefault(item['sha256'], payload)
    files.append({'path': item['path'], 'sha256': item['sha256'],
                  'bytes': len(payload), 'mode': path.stat().st_mode & 0o777,
                  'disposition': item['disposition']})
assert len(objects) == 119
archive = OUT / 'sealed-evidence.tar.gz'
with archive.open('xb') as output:
    with gzip.GzipFile(filename='', fileobj=output, mode='wb', compresslevel=9, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as bundle:
            for digest, payload in sorted(objects.items()):
                entry = tarfile.TarInfo('sha256/' + digest)
                entry.size = len(payload)
                entry.mode = 0o400
                entry.mtime = 0
                bundle.addfile(entry, io.BytesIO(payload))
for item in selected:
    assert sha(ROOT / item['path']) == item['sha256']
manifest = {
    'schemaVersion': 1, 'type': 'body-sealed-evidence-restoration-archive',
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'inventory': {'path': str(INVENTORY.relative_to(ROOT)), 'sha256': EXPECTED},
    'archive': {'path': str(archive.relative_to(ROOT)), 'sha256': sha(archive),
                'bytes': archive.stat().st_size, 'format': 'content-addressed USTAR + gzip'},
    'builder': {'path': str(Path(__file__).relative_to(ROOT)), 'sha256': sha(Path(__file__))},
    'originalPathCount': len(files), 'distinctContentCount': len(objects),
    'bytesAcrossOriginalPaths': sum(item['bytes'] for item in files),
    'distinctContentBytes': sum(len(payload) for payload in objects.values()),
    'files': files,
    'historicalBytesUnchanged': True,
    'scope': 'Exact incidental historical seals, synthetic journal/memory/job fixtures and three source/dependency context inputs. No product binary, browser asset, live profile or unreferenced cache.',
}
with (OUT / 'archive-manifest.json').open('x') as output:
    json.dump(manifest, output, indent=2)
    output.write('\n')
print(json.dumps({'archivedPaths': len(files), 'contents': len(objects),
                  'archiveBytes': archive.stat().st_size, 'sha256': sha(archive)}))
