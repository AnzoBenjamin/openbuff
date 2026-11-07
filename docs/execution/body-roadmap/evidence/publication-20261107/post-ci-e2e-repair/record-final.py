"""Record exact pinned-Bun E2E/managed-CI controls with no inherited environment."""
from pathlib import Path
import datetime
import hashlib
import json
import re
import subprocess
import sys
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'agents').is_dir())
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
BUN_HASH = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
SOURCES = [
    'agents/e2e/gate-aux-ordering.e2e.test.ts',
    'agents/e2e/gate-lifecycle.e2e.test.ts',
    'agents/base2/base2.ts', 'agents/base2/gate-reviewer.ts',
    'agents/base2/gate-fingerprint.ts', 'agents/base2/gate-state.ts',
    'agents/reviewer/code-reviewer.ts', 'agents/package.json',
    'package.json', 'bun.lock', 'bunfig.toml',
    'scripts/check-ci-local.ts', '.github/workflows/ci.yml',
]

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    return {'path': str(Path(path).relative_to(ROOT)), 'sha256': sha(path)}

assert sha(BUN) == BUN_HASH
name = sys.argv[1]
assert name in ['after-formatted-targeted', 'after-formatted-typecheck']
assert not (OUT / (name + '.json')).exists(), 'Preserve closed controls'
tests = [str(ROOT / p) for p in SOURCES[:2]]
cwd = ROOT
argv = [str(BUN), '--no-env-file', 'test', '--preload', str(OUT / 'offline-test-preload.ts'), '--isolate'] + tests
if name == 'after-agents-ci':
    cwd = ROOT / 'agents'
    argv = [str(BUN), '--no-env-file', 'test', '--preload', str(OUT / 'offline-test-preload.ts')]
elif name == 'after-formatted-typecheck':
    argv = [str(BUN), '--no-env-file', 'run', '--cwd', 'agents', 'typecheck']

extra = 'agents/e2e/helpers/reviewer-test-helpers.ts'
files = SOURCES + ([extra] if (ROOT / extra).is_file() else [])
files += [str((OUT / p).relative_to(ROOT)) for p in ['record-final.py', 'offline-test-preload.ts', 'provider-config.json']]
snapshot = lambda: {p: sha(ROOT / p) for p in files}
before = snapshot()
if name == 'before-targeted':
    for p in SOURCES[:2]:
        image = OUT / 'before' / p
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes((ROOT / p).read_bytes())
with tempfile.TemporaryDirectory(prefix='openbuff-e2e-ci-repair-') as owned:
    home = Path(owned) / 'home'
    xdg = Path(owned) / 'xdg'
    home.mkdir()
    xdg.mkdir()
    fetch_log = OUT / (name + '-fetch.jsonl')
    env = {
        'PATH': str(BUN.parent) + ':/usr/local/bin:/usr/bin:/bin',
        'HOME': str(home), 'USERPROFILE': str(home),
        'XDG_CONFIG_HOME': str(xdg), 'XDG_CACHE_HOME': str(Path(owned) / 'cache'),
        'XDG_DATA_HOME': str(Path(owned) / 'data'), 'TMPDIR': owned,
        'LANG': 'C.UTF-8', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test',
        'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
        'OPENBUFF_PROVIDER_CONFIG': str(OUT / 'provider-config.json'),
        'BUN_OPTIONS': '--no-env-file', 'B30_INDEPENDENT_FETCH_LOG': str(fetch_log),
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig'),
    }
    started = datetime.datetime.now(datetime.timezone.utc)
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        output, code = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        output, code = (error.stdout or b'') + b'\nCONTROL TIMEOUT\n', 124
    finished = datetime.datetime.now(datetime.timezone.utc)
after = snapshot()
log = OUT / (name + '.log')
log.write_bytes(output)
counts = {key: [int(v) for v in re.findall(pattern, output.decode(errors='replace'), re.M)] for key, pattern in {
    'pass': r'^\s*(\d+) pass\b', 'skip': r'^\s*(\d+) skip\b',
    'fail': r'^\s*(\d+) fail\b', 'assertions': r'(\d+) expect\(\) calls',
    'files': r'Ran \d+ tests across (\d+) files',
}.items()}
observation = [json.loads(line) for line in fetch_log.read_text().splitlines()] if fetch_log.exists() else []
receipt = {
    'schemaVersion': 1, 'type': 'body-ci-repair-command', 'reviewer': '/root/b02_runtime_outcomes',
    'name': name, 'argv': argv, 'cwd': str(cwd), 'exitCode': code,
    'startedUtc': started.isoformat(), 'finishedUtc': finished.isoformat(),
    'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after,
    'sourceMapScope': 'Declared two E2E fixture targets and accepted reviewer/gate/CI context, plus owned harness; not universal dependency tracing.',
    'environment': {'replacement': True, 'values': env, 'ownedEmptyHomeAndXdg': True, 'envFileLoading': False},
    'toolchain': {'executable': str(BUN), 'version': '1.3.5', 'sha256': sha(BUN)},
    'runner': ref(OUT / 'record-final.py'), 'preload': ref(OUT / 'offline-test-preload.ts'),
    'providerConfiguration': ref(OUT / 'provider-config.json'),
    'log': ref(log), 'counts': counts, 'fetchObservation': observation,
    'fetchLog': ref(fetch_log) if fetch_log.exists() else None,
    'historicalFailure': name == 'before-targeted', 'closed': True,
}
(OUT / (name + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'name': name, 'exitCode': code, 'counts': counts, 'sourceStable': before == after}))
assert before == after
if name not in ['before-targeted', 'after-evidence-targeted']:
    assert code == 0
