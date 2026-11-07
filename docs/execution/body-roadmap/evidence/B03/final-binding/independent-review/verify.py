"""Reattest unchanged card implementations against current consumed shared source."""
from pathlib import Path
import hashlib, json, os, re, subprocess, sys, datetime

ROOT = Path(__file__).resolve().parents[7]
CARD = sys.argv[1]
BASE = ROOT / 'docs/execution/body-roadmap/evidence' / CARD
OUT = BASE / 'final-binding/independent-review'
OUT.mkdir(parents=True, exist_ok=True)
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
EXPECTED_BUN = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(name, value): (OUT / name).write_text(json.dumps(value, indent=2) + '\n')
assert sha(BUN) == EXPECTED_BUN
producer = json.loads((BASE / 'manifest.json').read_text())
prior = json.loads((BASE / 'independent-review/manifest.json').read_text())
owned = producer.get('files') or [{'file': f, 'candidateHash': h} for f, h in producer['sourceHashes'].items()]
owned_rows = []
for row in owned:
    current = sha(ROOT / row['file'])
    changed = current != row['candidateHash']
    allowed = CARD == 'B30' and row['file'] == 'scripts/body-fixtures/evaluator-isolation.ts'
    assert not changed or allowed, 'Owned implementation drift: ' + row['file']
    owned_rows.append({'file': row['file'], 'historicalHash': row['candidateHash'], 'currentHash': current, 'changed': changed})
if CARD == 'B30':
    old = (BASE / 'independent-review/source-snapshot/scripts/body-fixtures/evaluator-isolation.ts').read_text()
    current = (ROOT / 'scripts/body-fixtures/evaluator-isolation.ts').read_text()
    assert current == old.replace('const expectedMissingCredential = `Missing environment variable', 'const expectedMissingCredential = `Agent run error: Missing environment variable')
    (OUT / 'oracle-change.diff').write_text(subprocess.run(['diff', '-u', str(BASE / 'independent-review/source-snapshot/scripts/body-fixtures/evaluator-isolation.ts'), str(ROOT / 'scripts/body-fixtures/evaluator-isolation.ts')], capture_output=True, text=True).stdout)
historical_artifacts = []
entries = producer.get('boundEvidence') or [{'file': f, 'sha256': h} for f, h in producer.get('artifacts', {}).items()]
for row in entries:
    actual = sha(BASE / row['file'])
    assert actual == row['sha256'], 'Historical artifact changed: ' + row['file']
    historical_artifacts.append({'file': row['file'], 'sha256': actual})
write('historical-integrity.json', {'producerManifestHash': sha(BASE / 'manifest.json'), 'priorReviewManifestHash': sha(BASE / 'independent-review/manifest.json'), 'owned': owned_rows, 'artifacts': historical_artifacts})
shared = {row['file'] for key in ['sharedSource', 'config', 'configsAndDependencies'] for row in producer.get(key, [])}
if CARD in ['B03', 'B30']:
    shared.update([
        'sdk/src/run.ts', 'sdk/src/run-state.ts', 'sdk/src/client.ts', 'sdk/src/index.ts', 'sdk/src/serve/bridge.ts',
        'sdk/src/tools/run-terminal-command.ts', 'sdk/src/services/harness-enforcement.ts',
        'packages/agent-runtime/src/run-programmatic-step.ts', 'packages/agent-runtime/src/tools/tool-executor.ts',
        'sdk/src/error-utils.ts', 'sdk/src/retry-config.ts', 'sdk/src/provider-config.ts',
        'sdk/src/impl/model-provider.ts', 'sdk/src/impl/llm.ts', 'sdk/src/impl/failover.ts',
        'packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts',
        'packages/internal/src/openai-compatible/openai-compatible-error.ts',
    ])
else:
    # These direct cooperative broker/index/snapshot consumers do not load SDK LLM/runtime dispatch.
    shared.update(['sdk/src/services/repository-identity.ts', 'cli/src/project-files.ts', 'cli/src/utils/env.ts', 'cli/src/utils/logger.ts'])
shared.update(['package.json', 'bun.lock', 'tsconfig.base.json', 'sdk/package.json', 'sdk/tsconfig.json',
               'common/package.json', 'common/tsconfig.json', 'packages/agent-runtime/package.json',
               'packages/agent-runtime/tsconfig.json', '.agents/sessions/body-capability-review-2026-11-05/PLAN.md',
               '.agents/sessions/body-capability-review-2026-11-05/SPEC.md'])
source_files = sorted({row['file'] for row in owned_rows} | shared)
sources = [{'file': f, 'sha256': sha(ROOT / f)} for f in source_files]
manifest = {'card': CARD, 'reviewer': '/root/b02_runtime_outcomes', 'status': 'running',
            'independence': 'No B03/B04/B30 production or test implementation edits by this reviewer. Reviewer authored consumed B08 provider and B02 cancellation prerequisite fixes; this reattestation grants no independent approval to those prerequisite changes.',
            'producerManifest': str((BASE / 'manifest.json').relative_to(ROOT)), 'producerManifestHash': sha(BASE / 'manifest.json'),
            'priorReviewManifest': str((BASE / 'independent-review/manifest.json').relative_to(ROOT)), 'priorReviewManifestHash': sha(BASE / 'independent-review/manifest.json'),
            'ownedSources': owned_rows, 'currentSources': sources, 'bunPath': str(BUN), 'bunHash': sha(BUN),
            'base2Scope': 'No selected consumer loads the shipped base2 implementation. B01 is excluded; the leader owns the broader integration binding.'}
write('verification-start.json', manifest)
config = OUT / 'fixture-config.json'
config.write_text('{}\n')
home = OUT / 'home'; home.mkdir(exist_ok=True)
env = {'PATH': str(BUN.parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home), 'USER': 'review-fixture',
       'OPENBUFF_PROVIDER_CONFIG': str(config), 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
       'NEXT_PUBLIC_CODEBUFF_APP_URL': 'https://fixture.invalid', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test'}
commands = []
def run(name, args):
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
    commands.append({'name': name, 'argv': args, 'cwd': str(ROOT), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': result.returncode, 'log': name + '.log', 'envKeys': sorted(env)})
    write('commands.json', commands)
    print(CARD, name, result.returncode, flush=True)
    assert result.returncode == 0, name
def tests(name, files, preload=None):
    args = [str(BUN), '--no-env-file', 'test']
    if preload: args += ['--preload', str(ROOT / preload)]
    run(name, args + ['--isolate', *[str(ROOT / f) for f in files]])
def copy_probe(name):
    original = BASE / 'independent-review' / name
    text = original.read_text().replace("'../../../../../..'", "'../../../../../../..'")
    if name == 'consumer-probe.ts':
        text = text.replace("const root = path.resolve", "globalThis.fetch = Object.assign(async () => { throw new Error('Independent current-source probe refuses fetch') }, globalThis.fetch)\nconst root = path.resolve")
    (OUT / name).write_text(text)
    return {'original': str(original.relative_to(ROOT)), 'originalHash': sha(original), 'copy': name, 'copyHash': sha(OUT / name)}
copied = []
if CARD == 'B03':
    tests('affected-runtime-acp-tests', ['sdk/src/__tests__/run-mutation-dispatch.test.ts', 'packages/agent-runtime/src/__tests__/tool-validation-error.test.ts', 'sdk/src/serve/__tests__/event-bridge.test.ts', 'sdk/src/__tests__/acp-outcomes.test.ts', 'sdk/src/__tests__/serve-bridge.test.ts'])
    run('actual-sdk-fixture', [str(BUN), '--no-env-file', str(ROOT / 'test/fixtures/body/mutation-evidence.ts'), str(OUT / 'fixture')])
    for probe in ['consumer-probe.ts', 'node-broker-probe.ts']:
        copied.append(copy_probe(probe))
        run(probe.removesuffix('.ts'), [str(BUN), '--no-env-file', str(OUT / probe)])
    (OUT / 'assess.py').write_bytes((BASE / 'independent-review/assess.py').read_bytes())
    run('byte-observer-replay', [sys.executable, str(OUT / 'assess.py')])
elif CARD == 'B04':
    selected = next(c['argv'] for c in prior['commands'] if c['name'] == 'tests')
    tests('cooperative-cas-tests', [f for f in selected if f.endswith('.test.ts')])
    rows = []
    for line in (OUT / 'cooperative-cas-tests.log').read_text().splitlines():
        try: row = json.loads(line)
        except ValueError: continue
        if isinstance(row, dict) and 'b04' in row: rows.append(row)
    write('runtime-observations.json', rows)
    (OUT / 'assess.py').write_bytes((BASE / 'independent-review/assess.py').read_bytes())
    run('cooperative-cas-replay', [sys.executable, str(OUT / 'assess.py')])
else:
    lessons = ROOT / 'evals/buffbench/agent-lessons'
    snapshot = lambda: {str(f.relative_to(ROOT)): sha(f) for f in sorted(lessons.rglob('*')) if f.is_file()}
    before = snapshot(); write('shared-lessons-before.json', before)
    tests('affected-evaluator-consumers', ['evals/buffbench/__tests__/agent-runner.test.ts', 'evals/buffbench/__tests__/isolated-sdk-client.test.ts', 'sdk/src/__tests__/terminal-environment.test.ts'])
    run('actual-isolated-sdk', [str(BUN), '--no-env-file', str(ROOT / 'scripts/body-fixtures/evaluator-isolation.ts'), str(OUT / 'isolation-fixture')])
    run('actual-evaluation-artifacts', [str(BUN), '--no-env-file', str(ROOT / 'test/fixtures/body/evaluation-artifacts.ts'), str(OUT / 'artifact-fixture')])
    (OUT / 'assess.py').write_bytes((BASE / 'independent-review/assess.py').read_bytes())
    run('artifact-isolation-replay', [sys.executable, str(OUT / 'assess.py')])
    after = snapshot(); write('shared-lessons-after.json', after)
    assert before == after
checks = [dict(row, actualHash=sha(ROOT / row['file'])) for row in sources]
stable = all(row['sha256'] == row['actualHash'] for row in checks)
write('source-stability.json', {'allMatch': stable, 'sources': checks, 'historicalProducerManifestUnchanged': sha(BASE / 'manifest.json') == manifest['producerManifestHash'], 'priorReviewManifestUnchanged': sha(BASE / 'independent-review/manifest.json') == manifest['priorReviewManifestHash']})
assert stable, 'Concurrent source drift requires a new current binding'
manifest.update({'status': 'verification_complete', 'verdict': 'approve current-source reattestation of ' + CARD + ' within its prior declared tier only', 'commands': commands, 'copiedReviewProbes': copied, 'requiredChecksPass': True})
manifest['evidence'] = [{'file': str(f.relative_to(OUT)), 'sha256': sha(f)} for f in sorted(OUT.rglob('*')) if f.is_file() and f.name != 'manifest.json']
write('manifest.json', manifest)
print(CARD, 'current-source independent reattestation checks passed', flush=True)
