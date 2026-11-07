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
publication = base / 'publication-20261107/post-remote-ci-repair'
previous_publication = base / 'publication-20261107/post-commit-ci-repair'
node = sys.argv[1]
assert node in ['B01', 'B36']
destination = publication / 'independent-node-review' / node
destination.mkdir(parents=True, exist_ok=True)
old_dir = previous_publication / 'independent-node-review' / node
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
    'B01': ['ed536e1d9724790d05ffe76eecf7c0a2c03663e2c99fb7c0a5bc782c378605fc',
            'e104687798891af8c0c0b819828bc69b7c7a91ac7b0e79dab77a2a53e5cceaf1'],
    'B36': ['c965379ac0908029ae8ddcfec6398f97c30289675858f0e910cb81501b0d4cae',
            '5be413776644461f9fc56522e1cd56aabafe77a6ab2d4113598e5929a2495c2a'],
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
    assert len(receipt['sourceBefore']) == 193
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
assert root_receipts['guard-tests']['value']['counts'] == {'pass': 71, 'fail': 0}
assert '0 findings across 12 checkers' in (root / root_receipts['guard-memory-drift']['log']['path']).read_text()
for item in root_receipts.values():
    assert item['value']['sourceBefore'] == raw['sourceBefore']

assert sha(raw_path) == '975d4370a7d785d874b98a53dbfa07acee3f716927e9456183cc3f6f33cd45c5'
previous_raw = json.loads((previous_publication / 'commands/typecheck/typecheck.json').read_text())
assert set(previous_raw['sourceBefore']) <= set(raw['sourceBefore'])
assert sorted(set(raw['sourceBefore']) - set(previous_raw['sourceBefore'])) == sorted([
    'cli/scripts/prebuild-agents.ts', 'sdk/scripts/build.ts',
    'agents/e2e/gate-aux-ordering.e2e.test.ts', 'agents/e2e/gate-lifecycle.e2e.test.ts',
    '.github/workflows/rust-workspace.yml', str((publication / 'record-check.py').relative_to(root)),
])
command_path = publication / 'normalized-commands' / f'{node}-command-workspace-typecheck.json'
command_path.parent.mkdir(parents=True, exist_ok=True)
write(command_path, {
    'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': node,
    'name': 'root all-workspaces typecheck after remote CI generated-output guard repair (shared actual invocation)',
    **{field: raw[field] for field in ['argv', 'cwd', 'startedAt', 'finishedAt', 'exitCode', 'sourceBefore', 'sourceAfter', 'toolchain', 'environment']},
    'log': ref(log_path),
    'sourceBindingScope': 'Exact 193-input maps from one fresh invocation: preserve all prior 187 declared inputs and prospectively add both generated-output producers, two later E2E fixtures, Rust workflow and this recorder. Historical maps remain immutable.',
    'provenance': ref(raw_path), 'artifacts': [ref(raw_path), ref(log_path)],
})
command = json.loads(command_path.read_text())
assert command['type'] == 'body-acceptance-command' and command['nodeId'] == node
for field in ['argv', 'cwd', 'startedAt', 'finishedAt', 'exitCode', 'sourceBefore', 'sourceAfter', 'toolchain', 'environment']:
    assert command[field] == raw[field]
assert command['provenance'] == ref(raw_path) and command['log'] == ref(log_path)

retired, reused = [], []
for reference in old['commandReceipts']:
    verify_ref(reference)
    path = root / reference['path']
    receipt = json.loads(path.read_text())
    assert receipt['sourceBefore'] == receipt['sourceAfter'] and receipt['exitCode'] == 0
    verify_ref(receipt['log'])
    drift = [source for source, value in receipt['sourceBefore'].items() if sha(root / source) != value]
    if path == previous_publication / 'normalized-commands' / f'{node}-command-workspace-typecheck.json':
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
assert sha(guard_manifest_path) == '692ed8c437ae2629e3a8f47d72a376602690e14427cd8d4ea9cc32c733aa4c5d'
guard_manifest = json.loads(guard_manifest_path.read_text())
for item in guard_manifest['files']:
    verify_ref(item)
guard_authority_path = publication / 'independent-review/review.json'
assert sha(guard_authority_path) == 'd915bbbc42b0dc8c683767378ef37ca26e1183f858a00c731ed72cfb9ebdde0c'
guard_authority = json.loads(guard_authority_path.read_text())
assert guard_authority['decision'] == 'approve-three-source-ci-repair' and not guard_authority['findings']
for item in guard_authority['sourceBindings']:
    verify_ref(item)
controls_path = publication / 'independent-review/snapshot-probe.json'
controls = json.loads(controls_path.read_text())
assert controls['allPassed'] and controls['sourceUnchanged'] and len(controls['cases']) == 5
verify_ref(controls['source'])
fresh_path = publication / 'guard/fresh-checkout-v3/report.json'
verify_ref(guard_authority['freshCheckout']['receipt'])
fresh = json.loads(fresh_path.read_text())
assert fresh['rootSourceStable'] and fresh['rootSourceBefore'] == fresh['rootSourceAfter']
assert all(sha(root / path) == value for path, value in fresh['rootSourceBefore'].items())
assert [(item['exitCode'], item['expectedExitCode'], item['findingCount']) for item in fresh['records']] == [(1, 1, 4), (0, 0, 0), (1, 1, 2)]
for item in fresh['records']:
    verify_ref(item['log'])
    assert item['sourceStable'] and item['sourceBefore'] == item['sourceAfter']
    assert all(item['generatedOutputsAbsentBeforeAndAfter'].values())
assert fresh['records'][1]['sourceBefore']['scripts/memory-drift-guard.ts'] == sha(root / 'scripts/memory-drift-guard.ts')
guard_review_path = publication / 'independent-review/REVIEW.md'
guard_observation = write(destination / 'publication-guard-observation.json', {
    'schemaVersion': 1, 'reviewer': old['reviewer'], 'purpose': 'Remote CI repair context only; original node implementation scope remains unchanged.',
    'sourceBindings': guard_authority['sourceBindings'], 'independentSmallFixAuthority': ref(guard_manifest_path),
    'independentControls': ref(controls_path), 'freshUnbuiltCheckout': ref(fresh_path), 'independentReport': ref(guard_review_path),
    'observations': [
        'Inspected exact guard/test diff and both real producers: only three canonical generated output paths receive fallback when their producer resolves to a regular file. No Markdown exclusion, active-document, other-checker or validator rule changed.',
        'New direct regressions retain unknown generated/dist/source paths and reject absent/directory producers. The sealed independent five-case probe additionally checks shared/full-guard parity, removal of producer after snapshot capture and existing output without producer.',
        'The completed v3 unbuilt-checkout control records old guard 4 findings/exit 1, repaired guard 0 findings/exit 0, and unlisted outputs 2 findings/exit 1; all three declared outputs remained physically absent. The fixture retains the committed old test source, while the root source map binds the new regression test.',
        'The v1/v2 harness parser failures are historical only; their successful banners grant no complete positive command credit.',
        'All three root receipt logs, pinned Bun identity, equal 193-input maps and current hashes were independently verified; all 187 prior inputs are preserved and all six additional inputs were declared before invocation.',
        'Windows workflow and later E2E fixture paths are recorded context only; this node renewal grants no independent implementation approval or Windows/native execution credit.',
    ],
    'rootChecks': [{key: item[key] for key in ['receipt', 'log']} for item in root_receipts.values()],
    'scopeLimits': ['No other card implementation or broader native/provider/installed/OS guarantee is approved here.', 'B04 controls and root fresh-checkout control reused without rerunning them.'],
})

limits = [limit.replace('recorded map covers 187 inputs', 'recorded map covers 193 inputs')
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

The latest accepted independent authority is `post-commit-ci-repair/independent-node-review/{node}/review.json`. Its {len(old['sourceContractHashes'])} implementation contract hashes, original owners, behavior oracle artifacts, dependency/config hashes and {len(reused)} scoped commands remain unchanged and were independently checked. No scoped product command was rerun; prior bounded source observations retain their original provenance.

Only the shared root typecheck credit is replaced. The fresh command passed all eleven workspaces with exactly 193 stable/current declared inputs. Its normalized node-specific receipt preserves raw argv/cwd/timing, pinned Bun 1.3.5, replacement environment, log and exact before/after maps. Historical maps remain immutable and receive no current typecheck command credit. Contracts outside that map: {json.dumps(omitted)}; unchanged scoped behavior receipts cover those contracts.

The publication guard observation records the exact three generated-output producer fallbacks, active-neighbor and missing/directory-producer controls, the complete v3 unbuilt-checkout proof and successful guard receipts. These are contextual observations and do not expand the node implementation scope. Existing exclusions for reviewer-owned B01 tail/store, gate-files fixtures, B30 comparison repairs and all native/provider/installed/OS graduation limits remain unchanged.

`approval.json` is new typed independent authority. `review.json` hash-references it and matches all canonical fields. Exactly {len(commands)} commands remain required once each. Behavior oracle artifacts remain attached directly. Only this owned evidence tree was written; no production/tests/ledger, Git staging or historical evidence was changed. The frozen strict validator is exercised in an isolated format harness that grants no actual roadmap acceptance.
''')
additional = [ref(raw_path), ref(log_path), ref(command_path), inspection, readme,
              guard_observation, ref(guard_manifest_path), ref(guard_authority_path), ref(guard_review_path), ref(controls_path), ref(fresh_path), *[item['log'] for item in fresh['records']],
              ref(Path(__file__).resolve()), *[item[key] for item in root_receipts.values() for key in ['receipt', 'log']]]
artifacts = {item['path']: item for item in [*old['artifacts'], *additional]}
supporting = [*old['supportingEvidence'],
              {**ref(old_path), 'credit': 'raw-data-only', 'reason': 'Latest historical bounded implementation authority; shared typecheck command is superseded.'},
              {**ref(old_dir / 'review.json'), 'credit': 'raw-data-only', 'reason': 'Historical normalized authority; no current command credit.'},
              {**retired[0]['receipt'], 'credit': 'raw-data-only', 'reason': 'Immutable historical 187-input workspace map predates the remote generated-output guard repair.'}]
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
