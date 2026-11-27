#!/usr/bin/env python3
"""Restore only the 27 pinned B30 Git-fixture files, without overwriting data."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile

if not __debug__:
    raise RuntimeError('Refusing Git-fixture verification with optimized Python; remove -O or PYTHONOPTIMIZE.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
EXPECTED_GAP = '75f1292ba660dec30045250f03359a2adc6e0f421cb7127bfb78f1ede7041e1b'
EXPECTED_MANIFEST = '6de54c8670bd9602051a421ba1b228e4d06bc5645fa9816fdcc8f98447f1bfcf'
EXPECTED_ARCHIVE = 'f298550c8f8f24965d9be2fd707cf6e0261716a33cce77ba1a49f7673de3b531'
EXPECTED_ARCHIVE_BYTES = 12146
PREFIX = 'docs/execution/body-roadmap/evidence/B30/post-build/independent-review-b02/isolation-fixture/repo/'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def check_target(destination, target):
    require(target.resolve().is_relative_to(destination), 'Path escapes destination')
    require(not target.is_symlink(), 'Refuse symlink destination')
    for ancestor in target.parents:
        if ancestor == destination:
            break
        require(not ancestor.is_symlink(), 'Refuse symlink ancestor')
        require(not ancestor.exists() or ancestor.is_dir(), 'Non-directory ancestor')


def restore(destination):
    destination = Path(destination).resolve(strict=True)
    require(destination.is_dir(), 'Destination must be a directory')
    inventory_path = BASE.parent / 'curated-required-files.json'
    gap_path = BASE.parent / 'independent-review/fresh-checkout/git-fixture-gap.json'
    manifest_path = BASE / 'manifest.json'
    require(sha(inventory_path) == EXPECTED_INVENTORY, 'Inventory hash mismatch')
    require(sha(gap_path) == EXPECTED_GAP, 'Gap classification hash mismatch')
    require(sha(manifest_path) == EXPECTED_MANIFEST, 'Manifest hash mismatch')
    inventory = json.loads(inventory_path.read_text())
    expected = {entry['path']: entry for entry in inventory['files']
                if entry['path'].startswith(PREFIX + '.git/')
                or entry['path'] == PREFIX + 'README.md'}
    manifest = json.loads(manifest_path.read_text())
    entries = manifest['files']
    require(len(entries) == len(expected) == 27, 'Unexpected file count')
    require({entry['path'] for entry in entries} == set(expected), 'Unexpected path set')
    require(manifest['inventory']['sha256'] == EXPECTED_INVENTORY, 'Manifest inventory differs')
    require(manifest['gapClassification']['sha256'] == EXPECTED_GAP, 'Manifest gap differs')
    objects = {}
    pending = []
    for entry in entries:
        name = entry['path']
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts
                and str(relative) == name, 'Invalid relative path')
        require(entry['sha256'] == expected[name]['sha256']
                and entry['bytes'] == expected[name]['bytes'], 'File differs from inventory')
        require(0 <= entry['mode'] <= 0o777, 'Invalid file mode')
        objects[entry['sha256']] = entry['bytes']
        target = destination / name
        check_target(destination, target)
        if target.exists():
            require(target.is_file() and sha(target) == entry['sha256'], 'Existing bytes differ')
        else:
            pending.append(entry)

    archive_path = BASE / 'sealed-git-fixture.tar.gz'
    archive_ref = manifest['archive']
    require(archive_ref['path'] == str(archive_path.relative_to(ROOT)), 'Unexpected archive path')
    require(archive_ref['sha256'] == EXPECTED_ARCHIVE
            and archive_ref['bytes'] == EXPECTED_ARCHIVE_BYTES, 'Archive manifest differs')
    require(archive_path.stat().st_size == EXPECTED_ARCHIVE_BYTES
            and sha(archive_path) == EXPECTED_ARCHIVE, 'Archive bytes differ from pinned snapshot')
    require(len(objects) == 25 and sum(entry['bytes'] for entry in entries) == 27922,
            'Unexpected payload bounds')
    payloads = {}
    # The small compressed archive is pinned before tar parsing or allocation.
    with tarfile.open(archive_path, 'r:gz') as bundle:
        members = bundle.getmembers()
        require(len(members) == len(objects), 'Unexpected archive member count')
        require(len({member.name for member in members}) == len(members), 'Duplicate member')
        for member in members:
            require(member.isfile() and not member.issym() and not member.islnk(), 'Non-file member')
            require(member.name.startswith('sha256/'), 'Unexpected member path')
            digest = member.name.removeprefix('sha256/')
            require(digest in objects and member.size == objects[digest], 'Unexpected member size')
            handle = bundle.extractfile(member)
            require(handle is not None, 'Missing member payload')
            with handle:
                payload = handle.read(member.size + 1)
            require(len(payload) == member.size
                    and hashlib.sha256(payload).hexdigest() == digest, 'Payload hash mismatch')
            payloads[digest] = payload
    require(set(payloads) == set(objects), 'Archive coverage differs')

    # Every existing target and payload validates before the first write.
    written = []
    for entry in pending:
        target = destination / entry['path']
        check_target(destination, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        check_target(destination, target)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             entry['mode'])
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payloads[entry['sha256']])
            handle.flush()
            os.fsync(handle.fileno())
        require(sha(target) == entry['sha256'], 'Written hash mismatch')
        written.append(entry['path'])
    return {'verified': True, 'paths': len(entries), 'restored': len(written),
            'alreadyPresent': len(entries) - len(written), 'destination': str(destination),
            'scope': 'Exact historical toy-Git fixture restoration; no Git operation or application code execution.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT)
    options = parser.parse_args()
    print(json.dumps(restore(options.destination)))
