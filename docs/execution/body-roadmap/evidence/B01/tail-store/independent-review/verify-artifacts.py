#!/usr/bin/env python3
import datetime, hashlib, json, pathlib, re
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[6]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
prior=json.loads((HERE.parent/'manifest.json').read_text())
for entry in prior['artifacts']:assert sha(ROOT/entry['path'])==entry['sha256'],entry['path']
source={}
names=['tests','fixture','counterexamples']
for name in names:
    receipt=json.loads((HERE/(name+'.json')).read_text())
    assert receipt['exit']==0 and receipt['sourceUnchangedDuringCommand'],name
    assert sha(HERE/receipt['log'])==receipt['logSha256'],name
    for file,digest in receipt['sourceAfter'].items():
        assert sha(ROOT/file)==digest,file
        source[file]=digest
shared=HERE/'sdk-typecheck.json'
tsc=json.loads(shared.read_text())
assert tsc['exit']==0 and tsc['sourceUnchangedDuringCommand']
assert sha(shared.parent/tsc['log'])==tsc['logSha256']
for entry in prior['ownedSources']+prior['sharedSources']:assert tsc['sourceAfter'][entry['path']]==source[entry['path']],entry['path']
fixture=json.loads((HERE/'fixture-report.json').read_text())
assert fixture['allAssertionsPassed'] and len(fixture['cases'])==5 and fixture['codingFetch']=={'attempted':0,'forwarded':0}
probe=json.loads((HERE/'quarantine-observations.json').read_text())
assert len(probe['observations'])==2 and probe['fetchCalls']==0
for row in probe['observations']:
    assert len(row['after']['diagnostics'])==1 and 'error' in row['directRead']
    assert 'errorMessage' in row['bundle']['value'] and row['rawBytes']=='{broken'
counts=re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail',(HERE/'tests.log').read_text())
delta=[{'path':entry['path'],'previous':entry['sha256'],'current':source[entry['path']]} for entry in prior['ownedSources']+prior['sharedSources'] if source[entry['path']]!=entry['sha256']]
manifest={'schemaVersion':1,'card':'B01-tail-store-subset','reviewedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reviewer':'B04/B36/B18 implementation worker, independent of B01 tail/store authorship; evidence-only review','recommendation':'approve_bounded_tail_identity_and_quarantine_subset','cardAcceptance':'leader_owned_not_all_B01','blockingFindings':[],'resolvedFinding':'A valid .tmp. record id lost quarantine evidence after sidecar loss; initial counterexample preserved and final fresh probe requires unavailable evidence for both ids.','producerManifestSha256':sha(HERE.parent/'manifest.json'),'producerArtifactsPreserved':True,'originalProducerTypecheckExit':2,'sourceDelta':delta,'sourceHashes':source,'freshTests':{'passed':int(counts[1]),'failed':int(counts[2])},'realProducerCases':5,'independentCounterexamples':2,'sharedCurrentSdkTypecheck':{'path':str(shared.relative_to(ROOT)),'sha256':sha(shared)},'commands':[{'receipt':name+'.json','sha256':sha(HERE/(name+'.json'))} for name in names],'artifacts':{str(file.relative_to(HERE)):sha(file) for file in sorted(HERE.rglob('*')) if file.is_file() and file.name!='manifest.json'},'limits':['Tail identity and quarantine subset only; not B01 gate/specialist acceptance.','Metadata checks detect observed drift, not an atomic OS snapshot or filesystem fence.','Direct child signalling and bounded presentation do not prove universal descendant settlement.','No provider execution, native authority or installed-package claim.']}
(HERE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'tests':manifest['freshTests'],'fixtureCases':5,'counterexamples':2,'sourceDelta':[entry['path'] for entry in delta],'recommendation':manifest['recommendation']}))
