#!/usr/bin/env python3
"""Read-only candidate evidence inspection; writes only new adjacent artifacts."""

import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[7]
OUT = Path(__file__).resolve().parent
BASE = ROOT / 'docs/execution/body-roadmap'
CANDIDATE = BASE / 'evidence/integration/first-wave-final-20261107/acceptance/candidate-ledger.json'
EXPECTED = ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36']
inventory = {}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def observe(path, expected=None):
    path = Path(path)
    target = (ROOT / path).resolve() if not path.is_absolute() else path.resolve()
    name = str(target.relative_to(ROOT))
    actual = sha(target)
    assert expected is None or actual == expected, ('hash mismatch', name)
    assert name not in inventory or inventory[name] == actual, ('mid-review drift', name)
    inventory[name] = actual
    return target


def bound(ref):
    return observe(ref['path'], ref['sha256'])


def read(path):
    return json.loads(observe(path).read_text())


def identity(ref):
    return ref['path'], ref['sha256']


def bindings(values):
    for name, digest in values.items():
        observe(name, digest)


def seals(document):
    result = set()
    for ref in document.get('artifacts', []):
        bound(ref)
        result.add(identity(ref))
    return result


def origin_command(command):
    provenance = command['provenance']
    path = bound(provenance)
    origin = json.loads(path.read_text())
    selected = origin
    pointer = provenance.get('jsonPointer', '')
    if pointer:
        for key in pointer.lstrip('/').split('/'):
            selected = selected[int(key)] if isinstance(selected, list) else selected[key]
    elif 'provenanceInvocationIndex' in command:
        selected = origin['invocations'][command['provenanceInvocationIndex']]
    elif 'provenanceCommandIndex' in command:
        selected = (origin if isinstance(origin, list) else origin['commands'])[command['provenanceCommandIndex']]
    assert selected.get('argv', selected.get('args')) == command['argv']
    assert selected.get('exitCode', selected.get('exit', selected.get('code'))) == command['exitCode'] == 0
    log = selected.get('log', selected.get('stdoutLog'))
    raw_log = log['path'] if isinstance(log, dict) else log
    log_path = Path(raw_log)
    if not log_path.is_absolute():
        log_path = ROOT / log_path if (ROOT / log_path).is_file() else path.parent / log_path
    assert log_path.resolve() == bound(command['log'])
    raw_hash = log.get('sha256') if isinstance(log, dict) else selected.get('logSha256')
    if raw_hash is not None:
        assert raw_hash == command['log']['sha256']
    for field in ('provenanceSourceManifest', 'sourceStability', 'currentInputInspection'):
        if field in command:
            bound(command[field])
    return {'origin': provenance, 'actualLog': command['log'], 'argv': command['argv']}


candidate = read(CANDIDATE)
live = read(BASE / 'ledger.json')
inputs = read(CANDIDATE.parent / 'inputs.json')
input_by_id = {row['nodeId']: row for row in inputs}
graph = candidate['completionGraph']
blocks = re.findall(r'```json\s*\n(.*?)\n```', observe(candidate['plan'], candidate['planSha256']).read_text(), re.S)
graphs = [value for block in blocks if isinstance(value := json.loads(block), dict) and value.get('dependencySemantics') == 'all-of']
assert graphs == [graph]
observe(candidate['specification'], candidate['specificationSha256'])
assert graph == live['completionGraph']
by_id = {node['nodeId']: node for node in candidate['nodes']}
live_by_id = {node['nodeId']: node for node in live['nodes']}
accepted = [node['nodeId'] for node in candidate['nodes'] if node['status'] == 'accepted']
assert accepted == EXPECTED == list(input_by_id)
assert len(by_id) == graph['nodeCount'] == 39 and graph['cardCount'] == 36
assert all(node['status'] == 'pending' for key, node in by_id.items() if key not in accepted)
assert all(node == live_by_id[key] for key, node in by_id.items() if key not in accepted)
assert candidate['evidenceDirectory'] == 'docs/execution/body-roadmap/evidence'
assert {key: value for key, value in candidate.items() if key not in ('nodes', 'updatedAt', 'evidenceDirectory')} == {
    key: value for key, value in live.items() if key not in ('nodes', 'updatedAt', 'evidenceDirectory')
}
ready = sorted(key for key, node in by_id.items() if key not in accepted and set(node['prerequisites']) <= set(accepted))
assert by_id['B19']['prerequisites'] == ['B02', 'B18'] and 'B19' in ready
assert 'B20' not in ready and 'B21' not in ready and 'B22' not in ready
assert graph['rollups']['B22'] == ['M22-CORE', 'M22-TXN', 'M22-CHILD']

nodes = []
raw_commands = set()
all_sources = {}
for node_id in accepted:
    node = by_id[node_id]
    declared = input_by_id[node_id]
    receipt = read(bound(node['acceptanceReceipt']))
    manifest = read(bound(receipt['manifest']))
    assert receipt['manifest']['path'] == node['evidenceManifest']
    assert node['acceptedPrerequisites'] == node['prerequisites'] == []
    assert receipt['acceptedPrerequisites'] == []
    assert node['coverageTier'] == receipt['coverageTier'] == declared['coverageTier']
    assert node['risks'] == receipt['limits'] == declared['limits']
    assert [row['evidence']['path'] for row in receipt['independentReviews']] == declared['reviews']
    source_union = {}
    original_seals = set()
    review_commands = []
    reviewer_rows = []
    seals(receipt)
    seals(manifest)
    for summary in receipt['independentReviews']:
        review = read(bound(summary['evidence']))
        original = read(bound(review['provenance']))
        for field in ('nodeId', 'reviewer', 'implementationOwners', 'independent', 'scope', 'decision', 'sourceContractHashes', 'commandReceipts'):
            assert review[field] == original[field], (node_id, field)
        assert original['type'] == 'body-independent-approval' and original['independent'] is True
        assert original['decision'] == 'approve' and original['nodeId'] == node_id
        assert original['reviewer'] not in original['implementationOwners']
        assert not original.get('neededReruns') and not original.get('requiredProductReruns')
        for field in ('sourceContractHashes', 'dependencyContractHashes', 'configurationHashes', 'frozenPlanHashes'):
            bindings(review.get(field, {}))
        for name, digest in review['sourceContractHashes'].items():
            assert name not in source_union or source_union[name] == digest
            source_union[name] = digest
        seals(review)
        original_seals |= seals(original)
        for ref in review['commandReceipts']:
            bound(ref)
            if ref not in review_commands:
                review_commands.append(ref)
        reviewer_rows.append({key: original[key] for key in ('reviewer', 'implementationOwners', 'scope', 'decision')}
                             | {'review': summary['evidence'], 'originalApproval': review['provenance']})
    assert source_union == node['sourceContractHashes'] == receipt['sourceContractHashes'] == manifest['sourceContractHashes']
    all_sources.update(source_union)
    assert [row['evidence'] for row in receipt['requiredChecks']] == review_commands == manifest['commandReceipts']
    assert node['verification']['requiredCommandCount'] == len(review_commands)
    commands = []
    for check in receipt['requiredChecks']:
        command = read(bound(check['evidence']))
        assert command['nodeId'] == node_id and command['type'] == 'body-acceptance-command'
        assert command['argv'] == check['argv'] and command['exitCode'] == check['exitCode'] == 0
        assert command['sourceBefore'] == command['sourceAfter']
        bindings(command['sourceBefore'])
        for before, after in [('configBefore', 'configAfter')]:
            assert command.get(before) == command.get(after)
            bindings(command.get(before, {}))
        provenance = origin_command(command)
        raw_commands.add((provenance['origin']['path'], json.dumps(command['argv']), command['log']['path']))
        commands.append({'name': command['name'], 'receipt': check['evidence'], 'sourceCount': len(command['sourceBefore']), **provenance})
    behavior = []
    assert [row['criterion'] for row in receipt['behaviorEvidence']] == list(declared['behaviorEvidence'])
    for control in receipt['behaviorEvidence']:
        assert [ref['path'] for ref in control['evidence']] == declared['behaviorEvidence'][control['criterion']]
        for ref in control['evidence']:
            assert identity(ref) in original_seals, ('behavior lacks original authority', node_id, ref)
            evidence = read(bound(ref))
            behavior.append({'criterion': control['criterion'], 'evidence': ref,
                             'originalApprovalSealed': True,
                             'topLevelKeys': list(evidence) if isinstance(evidence, dict) else ['array']})
    nodes.append({'nodeId': node_id, 'sourceCount': len(source_union), 'reviewers': reviewer_rows,
                  'commandCount': len(commands), 'commands': commands, 'behaviorCount': len(behavior), 'behavior': behavior,
                  'coverageTier': node['coverageTier'], 'limits': node['risks']})

validator_path = observe(BASE / 'validate-ledger.py', '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c')
spec = importlib.util.spec_from_file_location('frozen_candidate_validator', validator_path)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
controls = []


def negative(name, document, required_substring, require_complete=False):
    result = validator.validate(document, require_complete=require_complete)
    assert not result['valid'] and any(required_substring in error for error in result['errors']), (name, result)
    controls.append({'name': name, 'expectedValid': False, 'actualValid': result['valid'], 'errors': result['errors'], 'passed': True})


negative('Partial candidate cannot claim completion', candidate, 'completion requested with outstanding nodes', True)
mutated = copy.deepcopy(candidate)
next(node for node in mutated['nodes'] if node['nodeId'] == 'B20')['status'] = 'in_progress'
negative('B20 cannot start while B19 is pending', mutated, 'without all accepted prerequisites')
mutated = copy.deepcopy(candidate)
next(node for node in mutated['nodes'] if node['nodeId'] == 'B22')['status'] = 'accepted'
negative('B22 cannot absorb pending native milestones', mutated, 'without all accepted prerequisites')
mutated = copy.deepcopy(candidate)
row = next(node for node in mutated['nodes'] if node['nodeId'] == 'B04')
row['sourceContractHashes'][next(iter(row['sourceContractHashes']))] = '0' * 64
negative('Current accepted source cannot be rebound', mutated, 'hash')
for name, expected in inventory.items():
    assert sha(ROOT / name) == expected, ('final drift', name)
protected = read(OUT / 'protected-before.json')
for name, expected in protected.items():
    assert sha(ROOT / name) == expected, ('protected drift', name)
report = {'schemaVersion': 1, 'type': 'independent-candidate-consistency-inspection',
          'reviewer': '/root/b04_lock_cas', 'candidate': {'path': str(CANDIDATE.relative_to(ROOT)), 'sha256': sha(CANDIDATE)},
          'accepted': accepted, 'pendingCount': 31, 'ready': ready, 'graphMatchesFrozenPlan': True,
          'pendingNodesUnchangedFromLiveLedger': True, 'assemblyMatchesInputs': True,
          'sourceCountUnique': len(all_sources), 'reviewCount': sum(len(node['reviewers']) for node in nodes),
          'commandCredits': sum(node['commandCount'] for node in nodes), 'uniqueOriginalInvocations': len(raw_commands),
          'behaviorReferences': sum(node['behaviorCount'] for node in nodes), 'nodes': nodes,
          'negativeControls': controls, 'activeEvidenceHashes': inventory, 'activeEvidenceUnchanged': True,
          'protectedInputsUnchanged': True, 'productCommandsRerun': False,
          'scope': 'Evidence consistency only; original typed independent reviewers retain implementation authority.',
          'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
with (OUT / 'inspection.json').open('x') as handle:
    json.dump(report, handle, indent=2)
    handle.write('\n')
print(json.dumps({key: report[key] for key in ('accepted', 'pendingCount', 'ready', 'sourceCountUnique', 'reviewCount', 'commandCredits', 'uniqueOriginalInvocations', 'behaviorReferences', 'activeEvidenceUnchanged', 'protectedInputsUnchanged')}
                 | {'activeEvidenceFiles': len(inventory), 'negativeControlsPassed': len(controls)}, indent=2))
