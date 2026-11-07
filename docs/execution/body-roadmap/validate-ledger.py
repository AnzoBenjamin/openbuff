#!/usr/bin/env python3
"""Validate plan dependencies and sealed acceptance evidence, without running it."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
LEDGER = ROOT / 'docs/execution/body-roadmap/ledger.json'
HASH = re.compile(r'^[a-f0-9]{64}$')
STATUSES = {'pending', 'in_progress', 'accepted', 'blocked', 'unavailable'}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            digest.update(block)
    return digest.hexdigest()


def source_bindings(document, field=None):
    """Read declared source identities, including the preserved fixture formats."""
    fields = [field] if field else [
        'sourceContractHashes', 'sourceHashes', 'sourceBindings', 'currentSources',
        'reviewedSources', 'dependencyBindings', 'configBindings', 'frozenPlanBindings',
        'sourceRows', 'sourceBefore', 'sourceAfter',
    ]
    result = {}
    for key in fields:
        value = document.get(key, {}) if isinstance(document, dict) else {}
        if isinstance(value, dict):
            rows = [{'path': name, 'sha256': digest} for name, digest in value.items()]
        elif isinstance(value, list):
            rows = value
        else:
            continue
        for row in rows:
            name = row.get('path', row.get('file'))
            digest = row.get('sha256', row.get('candidateHash', row.get('currentHash')))
            if not isinstance(name, str) or not isinstance(digest, str) or not HASH.fullmatch(digest):
                continue
            if name in result and result[name] != digest:
                raise ValueError(f'contradictory source binding for {name}')
            result[name] = digest
    return result


def validate(ledger, root=ROOT, require_complete=False):
    errors = []

    def fail(message):
        errors.append(message)

    def file_binding(path, expected, label):
        if not isinstance(path, str) or not isinstance(expected, str) or not HASH.fullmatch(expected):
            fail(f'{label}: invalid path/hash binding')
            return None
        relative = Path(path)
        if relative.is_absolute() or '..' in relative.parts:
            fail(f'{label}: evidence must use a contained repository-relative path')
            return None
        target = root / relative
        if not target.resolve().is_relative_to(root.resolve()):
            fail(f'{label}: path escapes repository')
            return None
        if not target.is_file():
            fail(f'{label}: missing {path}')
            return None
        if sha256(target) != expected:
            fail(f'{label}: hash mismatch for {path}')
            return None
        return target

    def reference(value, label):
        if not isinstance(value, dict):
            fail(f'{label}: missing evidence reference')
            return None
        return file_binding(value.get('path'), value.get('sha256'), label)

    def load(path, label, object_only=True):
        if path is None:
            return None
        try:
            value = json.loads(path.read_text())
            if object_only and not isinstance(value, dict):
                raise ValueError('expected an object')
            return value
        except (OSError, ValueError) as error:
            fail(f'{label}: unreadable JSON: {error}')
            return None

    def artifact_seal(document, label):
        artifacts = document.get('artifacts')
        if not isinstance(artifacts, list) or not artifacts:
            fail(f'{label}: missing closed artifact seal')
            return set()
        identities = set()
        for artifact in artifacts:
            reference(artifact, f'{label} sealed artifact')
            if isinstance(artifact, dict):
                identities.add((artifact.get('path'), artifact.get('sha256')))
        return identities

    def current_sources(bindings, label):
        for name, digest in bindings.items():
            file_binding(name, digest, label)

    def matching_sources(bindings, expected, label):
        if not isinstance(bindings, dict) or not bindings:
            fail(f'{label}: missing source bindings')
            return set()
        matched = set()
        for name, digest in bindings.items():
            if name in expected:
                if digest != expected[name]:
                    fail(f'{label}: stale source binding for {name}')
                else:
                    matched.add(name)
        if not matched:
            fail(f'{label}: no accepted source is bound')
        return matched

    def origin_selection(document, label):
        provenance = document.get('provenance')
        path = reference(provenance, label + ' provenance')
        origin = load(path, label, object_only=False)
        if origin is None:
            return None, None, path
        selected = origin
        pointer = provenance.get('jsonPointer', '')
        if not isinstance(pointer, str) or not re.fullmatch(r'(?:/(?:commands|invocations)/\d+|/\d+)?', pointer):
            fail(f'{label}: unsupported command provenance selection')
            return None, origin, path
        try:
            for component in pointer.split('/')[1:]:
                selected = selected[int(component)] if isinstance(selected, list) else selected[component]
            for index_field, list_field in [('provenanceInvocationIndex', 'invocations'),
                                          ('provenanceCommandIndex', 'commands')]:
                if index_field in document:
                    if pointer:
                        raise ValueError('ambiguous provenance selection')
                    index = document[index_field]
                    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
                        raise ValueError('invalid provenance index')
                    if list_field == 'commands' and isinstance(selected, list):
                        selected = selected[index]
                    else:
                        selected = selected[list_field][index]
            if not isinstance(selected, dict):
                raise ValueError('selected command is not an object')
        except (IndexError, KeyError, ValueError, TypeError) as error:
            fail(f'{label}: invalid command provenance: {error}')
            selected = None
        return selected, origin, path

    def origin_log(value, base):
        if isinstance(value, dict):
            return value.get('path')
        if not isinstance(value, str):
            return None
        path = Path(value)
        if not path.is_absolute():
            path = root / path if (root / path).is_file() else base / path
        try:
            return str(path.resolve().relative_to(root.resolve()))
        except ValueError:
            return None

    def original_artifacts(document, base, label):
        """Check the original seal itself, without interpreting sealed raw data."""
        identities = set()
        for field in ['artifacts', 'evidence']:
            value = document.get(field, []) if isinstance(document, dict) else []
            if isinstance(value, dict):
                rows = [{'path': name, 'sha256': digest} for name, digest in value.items()]
            elif isinstance(value, list):
                rows = value
            else:
                fail(f'{label}: invalid original {field} seal')
                continue
            for row in rows:
                if not isinstance(row, dict):
                    fail(f'{label}: invalid original sealed artifact')
                    continue
                name = origin_log(row.get('path', row.get('file')), base)
                digest = row.get('sha256')
                file_binding(name, digest, label + ' original sealed artifact')
                identities.add((name, digest))
        return identities

    def command_provenance(command, label):
        selected, origin, path = origin_selection(command, label)
        if selected is None:
            return
        original_exit = selected.get('exitCode', selected.get('exit', selected.get('code')))
        if selected.get('argv', selected.get('args')) != command.get('argv') or original_exit != command.get('exitCode'):
            fail(f'{label}: command differs from original argv/exit')
        actual_log = origin_log(selected.get('log'), path.parent)
        if actual_log != command.get('log', {}).get('path'):
            fail(f'{label}: substituted original command log')
        original_hash = selected.get('logSha256', selected.get('logHash'))
        if isinstance(selected.get('log'), dict):
            original_hash = selected['log'].get('sha256')
        if original_hash is not None and original_hash != command.get('log', {}).get('sha256'):
            fail(f'{label}: original command log hash differs')
        original_artifacts(selected, path.parent, label)
        if isinstance(origin, dict) and origin is not selected:
            original_artifacts(origin, path.parent, label)
        inputs = command.get('inputProvenance', {})
        for phase in ['before', 'after']:
            field = 'sourceBefore' if phase == 'before' else 'sourceAfter'
            # A formatter cannot replace a recorded input map with a newer file.
            # Grouped invocation receipts retain their enclosing original maps.
            recorded = next((value for value in [selected, origin]
                             if isinstance(value, dict) and field in value), None)
            exact = recorded is not None
            if exact:
                declared = source_bindings(recorded, field)
            else:
                declared = source_bindings(origin)
                if not declared:
                    source_reference = command.get('provenanceSourceManifest', inputs.get(phase))
                    source_path = reference(source_reference, label + ' original source manifest')
                    source_document = load(source_path, label + ' original source manifest')
                    declared = source_bindings(source_document)
                    anchors = original_artifacts(source_document, source_path.parent, label) if source_path else set()
                    identity = (command.get('provenance', {}).get('path'), command.get('provenance', {}).get('sha256'))
                    if identity not in anchors:
                        fail(f'{label}: original source manifest does not bind the actual command')
            normalized = command.get(field, {})
            if (not normalized or not declared
                    or (exact and normalized != declared)
                    or any(declared.get(name) != digest for name, digest in normalized.items())):
                fail(f'{label}: normalized {phase} inputs lack original source provenance')
            current_sources(declared, label + ' original ' + phase + ' input')
            current_sources(normalized, label + ' normalized ' + phase + ' input')
            input_reference = inputs.get(phase)
            if input_reference is not None:
                input_document = load(reference(input_reference, label + ' ' + phase + ' inputs'), label)
                supplemental = source_bindings(input_document, field) if isinstance(input_document, dict) and field in input_document else source_bindings(input_document)
                if not supplemental or any(supplemental.get(name) != digest for name, digest in normalized.items()):
                    fail(f'{label}: supplemental {phase} inputs differ from the original command')
                current_sources(supplemental, label + ' supplemental ' + phase + ' input')

    if ledger.get('schemaVersion') != 1:
        fail('unsupported ledger schema')
    plan = file_binding(ledger.get('plan'), ledger.get('planSha256'), 'plan')
    file_binding(ledger.get('specification'), ledger.get('specificationSha256'), 'specification')
    graph = ledger.get('completionGraph', {})
    canonical = []
    if plan:
        for block in re.findall(r'```json\s*\n(.*?)\n```', plan.read_text(), flags=re.S):
            try:
                value = json.loads(block)
                if isinstance(value, dict) and value.get('dependencySemantics') == 'all-of':
                    canonical.append(value)
            except ValueError:
                continue
        if len(canonical) != 1 or canonical[0] != graph:
            fail('ledger graph differs from the single canonical all-of plan graph')
    if not isinstance(graph, dict) or graph.get('dependencySemantics') != 'all-of':
        fail('completion graph must declare all-of dependencies')
        graph = {}
    graph_nodes = graph.get('nodes', [])
    graph_by_id = {}
    for item in graph_nodes:
        node_id = item.get('id')
        if not isinstance(node_id, str) or node_id in graph_by_id:
            fail(f'duplicate/invalid completion node: {node_id}')
        else:
            graph_by_id[node_id] = item
    if graph.get('nodeCount') != len(graph_nodes):
        fail('completion node count mismatch')
    if graph.get('cardCount') != sum(n.get('kind') == 'card' for n in graph_nodes):
        fail('completion card count mismatch')
    active, visited = set(), set()

    def visit(node_id):
        if node_id in active:
            fail(f'completion dependency cycle at {node_id}')
            return
        if node_id in visited:
            return
        active.add(node_id)
        for prerequisite in graph_by_id[node_id].get('prerequisites', []):
            if prerequisite not in graph_by_id:
                fail(f'{node_id}: unknown prerequisite {prerequisite}')
            else:
                visit(prerequisite)
        active.remove(node_id)
        visited.add(node_id)

    for node_id in graph_by_id:
        visit(node_id)
    for parent, children in graph.get('rollups', {}).items():
        if parent not in graph_by_id or graph_by_id[parent].get('prerequisites') != children:
            fail(f'{parent}: rollup does not require its exact milestones')
        for child in children:
            if child not in graph_by_id or graph_by_id[child].get('parentCardId') != parent:
                fail(f'{parent}: invalid child milestone {child}')

    entries = ledger.get('nodes', [])
    by_id = {}
    for node in entries:
        node_id = node.get('nodeId')
        if node_id in by_id:
            fail(f'duplicate ledger node: {node_id}')
        by_id[node_id] = node
    if set(by_id) != set(graph_by_id):
        fail('ledger membership differs from canonical completion graph')

    accepted = {node_id for node_id, node in by_id.items() if node.get('status') == 'accepted'}
    for node_id, node in by_id.items():
        expected = graph_by_id.get(node_id)
        if expected is None:
            continue
        for field in graph.get('ledgerRequiredFields', []):
            if field not in node:
                fail(f'{node_id}: missing ledger field {field}')
        prerequisites = expected.get('prerequisites', [])
        if node.get('prerequisites') != prerequisites:
            fail(f'{node_id}: prerequisite list differs from plan')
        if node.get('parentCardId') != expected.get('parentCardId'):
            fail(f'{node_id}: milestone parent differs from plan')
        status = node.get('status')
        if status not in STATUSES:
            fail(f'{node_id}: invalid status {status}')
        if status in {'accepted', 'in_progress'} and not set(prerequisites) <= accepted:
            fail(f'{node_id}: started/accepted without all accepted prerequisites')
        if not set(node.get('acceptedPrerequisites', [])) <= set(prerequisites) & accepted:
            fail(f'{node_id}: unsupported prerequisite credit')
        if status != 'accepted':
            continue
        if node.get('acceptedPrerequisites') != prerequisites:
            fail(f'{node_id}: acceptance must name all prerequisites')
        receipt_path = reference(node.get('acceptanceReceipt'), f'{node_id} acceptance receipt')
        receipt = load(receipt_path, node_id)
        if receipt is None:
            continue
        if receipt.get('schemaVersion') != 1 or receipt.get('status') != 'accepted':
            fail(f'{node_id}: unsupported/unaccepted receipt')
        for key in ['nodeId', 'parentCardId', 'repositoryId', 'backend', 'epoch', 'coverageTier', 'sourceContractHashes']:
            if receipt.get(key) != node.get(key):
                fail(f'{node_id}: receipt/ledger mismatch for {key}')
        for key in ['planSha256', 'specificationSha256']:
            if receipt.get(key) != ledger.get(key):
                fail(f'{node_id}: receipt binds a different {key}')
        if not node.get('coverageTier') or not node.get('repositoryId') or not node.get('epoch'):
            fail(f'{node_id}: missing accepted scope/identity')
        hashes = node.get('sourceContractHashes')
        if not isinstance(hashes, dict) or not hashes:
            fail(f'{node_id}: no accepted source bindings')
        else:
            for name, digest in hashes.items():
                file_binding(name, digest, f'{node_id} current source')
        manifest_path = reference(receipt.get('manifest'), f'{node_id} evidence manifest')
        manifest = load(manifest_path, node_id + ' evidence manifest')
        if manifest is None or node.get('evidenceManifest') != receipt.get('manifest', {}).get('path'):
            fail(f'{node_id}: evidence manifest is missing or differs from ledger')
        if manifest is None:
            continue
        if (manifest.get('schemaVersion') != 1 or manifest.get('type') != 'body-acceptance-evidence'
                or manifest.get('nodeId') != node_id or manifest.get('sourceContractHashes') != hashes):
            fail(f'{node_id}: manifest does not bind the accepted node/sources')
        manifest_artifacts = artifact_seal(manifest, node_id + ' manifest')
        dependency_rows = receipt.get('acceptedPrerequisites', [])
        if [row.get('nodeId') for row in dependency_rows] != prerequisites:
            fail(f'{node_id}: receipt prerequisites differ from plan')
        for row in dependency_rows:
            prerequisite = by_id.get(row.get('nodeId'), {})
            if row.get('receipt') != prerequisite.get('acceptanceReceipt'):
                fail(f'{node_id}: stale prerequisite receipt for {row.get("nodeId")}')
            reference(row.get('receipt'), f'{node_id} prerequisite')
        reviews = receipt.get('independentReviews', [])
        if not reviews:
            fail(f'{node_id}: no independent implementation review')
        reviewed_sources = set()
        review_commands = set()
        reviewed_artifacts = set()
        for review in reviews:
            if (review.get('decision') != 'approve' or not review.get('scope')
                    or not review.get('reviewer') or not review.get('implementationOwners')
                    or review.get('reviewer') in review.get('implementationOwners', [])):
                fail(f'{node_id}: rejected/ambiguous/self-authored review')
            review_document = load(reference(review.get('evidence'), f'{node_id} independent review'), node_id)
            if review_document is not None:
                if (review_document.get('schemaVersion') != 1
                        or review_document.get('type') != 'body-implementation-review'
                        or review_document.get('nodeId') != node_id
                        or review_document.get('independent') is not True):
                    fail(f'{node_id}: missing authoritative independent review identity')
                for key in ['reviewer', 'implementationOwners', 'scope', 'decision']:
                    if review_document.get(key) != review.get(key):
                        fail(f'{node_id}: wrapper differs from authoritative review {key}')
                if review_document.get('decision') != 'approve':
                    fail(f'{node_id}: referenced review does not approve the implementation')
                reviewed_sources |= matching_sources(review_document.get('sourceContractHashes'), hashes, node_id + ' review')
                for field in ['dependencyContractHashes', 'configurationHashes', 'frozenPlanHashes']:
                    current_sources(review_document.get(field, {}), node_id + ' review context')
                review_origin = load(reference(review_document.get('provenance'), node_id + ' review provenance'), node_id)
                if review_origin is not None:
                    if (review_origin.get('schemaVersion') != 1
                            or review_origin.get('type') != 'body-independent-approval'
                            or review_origin.get('independent') is not True):
                        fail(f'{node_id}: missing structured original independent approval')
                    for field in ['nodeId', 'reviewer', 'implementationOwners', 'independent', 'scope', 'decision']:
                        if review_origin.get(field) != review_document.get(field):
                            fail(f'{node_id}: {field} differs from original independent provenance')
                    owners = review_origin.get('implementationOwners')
                    if (not isinstance(owners, list) or not owners
                            or review_origin.get('reviewer') in owners):
                        fail(f'{node_id}: original implementation review is author-affiliated')
                    if review_origin.get('decision') != 'approve':
                        fail(f'{node_id}: original implementation review does not approve acceptance')
                    declared = review_origin.get('sourceContractHashes')
                    if declared != review_document.get('sourceContractHashes'):
                        fail(f'{node_id}: reviewed sources lack original independent provenance')
                    current_sources(source_bindings(review_origin), node_id + ' original review source')
                    reviewed_artifacts |= artifact_seal(review_origin, node_id + ' original review')
                    if review_origin.get('commandReceipts') != review_document.get('commandReceipts'):
                        fail(f'{node_id}: command credit differs from original independent approval')
                sealed = artifact_seal(review_document, node_id + ' review')
                if not sealed <= manifest_artifacts:
                    fail(f'{node_id}: manifest omits review-sealed artifacts')
                for command in review_document.get('commandReceipts', []):
                    reference(command, node_id + ' reviewed command')
                    review_commands.add((command.get('path'), command.get('sha256')))
        if reviewed_sources != set(hashes):
            fail(f'{node_id}: accepted sources lack current independent review coverage')
        if manifest.get('reviews') != [review.get('evidence') for review in reviews]:
            fail(f'{node_id}: manifest review identities differ from acceptance')
        checks = receipt.get('requiredChecks', [])
        if not checks:
            fail(f'{node_id}: no required command evidence')
        check_identities = [(check.get('evidence', {}).get('path'), check.get('evidence', {}).get('sha256'))
                            for check in checks]
        if len(check_identities) != len(set(check_identities)) or set(check_identities) != review_commands:
            fail(f'{node_id}: required checks must include every independently credited command exactly once')
        tested_sources = set()
        for check in checks:
            if not check.get('argv') or check.get('exitCode') != 0:
                fail(f'{node_id}: missing/failed required command {check.get("name")}')
            reference(check.get('log'), f'{node_id} command log')
            command = load(reference(check.get('evidence'), f'{node_id} command receipt'), node_id)
            if command is not None:
                actual_exit = command.get('exitCode', command.get('exit', command.get('code')))
                if actual_exit != check.get('exitCode') or command.get('argv', command.get('args')) != check.get('argv'):
                    fail(f'{node_id}: command evidence disagrees with required check')
                if (command.get('schemaVersion') != 1 or command.get('type') != 'body-acceptance-command'
                        or command.get('nodeId') != node_id):
                    fail(f'{node_id}: unsupported command receipt')
                if command.get('log') != check.get('log'):
                    fail(f'{node_id}: required log differs from actual command log')
                reference(command.get('log'), node_id + ' actual command log')
                before = command.get('sourceBefore')
                after = command.get('sourceAfter')
                if before != after:
                    fail(f'{node_id}: source changed during credited command')
                tested_sources |= matching_sources(before, hashes, node_id + ' command')
                command_provenance(command, node_id + ' command')
            identity = (check.get('evidence', {}).get('path'), check.get('evidence', {}).get('sha256'))
            if identity not in review_commands:
                fail(f'{node_id}: required command has no independent evidence credit')
        if tested_sources != set(hashes):
            fail(f'{node_id}: accepted sources lack current command coverage')
        if manifest.get('commandReceipts') != [check.get('evidence') for check in checks]:
            fail(f'{node_id}: manifest command identities differ from acceptance')
        behavior = receipt.get('behaviorEvidence', [])
        if not behavior:
            fail(f'{node_id}: no producer/consumer oracle evidence')
        for control in behavior:
            if not control.get('criterion') or not control.get('evidence'):
                fail(f'{node_id}: empty behavior control')
            for evidence in control.get('evidence', []):
                reference(evidence, f'{node_id} behavior evidence')
                if (evidence.get('path'), evidence.get('sha256')) not in reviewed_artifacts:
                    fail(f'{node_id}: behavior evidence lacks an independent review seal')
        for artifact in receipt.get('artifacts', []):
            reference(artifact, f'{node_id} sealed artifact')

    for parent, children in graph.get('rollups', {}).items():
        if parent not in accepted:
            continue
        identity = {field: by_id[parent].get(field) for field in ['repositoryId', 'backend', 'epoch']}
        for child in children:
            if any(by_id.get(child, {}).get(field) != value for field, value in identity.items()):
                fail(f'{parent}: milestone {child} uses a different authority identity')

    remaining = [node_id for node_id in graph_by_id if node_id not in accepted]
    if require_complete and remaining:
        fail('completion requested with outstanding nodes: ' + ', '.join(remaining))
    return {
        'schemaVersion': 1,
        'valid': not errors,
        'scope': 'plan/ledger/evidence consistency; no product or unavailable-platform assurance is inferred',
        'cardCount': graph.get('cardCount'),
        'nodeCount': graph.get('nodeCount'),
        'accepted': sorted(accepted),
        'remaining': remaining,
        'ready': [node_id for node_id in remaining
                  if set(graph_by_id[node_id].get('prerequisites', [])) <= accepted
                  and by_id.get(node_id, {}).get('status') in {'pending', 'in_progress'}],
        'errors': errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=LEDGER)
    parser.add_argument('--require-complete', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        report = validate(json.loads(args.ledger.read_text()), require_complete=args.require_complete)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
        report = {'valid': False, 'errors': [f'invalid ledger: {error}']}
    rendered = json.dumps(report, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered)
    print(rendered, end='')
    return 0 if report['valid'] else 1


if __name__ == '__main__':
    sys.exit(main())
