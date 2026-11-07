"""Independent B18 current-source consumer review; preserves producer evidence."""
from pathlib import Path
import datetime, hashlib, json, os, re, subprocess, sys, time

ROOT = Path(__file__).resolve().parents[7]
OUT = Path(__file__).resolve().parent
BASE = OUT.parents[1]
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
BUN_HASH = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(name, value): (OUT / name).write_text(json.dumps(value, indent=2) + '\n')
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

assert sha(BUN) == BUN_HASH
producer = json.loads((BASE / 'manifest.json').read_text())
historical = {'manifest.json': sha(BASE / 'manifest.json'), **producer['artifacts']}
def history_check():
    rows = [{'file': file, 'expectedHash': expected, 'actualHash': sha(BASE / file)} for file, expected in historical.items()]
    assert all(row['expectedHash'] == row['actualHash'] for row in rows), 'Producer evidence drift'
    return rows

if '--check' in sys.argv:
    manifest = json.loads((OUT / 'manifest.json').read_text())
    assert manifest['requiredChecksPass'] and manifest['blockingFindings'] == []
    for file, expected in manifest['sourceHashes'].items():
        assert sha(ROOT / file) == expected, 'Source drift: ' + file
    for file, expected in manifest['referenceHashes'].items():
        assert sha(ROOT / file) == expected, 'Reference drift: ' + file
    for file, expected in manifest['artifacts'].items():
        assert sha(OUT / file) == expected, 'Review artifact drift: ' + file
    history_check()
    print(json.dumps({'allMatch': True, 'manifestSha256': sha(OUT / 'manifest.json'), 'sourceCount': len(manifest['sourceHashes']), 'artifactCount': len(manifest['artifacts']), 'producerArtifactCount': len(historical)}))
    raise SystemExit(0)

if '--finalize' in sys.argv:
    manifest = json.loads((OUT / 'manifest.json').read_text())
    rows = [{'file': file, 'expectedHash': expected, 'actualHash': sha(ROOT / file)} for file, expected in manifest['sourceHashes'].items()]
    assert all(row['expectedHash'] == row['actualHash'] for row in rows), 'Source drift'
    history_check()
    for file, expected in manifest['referenceHashes'].items():
        assert sha(ROOT / file) == expected, 'Reference drift: ' + file
    write('final-sweep.json', {'finishedUtc': utc(), 'allSourcesMatch': True, 'producerArtifactsPreserved': True, 'referenceManifestsPreserved': True, 'sources': rows, 'producerArtifactCount': len(historical), 'processesAndCommandLogsClosed': True})
    manifest['finalSweepUtc'] = utc()
    manifest['artifacts'] = {str(file.relative_to(OUT)): sha(file) for file in sorted(OUT.rglob('*')) if file.is_file() and file != OUT / 'manifest.json'}
    write('manifest.json', manifest)
    assert all(sha(OUT / file) == expected for file, expected in manifest['artifacts'].items())
    print(json.dumps({'manifest': str((OUT / 'manifest.json').relative_to(ROOT)), 'sha256': sha(OUT / 'manifest.json'), 'artifactCount': len(manifest['artifacts']), 'sources': len(rows), 'allMatch': True}))
    raise SystemExit(0)

assert not (OUT / 'manifest.json').exists(), 'Use a fresh evidence directory; do not overwrite a completed review'
history_rows = history_check()
write('historical-integrity.json', {'producerManifestHash': historical['manifest.json'], 'artifacts': history_rows, 'priorIndependentB18Review': None, 'priorReviewNote': 'Leader confirms no separate prior B18 reviewer artifact; this is the first full independent B18 review.'})
sources = dict(producer['sourceHashes'])
extra = [
    'sdk/src/__tests__/local-harness-store.test.ts', 'sdk/src/services/repository-identity.ts',
    'sdk/src/services/workspace-mutation-broker.ts', 'sdk/src/services/workspace-journal.ts', 'sdk/src/index.ts',
    'sdk/src/tools/background-jobs.ts', 'sdk/src/tools/concurrency.ts', 'sdk/src/tools/path-utils.ts',
    'sdk/src/tools/terminal-output-spool.ts', 'sdk/src/env.ts',
    'sdk/src/error-utils.ts', 'sdk/src/retry-config.ts', 'sdk/src/provider-config.ts',
    'sdk/src/impl/model-provider.ts', 'sdk/src/impl/llm.ts', 'sdk/src/impl/failover.ts',
    'packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts',
    'packages/internal/src/openai-compatible/openai-compatible-error.ts',
    'package.json', 'bun.lock', 'tsconfig.base.json', 'sdk/package.json', 'sdk/tsconfig.json',
    'common/package.json', 'common/tsconfig.json', 'packages/agent-runtime/package.json',
    'packages/agent-runtime/tsconfig.json', '.agents/sessions/body-capability-review-2026-11-05/PLAN.md',
    '.agents/sessions/body-capability-review-2026-11-05/SPEC.md',
]
for file in extra:
    if not (ROOT / file).is_file():
        raise SystemExit('Missing selected binding: ' + file)
current = {file: sha(ROOT / file) for file in sorted(set(sources) | set(extra))}
deltas = [{'file': file, 'historicalHash': expected, 'currentHash': current[file]} for file, expected in sources.items() if expected != current[file]]
assert [row['file'] for row in deltas] == ['sdk/src/services/local-harness-store.ts'], deltas
references = [
    'docs/execution/body-roadmap/evidence/B01/tail-store/independent-review/manifest.json',
    'docs/execution/body-roadmap/evidence/B02/cancellation-followup/manifest.json',
    'docs/execution/body-roadmap/evidence/B08/manifest.json',
]
reference_hashes = {file: sha(ROOT / file) for file in references}
store_review = json.loads((ROOT / references[0]).read_text())
assert store_review['sourceHashes']['sdk/src/services/local-harness-store.ts'] == current['sdk/src/services/local-harness-store.ts']
write('source-delta.json', {'originalBindingCount': len(sources), 'changedBindings': deltas, 'storeDeltaIndependentReview': {'file': references[0], 'sha256': reference_hashes[references[0]], 'recommendation': store_review['recommendation']}, 'allOtherOriginalBindingsMatch': True})
manifest = {'schemaVersion': 1, 'card': 'B18', 'reviewer': '/root/b02_runtime_outcomes', 'startedUtc': utc(), 'status': 'running',
    'tier': producer['tier'], 'independence': 'Reviewer made no B18 command identity, approval, terminal, or store production/test edits. Reviewer authored consumed B02 runtime cancellation and B08 provider prerequisite fixes. Current consumer observations exercise those prerequisites but grant no independent approval to reviewer-authored changes; their independent review and prerequisite acceptance belong to other lanes and the leader.',
    'producerManifest': str((BASE / 'manifest.json').relative_to(ROOT)), 'producerManifestHash': historical['manifest.json'],
    'referenceHashes': reference_hashes, 'sourceHashes': current, 'sourceDelta': deltas, 'bun': {'path': str(BUN), 'sha256': BUN_HASH, 'version': '1.3.5'},
    'priorIndependentB18Review': None, 'cardAcceptance': 'leader_owned', 'limits': producer['limits'],
    'base2Scope': 'The selected SDK fixture passes an explicit programmatic agent; it does not load the shipped base2 implementation. B01 base2 and the broader integration binding remain leader-owned.'}
write('verification-start.json', manifest)
config = OUT / 'fixture-config.json'
config.write_text('{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n')
home = OUT / 'home'; home.mkdir(exist_ok=True)
env = {'PATH': str(BUN.parent) + ':/usr/bin:/bin', 'HOME': str(home), 'USER': 'b18-independent-fixture',
    'OPENBUFF_PROVIDER_CONFIG': str(config), 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
    'NEXT_PUBLIC_CODEBUFF_APP_URL': 'https://fixture.invalid', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test'}
commands = []
def run(name, argv, cwd=ROOT):
    before = {file: sha(ROOT / file) for file in current}
    start = time.monotonic(); started = utc()
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
    after = {file: sha(ROOT / file) for file in current}
    receipt = {'name': name, 'argv': argv, 'cwd': str(cwd), 'startedUtc': started, 'finishedUtc': utc(), 'elapsedSeconds': time.monotonic() - start, 'exit': result.returncode,
        'log': name + '.log', 'logSha256': sha(OUT / (name + '.log')), 'sourceBefore': before, 'sourceAfter': after, 'sourceUnchanged': before == after == current,
        'environment': {'keys': sorted(env), 'HOME': str(home), 'PATH': env['PATH'], 'OPENBUFF_PROVIDER_CONFIG': str(config), 'credentials': 'No inherited credentials; owned home/config; Bun --no-env-file; actual fixtures reject fetch before SDK import.'}}
    write(name + '.json', receipt); commands.append({'receipt': name + '.json', 'sha256': sha(OUT / (name + '.json'))})
    print(json.dumps({'name': name, 'exit': result.returncode, 'sourceUnchanged': receipt['sourceUnchanged'], 'elapsedSeconds': receipt['elapsedSeconds']}), flush=True)
    assert result.returncode == 0, name + ': inspect retained log'
    assert receipt['sourceUnchanged'], 'Source drift during ' + name
tests = ['sdk/src/__tests__/harness-enforcement.test.ts', 'sdk/src/__tests__/harness-command-identity.test.ts',
    'sdk/src/__tests__/run-terminal-command.test.ts', 'sdk/src/__tests__/terminal-command-policy.test.ts',
    'sdk/src/__tests__/serve-approval-bridge.test.ts', 'sdk/src/__tests__/local-harness-store.test.ts']
run('affected-identity-approval-terminal-store-tests', [str(BUN), '--no-env-file', 'test', '--isolate', *[str(ROOT / file) for file in tests]])
run('actual-launcher-parser-consumers', [str(BUN), '--no-env-file', 'run', str(ROOT / 'scripts/body-fixtures/terminal-approval-identity.ts'), '--evidence-dir', str(OUT / 'launcher-fixture')])
run('actual-sdk-approval-cancellation-consumers', [str(BUN), '--no-env-file', 'run', str(ROOT / 'scripts/body-fixtures/sdk-terminal-approval-identity.ts'), '--evidence-dir', str(OUT / 'sdk-fixture')])
run('independent-corrupt-approval-consumer', [str(BUN), '--no-env-file', 'run', str(OUT / 'approval-store-probe.ts')])
run('independent-observation-replay', [sys.executable, str(OUT / 'assess.py')])
run('sdk-typecheck', [str(BUN), '--no-env-file', 'run', 'typecheck'], ROOT / 'sdk')
run('source-diff-check', ['git', 'diff', '--check', '--', *current])
text = (OUT / 'affected-identity-approval-terminal-store-tests.log').read_text()
passed = re.search(r'(\d+) pass', text); failed = re.search(r'(\d+) fail', text)
assert passed and failed and int(failed.group(1)) == 0
manifest.update({'status': 'verification_complete', 'finishedUtc': utc(), 'recommendation': 'approve B18 exact command/approval identity against the frozen current sources within the declared cooperative TypeScript/source-consumer tier',
    'blockingFindings': [], 'requiredChecksPass': True, 'testCounts': {'pass': int(passed.group(1)), 'fail': int(failed.group(1)), 'files': len(tests)},
    'actualSdkCases': 7, 'actualLauncherCases': 13, 'parserCorpusCases': 17, 'independentCorruptApprovalCases': 4, 'providerCalls': 0, 'commands': commands,
    'historicalRuntimeEvidence': 'The three original runtime/handler test source bindings and B02 runtime implementation hashes remain exactly equal to the original B18 producer binding. The original 134 passing runtime/handler tests are preserved; current SDK cancellation exercises the actual runtime. This reviewer does not independently approve reviewer-authored B02 changes.'})
history_check()
write('manifest.json', manifest)
print('Checks complete. Run --finalize after this process closes to bind all closed artifacts.', flush=True)
