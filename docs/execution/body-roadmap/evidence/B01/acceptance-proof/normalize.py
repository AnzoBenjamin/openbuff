#!/usr/bin/env python3
"""Normalize the author's three independent decisions without executing checks."""
import datetime
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]
EVIDENCE = HERE.parent.parent
REVIEWER = '/root/b03_mutation_evidence'
SPECS = {
    'B01': ('B01/independent-main-review/manifest.json', 'e2f7e325c8a46dab943223ca044048077efef8f7409b960ad1c7639a436587b5', ['/root']),
    'B08': ('B08/final-binding/independent-review/manifest.json', '6f332001c8c28877fc8a0ae5aa71d65f418319ac8f97e18726887642ddf7d8c9', ['/root/b02_runtime_outcomes', '/root']),
    'B36': ('B36/final-independent-review/manifest.json', 'b9d7d6c01e3a369f4ed63beeded69a05117ebd2dc406a708ad306cc5b7108aba', ['/root/b04_lock_cas', '/root']),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def rel(path):
    return str(path.relative_to(ROOT))


def ref(path):
    return {'path': rel(path), 'sha256': sha(path)}


def bindings(value):
    return dict(value) if isinstance(value, dict) else {row['path']: row['sha256'] for row in value}


def verify_hashes(value):
    for name, digest in value.items():
        assert sha(ROOT / name) == digest, name


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


all_results = []
for node, (manifest_rel, expected_manifest_hash, owners) in SPECS.items():
    source_manifest = EVIDENCE / manifest_rel
    assert sha(source_manifest) == expected_manifest_hash, node
    original = read(source_manifest)
    output = EVIDENCE / node / 'acceptance-proof'
    output.mkdir(exist_ok=True)
    old_artifacts = {}

    def bind_old(path, expected=None):
        digest = sha(path)
        if expected is not None:
            assert digest == expected, rel(path)
        old_artifacts[rel(path)] = digest

    bind_old(source_manifest, expected_manifest_hash)
    if isinstance(original['artifacts'], dict):
        for name, digest in original['artifacts'].items():
            bind_old(source_manifest.parent / name, digest)
    else:
        for entry in original['artifacts']:
            bind_old(ROOT / entry['path'], entry['sha256'])
    assert REVIEWER not in owners
    dependencies = {}
    frozen_plans = {}
    if node == 'B01':
        assert original['requiredChecksPass'] and original['sourceStableDuringChecks'] and original['configStableDuringChecks']
        source_contract = bindings(original['reviewedSources'])
        dependencies = bindings(original['dependencyBindings'])
        configs = bindings(original['configBindings'])
        frozen_plans = bindings(original['frozenPlanBindings'])
        source_before = source_after = {**source_contract, **dependencies}
        command_entries = original['commands']
        command_provenance = source_manifest
        before_provenance = after_provenance = source_manifest
        binding_basis = 'Original manifest records final reviewedSources + dependencyBindings and sourceStableDuringChecks=true after the complete command matrix. Those frozen code maps represent both sides; configBindings are separately preserved.'
        assert read(ROOT / original['currentSourceRecommendation'])['recommendation'] == 'approve-leader-owned-main-scope'
        scope = original['scope'] + '; approval covers only the 11 reviewedSources. The 37 dependency bindings are integrity inputs and confer no separate implementation approval.'
        exclusions = original['exclusions']
    elif node == 'B08':
        assert original['recommendation'] == 'approve' and original['requiredChecksPass']
        command_provenance = source_manifest.parent / 'command-results.json'
        before_provenance = source_manifest.parent / 'precommitted-inputs.json'
        after_provenance = command_provenance
        before = read(before_provenance)
        after = read(after_provenance)
        assert after['sourceStableDuringChecks'] and after['configStableDuringChecks'] and after['requiredCommandsPass']
        source_contract = bindings(original['sourceBindings'])
        source_before = bindings(before['sourceBindings'])
        source_after = bindings(after['sourceBindings'])
        assert source_before == source_after == source_contract
        configs = bindings(original['configBindings'])
        assert bindings(before['configBindings']) == bindings(after['configBindings']) == configs
        assert after['commands'] == original['commands']
        command_entries = after['commands']
        binding_basis = 'Actual precommitted-inputs sourceBindings before the command matrix and command-results sourceBindings after it; both maps equal the independently approved final source bindings.'
        scope = original['scope']
        exclusions = original['exclusions']
        bind_old(command_provenance)
        bind_old(before_provenance)
    else:
        assert original['decision'] == 'approve'
        source_contract = dict(original['sourceHashes'])
        configs = {}
        command_entries = original['reusedCommands']
        verification = read(source_manifest.parent / 'verification.json')
        for collection in ['sealedArtifactHashes', 'priorB36EvidenceHashes']:
            for name, digest in verification[collection].items():
                bind_old(ROOT / name, digest)
        scope = original['scope']
        exclusions = original['scopeLimits']
        binding_basis = 'Actual original command receipt sourceBefore/sourceAfter, individually frozen around that execution; commands are implementation-author affiliated and reused by the independent reviewer.'
    verify_hashes(source_contract)
    verify_hashes(dependencies)
    verify_hashes(configs)
    verify_hashes(frozen_plans)
    normalized_commands = []
    for index, entry in enumerate(command_entries):
        if node == 'B36':
            command_provenance = ROOT / entry['receipt']
            bind_old(command_provenance, entry['sha256'])
            receipt = read(command_provenance)
            assert receipt['argv'] == entry['argv']
            source_before = receipt['sourceBefore']
            source_after = receipt['sourceAfter']
            assert source_before == source_after == source_contract
            name = receipt['command']
            exit_code = receipt['exit']
            actual_log = command_provenance.parent / receipt['log']
            bind_old(actual_log, receipt['logSha256'])
            before_provenance = after_provenance = command_provenance
            pointer = ''
            command_author = '/root/b04_lock_cas'
        else:
            receipt = entry
            name = entry['name']
            exit_code = entry['exitCode']
            actual_log = ROOT / entry['log']
            bind_old(actual_log)
            pointer = '/commands/' + str(index)
            command_author = REVIEWER
        exit_file = ROOT / receipt['exitFile'] if 'exitFile' in receipt else actual_log.with_suffix('.exit')
        assert int(exit_file.read_text().strip()) == exit_code == 0, name
        bind_old(exit_file)
        verify_hashes(source_before)
        verify_hashes(source_after)
        record = {
            'schemaVersion': 1,
            'type': 'body-acceptance-command',
            'nodeId': node,
            'name': name,
            'argv': receipt['argv'],
            'cwd': receipt['cwd'],
            'exitCode': exit_code,
            'log': ref(actual_log),
            'sourceBefore': source_before,
            'sourceAfter': source_after,
            'configBefore': configs,
            'configAfter': configs,
            'provenance': {**ref(command_provenance), 'jsonPointer': pointer},
            'inputProvenance': {'before': ref(before_provenance), 'after': ref(after_provenance), 'basis': binding_basis},
            'exitProvenance': ref(exit_file),
            'executedBy': command_author,
            'independentlyRerunForNormalization': False,
            'newExecutionClaim': False,
        }
        path = output / ('command-' + name + '.json')
        write(path, record)
        normalized_commands.append(ref(path))
    readme = output / 'README.md'
    readme.write_text(
        '# ' + node + ' authoritative acceptance normalization\n\n'
        'Reviewer `' + REVIEWER + '` independently approves exactly the source-bound scope in `review.json`. '
        'This record normalizes the unchanged original independent final manifest and actual command logs; '
        'it does not use an outer leader wrapper as review identity.\n\n'
        + scope + '\n\n'
        'All source hashes, original manifest/artifact hashes, and exact command/log provenance were verified before closing the record. '
        'No product check was rerun, and no production/test/old-evidence/ledger file was edited. '
        'Bound dependencies and historical artifacts retain their original exclusions and do not earn additional implementation approval.\n\n'
        + '\n'.join('- ' + item for item in exclusions) + '\n'
    )
    normalization = output / 'normalization.json'
    write(normalization, {
        'schemaVersion': 1, 'nodeId': node,
        'normalizedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'originalManifest': ref(source_manifest),
        'sourceContractHashCount': len(source_contract),
        'dependencyHashCount': len(dependencies),
        'configHashCount': len(configs),
        'originalArtifactsClosedAndPreserved': old_artifacts,
        'commandCount': len(normalized_commands),
        'productChecksRerun': 0,
        'implementationOwners': owners,
        'implementationOwnerBasis': 'Root task scope and explicit implementation-owner attribution; this independent reviewer authored no implementation within this approved scope.',
        'scopeExclusionsPreserved': exclusions,
    })
    new_artifacts = {rel(readme): sha(readme), rel(normalization): sha(normalization)}
    for entry in normalized_commands:
        new_artifacts[entry['path']] = entry['sha256']
    if node == 'B01':
        new_artifacts[rel(pathlib.Path(__file__).resolve())] = sha(pathlib.Path(__file__).resolve())
    # Directly seal every credited original artifact and actual command log,
    # including the original final manifest used as decision provenance.
    artifacts = {**old_artifacts, **new_artifacts}
    verify_hashes(artifacts)
    verify_hashes(source_contract)
    review = {
        'schemaVersion': 1,
        'type': 'body-implementation-review',
        'nodeId': node,
        'decision': 'approve',
        'reviewer': REVIEWER,
        'implementationOwners': owners,
        'independent': True,
        'scope': scope,
        'sourceContractHashes': source_contract,
        'provenance': ref(source_manifest),
        'artifacts': [{'path': name, 'sha256': digest} for name, digest in sorted(artifacts.items())],
        'commandReceipts': normalized_commands,
        'dependencyContractHashes': dependencies,
        'configurationHashes': configs,
        'frozenPlanHashes': frozen_plans,
        'exclusions': exclusions,
        'normalizationOnly': True,
        'newProductExecutions': 0,
        'ledgerAcceptance': 'leader_owned',
    }
    review_path = output / 'review.json'
    write(review_path, review)
    assert review['decision'] == 'approve' and review['independent'] and REVIEWER not in review['implementationOwners']
    verify_hashes(source_contract)
    verify_hashes(artifacts)
    all_results.append({'nodeId': node, 'review': ref(review_path), 'sources': len(source_contract), 'commands': len(normalized_commands), 'sealedArtifacts': len(artifacts)})
print(json.dumps(all_results, indent=2))
