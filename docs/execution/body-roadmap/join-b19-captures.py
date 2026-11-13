#!/usr/bin/env python3
"""Join canonical B19 selectors to retained captures without granting acceptance.

Usage: python3 docs/execution/body-roadmap/join-b19-captures.py --canonical DIR
       --source-results FILE --compiled-results FILE --out NEW_DIRECTORY
The canonical directory is recovered historical input, never current execution.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
REF_CACHE = {}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(path):
    path = path.resolve()
    if path not in REF_CACHE:
        REF_CACHE[path] = {'path': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
                          'sha256': digest(path), 'bytes': path.stat().st_size}
    return dict(REF_CACHE[path])


def read(path):
    return json.loads(path.read_text())


def verify(value):
    path = ROOT / value['path']
    assert path.is_file() and digest(path) == value['sha256'], value
    return path


def key(schema, producer, branch, control, variant='default'):
    return (schema, producer, branch, control, variant)


def row_key(row):
    schema, selector = row['captureSchemaId'], row['selector']
    variant = selector.get('variant', 'default')
    if schema == 'terminal-branch':
        variant = (selector['id'], row['route'], selector.get('inherited', True))
    elif schema == 'external-sdk':
        variant = selector['edge']
    elif schema in ('supervision-compiled', 'external-compiled'):
        variant = row['mode']
    elif schema != 'toolchain-branch':
        variant = 'default'
    return key(schema, row['rawProducerId'], row['branchId'], row['control'], variant)


def field_refs(data):
    names = ['fixtureCase', 'capturedHostConfiguration', 'configReads', 'consumerEntries',
             'controlInput', 'privateRegistrations', 'sdkToolCallbacks', 'policyInputs',
             'adapterCalls', 'controlBoundary', 'upstreamGate', 'policy', 'spawns', 'children',
             'clockTransitions', 'events', 'genuineHostEvents', 'boundaryCalls', 'authorizerInputs',
             'observed', 'callbackReached', 'hostSnapshots', 'runtimeCalls', 'factoryCalls',
             'registrations', 'actionStarts', 'resolverCalls', 'attempts', 'boundaries',
             'policies', 'preparedAttempts', 'result', 'consumerResult', 'settledConsumerResults',
             'zeroSemantics', 'peer', 'sourceHashes', 'toolchain', 'executableSha256', 'execution', 'launches', 'output', 'observation']
    return {name: '/' + name for name in names if name in data}


def observations(data, schema, branch):
    if schema == 'sdk-oracle':
        return {'oracleCaseId': data['caseId'], 'assertedObservationField': '/observation',
                'interpretation': 'The retained observation contains each oracle arm and its actual boundary/phase; this supplemental group has no canonical producer selector credit.'}
    observed = data.get('observed', {})
    canonical_branch = branch
    branch = data.get('runtimeBranch', branch)
    events = data.get('events', data.get('execution', data.get('genuineHostEvents', observed.get('events', []))))
    event_field = '/events' if 'events' in data else '/execution' if 'execution' in data else '/genuineHostEvents' if 'genuineHostEvents' in data else '/observed/events'
    target = [e for e in events if e.get('facts', {}).get('branchId') == branch]
    earlier = [e for e in events if e.get('facts', {}).get('branchId') != branch]
    phases = Counter(e.get('phase') for e in target)
    launch_ids = sorted({e['facts']['launchId'] for e in target if e.get('facts', {}).get('launchId')})
    policies = data.get('policyInputs', data.get('policies', data.get('policy',
               data.get('authorizerInputs', observed.get('targetAuthorizations', [])))))
    target_policy = [p for p in policies if p.get('facts', {}).get('branchId',
                     p.get('branchId', p.get('target', {}).get('branchId'))) == branch]
    coverage = data.get('result', {}).get('controlCoverage', {}) if isinstance(data.get('result'), dict) else {}
    callback = data.get('callbackReached')
    if schema == 'terminal-branch':
        if data['fixtureCase']['route'] == 'sdk-run':
            callback = False if coverage.get('outerEntryGateOnly') else None
        else:
            callback = None
    if schema == 'external-sdk':
        callback = None  # generator entry is independent of selected MCP callback entry
    if schema == 'sdk-required-unavailable-log':
        callback = False  # current specific test fails in bootstrap before terminal callback
    starts = phases.get('dispatched', 0)
    return {
        'canonicalBranch': canonical_branch, 'rawObservedBranchSelector': branch,
        'rawEventBranchIds': sorted({e.get('facts', {}).get('branchId') for e in events if e.get('facts', {}).get('branchId')}),
        'targetEventPhases': dict(phases), 'targetLaunchIds': launch_ids,
        'targetPolicyObservations': len(target_policy),
        'targetDispatchEvents': starts,
        'otherBranchDispatchEvents': sum(e.get('phase') == 'dispatched' for e in earlier),
        'selectedTargetDispatchCount': coverage.get('selectedTargetDispatchCount'),
        'targetBoundaryCount': data.get('targetBoundaryCount', data.get('targetBoundaryCallCount')),
        'selectedCallbackReached': callback,
        'sdkGeneratorEntered': observed.get('generatorEntered'),
        'consumerEntryCount': len(data['consumerEntries']) if 'consumerEntries' in data else None,
        'sdkToolResultCallbackCount': len(data['sdkToolCallbacks']) if 'sdkToolCallbacks' in data else None,
        'outerEntryGateOnly': coverage.get('outerEntryGateOnly'),
        'laterBranchExhaustionApplicable': coverage.get('laterBranchExhaustionApplicable'),
        'earlierDispatchCountAtControl': data.get('earlierDispatchCountAtControl'),
        'controlBoundary': data.get('controlBoundary'), 'upstreamGate': data.get('upstreamGate'),
        'zeroSemantics': data.get('zeroSemantics'),
        'actualNodeChildReceiptCount': sum(c.get('kind') == 'actual-node-child' for c in data.get('children', [])),
        'syntheticPidCount': sum('syntheticPid' in c for c in data.get('adapterCalls', data.get('boundaries', []))),
        'factoryCallCount': len(data['factoryCalls']) if 'factoryCalls' in data else None,
        'originResolverSuccessfullyRecordedCount': len(data['resolverCalls']) if 'resolverCalls' in data else None,
        'originResolverCallbackEntryCount': None,
        'childActorRegistrationCount': len(data['registrations']) if 'registrations' in data else None,
        'preparedAttemptCount': len(data['preparedAttempts']) if 'preparedAttempts' in data else None,
        'hostSnapshotIds': sorted({e['facts']['configurationSnapshotId'] for e in events
                                  if e.get('facts', {}).get('configurationSnapshotId')}),
        'identityAndTruthFields': {'deadlines': event_field + '/*/facts/deadlines',
           'ownerRequestResourceGenerationLease': event_field + '/*/facts',
           'bindingAndProfile': event_field + '/*/facts',
           'finalExecutableArgvCwdEnv': {name: value for name, value in field_refs(data).items()
               if name in ['adapterCalls', 'spawns', 'children', 'boundaryCalls', 'boundaries', 'observed', 'launches']}},
        'interpretation': 'Observed counts only; helpers, selected dispatch, callback entry and actual OS processes are independent.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--canonical', type=Path, required=True)
    parser.add_argument('--source-results', type=Path, required=True)
    parser.add_argument('--compiled-results', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    canonical = {name: read(args.canonical / (name + '.json')) for name in
                 ['matrix', 'closure-requirements', 'variant-expansion', 'source-na-adjudication', 'capture-schema-map']}
    matrix, closure = canonical['matrix'], canonical['closure-requirements']
    rows = canonical['variant-expansion']['rows']
    source, compiled = read(args.source_results), read(args.compiled_results)
    manifest_path = verify(source['manifest'])
    manifest = read(manifest_path)
    assert ref(manifest_path)['sha256'] == compiled['manifest']['sha256']
    assert source['passed'] and compiled['passed']
    suites = []
    for index, receipt in enumerate(source['suites']):
        assert receipt['sourceStable'] and receipt['exitCode'] == 0
        log_path = verify(receipt['log'])
        log_lines = log_path.read_text().splitlines()
        receipt_path = args.source_results.parent / f'{index:02d}-result.json'
        assert read(receipt_path) == receipt
        suites.append({'receipt': ref(receipt_path), 'log': ref(log_path), 'source': receipt['suite'],
                       'lines': log_lines, 'argv': receipt['argv']})

    def test_assertion(suite, selector):
        for line, value in enumerate(suite['lines'], 1):
            match = re.match(r'\(pass\) (.*?) \[[^\]]+\]$', value)
            if match and (match.group(1) == selector or match.group(1).endswith(' > ' + selector)):
                return {'kind': 'specific-passing-test-log-line', **suite['log'], 'line': line,
                        'testName': match.group(1), 'testSource': {'path': suite['source'],
                            'sha256': manifest['inputs'][suite['source']]}, 'sourceIdentity': 'original-dispatch-manifest'}
        return None

    cases, index = [], defaultdict(list)

    def add(data, schema, capture, normalized_key, suite, assertion=None, compiled_receipt=None):
        source_mismatches = {name: sha for name, sha in data.get('sourceHashes', {}).items()
                             if manifest['inputs'].get(name) != sha}
        assert not source_mismatches, source_mismatches
        if suite:
            dependencies = [suite['source']]
            deps = {'terminal-branch': ['sdk/src/__tests__/fixtures/b19-terminal-branch-authority-r3.ts'],
                    'toolchain-branch': ['sdk/src/__tests__/fixtures/toolchain-branch-authority.ts'],
                    'blender-sdk': ['sdk/src/__tests__/fixtures/b19-blender-sdk-branch-controls.ts'],
                    'supervision-source': ['sdk/src/__tests__/fixtures/b19-supervision-sdk-branch-controls.ts']}
            dependencies += deps.get(schema, [])
            dependencies += list(data.get('sourceHashes', {}))
            source_refs = [{'path': n, 'sha256': manifest['inputs'][n]} for n in dict.fromkeys(dependencies)]
        else:
            source_refs = [{'path': n, 'sha256': sha} for n, sha in data['sourceHashes'].items()]
        status = data.get('status', data.get('outcome', data.get('captureStatus')))
        passed = status in ['passed', 'assertions-passed'] or schema == 'supervision-source' and assertion is not None
        case = {'caseId': len(cases), 'schema': schema, 'selectorKey': list(normalized_key),
                'capture': capture, 'assertion': assertion,
                'sourceRefs': source_refs,
                'receipt': suite['receipt'] if suite else {'results': ref(args.compiled_results), **compiled_receipt},
                'captureOutcome': status, 'captureAssertionsPassed': passed,
                'evidenceKind': data.get('evidenceKind', data.get('observationOrigin')),
                'route': 'OpenbuffClient.run SDK callback' if schema == 'blender-sdk' else data.get('fixtureCase', {}).get('route'),
                'rawBranch': data.get('runtimeBranch', data.get('branchId', data.get('targetBranch', data.get('branch')))),
                'observations': observations(data, schema, normalized_key[2]),
                'fields': field_refs(data), 'limits': data.get('limitations', data.get('limits', data.get('doesNotCertify', []))),
                'acceptance': False}
        cases.append(case)
        index[normalized_key].append(case['caseId'])

    suite_by_source = {s['source']: s for s in suites}
    terminal_suite = suite_by_source['sdk/src/__tests__/terminal-execution-branch-controls.test.ts']
    for artifact in source['captures']:
        path = verify(artifact)
        if path.suffix == '.jsonl':
            assert 'terminal/runs/' in str(path)
            for line_no, line in enumerate(path.read_bytes().splitlines(), 1):
                data = json.loads(line)
                fixture = data['fixtureCase']
                selector = fixture['id'] + ':' + data['state']
                assertion = test_assertion(terminal_suite, selector) or test_assertion(terminal_suite, fixture['id'])
                assert assertion, selector
                capture = {**ref(path), 'line': line_no, 'lineSha256': hashlib.sha256(line).hexdigest()}
                add(data, 'terminal-branch', capture, key('terminal-branch', fixture['producerId'],
                    fixture['branchId'], data['state'], (fixture['id'], fixture['route'], data['inherited'])),
                    terminal_suite, assertion)
            continue
        data = read(path)
        if 'toolchain/runs/' in str(path):
            owners = [s for s in suites if any(str(path) in line for line in s['lines'])]
            assert len(owners) == 1, path
            suite = owners[0]
            add(data, 'toolchain-branch', ref(path), key('toolchain-branch', data['producerId'],
                data['branchId'], data['state'], data['variant']), suite,
                {'kind': 'assertions-passed capture written by observeBranchCase after body assertions',
                 'status': data['status'], 'source': {'path': 'sdk/src/__tests__/fixtures/toolchain-branch-authority.ts',
                      'sha256': manifest['inputs']['sdk/src/__tests__/fixtures/toolchain-branch-authority.ts']},
                 'log': suite['log'], 'captureLogLine': next(i for i, line in enumerate(suite['lines'], 1) if str(path) in line)})
        elif 'chrome-sdk' in str(path):
            suite = suite_by_source['sdk/src/__tests__/chrome-sdk-execution-branch-controls.test.ts']
            assertion = test_assertion(suite, f"sdk.chrome {data['branch']} {data['control']}")
            assert assertion
            add(data, 'chrome-sdk', ref(path), key('chrome-sdk', data['producer'], data['branch'], data['control']), suite, assertion)
        elif 'blender-sdk' in str(path):
            suite = suite_by_source['sdk/src/__tests__/blender-sdk-execution-branch-controls.test.ts']
            assertion = test_assertion(suite, f"sdk.blender {data['branch']} {data['control']}")
            assert assertion
            assert data['producer'] == 'sdk.blender' and data['status'] == 'passed'
            assert data['targetBoundaryCount'] == (1 if data['control'] == 'happy' else 0)
            add(data, 'blender-sdk', ref(path), key('blender-sdk', data['producer'], data['branch'], data['control']), suite, assertion)
        elif 'sdk-oracle-controls' in str(path):
            suite = suite_by_source['sdk/src/__tests__/execution-launch-oracles.test.ts']
            names = {
                'missing-authorizer': 'approval.missing-authorizer: identical intended target refuses at host intake while explicit allow-all launches',
                'mcp-missing-authorizer': 'real.mcp-env: owned stdio preserves missing-authorizer host-intake refusal and explicit allow-all launches',
                'sync-required-cooperative-cancellation': 'sync.limit and review.admission.sync: real legacy adapter refuses required cooperative cancellation before spawnSync',
                'concurrent-sdk-isolation': 'review.config.isolation: two simultaneous SDK strategies read no ambient configuration',
                **{'fresh-retry-' + outcome: 'review.authority.v2-and-retry: fresh high-impact approval after ' + outcome + ' preserves target grants through preflight'
                   for outcome in ['ENOENT','failing-child','unobserved-child']},
            }
            assert path.stem == data['caseId'] and data['status'] == 'passed'
            assertion = test_assertion(suite, names[data['caseId']])
            assert assertion
            add(data, 'sdk-oracle', ref(path), key('sdk-oracle', 'sdk.oracle-controls', data['caseId'], 'passed'), suite, assertion)
        elif path.name == 'case.json' and 'sdk-supervision/runs/' in str(path):
            suite = suite_by_source['sdk/src/__tests__/supervision-sdk-execution-branch-controls.test.ts']
            sidecar_path = path.parent / 'assertion-result.json'
            sidecar = read(sidecar_path)
            assert sidecar['casePath'] == str(path) and sidecar['caseSha256'] == digest(path)
            assert sidecar['assertionStatus'] == 'passed'
            assertion = {'kind': 'SHA-bound assertion sidecar', **ref(sidecar_path), 'status': sidecar['assertionStatus']}
            add(data, 'supervision-source', ref(path), key('supervision-source', data['producer'], data['targetBranch'], data['control']), suite, assertion)
    external_suite = suite_by_source['sdk/src/__tests__/external-execution-branch-controls.test.ts']
    for receipt in source['suites']:
        for artifact in receipt['externalOriginals']:
            path = verify(artifact)
            data = read(path)
            schema = 'external-sdk' if 'run-client/' in str(path) else 'external-direct'
            control = path.stem.split('--')[-1] if schema == 'external-sdk' else data['control']
            variant = data['observed']['edge'] if schema == 'external-sdk' else 'default'
            assert schema != 'external-sdk' or data['observed']['control'] == control
            selector = f"actual-sdk-run {variant} {control}" if schema == 'external-sdk' else f"{data['producer']} {data['matrixBranch']} {control}"
            assertion = test_assertion(external_suite, selector)
            if assertion is None:
                names = {'real-mcp-env': f"{data['producer']} real.mcp-env captured destination",
                         'request-versus-resource-lifetime': f"{data['producer']} request cancellation preserves another lease",
                         'delayed-authorizer-waiter-only-cancellation': f"{data['producer']} delayed authorizer waiter cancellation preserves startup for another lease",
                         'missing-context': 'missing Blender context is separate from branch admission controls' if data['producer'] == 'sdk.blender'
                                            else 'missing Chrome context is separate from branch admission controls'}
                assertion = test_assertion(external_suite, names[control])
            assert assertion, selector
            add(data, schema, ref(path), key(schema, data['producer'], data['matrixBranch'], control, variant), external_suite, assertion)

    native_suite = suite_by_source['sdk/src/__tests__/run-host-contract-controls.test.ts']
    native_lines = [(i, value) for i, value in enumerate(native_suite['lines'], 1)
                    if value.startswith('B19_SDK_REQUIRED_UNAVAILABLE ')]
    assert len(native_lines) == 1
    native_line_no, native_line = native_lines[0]
    native = json.loads(native_line.partition(' ')[2])
    assert native['launches'] == [] and native['output']['type'] == 'error'
    assert not any(e['phase'] == 'dispatched' for e in native['execution'])
    assert any(e.get('refusal', {}).get('reason') == 'unavailable' for e in native['execution'])
    expected_profile = {'policy': 'full-access', 'preferredBackend': 'native-exec', 'required': ['exact-env'], 'allowBackendFallback': False}
    assert all(e['facts']['profile']['requested'] == expected_profile for e in native['execution'])
    assertion = test_assertion(native_suite, 'strategy.sdk: a second run with required unavailable execution starts no command target')
    assert assertion
    # The raw bytes use bootstrap branch names. native.unavailable is the
    # canonical unavailable-selection scenario, never a process branch rename.
    native_case = {**native, 'status': 'passed',
                   'evidenceKind': 'actual-sdk-unavailable-selection-at-bootstrap; selected-terminal-callback-unreached',
                   'limitations': ['Scenario counterpart only; raw bootstrap event labels retained',
                                   'No native execution or selected terminal callback entry proof']}
    add(native_case, 'sdk-required-unavailable-log', {**native_suite['log'], 'line': native_line_no,
        'lineSha256': hashlib.sha256(native_line.encode()).hexdigest(), 'jsonPrefix': 'B19_SDK_REQUIRED_UNAVAILABLE '},
        key('sdk-required-unavailable-log', 'native.selection', 'native.unavailable', 'unavailable'), native_suite, assertion)

    for case_no, receipt in enumerate(compiled['cases']):
        data = read(verify(receipt['capture']))
        binary = verify(receipt['binary'])
        verify(receipt['log']); verify(receipt['buildLog'])
        assert receipt['passed'] and receipt['exitCode'] == 0
        assert data['status'] == 'passed' and data['executableSha256'] == digest(binary)
        sdk = receipt['family'] == 'sdk'
        assert not sdk or data['assertionsCompleted'] is True
        schema = 'supervision-compiled' if sdk else 'external-compiled'
        branch = data['targetBranch'] if sdk else data['matrixBranch']
        mode = receipt['mode'] if sdk else 'minimal-external'
        assertion_source = ('sdk/src/__tests__/fixtures/b19-supervision-sdk-compiled-entry.ts' if sdk
                            else 'sdk/src/__tests__/fixtures/external-branch-compiled-entry.ts')
        assert data['sourceHashes'][assertion_source] == manifest['inputs'][assertion_source]
        assertion = {'kind': 'compiled internal fixture assertions + raw status + exact original zero exit',
                     'assertionsCompleted': data.get('assertionsCompleted'),
                     'assertionSource': {'path': assertion_source, 'sha256': manifest['inputs'][assertion_source]},
                     'sourceIdentity': 'original-compiled-build-manifest',
                     'buildLog': receipt['buildLog'], 'binary': receipt['binary'], 'log': receipt['log']}
        add(data, schema, receipt['capture'], key(schema, data['producer'], branch, receipt['control'], mode),
            None, assertion, {'caseIndex': case_no, 'argv': receipt['argv'], 'buildArgv': receipt['buildArgv'],
                              'binary': receipt['binary'], 'buildLog': receipt['buildLog'], 'log': receipt['log']})

    row_joins, unmatched = [], []
    for row in rows:
        found = index.get(row_key(row), [])
        alias = None
        if not found and row['rowId'] in ['toolchain-zero-layer', 'lsp-symbol-no-acquire::no-warm-server', 'lsp-symbol-no-acquire::dead-warm-entry']:
            if row['rowId'] == 'toolchain-zero-layer':
                raw_key = key('toolchain-branch', 'direct.budget-intake', 'budget.zero-layer', 'allow')
                source_path = ROOT / 'sdk/src/__tests__/toolchain-execution-branch-controls.test.ts'
                source_anchor = "producerId: 'direct.budget-intake', branchId: 'budget.zero-layer', state: 'allow'"
                test_name = 'literal-zero SDK intake and invalid common duration have distinct original refusals'
            else:
                raw_variant = 'cold-query' if row['rowId'].endswith('no-warm-server') else 'dead-entry-query'
                raw_key = key('toolchain-branch', 'sdk.lsp-primary', 'lsp.workspace-symbol-no-acquire', 'allow', raw_variant)
                source_path = ROOT / 'sdk/src/__tests__/lsp-execution-branch-controls.test.ts'
                source_anchor = "first: scenario === 'dead-entry-query' ? definition : null"
                test_name = f'sdk.lsp-primary workspace_symbol {raw_variant} cannot launch the source-inapplicable acquire branch'
            assert source_anchor in source_path.read_text()
            found = index.get(raw_key, [])
            assert len(found) == 1
            suite = suite_by_source[str(source_path.relative_to(ROOT))]
            assertion = test_assertion(suite, test_name)
            assert assertion
            alias = {'kind': 'explicit-source-backed-selector-alias', 'canonicalKey': list(row_key(row)),
                     'rawKeyRetained': list(raw_key), 'source': ref(source_path), 'sourceAnchor': source_anchor,
                     'assertion': assertion, 'canonicalEdgeCredit': False}
        assert len(found) <= 1, row['rowId']
        joined = bool(found)
        row_joins.append({k: row[k] for k in ['rowId', 'edgeId', 'producerId', 'branchId', 'rawProducerId',
            'rawBranchId', 'control', 'canonicalStateSlot', 'route', 'mode', 'captureSchemaId', 'sourceId',
            'selector', 'evidenceRole', 'testOrFixtureSelector']} | {
            'caseIds': found, 'status': ('source-backed-selector-alias-capture-joined' if alias else 'selector-capture-joined') if joined else 'UNJOINED',
            'selectorAlias': alias,
            'assertionJoined': bool(found) and cases[found[0]]['assertion'] is not None,
            'finalEdgeVerdict': 'unadjudicated', 'fullControlOracleVerdict': 'unadjudicated'})
        if not joined:
            unmatched.append(row['rowId'])

    # Current source applicability is a separate adjudication. Exact old excerpt
    # preservation and current source hash identity are reported independently.
    na = canonical['source-na-adjudication']
    proof_groups = {}
    for group_id, group in na['proofGroups'].items():
        refs = []
        for old in group['sourceRefs']:
            path = ROOT / old['path']
            text = path.read_text()
            excerpt = '\n'.join(line.partition(': ')[2] for line in old['excerpt'].splitlines())
            locations = [i for i, line in enumerate(text.splitlines(), 1) if old['anchor'] in line]
            assert locations, old['anchor']
            start = locations[0]
            width = old['lineEnd'] - old['lineStart'] + 1
            refs.append({**ref(path), 'historicalSha256': old['sha256'], 'sourceHashDrift': digest(path) != old['sha256'],
                         'anchor': old['anchor'], 'anchorLines': locations,
                         'historicalExcerptPreserved': excerpt in text,
                         'currentExcerpt': '\n'.join(text.splitlines()[start - 1:start - 1 + width])})
        proof_groups[group_id] = {'reason': group['reason'], 'currentRefs': refs,
            'sourceApplicabilityStatus': 'revalidated-source-selection-only',
            'manualExcerptDifferences': ({'difference': 'sandboxPolicy added; no timeout selector added'} if group_id == 'identity-legacy-only'
                else {'difference': 'strict/tolerant default changed; getBaseline still returns stored capture and does not launch baseline'}
                if group_id == 'hooks-no-new-baseline' else {})
                if any(not r['historicalExcerptPreserved'] for r in refs) else {},
            'acceptance': False}
    na_edges = [{k: e[k] for k in ['edgeId', 'producerId', 'branchId', 'proofGroupId', 'reason', 'actualSelectedBranchAlternatives']}
                | {'status': 'revalidated-source-backed-not-applicable', 'executionProof': False} for e in na['edges']]
    na_ids = {e['edgeId'] for e in na_edges}
    edges = []
    for edge in matrix['producerBranchEdges']:
        selectors = [j for j in row_joins if j['edgeId'] == edge['edgeId']]
        edges.append({'edgeId': edge['edgeId'], 'producerId': edge['producerId'], 'branchId': edge['branchId'],
                      'requiredControlIds': next((x['requiredCanonicalControlIds'] for x in closure['edgeRequirements']
                                                 if x['edgeId'] == edge['edgeId']), []),
                      'sourceApplicability': 'source-backed-not-applicable' if edge['edgeId'] in na_ids else 'applicable',
                      'selectorRows': len(selectors), 'selectorRowsJoined': sum(bool(j['caseIds']) for j in selectors),
                      'assertionRowsJoined': sum(j['assertionJoined'] for j in selectors),
                      'unjoinedRowIds': [j['rowId'] for j in selectors if not j['caseIds']],
                      'finalEdgeVerdict': 'unadjudicated' if edge['edgeId'] not in na_ids else 'source-applicability-only'})
    matched_ids = {case for row in row_joins for case in row['caseIds']}
    current_drift = [{'path': name, 'manifestSha256': sha,
                      'currentSha256': digest(ROOT / name) if (ROOT / name).is_file() else None}
                     for name, sha in manifest['inputs'].items()
                     if not (ROOT / name).is_file() or digest(ROOT / name) != sha]
    counts = {'originalProducers': len(matrix['producerRows']), 'originalEdges': len(edges),
              'sourceNAEdgesRevalidated': len(na_ids), 'applicableEdges': len(edges) - len(na_ids),
              'applicableEdgesWithMatchingCapture': sum(e['sourceApplicability'] == 'applicable' and e['selectorRowsJoined'] > 0 for e in edges),
              'applicableEdgesWithoutMatchingCapture': [e['edgeId'] for e in edges if e['sourceApplicability'] == 'applicable' and e['selectorRowsJoined'] == 0],
              'canonicalAndSupplementalSelectorRows': len(rows), 'selectorRowsJoined': len(rows) - len(unmatched),
              'unjoinedSelectorRows': len(unmatched), 'assertionRowsJoined': sum(j['assertionJoined'] for j in row_joins),
              'exactSelectorRowsJoined': sum(bool(j['caseIds']) and not j['selectorAlias'] for j in row_joins),
              'sourceBackedAliasRowsJoined': sum(j['selectorAlias'] is not None for j in row_joins),
              'rawCasesIndexed': len(cases), 'rawCasesMatchingRecoveredRows': len(matched_ids),
              'additionalCurrentCaptureCases': len(cases) - len(matched_ids),
              'blenderSdkCallbackCasesJoined': sum(c['schema'] == 'blender-sdk' for c in cases),
              'sdkOracleCaptureCasesJoined': sum(c['schema'] == 'sdk-oracle' for c in cases),
              'additionalCurrentCaptureCasesBySchema': dict(Counter(c['schema'] for c in cases if c['caseId'] not in matched_ids)),
              'fullControlOraclesAdjudicated': 0, 'fullControlOraclesPending': len(matrix['controlRows']),
              'finalApplicableEdgeVerdictsAdjudicated': 0,
              'sourceAndCompiledReceiptSourceInputs': len(manifest['inputs']),
              'liveSourceManifestDriftFiles': len(current_drift)}
    gates = [
        'All 32 complete control oracles remain unadjudicated; supporting test/capture selectors do not establish full oracle completion.',
        'All 196 final applicable edge verdicts remain unadjudicated; intake refusal and earlier helper counts must be assessed independently of selected target entry.',
        'Native unavailable scenario counterpart joins current structured JSON log and passing test; it proves bootstrap unavailable refusal, not selected terminal callback entry or native execution.',
        'Factory compiled negatives, whole SDK happy-only compiled cases and minimal compiled direct cases remain distinct routes.',
        'Empty resolverCalls means zero successfully recorded resolutions; it does not prove zero origin resolver callback entry.',
        'OS process claims require actual observed process origin; terminal/Chrome/LSP/source supervision synthetic peers and PIDs are retained as such.',
        'Whole-package CI, package consumers, prerequisite cards and final independent acceptance review are owned by root and are outside this join report.',
    ]
    controls = [{'controlId': c['controlId'], 'canonicalOracle': c['canonicalOracle'],
                 'specificTestSourceIds': c['specificTestSourceIds'],
                 'candidateCaptureSchemaIds': c['candidateCaptureSchemaIds'],
                 'status': 'UNADJUDICATED-COMPLETE-ORACLE', 'acceptance': False}
                for c in closure['controlRequirements']]
    callback_routes = []
    expected_blender_controls = {'happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero',
                                 'delayed-authorizer-cancellation', 'exhausted-before-later-branch'}
    for edge in edges:
        if edge['producerId'] != 'sdk.blender':
            continue
        selected = [c for c in cases if c['schema'] == 'blender-sdk' and c['selectorKey'][2] == edge['branchId']]
        callback_controls = {c['selectorKey'][3] for c in selected}
        if selected:
            assert len(selected) == 7 and callback_controls == expected_blender_controls, edge['edgeId']
            assert all(c['assertion'] is not None for c in selected)
            assert any(c['selectorKey'][3] == 'happy' and c['observations']['selectedCallbackReached'] for c in selected)
        callback_routes.append({'edgeId': edge['edgeId'], 'producerId': 'sdk.blender', 'branchId': edge['branchId'],
            'route': 'OpenbuffClient.run SDK Blender callback', 'sdkCallbackCaseIds': [c['caseId'] for c in selected],
            'sdkCallbackControls': sorted(callback_controls),
            'currentDirectCaseIds': [j['caseIds'][0] for j in row_joins if j['edgeId'] == edge['edgeId'] and j['caseIds']],
            'currentDirectControls': sorted({j['control'] for j in row_joins if j['edgeId'] == edge['edgeId']}),
            'reason': None if selected else 'Current original source suite has no SDK callback captures; direct captures prove their direct route only',
            'status': 'asserted-sdk-callback-route-joined' if selected else 'UNJOINED-SDK-CALLBACK-ROUTE',
            'canonicalSelectorCredit': False, 'acceptance': False})
    if any(r['status'] == 'UNJOINED-SDK-CALLBACK-ROUTE' for r in callback_routes):
        gates.append('SDK Blender callback evidence is missing from these source originals; direct Blender receipts retain direct-route scope.')
    out = args.out.resolve()
    allowed = ROOT / 'docs/execution/body-roadmap/evidence/B19/continuation-20261111/capture-joins'
    assert out.is_relative_to(allowed), out
    out.mkdir(parents=True, exist_ok=False)
    artifacts = {'case-index.json': cases, 'selector-joins.json': row_joins, 'edge-coverage.json': edges,
                 'source-na-current.json': {'proofGroups': proof_groups, 'edges': na_edges},
                 'control-gaps.json': controls, 'live-source-drift.json': current_drift,
                 'missing-callback-gates.json': callback_routes}
    for name, value in artifacts.items():
        (out / name).write_text(json.dumps(value, indent=2) + '\n')
    report = {'schemaVersion': 1, 'card': 'B19', 'acceptance': False,
              'status': 'Current selector capture joins; complete edge and control adjudication pending',
              'canonicalInputs': {name: ref(args.canonical / (name + '.json')) for name in canonical},
              'sourceResults': ref(args.source_results), 'compiledResults': ref(args.compiled_results),
              'sourceManifest': ref(manifest_path), 'joiner': ref(Path(__file__)),
              'counts': counts, 'unjoinedRowIds': unmatched, 'gates': gates,
              'rowsBySource': {source_id: {'required': sum(j['sourceId'] == source_id for j in row_joins),
                                          'joined': sum(j['sourceId'] == source_id and bool(j['caseIds']) for j in row_joins)}
                               for source_id in sorted({j['sourceId'] for j in row_joins})},
              'additionalCurrentCaptureCaseIds': [c['caseId'] for c in cases if c['caseId'] not in matched_ids],
              'artifacts': {name: ref(out / name) for name in artifacts},
              'sourceCurrentness': 'Receipt manifest/stability proves original dispatch source identity. Live source drift is separately reported; no claim of whole-candidate currentness.'}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    text = '# B19 current capture joins\n\n'
    text += f"{counts['selectorRowsJoined']}/{len(rows)} recovered selector rows have current raw capture joins; "
    text += f"{counts['applicableEdgesWithMatchingCapture']}/{counts['applicableEdges']} applicable edges have at least one matching case. "
    text += 'These are coverage joins, not final edge or complete control passes.\n\n'
    text += f"Exact selectors: {counts['exactSelectorRowsJoined']}; explicit source-backed supplemental aliases: {counts['sourceBackedAliasRowsJoined']}. "
    text += 'Raw selector/control names remain unchanged in the case index.\n\n'
    text += '| Source | Required selectors | Raw capture joins |\n| --- | ---: | ---: |\n'
    for name, c in report['rowsBySource'].items():
        text += f"| {name} | {c['required']} | {c['joined']} |\n"
    text += '\nAll 55 historical source N/A edges were checked against current source anchors. '
    text += 'Hash and excerpt drift is retained in `source-na-current.json`; source applicability does not establish selected-variant execution.\n\n'
    text += f"Additional current cases absent from recovered selectors: {counts['additionalCurrentCaptureCases']}. "
    text += 'They remain supplemental and do not alter the original 26 producer / 251 edge denominator.\n\n'
    text += f"Blender SDK callback cases from this same source invocation: {counts['blenderSdkCallbackCasesJoined']}. "
    text += 'Their SDK route joins are recorded separately in `missing-callback-gates.json`.\n\n'
    text += 'Unjoined selectors:\n\n' + ''.join(f'- `{name}`\n' for name in unmatched)
    text += '\nUnresolved gates:\n\n' + ''.join(f'- {gate}\n' for gate in gates)
    text += '\n`report.json` links SHA-bound original result/manifest and all reports. `case-index.json` links raw JSON or exact JSONL line, source fixtures, original receipt/log, assertion evidence and observation fields. '
    text += 'Fresh source stability is scoped to the original commands; `live-source-drift.json` separately records later source or package fixture edits.\n'
    (out / 'README.md').write_text(text)
    print(json.dumps(counts, indent=2))


if __name__ == '__main__':
    main()
