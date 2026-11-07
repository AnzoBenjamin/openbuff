"""Validate B03 seals through the unchanged canonical validator; no live promotion."""
from pathlib import Path
import copy
import datetime
import hashlib
import json
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir())
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'

def read(path):
    return json.loads(Path(path).read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    return {'path': str(Path(path).relative_to(ROOT)), 'sha256': sha(path)}

def bind(row):
    path = ROOT / row['path']
    assert sha(path) == row['sha256'], row['path']
    return path

assert not (OUT / 'validator-command.json').exists(), 'Preserve closed validation'
approval = read(OUT / 'approval.json')
review = read(OUT / 'review.json')
assert approval['type'] == 'body-independent-approval' and review['type'] == 'body-implementation-review'
assert approval['independent'] and approval['decision'] == 'approve'
assert approval['reviewer'] == '/root/b02_runtime_outcomes'
assert approval['reviewer'] not in approval['implementationOwners']
assert review['provenance'] == ref(OUT / 'approval.json')
for key in ['nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'artifacts']:
    assert approval[key] == review[key], key
for row in approval['artifacts']:
    bind(row)
contexts = {}
checks = []
for row in approval['commandReceipts']:
    command = read(bind(row))
    original = read(bind(command['provenance']))
    for key in ['argv', 'cwd', 'exitCode', 'log', 'sourceBefore', 'sourceAfter', 'environment', 'runner', 'preload', 'providerConfiguration']:
        assert command[key] == original[key], key
    assert command['sourceBefore'] == command['sourceAfter'] and command['exitCode'] == 0
    contexts.update(command['sourceBefore'])
    checks.append({'name': command['name'], 'argv': command['argv'], 'exitCode': 0, 'log': command['log'], 'evidence': row})
for name, digest in contexts.items():
    assert sha(ROOT / name) == digest, name

live_path = ROOT / 'docs/execution/body-roadmap/ledger.json'
live_hash = sha(live_path)
ledger = copy.deepcopy(read(live_path))
# Retain all canonical node/dependency records. The isolated consistency
# candidate deliberately grants no accepted or started status to other nodes.
for node in ledger['nodes']:
    node['status'] = 'pending'
    node['acceptedPrerequisites'] = []
node = next(item for item in ledger['nodes'] if item['nodeId'] == 'B03')
node.update({'status': 'accepted', 'sourceContractHashes': approval['sourceContractHashes'], 'epoch': 'B03-post-cleanup-controlled-source-20261107', 'coverageTier': approval['scope']})
manifest_path = OUT / 'validator-candidate-manifest.json'
receipt_path = OUT / 'validator-candidate-receipt.json'
ledger_path = OUT / 'validator-candidate-ledger.json'
manifest = {'schemaVersion': 1, 'type': 'body-acceptance-evidence', 'nodeId': 'B03', 'sourceContractHashes': approval['sourceContractHashes'], 'reviews': [ref(OUT / 'review.json')], 'commandReceipts': approval['commandReceipts'], 'artifacts': approval['artifacts'] + [ref(OUT / 'approval.json'), ref(OUT / 'review.json')], 'scope': 'B03-only isolated validator candidate; not live ledger promotion'}
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
receipt = {'schemaVersion': 1, 'status': 'accepted', **{key: node[key] for key in ['nodeId', 'parentCardId', 'repositoryId', 'backend', 'epoch', 'coverageTier', 'sourceContractHashes']}, 'planSha256': ledger['planSha256'], 'specificationSha256': ledger['specificationSha256'], 'acceptedPrerequisites': [], 'manifest': ref(manifest_path), 'independentReviews': [{key: review[key] for key in ['reviewer', 'implementationOwners', 'scope', 'decision']} | {'evidence': ref(OUT / 'review.json')}], 'requiredChecks': checks, 'behaviorEvidence': [{'criterion': 'Mutation authority, exact foreign/partial/CRLF bytes, observer/journal and consumer outcome controls', 'evidence': [ref(OUT / 'inspection.json'), ref(OUT / 'assessment.json'), ref(OUT / 'consumer-probe.json'), ref(OUT / 'node-broker-probe.json'), ref(OUT / 'fixture/mutation-report.json')]}], 'artifacts': approval['artifacts'], 'candidateOnly': True}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
node['acceptanceReceipt'] = ref(receipt_path)
node['evidenceManifest'] = str(manifest_path.relative_to(ROOT))
ledger_path.write_text(json.dumps(ledger, indent=2) + '\n')
inputs = set(contexts) | {str(path.relative_to(ROOT)) for path in [VALIDATOR, OUT / 'validate-review.py', OUT / 'approval.json', OUT / 'review.json', manifest_path, receipt_path, ledger_path]}
snapshot = lambda: {name: sha(ROOT / name) for name in sorted(inputs)}
before = snapshot()
started = datetime.datetime.now(datetime.timezone.utc)
with tempfile.TemporaryDirectory(prefix='b03-validator-') as owned:
    home = Path(owned) / 'home'
    home.mkdir()
    env = {'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'), 'TMPDIR': owned, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    argv = ['/usr/bin/python3', str(VALIDATOR), '--ledger', str(ledger_path), '--report', str(OUT / 'validator-report.json')]
    result = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
after = snapshot()
log = OUT / 'validator.log'
log.write_bytes(result.stdout)
assert before == after
assert sha(live_path) == live_hash, 'Live ledger changed during isolated validation'
report = read(OUT / 'validator-report.json')
receipt = {'schemaVersion': 1, 'type': 'body-review-validator-command', 'nodeId': 'B03', 'reviewer': '/root/b02_runtime_outcomes', 'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode, 'startedUtc': started.isoformat(), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'validator': ref(VALIDATOR), 'log': ref(log), 'report': ref(OUT / 'validator-report.json'), 'environment': {'replacement': True, 'keys': sorted(env), 'ownedEmptyHome': True}, 'candidateOnly': True, 'liveLedgerUnchanged': True, 'scope': 'Canonical plan/ledger/original-command/oracle seal consistency for isolated B03 candidate only; no broader acceptance promotion.'}
(OUT / 'validator-command.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert result.returncode == 0 and report['valid'] and report['accepted'] == ['B03'], report
print(json.dumps({'nodeId': 'B03', 'allMatch': True, 'validatorUnchanged': ref(VALIDATOR), 'liveLedgerUnchanged': True, 'candidateOnly': True, 'report': ref(OUT / 'validator-report.json'), 'acceptedCandidate': report['accepted'], 'sources': len(approval['sourceContractHashes']), 'commands': len(checks), 'approval': ref(OUT / 'approval.json'), 'review': ref(OUT / 'review.json')}))
