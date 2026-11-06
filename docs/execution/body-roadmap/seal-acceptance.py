#!/usr/bin/env python3
"""Assemble immutable acceptance candidates from source-bound independent proofs."""

import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('ledger_validator', Path(__file__).with_name('validate-ledger.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def reference(path):
    path = path.resolve()
    return {'path': str(path.relative_to(ROOT)), 'sha256': validator.sha256(path)}


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')
    return reference(path)


def assemble(ledger, inputs):
    candidate = copy.deepcopy(ledger)
    by_id = {node['nodeId']: node for node in candidate['nodes']}
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    for card in inputs:
        node = by_id[card['nodeId']]
        if any(by_id[name]['status'] != 'accepted' for name in node['prerequisites']):
            raise ValueError('Unaccepted prerequisite for ' + node['nodeId'])
        source_hashes, artifact_hashes, command_refs, reviews = {}, {}, [], []
        contexts = {}
        for name in card['reviews']:
            path = ROOT/name
            review = json.loads(path.read_text())
            if (review.get('type') != 'body-implementation-review' or review.get('decision') != 'approve'
                    or review.get('nodeId') != node['nodeId'] or review.get('independent') is not True
                    or review.get('reviewer') in review.get('implementationOwners', [])):
                raise ValueError('Not an independent approval: ' + name)
            for source, digest in review['sourceContractHashes'].items():
                if source in source_hashes and source_hashes[source] != digest:
                    raise ValueError('Conflicting reviewed source: ' + source)
                if validator.sha256(ROOT/source) != digest:
                    raise ValueError('Reviewed source drift: ' + source)
                source_hashes[source] = digest
            for field in ['dependencyContractHashes', 'configurationHashes', 'frozenPlanHashes']:
                for source, digest in review.get(field, {}).items():
                    if validator.sha256(ROOT/source) != digest:
                        raise ValueError('Reviewed context drift: ' + source)
                    contexts[source] = digest
            refs = [reference(path), review['provenance'], *review['artifacts'], *review['commandReceipts']]
            for evidence in refs:
                actual = reference(ROOT/evidence['path'])
                if actual != evidence:
                    raise ValueError('Sealed artifact drift: ' + evidence['path'])
                artifact_hashes[evidence['path']] = evidence['sha256']
            for command in review['commandReceipts']:
                if command not in command_refs:
                    command_refs.append(command)
            reviews.append({key: review[key] for key in ['reviewer', 'implementationOwners', 'scope', 'decision']}
                           | {'evidence': reference(path)})
        artifacts = [{'path': name, 'sha256': digest} for name, digest in sorted(artifact_hashes.items())]
        directory = ROOT/'docs/execution/body-roadmap/evidence'/node['nodeId']/'accepted'
        manifest = write_new(directory/(stamp+'-manifest.json'), {
            'schemaVersion': 1, 'type': 'body-acceptance-evidence', 'nodeId': node['nodeId'],
            'sourceContractHashes': dict(sorted(source_hashes.items())),
            'contextContractHashes': dict(sorted(contexts.items())),
            'reviews': [review['evidence'] for review in reviews],
            'commandReceipts': command_refs, 'artifacts': artifacts,
            'scope': card['coverageTier'],
            'historicalEvidence': 'Raw historical JSON is preserved as data; its internal seals do not receive fresh acceptance credit.',
        })
        checks = []
        for evidence in command_refs:
            command = json.loads((ROOT/evidence['path']).read_text())
            checks.append({'name': command['name'], 'argv': command['argv'], 'exitCode': command['exitCode'],
                           'log': command['log'], 'evidence': evidence})
        node.update({
            'status': 'accepted', 'acceptedPrerequisites': node['prerequisites'],
            'sourceContractHashes': dict(sorted(source_hashes.items())),
            'backend': card.get('backend', 'ts'), 'epoch': card.get('epoch', candidate['baselineHead']),
            'coverageTier': card['coverageTier'], 'evidenceManifest': manifest['path'],
            'acceptedAt': datetime.now(timezone.utc).isoformat(),
            'verification': {'independentReviews': reviews, 'requiredCommandCount': len(checks)},
            'risks': card['limits'],
        })
        receipt = {key: node[key] for key in ['nodeId', 'parentCardId', 'repositoryId', 'backend',
                   'epoch', 'coverageTier', 'sourceContractHashes']}
        receipt.update({
            'schemaVersion': 1, 'status': 'accepted',
            'planSha256': candidate['planSha256'], 'specificationSha256': candidate['specificationSha256'],
            'acceptedPrerequisites': [{'nodeId': name, 'receipt': by_id[name]['acceptanceReceipt']}
                                      for name in node['prerequisites']],
            'manifest': manifest, 'independentReviews': reviews, 'requiredChecks': checks,
            'behaviorEvidence': [{'criterion': criterion, 'evidence': [reference(ROOT/name) for name in names]}
                                 for criterion, names in card['behaviorEvidence'].items()],
            'artifacts': artifacts, 'acceptedAt': node['acceptedAt'], 'limits': card['limits'],
        })
        node['acceptanceReceipt'] = write_new(directory/(stamp+'-acceptance.json'), receipt)
    candidate['evidenceDirectory'] = 'docs/execution/body-roadmap/evidence'
    candidate['updatedAt'] = datetime.now(timezone.utc).isoformat()
    report = validator.validate(candidate)
    return candidate, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=ROOT/'docs/execution/body-roadmap/ledger.json')
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    candidate, report = assemble(json.loads(args.ledger.read_text()), json.loads(args.inputs.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(candidate, indent=2) + '\n')
    args.output.with_suffix('.validation.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'valid': report['valid'], 'accepted': report['accepted'], 'errors': report['errors']}, indent=2))
    return 0 if report['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
