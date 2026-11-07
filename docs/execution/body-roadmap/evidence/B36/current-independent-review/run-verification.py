#!/usr/bin/env python3
"""Refresh changed integration bindings without modifying prior review artifacts."""
import datetime, hashlib, json, pathlib, subprocess, sys, tempfile, time
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]
CARD = HERE.parent.name
BUN = pathlib.Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(BUN) == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
evidence = HERE.parent.parent
prior = json.loads((HERE.parent/('independent-review/manifest.json' if CARD == 'B02' else 'manifest.json')).read_text())
sources = list(prior['sourceHashes'])
name = sys.argv[1]
if name == 'integration-tests': argv=[str(BUN),'--no-env-file','test','--isolate',str(ROOT/'sdk/src/__tests__/run-mutation-dispatch.test.ts')]
elif name == 'fixture': argv=[str(BUN),'--no-env-file',str(ROOT/'scripts/body-fixtures/diagnostic-outcomes.ts'),str(HERE/'sdk-client-observations.json')]
elif name == 'sdk-typecheck': argv=[str(BUN),'--no-env-file','run','--cwd',str(ROOT/'sdk'),'typecheck']
else: raise SystemExit('Unknown B36 verification command')
with tempfile.TemporaryDirectory(prefix='b36-current-reattest-') as temp:
    home=pathlib.Path(temp)/'home'; home.mkdir()
    config=pathlib.Path(temp)/'config'; config.mkdir()
    provider=HERE/'fixture-config.json'; provider.write_text('{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n')
    env={'PATH':str(BUN.parent)+':/usr/local/bin:/usr/bin:/bin','HOME':str(home),'XDG_CONFIG_HOME':str(config),'TMPDIR':'/tmp','LANG':'C.UTF-8','OPENBUFF_PROVIDER_CONFIG':str(provider),'NEXT_PUBLIC_CB_ENVIRONMENT':'test'}
    before={file:sha(ROOT/file) for file in sources}
    started=datetime.datetime.now(datetime.timezone.utc).isoformat(); start=time.monotonic()
    result=subprocess.run(argv,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    after={file:sha(ROOT/file) for file in sources}
    (HERE/(name+'.log')).write_bytes(result.stdout)
    (HERE/(name+'.exit')).write_text(str(result.returncode)+'\n')
    receipt={'schemaVersion':1,'card':CARD,'purpose':'Current B36 integration rerun; original author affiliation disclosed; original independent approval preserved','command':name,'argv':argv,'cwd':str(ROOT),'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':time.monotonic()-start,'exit':result.returncode,'log':name+'.log','logSha256':sha(HERE/(name+'.log')),'bun':{'path':str(BUN),'version':subprocess.check_output([str(BUN),'--version'],text=True).strip(),'sha256':sha(BUN)},'environment':{'replacement':True,'keys':sorted(env),'HOME':'owned ephemeral empty directory','XDG_CONFIG_HOME':'owned ephemeral empty directory','providerConfig':'owned empty providers','bunEnvFileLoading':False},'sourceBefore':before,'sourceAfter':after,'sourceUnchangedDuringCommand':before==after}
    (HERE/(name+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'card':CARD,'command':name,'exit':result.returncode,'sourceUnchanged':before==after,'elapsedSeconds':receipt['elapsedSeconds']}))
    print('\n'.join(result.stdout.decode('utf8',errors='replace').splitlines()[-8:]))
    sys.exit(result.returncode)
