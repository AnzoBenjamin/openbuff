"""Independent current-source and closed-oracle inspection. No product execution."""
from pathlib import Path
import base64, datetime, hashlib, json, re, sys

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir() and (p / 'docs/execution/body-roadmap').is_dir())
INPUTS = json.loads((OUT / 'inputs.json').read_text())
CARD = INPUTS['nodeId']
ORIGINAL = ROOT / INPUTS['originalReviewManifest']['path']
BASE = ORIGINAL.parent

def read(path): return json.loads(Path(path).read_text())
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def digest(data): return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()
def ref(path): return {'path': str(Path(path).resolve().relative_to(ROOT)), 'sha256': sha(path)}
def bind(row):
    path = ROOT / row['path']
    assert sha(path) == row['sha256'], row['path']
    return path
def source_check(sources):
    for path, expected in sources.items(): assert sha(ROOT / path) == expected, path
def compact(value): return json.dumps(value, separators=(',', ':'), ensure_ascii=False)

bind(INPUTS['originalReviewManifest'])
manifest = read(ORIGINAL)
sources = manifest.get('sourceHashes') or {r['file']: r['sha256'] for r in manifest['currentSources']}
source_check(sources)
assert not (OUT / 'inspection.json').exists(), 'Preserve the closed inspection; use check.py afterward'
if INPUTS.get('originalSourceStabilityEvidence'):
    stability = read(bind(INPUTS['originalSourceStabilityEvidence']))
    assert stability['allMatch'] and {r['file']: r['sha256'] for r in stability['sources']} == sources
prior_flat = read(bind(INPUTS['supportingNormalization']))
for row in prior_flat['artifacts']: bind(row)
command_context = []
for specification in INPUTS['commands']:
    original = read(bind(specification['provenance']))
    if 'provenanceCommandIndex' in specification: original = original[specification['provenanceCommandIndex']]
    before = original.get('sourceBefore', sources)
    after = original.get('sourceAfter', sources)
    assert before == after and all(before.get(p) == d for p, d in sources.items())
    source_check(before)
    log = BASE / original['log']
    if original.get('logSha256'): assert sha(log) == original['logSha256']
    assert original.get('exit', original.get('exitCode')) == 0
    argv_inputs = [ref(ROOT / arg) for arg in original['argv'] if not Path(arg).is_absolute() and (ROOT / arg).is_file()]
    argv_inputs += [ref(arg) for arg in original['argv'] if Path(arg).is_absolute() and Path(arg).is_file() and Path(arg).resolve().is_relative_to(ROOT)]
    environment = original.get('environment', {'keys': original.get('envKeys', [])})
    context_files = []
    config_path = environment.get('OPENBUFF_PROVIDER_CONFIG')
    if config_path:
        context_files.append(ref(config_path))
        assert read(config_path) == {}
    if original['argv'][0].endswith('/bun'):
        expected_bun = manifest.get('bun', {}).get('sha256', manifest.get('bunHash'))
        assert sha(original['argv'][0]) == expected_bun
        assert '--no-env-file' in original['argv']
    command_context.append({'name': specification['name'], 'argv': original['argv'],
        'exitCode': original.get('exit', original.get('exitCode')), 'log': ref(log),
        'sourceBefore': before, 'sourceAfter': after, 'argvInputFiles': argv_inputs,
        'environment': environment, 'configurationFiles': context_files, 'provenance': specification['provenance'],
        'sourceMapDerivation': 'Exact original command maps' if 'sourceBefore' in original else 'Original final manifest currentSources plus matching original source-stability evidence',
        **({'provenanceSourceManifest': INPUTS['originalReviewManifest'], 'sourceStability': INPUTS['originalSourceStabilityEvidence']} if 'sourceBefore' not in original else {}),
        **({'provenanceCommandIndex': specification['provenanceCommandIndex']} if 'provenanceCommandIndex' in specification else {})})

expected_tests = {'B03': 243, 'B04': 147, 'B18': 180, 'B30': 17}
test_counts = []
for row in command_context:
    if 'test' not in row['argv']: continue
    log = (ROOT / row['log']['path']).read_text()
    passed = int(re.search(r'^\s*(\d+) pass\b', log, re.M).group(1))
    failed = int(re.search(r'^\s*(\d+) fail\b', log, re.M).group(1))
    expected = 1 if row['name'] == 'leader-vision-route-regression' else expected_tests[CARD]
    assert passed == expected and failed == 0
    test_counts.append({'command': row['name'], 'pass': passed, 'fail': failed})

def rawhash(value): return 'sha256:' + digest(value)
def acknowledged(receipt):
    actions = []
    for action in receipt['actions']:
        forward = action.get('forward')
        if action['status'] not in ['committed', 'rollback_failed'] or not forward or forward['outcome'] != 'applied': continue
        final = receipt['finalHashes']; hashes = forward['afterHashes']; target = action.get('destinationPath', action['path'])
        if hashes.get(target) != action['afterHash']: continue
        if action['action'] == 'move' and hashes.get(action['path'], 'missing') is not None: continue
        if all(path in final and final[path] == value for path, value in hashes.items()): actions.append(action)
    return actions

if CARD == 'B03':
    report = read(BASE / 'fixture/mutation-report.json'); byte_count = 0; populations = []
    expected = {'rejected-then-recovered': [0, 1], 'thrown-partial': [0], 'retained-partial-forward': [1], 'successful-edit': [1]}
    assert report['fetch'] == {'attempted': 0, 'forwarded': 0}
    for record in report['records']:
        for side in ['before', 'after']:
            for value in record[side].values():
                raw = base64.b64decode(value['base64'], validate=True)
                assert raw.decode() == value['utf8'] and rawhash(raw) == value['hash']; byte_count += 1
        counts = []
        for projection in record['projections']:
            mutation = projection['mutation']; receipt = mutation['authorityReceipt']; actions = acknowledged(receipt)
            assert receipt['operationId'] == mutation['operationId'] and receipt['receiptId'] == mutation['receiptId']
            assert [a['actionId'] for a in actions] == [a['actionId'] for a in projection['confirmed']] == [a['actionId'] for a in projection['cliConfirmed']]
            assert projection['summary']['filesEdited'] == len(actions)
            counts.append(len(actions))
        assert counts == expected[record['mode']]; populations.append(counts)
    node = read(BASE / 'node-broker-probe.json')
    for side in ['before', 'after']:
        raw = base64.b64decode(node[side]['base64'], validate=True)
        assert rawhash(raw) == node[side]['hash']; byte_count += 1
    assert base64.b64decode(node['after']['base64']) == b'after\r\nkept\r\n'
    assert len(acknowledged(node['mutation']['authorityReceipt'])) == 1
    assert acknowledged(report['legacyRefusedRollback']['authorityReceipt']) == []
    assert byte_count == 18
    oracle = {'rawByteRecordsRecomputed': byte_count, 'confirmedPopulations': populations, 'refusedRollbackConfirmations': 0, 'nodeExactCRLFConfirmation': 1}
elif CARD == 'B04':
    rows = read(BASE / 'runtime-observations.json'); assert len(rows) == 9
    by = lambda name: [r for r in rows if r['b04'] == name]
    broker = by('broker-real-process')[0]
    assert [r['event'] for r in broker['events']] == ['enter', 'exit', 'enter', 'exit']
    assert broker['events'][0]['pid'] != broker['events'][2]['pid']
    assert broker['events'][0]['token'] != broker['events'][2]['token']
    assert sum(r['applied'] for r in broker['results']) == 1
    assert len({r['receipt']['receiptId'] for r in broker['results']}) == 2
    crash = by('broker-crash-refusal')[0]; assert crash['beforeHash'] == crash['afterHash']
    index = by('index-real-process'); assert len(index) == 2 and {r['initial'] for r in index} == {True, False}
    for row in index:
        assert sum(r['result'] for r in row['outputs']) == 1
        assert digest(row['after']) == row['actualPublicationToken'] != row['expectedPublicationToken']
    assert by('manager-graph-cas-refusal')[0]['returned'] is False
    for row in by('snapshot-cas'):
        assert row['outcome']['status'] == 'error' and row['expected'] != row['winner']
    real = by('snapshot-real-process')[0]
    assert real['refused']['status'] == 'skipped' and [r['label'] for r in real['chain']] == ['parent-turn', 'child-turn']
    oracle = {'runtimeRows': 9, 'singleBrokerWinner': True, 'crashBytesPreserved': True, 'indexFullByteHashesRecomputed': 2, 'snapshotContentionRefused': True}
elif CARD == 'B18':
    def context_hash(context):
        return digest(compact({'version': 1, 'permissionProfile': context['permissionProfile'], 'cwd': context['cwd'], 'projectRoot': context['projectRoot'], 'allowedPaths': context.get('allowedPaths', []), 'processType': context['processType'], 'detach': context.get('detach', False), 'mode': context.get('mode', 'assistant')}))
    sdk = read(BASE / 'sdk-fixture/observations.json'); assert sdk['providerCalls'] == 0 and len(sdk['observations']) == 7
    for row in sdk['observations']:
        cwd = Path(sdk['invocationDir']) / row['name']
        hash_value = context_hash({'permissionProfile': 'full-access', 'cwd': str(cwd), 'projectRoot': str(cwd), 'processType': 'SYNC'})
        trace = cwd / 'trace.txt'; assert (trace.read_text() if trace.exists() else '') == row['trace']
        for approval in row['approvals']:
            assert approval['rawCommand'] == row['command'] and approval['commandHash'] == digest(row['command']) and approval['executionContextHash'] == hash_value
        actual_records = [read(p) for p in sorted((cwd / 'harness').rglob('*.json')) if p.parent.name == 'approvals']
        assert actual_records == row['approvalRecords']
        if row['name'] == 'approval_cancelled': assert row['runOutcome']['termination'] == 'cancelled' and not actual_records and not row['trace']
    launcher = read(BASE / 'launcher-fixture/observations.json')
    assert launcher['providerCalls'] == 0 and len(launcher['observations']) == 13 and len(launcher['parserCorpus']) == 17
    for row in launcher['observations']: assert row['commandSha256'] == digest(row['command']) and row['traceSha256'] == digest(row['trace'])
    for row in launcher['parserCorpus']: assert row['commandSha256'] == digest(row['command']) and (row['bashSyntaxExit'] == 0) == row['syntax']
    corrupt = read(BASE / 'approval-store-observations.json'); assert corrupt['fetchCalls'] == 0 and len(corrupt['observations']) == 4
    for row in corrupt['observations']:
        assert row['wins'] == 0 and len(row['errors']) == 3 and row['noConsumedCorruptRecord']
        assert row['action']['commandHash'] == digest(row['command']) and row['action']['executionContextHash'] == context_hash(row['context'])
        assert sha(row['diagnostic']['quarantinedPath']) == row['corruptBytesSha256'] == row['quarantinedBytesSha256']
    healthy = corrupt['healthy']; assert healthy['mismatchControls'] == 7 and healthy['unchangedBytesAfterMismatch']
    assert healthy['consumed'] == healthy['persisted'] and healthy['persisted']['revision'] == 1 and healthy['persisted']['consumedAt']
    oracle = {'sdkCases': 7, 'launcherCases': 13, 'parserCorpusCases': 17, 'corruptRecordsRefusals': 12, 'healthyMismatchControls': 7, 'cancelledApprovalTraceAndGrant': 0}
else:
    art = read(BASE / 'artifact-fixture/fixture-report.json'); iso = read(BASE / 'isolation-fixture/isolation-report.json')
    assert len(art['population']) == 2 and len({r['runId'] for r in art['population']}) == 2
    for population in art['population']:
        result = read(Path(population['artifactRoot']) / 'FINAL_RESULTS.json')
        runs = [r for agent in result['agents'].values() for r in agent['runs']]
        assert len(runs) == 8 and sum(r['cost'] for r in runs) == 12 and sum(r['runOutcome']['termination'] == 'completed' for r in runs) == 2
        assert result['agents']['agent-a']['measuredRunCount'] == 2 and result['agents']['agent-b']['measuredRunCount'] == 0
        assert len(population['modelAttempts']) == 16 and sum(r['costUsd'] is None for r in population['modelAttempts']) == 8
        assert population['spend']['wholeExperimentCostComplete'] is False
    means = {}
    for side in ['before', 'after']:
        rows = [r for p in sorted((BASE / 'artifact-fixture' / side).glob('*-ANALYSIS.json')) for r in read(p)['results']]
        eligible = [r for r in rows if r['runOutcome']['termination'] == 'completed']
        assert len(rows) == 6 and len(eligible) == 4 and sum(r['cost'] for r in rows) == 14
        means[side] = {agent: sum(r['overallScore'] for r in eligible if r['agentId'] == agent) / 2 for agent in ['repeat-agent', 'zero-agent']}
    assert means == {'before': {'repeat-agent': 8.0, 'zero-agent': 0.0}, 'after': {'repeat-agent': 4.75, 'zero-agent': 0.25}}
    assert len(iso['observations']) == 7
    for row in iso['observations']:
        assert not row['controllerSentinelPresent'] and not row['ambientProviderConfigPresent'] and not row['defaultUserConfigPresent']
        assert row['fetch']['attempted'] == row['fetch']['forwarded'] == 0 and row['eventsReplayed'] > 0
        assert not Path(row['home']).exists() and not Path(row['cwd']).exists()
    assert iso['unavailable']['runOutcome']['termination'] == 'failed' and iso['unavailable']['observations'][1]['fetch']['attempted'] == 0
    assert read(BASE / 'shared-lessons-before.json') == read(BASE / 'shared-lessons-after.json')
    oracle = {'isolatedWorkers': 7, 'populations': 2, 'meansRecomputed': means, 'missingCredentialFetch': 0, 'lessonsUnchanged': True}

result = {'schemaVersion': 1, 'type': 'body-current-independent-inspection', 'nodeId': CARD,
    'reviewer': '/root/b02_runtime_outcomes', 'sourceContractHashes': sources,
    'originalReviewManifest': INPUTS['originalReviewManifest'], 'commandContexts': command_context,
    'testCounts': test_counts, 'independentOracleObservations': oracle, 'allCurrentSourceAndContextBindingsMatch': True,
    'requiredProductReruns': [], 'productCommandsRunByThisInspection': False,
    'inspectedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
(OUT / 'inspection.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'nodeId': CARD, 'inspection': ref(OUT / 'inspection.json'), 'allMatch': True, 'sources': len(sources), 'commands': len(command_context), 'oracle': oracle}))
