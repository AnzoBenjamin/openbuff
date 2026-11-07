from pathlib import Path
import datetime
import hashlib
import json
import re
import sys

root = Path('/home/ben/Code/CLI/openbuff')
base = root / 'docs/execution/body-roadmap/evidence'
node, raw_relative = sys.argv[1:]
assert node in ['B01', 'B36']
old_dir = base / node / 'workspace-typecheck-refresh'
destination = base / node / 'workspace-typecheck-refresh-20261107'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}

def write(path, value):
    with path.open('x') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
    return ref(path)

old_path = old_dir / 'approval.json'
old = json.loads(old_path.read_text())
old_review = json.loads((old_dir / 'review.json').read_text())
canonical = ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']
assert old_review['provenance'] == ref(old_path)
assert all(old_review[field] == old[field] for field in canonical)
assert old['reviewer'] == '/root/b03_mutation_evidence'
assert old['reviewer'] not in old['implementationOwners']
assert old['independent'] and old['decision'] == 'approve'
assert all(sha(root / path) == value for path, value in old['sourceContractHashes'].items())
assert all(sha(root / item['path']) == item['sha256'] for item in old['artifacts'])
assert all(sha(root / item['path']) == item['sha256'] for item in old['behaviorOracleArtifacts'])
inspection_path = root / old['currentInspection']['path']
assert ref(inspection_path) == old['currentInspection']
prior = json.loads(inspection_path.read_text())
assert prior['sourceContractHashes'] == old['sourceContractHashes']
assert all(sha(root / path) == value for path, value in prior['dependencyHashesWithoutApproval'].items())

raw_path = root / raw_relative
raw = json.loads(raw_path.read_text())
assert raw['exitCode'] == 0 and raw['sourceUnchangedDuringCommand']
assert raw['sourceBefore'] == raw['sourceAfter']
assert all(sha(root / path) == value for path, value in raw['sourceBefore'].items())
assert raw['toolchain']['version'] == '1.3.5'
assert sha(Path(raw['toolchain']['executable'])) == raw['toolchain']['sha256']
assert raw['argv'] == [raw['toolchain']['executable'], '--no-env-file', 'run', 'typecheck']
assert raw['cwd'] == str(root)
log_path = root / raw['log']
assert sha(log_path) == raw['logSha256']
log = log_path.read_text()
assert 'All type checks passed!' in log
assert len(re.findall(r'typecheck: Exited with code 0', log)) == 11
repair = json.loads((base / 'integration/evaluator-comparison-regression/settled-source-hashes.json').read_text())
assert len(repair) == 6
assert all(raw['sourceBefore'].get(path) == value for path, value in repair.items())

retired, reused = [], []
for reference in old['commandReceipts']:
    path = root / reference['path']
    assert ref(path) == reference
    command = json.loads(path.read_text())
    assert command['sourceBefore'] == command['sourceAfter'] and command['exitCode'] == 0
    assert sha(root / command['log']['path']) == command['log']['sha256']
    drift = [source for source, value in command['sourceBefore'].items() if sha(root / source) != value]
    if path == old_dir / 'command-workspace-typecheck.json':
        retired.append({'receipt': reference, 'driftedInputs': drift, 'newRawInputsAbsentFromHistoricalMap': sorted(set(raw['sourceBefore']) - set(command['sourceBefore']))})
    else:
        assert not drift
        reused.append(reference)
assert len(retired) == 1
assert len(reused) == (6 if node == 'B01' else 2)
command_path = destination / 'command-workspace-typecheck.json'
command_reference = write(command_path, {
    'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': node,
    'name': 'final root all-workspaces typecheck after generated CLI build (shared actual invocation)',
    'argv': raw['argv'], 'cwd': raw['cwd'], 'startedAt': raw['startedAt'], 'finishedAt': raw['finishedAt'],
    'exitCode': raw['exitCode'], 'log': ref(log_path),
    'sourceBefore': raw['sourceBefore'], 'sourceAfter': raw['sourceAfter'],
    'sourceBindingScope': f'Exact {len(raw["sourceBefore"])}-input final root invocation maps, retained without grafting historical 180/1309-input maps or retroactively adding inputs.',
    'provenance': ref(raw_path), 'toolchain': raw['toolchain'], 'environment': raw['environment'],
    'artifacts': [ref(raw_path), ref(log_path)],
})
new_commands = [*reused, command_reference]
current_reads = {path: sha(root / path) for path in sorted(set(prior['sourceBefore']) | set(raw['sourceBefore']) | set(prior['dependencyHashesWithoutApproval']))}
omitted = [path for path in old['sourceContractHashes'] if path not in raw['sourceBefore']]
assert omitted == ([] if node == 'B01' else ['sdk/src/__tests__/node-filesystem.test.ts'])
limits = [limit for limit in old['scopeLimits'] if not limit.startswith('Global typecheck success covers all workspace scripts;') and not limit.startswith('All ') ]
limits.extend([
    f'Final root typecheck script success covers eleven workspaces; the exact recorded map covers {len(raw["sourceBefore"])} inputs. Unchanged scoped behavior receipts cover any source contract omitted from that map.',
    'The reviewer authored the six B30 comparison repair files observed in this global context; their presence is context binding only and confers no independent B30 implementation approval. B30 review belongs to another reviewer.',
    'Historical generated/typecheck maps remain immutable; the first-wave initial command is genuine historical evidence after generated CLI build drift and receives no current command credit.',
    f'All {len(new_commands)} commandReceipts must remain required exactly once; the replacement envelope represents the one shared actual final root invocation.',
])
summary = {
    'schemaVersion': 1, 'nodeId': node, 'reviewer': old['reviewer'],
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'Independently verify the final raw command/log/Bun/current input maps; reuse the latest scoped independent authority only after exact source, dependency, oracle, artifact and unchanged behavior-command hash verification. No product reruns.',
    'originalIndependentAuthority': ref(old_path), 'originalNormalizedReview': ref(old_dir / 'review.json'),
    'sourceContractHashes': old['sourceContractHashes'], 'dependencyHashesWithoutApproval': prior['dependencyHashesWithoutApproval'],
    'historicalReadContextHashes': prior['sourceBefore'],
    'historicalContextDrift': [path for path, value in prior['sourceBefore'].items() if sha(root / path) != value],
    'sourceBefore': current_reads, 'sourceAfter': {path: sha(root / path) for path in current_reads},
    'observedOracles': prior['observedOracles'], 'actualSourceInspection': prior['actualSourceInspection'],
    'retiredCommands': retired, 'reusedCommands': reused,
    'replacementGlobalCommand': ref(raw_path), 'rawTypecheckInputCount': len(raw['sourceBefore']),
    'changedB30FilesAsContextOnly': repair, 'sourceContractsOutsideRawTypecheckMap': omitted,
    'initialHistoricalCommandInspection': ref(destination / 'initial-typecheck-inspection.json'),
    'scopeLimits': limits, 'neededReruns': [],
}
assert summary['sourceBefore'] == summary['sourceAfter']
inspection_reference = write(destination / 'inspection.json', summary)
report_path = destination / 'README.md'
with report_path.open('x') as output:
    output.write(f'''# {node} final workspace-typecheck contextual refresh

The latest `workspace-typecheck-refresh/review.json` is the starting independent authority. Its {len(old['sourceContractHashes'])} exact source contracts, dependency/config hashes, oracle/artifact seals and {len(reused)} unchanged scoped command maps remain current. The original scope/owners and implementation limits are preserved. No scoped product control was rerun.

Only the broad workspace command is superseded. Its historical map and the initial `first-wave-final-20261107/typecheck.json` remain immutable. This reviewer independently inspected the final raw root command, its log, pinned Bun binary, argv/cwd/timing, equal before/after maps and current hashes. The log records all eleven workspace scripts exit zero. The normalized command preserves the actual {len(raw['sourceBefore'])}-input map exactly, including all six B30 comparison repair paths and the new comparator test; no old 180/1309-input map was grafted onto it. Contract paths outside that raw map are {json.dumps(omitted)}; current original behavior receipts bind those paths.

Raw hash/typecheck observation of reviewer-authored B30 files is contextual only: this envelope approves no B30 implementation. Original gate-files fixture and other-card context exclusions remain. Older B01 tail/store/specialist, B36 historical 188-test/postimage and native/installed/provider/OS scopes stay as defined by the original independent authority.

`approval.json` is new original typed independent authority; normalized `review.json` hash-references it and matches canonical scope/source/command fields. The same {len(new_commands)} current commands must remain required exactly once. Actual behavior oracle artifacts remain attached directly. Production, repository tests, old evidence and the real ledger were not edited. The unchanged strict validator is used only in a synthetic format harness, conferring no actual roadmap/prerequisite acceptance.
''')
primary = [item for item in old['artifacts'] if 'typecheck' not in item['path']]
additional = [ref(raw_path), ref(log_path), command_reference, inspection_reference, ref(report_path), ref(Path(__file__).resolve()), ref(destination / 'initial-typecheck-inspection.json'), *old['behaviorOracleArtifacts'], *[ref(root / path) for path in old['sourceContractHashes']]]
artifact_map = {item['path']: item for item in [*primary, *additional]}
supporting = [*old['supportingEvidence'], {**ref(old_path), 'credit': 'raw-data-only', 'reason': 'Latest prior independent scope/source/oracle authority; its broad workspace command is historical and superseded.'}, *[{**item, 'credit': 'raw-data-only', 'reason': 'Historical contextual typecheck provenance; never current passing command credit.'} for item in old['artifacts'] if 'typecheck' in item['path']]]
approval = {
    'schemaVersion': 1, 'type': 'body-independent-approval', 'nodeId': node,
    'reviewer': old['reviewer'], 'implementationOwners': old['implementationOwners'], 'independent': True,
    'decision': 'approve', 'scope': old['scope'], 'sourceContractHashes': old['sourceContractHashes'],
    'commandReceipts': new_commands, 'scopeLimits': limits, 'reviewedAt': summary['checkedAt'],
    'artifacts': list(artifact_map.values()), 'behaviorOracleArtifacts': old['behaviorOracleArtifacts'],
    'currentInspection': inspection_reference, 'supportingEvidence': supporting, 'neededReruns': [],
}
approval_reference = write(destination / 'approval.json', approval)
review = {field: approval[field] for field in canonical}
review.update({'type': 'body-implementation-review', 'provenance': approval_reference, 'artifacts': [*approval['artifacts'], approval_reference], 'supportingEvidence': supporting})
review_reference = write(destination / 'review.json', review)
write(destination / 'behavior-evidence.json', json.loads((old_dir / 'behavior-evidence.json').read_text()))
assert all(review[field] == approval[field] for field in canonical)
assert all(ref(root / item['path']) == item for item in approval['artifacts'])
print(json.dumps({'nodeId': node, 'sourceContracts': len(old['sourceContractHashes']), 'requiredCommands': len(new_commands), 'reusedCommands': len(reused), 'rawInputs': len(raw['sourceBefore']), 'approval': approval_reference, 'review': review_reference}, indent=2))
