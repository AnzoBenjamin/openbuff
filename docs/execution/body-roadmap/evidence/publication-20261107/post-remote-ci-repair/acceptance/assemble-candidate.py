#!/usr/bin/env python3
"""Create a new bounded B01/B36 context candidate without touching the live ledger."""

import copy
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

assert __debug__, 'Refuse candidate generation with disabled assertions.'
ROOT = Path('/home/ben/Code/CLI/openbuff')
BASE = Path(__file__).resolve().parent
REPAIR = BASE.parent
LIVE = ROOT / 'docs/execution/body-roadmap/ledger.json'
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
EXPECTED_PREVIOUS = '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
EXPECTED_VALIDATOR = '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
EXPECTED_REVIEWS = {
    'B01': '3a1e33ff35f3f0f83d8f135900b8bcee7fc6d218876a5370b3e0188476243e8f',
    'B36': '6da014174c0d5a3cb5dfc096ca8ea5f67f0890310d2bd6d2fa0aeef4e60a6852',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


def verify(reference):
    assert ref(ROOT / reference['path']) == {key: reference[key] for key in ['path', 'sha256']}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
    return ref(path)


assert sha(LIVE) == EXPECTED_PREVIOUS and sha(VALIDATOR) == EXPECTED_VALIDATOR
previous_bytes = LIVE.read_bytes()
with (BASE / 'previous-ledger.json').open('xb') as output:
    output.write(previous_bytes)
previous = json.loads(previous_bytes)
candidate = copy.deepcopy(previous)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
changed = []
for node in candidate['nodes']:
    node_id = node['nodeId']
    if node_id not in EXPECTED_REVIEWS:
        continue
    assert node['status'] == 'accepted' and node['acceptedPrerequisites'] == []
    old_node = next(item for item in previous['nodes'] if item['nodeId'] == node_id)
    verify(old_node['acceptanceReceipt'])
    old_receipt = json.loads((ROOT / old_node['acceptanceReceipt']['path']).read_text())
    verify(old_receipt['manifest'])
    old_manifest = json.loads((ROOT / old_receipt['manifest']['path']).read_text())
    review_path = REPAIR / 'independent-node-review' / node_id / 'review.json'
    assert sha(review_path) == EXPECTED_REVIEWS[node_id]
    review = json.loads(review_path.read_text())
    verify(review['provenance'])
    original = json.loads((ROOT / review['provenance']['path']).read_text())
    canonical = ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent',
                 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']
    assert all(review[field] == original[field] for field in canonical)
    assert review['independent'] and review['decision'] == 'approve'
    assert review['reviewer'] == '/root/b03_mutation_evidence'
    assert review['reviewer'] not in review['implementationOwners']
    assert all(sha(ROOT / path) == value for path, value in node['sourceContractHashes'].items())
    format_path = review_path.parent / 'format-validation.json'
    format_result = json.loads(format_path.read_text())
    assert format_result['result']['valid'] and not format_result['result']['errors']
    verify(format_result['validator'])
    assert format_result['validator']['sha256'] == EXPECTED_VALIDATOR

    receipt = copy.deepcopy(old_receipt)
    manifest = copy.deepcopy(old_manifest)
    prior_main = [item for item in receipt['independentReviews']
                  if item['reviewer'] == review['reviewer']]
    assert len(prior_main) == 1
    old_review_ref = prior_main[0]['evidence']
    verify(old_review_ref)
    old_review = json.loads((ROOT / old_review_ref['path']).read_text())
    assert [review[field] for field in ['scope', 'sourceContractHashes', 'implementationOwners']] == [old_review[field] for field in ['scope', 'sourceContractHashes', 'implementationOwners']]
    assert original['behaviorOracleArtifacts'] == json.loads((ROOT / old_review['provenance']['path']).read_text())['behaviorOracleArtifacts']
    assert review['commandReceipts'][:-1] == old_review['commandReceipts'][:-1]
    old_command_ref = old_review['commandReceipts'][-1]
    new_command_ref = review['commandReceipts'][-1]
    verify(old_command_ref)
    verify(new_command_ref)
    new_command = json.loads((ROOT / new_command_ref['path']).read_text())
    assert new_command['nodeId'] == node_id and new_command['type'] == 'body-acceptance-command'
    assert new_command['exitCode'] == 0 and new_command['sourceBefore'] == new_command['sourceAfter']
    assert len(new_command['sourceBefore']) == 193
    assert all(sha(ROOT / path) == value for path, value in new_command['sourceBefore'].items())
    verify(new_command['log'])
    verify(new_command['provenance'])
    prior_main[0]['evidence'] = ref(review_path)
    checks = [item for item in receipt['requiredChecks'] if item['evidence'] == old_command_ref]
    assert len(checks) == 1
    checks[0].update({field: new_command[field] for field in ['name', 'argv', 'exitCode', 'log']})
    checks[0]['evidence'] = new_command_ref
    assert len(receipt['requiredChecks']) == (11 if node_id == 'B01' else 3)
    assert [item for item in receipt['requiredChecks'] if item['evidence'] != new_command_ref] == [item for item in old_receipt['requiredChecks'] if item['evidence'] != old_command_ref]
    assert [item for item in receipt['independentReviews'] if item['reviewer'] != review['reviewer']] == [item for item in old_receipt['independentReviews'] if item['reviewer'] != review['reviewer']]
    manifest['reviews'] = [item['evidence'] for item in receipt['independentReviews']]
    manifest['commandReceipts'] = [item['evidence'] for item in receipt['requiredChecks']]
    artifact_rows = [*old_manifest['artifacts'], *old_receipt['artifacts'],
                     *review['artifacts'], ref(review_path), ref(format_path),
                     ref(BASE / 'previous-ledger.json'), ref(Path(__file__).resolve())]
    artifacts = {}
    for item in artifact_rows:
        verify(item)
        if item['path'] in artifacts:
            assert artifacts[item['path']]['sha256'] == item['sha256']
        artifacts[item['path']] = item
    manifest['artifacts'] = list(artifacts.values())
    manifest['contextRenewal'] = {
        'previousManifest': old_receipt['manifest'], 'previousAcceptance': old_node['acceptanceReceipt'],
        'retiredCommand': old_command_ref, 'replacementCommand': new_command_ref,
        'replacementIndependentReview': ref(review_path), 'refreshedAt': now,
        'meaning': 'Only the shared typecheck context is renewed; historical maps, implementation authority and behavior evidence remain unchanged.',
    }
    manifest_ref = write(BASE / node_id / 'manifest.json', manifest)
    receipt['manifest'] = manifest_ref
    receipt['artifacts'] = [*manifest['artifacts'], manifest_ref]
    receipt['contextRefreshedAt'] = now
    receipt_ref = write(BASE / node_id / 'acceptance.json', receipt)
    node['evidenceManifest'] = manifest_ref['path']
    node['acceptanceReceipt'] = receipt_ref
    node['verification'] = copy.deepcopy(old_node['verification'])
    node['verification']['independentReviews'] = receipt['independentReviews']
    assert node['verification']['requiredCommandCount'] == len(receipt['requiredChecks'])
    assert receipt['sourceContractHashes'] == old_receipt['sourceContractHashes'] == node['sourceContractHashes']
    assert receipt['behaviorEvidence'] == old_receipt['behaviorEvidence']
    assert receipt['limits'] == old_receipt['limits']
    changed.append({'nodeId': node_id, 'previousAcceptance': old_node['acceptanceReceipt'],
                    'acceptance': receipt_ref, 'manifest': manifest_ref, 'review': ref(review_path),
                    'requiredChecks': len(receipt['requiredChecks']),
                    'implementationContractsUnchanged': True, 'behaviorEvidenceUnchanged': True,
                    'otherIndependentReviewAndScopedChecksUnchanged': True})

assert [item['nodeId'] for item in changed] == ['B01', 'B36']
unchanged = [item['nodeId'] for item, old in zip(candidate['nodes'], previous['nodes'])
             if item['nodeId'] not in EXPECTED_REVIEWS and item == old]
assert len(unchanged) == 37
assert candidate['completionGraph'] == previous['completionGraph']
assert [item['nodeId'] for item in candidate['nodes'] if item['status'] == 'accepted'] == [item['nodeId'] for item in previous['nodes'] if item['status'] == 'accepted']
candidate['updatedAt'] = now
assert all(candidate[field] == previous[field] for field in previous if field not in ['nodes', 'updatedAt'])
candidate_ref = write(BASE / 'candidate-ledger.json', candidate)
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
tick = time.monotonic()
argv = [sys.executable, '-B', str(VALIDATOR), '--ledger', str(ROOT / candidate_ref['path'])]
result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=60)
for name, payload in [('candidate-validation.stdout.log', result.stdout), ('candidate-validation.stderr.log', result.stderr)]:
    with (BASE / name).open('xb') as output:
        output.write(payload)
validation = json.loads(result.stdout)
assert result.returncode == 0 and validation['valid'] and not validation['errors']
assert len(validation['accepted']) == 8 and len(validation['remaining']) == 31
validation_ref = write(BASE / 'candidate-ledger.validation.json', validation)
assert LIVE.read_bytes() == previous_bytes and sha(LIVE) == EXPECTED_PREVIOUS
report = {
    'schemaVersion': 1, 'type': 'narrow-remote-ci-renewal-candidate',
    'createdAt': now, 'previousLiveSha256': EXPECTED_PREVIOUS,
    'previousLedger': ref(BASE / 'previous-ledger.json'), 'candidate': candidate_ref,
    'changedNodes': changed, 'other37NodesIdentical': True, 'unchangedNodes': unchanged,
    'implementationContractsAndBehaviorEvidencePreserved': True,
    'planSpecificationGraphAndAcceptedSetPreserved': True, 'liveLedgerUnchanged': True,
    'validator': ref(VALIDATOR), 'validation': validation_ref,
    'command': {'argv': argv, 'cwd': str(ROOT), 'startedAt': started,
                'elapsedSeconds': time.monotonic() - tick, 'exitCode': result.returncode,
                'stdout': ref(BASE / 'candidate-validation.stdout.log'),
                'stderr': ref(BASE / 'candidate-validation.stderr.log')},
    'assembler': ref(Path(__file__).resolve()),
    'scope': 'Fresh B01/B36 shared-typecheck context only. No new accepted node, card implementation, native execution, publication or live promotion.',
    'promotionRequirements': 'Root must obtain independent exact-candidate review, verify previous live/candidate/review/manifest/source hashes, preserve the candidate bytes and run the frozen validator after any authorized promotion.',
}
write(BASE / 'candidate-report.json', report)
print(json.dumps({'candidate': candidate_ref, 'changedNodes': ['B01', 'B36'],
                  'other37NodesIdentical': True, 'requiredChecks': {'B01': 11, 'B36': 3},
                  'valid': validation['valid'], 'accepted': len(validation['accepted']),
                  'remaining': len(validation['remaining']), 'liveLedgerUnchanged': True}, indent=2))
