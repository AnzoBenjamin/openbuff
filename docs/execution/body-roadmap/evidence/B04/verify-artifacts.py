#!/usr/bin/env python3
import datetime, hashlib, json, pathlib, re
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
CARD=HERE.name
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
commands=['tests','indexer-typecheck','cli-typecheck','diff-check'] if CARD=='B04' else ['tests','fixture','sdk-typecheck','diff-check']
receipts=[json.loads((HERE/(name+'.json')).read_text()) for name in commands]
for receipt in receipts:
 assert receipt['exit']==0, receipt['command']
 assert receipt['sourceUnchangedDuringCommand'], receipt['command']
 assert receipt['logSha256']==sha(HERE/receipt['log'])
 for file,digest in receipt['sourceAfter'].items(): assert sha(ROOT/file)==digest, file
rows=[]
for line in (HERE/'tests.log').read_text().splitlines():
 try: row=json.loads(line)
 except (ValueError,TypeError): continue
 if isinstance(row,dict) and CARD.lower() in row and (CARD=='B04' or row['b36']=='client-multi-call-observed'): rows.append(row)
(HERE/'runtime-observations.json').write_text(json.dumps(rows,indent=2)+'\n')
if CARD=='B04':
 assert len(rows)==9
 broker=next(row for row in rows if row['b04']=='broker-real-process')
 assert [event['event'] for event in broker['events']]==['enter','exit','enter','exit']
 assert sum(result['applied'] for result in broker['results'])==1
 crash=next(row for row in rows if row['b04']=='broker-crash-refusal')
 assert crash['beforeHash']==crash['afterHash']
 for row in [r for r in rows if r['b04']=='index-real-process']:
  assert sum(result['result'] for result in row['outputs'])==1
  assert [event['event'] for event in row['observations']]==['enter','exit','enter','exit']
  assert hashlib.sha256(row['after'].encode()).hexdigest()==row['actualPublicationToken']
 for row in [r for r in rows if r['b04']=='snapshot-cas']: assert row['outcome']['status']=='error'
 real=next(row for row in rows if row['b04']=='snapshot-real-process')
 assert real['refused']['status']=='skipped'
 assert [node['label'] for node in real['chain']]==['parent-turn','child-turn']
 assertions={'actualRuntimeRows':len(rows),'brokerSingleWinner':True,'crashedOwnerPreservesBytes':True,'indexPresentAndAbsentSingleWinner':True,'fullPersistedByteHashesVerified':True,'snapshotCompetingTipRefused':True,'realSnapshotRefusalAndAttributedRetry':True}
else:
 assert len(rows)==6
 expected={'new-error':'new_errors','shifted-error':'passed','failed-baseline':'unavailable','mismatched-files':'unknown','foreign-bytes':'unknown','failed-foreign-baseline':'unknown'}
 for row in rows: assert row['diagnostic']['diagnosticStatus']==expected[row['name']]
 fixture=json.loads((HERE/'sdk-client-observations.json').read_text())
 assert len(fixture['records'])==12
 for row in fixture['records']:
  assert (row['clientClassification']=='passed')==(row['expectedStatus']=='passed')
 severity=next(row for row in fixture['records'] if row['name']=='severity-escalation')
 assert severity['expectedStatus']=='new_errors'
 assert [result.get('exitCode') for result in severity['commandResults']]==[0,101]
 for name in ['timeout','cancelled']:
  row=next(row for row in fixture['records'] if row['name']==name)
  assert all(result['stdoutBytes']>0 for result in row['commandResults'])
 capped=next(row for row in fixture['records'] if row['name']=='capped')
 assert all(result['outputTruncated'] for result in capped['commandResults'])
 assertions={'actualSdkMultiCallRows':len(rows),'realDiagnosticChildCases':len(fixture['records']),'onlyThreeCompleteControlsPass':True,'warningToErrorRejected':True,'timeoutAndCancellationRetainOutput':True,'streamCapReducesAssurance':True}
(HERE/'assertions.json').write_text(json.dumps(assertions,indent=2)+'\n')
counts=re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail', (HERE/'tests.log').read_text())
manifest={'schemaVersion':1,'card':CARD,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'fresh_verification_ready_for_independent_inspection','history':'Former /tmp evidence unavailable after restore; current commands were rerun. Historical acceptance is not modified by this artifact.','testCounts':{'passed':int(counts[1]),'failed':int(counts[2])},'commands':[{'receipt':name+'.json','sha256':sha(HERE/(name+'.json'))} for name in commands],'assertions':assertions,'sourceHashes':receipts[0]['sourceAfter'],'independence':'Verification performed by original implementation author; independent acceptance is a separate leader/reviewer decision.','artifacts':{str(file.relative_to(HERE)):sha(file) for file in sorted(HERE.iterdir()) if file.is_file() and file.name!='manifest.json'}}
if CARD=='B04': manifest['sharedSdkTypecheck']={'receipt':'../B36/sdk-typecheck.json','sha256':sha(HERE.parent/'B36/sdk-typecheck.json')}
(HERE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'card':CARD,'passed':manifest['testCounts']['passed'],'assertions':assertions,'manifest':str(HERE/'manifest.json')}))
