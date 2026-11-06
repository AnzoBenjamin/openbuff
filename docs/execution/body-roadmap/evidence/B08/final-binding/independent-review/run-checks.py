#!/usr/bin/env python3
"""Independent current-source B08 checks; preserves the original producer evidence."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[7]
OUT = Path(__file__).resolve().parent
PRODUCER = OUT.parent.parent
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
POLICY = {'maxRetries': 2, 'backupMaxRetries': 0, 'maxTotalAttempts': 4,
          'baseDelayMs': 100, 'maxDelayMs': 200, 'retryAfterMaxDelayMs': 250,
          'maxTotalDelayMs': 600, 'jitterFraction': 0}
producer = json.loads((PRODUCER / 'manifest.json').read_text())
SOURCE_FILES = sorted({row['file'] for key in ['files', 'tests', 'dependencies'] for row in producer[key]} |
                      {'docs/execution/body-roadmap/evidence/B08/independent-review/route-metadata.ts'})
CONFIGS = ['package.json', 'sdk/package.json', 'common/package.json', 'packages/internal/package.json',
           'tsconfig.json', 'tsconfig.base.json', 'sdk/tsconfig.json', 'common/tsconfig.json',
           'packages/internal/tsconfig.json', 'bunfig.toml', 'bun.lock']
TESTS = [row['file'] for row in producer['tests']]

def bind(file):
    path = ROOT / file
    return {'path': file, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

def producer_artifacts():
    return [bind(str(file.relative_to(ROOT))) for file in sorted(PRODUCER.rglob('*'))
            if file.is_file() and not (PRODUCER / "final-binding") in file.parents]

before_sources = [bind(file) for file in SOURCE_FILES]
before_configs = [bind(file) for file in CONFIGS if (ROOT / file).is_file()]
before_producer = producer_artifacts()
(OUT / 'precommitted-inputs.json').write_text(json.dumps({
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'card': 'B08',
    'policy': POLICY, 'sourceBindings': before_sources, 'configBindings': before_configs,
    'producerArtifacts': before_producer,
    'acceptance': 'Canonical B08 PLAN/SPEC request/error/retry contract; root owns ledger acceptance.',
    'authorship': 'This lane has made no B08 production/test edits. B08 has no canonical prerequisites. This lane previously authored a B01 tail/store subset; that work receives no independent credit here.'
}, indent=2) + '\n')
receipts = []
with tempfile.TemporaryDirectory(prefix='b08-independent-env-') as owned:
    home = Path(owned) / 'home'; home.mkdir()
    xdg = Path(owned) / 'xdg'; xdg.mkdir()
    env = {'PATH': f'{BUN.parent}:/usr/local/bin:/usr/bin:/bin', 'HOME': str(home),
           'XDG_CONFIG_HOME': str(xdg), 'TMPDIR': '/tmp', 'LANG': 'C.UTF-8',
           'USER': 'b08-independent', 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
           'NEXT_PUBLIC_CODEBUFF_APP_URL': 'https://fixture.invalid'}
    commands = [
        ('actual-vision-failover', [str(BUN), '--no-env-file', str(PRODUCER / 'independent-review/route-metadata.ts'), str(OUT / 'route-metadata')]),
        ('provider-tests', [str(BUN), '--no-env-file', 'test', '--isolate',
                            '--preload', str(OUT / 'offline-preload.ts'), *[str(ROOT / file) for file in TESTS]]),
        ('provider-retry-fixture', [str(BUN), '--no-env-file', '--preload', str(OUT / 'offline-preload.ts'),
                                   str(ROOT / 'test/fixtures/body/provider-retry.ts'), str(OUT / 'fixture')]),
        *[('typecheck-' + name, [str(BUN), '--no-env-file', 'run', '--cwd', directory, 'typecheck'])
          for name, directory in [('sdk', 'sdk'), ('internal', 'packages/internal'), ('common', 'common')]],
    ]
    for name, argv in commands:
        command_env = dict(env)
        command_env['B08_INDEPENDENT_FETCH_LOG'] = str(OUT / (name + '-fetch.jsonl'))
        with (OUT / (name + '.log')).open('w') as log:
            result = subprocess.run(argv, cwd=ROOT, env=command_env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=180)
        (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
        receipts.append({'name': name, 'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode,
                         'log': str((OUT / (name + '.log')).relative_to(ROOT)),
                         'environmentKeys': sorted(command_env)})
        (OUT / 'commands.json').write_text(json.dumps(receipts, indent=2) + '\n')
        print(f'{name}: exit {result.returncode}', flush=True)
after_sources = [bind(file) for file in SOURCE_FILES]
after_configs = [bind(file) for file in CONFIGS if (ROOT / file).is_file()]
after_producer = producer_artifacts()
result = {'schemaVersion': 1, 'card': 'B08', 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'commands': receipts, 'policy': POLICY, 'sourceBindings': after_sources,
          'configBindings': after_configs, 'sourceStableDuringChecks': before_sources == after_sources,
          'configStableDuringChecks': before_configs == after_configs,
          'producerArtifactsPreserved': before_producer == after_producer,
          'producerArtifactBindings': after_producer,
          'toolchain': {'executable': str(BUN), 'version': subprocess.check_output([str(BUN), '--version'], text=True).strip(),
                        'sha256': hashlib.sha256(BUN.read_bytes()).hexdigest()},
          'environment': {'replacement': True, 'ownedEmptyHomeAndXdg': True, 'noEnvFile': True,
                          'providerKeys': 'No ambient credentials; fixture/test-controlled synthetic keys only'},
          'requiredCommandsPass': all(row['exitCode'] == 0 for row in receipts)}
(OUT / 'command-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['requiredCommandsPass', 'sourceStableDuringChecks', 'configStableDuringChecks', 'producerArtifactsPreserved']}))
