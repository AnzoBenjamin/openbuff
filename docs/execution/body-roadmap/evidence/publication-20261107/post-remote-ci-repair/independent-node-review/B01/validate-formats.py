from pathlib import Path
import copy, hashlib, importlib.util, json, sys

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
node_id = sys.argv[1]
assert node_id in ['B01', 'B36']
evidence = Path(sys.argv[2]).resolve()
harness = evidence / 'format-harness'
harness.mkdir(exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}
def write(path, value):
    assert not path.exists()
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
    return ref(path)
review = json.loads((evidence / 'review.json').read_text())
original = json.loads((evidence / 'approval.json').read_text())
assert review['provenance'] == ref(evidence / 'approval.json')
for field in ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent', 'scope', 'decision', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']:
    assert review[field] == original[field]
artifacts = [*review['artifacts'], ref(evidence / 'review.json')]
manifest = write(harness / 'manifest.json', {'schemaVersion': 1, 'type': 'body-acceptance-evidence', 'nodeId': node_id, 'sourceContractHashes': review['sourceContractHashes'], 'reviews': [ref(evidence / 'review.json')], 'commandReceipts': review['commandReceipts'], 'artifacts': artifacts})
graph = {'schemaVersion': 2, 'cardCount': 1, 'nodeCount': 1, 'dependencySemantics': 'all-of', 'rollups': {}, 'ledgerRequiredFields': ['nodeId', 'parentCardId', 'acceptedPrerequisites', 'sourceContractHashes', 'repositoryId', 'backend', 'epoch', 'coverageTier', 'evidenceManifest'], 'nodes': [{'id': node_id, 'kind': 'card', 'prerequisites': []}]}
plan = write(harness / 'plan.md', f'# Isolated {node_id} format validation only\n\nThis synthetic graph exercises the exact review/command/oracle formats and grants no actual prerequisite or roadmap acceptance.\n\n```json\n' + json.dumps(graph) + '\n```\n')
specification = write(harness / 'specification.md', 'Strict format validation only: preserve original bounded independent scope and current source/command provenance. No actual roadmap acceptance.\n')
node = {'nodeId': node_id, 'parentCardId': None, 'status': 'accepted', 'prerequisites': [], 'acceptedPrerequisites': [], 'sourceContractHashes': review['sourceContractHashes'], 'repositoryId': 'format-harness-only', 'backend': 'source-ts-bun', 'epoch': 'format-only-no-roadmap-credit', 'coverageTier': 'isolated-format-validation-only', 'evidenceManifest': manifest['path']}
checks = []
for reference in review['commandReceipts']:
    command = json.loads((root / reference['path']).read_text())
    checks.append({'name': command['name'], 'argv': command['argv'], 'exitCode': command['exitCode'], 'log': command['log'], 'evidence': reference})
receipt = {field: copy.deepcopy(node[field]) for field in ['nodeId', 'parentCardId', 'sourceContractHashes', 'repositoryId', 'backend', 'epoch', 'coverageTier']}
receipt.update({'schemaVersion': 1, 'status': 'accepted', 'planSha256': plan['sha256'], 'specificationSha256': specification['sha256'], 'manifest': manifest, 'acceptedPrerequisites': [], 'independentReviews': [{**{field: review[field] for field in ['reviewer', 'implementationOwners', 'scope', 'decision']}, 'evidence': ref(evidence / 'review.json')}], 'requiredChecks': checks, 'behaviorEvidence': json.loads((evidence / 'behavior-evidence.json').read_text()), 'artifacts': artifacts})
node['acceptanceReceipt'] = write(harness / 'acceptance.json', receipt)
ledger = {'schemaVersion': 1, 'plan': plan['path'], 'planSha256': plan['sha256'], 'specification': specification['path'], 'specificationSha256': specification['sha256'], 'completionGraph': graph, 'nodes': [node]}
write(harness / 'ledger.json', ledger)
validator_path = root / 'docs/execution/body-roadmap/validate-ledger.py'
module_spec = importlib.util.spec_from_file_location('body_context_refresh_format_check', validator_path)
validator = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(validator)
result = validator.validate(ledger, root, require_complete=True)
assert result['valid'], result['errors']
report = {'schemaVersion': 1, 'nodeId': node_id, 'purpose': 'Exact authority/command/oracle formats only; synthetic graph grants no real prerequisite or roadmap acceptance.', 'validator': ref(validator_path), 'helper': ref(Path(__file__).resolve()), 'approval': ref(evidence / 'approval.json'), 'review': ref(evidence / 'review.json'), 'formatHarness': ref(harness / 'ledger.json'), 'result': result}
write(evidence / 'format-validation.json', report)
print(json.dumps({'nodeId': node_id, 'valid': result['valid'], 'errors': result['errors'], 'requiredCommands': len(checks), 'sourceContracts': len(review['sourceContractHashes']), 'formatOnly': True, 'approval': ref(evidence / 'approval.json'), 'review': ref(evidence / 'review.json'), 'formatValidation': ref(evidence / 'format-validation.json')}, indent=2))
