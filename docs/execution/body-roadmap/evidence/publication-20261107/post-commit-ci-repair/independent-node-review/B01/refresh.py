"""Renew only B01/B36 shared typecheck context; preserve prior bounded authority."""

from pathlib import Path
import datetime
import hashlib
import json
import re
import sys

assert __debug__, 'Refuse evidence generation with disabled assertions.'
root = Path('/home/ben/Code/CLI/openbuff')
base = root / 'docs/execution/body-roadmap/evidence'
publication = base / 'publication-20261107/post-commit-ci-repair'
node = sys.argv[1]
assert node in ['B01', 'B36']
destination = publication / 'independent-node-review' / node
destination.mkdir(parents=True, exist_ok=True)
old_dir = base / node / 'workspace-typecheck-refresh-20261107'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}


def verify_ref(reference):
    assert ref(root / reference['path']) == {key: reference[key] for key in ['path', 'sha256']}


def write(path, value):
    with path.open('x') as output:
        if isinstance(value, str):
            output.write(value)
        else:
            json.dump(value, output, indent=2)
            output.write('\n')
    return ref(path)


expected_authority = {
    'B01': ['d5cc31d35f71fe64f650c12f7e9e61b6946aa897120e0256932c0410c38791b2',
            '3ac61eba60c9330c4876974df8e5f18161fe38fe5380cf815810f9b1b164ca71'],
    'B36': ['d3508960ec9862bd7ef75ac5973f268fff774082a17e12e4470d09f940b8d34a',
            '55ec7711acbfde8522cc889f62071df8cd4fc04b2c1f6f51431a2ae32cb750f8'],
}
assert [sha(old_dir / name) for name in ['approval.json', 'review.json']] == expected_authority[node]
old_path = old_dir / 'approval.json'
old = json.loads(old_path.read_text())
old_review = json.loads((old_dir / 'review.json').read_text())
canonical = ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent',
             'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']
assert old_review['provenance'] == ref(old_path)
assert all(old_review[field] == old[field] for field in canonical)
assert old['reviewer'] == '/root/b03_mutation_evidence'
assert old['reviewer'] not in old['implementationOwners']
assert old['independent'] and old['decision'] == 'approve'
assert len(old['sourceContractHashes']) == (11 if node == 'B01' else 15)
assert all(sha(root / path) == value for path, value in old['sourceContractHashes'].items())
for artifact in [*old['artifacts'], *old['behaviorOracleArtifacts']]:
    verify_ref(artifact)
verify_ref(old['currentInspection'])
prior = json.loads((root / old['currentInspection']['path']).read_text())
assert prior['sourceContractHashes'] == old['sourceContractHashes']
assert all(sha(root / path) == value for path, value in prior['dependencyHashesWithoutApproval'].items())
assert sha(root / '.agents/types/tools.ts') == 'c4121c5fd085f6bf68aa312658a73e3d2d9d4009859ea72e0af73be447e7c53f'
validator_path = root / 'docs/execution/body-roadmap/validate-ledger.py'
assert sha(validator_path) == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'

root_receipts = {}
for name in ['guard-tests', 'guard-memory-drift', 'typecheck']:
    path = publication / 'commands' / name / f'{name}.json'
    receipt = json.loads(path.read_text())
    assert receipt['check'] == name and receipt['exitCode'] == 0
    assert (path.parent / f'{name}.exit').read_text().strip() == '0'
    assert receipt['sourceUnchangedDuringCommand']
    assert receipt['sourceBefore'] == receipt['sourceAfter']
    assert len(receipt['sourceBefore']) == 187
    assert all(sha(root / source) == value for source, value in receipt['sourceBefore'].items())
    assert receipt['toolchain']['version'] == '1.3.5'
    assert sha(Path(receipt['toolchain']['executable'])) == receipt['toolchain']['sha256']
    assert receipt['cwd'] == str(root)
    assert receipt['environment']['replacement'] and receipt['environment']['ephemeralHome']
    assert receipt['environment']['envFileLoading'] is False
    verify_ref(receipt['inputScope'])
    log = root / receipt['log']
    assert sha(log) == receipt['logSha256']
    root_receipts[name] = {'receipt': ref(path), 'log': ref(log), 'value': receipt}
raw_path = root / root_receipts['typecheck']['receipt']['path']
raw = root_receipts['typecheck']['value']
assert raw['argv'] == [raw['toolchain']['executable'], '--no-env-file', 'run', 'typecheck']
log_path = root / raw['log']
log = log_path.read_text()
assert 'All type checks passed!' in log
assert len(re.findall(r'typecheck: Exited with code 0', log)) == 11
assert root_receipts['guard-tests']['value']['counts'] == {'pass': 69, 'fail': 0}
assert '0 findings across 12 checkers' in (root / root_receipts['guard-memory-drift']['log']['path']).read_text()
for item in root_receipts.values():
    assert item['value']['sourceBefore'] == raw['sourceBefore']

command_path = publication / 'normalized-commands' / f'{node}-command-workspace-typecheck.json'
expected_command = {'B01': '6934e96975e1ce08f0070ad0530c9019afbfb7c070438c5b9e152fd99b452dc6',
                    'B36': 'b4ed1721fa0dcf982ffd056ce10c4f2e9f51cf060c4bf4252a53cb6cebb8eca7'}
assert sha(command_path) == expected_command[node]
command = json.loads(command_path.read_text())
assert command['type'] == 'body-acceptance-command' and command['nodeId'] == node
for field in ['argv', 'cwd', 'startedAt', 'finishedAt', 'exitCode', 'sourceBefore', 'sourceAfter', 'toolchain', 'environment']:
    assert command[field] == raw[field]
assert command['provenance'] == ref(raw_path) and command['log'] == ref(log_path)
for artifact in command['artifacts']:
    verify_ref(artifact)

retired, reused = [], []
for reference in old['commandReceipts']:
    verify_ref(reference)
    path = root / reference['path']
    receipt = json.loads(path.read_text())
    assert receipt['sourceBefore'] == receipt['sourceAfter'] and receipt['exitCode'] == 0
    verify_ref(receipt['log'])
    drift = [source for source, value in receipt['sourceBefore'].items() if sha(root / source) != value]
    if path == old_dir / 'command-workspace-typecheck.json':
        assert sorted(drift) == ['scripts/__tests__/memory-drift-guard.test.ts', 'scripts/memory-drift-guard.ts']
        retired.append({'receipt': reference, 'driftedInputs': drift,
                        'newRawInputsAbsentFromHistoricalMap': sorted(set(raw['sourceBefore']) - set(receipt['sourceBefore']))})
    else:
        assert not drift
        reused.append(reference)
assert len(retired) == 1 and len(reused) == (6 if node == 'B01' else 2)
commands = [*reused, ref(command_path)]
omitted = [path for path in old['sourceContractHashes'] if path not in raw['sourceBefore']]
assert omitted == ([] if node == 'B01' else ['sdk/src/__tests__/node-filesystem.test.ts'])

guard_manifest_path = publication / 'independent-review/manifest.json'
assert sha(guard_manifest_path) == '3e675f3a479431b9df553b7f3dfb42134daee3c6f676d893ba3114c9d86466e5'
controls_path = publication / 'independent-review/guard-fix-controls.json'
controls = json.loads(controls_path.read_text())
assert controls['passed'] and controls['sourceUnchangedDuringControls']
assert all(sha(root / path) == value for path, value in controls['sourceHashes'].items())
for snapshot in controls['immutableSnapshots']:
    verify_ref(snapshot)
    assert snapshot['matchesCommittedBytes']
assert [(item['exitCode'], item['expectedExitCode'], item['result']['passed'])
        for item in controls['independentControls']] == [(1, 1, False), (0, 0, True)]
guard_review_path = publication / 'independent-review/REVIEW.md'
guard_observation = write(destination / 'publication-guard-observation.json', {
    'schemaVersion': 1, 'reviewer': old['reviewer'], 'purpose': 'Publication repair context only; original node implementation scope remains unchanged.',
    'sourceHashes': controls['sourceHashes'], 'independentSmallFixAuthority': ref(guard_manifest_path),
    'independentControls': ref(controls_path), 'independentReport': ref(guard_review_path),
    'observations': [
        'Inspected guard diff, new regression and Markdown traversal: an exact-path Set excludes only four immutable RWEB snapshots; enclosing-directory traversal appends a slash and remains active.',
        'Portable project-relative spelling is used; existing prefix exclusions are unchanged; other guard/test diff changes are formatting only.',
        'New regression tests four checkers in direct/shared-snapshot modes against four archived and six active neighboring files. Independently recorded controls additionally retain backup suffix and unrelated same-basename documents.',
        'Knowledge additions describe already accepted outcome/mutation boundaries and link the active checkpoint. They introduce no guard bypass or forged review receipt.',
        'All three root receipt logs, pinned Bun identity, equal 187-input maps and current hashes were independently verified; no scoped behavior commands were rerun.',
    ],
    'rootChecks': [{key: item[key] for key in ['receipt', 'log']} for item in root_receipts.values()],
    'scopeLimits': ['No other card implementation or broader native/provider/installed/OS guarantee is approved here.', 'B04 independent probe is reused without rerunning it.'],
})

limits = [limit.replace('recorded map covers 182 inputs', 'recorded map covers 187 inputs')
          for limit in old['scopeLimits']]
reads = {path: sha(root / path) for path in sorted(set(prior['sourceBefore']) | set(raw['sourceBefore']) | set(prior['dependencyHashesWithoutApproval']))}
summary = {
    'schemaVersion': 1, 'nodeId': node, 'reviewer': old['reviewer'],
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'Independently inspect publication guard source/regression and sealed controls; verify fresh raw/normalized command provenance, logs, Bun and exact current maps; reuse original bounded implementation authority only after exact source/dependency/artifact/oracle/scoped-command integrity verification. No product reruns.',
    'originalIndependentAuthority': ref(old_path), 'originalNormalizedReview': ref(old_dir / 'review.json'),
    'sourceContractHashes': old['sourceContractHashes'], 'dependencyHashesWithoutApproval': prior['dependencyHashesWithoutApproval'],
    'historicalReadContextHashes': prior['sourceBefore'],
    'historicalContextDrift': [path for path, value in prior['sourceBefore'].items() if sha(root / path) != value],
    'sourceBefore': reads, 'sourceAfter': {path: sha(root / path) for path in reads},
    'observedOracles': prior['observedOracles'], 'actualSourceInspection': prior['actualSourceInspection'],
    'actualSourceInspectionCredit': 'Prior bounded source observations retained because all implementation contracts and scoped behavioral inputs are unchanged; newly inspected publication guard observations are separate contextual evidence.',
    'retiredCommands': retired, 'reusedCommands': reused, 'replacementGlobalCommand': ref(raw_path),
    'replacementNormalizedCommand': ref(command_path), 'rawTypecheckInputCount': len(raw['sourceBefore']),
    'sourceContractsOutsideRawTypecheckMap': omitted, 'publicationGuardObservation': guard_observation,
    'scopeLimits': limits, 'neededReruns': [],
}
assert summary['sourceBefore'] == summary['sourceAfter']
inspection = write(destination / 'inspection.json', summary)
readme = write(destination / 'README.md', f'''# {node} publication typecheck contextual renewal

The latest accepted independent authority is `{node}/workspace-typecheck-refresh-20261107/review.json`. Its {len(old['sourceContractHashes'])} implementation contract hashes, original owners, behavior oracle artifacts, dependency/config hashes and {len(reused)} scoped commands remain unchanged and were independently checked. No scoped product command was rerun; prior bounded source observations retain their original provenance.

Only the shared root typecheck credit is replaced. The fresh command passed all eleven workspaces with exactly 187 stable/current declared inputs. Its normalized node-specific receipt preserves raw argv/cwd/timing, pinned Bun 1.3.5, replacement environment, log and exact before/after maps. Historical maps remain immutable and receive no current typecheck command credit. Contracts outside that map: {json.dumps(omitted)}; unchanged scoped behavior receipts cover those contracts.

The publication guard observation records the exact four immutable RWEB exclusions, active-neighbor regression controls, independent probe provenance and successful guard receipts. These are contextual observations and do not expand the node implementation scope. Existing exclusions for reviewer-owned B01 tail/store, gate-files fixtures, B30 comparison repairs and all native/provider/installed/OS graduation limits remain unchanged.

`approval.json` is new typed independent authority. `review.json` hash-references it and matches all canonical fields. Exactly {len(commands)} commands remain required once each. Behavior oracle artifacts remain attached directly. Only this owned evidence tree was written; no production/tests/ledger, Git staging or historical evidence was changed. The frozen strict validator is exercised in an isolated format harness that grants no actual roadmap acceptance.
''')
additional = [ref(raw_path), ref(log_path), ref(command_path), inspection, readme,
              guard_observation, ref(guard_manifest_path), ref(guard_review_path), ref(controls_path),
              ref(Path(__file__).resolve()), *[item[key] for item in root_receipts.values() for key in ['receipt', 'log']]]
artifacts = {item['path']: item for item in [*old['artifacts'], *additional]}
supporting = [*old['supportingEvidence'],
              {**ref(old_path), 'credit': 'raw-data-only', 'reason': 'Latest historical bounded implementation authority; shared typecheck command is superseded.'},
              {**ref(old_dir / 'review.json'), 'credit': 'raw-data-only', 'reason': 'Historical normalized authority; no current command credit.'},
              {**retired[0]['receipt'], 'credit': 'raw-data-only', 'reason': 'Immutable historical workspace map predates the publication guard repair.'}]
approval = {
    'schemaVersion': 1, 'type': 'body-independent-approval', 'nodeId': node,
    'reviewer': old['reviewer'], 'implementationOwners': old['implementationOwners'], 'independent': True,
    'decision': 'approve', 'scope': old['scope'], 'sourceContractHashes': old['sourceContractHashes'],
    'commandReceipts': commands, 'scopeLimits': limits, 'reviewedAt': summary['checkedAt'],
    'artifacts': list(artifacts.values()), 'behaviorOracleArtifacts': old['behaviorOracleArtifacts'],
    'currentInspection': inspection, 'supportingEvidence': supporting, 'neededReruns': [],
}
approval_reference = write(destination / 'approval.json', approval)
review = {field: approval[field] for field in canonical}
review.update({'type': 'body-implementation-review', 'provenance': approval_reference,
               'artifacts': [*approval['artifacts'], approval_reference], 'supportingEvidence': supporting})
review_reference = write(destination / 'review.json', review)
write(destination / 'behavior-evidence.json', json.loads((old_dir / 'behavior-evidence.json').read_text()))
assert all(review[field] == approval[field] for field in canonical)
for artifact in approval['artifacts']:
    verify_ref(artifact)
print(json.dumps({'nodeId': node, 'sourceContracts': len(old['sourceContractHashes']),
                  'requiredCommands': len(commands), 'reusedCommands': len(reused), 'rawInputs': len(raw['sourceBefore']),
                  'approval': approval_reference, 'review': review_reference}, indent=2))
