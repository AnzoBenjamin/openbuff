from pathlib import Path
import datetime, hashlib, json, re, sys

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}
node = sys.argv[1]
assert node in ['B01', 'B36']
old_dir = here.parent.parent / node / 'typed-independent-review'
destination = old_dir.parent / 'workspace-typecheck-refresh'
destination.mkdir(exist_ok=True)
assert not (destination / 'approval.json').exists()
old_approval_path = old_dir / 'approval.json'
old = json.loads(old_approval_path.read_text())
old_review = json.loads((old_dir / 'review.json').read_text())
assert old_review['provenance'] == ref(old_approval_path)
assert old['reviewer'] == '/root/b03_mutation_evidence' and old['reviewer'] not in old['implementationOwners']
inspection_path = root / old['currentInspection']['path']
assert sha(inspection_path) == old['currentInspection']['sha256']
prior_inspection = json.loads(inspection_path.read_text())
for field in ['sourceContractHashes', 'dependencyHashesWithoutApproval']:
    assert all(sha(root / path) == value for path, value in prior_inspection[field].items())
historical_context_drift = [path for path, value in prior_inspection['declaredCommandContextHashes'].items() if sha(root / path) != value]
assert set(historical_context_drift) == {'agents/__tests__/gate-files-parity.test.ts', 'agents/__tests__/gate-files.test.ts', 'sdk/src/serve/event-bridge.ts'}
assert all(sha(root / path) == value for path, value in old['sourceContractHashes'].items())
assert all(sha(root / item['path']) == item['sha256'] for item in old['artifacts'])
raw_path = here.parent / 'final-gate/typecheck.json'
raw = json.loads(raw_path.read_text())
assert raw['exitCode'] == 0 and raw['sourceUnchangedDuringCommand']
assert raw['sourceBefore'] == raw['sourceAfter']
assert all(sha(root / path) == value for path, value in raw['sourceBefore'].items())
log_path = root / raw['log']
assert sha(log_path) == raw['logSha256']
assert sha(Path(raw['toolchain']['executable'])) == raw['toolchain']['sha256']
assert raw['argv'] == [raw['toolchain']['executable'], '--no-env-file', 'run', 'typecheck']
log = log_path.read_text()
assert 'All type checks passed!' in log
assert len(re.findall(r'typecheck: Exited with code 0', log)) == 11
retired, reused = [], []
retired_artifact_paths = set()
for reference in old['commandReceipts']:
    path = root / reference['path']
    assert sha(path) == reference['sha256']
    command = json.loads(path.read_text())
    assert command['sourceBefore'] == command['sourceAfter'] and command['exitCode'] == 0
    drift = [source for source, value in command['sourceBefore'].items() if sha(root / source) != value]
    if 'typecheck' in path.name:
        assert set(drift) == {'agents/__tests__/gate-files-parity.test.ts', 'agents/__tests__/gate-files.test.ts', 'sdk/src/serve/event-bridge.ts'}
        retired.append({'receipt': reference, 'driftedInputs': drift})
        retired_artifact_paths.update([reference['path'], command['provenance']['path'], command['log']['path']])
    else:
        assert not drift
        assert sha(root / command['log']['path']) == command['log']['sha256']
        reused.append(reference)
assert len(retired) == (2 if node == 'B01' else 1)
assert len(reused) == (6 if node == 'B01' else 2)
command_path = destination / 'command-workspace-typecheck.json'
normalized_command = {'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': node, 'name': 'current root all-workspaces typecheck (shared actual invocation)', 'argv': raw['argv'], 'cwd': raw['cwd'], 'startedAt': raw['startedAt'], 'finishedAt': raw['finishedAt'], 'exitCode': raw['exitCode'], 'log': ref(log_path), 'sourceBefore': raw['sourceBefore'], 'sourceAfter': raw['sourceAfter'], 'sourceBindingScope': 'Exact 180-input original root-workspace invocation maps, retained without adding retired 1309-input context or rewriting raw provenance.', 'provenance': ref(raw_path), 'toolchain': raw['toolchain'], 'environment': raw['environment'], 'artifacts': [ref(raw_path), ref(log_path)]}
command_path.write_text(json.dumps(normalized_command, indent=2) + '\n')
new_commands = [*reused, ref(command_path)]
source_before = {path: sha(root / path) for path in sorted(set(prior_inspection['declaredCommandContextHashes']) | set(raw['sourceBefore']))}
summary = {'schemaVersion': 1, 'nodeId': node, 'reviewer': old['reviewer'], 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'method': 'Reuse this reviewer’s original actual-source and behavior-oracle inspection only after current source/dependency/oracle/hash verification; replace only retired contextual typechecks with one actual root all-workspaces invocation.', 'originalIndependentAuthority': ref(old_approval_path), 'sourceContractHashes': old['sourceContractHashes'], 'dependencyHashesWithoutApproval': prior_inspection['dependencyHashesWithoutApproval'], 'historicalDeclaredContextHashes': prior_inspection['declaredCommandContextHashes'], 'historicalContextDrift': historical_context_drift, 'sourceBefore': source_before, 'sourceAfter': {path: sha(root / path) for path in source_before}, 'observedOracles': prior_inspection['observedOracles'], 'actualSourceInspection': prior_inspection['actualSourceInspection'], 'retiredCommands': retired, 'reusedCommands': reused, 'replacementGlobalCommand': ref(raw_path), 'rawTypecheckInputCount': len(raw['sourceBefore']), 'sourceContractsOutsideRawTypecheckMap': [path for path in old['sourceContractHashes'] if path not in raw['sourceBefore']], 'scopeLimits': [*old['scopeLimits'], 'Reviewer-authored gate-files fixture repairs are context bindings only; no separate independent implementation approval of those fixtures is inferred.', 'Global typecheck success covers all workspace scripts; exact recorded before/after provenance covers only the 180 original input paths. Existing unchanged behavior commands retain coverage of any contract omitted from that raw map.'], 'neededReruns': []}
assert summary['sourceBefore'] == summary['sourceAfter']
assert summary['sourceContractsOutsideRawTypecheckMap'] == ([] if node == 'B01' else ['sdk/src/__tests__/node-filesystem.test.ts'])
inspection_destination = destination / 'inspection.json'
inspection_destination.write_text(json.dumps(summary, indent=2) + '\n')
report_path = destination / 'README.md'
report_path.write_text(f'''# {node} contextual typecheck refresh

The original independent {node} source scope, owner list and limits are preserved. All {len(old['sourceContractHashes'])} source contracts, original dependency hashes and {len(old['artifacts'])} original artifact seals still match current bytes. The historical declared typecheck-context map differs at the same three context files and remains preserved; `inspection.json` separately records current stable read hashes. The original actual-source inspection and directly sealed behavior/test/fixture oracles are reused at their unchanged identities.

Only {len(retired)} old contextual typecheck receipt(s) drifted, at the two gate-files fixtures and the event-bridge dead-local deletion. Those receipts remain immutable historical evidence. The {len(reused)} current behavior/validation commands retain their original exact maps and provenance. One actual root `bun --no-env-file run typecheck` invocation replaces the retired per-package typecheck credits. Its unchanged log reports eleven workspace typechecks exit 0; this reviewer ran no additional typecheck or product suite.

`command-workspace-typecheck.json` preserves the raw parent-authored invocation’s argv, exit, log, timing and exact {len(raw['sourceBefore'])}-input before/after map, and hash-references that same raw receipt. The earlier 1309-input maps were not rewritten or retroactively added. The global command’s script success and its recorded source-map coverage are distinct: {json.dumps(summary['sourceContractsOutsideRawTypecheckMap'])} is outside the new raw map; the unchanged original behavior receipts retain complete contract coverage.

This reviewer’s gate-files fixture repair is context binding only and receives no separate independent implementation approval. The shared global command also observes other cards’ source/configuration context without approving those implementations. B01 tail/store, B01 specialist graduation, providers, native/installed packages, OS isolation and broader process enforcement remain excluded as specified by the original scopes. B36 retains its original 188-test/postimage evidence as historical context; only its previously credited 22-test integration and twelve-case source diagnostic oracles are reused.

`approval.json` is a new original independent authority; `review.json` hash-references it and has matching canonical fields, source map and command identities. Every credited command remains required exactly once. Actual behavior-oracle files are attached directly to the original authority. No production, tests, ledger or old evidence were edited for this refresh. Strict format validation uses the unchanged validator and a clearly isolated one-node harness; it grants no actual roadmap acceptance.
''')
primary_artifacts = [item for item in old['artifacts'] if 'typecheck' not in item['path']]
additional = [ref(raw_path), ref(log_path), ref(command_path), ref(inspection_destination), ref(report_path), ref(Path(__file__).resolve()), *old['behaviorOracleArtifacts'], *[ref(root / path) for path in old['sourceContractHashes']]]
artifact_map = {item['path']: item for item in [*primary_artifacts, *additional]}
limits = [*old['scopeLimits'], *summary['scopeLimits'][len(old['scopeLimits']):], f'All {len(new_commands)} independently credited commandReceipts must remain required exactly once; the new contextual envelope represents one shared actual global invocation.']
new_approval = {'schemaVersion': 1, 'type': 'body-independent-approval', 'nodeId': node, 'reviewer': old['reviewer'], 'implementationOwners': old['implementationOwners'], 'independent': True, 'decision': 'approve', 'scope': old['scope'], 'sourceContractHashes': old['sourceContractHashes'], 'commandReceipts': new_commands, 'scopeLimits': limits, 'reviewedAt': summary['checkedAt'], 'artifacts': list(artifact_map.values()), 'behaviorOracleArtifacts': old['behaviorOracleArtifacts'], 'currentInspection': ref(inspection_destination), 'supportingEvidence': [dict(ref(old_approval_path), credit='raw-data-only', reason='Original independent scope and behavior inspection; old contextual typecheck command credits are superseded.'), *[dict(item, credit='raw-data-only', reason='Retired/historical typecheck provenance; never current passing command credit.') for item in old['artifacts'] if 'typecheck' in item['path']]], 'neededReruns': []}
(destination / 'approval.json').write_text(json.dumps(new_approval, indent=2) + '\n')
canonical = ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']
new_review = {key: new_approval[key] for key in canonical}
new_review.update({'type': 'body-implementation-review', 'provenance': ref(destination / 'approval.json'), 'artifacts': [*new_approval['artifacts'], ref(destination / 'approval.json')], 'supportingEvidence': new_approval['supportingEvidence']})
(destination / 'review.json').write_text(json.dumps(new_review, indent=2) + '\n')
behavior = [{'criterion': ('Source inspection/maturity separation, complete inventoried coverage and ordinary/specialist snapshot attestation including adverse controls.' if node == 'B01' else 'Actual diagnostic children through delta/hooks, source SDK JSON and CLI classification preserve unsuccessful/incomplete/unknown evidence.'), 'evidence': old['behaviorOracleArtifacts']}]
(destination / 'behavior-evidence.json').write_text(json.dumps(behavior, indent=2) + '\n')
assert all(new_review[key] == new_approval[key] for key in canonical)
assert all(sha(root / item['path']) == item['sha256'] for item in new_approval['artifacts'])
print(json.dumps({'nodeId': node, 'sourceContracts': len(old['sourceContractHashes']), 'reusedCommands': len(reused), 'retiredTypechecks': len(retired), 'replacementTypecheck': ref(raw_path), 'approval': ref(destination / 'approval.json'), 'review': ref(destination / 'review.json')}, indent=2))
