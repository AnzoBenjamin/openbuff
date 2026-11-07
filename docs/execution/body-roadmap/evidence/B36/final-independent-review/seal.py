#!/usr/bin/env python3
"""Close the independent B36 evidence directory without touching prior artifacts."""
import datetime
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


result = json.loads((HERE / 'verification.json').read_text())
assert result['decision'] == 'approve'
for row in result['sourceChecks']:
    assert sha(ROOT / row['path']) == row['currentSha256'], row['path']
for collection in ['sealedArtifactHashes', 'priorB36EvidenceHashes']:
    for name, digest in result[collection].items():
        assert sha(ROOT / name) == digest, name
artifacts = {
    str(p.relative_to(HERE)): sha(p)
    for p in sorted(HERE.rglob('*'))
    if p.is_file() and p.name != 'manifest.json'
}
manifest = {
    'schemaVersion': 1,
    'card': 'B36',
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'reviewer': '/root/b03_mutation_evidence',
    'decision': 'approve',
    'recommendation': 'approve_declared_B36_diagnostic_truth_tier_at_current_independent_countersignature',
    'findings': [],
    'cardAcceptance': 'leader_owned_not_changed_by_this_countersignature',
    'independence': {
        'authoredOriginalIndependentB36Review': True,
        'authoredB36Implementation': False,
        'authoredRootSharedRunDelta': False,
        'currentProducerAuthoredB36Implementation': True,
        'currentProducer': '/root/b04_lock_cas',
        'authoredB01TailStore': True,
        'approvesB01TailStore': False,
        'newIndependentApprovalForDeclaredB36Tier': True,
        'method': 'Independent source/delta and explicit oracle review; immutable artifact/source comparison; reused implementor-produced fresh commands with no independent product reruns.',
    },
    'sourceHashes': {row['path']: row['currentSha256'] for row in result['sourceChecks']},
    'all15MatchPriorFinalBinding': True,
    'matchesOriginalIndependentCount': 14,
    'sourceDeltaSinceOriginalIndependent': ['sdk/src/run.ts'],
    'sharedRunDelta': result['reconstruction'],
    'supportingSeals': {
        'currentProducer': {'path': 'docs/execution/body-roadmap/evidence/B36/current-independent-review/manifest.json', 'sha256': 'eb310be784b27ae3b63af67bcedf320961550385997e443d8273435a1f4fba92'},
        'priorFinalBinding': {'path': 'docs/execution/body-roadmap/evidence/B36/final-binding/manifest.json', 'sha256': 'd22be7639a4bfd6064d84b51da0b976acb4fdd9390b16ddd09fd6f6b3b8ac03b'},
        'originalIndependent': {'path': 'docs/execution/body-roadmap/evidence/B36/independent-review/manifest-check.json', 'sha256': 'e856d4eab30d69db7055f7b4c760f72a8c187176744ae54bf55c87faff9a8fb1'},
        'b02Independent': {'path': 'docs/execution/body-roadmap/evidence/B02/final-binding/manifest.json', 'sha256': '95901b10a4d4350f6392bf2f315f9f5b0dcd8925cfb427b9cf94f2ae57afcafa'},
    },
    'freshRecordedTests': result['freshRecordedTests'],
    'reusedCommands': result['reusedCommands'],
    'diagnosticCases': result['diagnosticCases'],
    'diagnosticCaseCount': 12,
    'actualChildLaunches': result['actualChildLaunches'],
    'sdkTypecheckExit': 0,
    'b02ApprovalCancellationVerified': True,
    'historicalCountsNotRerun': result['historicalCountsNotRerun'],
    'independentlyExecutedProductChecks': 0,
    'integrity': {'sealedArtifactsVerified': len(result['sealedArtifactHashes']), 'priorB36FilesPreserved': len(result['priorB36EvidenceHashes']), 'allSourceAndPriorHashesVerifiedAtClosure': True},
    'scope': 'Real fixed diagnostic children → delta/hooks → source SDK dispatch/JSON → CLI classifier, retained source-SDK client baselines and actual Node bounded reads.',
    'scopeLimits': [
        'No approval for B01 tail/store, B01 specialist gates, or any other prerequisite/card implementation.',
        'No native validator/toolchain, provider/model, installed-package, OS isolation, descendant-death, or broader terminal/process enforcement graduation.',
        'B20 owns actual descendant-death enforcement; diagnostic fail-open never converts unsuccessful evidence to passed.',
        'Fresh product commands are implementation-author affiliated; independent reviewer reused receipts and did not rerun them.',
        'Original 188 tests and ten postimage controls remain historical and unchanged.',
        'Only this new evidence directory was written; production/tests/ledger/old evidence were not edited.',
    ],
    'artifacts': artifacts,
}
(HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
for name, digest in artifacts.items():
    assert sha(HERE / name) == digest, name
assert set(artifacts) == {str(p.relative_to(HERE)) for p in HERE.rglob('*') if p.is_file() and p.name != 'manifest.json'}
print(json.dumps({'decision': 'approve', 'manifest': str((HERE / 'manifest.json').relative_to(ROOT)), 'sha256': sha(HERE / 'manifest.json'), 'closedArtifacts': len(artifacts)}))
