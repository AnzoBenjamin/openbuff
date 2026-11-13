#!/usr/bin/env python3
"""Adversarial controls for dependency and evidence credit in the execution ledger."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('ledger_validator', Path(__file__).with_name('validate-ledger.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='openbuff-ledger-controls-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        graph = {
            'schemaVersion': 2, 'cardCount': 3, 'nodeCount': 5,
            'dependencySemantics': 'all-of',
            'rollups': {'B22': ['M22-CORE', 'M22-TXN']},
            'ledgerRequiredFields': ['nodeId', 'parentCardId', 'acceptedPrerequisites',
                                     'sourceContractHashes', 'repositoryId', 'backend',
                                     'epoch', 'coverageTier', 'evidenceManifest'],
            'nodes': [
                {'id': 'B01', 'kind': 'card', 'prerequisites': []},
                {'id': 'B02', 'kind': 'card', 'prerequisites': ['B01']},
                {'id': 'B22', 'kind': 'card', 'prerequisites': ['M22-CORE', 'M22-TXN']},
                {'id': 'M22-CORE', 'kind': 'milestone', 'parentCardId': 'B22', 'prerequisites': ['B02']},
                {'id': 'M22-TXN', 'kind': 'milestone', 'parentCardId': 'B22', 'prerequisites': ['M22-CORE']},
            ],
        }
        (self.root / 'plan.md').write_text('```json\n' + json.dumps(graph) + '\n```\n')
        (self.root / 'spec.md').write_text('finite fixture specification\n')
        self.ledger = {
            'schemaVersion': 1, 'plan': 'plan.md', 'planSha256': validator.sha256(self.root/'plan.md'),
            'specification': 'spec.md', 'specificationSha256': validator.sha256(self.root/'spec.md'),
            'completionGraph': graph, 'nodes': [],
        }
        for item in graph['nodes']:
            self.ledger['nodes'].append({
                'nodeId': item['id'], 'parentCardId': item.get('parentCardId'), 'status': 'pending',
                'prerequisites': item['prerequisites'], 'acceptedPrerequisites': [],
                'sourceContractHashes': {}, 'repositoryId': 'fixture', 'backend': 'ts',
                'epoch': None, 'coverageTier': None, 'evidenceManifest': None,
            })

    def write(self, name, value):
        path = self.root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value if isinstance(value, str) else json.dumps(value))
        return {'path': name, 'sha256': validator.sha256(path)}

    def node(self, name):
        return next(node for node in self.ledger['nodes'] if node['nodeId'] == name)

    def accept(self, name):
        node = self.node(name)
        source = self.write(f'source/{name}.txt', 'exact source bytes\n')
        hashes = {source['path']: source['sha256']}
        log = self.write(f'evidence/{name}/command.log', 'observed fixture pass\n')
        oracle = self.write(f'evidence/{name}/oracle.json', {'before': 'foreign', 'after': 'foreign', 'confirmed': 0})
        original_command = {'argv': ['fixture', 'check'], 'exitCode': 0, 'log': log,
                            'sourceBefore': hashes, 'sourceAfter': hashes}
        command_origin = self.write(f'evidence/{name}/original-command.json', original_command)
        command = self.write(f'evidence/{name}/command.json', {
            **original_command, 'schemaVersion': 1, 'type': 'body-acceptance-command',
            'nodeId': name, 'provenance': command_origin,
        })
        original_review = {'schemaVersion': 1, 'type': 'body-independent-approval',
                           'nodeId': name, 'reviewer': '/root/verifier', 'independent': True,
                           'implementationOwners': ['/root/implementer'], 'scope': 'producer and actual consumer',
                           'decision': 'approve', 'sourceContractHashes': hashes,
                           'artifacts': [oracle, log, command, command_origin],
                           'commandReceipts': [command]}
        review_origin = self.write(f'evidence/{name}/original-review.json', original_review)
        artifacts = [oracle, log, command, command_origin, review_origin]
        review_document = {
            **original_review, 'schemaVersion': 1, 'type': 'body-implementation-review',
            'independent': True, 'provenance': review_origin,
            'artifacts': artifacts, 'commandReceipts': [command],
        }
        review = self.write(f'evidence/{name}/review.json', review_document)
        artifacts = [*artifacts, review]
        manifest = self.write(f'evidence/{name}/manifest.json', {
            'schemaVersion': 1, 'type': 'body-acceptance-evidence', 'nodeId': name,
            'sourceContractHashes': hashes, 'reviews': [review],
            'commandReceipts': [command], 'artifacts': artifacts,
        })
        node.update({'status': 'accepted', 'acceptedPrerequisites': node['prerequisites'],
                     'sourceContractHashes': hashes, 'epoch': 'fixture-source-epoch',
                     'coverageTier': 'controlled fixture only', 'evidenceManifest': manifest['path']})
        receipt = {key: copy.deepcopy(node[key]) for key in ['nodeId', 'parentCardId', 'repositoryId',
                   'backend', 'epoch', 'coverageTier', 'sourceContractHashes']}
        receipt.update({
            'schemaVersion': 1, 'status': 'accepted', 'planSha256': self.ledger['planSha256'],
            'specificationSha256': self.ledger['specificationSha256'], 'manifest': manifest,
            'acceptedPrerequisites': [{'nodeId': dependency, 'receipt': self.node(dependency).get('acceptanceReceipt')}
                                      for dependency in node['prerequisites']],
            'independentReviews': [{'reviewer': '/root/verifier', 'implementationOwners': ['/root/implementer'],
                                    'scope': 'producer and actual consumer', 'decision': 'approve',
                                    'evidence': review}],
            'requiredChecks': [{'name': 'fixture', 'argv': ['fixture', 'check'], 'exitCode': 0,
                                'evidence': command, 'log': log}],
            'behaviorEvidence': [{'criterion': 'refused forward preserves foreign bytes', 'evidence': [oracle]}],
            'artifacts': artifacts,
        })
        self.save_receipt(name, receipt)
        return receipt

    def save_receipt(self, name, receipt):
        self.node(name)['acceptanceReceipt'] = self.write(f'evidence/{name}/acceptance.json', receipt)

    def check(self):
        return validator.validate(self.ledger, self.root)

    def bundle(self, name='B01'):
        return {key: json.loads((self.root/f'evidence/{name}/{key}.json').read_text())
                for key in ['original-command', 'command', 'original-review', 'review', 'manifest', 'acceptance']}

    def reseal(self, bundle, name='B01'):
        """Keep every changed container hash current when testing semantic credit."""
        replacements = {}

        def replace(value):
            if isinstance(value, dict):
                if 'path' in value and 'sha256' in value and value['path'] in replacements:
                    return {**value, **replacements[value['path']]}
                return {key: replace(item) for key, item in value.items()}
            if isinstance(value, list):
                return [replace(item) for item in value]
            return value

        for key, document in bundle.items():
            document = replace(document)
            reference = self.write(f'evidence/{name}/{key}.json', document)
            replacements[reference['path']] = reference
            bundle[key] = document
        self.node(name)['acceptanceReceipt'] = replacements[f'evidence/{name}/acceptance.json']

    def assert_rejected(self, text):
        report = self.check()
        self.assertFalse(report['valid'])
        self.assertTrue(any(text in error for error in report['errors']), report['errors'])

    def test_pending_progress_is_valid_but_cannot_claim_completion(self):
        self.assertTrue(self.check()['valid'])
        self.assertEqual(self.check()['ready'], ['B01'])
        self.assertFalse(validator.validate(self.ledger, self.root, require_complete=True)['valid'])

    def test_all_of_milestones_and_immutable_prerequisite_receipts(self):
        for name in ['B01', 'B02', 'M22-CORE']:
            self.accept(name)
        self.assertTrue(self.check()['valid'])
        self.node('B22')['status'] = 'in_progress'
        self.assert_rejected('without all accepted prerequisites')
        self.node('B22')['status'] = 'pending'
        for name in ['M22-TXN', 'B22']:
            self.accept(name)
        self.assertTrue(validator.validate(self.ledger, self.root, require_complete=True)['valid'])
        replacement = self.write('evidence/B01/reattested.json', json.loads((self.root/'evidence/B01/acceptance.json').read_text()))
        self.node('B01')['acceptanceReceipt'] = replacement
        self.assert_rejected('stale prerequisite receipt')

    def test_plan_graph_and_specification_cannot_drift(self):
        self.ledger['completionGraph']['nodes'][1]['prerequisites'] = []
        self.assert_rejected('graph differs')
        (self.root/'spec.md').write_text('changed specification\n')
        self.assert_rejected('hash mismatch for spec.md')

    def test_duplicate_unknown_and_cyclic_nodes_are_rejected(self):
        self.ledger['nodes'].append(copy.deepcopy(self.ledger['nodes'][0]))
        self.assert_rejected('duplicate ledger node')
        self.ledger['completionGraph']['nodes'][0]['prerequisites'] = ['UNKNOWN']
        self.assert_rejected('unknown prerequisite')
        self.ledger['completionGraph']['nodes'][0]['prerequisites'] = ['B02']
        self.assert_rejected('dependency cycle')

    def test_source_and_closed_artifact_hashes_are_required(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        (self.root/'source/B01.txt').write_text('other source bytes\n')
        self.assert_rejected('current source: hash mismatch')
        (self.root/'evidence/B01/oracle.json').unlink()
        self.assert_rejected('missing evidence/B01/oracle.json')

    def test_self_review_and_referenced_rejection_cannot_be_credited(self):
        receipt = self.accept('B01')
        receipt['independentReviews'][0]['reviewer'] = '/root/implementer'
        self.save_receipt('B01', receipt)
        self.assert_rejected('self-authored review')
        receipt['independentReviews'][0]['reviewer'] = '/root/verifier'
        receipt['independentReviews'][0]['evidence'] = self.write('evidence/B01/review.json', {'recommendation': 'request_changes'})
        self.save_receipt('B01', receipt)
        self.assert_rejected('referenced review does not approve')

    def test_failed_command_cannot_be_relabelled_as_passing(self):
        receipt = self.accept('B01')
        receipt['requiredChecks'][0]['evidence'] = self.write('evidence/B01/command.json', {'argv': ['fixture', 'check'], 'exitCode': 1})
        self.save_receipt('B01', receipt)
        self.assert_rejected('command evidence disagrees')

    def test_missing_oracles_and_absolute_evidence_are_rejected(self):
        receipt = self.accept('B01')
        receipt['behaviorEvidence'] = []
        self.save_receipt('B01', receipt)
        self.assert_rejected('no producer/consumer oracle evidence')
        receipt['manifest']['path'] = str(self.root/'evidence/B01/manifest.json')
        self.save_receipt('B01', receipt)
        self.assert_rejected('repository-relative path')

    def test_fresh_outer_hashes_do_not_reattest_old_source(self):
        receipt = self.accept('B01')
        self.assertTrue(self.check()['valid'])
        source = self.write('source/B01.txt', 'changed source bytes\n')
        hashes = {source['path']: source['sha256']}
        receipt['sourceContractHashes'] = hashes
        self.node('B01')['sourceContractHashes'] = hashes
        manifest = json.loads((self.root/'evidence/B01/manifest.json').read_text())
        manifest['sourceContractHashes'] = hashes
        receipt['manifest'] = self.write('evidence/B01/manifest.json', manifest)
        self.save_receipt('B01', receipt)
        self.assert_rejected('review: stale source binding')

    def test_authoritative_reviewer_identity_cannot_be_relabelled(self):
        receipt = self.accept('B01')
        document = json.loads((self.root/'evidence/B01/review.json').read_text())
        document['reviewer'] = '/root/implementer'
        document['independent'] = False
        receipt['independentReviews'][0]['evidence'] = self.write('evidence/B01/review.json', document)
        self.save_receipt('B01', receipt)
        self.assert_rejected('authoritative review reviewer')

    def test_unrelated_decision_field_cannot_override_rejection(self):
        receipt = self.accept('B01')
        document = json.loads((self.root/'evidence/B01/review.json').read_text())
        document['decision'] = 'request_changes'
        document['formattingDecision'] = 'approve'
        receipt['independentReviews'][0]['decisionField'] = 'formattingDecision'
        receipt['independentReviews'][0]['evidence'] = self.write('evidence/B01/review.json', document)
        self.save_receipt('B01', receipt)
        self.assert_rejected('referenced review does not approve')

    def test_manifest_descendant_drift_is_checked_without_outer_artifacts(self):
        receipt = self.accept('B01')
        receipt['artifacts'] = []
        self.save_receipt('B01', receipt)
        self.assertTrue(self.check()['valid'])
        self.write('evidence/B01/oracle.json', {'confirmed': 1})
        self.assert_rejected('manifest sealed artifact: hash mismatch')

    def test_original_command_log_cannot_be_substituted(self):
        receipt = self.accept('B01')
        receipt['requiredChecks'][0]['log'] = self.write('evidence/B01/unrelated.log', 'other output\n')
        self.save_receipt('B01', receipt)
        self.assert_rejected('required log differs from actual command log')

    def test_milestone_rollup_requires_one_authority_identity(self):
        for index, name in enumerate(['B01', 'B02', 'M22-CORE', 'M22-TXN', 'B22']):
            receipt = self.accept(name)
            if name.startswith('M22') or name == 'B22':
                identity = {'repositoryId': f'repo-{index}', 'backend': f'backend-{index}', 'epoch': f'epoch-{index}'}
                receipt.update(identity)
                self.node(name).update(identity)
                self.save_receipt(name, receipt)
        self.assert_rejected('different authority identity')

    def test_detached_inputs_cannot_override_explicit_original_source_maps(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        bundle = self.bundle()
        original = copy.deepcopy(bundle['original-command'])
        source = self.write('source/B01.txt', 'new unexercised implementation\n')
        hashes = {source['path']: source['sha256']}
        self.node('B01')['sourceContractHashes'] = hashes
        for key in ['original-review', 'review', 'manifest', 'acceptance']:
            bundle[key]['sourceContractHashes'] = hashes
        detached = self.write('evidence/B01/detached-inputs.json', {'sourceContractHashes': hashes})
        bundle['command'].update({'sourceBefore': hashes, 'sourceAfter': hashes,
                                  'inputProvenance': {'before': detached, 'after': detached}})
        self.reseal(bundle)
        self.assertEqual(bundle['original-command'], original)
        self.assert_rejected('normalized before inputs lack original source provenance')

    def test_original_self_authorship_and_independence_cannot_be_erased(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        bundle = self.bundle()
        bundle['original-review']['implementationOwners'] = ['/root/verifier']
        bundle['original-review']['independent'] = False
        self.reseal(bundle)
        self.assert_rejected('original implementation review is author-affiliated')

    def test_original_pending_review_cannot_be_promoted_by_normalization(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        bundle = self.bundle()
        bundle['original-review']['decision'] = 'pending'
        self.reseal(bundle)
        self.assert_rejected('original implementation review does not approve')

    def test_original_card_and_scope_cannot_be_reassigned_on_shared_source(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        bundle = self.bundle()
        bundle['original-review']['nodeId'] = 'B99'
        bundle['original-review']['scope'] = 'unrelated formatting'
        self.reseal(bundle)
        self.assert_rejected('nodeId differs from original independent provenance')
        self.assert_rejected('scope differs from original independent provenance')

    def test_original_review_seal_closes_descendants_without_outer_duplicates(self):
        self.accept('B01')
        bundle = self.bundle()
        artifact = self.write('evidence/B01/original-observation.json', {'passed': True})
        bundle['original-review']['artifacts'].append(artifact)
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'])
        self.write(artifact['path'], {'passed': False})
        self.assert_rejected('original review sealed artifact: hash mismatch')

    def test_all_recorded_command_context_must_remain_current(self):
        self.accept('B01')
        bundle = self.bundle()
        context = self.write('source/shared-context.txt', 'recorded dependency\n')
        for key in ['original-command', 'command']:
            for field in ['sourceBefore', 'sourceAfter']:
                bundle[key][field][context['path']] = context['sha256']
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'])
        self.write(context['path'], 'different dependency\n')
        self.assert_rejected('original before input: hash mismatch')

    def test_normalization_cannot_drop_original_context(self):
        self.accept('B01')
        bundle = self.bundle()
        context = self.write('source/shared-context.txt', 'recorded dependency\n')
        for field in ['sourceBefore', 'sourceAfter']:
            bundle['original-command'][field][context['path']] = context['sha256']
        self.reseal(bundle)
        self.assert_rejected('normalized before inputs lack original source provenance')

    def test_original_approval_must_credit_the_same_commands(self):
        self.accept('B01')
        bundle = self.bundle()
        bundle['original-review']['commandReceipts'] = []
        self.reseal(bundle)
        self.assert_rejected('command credit differs from original independent approval')

    def test_normalization_cannot_add_independent_behavior_credit(self):
        self.accept('B01')
        self.assertTrue(self.check()['valid'])
        bundle = self.bundle()
        original = copy.deepcopy(bundle['original-review'])
        added = self.write('evidence/B01/unreviewed-observation.json', {'passed': True})
        for key in ['review', 'manifest']:
            bundle[key]['artifacts'].append(added)
        bundle['acceptance']['behaviorEvidence'] = [{'criterion': 'new claim', 'evidence': [added]}]
        self.reseal(bundle)
        self.assertEqual(bundle['original-review'], original)
        self.assert_rejected('behavior evidence lacks an independent review seal')

    def test_acceptance_cannot_omit_a_credited_command_to_hide_stale_context(self):
        self.accept('B01')
        bundle = self.bundle()
        context = self.write('source/second-command-context.txt', 'recorded context\n')
        sources = {**bundle['command']['sourceBefore'], context['path']: context['sha256']}
        log = self.write('evidence/B01/second-command.log', 'second command passed\n')
        original = {'argv': ['fixture', 'check-extra'], 'exitCode': 0, 'log': log,
                    'sourceBefore': sources, 'sourceAfter': sources}
        origin = self.write('evidence/B01/second-original-command.json', original)
        command = self.write('evidence/B01/second-command.json', {
            **original, 'schemaVersion': 1, 'type': 'body-acceptance-command',
            'nodeId': 'B01', 'provenance': origin,
        })
        for key in ['original-review', 'review', 'manifest']:
            bundle[key]['commandReceipts'].append(command)
            bundle[key]['artifacts'].extend([command, origin, log])
        bundle['acceptance']['requiredChecks'].append({
            'name': 'second', 'argv': original['argv'], 'exitCode': 0, 'log': log, 'evidence': command,
        })
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'], self.check()['errors'])
        self.write(context['path'], 'changed context\n')
        bundle['acceptance']['requiredChecks'].pop()
        bundle['manifest']['commandReceipts'].pop()
        self.reseal(bundle)
        self.assert_rejected('required checks must include every independently credited command')

    def test_top_level_command_array_keeps_original_selection_and_inputs(self):
        self.accept('B01')
        bundle = self.bundle()
        bundle['original-command'] = [bundle['original-command']]
        bundle['command']['provenanceCommandIndex'] = 0
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'], self.check()['errors'])

    def test_grouped_invocation_keeps_enclosing_original_source_maps(self):
        self.accept('B01')
        bundle = self.bundle()
        original = bundle['original-command']
        invocation = {key: value for key, value in original.items()
                      if key not in ['sourceBefore', 'sourceAfter']}
        bundle['original-command'] = {**original, 'invocations': [invocation]}
        bundle['command']['provenanceInvocationIndex'] = 0
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'], self.check()['errors'])

    def test_separate_source_manifest_must_anchor_a_command_without_recorded_maps(self):
        self.accept('B01')
        bundle = self.bundle()
        original = bundle['original-command']
        hashes = original.pop('sourceBefore')
        original.pop('sourceAfter')
        original_reference = self.write('evidence/B01/original-command.json', original)
        inputs = self.write('evidence/B01/recorded-inputs.json', {
            'sourceContractHashes': hashes, 'artifacts': [original_reference],
        })
        bundle['command']['provenanceSourceManifest'] = inputs
        bundle['original-review']['artifacts'].append(inputs)
        self.reseal(bundle)
        self.assertTrue(self.check()['valid'], self.check()['errors'])
        detached = self.write('evidence/B01/detached-inputs.json', {'sourceContractHashes': hashes})
        bundle['command']['provenanceSourceManifest'] = detached
        self.reseal(bundle)
        self.assert_rejected('original source manifest does not bind the actual command')


if __name__ == '__main__':
    unittest.main()
