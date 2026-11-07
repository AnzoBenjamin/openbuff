"""Verify settled CI-repair receipts without changing sources or prior artifacts."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

if not __debug__:
    raise RuntimeError('Optimized verification is unsupported')
OUT = Path(__file__).resolve().parent
BASE = OUT.parent
ROOT = OUT.parents[6]


def binding(path):
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def check(row):
    actual = binding(ROOT / row['path'])
    assert actual['sha256'] == row['sha256'], row['path']
    if 'bytes' in row:
        assert actual['bytes'] == row['bytes'], row['path']
    return actual


prior_path = ROOT / 'docs/execution/body-roadmap/evidence/publication-20261107/post-commit-ci-repair/commands/typecheck/typecheck.json'
prior = json.loads(prior_path.read_text())
commands = []
for name in ['guard-tests', 'guard-memory-drift', 'typecheck']:
    path = BASE / 'commands' / name / (name + '.json')
    receipt = json.loads(path.read_text())
    assert receipt['exitCode'] == 0
    assert receipt['sourceBefore'] == receipt['sourceAfter']
    assert len(receipt['sourceBefore']) == 193
    assert set(prior['sourceBefore']) <= set(receipt['sourceBefore'])
    assert len(prior['sourceBefore']) == 187
    for source, digest in receipt['sourceBefore'].items():
        check({'path': source, 'sha256': digest})
    check(receipt['inputScope'])
    log = check({'path': receipt['log'], 'sha256': receipt['logSha256']})
    tool = Path(receipt['toolchain']['executable'])
    assert hashlib.sha256(tool.read_bytes()).hexdigest() == receipt['toolchain']['sha256'] == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
    text = (ROOT / log['path']).read_text()
    if name == 'guard-tests':
        assert receipt['counts'] == {'pass': 71, 'fail': 0}
        assert '164 expect() calls' in text and 'Ran 71 tests across 1 file.' in text
    elif name == 'guard-memory-drift':
        assert 'Memory drift guard passed: 0 findings across 12 checkers.' in text
    else:
        assert receipt['argv'][-2:] == ['run', 'typecheck']
    commands.append({'receipt': binding(path), 'log': log, 'exitCode': 0,
                     'stableCurrentInputs': len(receipt['sourceBefore']), 'counts': receipt['counts']})
windows_path = BASE / 'windows/repair-seal.json'
windows = json.loads(windows_path.read_text())
for row in windows['artifacts']:
    check(row)
check(windows['sourceAfter'])
assert windows['sourceAfter']['sha256'] == '0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3'
for reference in windows['commands']:
    check(reference)
    command = json.loads((ROOT / reference['path']).read_text())
    assert command['exitCode'] == 0 and command['sourceBefore'] == command['sourceAfter']
    for source, digest in command['sourceBefore'].items():
        check({'path': source, 'sha256': digest})
    check(command['log'])
probe = json.loads((OUT / 'snapshot-probe.json').read_text())
check(probe['source'])
assert probe['allPassed'] and len(probe['cases']) == 5
source_paths = ['scripts/memory-drift-guard.ts', 'scripts/__tests__/memory-drift-guard.test.ts', '.github/workflows/rust-workspace.yml']
producer_paths = ['cli/scripts/prebuild-agents.ts', 'sdk/scripts/build.ts', 'cli/package.json', 'sdk/package.json']
delta = subprocess.check_output(['git', 'diff', '--', *source_paths], cwd=ROOT)
with (OUT / 'reviewed-source.diff').open('xb') as stream:
    stream.write(delta)
result = {'schemaVersion': 1, 'type': 'independent-ci-repair-receipt-verification',
          'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'reviewer': '/root/b04_lock_cas', 'sourceBindings': [binding(ROOT / path) for path in source_paths],
          'producerAndManifestBindings': [binding(ROOT / path) for path in producer_paths],
          'commands': commands, 'inherited187InputScope': binding(prior_path),
          'windowsSeal': binding(windows_path), 'windowsExecutionClaimed': False,
          'independentSnapshotProbe': binding(OUT / 'snapshot-probe.json'),
          'snapshotProbeExecution': {'argv': ['/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun', '--no-env-file', str(OUT / 'snapshot-probe.ts')], 'cwd': str(ROOT), 'exitCode': 0, 'observedStdout': '{"cases":5,"allPassed":true,"sourceUnchanged":true}\n'},
          'scope': 'Fresh-checkout recording is reviewed separately; this record verifies the settled 193-input commands, Windows structure artifacts and independent snapshot probe.'}
with (OUT / 'receipt-verification.json').open('x') as stream:
    json.dump(result, stream, indent=2)
    stream.write('\n')
print(json.dumps(binding(OUT / 'receipt-verification.json')))
