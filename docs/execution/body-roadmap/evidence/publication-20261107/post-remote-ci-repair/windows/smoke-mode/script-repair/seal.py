"""Seal the corrected placeholder smoke separately from frozen failed history."""
from pathlib import Path
import datetime
import hashlib
import json
import stat

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'rust').is_dir())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
read = lambda p: json.loads(Path(p).read_text())
assert not (OUT / 'repair-seal.json').exists()
result = read(OUT / 'run-results.json')
assert result['allPassed'] and not result['execPayloadExecuted']
assert sha(ROOT / result['scriptAfter']['path']) == result['scriptAfter']['sha256']
assert stat.S_IMODE((ROOT / result['scriptAfter']['path']).stat().st_mode) == 0o755
assert sha(ROOT / result['workflow']['path']) == result['workflow']['sha256']
current = result['commands'][:3] + [ref(OUT / 'git-diff-check-corrected.json')]
for row in current:
    path = ROOT / row['path']
    assert sha(path) == row['sha256']
    command = read(path)
    assert command['sourceBefore'] == command['sourceAfter']
    for name, digest in command['sourceBefore'].items():
        assert sha(ROOT / name) == digest, name
    for side in ['stdout', 'stderr', 'log']:
        if side in command:
            assert sha(ROOT / command[side]['path']) == command[side]['sha256']
    assert command['exitCode'] == (2 if command.get('name') == 'daemon-placeholder' else 0)
mode_seal = OUT.parent / 'repair-seal.json'
workflow_seal = OUT.parents[1] / 'repair-seal.json'
assert sha(mode_seal) == '5f4aa5efd4a1d73f182f1a5692f04d08c0f258b0758fc7042e6e0b566ed49193'
assert sha(workflow_seal) == '6f4a92570328cef03eab7e86c73630de7e81e69a02c334542da4bcd3dbec2c29'
seal = {
    'schemaVersion': 1, 'type': 'body-smoke-placeholder-script-repair',
    'owner': '/root/b02_runtime_outcomes', 'scriptBefore': result['scriptBefore'],
    'scriptAfter': result['scriptAfter'], 'scriptMode': '0755',
    'workflow': result['workflow'], 'matchingHostBuild': result['matchingHostBuildProvenance'],
    'currentControls': current, 'allCurrentControlsPassed': True,
    'historicalMisScopedWhitespaceControl': result['commands'][3],
    'preservedFailedModeSupplement': ref(mode_seal), 'preservedWorkflowSeal': ref(workflow_seal),
    'delta': result['delta'], 'artifacts': [ref(p) for p in sorted(OUT.rglob('*')) if p.is_file() and '__pycache__' not in p.parts],
    'scope': 'Smallest authorized daemon placeholder probe and comment change;0755 retained. Local Linux ordinary CLI/shell/placeholder proof only; no exec payload, Windows/Darwin execution, downstream native acceptance or publication action.',
    'sealedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(OUT / 'repair-seal.json').write_text(json.dumps(seal, indent=2) + '\n')
print(json.dumps({'scriptAfter': result['scriptAfter'], 'mode': '0755', 'seal': ref(OUT / 'repair-seal.json'), 'currentControls': current}))
