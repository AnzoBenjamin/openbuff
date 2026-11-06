#!/usr/bin/env python3
"""Reproducible, credential-free fresh verification; writes evidence only."""
import datetime, hashlib, json, os, pathlib, platform, subprocess, sys, time
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
CARD = HERE.name
BUN = pathlib.Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
EXPECTED_BUN_SHA = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(BUN) == EXPECTED_BUN_SHA, 'Pinned executable mismatch'
b04 = ['sdk/src/services/workspace-mutation-broker.ts','sdk/src/__tests__/workspace-mutation-broker.test.ts','packages/indexer/src/index-store.ts','packages/indexer/src/index-store.test.ts','packages/indexer/src/index-manager.ts','packages/indexer/src/index-manager.test.ts','cli/src/utils/turn-snapshots.ts','cli/src/utils/__tests__/turn-snapshots.test.ts']
b36 = ['sdk/src/services/diagnostic-delta.ts','sdk/src/services/diagnostic-delta-runner.ts','sdk/src/tools/file-change-hooks.ts','sdk/src/tools/language-diagnostics.ts','sdk/src/__tests__/diagnostic-delta.test.ts','sdk/src/__tests__/file-change-hooks.test.ts','sdk/src/__tests__/language-diagnostics.test.ts','sdk/src/__tests__/run-mutation-dispatch.test.ts','scripts/body-fixtures/diagnostic-outcomes.ts']
sources = b04 if CARD == 'B04' else b36
consumed = ['packages/indexer/src/index-manager-semantic.test.ts'] if CARD == 'B04' else ['sdk/src/run.ts','sdk/src/services/diagnostic-baseline.ts','sdk/src/tools/node-filesystem.ts','sdk/src/__tests__/node-filesystem.test.ts','common/src/tools/params/tool/run-file-change-hooks.ts','cli/src/utils/output-outcome.ts']
configs = ['bun.lock','package.json','sdk/package.json','sdk/tsconfig.json','cli/package.json','packages/indexer/package.json','.agents/sessions/body-capability-review-2026-11-05/PLAN.md','.agents/sessions/body-capability-review-2026-11-05/SPEC.md','.omx/context/openbuff-body-execution-20261106T102953Z.md']
name = sys.argv[1]
cwd = ROOT
if name == 'tests':
 tests = [b04[i] for i in [1,3,5,7]] + ['packages/indexer/src/index-manager-semantic.test.ts'] if CARD == 'B04' else b36[4:8]+['sdk/src/__tests__/node-filesystem.test.ts']
 argv=[str(BUN),'test','--isolate',*tests]
elif name == 'fixture' and CARD == 'B36': argv=[str(BUN),'scripts/body-fixtures/diagnostic-outcomes.ts',str(HERE/'sdk-client-observations.json')]
elif name.endswith('-typecheck'):
 package = {'sdk':'sdk','cli':'cli','indexer':'packages/indexer'}[name.removesuffix('-typecheck')]
 cwd=ROOT/package
 argv=[str(BUN),'run','typecheck']
elif name == 'diff-check': argv=['git','diff','--check','--',*sources]
else: raise SystemExit('Unknown verification command')
config=HERE/'fixture-config.json'
config.write_text('{}\n')
env={key:os.environ[key] for key in ['HOME','USER','SHELL','TMPDIR','LANG','LC_ALL','TERM'] if key in os.environ}
env.update({'PATH':str(BUN.parent)+':'+os.environ.get('PATH','/usr/bin:/bin'),'OPENBUFF_PROVIDER_CONFIG':str(config),'NEXT_PUBLIC_CB_ENVIRONMENT':'test'})
before={file:sha(ROOT/file) for file in sources+consumed}
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
t0=time.monotonic()
result=subprocess.run(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
finished=datetime.datetime.now(datetime.timezone.utc).isoformat()
text=result.stdout.decode('utf8',errors='replace')
(HERE/(name+'.log')).write_text(text)
(HERE/(name+'.exit')).write_text(str(result.returncode)+'\n')
after={file:sha(ROOT/file) for file in sources+consumed}
receipt={'schemaVersion':1,'card':CARD,'command':name,'argv':argv,'cwd':str(cwd),'startedAt':started,'finishedAt':finished,'elapsedSeconds':time.monotonic()-t0,'exit':result.returncode,'log':name+'.log','logSha256':sha(HERE/(name+'.log')),'environment':{'inheritedKeys':sorted(k for k in env if k not in ['PATH','OPENBUFF_PROVIDER_CONFIG','NEXT_PUBLIC_CB_ENVIRONMENT']),'PATH':'pinned Bun bin prepended to inherited executable search path','OPENBUFF_PROVIDER_CONFIG':'fixture-config.json','NEXT_PUBLIC_CB_ENVIRONMENT':'test','credentials':'not inherited'},'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'platform':platform.platform(),'bun':{'path':str(BUN),'version':subprocess.check_output([str(BUN),'--version'],text=True).strip(),'sha256':sha(BUN)},'sourceBefore':before,'sourceAfter':after,'sourceUnchangedDuringCommand':before==after,'configHashes':{file:sha(ROOT/file) for file in configs}}
(HERE/(name+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'card':CARD,'command':name,'exit':result.returncode,'elapsedSeconds':receipt['elapsedSeconds'],'sourceUnchanged':before==after,'log':str(HERE/(name+'.log'))}))
print('\n'.join(text.splitlines()[-8:]))
sys.exit(result.returncode)
