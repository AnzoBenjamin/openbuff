"""Independent deterministic B30 controls. No inherited process environment."""
from pathlib import Path
import datetime
import hashlib
import json
import re
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir())
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
BUN_HASH = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    return {'path': str(Path(path).relative_to(ROOT)), 'sha256': sha(path)}

assert sha(BUN) == BUN_HASH
assert not (OUT / 'run-results.json').exists(), 'Preserve closed commands'
declared = json.loads((OUT / 'source-inputs.json').read_text())['sourceContractHashes']
# Capture all relevant workspace source/type/test dependency context, beyond the
# original review's contract map. Do not traverse user configs or credentials.
files = []

def snapshot():
    return {file: sha(ROOT / file) for file in sorted(files)}

assert all(sha(ROOT / file) == digest for file, digest in declared.items())

def shared_lessons():
    result = {}
    for folder in [ROOT / 'evals/buffbench/lessons', ROOT / 'evals/buffbench/agent-lessons']:
        if folder.exists():
            for file in folder.rglob('*'):
                if file.is_file():
                    result[str(file.relative_to(ROOT))] = sha(file)
    return result

before_lessons = shared_lessons()
(OUT / 'shared-lessons-before.json').write_text(json.dumps(before_lessons, indent=2) + '\n')
preload = [str(BUN), '--no-env-file', '--preload', str(OUT / 'offline-preload.ts')]
tests = [str(BUN), '--no-env-file', 'test', '--preload', str(OUT / 'offline-test-preload.ts'), '--isolate']
discovery = subprocess.run(
    ['/usr/bin/find', str(ROOT / 'evals'), '-type', 'd', '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', 'dist', ')', '-prune', '-o', '-type', 'f', '(', '-name', '*.test.ts', '-o', '-name', '*.test.tsx', ')', '!', '-name', '*.integration.test.ts', '-print'],
    check=True, stdout=subprocess.PIPE, env={'PATH': '/usr/bin:/bin'},
)
eval_tests = sorted(discovery.stdout.decode().splitlines())
(OUT / 'eval-test-discovery.json').write_text(json.dumps({'argv': discovery.args, 'files': eval_tests}, indent=2) + '\n')
commands = [
    ('affected-evaluator-consumers', tests + [str(ROOT / path) for path in ['evals/buffbench/__tests__/agent-runner.test.ts', 'evals/buffbench/__tests__/isolated-sdk-client.test.ts', 'evals/buffbench/__tests__/evaluation-artifacts.test.ts', 'sdk/src/__tests__/terminal-environment.test.ts']], 34),
    ('comparison-consumer-regressions', tests + [str(ROOT / path) for path in ['evals/buffbench/__tests__/statistics.test.ts', 'evals/buffbench/__tests__/run-buffbench.test.ts', 'scripts/__tests__/compare-buffbench-runs.test.ts']], 73),
    ('full-evals-ci', tests + eval_tests, 365),
    ('leader-vision-route-regression', tests + ['-t', 'vision failover retains the actual route in status and analytics', str(ROOT / 'sdk/src/__tests__/provider-contract-regressions.test.ts')], 1),
    ('actual-isolated-sdk', preload + [str(ROOT / 'scripts/body-fixtures/evaluator-isolation.ts'), str(OUT / 'isolation-fixture')], None),
    ('actual-evaluation-artifacts', preload + [str(ROOT / 'test/fixtures/body/evaluation-artifacts.ts'), str(OUT / 'artifact-fixture')], None),
    ('comparison-boundary-probe', preload + [str(OUT / 'comparison-boundary-probe.ts')], None),
    ('artifact-isolation-replay', ['/usr/bin/python3', str(OUT / 'assess.py')], None),
]
import importlib.util
scope_spec = importlib.util.spec_from_file_location('bounded_dependency_scope', OUT / 'dependency-scope.py')
scope_module = importlib.util.module_from_spec(scope_spec)
scope_spec.loader.exec_module(scope_module)
argv_roots = [str(Path(arg).relative_to(ROOT)) for _, argv, _ in commands for arg in argv if Path(arg).is_absolute() and Path(arg).is_relative_to(ROOT) and Path(arg).is_file()]
argv_roots.append('evals/buffbench/isolated-sdk-worker.ts')
files = scope_module.build_scope(ROOT, OUT, declared, argv_roots)
files.append(str((OUT / 'dependency-scope.json').relative_to(ROOT)))
receipts = []
for name, argv, expected_count in commands:
    assert not (OUT / (name + '.command.json')).exists()
    with tempfile.TemporaryDirectory(prefix='b30-independent-' + name + '-') as owned:
        home = Path(owned) / 'home'
        home.mkdir()
        xdg = Path(owned) / 'xdg'
        xdg.mkdir()
        env = {
            'PATH': str(BUN.parent) + ':/usr/local/bin:/usr/bin:/bin',
            'HOME': str(home), 'USERPROFILE': str(home),
            'XDG_CONFIG_HOME': str(xdg), 'XDG_CACHE_HOME': str(Path(owned) / 'cache'),
            'XDG_DATA_HOME': str(Path(owned) / 'data'), 'TMPDIR': owned,
            'LANG': 'C.UTF-8', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test',
            'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
            'BUN_OPTIONS': '--no-env-file',
            'OPENBUFF_PROVIDER_CONFIG': str(OUT / 'provider-config.json'),
            'B30_INDEPENDENT_FETCH_LOG': str(OUT / (name + '-fetch.jsonl')),
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig'),
        }
        before = snapshot()
        started = datetime.datetime.now(datetime.timezone.utc)
        try:
            result = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
            output, code = result.stdout, result.returncode
        except subprocess.TimeoutExpired as error:
            output, code = (error.stdout or b'') + b'\nCONTROL TIMEOUT\n', 124
        finished = datetime.datetime.now(datetime.timezone.utc)
        log = OUT / (name + '.log')
        log.write_bytes(output)
        after = snapshot()
        counts = {key: [int(value) for value in re.findall(pattern, output.decode(errors='replace'), re.M)] for key, pattern in {'pass': r'^\s*(\d+) pass\b', 'fail': r'^\s*(\d+) fail\b', 'assertions': r'(\d+) expect\(\) calls'}.items()}
        fetch = OUT / (name + '-fetch.jsonl')
        observation = [json.loads(line) for line in fetch.read_text().splitlines()] if fetch.exists() else []
        receipt = {
            'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': 'B30',
            'reviewer': '/root/b02_runtime_outcomes', 'name': name,
            'argv': argv, 'cwd': str(ROOT), 'exitCode': code,
            'startedUtc': started.isoformat(), 'finishedUtc': finished.isoformat(),
            'elapsedSeconds': (finished - started).total_seconds(),
            'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after,
            'environment': {'replacement': True, 'values': env, 'ownedEmptyHomeAndXdgAtStart': True, 'envFileLoading': False, 'nestedBunEnvFileLoading': False},
            'toolchain': {'executable': str(BUN), 'sha256': sha(BUN), 'version': '1.3.5'},
            'runner': ref(OUT / 'run.py'), 'preload': ref(OUT / ('offline-test-preload.ts' if 'test' in argv else 'offline-preload.ts')),
            'providerConfiguration': ref(OUT / 'provider-config.json'),
            'log': ref(log), 'counts': counts, 'fetchObservation': observation,
            'fetchLog': ref(fetch) if fetch.exists() else None,
            'scope': 'B30 deterministic process/environment/accounting/artifact controls only; broader suite is regression context.',
            'closed': True,
        }
        file = OUT / (name + '.command.json')
        file.write_text(json.dumps(receipt, indent=2) + '\n')
        receipts.append(ref(file))
        print(json.dumps({'name': name, 'exitCode': code, 'counts': counts, 'sourcesStable': before == after, 'fetchRefused': sum(row['event'] == 'external-fetch-refused' for row in observation)}), flush=True)
        assert code == 0 and before == after, name
        if expected_count is not None:
            assert counts['pass'] == [expected_count] and counts['fail'] == [0], name
        if '--preload' in argv:
            assert observation and observation[0]['event'] == 'guard-installed-before-imports', name
            assert observation[-1]['event'] == ('test-after-all' if 'test' in argv else 'process-exit') and observation[-1]['refused'] == 0, name

after_lessons = shared_lessons()
(OUT / 'shared-lessons-after.json').write_text(json.dumps(after_lessons, indent=2) + '\n')
assert before_lessons == after_lessons
(OUT / 'run-results.json').write_text(json.dumps({'schemaVersion': 1, 'reviewer': '/root/b02_runtime_outcomes', 'commands': receipts, 'sourceStable': True, 'sharedLessonsUnchanged': True, 'allControlsPassed': True}, indent=2) + '\n')
