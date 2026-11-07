"""Reproduce pre-build documentation CI on a real, unbuilt local Git checkout."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

if not __debug__:
    raise RuntimeError('Optimized evidence recording is unsupported')
BASE = Path(__file__).resolve().parent
ROOT = next(parent for parent in BASE.parents if (parent / 'bun.lock').is_file())
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
GUARD = 'scripts/memory-drift-guard.ts'
OUTPUTS = ['cli/src/agents/bundled-agents.generated.ts', 'sdk/dist/index.mjs', 'sdk/dist/index.d.ts']
INPUTS = [GUARD, 'scripts/__tests__/memory-drift-guard.test.ts', 'cli/scripts/prebuild-agents.ts',
          'sdk/scripts/build.ts', 'cli/package.json', 'sdk/package.json',
          'scripts/package.json', 'bunfig.toml']
DIRECTORY = BASE / 'fresh-checkout-v3'
DIRECTORY.mkdir(exist_ok=False)

def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def source_map(root):
    return {name: sha(root / name) for name in INPUTS}

root_before = source_map(ROOT)
records = []
with tempfile.TemporaryDirectory(prefix='openbuff-prebuild-guard-') as temporary:
    scratch = Path(temporary)
    checkout = scratch / 'checkout'
    (scratch / 'home').mkdir()
    (scratch / 'config').mkdir()
    environment = {
        'PATH': str(BUN.parent) + ':/usr/local/bin:/usr/bin:/bin',
        'HOME': str(scratch / 'home'), 'XDG_CONFIG_HOME': str(scratch / 'config'),
        'TMPDIR': temporary, 'LANG': 'C.UTF-8', 'BUN_OPTIONS': '--no-env-file',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(scratch / 'home/.gitconfig'),
    }
    with (DIRECTORY / 'clone.log').open('xb') as log:
        subprocess.run(['git', 'clone', '--no-hardlinks', '--quiet', str(ROOT), str(checkout)],
                       env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, env=environment, text=True).strip()
    assert head == '0f34d0f7775443552c4b99fad55cccb2c600a298'

    def run(name, expected_exit, expected_findings):
        assert not any((checkout / output).exists() for output in OUTPUTS)
        before = source_map(checkout)
        argv = [str(BUN), '--no-env-file', 'run', '--cwd', 'scripts', 'guard:memory-drift']
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log_path = DIRECTORY / (name + '.log')
        with log_path.open('xb') as log:
            result = subprocess.run(argv, cwd=checkout, env=environment,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=60)
        after = source_map(checkout)
        log_text = log_path.read_text(errors='replace')
        findings = re.search(r'Memory drift guard(?::| passed:) (\d+) findings?(?:\(s\))? across (\d+) checkers?(?:\(s\))?', log_text)
        assert findings, log_text
        record = {
            'name': name, 'argv': argv, 'cwd': str(checkout), 'startedAt': started,
            'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'exitCode': result.returncode, 'expectedExitCode': expected_exit,
            'findingCount': int(findings[1]), 'checkerCount': int(findings[2]),
            'expectedFindingCount': expected_findings,
            'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after,
            'generatedOutputsAbsentBeforeAndAfter': {output: not (checkout / output).exists() for output in OUTPUTS},
            'log': {'path': str(log_path.relative_to(ROOT)), 'sha256': sha(log_path)},
        }
        records.append(record)
        (DIRECTORY / (name + '.json')).write_text(json.dumps(record, indent=2) + '\n')
        assert result.returncode == expected_exit, record
        assert int(findings[1]) == expected_findings, record
        assert before == after

    run('before', 1, 4)
    shutil.copyfile(ROOT / GUARD, checkout / GUARD)
    run('after', 0, 0)
    negative = checkout / 'docs/generated-output-negative-control.md'
    negative.write_text('See `sdk/dist/unlisted.mjs` and `cli/src/agents/unlisted.generated.ts`.\n')
    run('unlisted-output-negative', 1, 2)

root_after = source_map(ROOT)
report = {
    'schemaVersion': 1, 'type': 'fresh-unbuilt-checkout-documentation-guard-control',
    'materializedHead': head, 'records': records,
    'rootSourceBefore': root_before, 'rootSourceAfter': root_after,
    'rootSourceStable': root_before == root_after,
    'toolchain': {'path': str(BUN), 'version': '1.3.5', 'sha256': sha(BUN)},
    'environment': {'replacement': True, 'keys': sorted(environment), 'envFileLoading': False},
    'scope': 'Actual full guard against an unbuilt local Git checkout. Generated-output producers are present; all three outputs remain absent. No archive rehydration, build, SDK/native/browser/provider execution or card acceptance.',
    'runner': {'path': str(Path(__file__).relative_to(ROOT)), 'sha256': sha(Path(__file__))},
}
(DIRECTORY / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
assert root_before == root_after
print(json.dumps({'checks': [{key: record[key] for key in ['name', 'exitCode', 'findingCount', 'sourceStable']} for record in records], 'rootSourceStable': True}))

