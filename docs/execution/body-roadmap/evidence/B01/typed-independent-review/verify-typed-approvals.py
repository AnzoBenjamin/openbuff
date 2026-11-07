#!/usr/bin/env python3
"""Fresh typed independent approvals: reuse closed receipts; never overwrite prior evidence."""
import datetime
import hashlib
import json
import pathlib
import re

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


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


def bindings(value):
    return dict(value) if isinstance(value, dict) else {row['path']: row['sha256'] for row in value}


def sweep(value):
    for name, digest in value.items():
        assert sha(ROOT / name) == digest, name


def write(path, value):
    
    with path.open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')


def counts(log):
    return re.findall(r'\n\s+(\d+) pass\n\s+(\d+) fail\n\s+(\d+) expect\(\) calls', log.read_text())


# The new typecheck's executable/config/source contexts are independently
# checked here. Broad root success and ledger-derived identity are never used.
fresh = {}
for node, name in [('B01', 'agent-typecheck-refreshed-context'), ('B36', 'sdk-typecheck-refreshed-context')]:
    p = EVIDENCE / node / 'refreshed-typecheck-context' / (name + '.json')
    d = read(p)
    assert d['exitCode'] == 0 and d['sourceBefore'] == d['sourceAfter'] and d['sourceStable']
    assert d['executedBy'] == REVIEWER and d['environment']['replacement']
    assert not d['environment']['bunEnvFileLoading']
    assert read(ROOT / d['environment']['providerConfig']['path'])['providers'] == {}
    assert sha(ROOT / d['environment']['providerConfig']['path']) == d['environment']['providerConfig']['sha256']
    assert (ROOT / 'node_modules/.bin/tsc').resolve() == (ROOT / d['toolchain']['tscAlias']['resolvedPath']).resolve()
    sweep(d['sourceAfter'])
    assert d['configBefore'] == d['configAfter'] and d['configStable']
    sweep(d['configAfter'])
    assert d['toolchainBefore'] == d['toolchainAfter'] and d['toolchainStable']
    assert sha(ROOT / d['log']['path']) == d['log']['sha256']
    for key in ['typescriptEntry', 'typescriptDelegate']:
        assert sha(ROOT / d['toolchain'][key]['path']) == d['toolchain'][key]['sha256']
    assert sha(pathlib.Path(d['toolchain']['bun']['path'])) == d['toolchain']['bun']['sha256']
    assert d['toolchain']['bun']['version'] == '1.3.5'
    fresh[name] = (p, d)

output_refs = []
for node, (manifest_name, expected_manifest, owners) in SPECS.items():
    original_path = EVIDENCE / manifest_name
    assert sha(original_path) == expected_manifest
    original = read(original_path)
    out = EVIDENCE / node / 'typed-independent-review'
    out.mkdir(exist_ok=True)
    raw = {str(original_path.relative_to(ROOT)): expected_manifest}
    artifacts = original['artifacts']
    for name, digest in (artifacts.items() if isinstance(artifacts, dict) else [(item['path'], item['sha256']) for item in artifacts]):
        path = original_path.parent / name if isinstance(artifacts, dict) else ROOT / name
        assert sha(path) == digest
        raw[str(path.relative_to(ROOT))] = digest
    raw_wrappers = []
    for old in (EVIDENCE / node / 'acceptance-proof').rglob('*'):
        if old.is_file():
            raw_wrappers.append(ref(old))
    # Their old decision metadata is not used or interpreted. They are sealed
    # historical normalization data, not the source of this new approval.
    configs = {}
    dependencies = {}
    frozen = {}
    obsolete_commands = []
    oracle = {}
    static = []
    if node == 'B01':
        contracts = bindings(original['reviewedSources'])
        dependencies = bindings(original['dependencyBindings'])
        configs = bindings(original['configBindings'])
        frozen = bindings(original['frozenPlanBindings'])
        source_before = source_after = {**contracts, **dependencies}
        assert original['sourceStableDuringChecks'] and original['configStableDuringChecks']
        entries = original['commands']
        provenance = original_path
        assert counts(original_path.parent / 'tests.log') == [('560', '0', '4160')]
        probe = read(original_path.parent / 'probe-report.json')
        ordinary = read(original_path.parent / 'ordinary-consumer-report.json')
        specialist = read(original_path.parent / 'specialist-consumer-report.json')
        for observed in [probe, ordinary, specialist]:
            assert observed['codingFetch'] == {'attempted': 0, 'forwarded': 0}
        assert probe['blocking'] == [] and specialist['blockingCounterexamples'] == []
        assert len(ordinary['reports']) == 4 and len(specialist['reports']) == 13
        for item in ordinary['reports']:
            if item['kind'] == 'complete':
                assert item['phase'] == 'final_response_allowed' and item['reviewerSpawns'] == 1 and len(item['reviewReceipts']) == 1
            else:
                assert item['phase'] == 'blocked' and item['reviewerSpawns'] == 2 and item['reviewReceipts'] == []
        positive = adverse = 0
        for item in specialist['reports']:
            if item['positive']:
                positive += 1
                assert len(item['reviewReceipts']) == 1
                assert item['reviewReceipts'][0]['snapshotFingerprint'] == item['expectedFingerprint']
                if 'retry' in item['kind']:
                    assert item['reviewerSpawns'] == 2
            else:
                adverse += 1
                assert item['phase'] == 'blocked' and item['reviewReceipts'] == []
                assert item.get('creditedFingerprint') is None
                assert not item.get('creditedFileMarkers') and not item.get('waveCreditMarkers') and not item.get('waveCompletions')
                if item['windowed']:
                    assert item['sourcePathCount'] == 41 and item['generatorStoppedNaturally'] and item['reviewerSpawns'] == 2
        assert (positive, adverse) == (4, 9)
        static = [
            {'path': 'sdk/src/services/audit-intelligence.ts', 'line': 476, 'observation': 'Attested discovery remains source inspection; maturity/runtime readiness are not promoted to executed capability. Coverage checks every inventoried file/subsystem and all declared domains.'},
            {'path': 'agents/base2/gate-reviewer.ts', 'line': 221, 'observation': 'Current fingerprint/file/schema attestation and full dimensional/nonempty requirement evidence fail closed; reduced receipts retain their explicit eligibility limits.'},
            {'path': 'agents/base2/base2.ts', 'observation': 'Current generated/ordinary/specialist consumers remain at the exact reviewed hash; original actual-source adverse reports show no credit for missing, foreign, unsupported, exhausted or drifting receipts.'},
        ]
        oracle = {'tests': 560, 'assertions': 4160, 'ordinaryControls': 4, 'specialistControls': 13, 'positiveSpecialistControls': 4, 'adverseSpecialistControls': 9, 'windowedFiles': 41, 'windowedReviewerSpawns': 2, 'codingFetch': 0}
        scope = 'Independent approval of the 11 leader-owned B01 coverage/maturity/source-inventory and ordinary/specialist reviewer-gating source files only. The 37 declared dependencies are integrity inputs, not separately approved implementation.'
        limits = original['exclusions'] + ['No approval for reviewer-authored B01 tail/store. No runtime reduced-tier graduation. Transitive typecheck inputs confer no implementation approval.']
    elif node == 'B08':
        contracts = bindings(original['sourceBindings'])
        configs = bindings(original['configBindings'])
        provenance = original_path.parent / 'command-results.json'
        before_path = original_path.parent / 'precommitted-inputs.json'
        result = read(provenance)
        before = read(before_path)
        source_before = bindings(before['sourceBindings'])
        source_after = bindings(result['sourceBindings'])
        assert source_before == source_after == contracts
        assert bindings(before['configBindings']) == bindings(result['configBindings']) == configs
        assert result['sourceStableDuringChecks'] and result['configStableDuringChecks']
        entries = result['commands']
        assert counts(original_path.parent / 'provider-tests.log') == [('331', '0', '1078')]
        observations = read(original_path.parent / 'fixture/observations.json')
        cases = {item['case']: item for item in observations['controls']}
        hints = ['missing', '9', '0', '-5', '3.5', 'hostile', 'nonfinite', 'http-date']
        expected = {f'{protocol}-503-hint-{hint}' for protocol in ['http', 'sse'] for hint in hints}
        expected.update(['wrapped-policy-and-abort-override-status', 'http-policy-503-no-retry', 'sse-policy-503-no-retry', 'total-wait-exhaustion-no-backup', 'abort-before-dispatch', 'abort-active', 'abort-backoff', 'abort-real-timer', *[f'delivered-{kind}-no-replay' for kind in ['text', 'reasoning', 'tool', 'text-tool']], 'buffered-tool-discard-on-retry', 'dormant-key-healthy-primary', 'vision-metadata-skips-dormant-key-validation', 'vision-route-cannot-reselect-excluded-oauth', 'selected-backup-key-error-retains-primary', *[f'reasoning-{provider}-{kind}' for provider in ['local', 'custom-gateway', 'openai'] for kind in ['override', 'configured']], *[f'configured-oauth-{kind}' for kind in ['skip', 'rate-limit', 'skip-no-backup']], 'nonstream-text-owned-retries', 'nonstream-structured-owned-retries'])
        assert len(expected) == len(observations['controls']) == 44 and set(cases) == expected
        assert observations['policy'] == before['policy'] and observations['refusedFetches'] == 0
        for name, item in cases.items():
            assert item['passed'] and sum(item['waits']) <= 600 and len(item['requests']) <= 4
            if '-503-hint-' in name:
                hint = name.split('-503-hint-')[1]
                assert ['primary' if 'primary.' in req['url'] else 'backup' for req in item['requests']] == ['primary', 'primary', 'primary', 'backup']
                assert item['waits'] == ([250, 250] if hint in ['9', 'http-date'] else [0, 0] if hint == '0' else [100, 200])
            if name.endswith('policy-503-no-retry') or name.startswith('delivered-'):
                assert len(item['requests']) == 1 and item['waits'] == []
            if name in ['abort-active', 'abort-backoff', 'abort-real-timer']:
                assert len(item['requests']) == 1 and item['elapsedMs'] < 350 and item['detail']['name'] == 'AbortError'
        assert cases['abort-before-dispatch']['requests'] == []
        route = read(original_path.parent / 'route-metadata/observations.json')
        assert route['passed'] and route['refused'] == 0 and route['forwarded'] == 0
        assert route['ledger'] == ['vision', 'vision', 'vision', 'backup'] and route['waits'] == [100, 200]
        assert route['actualFailover']['model'] == 'vision/model' and route['actualFailover']['nextModel'] == 'backup/model'
        static = [
            {'path': 'sdk/src/error-utils.ts', 'line': 14, 'observation': 'Bounded wrapper traversal preserves typed HTTP/policy/abort meaning, with policy and abort overriding retryable status.'},
            {'path': 'sdk/src/impl/llm.ts', 'line': 2093, 'observation': 'Failover requires undelivered output, non-aborted/non-exhausted shared budget, and an eligible error; status uses actual attemptModel.'},
            {'path': 'sdk/src/impl/model-provider.ts', 'line': 255, 'observation': 'Excluded OAuth cannot be reselected; metadata-only route selection does not eagerly validate dormant provider keys.'},
        ]
        oracle = {'tests': 331, 'assertions': 1078, 'producerControls': 44, 'additionalIndependentVisionControl': 1, 'refusedOrForwardedExternalFetches': 0}
        scope = 'Canonical B08 offline source-SDK request/error/retry/actual-route-metadata/settings contract under the frozen 64-source and 11-config inputs; no live provider or installed-client graduation.'
        limits = original['exclusions'] + ['B08 commands are reused only at their originally recorded source/config/preload/Bun context. No new claim of historical TypeScript installed-file hashes or universal dependency integrity.']
    else:
        contracts = dict(original['sourceHashes'])
        provenance = EVIDENCE / 'B36/current-independent-review/manifest.json'
        producer = read(provenance)
        assert producer['sourceHashes'] == contracts
        assert sha(provenance) == original['supportingSeals']['currentProducer']['sha256']
        raw[str(provenance.relative_to(ROOT))] = sha(provenance)
        # Bind the original actual SDK observation file and all producer
        # artifacts directly in the new independent approval. Auxiliary
        # countersignatures alone do not prove those behavior oracles.
        for artifact_name, digest in producer['artifacts'].items():
            artifact_path = provenance.parent / artifact_name
            assert sha(artifact_path) == digest
            raw[str(artifact_path.relative_to(ROOT))] = digest
        entries = original['reusedCommands']
        assert counts(provenance.parent / 'integration-tests.log') == [('22', '0', '143')]
        observations = read(provenance.parent / 'sdk-client-observations.json')
        expected = {'empty': ('passed', 'passed', 2), 'preexisting': ('passed', 'passed', 2), 'shifted': ('passed', 'passed', 2), 'severity-escalation': ('new_errors', 'failed', 2), 'timeout': ('failed', 'failed', 2), 'exit127': ('unavailable', 'unknown', 2), 'cancelled': ('cancelled', 'failed', 1), 'missing-tool': ('unavailable', 'unknown', 2), 'missing-language': ('unavailable', 'unknown', 0), 'capped': ('incomplete', 'unknown', 2), 'partial': ('unknown', 'unknown', 2), 'unknown': ('unknown', 'unknown', 0)}
        assert len(observations['records']) == 12
        observed = {}
        for item in observations['records']:
            diagnostic = next(row for row in item['sdkOutput'][0]['value'] if row.get('hookName') == 'diagnostic-delta')
            assert (diagnostic['diagnosticStatus'], item['clientClassification'], item['launches']) == expected[item['name']]
            observed[item['name']] = diagnostic
            assert diagnostic['diagnosticStatus'] == 'passed' or item['clientClassification'] != 'passed'
        assert set(observed) == set(expected)
        assert observed['empty']['observations']['before']['diagnostics'] == [] and observed['empty']['observations']['after']['diagnostics'] == []
        assert observed['preexisting']['observations']['before']['diagnostics'] == observed['preexisting']['observations']['after']['diagnostics']
        assert observed['severity-escalation']['observations']['before']['diagnostics'][0]['severity'] == 'warning'
        assert observed['severity-escalation']['observations']['after']['diagnostics'][0]['severity'] == 'error'
        assert len(observed['severity-escalation']['newDiagnostics']) == 1
        static = [
            {'path': 'sdk/src/services/diagnostic-delta.ts', 'line': 556, 'observation': 'Command failure/cancellation precedes coverage success; tolerant matching includes severity and consumes diagnostic counts.'},
            {'path': 'sdk/src/tools/file-change-hooks.ts', 'line': 1720, 'observation': 'Passed diagnostics are demoted to unknown for absent/incomplete/unknown basis; no baseline/current errors are not invented as pre-existing.'},
            {'path': 'sdk/src/run.ts', 'line': 2807, 'observation': 'Only reviewed terminal-approval integration changed since the original B36 seal; complete effect/context/cancel/snapshot checks do not alter diagnostics.'},
        ]
        oracle = {'tests': 22, 'assertions': 143, 'diagnosticCases': 12, 'actualChildLaunches': 19, 'historical188TestsAnd10PostimagesNotRecredited': True}
        scope = original['scope']
        limits = original['scopeLimits']
    sweep(contracts)
    sweep(dependencies)
    sweep(configs)
    sweep(frozen)
    # Read every currently approved source body, independently of old metadata.
    current_reads = {name: {'sha256': sha(ROOT / name), 'bytesRead': len((ROOT / name).read_bytes())} for name in contracts}
    declared_context = {**contracts, **dependencies, **configs, **frozen}
    commands = []
    for index, entry in enumerate(entries):
        name = entry.get('name')
        if node == 'B36':
            p = ROOT / entry['receipt']
            receipt = read(p)
            name = receipt['command']
            command_log = p.parent / receipt['log']
            before = receipt['sourceBefore']
            after = receipt['sourceAfter']
            exit_code = receipt['exit']
            pointer = ''
            assert before == after == contracts
        else:
            p = provenance
            receipt = entry
            command_log = ROOT / entry['log']
            before, after = source_before, source_after
            exit_code = entry['exitCode']
            pointer = '/commands/' + str(index)
        if (node == 'B01' and name in ['agent-typecheck', 'sdk-typecheck']) or (node == 'B36' and name == 'sdk-typecheck'):
            obsolete_commands.append({'name': name, 'provenance': {**ref(p), 'jsonPointer': pointer}, 'credit': 'rejected_for_unrecorded_current_execution_context', 'reason': 'Original command omitted actual TypeScript entry/delegate context; B36 latest command also omitted SDK config map. Preserved raw, replaced by fresh context-bound execution.'})
            continue
        assert exit_code == 0
        assert int(command_log.with_suffix('.exit').read_text().strip()) == 0
        assert before == after
        sweep(before)
        raw.update({str(p.relative_to(ROOT)): sha(p), str(command_log.relative_to(ROOT)): sha(command_log), str(command_log.with_suffix('.exit').relative_to(ROOT)): sha(command_log.with_suffix('.exit'))})
        normalized = {'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': node, 'name': name, 'argv': receipt['argv'], 'cwd': receipt['cwd'], 'exitCode': exit_code, 'log': ref(command_log), 'sourceBefore': before, 'sourceAfter': after, 'configBefore': configs, 'configAfter': configs, 'provenance': {**ref(p), 'jsonPointer': pointer}, 'executedBy': '/root/b04_lock_cas' if node == 'B36' else REVIEWER, 'newExecution': False}
        path = out / ('command-' + name + '.json')
        write(path, normalized)
        commands.append(ref(path))
    for name in (['agent-typecheck-refreshed-context', 'sdk-typecheck-refreshed-context'] if node == 'B01' else ['sdk-typecheck-refreshed-context'] if node == 'B36' else []):
        p, receipt = fresh[name]
        # The SDK typecheck does not include CLI or fixture sources. Those
        # retain their original fixture/test command coverage, not invented
        # typecheck coverage. Every intersecting input must still match.
        assert all(receipt['sourceAfter'][key] == digest for key, digest in contracts.items() if key in receipt['sourceAfter'])
        normalized = {**receipt, 'nodeId': node, 'provenance': ref(p), 'sharedContextOnly': receipt['nodeId'] != node}
        path = out / ('command-' + name + '.json')
        write(path, normalized)
        commands.append(ref(path))
        raw[str(p.relative_to(ROOT))] = sha(p)
        raw[receipt['log']['path']] = receipt['log']['sha256']
        declared_context.update(receipt['sourceAfter'])
    # Read argv-named scripts/tests as original bound command inputs. No newly
    # computed hash is substituted for a historical sourceBefore entry.
    for command in commands:
        record = read(ROOT / command['path'])
        for argument in record['argv'][1:]:
            candidate = pathlib.Path(argument)
            candidate = candidate if candidate.is_absolute() else ROOT / candidate
            if candidate.is_file() and candidate.suffix in {'.ts', '.tsx', '.js'}:
                declared_context[str(candidate.relative_to(ROOT))] = sha(candidate)
    sweep(declared_context)
    report = {
        'schemaVersion': 1, 'nodeId': node, 'reviewer': REVIEWER, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'method': 'Fresh independent actual source reading, original script/log/oracle/context inspection and hash comparison, plus authorized replacement typechecks. No ledger-derived authority.',
        'currentSourceReads': current_reads, 'declaredCommandContextHashes': declared_context,
        'sourceContractHashes': contracts, 'dependencyHashesWithoutApproval': dependencies,
        'observedOracles': oracle, 'actualSourceInspection': static,
        'originalCommandsNotCredited': obsolete_commands, 'neededReruns': [],
        'historicalNormalizationRawOnly': raw_wrappers,
        'scopeLimits': limits,
    }
    report_path = out / 'current-review-inspection.json'
    write(report_path, report)
    README = out / 'REVIEW.md'
    assert not README.exists()
    README.write_text('# ' + node + ' current bounded independent approval\n\n' + scope + '\n\n' + 'I, `' + REVIEWER + '`, independently approve this exact current source scope. This is a new attributable positive approval after current source, original scripts/logs/oracles, and declared command-context review. It does not infer approval from absent historical metadata or borrow ledger/wrapper authority.\n\n' + '\n'.join('- ' + item['observation'] for item in static) + '\n\n' + 'Current source bindings and all declared credited command inputs close. Required old commands without current executable/config context are rejected as credit and replaced by the new independently executed typechecks. Other unchanged commands remain at their recorded scope. Old approval/normalization artifacts are sealed raw supporting data; excluded, stale or prerequisite scopes gain no credit.\n\n' + '\n'.join('- ' + limit for limit in limits) + '\n')
    historical_context_refs = []
    if node in ['B01', 'B36']:
        historical_checks = [('B01', 'agent-typecheck-current-context'), ('B36', 'sdk-typecheck-current-context')] if node == 'B01' else [('B36', 'sdk-typecheck-current-context')]
        for historical_node, historical_name in historical_checks:
            historical_dir = EVIDENCE / historical_node / 'structured-independent-review'
            for extension in ['.json', '.log', '.exit']:
                historical_path = historical_dir / (historical_name + extension)
                item = ref(historical_path)
                raw[item['path']] = item['sha256']
                historical_context_refs.append({**item, 'credit': 'raw-data-only', 'reason': 'Superseded after the serve-socket test fixture changed; recorded pre-change inputs remain preserved, not current passing command credit.'})
    for item in raw_wrappers:
        raw[item['path']] = item['sha256']
    if node in ['B01', 'B36']:
        refreshed_runner = EVIDENCE / 'B01/refreshed-typecheck-context/run-refreshed-context-checks.py'
        raw[str(refreshed_runner.relative_to(ROOT))] = sha(refreshed_runner)
    own_artifacts = {str(report_path.relative_to(ROOT)): sha(report_path), str(README.relative_to(ROOT)): sha(README)}
    for command in commands:
        own_artifacts[command['path']] = command['sha256']
    for path in out.iterdir():
        if path.is_file() and path.name not in ['approval.json', 'review.json']:
            own_artifacts[str(path.relative_to(ROOT))] = sha(path)
    own_artifacts[str(pathlib.Path(__file__).resolve().relative_to(ROOT))] = sha(pathlib.Path(__file__).resolve())
    all_artifacts = {**raw, **own_artifacts}
    # Reused commands stay required exactly once; old context-incomplete
    # records appear only as uncredited supporting data.
    assert len(commands) == len({(item['path'], item['sha256']) for item in commands})
    behavior_names = {
        'B01': ['B01/independent-main-review/probe-report.json', 'B01/independent-main-review/ordinary-consumer-report.json', 'B01/independent-main-review/specialist-consumer-report.json', 'B01/independent-main-review/tests.log'],
        'B08': ['B08/final-binding/independent-review/fixture/observations.json', 'B08/final-binding/independent-review/route-metadata/observations.json', 'B08/final-binding/independent-review/provider-tests.log'],
        'B36': ['B36/current-independent-review/sdk-client-observations.json', 'B36/current-independent-review/integration-tests.log'],
    }[node]
    behavior_refs = [ref(EVIDENCE / name) for name in behavior_names]
    for item in behavior_refs:
        assert all_artifacts.get(item['path']) == item['sha256'], item['path']
    sweep(all_artifacts)
    sweep(contracts)
    common = {'schemaVersion': 1, 'nodeId': node, 'reviewer': REVIEWER, 'implementationOwners': owners, 'independent': True, 'decision': 'approve', 'scope': scope, 'sourceContractHashes': contracts, 'commandReceipts': commands, 'scopeLimits': limits}
    assert REVIEWER not in owners
    approval = {**common, 'type': 'body-independent-approval', 'artifacts': [{'path': path, 'sha256': digest} for path, digest in sorted(all_artifacts.items())], 'supportingEvidence': historical_context_refs + [{**item, 'credit': 'raw-data-only'} for item in raw_wrappers] + [{**item['provenance'], 'credit': 'raw-data-only', 'reason': item['reason']} for item in obsolete_commands], 'currentInspection': ref(report_path), 'behaviorOracleArtifacts': behavior_refs, 'neededReruns': [], 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    approval_path = out / 'approval.json'
    write(approval_path, approval)
    review = {**common, 'type': 'body-implementation-review', 'provenance': ref(approval_path), 'artifacts': [*approval['artifacts'], ref(approval_path)], 'supportingEvidence': approval['supportingEvidence']}
    review_path = out / 'review.json'
    write(review_path, review)
    for field in ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']:
        assert approval[field] == review[field]
    sweep(all_artifacts)
    sweep(contracts)
    output_refs.append({'nodeId': node, 'approval': ref(approval_path), 'review': ref(review_path), 'sourceContracts': len(contracts), 'commandReceipts': len(commands), 'neededReruns': []})
print(json.dumps(output_refs, indent=2))
