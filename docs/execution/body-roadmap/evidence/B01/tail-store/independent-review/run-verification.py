#!/usr/bin/env python3
import datetime, hashlib, json, pathlib, subprocess, sys, tempfile, time
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[6]
BUN = pathlib.Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(BUN) == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
prior = json.loads((HERE.parent/'manifest.json').read_text())
sources = [entry['path'] for entry in prior['ownedSources'] + prior['sharedSources']]
sources += [str(path.relative_to(ROOT)) for path in [HERE.parent/'fixture.ts', HERE/'producer-fixture.ts', HERE/'quarantine-counterexamples.ts']]
name = sys.argv[1]
if name == 'tests': argv = [str(BUN),'--no-env-file','test','--isolate',*[str(ROOT/entry['path']) for entry in prior['ownedSources'][3:]]]
elif name == 'fixture': argv = [str(BUN),'--no-env-file','run',str(HERE/'producer-fixture.ts')]
elif name == 'counterexamples': argv = [str(BUN),'--no-env-file','run',str(HERE/'quarantine-counterexamples.ts')]
elif name == 'sdk-typecheck':
    argv = [str(BUN),'--no-env-file','run','--cwd',str(ROOT/'sdk'),'typecheck']
    b36=json.loads((ROOT/'docs/execution/body-roadmap/evidence/B36/manifest.json').read_text())['sourceHashes']
    sources=list(dict.fromkeys(sources+list(b36)))
else: raise SystemExit('Unknown command')
with tempfile.TemporaryDirectory(prefix='b01-independent-env-') as temp:
    home = pathlib.Path(temp)/'home'; home.mkdir()
    config = pathlib.Path(temp)/'config'; config.mkdir()
    env = {'PATH':str(BUN.parent)+':/usr/local/bin:/usr/bin:/bin','HOME':str(home),'XDG_CONFIG_HOME':str(config),'TMPDIR':'/tmp','LANG':'C.UTF-8'}
    before = {file:sha(ROOT/file) for file in sources}
    started = datetime.datetime.now(datetime.timezone.utc).isoformat(); start=time.monotonic()
    result = subprocess.run(argv,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    after = {file:sha(ROOT/file) for file in sources}
    (HERE/(name+'.log')).write_bytes(result.stdout)
    (HERE/(name+'.exit')).write_text(str(result.returncode)+'\n')
    receipt = {'schemaVersion':1,'card':'B01-tail-store-independent','command':name,'argv':argv,'cwd':str(ROOT),'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':time.monotonic()-start,'exit':result.returncode,'log':name+'.log','logSha256':sha(HERE/(name+'.log')),'bun':{'executable':str(BUN),'version':subprocess.check_output([str(BUN),'--version'],text=True).strip(),'sha256':sha(BUN)},'environment':{'replacement':True,'keys':sorted(env),'HOME':'ephemeral empty directory','XDG_CONFIG_HOME':'ephemeral empty directory','bunEnvFileLoading':False},'sourceBefore':before,'sourceAfter':after,'sourceUnchangedDuringCommand':before==after,'producerManifestSha256':sha(HERE.parent/'manifest.json')}
    (HERE/(name+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'command':name,'exit':result.returncode,'sourceUnchanged':before==after,'elapsedSeconds':receipt['elapsedSeconds']}))
    print('\n'.join(result.stdout.decode('utf8',errors='replace').splitlines()[-8:]))
    sys.exit(result.returncode)
