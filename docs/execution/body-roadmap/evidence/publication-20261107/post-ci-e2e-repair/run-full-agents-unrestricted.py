#!/usr/bin/env python3
"""Replay all agents tests with the local socket capability required by supervised spawn."""

import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

if not __debug__:
    raise RuntimeError('Refusing full-agents recording with optimized Python.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


names = set(subprocess.check_output(['rg', '--files', 'agents', '-g', '*.ts', '-g', '*.tsx',
                                    '-g', '!**/node_modules/**'], cwd=ROOT, text=True).splitlines())
names.update(['package.json', 'bun.lock', 'bunfig.toml', 'agents/package.json',
              'agents/tsconfig.json', 'scripts/check-ci-local.ts', '.agents/types/tools.ts',
              'common/src/util/content-hash.ts', 'common/src/tools/results/filesystem.ts',
              str(Path(__file__).relative_to(ROOT)),
              str((BASE / 'offline-test-preload.ts').relative_to(ROOT)),
              str((BASE / 'provider-config.json').relative_to(ROOT))])
assert len([name for name in names if name.endswith(('.test.ts', '.test.tsx'))]) == 56


def sources():
    return {name: sha(ROOT / name) for name in sorted(names)}


assert subprocess.check_output([str(BUN), '--version'], text=True).strip() == '1.3.5'
before = sources()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
tick = time.monotonic()
argv = [str(BUN), '--no-env-file', 'test', '--preload', str(BASE / 'offline-test-preload.ts')]
directory = BASE / 'full-agents-unrestricted'
directory.mkdir(exist_ok=False)
log_path = directory / 'full-agents.log'
with tempfile.TemporaryDirectory(prefix='openbuff-full-agents-') as temporary:
    scratch = Path(temporary)
    (scratch / 'home').mkdir()
    (scratch / 'config').mkdir()
    node = shutil.which('node')
    environment = {
        'PATH': ':'.join(dict.fromkeys([str(BUN.parent),
                    *([str(Path(node).parent)] if node else []),
                    '/usr/local/bin', '/usr/bin', '/bin'])),
        'HOME': str(scratch / 'home'), 'XDG_CONFIG_HOME': str(scratch / 'config'),
        'TMPDIR': '/tmp', 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
        'NEXT_PUBLIC_CB_ENVIRONMENT': 'test', 'OPENBUFF_LOCAL_MODE': 'true',
        'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'BUN_OPTIONS': '--no-env-file',
        'OPENBUFF_PROVIDER_CONFIG': str(BASE / 'provider-config.json'),
        'B30_INDEPENDENT_FETCH_LOG': str(directory / 'fetch.jsonl'),
    }
    with log_path.open('xb') as log:
        result = subprocess.run(argv, cwd=ROOT / 'agents', env=environment,
                                stdout=log, stderr=subprocess.STDOUT)
after = sources()
log_text = log_path.read_text(errors='replace')
summary = re.search(r'\n\s+(\d+) pass\n(?:\s+(\d+) skip\n)?\s+(\d+) fail', log_text)
schedule = re.search(r'Ran (\d+) tests across (\d+) files', log_text)
counts = {'pass': int(summary[1]), 'skip': int(summary[2] or 0),
          'fail': int(summary[3])} if summary else None
report = {
    'schemaVersion': 1, 'type': 'managed-full-agents-test-discovery',
    'argv': argv, 'cwd': str(ROOT / 'agents'), 'startedAt': started,
    'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'elapsedSeconds': time.monotonic() - tick, 'exitCode': result.returncode,
    'toolchain': {'executable': str(BUN), 'version': '1.3.5', 'sha256': sha(BUN)},
    'environment': {'replacement': True, 'keys': sorted(environment),
                    'ephemeralHome': True, 'envFileLoading': False},
    'sourceBefore': before, 'sourceAfter': after, 'sourceUnchangedDuringCommand': before == after,
    'log': {'path': str(log_path.relative_to(ROOT)), 'sha256': sha(log_path)},
    'counts': counts, 'tests': int(schedule[1]) if schedule else None,
    'files': int(schedule[2]) if schedule else None,
    'executionContext': 'Run with required sandbox escalation: the unchanged supervised child requires a real local Unix socket.',
    'fetchObservation': [json.loads(line) for line in (directory / 'fetch.jsonl').read_text().splitlines()],
    'scope': 'Bare agents discovery matching managed pre-push Step K, including E2Es. This is separate from the historical 45-file unit/package-script check; no new body-card acceptance.',
}
with (directory / 'full-agents.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(json.dumps({key: report[key] for key in ['exitCode', 'counts', 'tests', 'files',
                                             'sourceUnchangedDuringCommand', 'elapsedSeconds']}))
print('\n'.join(log_text.splitlines()[-12:]))
raise SystemExit(result.returncode)

