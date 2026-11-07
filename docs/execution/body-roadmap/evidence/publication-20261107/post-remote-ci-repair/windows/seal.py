"""Seal workflow-only structural controls and the independent binding scope."""
from pathlib import Path
import datetime
import hashlib
import json

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / '.github').is_dir())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
read = lambda p: json.loads(Path(p).read_text())
assert not (OUT / 'repair-seal.json').exists()
result = read(OUT / 'run-results.json')
assert result['allStructuralControlsPassed'] and result['windowsExecuted'] is False
assert sha(ROOT / result['sourceAfter']['path']) == result['sourceAfter']['sha256']
for row in result['commands']:
    path = ROOT / row['path']
    assert sha(path) == row['sha256']
    command = read(path)
    assert command['sourceBefore'] == command['sourceAfter'] and command['exitCode'] == 0
    for name, digest in command['sourceBefore'].items():
        assert sha(ROOT / name) == digest, name
    assert sha(ROOT / command['log']['path']) == command['log']['sha256']
scope = OUT.parent / 'independent-scope/active-bindings.json'
assert sha(scope) == 'fa4f302c36614a3778fd97a3b5509806541f5141b7907e71c01fe9aaac71f16f'
scope_data = read(scope)
workflow = result['sourceAfter']['path']
assert scope_data['sourceBefore'][workflow] == result['sourceBefore']['sha256']
assert scope_data['sourceBefore'] == scope_data['sourceAfter']
assert not any(row['path'] == workflow for row in scope_data['targetBindingCalls'])
seal = {
    'schemaVersion': 1, 'type': 'body-windows-workflow-structural-repair',
    'owner': '/root/b02_runtime_outcomes',
    'changedSourcePaths': [workflow], 'sourceBefore': result['sourceBefore'],
    'sourceAfter': result['sourceAfter'], 'bindingScopeBeforeMutation': ref(scope),
    'commands': result['commands'], 'delta': result['delta'],
    'verification': result['verification'],
    'artifacts': [ref(p) for p in sorted(OUT.rglob('*')) if p.is_file() and '__pycache__' not in p.parts],
    'windowsExecuted': False, 'realGitHubRerunRequired': True,
    'scope': 'One unbound workflow, Linux bounded YAML/order/boolean-condition verification only; no Rust source/native execution, staging, commit, push, frozen evidence rewrite or acceptance/ledger promotion.',
    'sealedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(OUT / 'repair-seal.json').write_text(json.dumps(seal, indent=2) + '\n')
print(json.dumps({'source': result['sourceAfter'], 'seal': ref(OUT / 'repair-seal.json'), 'windowsExecuted': False, 'realGitHubRerunRequired': True}))
