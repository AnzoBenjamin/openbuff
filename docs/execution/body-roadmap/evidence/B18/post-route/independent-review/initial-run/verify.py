"""Reattest B03/B18/B30 after the exact leader-authored B08 route delta."""
from pathlib import Path
import datetime, hashlib, json, os, re, subprocess, sys, time

ROOT = Path(__file__).resolve().parents[7]
CARD = sys.argv[1]
assert CARD in ['B03', 'B18', 'B30']
BASE = ROOT / 'docs/execution/body-roadmap/evidence' / CARD
PRIOR = BASE / 'final-binding/independent-review'
OUT = BASE / 'post-route/independent-review'
OUT.mkdir(parents=True, exist_ok=True)
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
BUN_HASH = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
OLD_LLM_HASH = '62dfe2a16bef79a700d8aafb7d56ca972a7e1707026e6fe92813cf05978b11c0'
NEW_LLM_HASH = '76b1b88454eb1471eeb3a71ae2ec60e97b83603c40799d3ce3cdbc6abe226be5'
REGRESSION = 'sdk/src/__tests__/provider-contract-regressions.test.ts'
REGRESSION_HASH = '904140141f77414577f46b498c71c64dca1c83dfd1a44eb1d559b7c23fde323b'
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(name, value): (OUT / name).write_text(json.dumps(value, indent=2) + '\n')
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
assert sha(BUN) == BUN_HASH

def verify_bound_files(manifest):
    for file, expected in manifest['sourceHashes'].items():
        assert sha(ROOT / file) == expected, 'Current source drift: ' + file
    for row in manifest['preservedArtifacts']:
        assert sha(ROOT / row['file']) == row['sha256'], 'Prior artifact drift: ' + row['file']

if '--check' in sys.argv:
    manifest = json.loads((OUT / 'manifest.json').read_text())
    verify_bound_files(manifest)
    assert manifest['requiredChecksPass'] and not manifest['blockingFindings']
    for file, expected in manifest['artifacts'].items():
        assert sha(OUT / file) == expected, 'New artifact drift: ' + file
    print(json.dumps({'card': CARD, 'allMatch': True, 'manifestSha256': sha(OUT / 'manifest.json'), 'sources': len(manifest['sourceHashes']), 'newArtifacts': len(manifest['artifacts']), 'preservedArtifacts': len(manifest['preservedArtifacts'])}))
    raise SystemExit(0)

if '--finalize' in sys.argv:
    manifest = json.loads((OUT / 'manifest.json').read_text())
    verify_bound_files(manifest)
    write('final-sweep.json', {'finishedUtc': utc(), 'allCurrentSourcesMatch': True, 'allPriorArtifactsPreserved': True, 'commandsAndLogsClosed': True, 'sourceCount': len(manifest['sourceHashes']), 'preservedArtifactCount': len(manifest['preservedArtifacts'])})
    manifest['finalSweepUtc'] = utc()
    manifest['artifacts'] = {str(file.relative_to(OUT)): sha(file) for file in sorted(OUT.rglob('*')) if file.is_file() and file != OUT / 'manifest.json'}
    write('manifest.json', manifest)
    print(json.dumps({'card': CARD, 'manifest': str((OUT / 'manifest.json').relative_to(ROOT)), 'sha256': sha(OUT / 'manifest.json'), 'allMatch': True}))
    raise SystemExit(0)

assert not (OUT / 'manifest.json').exists(), 'Do not overwrite a completed review'
prior = json.loads((PRIOR / 'manifest.json').read_text())
sources = prior.get('sourceHashes') or {row['file']: row['sha256'] for row in prior['currentSources']}
assert sources['sdk/src/impl/llm.ts'] == OLD_LLM_HASH
current = {file: sha(ROOT / file) for file in sources}
deltas = [{'file': file, 'priorHash': expected, 'currentHash': current[file]} for file, expected in sources.items() if current[file] != expected]
assert [row['file'] for row in deltas] == ['sdk/src/impl/llm.ts'], deltas
assert current['sdk/src/impl/llm.ts'] == NEW_LLM_HASH
assert sha(ROOT / REGRESSION) == REGRESSION_HASH
current[REGRESSION] = REGRESSION_HASH

snapshot = ROOT / 'docs/execution/body-roadmap/evidence/B08/source-snapshot/sdk/src/impl/llm.ts.txt'
assert sha(snapshot) == OLD_LLM_HASH
old = snapshot.read_text()
expected = old.replace('    const failoverModel = modelsToTry[failoverIndex]\n    let promptTooLongRetried', '    const failoverModel = modelsToTry[failoverIndex]\n    // Image routing may select a different model. Keep the resolved route\n    // available when this retry loop exits into the failover handler.\n    let attemptModel = failoverModel\n    let promptTooLongRetried')
expected = expected.replace('        let attemptModel = failoverModel\n', '')
expected = expected.replace('              model: failoverModel,\n              loadedConfig,', '              model: attemptModel,\n              loadedConfig,')
expected = expected.replace('                failoverModel,\n                configured.providerId,', '                attemptModel,\n                configured.providerId,')
expected = expected.replace('{ model: failoverModel, band, serializedBytes }', '{ model: attemptModel, band, serializedBytes }')
expected = expected.replace('finishReason,\n            model: failoverModel,', 'finishReason,\n            model: attemptModel,')
expected = expected.replace('fromModel: failoverModel,', 'fromModel: attemptModel,')
expected = expected.replace("status: 'failover',\n        model: failoverModel,", "status: 'failover',\n        model: attemptModel,")
assert (ROOT / 'sdk/src/impl/llm.ts').read_text() == expected, 'Unexpected llm delta'
test_snapshot = ROOT / 'docs/execution/body-roadmap/evidence/B08/source-snapshot' / (REGRESSION + '.txt')
test_old = test_snapshot.read_text(); test_new = (ROOT / REGRESSION).read_text()
start = test_new.index("  test('vision failover retains the actual route in status and analytics'")
end = test_new.index("  test('recursive OAuth refresh", start)
assert test_new[:start] + test_new[end:] == test_old, 'Regression delta is not exactly the added test'
for name, left, right in [('llm-route.diff', snapshot, ROOT / 'sdk/src/impl/llm.ts'), ('provider-regression.diff', test_snapshot, ROOT / REGRESSION)]:
    result = subprocess.run(['diff', '-u', str(left), str(right)], capture_output=True, text=True)
    assert result.returncode == 1
    (OUT / name).write_text(result.stdout)

preserved = {}
def preserve(path, expected_hash=None):
    actual = sha(path)
    if expected_hash: assert actual == expected_hash, 'Historical artifact changed: ' + str(path)
    preserved[str(path.relative_to(ROOT))] = actual
def preserve_manifest(path):
    preserve(path)
    value = json.loads(path.read_text())
    base = path.parent
    for file, digest in value.get('artifacts', {}).items(): preserve(base / file, digest)
    for row in value.get('evidence', []): preserve(base / row['file'], row['sha256'])
    for row in value.get('boundEvidence', []): preserve(base / row['file'], row['sha256'])
preserve_manifest(PRIOR / 'manifest.json')
preserve_manifest(BASE / 'manifest.json')
if (BASE / 'independent-review/manifest.json').is_file(): preserve_manifest(BASE / 'independent-review/manifest.json')
preserve(snapshot); preserve(test_snapshot)
if CARD == 'B18':
    for file, digest in prior['referenceHashes'].items(): preserve(ROOT / file, digest)
write('historical-integrity.json', {'allMatch': True, 'priorManifest': str((PRIOR / 'manifest.json').relative_to(ROOT)), 'priorManifestHash': sha(PRIOR / 'manifest.json'), 'preservedArtifactCount': len(preserved), 'preservedArtifacts': [{'file': file, 'sha256': digest} for file, digest in sorted(preserved.items())]})
write('source-delta.json', {'allOtherPriorBindingsMatch': True, 'changedPriorBindings': deltas, 'addedRegressionBinding': {'file': REGRESSION, 'sha256': REGRESSION_HASH}, 'exactLlmDeltaVerified': True, 'exactAddedTestVerified': True, 'deltaAuthorship': 'Leader-authored B08 route metadata followup; prior B02/B08 fixes were reviewer-authored and receive no new independent prerequisite approval.'})

manifest = {'schemaVersion': 1, 'card': CARD, 'reviewer': '/root/b02_runtime_outcomes', 'startedUtc': utc(), 'status': 'running',
    'independence': 'Reviewer made no B03/B18/B30 implementation/test changes and no changes to the current leader-authored llm.ts route metadata followup or its added regression. Reviewer authored earlier consumed B02/B08 prerequisite fixes; this review grants no independent approval to those earlier changes.',
    'priorReviewManifest': str((PRIOR / 'manifest.json').relative_to(ROOT)), 'priorReviewManifestHash': sha(PRIOR / 'manifest.json'),
    'producerManifest': str((BASE / 'manifest.json').relative_to(ROOT)), 'producerManifestHash': sha(BASE / 'manifest.json'),
    'sourceHashes': current, 'sourceDelta': deltas, 'addedRegression': REGRESSION,
    'preservedArtifacts': [{'file': file, 'sha256': digest} for file, digest in sorted(preserved.items())],
    'bun': {'path': str(BUN), 'version': '1.3.5', 'sha256': BUN_HASH},
    'scope': 'Same bounded card consumer scope as the prior final-binding review; current llm route metadata change only. No prior approved evidence or tier is widened.',
    'base2Scope': prior.get('base2Scope'), 'cardAcceptance': 'leader_owned', 'blockingFindings': []}
write('verification-start.json', manifest)
config = OUT / 'fixture-config.json'; config.write_text('{}\n')
for directory in ['home', 'tmp', 'xdg']: (OUT / directory).mkdir(exist_ok=True)
env = {'PATH': str(BUN.parent) + ':/usr/bin:/bin', 'HOME': str(OUT / 'home'), 'TMPDIR': str(OUT / 'tmp'), 'XDG_CONFIG_HOME': str(OUT / 'xdg'),
    'USER': 'post-route-review', 'OPENBUFF_PROVIDER_CONFIG': str(config), 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
    'NEXT_PUBLIC_CODEBUFF_APP_URL': 'https://fixture.invalid', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test'}
guard = OUT / 'offline-preload.ts'
guard.write_text("import fs from 'node:fs'\nlet refused = 0\nconst log = process.env.POST_ROUTE_FETCH_LOG!\nconst record = (event: string) => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, refused, forwarded: 0 }) + '\\n')\nrecord('guard-installed-before-imports')\nglobalThis.fetch = Object.assign(async () => { refused++; record('external-fetch-refused'); throw new Error('Post-route independent review refuses external fetch') }, { preconnect() {} }) as typeof fetch\nprocess.on('exit', () => record('process-exit'))\n")
copies = []
copy_names = ['assess.py']
if CARD == 'B03': copy_names += ['consumer-probe.ts', 'node-broker-probe.ts']
if CARD == 'B18': copy_names += ['approval-store-probe.ts']
for name in copy_names:
    original = PRIOR / name
    (OUT / name).write_bytes(original.read_bytes())
    copies.append({'source': str(original.relative_to(ROOT)), 'sha256': sha(original), 'copy': name, 'copySha256': sha(OUT / name), 'exactCopy': True})
write('copied-review-probes.json', copies)
prior_commands = prior['commands'] if CARD != 'B18' else [json.loads((PRIOR / row['receipt']).read_text()) for row in prior['commands']]
commands = []
def run(name, argv, cwd=ROOT, preload=False):
    argv = [str(arg).replace(str(PRIOR), str(OUT)) for arg in argv]
    before = {file: sha(ROOT / file) for file in current}
    command_env = dict(env)
    if preload:
        command_env['POST_ROUTE_FETCH_LOG'] = str(OUT / (name + '-fetch.jsonl'))
        index = argv.index('test') + 1
        argv[index:index] = ['--preload', str(guard)]
    started = utc(); timer = time.monotonic()
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(argv, cwd=cwd, env=command_env, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
    after = {file: sha(ROOT / file) for file in current}
    receipt = {'name': name, 'argv': argv, 'cwd': str(cwd), 'startedUtc': started, 'finishedUtc': utc(), 'elapsedSeconds': time.monotonic() - timer, 'exit': result.returncode,
        'log': name + '.log', 'logSha256': sha(OUT / (name + '.log')), 'sourceBefore': before, 'sourceAfter': after, 'sourceUnchanged': before == after == current,
        'environment': {'replacement': True, 'keys': sorted(command_env), 'HOME': command_env['HOME'], 'OPENBUFF_PROVIDER_CONFIG': str(config), 'credentials': 'No inherited credentials; owned home/config/tmp; Bun --no-env-file. Existing actual fixture fetch barriers preserved.'}}
    write(name + '.json', receipt); commands.append({'receipt': name + '.json', 'sha256': sha(OUT / (name + '.json'))})
    print(json.dumps({'card': CARD, 'name': name, 'exit': result.returncode, 'sourceUnchanged': receipt['sourceUnchanged'], 'elapsedSeconds': receipt['elapsedSeconds']}), flush=True)
    assert result.returncode == 0, 'Inspect retained ' + name + '.log'
    assert receipt['sourceUnchanged'], 'Source drift during ' + name
    if preload:
        rows = [json.loads(line) for line in Path(command_env['POST_ROUTE_FETCH_LOG']).read_text().splitlines()]
        assert any(row['event'] == 'guard-installed-before-imports' for row in rows)
        assert all(row['forwarded'] == 0 for row in rows)
        assert not any(row['event'] == 'external-fetch-refused' for row in rows), 'Unexpected real fetch attempt during selected tests'

run('leader-vision-route-regression', [str(BUN), '--no-env-file', 'test', '--isolate', '-t', 'vision failover retains the actual route in status and analytics', str(ROOT / REGRESSION)], preload=True)
reglog = (OUT / 'leader-vision-route-regression.log').read_text()
assert re.search(r'1 pass', reglog) and re.search(r'0 fail', reglog)
lessons = ROOT / 'evals/buffbench/agent-lessons'
def lesson_snapshot(): return {str(file.relative_to(ROOT)): sha(file) for file in sorted(lessons.rglob('*')) if file.is_file()}
if CARD == 'B30':
    lessons_before = lesson_snapshot(); write('shared-lessons-before.json', lessons_before)
for command in prior_commands:
    name = command['name']; argv = command['argv']; cwd = Path(command['cwd'])
    run(name, argv, cwd=cwd, preload='test' in argv)
if CARD == 'B30':
    lessons_after = lesson_snapshot(); write('shared-lessons-after.json', lessons_after)
    assert lessons_before == lessons_after
test_counts = []
for row in commands:
    receipt = json.loads((OUT / row['receipt']).read_text())
    if 'test' not in receipt['argv']: continue
    log = (OUT / receipt['log']).read_text()
    match = re.search(r'(\d+) pass\s*\n\s*(\d+) fail', log)
    assert match and int(match.group(2)) == 0
    test_counts.append({'command': receipt['name'], 'pass': int(match.group(1)), 'fail': int(match.group(2))})
manifest.update({'status': 'verification_complete', 'finishedUtc': utc(), 'recommendation': 'approve ' + CARD + ' current-source reattestation after the exact leader-authored route metadata delta within its prior declared tier only',
    'requiredChecksPass': True, 'commands': commands, 'testCounts': test_counts, 'copiedProbes': copies, 'realProviderRequests': 0,
    'routeRegressionObservation': 'The newly added test drives only owned Response/SSE doubles: vision host three attempts, backup host one, waits 100/200 ms, healthy text, retry model vision/model, failover status and analytics vision/model -> backup/model. This is a focused delta control, not independent approval of earlier reviewer-authored B08 changes.'})
verify_bound_files(manifest)
write('manifest.json', manifest)
print(CARD + ' checks complete; finalize after this process closes.', flush=True)
