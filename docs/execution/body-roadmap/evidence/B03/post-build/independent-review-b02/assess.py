from pathlib import Path
import hashlib, base64, json

OUT = Path(__file__).resolve().parent
ROOT = OUT / 'fixture'
report = json.loads((ROOT / 'mutation-report.json').read_text())
def raw_hash(data): return 'sha256:' + hashlib.sha256(data).hexdigest()
def confirmed(receipt):
    result = []
    for a in receipt['actions']:
        forward = a.get('forward')
        if a['status'] not in ['committed', 'rollback_failed'] or not forward or forward['outcome'] != 'applied': continue
        hashes = forward['afterHashes']
        target = a.get('destinationPath', a['path'])
        if hashes.get(target) != a['afterHash']: continue
        if a['action'] == 'move' and hashes.get(a['path'], 'missing') is not None: continue
        if all(k in receipt['finalHashes'] and receipt['finalHashes'][k] == v for k, v in hashes.items()): result.append(a)
    return result

expected = {'rejected-then-recovered': [0, 1], 'thrown-partial': [0], 'retained-partial-forward': [1], 'successful-edit': [1]}
assert report['fetch'] == {'attempted': 0, 'forwarded': 0}
assert report['fetchGuardControl']['attempted'] == report['fetchGuardControl']['refused'] == 1
assert report['fetchGuardControl']['forwarded'] == 0
assert report['fetchGuardControl']['output']['value']['initiated'] is True
assert report['environment']['credentialNames'] == []
assert not Path(report['environment']['home']).exists()
byte_count = 0
cases = []
for r in report['records']:
    for side in ['before', 'after']:
        for path, b in r[side].items():
            raw = base64.b64decode(b['base64'], validate=True)
            assert raw.decode('utf8') == b['utf8']
            assert raw_hash(raw) == b['hash']
            byte_count += 1
    projections = r['projections']
    counts = []
    confirmed_paths = []
    confirmed_operations = []
    for p in projections:
        mutation = p['mutation']
        receipt = mutation['authorityReceipt']
        assert receipt['operationId'] == mutation['operationId']
        assert receipt['receiptId'] == mutation['receiptId']
        acknowledged = confirmed(receipt)
        counts.append(len(acknowledged))
        assert [a['actionId'] for a in acknowledged] == [a['actionId'] for a in p['confirmed']] == [a['actionId'] for a in p['cliConfirmed']]
        assert p['summary']['filesEdited'] == len(acknowledged)
        if acknowledged:
            confirmed_operations.append(mutation['operationId'])
        for a in acknowledged:
            target = a.get('destinationPath', a['path'])
            assert a['afterHash'] == r['after']['/repo/' + target]['hash']
            confirmed_paths.append(target)
        assert p['headlessAction']['effect']['confirmedPaths'] == [a['path'] for a in acknowledged]
        if not acknowledged:
            assert p['headlessAction']['effect']['status'] != 'confirmed'
            assert p['cliOutcome']['tone'] != 'good'
    assert counts == expected[r['mode']]
    assert [o['operationId'] for o in r['observers']] == confirmed_operations
    assert [a['path'] for o in r['observers'] for a in o['actions']] == confirmed_paths
    journals = list((ROOT / r['mode'] / 'harness').glob('*/workspace-journals/workspace.json'))
    if confirmed_paths:
        assert len(journals) == 1
        journal = json.loads(journals[0].read_text())
        changes = journal['state']['changes']
        assert [c['operationId'] for c in changes] == confirmed_operations
        assert [a['path'] for c in changes for a in c['actions']] == confirmed_paths
    else: assert journals == []
    if r['mode'] == 'rejected-then-recovered':
        refused = projections[0]['mutation']
        assert refused['actions'][0]['forward']['outcome'] == 'not_applied'
        assert refused['authorityReceipt']['finalHashes']['a.txt'] == raw_hash(b'foreign\r\n')
        assert r['after']['/repo/a.txt']['utf8'] == 'recovered\r\n'
        assert r['adapterReturns'][0]['result']['applied'] is False
        assert len(r['adapterReturns']) == 2
        assert projections[1]['mutation']['authorityReceipt']['receiptId'] != refused['receiptId']
    if r['mode'] == 'thrown-partial':
        assert r['after']['/repo/b.txt']['utf8'] == 'partial\n'
        assert projections[0]['mutation']['actions'][0]['forward']['outcome'] == 'unconfirmed'
    if r['mode'] == 'retained-partial-forward':
        assert confirmed_paths == ['a.txt']
        assert r['after']['/repo/b.txt']['utf8'] == 'partial\n'
    cases.append({'mode': r['mode'], 'confirmedCounts': counts, 'observerCount': len(r['observers']), 'confirmedPaths': confirmed_paths, 'journalCount': len(journals), 'runTermination': r['runOutcome']['termination']})
assert confirmed(report['legacyRefusedRollback']['authorityReceipt']) == []
node = json.loads((OUT / 'node-broker-probe.json').read_text())
for side in ['before', 'after']:
    raw = base64.b64decode(node[side]['base64'], validate=True)
    assert raw_hash(raw) == node[side]['hash']
    byte_count += 1
assert base64.b64decode(node['after']['base64']) == b'after\r\nkept\r\n'
assert len(confirmed(node['mutation']['authorityReceipt'])) == 1
assert node['mutation']['actions'][0]['afterHash'] == node['after']['hash']
assert node['adapterReturns'][0]['result']['applied'] is True
assert node['fetchObservation'] == {'attempted': 0, 'forwarded': 0}
assert not Path(node['workspace']).exists()
summary = {'allPassed': True, 'byteRecordsRecomputed': byte_count, 'actualSdkCases': cases, 'actualNodeBrokerConditionalSuccess': {'confirmed': 1, 'exactCRLFPostimage': True}, 'legacyRefusedRollbackConfirmed': 0, 'codingFetchAttempts': 0, 'forwardedFetches': 0, 'positiveFetchRefusal': 1, 'scope': 'Actual source SDK generator/dispatch, controlled filesystem adapters, actual workspace journals, JSON/headless and CLI authority consumers plus ordinary Node cooperative-broker conditional success; no B02 task-acceptance, OS exclusion/crash-reclamation, installed/native or billing claim.'}
(OUT / 'assessment.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
