#!/usr/bin/env python3
"""Verify the curated archive, then restore missing evidence without overwrites."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
CONTEXT = {'cli/src/agents/bundled-agents.generated.ts',
           'node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/tsc.js'}
HISTORICAL_PREFIXES = tuple(f'docs/execution/body-roadmap/evidence/{card}/'
                            for card in ['B02', 'B04', 'B18', 'B30'])


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def restore(destination, manifest_path=BASE / 'archive-manifest.json'):
    destination = Path(destination).resolve(strict=True)
    assert destination.is_dir()
    inventory_path = BASE.parent / 'curated-required-files.json'
    assert sha(inventory_path) == EXPECTED_INVENTORY, 'inventory hash mismatch'
    inventory = json.loads(inventory_path.read_text())
    expected = {item['path']: item for item in inventory['files']
                if item['disposition'] != 'direct_publication_file'}
    manifest = json.loads(Path(manifest_path).read_text())
    assert manifest['inventory']['sha256'] == EXPECTED_INVENTORY
    entries = manifest['files']
    assert len(entries) == len(expected) == 186
    assert {entry['path'] for entry in entries} == set(expected)
    objects = {}
    pending = []
    for entry in entries:
        name = entry['path']
        relative = PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert name in CONTEXT or name.startswith(HISTORICAL_PREFIXES)
        assert entry['sha256'] == expected[name]['sha256']
        assert entry['bytes'] == expected[name]['bytes']
        assert entry['disposition'] == expected[name]['disposition']
        assert 0 <= entry['mode'] <= 0o777
        objects[entry['sha256']] = entry['bytes']
        target = destination / name
        assert target.resolve().is_relative_to(destination), ('path escapes destination', name)
        assert not target.is_symlink(), ('refuse symlink', name)
        if target.exists():
            assert target.is_file() and sha(target) == entry['sha256'], ('existing bytes differ', name)
            continue
        for ancestor in target.parents:
            if ancestor == destination:
                break
            assert not ancestor.is_symlink(), ('refuse symlink ancestor', name)
        pending.append(entry)

    archive_ref = manifest['archive']
    assert archive_ref['path'] == str((BASE / 'sealed-evidence.tar.gz').relative_to(ROOT))
    archive_path = BASE / 'sealed-evidence.tar.gz'
    assert archive_path.stat().st_size == archive_ref['bytes']
    assert sha(archive_path) == archive_ref['sha256'], 'archive hash mismatch'
    assert len(objects) == 119 and sum(objects.values()) == 42467666
    payloads = {}
    with tarfile.open(archive_path, 'r:gz') as bundle:
        members = bundle.getmembers()
        assert len(members) == len(objects)
        assert len({member.name for member in members}) == len(members)
        for member in members:
            assert member.isfile() and not member.issym() and not member.islnk()
            assert member.name.startswith('sha256/')
            digest = member.name.removeprefix('sha256/')
            assert digest in objects and member.size == objects[digest]
            handle = bundle.extractfile(member)
            assert handle is not None
            with handle:
                payload = handle.read(member.size + 1)
            assert len(payload) == member.size
            assert hashlib.sha256(payload).hexdigest() == digest
            payloads[digest] = payload
    assert set(payloads) == set(objects)

    # All paths, existing files and archive objects validate before the first write.
    written = []
    for entry in pending:
        target = destination / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        assert target.resolve().is_relative_to(destination)
        for ancestor in target.parents:
            if ancestor == destination:
                break
            assert not ancestor.is_symlink()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(target, flags, entry['mode'])
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payloads[entry['sha256']])
            handle.flush()
            os.fsync(handle.fileno())
        assert sha(target) == entry['sha256']
        written.append(entry['path'])
    return {'verified': True, 'paths': len(entries), 'restored': len(written),
            'alreadyPresent': len(entries) - len(written), 'destination': str(destination),
            'scope': 'Evidence/context byte restoration only; no code execution or product acceptance.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT)
    options = parser.parse_args()
    print(json.dumps(restore(options.destination)))
