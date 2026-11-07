#!/usr/bin/env python3
"""Record the repaired CI checks against a declared, stable source-input set."""

import argparse
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
    raise RuntimeError('Refusing CI-repair evidence recording with optimized Python.')

BASE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[6]
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
INPUT_SCOPE = ROOT / 'docs/execution/body-roadmap/evidence/publication-20261107/post-commit-ci-repair/commands/typecheck/typecheck.json'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('check', choices=['guard-tests', 'guard-memory-drift', 'typecheck'])
    options = parser.parse_args()
    commands = {
        'guard-tests': [str(BUN), '--no-env-file', 'test', '--isolate',
                        str(ROOT / 'scripts/__tests__/memory-drift-guard.test.ts')],
        'guard-memory-drift': [str(BUN), '--no-env-file', 'run', '--cwd', 'scripts',
                               'guard:memory-drift'],
        'typecheck': [str(BUN), '--no-env-file', 'run', 'typecheck'],
    }
    original = json.loads(INPUT_SCOPE.read_text())
    names = set(original['sourceBefore'])
    assert len(names) == 187
    names.update(['cli/scripts/prebuild-agents.ts', 'sdk/scripts/build.ts',
                  'agents/e2e/gate-aux-ordering.e2e.test.ts',
                  'agents/e2e/gate-lifecycle.e2e.test.ts',
                  '.github/workflows/rust-workspace.yml',
                  str(Path(__file__).relative_to(ROOT))])

    def source_hashes():
        return {name: sha(ROOT / name) for name in sorted(names)}

    assert subprocess.check_output([str(BUN), '--version'], text=True).strip() == '1.3.5'
    directory = BASE / 'commands' / options.check
    directory.mkdir(parents=True, exist_ok=False)
    before = source_hashes()
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='openbuff-ci-repair-') as temporary:
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
        }
        log_path = directory / (options.check + '.log')
        with log_path.open('xb') as log:
            result = subprocess.run(commands[options.check], cwd=ROOT, env=environment,
                                    stdout=log, stderr=subprocess.STDOUT)
    after = source_hashes()
    log_text = log_path.read_text(errors='replace')
    counts = re.search(r'\n\s+(\d+) pass\n(?:\s+\d+ skip\n)?\s+(\d+) fail', log_text)
    receipt = {
        'schemaVersion': 1, 'check': options.check, 'argv': commands[options.check],
        'cwd': str(ROOT), 'startedAt': started,
        'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'elapsedSeconds': time.monotonic() - start, 'exitCode': result.returncode,
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'toolchain': {'executable': str(BUN), 'version': '1.3.5', 'sha256': sha(BUN)},
        'environment': {'replacement': True, 'keys': sorted(environment),
                        'ephemeralHome': True, 'envFileLoading': False},
        'inputScope': {'path': str(INPUT_SCOPE.relative_to(ROOT)), 'sha256': sha(INPUT_SCOPE),
                       'meaning': 'Inherited 187 declared inputs, plus both generated-output producers, the subsequent two E2E fixture repairs, Rust workflow and this recorder; all declared before and captured before/after the command.'},
        'sourceBefore': before, 'sourceAfter': after,
        'sourceUnchangedDuringCommand': before == after,
        'log': str(log_path.relative_to(ROOT)), 'logSha256': sha(log_path),
        'counts': {'pass': int(counts[1]), 'fail': int(counts[2])} if counts else None,
    }
    with (directory / (options.check + '.json')).open('x') as output:
        json.dump(receipt, output, indent=2)
        output.write('\n')
    with (directory / (options.check + '.exit')).open('x') as output:
        output.write(str(result.returncode) + '\n')
    print(json.dumps({key: receipt[key] for key in ['check', 'exitCode',
                      'sourceUnchangedDuringCommand', 'elapsedSeconds', 'counts']}))
    print('\n'.join(log_text.splitlines()[-14:]))
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())

