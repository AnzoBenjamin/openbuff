#!/usr/bin/env python3
"""Verify archived roadmap evidence and restore it without overwriting files."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

BASE = Path(__file__).resolve().parent
EXPECTED_MANIFEST = 'f007ac73599e36dcb494171d010d5b91cff946ecd61f545fa0a2e85644654d52'
CHUNK_SIZE = 1024 * 1024


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative_path(value):
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or '..' in path.parts or str(path) != value or '\\' in value:
        raise ValueError(f'Invalid archive path: {value!r}')
    return path


def target_path(destination, name):
    target = destination.joinpath(*relative_path(name).parts)
    for ancestor in [target, *target.parents]:
        if ancestor == destination:
            break
        if ancestor.is_symlink():
            raise ValueError(f'Refusing symlink path: {name}')
        if ancestor != target and ancestor.exists() and not ancestor.is_dir():
            raise ValueError(f'Archive parent is not a directory: {name}')
    if not target.resolve().is_relative_to(destination):
        raise ValueError(f'Archive path escapes destination: {name}')
    return target


def restore(destination=None, include_context=False, check=False):
    manifest_path = BASE / 'manifest.json'
    if sha(manifest_path) != EXPECTED_MANIFEST:
        raise ValueError('Archive manifest differs from the sealed inventory')
    manifest = json.loads(manifest_path.read_text())
    if manifest['schemaVersion'] != 1:
        raise ValueError('Unsupported archive manifest')
    entries = manifest['files']
    if len({entry['path'] for entry in entries}) != len(entries):
        raise ValueError('Duplicate archive paths')
    names = {entry['path'] for entry in entries}
    for entry in entries:
        if any(str(parent) in names for parent in relative_path(entry['path']).parents):
            raise ValueError('Archive file conflicts with a parent path')
    objects = {}
    for entry in entries:
        relative_path(entry['path'])
        if entry['kind'] not in {'evidence', 'context'}:
            raise ValueError('Invalid archive entry kind')
        digest, size, mode = entry['sha256'], entry['bytes'], entry['mode']
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid object hash')
        if not isinstance(size, int) or size < 0 or not isinstance(mode, int) or not 0 <= mode <= 0o777:
            raise ValueError('Invalid object size or permissions')
        if digest in objects and objects[digest] != size:
            raise ValueError('Inconsistent content-addressed object size')
        objects[digest] = size

    selected = [entry for entry in entries if include_context or entry['kind'] == 'evidence']
    pending = []
    if not check:
        if destination is None:
            raise ValueError('An explicit destination is required')
        destination = Path(destination).resolve(strict=True)
        if not destination.is_dir():
            raise ValueError('Destination must be an existing directory')
        for entry in selected:
            target = target_path(destination, entry['path'])
            if target.exists():
                if not target.is_file() or target.stat().st_size != entry['bytes'] or sha(target) != entry['sha256']:
                    raise ValueError(f'Existing bytes differ: {entry["path"]}')
            else:
                pending.append(entry)

    with tempfile.TemporaryDirectory(prefix='openbuff-evidence-restore-') as temporary:
        temporary = Path(temporary)
        archive = temporary / 'objects.tar.xz'
        with archive.open('xb') as output:
            for part in manifest['parts']:
                name = relative_path(part['path'])
                if len(name.parts) != 1:
                    raise ValueError('Archive parts must be adjacent to the manifest')
                source = BASE / part['path']
                if source.is_symlink() or source.stat().st_size != part['bytes'] or sha(source) != part['sha256']:
                    raise ValueError(f'Archive part differs: {part["path"]}')
                with source.open('rb') as stream:
                    shutil.copyfileobj(stream, output, CHUNK_SIZE)
        if archive.stat().st_size != manifest['archive']['bytes'] or sha(archive) != manifest['archive']['sha256']:
            raise ValueError('Combined archive differs from the sealed inventory')
        verified = set()
        if manifest['archive']['compression'] != 'xz':
            raise ValueError('Unsupported archive compression')
        with tarfile.open(archive, 'r|xz') as bundle:
            for member in bundle:
                digest = member.name.removeprefix('sha256/')
                if member.name != f'sha256/{digest}' or digest not in objects or digest in verified:
                    raise ValueError(f'Unexpected archive object: {member.name}')
                if not member.isfile() or member.size != objects[digest]:
                    raise ValueError(f'Invalid archive object: {member.name}')
                stream = bundle.extractfile(member)
                if stream is None:
                    raise ValueError('Missing archive object payload')
                object_path = temporary / digest
                with stream, object_path.open('xb') as output:
                    shutil.copyfileobj(stream, output, CHUNK_SIZE)
                if object_path.stat().st_size != objects[digest] or sha(object_path) != digest:
                    raise ValueError(f'Object checksum differs: {digest}')
                verified.add(digest)
        if verified != set(objects):
            raise ValueError('Archive is missing declared objects')

        # Every part, object, path and existing file validates before any write.
        for entry in pending:
            target = target_path(destination, entry['path'])
            target.parent.mkdir(parents=True, exist_ok=True)
            target_path(destination, entry['path'])
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, entry['mode'])
            with os.fdopen(descriptor, 'wb') as output, (temporary / entry['sha256']).open('rb') as source:
                shutil.copyfileobj(source, output, CHUNK_SIZE)
                os.fchmod(output.fileno(), entry['mode'])
                output.flush()
                os.fsync(output.fileno())

    return {'verified': True, 'files': len(entries), 'objects': len(objects),
            'restored': len(pending), 'checkOnly': check,
            'scope': 'Original evidence/context bytes; no product or milestone acceptance.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--include-context', action='store_true')
    parser.add_argument('--check', action='store_true', help='Verify the complete archive without restoring files')
    options = parser.parse_args()
    print(json.dumps(restore(options.destination, options.include_context, options.check)))
