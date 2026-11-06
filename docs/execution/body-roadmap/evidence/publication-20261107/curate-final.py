#!/usr/bin/env python3
"""Produce compact final publication and restoration inventories; no staging."""
import collections
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
inventory = json.loads((OUT / 'required-files.json').read_text())
context = json.loads((OUT / 'context-and-exclusions.json').read_text())
initial = json.loads((OUT / 'summary.json').read_text())
rows = inventory['files']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def estimate(selected):
    unique = {row['sha256']: row for row in selected}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for digest, row in sorted(unique.items()):
            data = (ROOT / row['path']).read_bytes()
            entry = tarfile.TarInfo('sha256/' + digest)
            entry.size = len(data)
            entry.mode = 0o444
            entry.mtime = 0
            tar.addfile(entry, io.BytesIO(data))
    data = buf.getvalue()
    return {'pathCount': len(selected), 'originalBytes': sum(row['bytes'] for row in selected),
            'distinctContentHashes': len(unique), 'deduplicatedBytes': sum(row['bytes'] for row in unique.values()),
            'ustarBytes': len(data), 'gzipLevel9Bytes': len(gzip.compress(data, compresslevel=9, mtime=0)), 'archiveWritten': False}


compact = []
for row in rows:
    if '/.openbuff/' in row['path']:
        row['disposition'] = 'archive_exact_historical_bytes_restore_at_original_path'
    elif row['path'] == 'cli/src/agents/bundled-agents.generated.ts':
        row['disposition'] = 'restore_generated_context_or_explicitly_stage_exact_source'
    kinds = sorted({reason['kind'] for reason in row['reasons']})
    origins = sorted({reason['origin'] for reason in row['reasons'] if reason['origin']})
    compact.append({key: row[key] for key in ['path', 'sha256', 'bytes', 'validatorRequired', 'tracked', 'ignoreRule', 'disposition']}
                   | {'reasonKinds': kinds, 'reason': row['reasons'][0], 'bindingEdgeCount': len(row['reasons']),
                      'originDocumentCount': len(origins), 'fullAuthorityEvidence': 'validator-reference-trace-v2.json.gz'})
archives = [row for row in rows if row['disposition'].startswith('archive_')]
restorable_context = [row for row in rows if row['disposition'].startswith('restore_')]
direct = [row for row in compact if row['disposition'] == 'direct_publication_file']
profiles = [row for row in archives if '/.openbuff/' in row['path']]
assert len(compact) == len(direct) + len(archives) + len(restorable_context)
external_mentions = collections.defaultdict(set)
repo_binary_context = collections.defaultdict(set)
supplementary_json = {reason['origin'] for row in rows for reason in row['reasons']
                      if reason['kind'] in ('supplementary_hashed_reference', 'supplementary_command_log', 'planning_source_binding')}


def paths(value, origin):
    if isinstance(value, dict):
        for child in value.values():
            paths(child, origin)
    elif isinstance(value, list):
        for child in value:
            paths(child, origin)
    elif isinstance(value, str) and value.startswith('/') and '\n' not in value:
        path = Path(value)
        try:
            name = str(path.relative_to(ROOT))
        except ValueError:
            external_mentions[value].add(origin)
        else:
            if name.startswith('cli/bin/') or name.endswith(('.wasm', '.node', '.so', '.exe')):
                repo_binary_context[name].add(origin)


for name in supplementary_json:
    if name and name.endswith('.json'):
        paths(json.loads((ROOT / name).read_text()), name)
compression = {'mandatoryPileCaches': initial['compression']['requiredPileCaches'],
               'mandatorySQLiteOracles': initial['compression']['requiredSQLiteOracles'],
               'allHistoricalArchiveFilesIncludingFixtureMemory': estimate(archives),
               'allRestorationBytesIncludingGeneratedAndDependencyContext': estimate(archives + restorable_context)}
authorities = collections.defaultdict(set)
for row in archives:
    for reason in row['reasons']:
        if reason['kind'] == 'hashed_artifact_or_authority':
            authorities[(reason['origin'], reason['pointer'])].add(row['path'])
final = {'schemaVersion': 1, 'scope': inventory['scope'], 'validatorRequiredFiles': 2546,
         'requiredFiles': len(compact), 'requiredBytes': sum(row['bytes'] for row in compact),
         'files': compact, 'issues': inventory['issues'],
         'important': 'required-files.nul is the complete restore closure, NOT a stage-all list. Use curated-direct-files.nul only for ordinary files; archive/restoration choices remain explicit.'}
archive_doc = {'schemaVersion': 1, 'files': [row for row in compact if row['disposition'].startswith('archive_')],
               'contextRestoration': [{key: row[key] for key in ['path', 'sha256', 'bytes', 'disposition']} for row in restorable_context],
               'compression': compression, 'fixtureMemoryFiles': len(profiles), 'fixtureMemoryBytes': sum(row['bytes'] for row in profiles),
               'originalAuthorities': [{'origin': origin, 'validatorLabel': label, 'files': sorted(names)} for (origin, label), names in sorted(authorities.items())],
               'noArchiveWritten': True,
               'interpretation': 'B04/B18 pile caches and historical temporary job files are mandatory incidental broad seals; B02 journal databases and sealed fixture memory are historical consumer evidence. Byte preservation does not grant additional product assurance.'}
summary = {'schemaVersion': 1, 'liveLedgerSha256': '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758',
           'validatorSha256': '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c',
           'validatorValid': initial['validator']['valid'], 'requiredFiles': len(rows),
           'directFiles': len(direct), 'directBytes': sum(row['bytes'] for row in direct),
           'archiveFiles': len(archives), 'archiveBytes': sum(row['bytes'] for row in archives),
           'contextRestoreFiles': len(restorable_context), 'contextRestoreBytes': sum(row['bytes'] for row in restorable_context),
           'ignoredDirectLogs': len([row for row in direct if row['ignoreRule'] and row['path'].endswith('.log') and not row['tracked']]),
           'compression': compression, 'excludedUnreferencedPiles': initial['excludedUnreferencedPiles'],
           'missingOrMismatchedRequiredBindings': inventory['issues'],
           'publicationReadyWithoutRestore': False,
           'remainingPublicationWork': 'Root chooses archive/restoration handling and verifies a fresh checkout; do not omit mandatory sealed bytes or stage node_modules/product binaries.',
           'noExistingSourceEvidenceOrLedgerEdited': True, 'nothingStaged': True}
for name, data in [('curated-required-files.json', final), ('curated-archive-requirements.json', archive_doc), ('final-summary.json', summary),
                   ('external-context-paths.json', {'externalStructuredReferences': context['externalStructuredReferences'],
                                                    'externalPathMentions': [{'path': name, 'origins': sorted(origins), 'publication': 'environment context; do not stage'} for name, origins in sorted(external_mentions.items())],
                                                    'repoProductBinaryContext': [{'path': name, 'origins': sorted(origins), 'publication': 'build/install context only; do not stage'} for name, origins in sorted(repo_binary_context.items())],
                                                    'excludedRwebFeasibility': 'Root-owned future documents and /tmp distribution/home/browser data are not part of this inventory.'})]:
    with (OUT / name).open('x') as handle:
        json.dump(data, handle, indent=2)
        handle.write('\n')
lists = {'curated-direct-files.nul': [row['path'] for row in direct],
         'curated-archive-files.nul': [row['path'] for row in archives],
         'context-restoration-files.nul': [row['path'] for row in restorable_context],
         'ordinary-doc-companions.nul': [row['path'] for row in context['ordinaryDocumentationLinks'] if row.get('exists') and row['path'] not in {item['path'] for item in compact}]}
for name, values in lists.items():
    with (OUT / name).open('xb') as handle:
        handle.write(('\0'.join(sorted(values)) + '\0').encode() if values else b'')
with (OUT / 'context-and-exclusions.json.gz').open('xb') as handle:
    handle.write(gzip.compress((OUT / 'context-and-exclusions.json').read_bytes(), compresslevel=9, mtime=0))
for row in compact:
    assert sha(ROOT / row['path']) == row['sha256'], ('final drift', row['path'])
print(json.dumps(summary, indent=2))
