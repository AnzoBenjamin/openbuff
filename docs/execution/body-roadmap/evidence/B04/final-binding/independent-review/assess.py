from pathlib import Path
import json, hashlib

OUT = Path(__file__).resolve().parent
rows = json.loads((OUT / 'runtime-observations.json').read_text())
assert len(rows) == 9
by = lambda name: [r for r in rows if r['b04'] == name]
broker = by('broker-real-process')[0]
assert [e['event'] for e in broker['events']] == ['enter', 'exit', 'enter', 'exit']
assert broker['events'][0]['pid'] == broker['events'][1]['pid']
assert broker['events'][2]['pid'] == broker['events'][3]['pid']
assert broker['events'][0]['pid'] != broker['events'][2]['pid']
assert broker['events'][0]['token'] == broker['events'][1]['token']
assert broker['events'][2]['token'] == broker['events'][3]['token']
assert broker['events'][0]['token'] != broker['events'][2]['token']
assert sum(r['applied'] for r in broker['results']) == 1
assert len({r['receipt']['receiptId'] for r in broker['results']}) == 2
crash = by('broker-crash-refusal')[0]
assert crash['beforeHash'] == crash['afterHash']
index = by('index-real-process')
assert len(index) == 2 and {r['initial'] for r in index} == {True, False}
for r in index:
    assert sum(o['result'] for o in r['outputs']) == 1
    assert [o['event'] for o in r['observations']] == ['enter', 'exit', 'enter', 'exit']
    assert r['observations'][0]['pid'] == r['observations'][1]['pid']
    assert r['observations'][2]['pid'] == r['observations'][3]['pid']
    assert r['observations'][0]['pid'] != r['observations'][2]['pid']
    assert hashlib.sha256(r['after'].encode()).hexdigest() == r['actualPublicationToken']
    assert r['actualPublicationToken'] != r['expectedPublicationToken']
    assert (r['expectedPublicationToken'] is None) == r['initial']
    assert json.loads(r['after'])['graph']['nodes']
manager = by('manager-graph-cas-refusal')[0]
assert manager['returned'] is False and manager['beforeToken'] != manager['winnerToken']
snapshot = by('snapshot-cas')
assert len(snapshot) == 2 and {r['withParent'] for r in snapshot} == {True, False}
for r in snapshot:
    assert r['outcome']['status'] == 'error'
    assert 'cannot lock ref' in r['outcome']['message']
    assert r['expected'] != r['winner']
attribution = by('snapshot-attribution')[0]
assert attribution['refused']['status'] == 'skipped'
assert [n['label'] for n in attribution['chain']] == ['turn-B', 'turn-A']
assert len({n['sha'] for n in attribution['chain']}) == 2
real = by('snapshot-real-process')[0]
assert real['refused']['status'] == 'skipped'
assert [n['label'] for n in real['chain']] == ['parent-turn', 'child-turn']
assert len({n['sha'] for n in real['chain']}) == 2
report = {'allPassed': True, 'runtimeRows': 9, 'brokerSingleWinner': True, 'distinctSerializedBrokerOwners': True, 'crashRefusalPreservesBytes': True, 'indexPresentAndAbsentSingleWinner': True, 'recomputedFullIndexByteHashes': 2, 'managerPublicationLoserRefused': True, 'snapshotAbsentAndPresentTipCASRefused': True, 'snapshotAttributionAndRealProcessRetry': True, 'scope': 'Cooperative TypeScript fail-closed ownership plus full-document publication CAS and Git expected-tip CAS; no external-writer fencing, mixed-version or automatic crash-reclamation liveness claim.'}
(OUT / 'assessment.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
