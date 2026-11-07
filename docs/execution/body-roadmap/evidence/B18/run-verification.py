#!/usr/bin/env python3
"""Run B18 commands under the pinned toolchain with credential-free receipts."""
import datetime, hashlib, json, os, pathlib, platform, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
BUN = pathlib.Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(BUN) == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
sources = [
    'sdk/src/services/harness-enforcement.ts', 'sdk/src/services/local-harness-store.ts',
    'sdk/src/tools/run-terminal-command.ts', 'sdk/src/tools/terminal-command-policy.ts',
    'sdk/src/run.ts', 'sdk/src/__tests__/harness-enforcement.test.ts',
    'sdk/src/__tests__/harness-command-identity.test.ts', 'sdk/src/__tests__/run-terminal-command.test.ts',
    'sdk/src/__tests__/terminal-command-policy.test.ts', 'scripts/body-fixtures/terminal-approval-identity.ts',
    'scripts/body-fixtures/sdk-terminal-approval-identity.ts', 'sdk/src/client.ts', 'sdk/src/run-state.ts',
    'sdk/src/serve/bridge.ts', 'sdk/src/__tests__/serve-approval-bridge.test.ts',
    'packages/agent-runtime/src/tools/tool-executor.ts', 'packages/agent-runtime/src/run-programmatic-step.ts',
    'packages/agent-runtime/src/__tests__/run-programmatic-step.test.ts', 'packages/agent-runtime/src/__tests__/run-agent-step-tools.test.ts',
    'packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts', 'common/src/tools/params/tool/run-terminal-command.ts',
    'packages/agent-runtime/src/tools/handlers/tool/__tests__/run-terminal-command.test.ts',
]
name = sys.argv[1]
cwd = ROOT
if name == 'policy-tests': argv = [str(BUN), '--no-env-file', 'test', '--isolate', *[str(ROOT/file) for file in sources[5:7]]]
elif name == 'terminal-tests': argv = [str(BUN), '--no-env-file', 'test', '--isolate', *[str(ROOT/file) for file in sources[7:9]]]
elif name == 'runtime': argv = [str(BUN), '--no-env-file', 'run', str(ROOT/sources[9]), '--evidence-dir', str(HERE / 'runtime')]
elif name == 'sdk-consumers': argv = [str(BUN), '--no-env-file', 'run', str(ROOT/sources[10]), '--evidence-dir', str(HERE / 'sdk-consumers')]
elif name == 'approval-bridge-tests': argv = [str(BUN), '--no-env-file', 'test', '--isolate', str(ROOT/sources[14])]
elif name == 'runtime-tests': argv = [str(BUN), '--no-env-file', 'test', '--isolate', *[str(ROOT/file) for file in [*sources[17:19], sources[21]]]]
elif name == 'sdk-typecheck':
    cwd = ROOT / 'sdk'
    argv = [str(BUN), '--no-env-file', 'run', 'typecheck']
elif name == 'diff-check': argv = ['git', 'diff', '--check', '--', *sources]
else: raise SystemExit('Unknown command')
config = HERE / 'fixture-config.json'
config.write_text('{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n')
env = {key: os.environ[key] for key in ['HOME','USER','SHELL','TMPDIR','LANG','LC_ALL','TERM'] if key in os.environ}
env.update({'PATH': str(BUN.parent) + ':' + os.environ.get('PATH','/usr/bin:/bin'), 'OPENBUFF_PROVIDER_CONFIG': str(config), 'NEXT_PUBLIC_CB_ENVIRONMENT':'test'})
before = {file: sha(ROOT / file) for file in sources}
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
result = subprocess.run(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
log = result.stdout.decode('utf8', errors='replace')
(HERE / (name + '.log')).write_text(log)
(HERE / (name + '.exit')).write_text(str(result.returncode) + '\n')
after = {file: sha(ROOT / file) for file in sources}
receipt = {
    'schemaVersion':1, 'card':'B18', 'tier':'implementation-author verification; independent acceptance remains pending',
    'command':name, 'argv':argv, 'cwd':str(cwd), 'startedAt':started,
    'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'elapsedSeconds':time.monotonic()-start,
    'exit':result.returncode, 'log':name+'.log', 'logSha256':sha(HERE/(name+'.log')),
    'environment':{'inheritedKeys': sorted(key for key in env if key not in ['PATH','OPENBUFF_PROVIDER_CONFIG','NEXT_PUBLIC_CB_ENVIRONMENT']), 'PATH':'pinned Bun bin prepended to executable search path', 'OPENBUFF_PROVIDER_CONFIG':'fixture-config.json', 'credentials':'not inherited; Bun env-file loading disabled'},
    'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
    'platform':platform.platform(), 'bun':{'path':str(BUN),'sha256':sha(BUN),'version':subprocess.check_output([str(BUN),'--version'],text=True).strip()},
    'sourceBefore':before, 'sourceAfter':after, 'sourceUnchangedDuringCommand':before==after,
    'configHashes':{file:sha(ROOT/file) for file in ['bun.lock','package.json','sdk/package.json','sdk/tsconfig.json','.agents/sessions/body-capability-review-2026-11-05/PLAN.md','.agents/sessions/body-capability-review-2026-11-05/SPEC.md']},
}
(HERE/(name+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'command':name,'exit':result.returncode,'sourceUnchanged':before==after,'elapsedSeconds':receipt['elapsedSeconds']}))
print('\n'.join(log.splitlines()[-8:]))
sys.exit(result.returncode)
