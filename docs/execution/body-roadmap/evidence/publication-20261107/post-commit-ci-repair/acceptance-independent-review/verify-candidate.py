#!/usr/bin/env python3
"""Independently check the two-node CI-context renewal without promoting it."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

if not __debug__:
    raise RuntimeError('Run candidate review with ordinary Python')
OUT = Path(__file__).resolve().parent
BASE = OUT.parent
ROOT = OUT.parents[6]
LIVE = ROOT / 'docs/execution/body-roadmap/ledger.json'
CANDIDATE = BASE / 'acceptance/candidate-ledger.json'
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
EXPECTED_CANDIDATE = '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
EXPECTED_LIVE = '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
EXPECTED_VALIDATOR = '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
bindings = {}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bind(path, expected=None):
    digest = sha(path)
    if expected is not None:
        require(digest == expected, 'Hash mismatch: ' + str(path))
    key = str(path.relative_to(ROOT))
    prior = bindings.get(key)
    require(prior is None or prior['sha256'] == digest, 'Binding changed during review: ' + key)
    bindings[key] = {'path': key, 'sha256': digest, 'bytes': path.stat().st_size}
    return bindings[key]


def load_ref(reference):
    path = ROOT / reference['path']
    bind(path, reference['sha256'])
    return json.loads(path.read_text())


def check_artifacts(document):
    for entry in document.get('artifacts', []):
        bind(ROOT / entry['path'], entry['sha256'])


bind(LIVE, EXPECTED_LIVE)
bind(CANDIDATE, EXPECTED_CANDIDATE)
bind(VALIDATOR, EXPECTED_VALIDATOR)
bind(BASE / 'acceptance/previous-ledger.json', EXPECTED_LIVE)
old = json.loads(LIVE.read_text())
new = json.loads(CANDIDATE.read_text())
require(set(old) == set(new), 'Ledger schema fields changed')
require(all(old[key] == new[key] for key in old if key not in ['updatedAt', 'nodes']), 'Unrelated top-level field changed')
require([node['nodeId'] for node in old['nodes']] == [node['nodeId'] for node in new['nodes']], 'Node identity/order changed')
old_nodes = {node['nodeId']: node for node in old['nodes']}
new_nodes = {node['nodeId']: node for node in new['nodes']}
changed = [name for name in old_nodes if old_nodes[name] != new_nodes[name]]
require(changed == ['B01', 'B36'], 'Unexpected changed-node set')
node_changes = []
raw_path = BASE / 'commands/typecheck/typecheck.json'
bind(raw_path)
raw = json.loads(raw_path.read_text())
require(raw['exitCode'] == 0 and raw['sourceBefore'] == raw['sourceAfter'], 'Shared typecheck failed or changed input bytes')
require(len(raw['sourceBefore']) == 187, 'Unexpected actual typecheck input count')
require(raw['argv'][1:] == ['--no-env-file', 'run', 'typecheck'], 'Wrong shared typecheck invocation')
require(raw['cwd'] == str(ROOT), 'Wrong shared typecheck cwd')
require(raw['elapsedSeconds'] >= 0 and raw['finishedAt'] >= raw['startedAt'], 'Invalid command timing')
for name, digest in raw['sourceBefore'].items():
    bind(ROOT / name, digest)
log_path = ROOT / raw['log']
bind(log_path, raw['logSha256'])
log = log_path.read_text()
workspaces = re.findall(r'^([^\s]+) typecheck: Exited with code 0$', log, re.M)
require(len(workspaces) == len(set(workspaces)) == 11 and 'All type checks passed!' in log, 'Incomplete workspace typecheck result')
require(sha(Path(raw['toolchain']['executable'])) == raw['toolchain']['sha256'], 'Pinned typecheck executable differs')
raw_ref = {'path': str(raw_path.relative_to(ROOT)), 'sha256': sha(raw_path)}

for card in changed:
    prior = old_nodes[card]
    candidate = new_nodes[card]
    changed_fields = sorted(key for key in set(prior) | set(candidate) if prior.get(key) != candidate.get(key))
    require(changed_fields == ['acceptanceReceipt', 'acceptedAt', 'evidenceManifest', 'verification'], 'Unexpected node field changed: ' + card)
    for path, digest in candidate['sourceContractHashes'].items():
        bind(ROOT / path, digest)
    old_receipt = load_ref(prior['acceptanceReceipt'])
    new_receipt = load_ref(candidate['acceptanceReceipt'])
    permitted_receipt_fields = {'independentReviews', 'artifacts', 'manifest', 'requiredChecks', 'acceptedAt'}
    require(set(old_receipt) == set(new_receipt), 'Acceptance schema changed: ' + card)
    require(all(old_receipt[key] == new_receipt[key] for key in old_receipt if key not in permitted_receipt_fields), 'Acceptance scope/source/behavior changed: ' + card)
    require(old_receipt['behaviorEvidence'] == new_receipt['behaviorEvidence'], 'Behavior credit changed: ' + card)
    old_manifest = load_ref(old_receipt['manifest'])
    new_manifest = load_ref(new_receipt['manifest'])
    for document in [old_receipt, new_receipt, old_manifest, new_manifest]:
        check_artifacts(document)
    require(len(old_receipt['requiredChecks']) == len(new_receipt['requiredChecks']) == (11 if card == 'B01' else 3), 'Required command count changed')
    changed_commands = []
    for index, (before, after) in enumerate(zip(old_receipt['requiredChecks'], new_receipt['requiredChecks'])):
        if before == after:
            load_ref(after['evidence'])
            continue
        changed_commands.append(index)
        require(before['evidence']['path'].endswith('workspace-typecheck-refresh-20261107/command-workspace-typecheck.json'), 'Replaced a scoped behavior command')
        command = load_ref(after['evidence'])
        require(command['provenance'] == raw_ref, 'New command does not bind exact shared actual invocation')
        require(command['sourceBefore'] == command['sourceAfter'] == raw['sourceBefore'], 'Normalized command rewrites actual original input map')
        require(command['argv'] == raw['argv'] and command['exitCode'] == raw['exitCode'], 'Normalized invocation differs')
        require(command['log'] == {'path': raw['log'], 'sha256': raw['logSha256']}, 'Normalized command substitutes log')
        require(command['nodeId'] == card, 'Wrong normalized command node')
    require(len(changed_commands) == 1, 'Expected exactly one replaced command for ' + card)
    require(len(old_receipt['independentReviews']) == len(new_receipt['independentReviews']), 'Independent review count changed')
    review_changes = []
    for index, (before, after) in enumerate(zip(old_receipt['independentReviews'], new_receipt['independentReviews'])):
        if before == after:
            load_ref(after['evidence'])
            continue
        review_changes.append(index)
        require(all(before[key] == after[key] for key in before if key != 'evidence'), 'Review identity or scope changed')
        before_review = load_ref(before['evidence'])
        review = load_ref(after['evidence'])
        approval = load_ref(review['provenance'])
        require(review['reviewer'] == approval['reviewer'] == '/root/b03_mutation_evidence', 'Unexpected renewing authority')
        require(review['independent'] is True and approval['independent'] is True, 'Review lacks independence')
        require(review['reviewer'] not in review['implementationOwners'], 'Self-authored renewal')
        for field in ['reviewer', 'implementationOwners', 'scope', 'sourceContractHashes', 'decision']:
            require(before_review[field] == review[field] == approval[field], 'Renewal changed identity/scope/source: ' + field)
        for field in ['dependencyContractHashes', 'configurationHashes', 'frozenPlanHashes']:
            require(before_review.get(field) == review.get(field), 'Renewal altered context contract: ' + field)
        require(review['commandReceipts'] == approval['commandReceipts'], 'Approval and review disagree on command credit')
        require(len(review['commandReceipts']) == (7 if card == 'B01' else 3), 'Renewing review changed command count')
        check_artifacts(before_review)
        check_artifacts(review)
        check_artifacts(approval)
    require(review_changes == [0], 'Expected only B03 main review to change')
    if card == 'B01':
        require(old_receipt['independentReviews'][1] == new_receipt['independentReviews'][1], 'B01 tail/store authority changed')
    node_changes.append({'nodeId': card, 'changedLedgerFields': changed_fields,
                         'implementationContractsUnchanged': True, 'contractCount': len(candidate['sourceContractHashes']),
                         'behaviorEvidenceUnchanged': True, 'requiredCommands': len(new_receipt['requiredChecks']),
                         'replacedCommandIndexes': changed_commands, 'unchangedScopedCommands': len(new_receipt['requiredChecks']) - 1,
                         'renewingReviewer': '/root/b03_mutation_evidence', 'oldReceipt': prior['acceptanceReceipt'],
                         'newReceipt': candidate['acceptanceReceipt'], 'newMainReview': new_receipt['independentReviews'][0]['evidence']})

for name in ['guard-tests', 'guard-memory-drift']:
    path = BASE / f'commands/{name}/{name}.json'
    bind(path)
    receipt = json.loads(path.read_text())
    require(receipt['exitCode'] == 0 and receipt['sourceBefore'] == receipt['sourceAfter'], 'Guard command failed or drifted')
    for file, digest in receipt['sourceAfter'].items():
        bind(ROOT / file, digest)
    bind(ROOT / receipt['log'], receipt['logSha256'])
    if name == 'guard-tests':
        require(receipt['counts'] == {'pass': 69, 'fail': 0}, 'Wrong guard test count')
    else:
        require('0 findings across 12 checkers' in (ROOT / receipt['log']).read_text(), 'Guard log is not clean')

argv = [sys.executable, '-B', str(VALIDATOR), '--ledger', str(CANDIDATE)]
result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, timeout=60,
                        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
for name, value in [('candidate-validation.stdout.log', result.stdout), ('candidate-validation.stderr.log', result.stderr)]:
    with (OUT / name).open('x') as output:
        output.write(value)
require(result.returncode == 0, 'Candidate frozen validation failed: ' + result.stdout + result.stderr)
validation = json.loads(result.stdout)
require(validation['valid'] and not validation['errors'], 'Candidate is invalid')
require(validation['accepted'] == ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36'] and len(validation['remaining']) == 31, 'Acceptance set changed')
for item in list(bindings.values()):
    require(sha(ROOT / item['path']) == item['sha256'], 'Reviewed binding changed during validation')
require(sha(LIVE) == EXPECTED_LIVE, 'Live ledger changed during independent review')
report = {'schemaVersion': 1, 'type': 'independent-ci-repair-candidate-consistency-review',
          'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reviewer': '/root/b04_lock_cas',
          'decision': 'approve-exact-candidate-for-byte-preserving-promotion',
          'scope': 'Two-node evidence metadata transition and frozen-validator consistency only; no implementation self-approval or new card acceptance.',
          'candidateSha256': EXPECTED_CANDIDATE, 'previousLiveSha256': EXPECTED_LIVE, 'validatorSha256': EXPECTED_VALIDATOR,
          'changedNodes': node_changes, 'other37NodesIdentical': True,
          'topLevelOnlyUpdatedAtChanged': True, 'sharedTypecheck': {'receipt': raw_ref, 'actualInputCount': 187,
              'originalAndNormalizedMapsExact': True, 'allInputsMatchCurrent': True, 'workspaces': workspaces,
              'singleActualInvocation': True, 'exitCode': 0},
          'frozenValidation': {'argv': argv, 'exitCode': result.returncode, 'result': validation},
          'bindings': sorted(bindings.values(), key=lambda row: row['path']),
          'allReviewedBindingsStable': True, 'liveLedgerUntouched': True,
          'limitations': ['This verifies receipt/command/source consistency and preserved independent authority, not B01/B36 product behavior.',
                          'Historical publication inventory remains frozen; subsequent publication needs the explicit guard/test/ledger delta.',
                          'No product commands were rerun by this reviewer; actual command receipts, logs, tools and inputs were checked.']}
with (OUT / 'review.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({'passed': True, 'candidateSha256': EXPECTED_CANDIDATE, 'bindingCount': len(bindings),
                  'changedNodes': changed, 'accepted': 8, 'remaining': 31, 'reportSha256': sha(OUT / 'review.json')}))
