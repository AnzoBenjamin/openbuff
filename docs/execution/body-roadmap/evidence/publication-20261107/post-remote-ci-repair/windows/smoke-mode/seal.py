"""Seal the byte-preserving mode change and honestly retained smoke failures."""
from pathlib import Path
import datetime
import hashlib
import json
import stat
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'rust').is_dir())
read = lambda p: json.loads(Path(p).read_text())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
assert not (OUT / 'repair-seal.json').exists()
result = read(OUT / 'run-results.json')
script = ROOT / result['script']['path']
assert sha(script) == result['script']['sha256'] == sha(OUT / 'smoke-test-sidecar.before.sh')
assert stat.S_IMODE(script.stat().st_mode) == 0o755
assert sha(ROOT / result['workflow']['path']) == result['workflow']['sha256']
assert result['ordinaryVersionPassed'] and result['unknownRolePassed']
assert not result['execPlaceholderPassed'] and not result['directSmokePassed']
for row in result['commands']:
    path = ROOT / row['path']
    assert sha(path) == row['sha256']
    command = read(path)
    assert command['sourceBefore'] == command['sourceAfter']
    for name, digest in command['sourceBefore'].items():
        assert sha(ROOT / name) == digest, name
    for side in ['stdout', 'stderr']:
        assert sha(ROOT / command[side]['path']) == command[side]['sha256']
argv = ['git', 'diff', '--summary', '--', 'rust/scripts/smoke-test-sidecar.sh']
observed = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
assert observed.stdout.decode().strip() == 'mode change 100644 => 100755 rust/scripts/smoke-test-sidecar.sh'
(OUT / 'git-mode-diff.log').write_bytes(observed.stdout)
original_workflow_seal = OUT.parent / 'repair-seal.json'
assert sha(original_workflow_seal) == '6f4a92570328cef03eab7e86c73630de7e81e69a02c334542da4bcd3dbec2c29'
seal = {
    'schemaVersion': 1, 'type': 'body-smoke-executable-mode-supplement',
    'owner': '/root/b02_runtime_outcomes', 'sourceBytesPreserved': True,
    'script': result['script'], 'worktreeMode': '0755', 'gitModeDelta': '100644 -> 100755',
    'modeDiffCommand': {'argv': argv, 'cwd': str(ROOT), 'exitCode': 0, 'log': ref(OUT / 'git-mode-diff.log')},
    'workflow': result['workflow'], 'priorWorkflowSealUnchanged': ref(original_workflow_seal),
    'controls': result['commands'], 'matchingHostBuildCompleted': True,
    'ordinaryVersionAndUnknownRolePassed': True, 'execPlaceholderAndDirectSmokePassed': False,
    'failure': 'Current Exec implementation requires an initialize handshake; unchanged script incorrectly expects exec placeholder exit2/not_implemented.',
    'artifacts': [ref(p) for p in sorted(OUT.rglob('*')) if p.is_file() and '__pycache__' not in p.parts],
    'windowsExecuted': False, 'nativeAcceptanceClaimed': False, 'indexStagedByOwner': False,
    'sealedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(OUT / 'repair-seal.json').write_text(json.dumps(seal, indent=2) + '\n')
print(json.dumps({'script': result['script'], 'gitModeDelta': seal['gitModeDelta'], 'seal': ref(OUT / 'repair-seal.json'), 'execPlaceholderAndDirectSmokePassed': False}))
