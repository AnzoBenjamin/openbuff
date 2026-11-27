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


def reference(path, *, root=ROOT):
    path = path.resolve()
    return {'path': str(path.relative_to(root.resolve())), 'sha256': validator.sha256(path)}


def write_new(path, value, *, root=ROOT):
    path.resolve().relative_to(root.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')
    return reference(path, root=root)


def checked_reference(evidence, root, label):
    try:
        path = root/evidence['path']
        if reference(path, root=root) == evidence:
            return path
    except (OSError, ValueError, KeyError, TypeError):
        pass
    raise ValueError(label)


def addendum_tasks(ledger, addendum_id, by_id, root):
    registry_path = checked_reference(ledger.get('acceptanceDecisionRegistry'), root, 'Execution plan registry drift')
    registry = json.loads(registry_path.read_text())
    matches = [addendum for addendum in registry['addenda'] if addendum['id'] == addendum_id]
    if len(matches) != 1 or not validator.REGISTRY_ID.fullmatch(addendum_id):
        raise ValueError('Unknown/ambiguous addendum: ' + addendum_id)
    checked_reference(matches[0].get('document'), root, 'Addendum document drift: ' + addendum_id)

    seen = set(by_id)
    for addendum in registry['addenda']:
        for task in addendum['tasks']:
            name = task['id']
            if name in seen or not validator.REGISTRY_ID.fullmatch(name):
                raise ValueError('Duplicate/invalid addendum task: ' + name)
            seen.add(name)
            if task['status'] == 'accepted':
                by_id[name] = task['acceptanceNode']
    return registry, {task['id']: task for task in matches[0]['tasks']}


def assemble(ledger, inputs, *, root=ROOT, addendum_id=None):
    """Stage immutable evidence and return (candidate ledger, validation report).

    In addendum mode inputs are in prerequisite order and also name repositoryId.
    The candidate points to a new registry file; neither original root is written.
    """
    candidate = copy.deepcopy(ledger)
    by_id = {node['nodeId']: node for node in candidate['nodes']}
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    evidence_root = root/'docs/execution/body-roadmap/evidence'
    if addendum_id is not None:
        if not inputs:
            raise ValueError('No addendum task inputs')
        registry, tasks = addendum_tasks(candidate, addendum_id, by_id, root)
    for card in inputs:
        if addendum_id is None:
            node = by_id[card['nodeId']]
        else:
            task = tasks[card['nodeId']]
            node = {'nodeId': task['id'], 'parentCardId': None, 'repositoryId': card['repositoryId'],
                    'prerequisites': task['prerequisites']}
        for name in node['prerequisites']:
            prerequisite = by_id.get(name, {})
            if prerequisite.get('status') != 'accepted':
                raise ValueError(f'Unaccepted prerequisite {name} for {node["nodeId"]}')
            if addendum_id is not None and ('acceptanceDecision' in prerequisite or not prerequisite.get('acceptanceReceipt')):
                raise ValueError(f'No strict prerequisite receipt {name} for {node["nodeId"]}')
        source_hashes, artifact_hashes, command_refs, reviews = {}, {}, [], []
        contexts = {}
        for name in card['reviews']:
            path = root/name
            review = json.loads(path.read_text())
            if (review.get('type') != 'body-implementation-review' or review.get('decision') != 'approve'
                    or review.get('nodeId') != node['nodeId'] or review.get('independent') is not True
                    or review.get('reviewer') in review.get('implementationOwners', [])):
                raise ValueError('Not an independent approval: ' + name)
            for source, digest in review['sourceContractHashes'].items():
                if source in source_hashes and source_hashes[source] != digest:
                    raise ValueError('Conflicting reviewed source: ' + source)
                if validator.sha256(root/source) != digest:
                    raise ValueError('Reviewed source drift: ' + source)
                source_hashes[source] = digest
            for field in validator.REVIEW_CONTEXT_FIELDS:
                for source, digest in review.get(field, {}).items():
                    if validator.sha256(root/source) != digest:
                        raise ValueError('Reviewed context drift: ' + source)
                    contexts[source] = digest
            review_ref = reference(path, root=root)
            refs = [review_ref, review['provenance'], *review['artifacts'], *review['commandReceipts']]
            for evidence in refs:
                actual = reference(root/evidence['path'], root=root)
                if actual != evidence:
                    raise ValueError('Sealed artifact drift: ' + evidence['path'])
                artifact_hashes[evidence['path']] = evidence['sha256']
            for command in review['commandReceipts']:
                if command not in command_refs:
                    command_refs.append(command)
            reviews.append({key: review[key] for key in ['reviewer', 'implementationOwners', 'scope', 'decision']}
                           | {'evidence': review_ref})
        artifacts = [{'path': name, 'sha256': digest} for name, digest in sorted(artifact_hashes.items())]
        directory = evidence_root/node['nodeId']/'accepted'
        contexts = dict(sorted(contexts.items()))
        extra = {'addendumId': addendum_id, 'contextContractHashes': contexts} if addendum_id is not None else {}
        manifest = write_new(directory/(stamp+'-manifest.json'), {
            'schemaVersion': 1, 'type': 'body-acceptance-evidence', 'nodeId': node['nodeId'],
            'sourceContractHashes': dict(sorted(source_hashes.items())),
            'contextContractHashes': contexts,
            'reviews': [review['evidence'] for review in reviews],
            'commandReceipts': command_refs, 'artifacts': artifacts,
            'scope': card['coverageTier'],
            'historicalEvidence': 'Raw historical JSON is preserved as data; its internal seals do not receive fresh acceptance credit.',
            **extra,
        }, root=root)
        checks = []
        for evidence in command_refs:
            command = json.loads((root/evidence['path']).read_text())
            checks.append({'name': command['name'], 'argv': command['argv'], 'exitCode': command['exitCode'],
                           'log': command['log'], 'evidence': evidence})
        node.update({
            'status': 'accepted', 'acceptedPrerequisites': node['prerequisites'],
            'sourceContractHashes': dict(sorted(source_hashes.items())),
            'backend': card.get('backend', 'ts'), 'epoch': card.get('epoch', candidate['baselineHead']),
            'coverageTier': card['coverageTier'], 'evidenceManifest': manifest['path'],
            'acceptedAt': datetime.now(timezone.utc).isoformat(),
            'verification': {'independentReviews': reviews, 'requiredCommandCount': len(checks)},
            'risks': card['limits'], **extra,
        })
        receipt = {key: node[key] for key in ['nodeId', 'parentCardId', 'repositoryId', 'backend',
                   'epoch', 'coverageTier', 'sourceContractHashes']}
        receipt.update({
            'schemaVersion': 1, 'status': 'accepted',
            'planSha256': candidate['planSha256'], 'specificationSha256': candidate['specificationSha256'],
            'acceptedPrerequisites': [{'nodeId': name, 'receipt': by_id[name]['acceptanceReceipt']}
                                      for name in node['prerequisites']],
            'manifest': manifest, 'independentReviews': reviews, 'requiredChecks': checks,
            'behaviorEvidence': [{'criterion': criterion, 'evidence': [reference(root/name, root=root) for name in names]}
                                 for criterion, names in card['behaviorEvidence'].items()],
            'artifacts': artifacts, 'acceptedAt': node['acceptedAt'], 'limits': card['limits'], **extra,
        })
        node['acceptanceReceipt'] = write_new(directory/(stamp+'-acceptance.json'), receipt, root=root)
        if addendum_id is not None:
            task.update({'status': 'accepted', 'acceptanceNode': node})
            by_id[node['nodeId']] = node
    if addendum_id is None:
        candidate['evidenceDirectory'] = 'docs/execution/body-roadmap/evidence'
        candidate['updatedAt'] = datetime.now(timezone.utc).isoformat()
    else:
        candidate['acceptanceDecisionRegistry'] = write_new(
            evidence_root/addendum_id/(stamp+'-execution-plan.json'), registry, root=root)
    report = validator.validate(candidate, root)
    return candidate, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=ROOT/'docs/execution/body-roadmap/ledger.json')
    parser.add_argument('--addendum', metavar='ID', help='seal registered tasks into a new candidate registry')
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report_path = args.output.with_suffix('.validation.json')
    if args.addendum is not None and any(path.exists() or path.is_symlink() for path in [args.output, report_path]):
        parser.error('addendum output and validation paths must be new files')
    try:
        candidate, report = assemble(json.loads(args.ledger.read_text()), json.loads(args.inputs.read_text()),
                                     addendum_id=args.addendum)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        if args.addendum is None:
            raise
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for path, value in [(args.output, candidate), (report_path, report)]:
        with path.open('x' if args.addendum is not None else 'w') as stream:
            stream.write(json.dumps(value, indent=2) + '\n')
    print(json.dumps({'valid': report['valid'], 'accepted': report['accepted'], 'errors': report['errors']}, indent=2))
    return 0 if report['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
