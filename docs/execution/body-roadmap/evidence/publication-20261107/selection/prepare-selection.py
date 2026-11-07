#!/usr/bin/env python3
"""Build explicit source/evidence staging lists without staging scratch trees."""

import hashlib
import json
from pathlib import Path
import subprocess

if not __debug__:
    raise RuntimeError('Refusing publication selection with optimized Python.')

ROOT = Path(__file__).resolve().parents[6]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/publication-20261107'
OUT = Path(__file__).resolve().parent
SOURCE_ROOTS = ('agents/', 'cli/', 'common/', 'evals/', 'packages/', 'scripts/', 'sdk/', 'test/')
paths = set()


def nul(path):
    return [value.decode() for value in path.read_bytes().split(b'\0') if value]


def git_paths(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=True)
    return [value.decode() for value in result.stdout.split(b'\0') if value]


paths.update(nul(BASE / 'curated-direct-files.nul'))
paths.update(nul(BASE / 'inventory-artifacts.nul'))
paths.update(nul(BASE / 'ordinary-doc-companions.nul'))
paths.update(git_paths('diff', '--name-only', '-z'))
new_sources = git_paths('ls-files', '--others', '--exclude-standard', '-z', '--',
                        'agents', 'cli', 'common', 'evals', 'packages', 'scripts', 'sdk', 'test')
assert len(new_sources) == 27
assert all(Path(name).suffix == '.ts' for name in new_sources)
paths.update(new_sources)
paths.update(['.prettierignore', 'docs/execution/body-roadmap/STATE.md',
              str(Path(__file__).relative_to(ROOT))])
for directory in [
    '.agents/sessions/body-capability-review-2026-11-05',
    'docs/execution/body-roadmap/evidence/B05/preparation',
    'docs/execution/body-roadmap/evidence/B19/preparation',
    'docs/execution/body-roadmap/evidence/RWEB/feasibility',
    'docs/execution/body-roadmap/evidence/RWEB/feasibility-independent-review',
    'docs/execution/body-roadmap/evidence/publication-20261107/archive',
]:
    for path in (ROOT / directory).rglob('*'):
        if path.is_file() and '__pycache__' not in path.parts:
            paths.add(str(path.relative_to(ROOT)))

for name in paths:
    path = Path(name)
    assert not path.is_absolute() and '..' not in path.parts
    assert (ROOT / path).is_file(), ('missing selection', name)
    assert 'node_modules' not in path.parts and path.suffix != '.pile'
    assert not name.startswith('cli/bin/')
    assert not name.startswith('.agents/sessions/error-root-cause-2026-10/')
    assert path.suffix not in {'.sqlite', '.sqlite-shm', '.sqlite-wal', '.node', '.wasm', '.exe', '.tgz'}
required = json.loads((BASE / 'curated-required-files.json').read_text())
for item in required['files']:
    if item['disposition'] == 'direct_publication_file':
        assert item['path'] in paths
        assert hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest() == item['sha256']

ordered = sorted(paths)
input_bytes = b'\0'.join(name.encode() for name in ordered) + b'\0'
ignored = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin', '-z'],
                          cwd=ROOT, input=input_bytes, capture_output=True)
assert ignored.returncode in (0, 1)
force = {value.decode() for value in ignored.stdout.split(b'\0') if value}
source = {name for name in paths if name.startswith(SOURCE_ROOTS)
          or name in {'.prettierignore', 'docs/configuration.md', 'docs/request-flow.md'}}
groups = {'regular': paths - force, 'force': force, 'source': source,
          'evidence': paths - source, 'all': paths}
for label, values in groups.items():
    path = Path('/tmp') / f'openbuff-firstwave-{label}.nul'
    path.write_bytes(b'\0'.join(name.encode() for name in sorted(values)) + b'\0')
summary = {'schemaVersion': 1, 'type': 'explicit-first-wave-publication-selection',
           'fileCount': len(paths), 'sourceFiles': len(source), 'evidenceFiles': len(paths - source),
           'explicitIgnoredFiles': len(force),
           'bytes': sum((ROOT / name).stat().st_size for name in paths),
           'files': [{'path': name, 'sha256': hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
                      'bytes': (ROOT / name).stat().st_size, 'source': name in source,
                      'forceStageRequired': name in force} for name in ordered],
           'scope': 'Reviewed source plus exact acceptance/plan/browser feasibility evidence and restoration pack; no unreferenced caches, node_modules tree, product binary or unrelated session.'}
with (OUT / 'selection.json').open('x') as output:
    json.dump(summary, output, indent=2)
    output.write('\n')
print(json.dumps({key: value for key, value in summary.items() if key != 'files'}))
