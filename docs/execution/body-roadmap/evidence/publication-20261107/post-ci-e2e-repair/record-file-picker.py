"""Record the published-SDK default-route diagnostic and exact fixture replay."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

if not __debug__:
    raise RuntimeError('Optimized recording is unsupported')
BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[5]
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
mode = sys.argv[1]
assert mode in ['diagnostic', 'before-file-picker', 'after-file-picker']
directory = BASE / mode
directory.mkdir(exist_ok=False)
paths = [
    'agents/e2e/file-explorer.e2e.test.ts',
    'agents/file-explorer/file-picker.ts', 'agents/file-explorer/file-lister.ts',
    'sdk/e2e/utils/e2e-mocks.ts', 'sdk/dist/index.mjs', 'sdk/src/provider-config.ts',
    'sdk/src/impl/model-provider.ts', 'sdk/test/setup-env.ts',
    'package.json', 'agents/package.json', 'sdk/package.json', 'bun.lock', 'bunfig.toml',
    *[str((BASE / name).relative_to(ROOT)) for name in [
        'record-file-picker.py', 'file-picker-diagnostic.ts',
        'offline-test-preload.ts', 'provider-config.json',
    ]],
]
def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()
snapshot = lambda: {path: sha(ROOT / path) for path in paths}
assert subprocess.check_output([str(BUN), '--version'], text=True).strip() == '1.3.5'
before = snapshot()
if mode == 'before-file-picker':
    image = directory / 'file-explorer.e2e.test.ts'
    image.write_bytes((ROOT / paths[0]).read_bytes())
target = BASE / 'file-picker-diagnostic.ts' if mode == 'diagnostic' else ROOT / paths[0]
argv = [str(BUN), '--no-env-file', 'test', '--preload', str(BASE / 'offline-test-preload.ts'), str(target)]
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
tick = time.monotonic()
with tempfile.TemporaryDirectory(prefix='openbuff-file-picker-control-') as temporary:
    scratch = Path(temporary)
    (scratch / 'home').mkdir()
    (scratch / 'config').mkdir()
    node = shutil.which('node')
    environment = {
        'PATH': ':'.join(dict.fromkeys([str(BUN.parent),
                    *([str(Path(node).parent)] if node else []),
                    '/usr/local/bin', '/usr/bin', '/bin'])),
        'HOME': str(scratch / 'home'), 'XDG_CONFIG_HOME': str(scratch / 'config'),
        'TMPDIR': temporary, 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
        'NEXT_PUBLIC_CB_ENVIRONMENT': 'test', 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
        'OPENBUFF_PROVIDER_CONFIG': str(BASE / 'provider-config.json'),
        'BUN_OPTIONS': '--no-env-file',
        'B30_INDEPENDENT_FETCH_LOG': str(directory / 'fetch.jsonl'),
        'OPENBUFF_FILE_PICKER_DIAGNOSTIC': str(directory / 'observations.jsonl'),
    }
    with (directory / 'test.log').open('xb') as log:
        result = subprocess.run(argv, cwd=ROOT / 'agents', env=environment,
                                stdout=log, stderr=subprocess.STDOUT, timeout=180)
after = snapshot()
log_text = (directory / 'test.log').read_text(errors='replace')
counts = {key: re.findall(pattern, log_text, re.M) for key, pattern in {
    'pass': r'^\s*(\d+) pass\b', 'skip': r'^\s*(\d+) skip\b',
    'fail': r'^\s*(\d+) fail\b', 'assertions': r'(\d+) expect\(\) calls',
}.items()}
receipt = {
    'schemaVersion': 1, 'type': 'file-picker-ci-fixture-control', 'mode': mode,
    'argv': argv, 'cwd': str(ROOT / 'agents'), 'startedAt': started,
    'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'elapsedSeconds': time.monotonic() - tick, 'exitCode': result.returncode,
    'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after,
    'toolchain': {'version': '1.3.5', 'path': str(BUN), 'sha256': sha(BUN)},
    'environment': {'replacement': True, 'keys': sorted(environment), 'envFileLoading': False,
                    'ownedEmptyHomeAndXdg': True, 'providerConfig': '{}'},
    'counts': counts, 'artifacts': [{
        'path': str(path.relative_to(ROOT)), 'sha256': sha(path),
    } for path in sorted(directory.iterdir()) if path.is_file()],
    'scope': 'One current integration fixture plus a diagnostic using the identical published-SDK import/source-mock seam. No card acceptance or production edits.',
}
(directory / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({key: receipt[key] for key in ['mode', 'exitCode', 'counts', 'sourceStable']}))
print('\n'.join(log_text.splitlines()[-10:]))
assert before == after
raise SystemExit(result.returncode)
