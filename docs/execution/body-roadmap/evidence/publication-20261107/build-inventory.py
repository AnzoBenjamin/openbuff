#!/usr/bin/env python3
"""Curate publication dependencies without staging or changing sealed evidence."""
import collections
import datetime
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
PREFIX = 'docs/execution/body-roadmap/'
TRACE = json.loads(gzip.decompress((OUT / 'validator-reference-trace-v2.json.gz').read_bytes()))
records = {}
external = []
contexts = []
issues = []
doc_links = []
parsed = set()
queue = []


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalize(name, parent=None):
    path = Path(name)
    if path.is_absolute():
        try:
            return str(path.relative_to(ROOT))
        except ValueError:
            return None
    if (ROOT / path).is_file() or parent is None:
        return str(path)
    return str((ROOT / parent).parent.joinpath(path).relative_to(ROOT))


def add(name, expected, kind, origin, pointer='', mandatory=False):
    normalized = normalize(name, origin)
    if normalized is None:
        external.append({'path': name, 'sha256': expected, 'kind': kind, 'origin': origin, 'pointer': pointer})
        return
    path = ROOT / normalized
    if not path.is_file():
        issues.append({'kind': 'missing_reference', 'path': normalized, 'origin': origin, 'pointer': pointer, 'expectedSha256': expected})
        return
    actual = digest(path)
    if expected is not None and actual != expected:
        issues.append({'kind': 'hash_mismatch', 'path': normalized, 'origin': origin, 'pointer': pointer, 'expectedSha256': expected, 'actualSha256': actual})
    row = records.setdefault(normalized, {'path': normalized, 'sha256': actual, 'bytes': path.stat().st_size, 'reasons': [], 'validatorRequired': False})
    reason = {'kind': kind, 'origin': origin, 'pointer': pointer}
    if reason not in row['reasons']:
        row['reasons'].append(reason)
    row['validatorRequired'] |= mandatory


for edge in TRACE['fileBindingCalls']:
    add(edge['path'], edge['expectedSha256'], edge['referenceKind'], edge['originDocument'], edge['label'], True)

seeds = [PREFIX + name for name in ['ledger.json', 'validate-ledger.py', 'test-validate-ledger.py', 'run-checks.py', 'seal-acceptance.py', 'README.md', 'execution-plan.json', 'researcher-web-agent-browser.md', 'researcher-web-agent-browser.sources.json']]
seeds += [PREFIX + 'evidence/' + name for name in [
    'integration/architect-first-wave/final-integration/review.json',
    'integration/architect-first-wave/final-integration/manifest.json',
    'integration/first-wave-final-20261107/integration-manifest.json',
    'integration/first-wave-final-20261107/acceptance/inputs.json',
    'integration/first-wave-final-20261107/promotion/promotion.json',
    'integration/first-wave-final-20261107/promotion/ledger-before.json',
    'integration/first-wave-final-20261107/promotion/live-ledger.validation.json',
    'integration/first-wave-final-20261107/promotion/promote.py',
    'RWEB/planning-review/review.json', 'RWEB/planning-review/manifest.json',
]]
for name in seeds:
    add(name, None, 'explicit_publication_seed', 'root assignment')
    if name.endswith('.json') and not name.endswith(('/ledger.json', '/ledger-before.json', '/inputs.json')):
        queue.append(name)

semantic_prefixes = [PREFIX + 'evidence/' + p for p in [
    'integration/architect-first-wave/final-integration/',
    'integration/first-wave-final-20261107/',
    'RWEB/planning-review/', 'RWEB/planning-checks/',
]]
context_fields = {'sourceBefore', 'sourceAfter', 'sourceHashes', 'sourceBindings', 'localSourceHashes', 'localSourceBindings', 'sourceContractHashes', 'currentBindingHashes', 'activeEvidenceHashes', 'finalProtectedHashes', 'protectedFiles', 'protectedFilesBefore', 'protectedFilesAfter', 'configurationHashes', 'dependencyContractHashes', 'frozenPlanHashes', 'currentSourceHashes', 'evidenceAndCurrentSourceHashes'}


def scan(value, origin, pointer=''):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str) and re.fullmatch('[a-f0-9]{64}', str(value.get('sha256', ''))):
            add(value['path'], value['sha256'], 'supplementary_hashed_reference', origin, pointer)
            name = normalize(value['path'], origin)
            if name and name.endswith('.json') and any(name.startswith(p) for p in semantic_prefixes) and not name.endswith(('/candidate-ledger.json', '/ledger-before.json')):
                queue.append(name)
        for key, child in value.items():
            location = pointer + '/' + key
            if key in context_fields and isinstance(child, dict):
                for name, expected in child.items():
                    if not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
                        continue
                    normal = normalize(name, origin)
                    exists = normal is not None and (ROOT / normal).is_file()
                    contexts.append({'path': name, 'sha256': expected, 'origin': origin, 'pointer': location,
                                     'exists': exists, 'currentMatch': exists and digest(ROOT / normal) == expected,
                                     'alreadyRequired': normal in records})
                    if origin in (PREFIX + 'researcher-web-agent-browser.sources.json', PREFIX + 'evidence/RWEB/planning-review/review.json'):
                        add(name, expected, 'planning_source_binding', origin, location)
                continue
            if key in ('log', 'stdout', 'stderr') and isinstance(child, str) and any(field in value for field in ('logSha256', 'logHash')):
                add(child, value.get('logSha256', value.get('logHash')), 'supplementary_command_log', origin, location)
            scan(child, origin, location)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            scan(child, origin, pointer + '/' + str(index))


while queue:
    name = queue.pop()
    if name in parsed or not (ROOT / name).is_file():
        continue
    parsed.add(name)
    scan(json.loads((ROOT / name).read_text()), name)

# Ordinary links remain a distinct, finite documentation companion set.
for name in [PREFIX + 'README.md', PREFIX + 'researcher-web-agent-browser.md']:
    for target in re.findall(r'\]\(([^)]+)\)', (ROOT / name).read_text()):
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
            doc_links.append({'origin': name, 'target': target, 'kind': 'external_or_anchor'})
            continue
        target = target.split('#', 1)[0]
        target = re.sub(r':\d+$', '', target)
        path = (ROOT / name).parent.joinpath(target).resolve()
        try:
            local = str(path.relative_to(ROOT))
        except ValueError:
            doc_links.append({'origin': name, 'target': target, 'kind': 'external_filesystem'})
            continue
        doc_links.append({'origin': name, 'target': target, 'path': local, 'exists': path.is_file(), 'kind': 'ordinary_documentation_link', 'validatorRequired': local in records and records[local]['validatorRequired']})

tracked = set(subprocess.check_output(['git', 'ls-files', '--cached', '-z'], cwd=ROOT).decode().split('\0'))
names = sorted(records)
ignored_run = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin', '-z', '-v'], cwd=ROOT,
                             input=('\0'.join(names) + '\0').encode(), capture_output=True)
assert ignored_run.returncode in (0, 1), ignored_run.stderr.decode()
parts = ignored_run.stdout.decode().split('\0')
ignored = {}
for i in range(0, len(parts) - 1, 4):
    source, line, pattern, name = parts[i:i+4]
    ignored[name] = {'source': source, 'line': line, 'pattern': pattern}


def disposition(name):
    if name.startswith('node_modules/'):
        return 'restore_dependency_context_do_not_stage_node_modules'
    if name.endswith('.pile') or '/home/' in name or '/tmp/' in name or name.endswith(('.sqlite', '.db', '.sqlite-wal', '.sqlite-shm')):
        return 'archive_exact_historical_bytes_restore_at_original_path'
    if name.startswith('cli/bin/') or name.endswith(('.wasm', '.node', '.so', '.dll', '.exe')):
        return 'product_binary_asset_do_not_stage'
    return 'direct_publication_file'


for name, row in records.items():
    row['tracked'] = name in tracked
    row['ignoreRule'] = ignored.get(name)
    row['disposition'] = disposition(name)
    row['forceStageIgnoredLog'] = bool(row['ignoreRule']) and name.endswith('.log') and row['disposition'] == 'direct_publication_file' and not row['tracked']

archive = [row for row in records.values() if row['disposition'].startswith('archive_')]
cache = [row for row in archive if row['path'].endswith('.pile')]
sqlite = [row for row in archive if row['path'].endswith('.sqlite')]


def compression_estimate(rows):
    unique = {row['sha256']: row for row in rows}
    memory = io.BytesIO()
    with tarfile.open(fileobj=memory, mode='w', format=tarfile.USTAR_FORMAT) as archive_file:
        for content_hash, row in sorted(unique.items()):
            data = (ROOT / row['path']).read_bytes()
            info = tarfile.TarInfo('sha256/' + content_hash)
            info.size = len(data)
            info.mode = 0o444
            info.mtime = 0
            archive_file.addfile(info, io.BytesIO(data))
    raw = memory.getvalue()
    return {'paths': len(rows), 'bytesAcrossPaths': sum(row['bytes'] for row in rows), 'distinctSha256Contents': len(unique),
            'deduplicatedBytes': sum(row['bytes'] for row in unique.values()), 'deterministicTarBytes': len(raw),
            'gzipLevel9TarEstimateBytes': len(gzip.compress(raw, compresslevel=9, mtime=0)),
            'packWritten': False, 'method': 'Measured in-memory USTAR of one sha256-named object per distinct hash, fixed metadata, gzip level 9; no pack written.'}

compression = {kind: compression_estimate(rows) for kind, rows in [('requiredPileCaches', cache), ('requiredSQLiteOracles', sqlite), ('allProposedArchiveFiles', archive)]}
scratch_groups = collections.defaultdict(set)
for row in archive:
    for reason in row['reasons']:
        if reason['kind'] == 'hashed_artifact_or_authority':
            scratch_groups[(reason['origin'], reason['pointer'])].add(row['path'])
all_piles = list((ROOT / (PREFIX + 'evidence')).rglob('*.pile'))
required_piles = {row['path'] for row in cache}
excluded_piles = [{'path': str(p.relative_to(ROOT)), 'bytes': p.stat().st_size} for p in all_piles if str(p.relative_to(ROOT)) not in required_piles]
for path, row in records.items():
    assert digest(ROOT / path) == row['sha256'], ('inventory source drift', path)

outputs = {
    'required-files.json': {'schemaVersion': 1, 'kind': 'publication_dependency_inventory', 'scope': 'Exact live ledger validator closure plus named final architecture/integration/promotion/RWEB planning seeds and their declared supplementary references; no recursive interpretation of sealed historical raw JSON.', 'seeds': seeds, 'files': [records[name] for name in sorted(records)], 'issues': issues},
    'archive-requirements.json': {'schemaVersion': 1, 'files': sorted(archive, key=lambda row: row['path']), 'compression': compression, 'authorities': [{'origin': origin, 'label': label, 'files': sorted(files)} for (origin, label), files in sorted(scratch_groups.items())], 'disposition': 'Preserve exact historical bytes. Incidental cache seals are mandatory validator bindings, not product behavior or capability claims. SQLite journal fixtures are intentional oracle evidence. No archive or rehydrator was implemented.'},
    'context-and-exclusions.json': {'schemaVersion': 1, 'contextualHashMaps': contexts, 'externalStructuredReferences': external, 'ordinaryDocumentationLinks': doc_links, 'excludedUnreferencedPileFiles': excluded_piles, 'excludedFeasibilityScope': 'RWEB/feasibility is leader-owned future work; /tmp toolchain/home/browser distributions are excluded.', 'opaqueHistoricalJSONRule': 'Validator original_artifacts hashes raw artifacts without interpreting their internals. Stale historical maps and ordinary command argv do not recursively pull caches or external toolchains into active closure.'},
    'ignored-required-files.json': {'schemaVersion': 1, 'files': [records[name] for name in sorted(ignored)], 'forceStageDirectLogs': [name for name in names if records[name]['forceStageIgnoredLog']], 'dependencyContext': [records[name] for name in names if records[name]['disposition'].startswith('restore_dependency')], 'ignoredGeneratedContext': [records[name] for name in names if records[name]['ignoreRule'] and ('generated' in name or name.startswith('node_modules/'))]},
}
for name, value in outputs.items():
    with (OUT / name).open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
for name, subset in [
    ('required-files.nul', names),
    ('direct-publication-files.nul', [name for name in names if records[name]['disposition'] == 'direct_publication_file']),
    ('required-archive-files.nul', [row['path'] for row in sorted(archive, key=lambda row: row['path'])]),
    ('force-stage-logs.nul', [name for name in names if records[name]['forceStageIgnoredLog']]),
]:
    with (OUT / name).open('xb') as handle:
        handle.write(('\0'.join(subset) + '\0').encode())
summary = {'schemaVersion': 1, 'validator': TRACE['validation'], 'requiredFiles': len(records), 'requiredBytes': sum(row['bytes'] for row in records.values()),
           'byDisposition': {kind: {'files': len(rows), 'bytes': sum(row['bytes'] for row in rows)} for kind in sorted({row['disposition'] for row in records.values()}) if (rows := [row for row in records.values() if row['disposition'] == kind])},
           'ignoredDirectLogs': len([row for row in records.values() if row['forceStageIgnoredLog']]), 'compression': compression,
           'excludedUnreferencedPiles': {'files': len(excluded_piles), 'bytes': sum(row['bytes'] for row in excluded_piles)},
           'externalStructuredReferences': len(external), 'issues': issues, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stagedOrModifiedExistingFiles': False}
with (OUT / 'summary.json').open('x') as handle:
    json.dump(summary, handle, indent=2)
    handle.write('\n')
print(json.dumps({key: value for key, value in summary.items() if key != 'validator'}, indent=2))
