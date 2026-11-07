"""Seal a two-test fixture delta and current controls; no acceptance promotion."""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'agents').is_dir())
FILES = ['agents/e2e/gate-aux-ordering.e2e.test.ts', 'agents/e2e/gate-lifecycle.e2e.test.ts']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
read = lambda p: json.loads(Path(p).read_text())
assert not (OUT / 'repair-seal.json').exists()
before = read(OUT / 'before-targeted.json')
intermediate = read(OUT / 'after-evidence-targeted.json')
semantic = read(OUT / 'after-targeted.json')
final = read(OUT / 'after-formatted-targeted.json')
types = read(OUT / 'after-formatted-typecheck.json')
for receipt in [before, intermediate, semantic, final, types, read(OUT / 'after-typecheck.json')]:
    assert receipt['sourceBefore'] == receipt['sourceAfter'] and receipt['sourceStable']
    assert sha(ROOT / receipt['log']['path']) == receipt['log']['sha256']
assert before['counts']['pass'] == [19] and before['counts']['fail'] == [13]
assert intermediate['counts']['pass'] == [30] and intermediate['counts']['fail'] == [2]
assert final['counts']['pass'] == [32] and final['counts']['fail'] == [0] and final['counts']['assertions'] == [787]
assert types['exitCode'] == final['exitCode'] == 0
assert sha(OUT / 'record-initial.py') == before['runner']['sha256']
for receipt in [final, types]:
    for path, digest in receipt['sourceBefore'].items():
        assert sha(ROOT / path) == digest, path
    assert sha(ROOT / receipt['runner']['path']) == receipt['runner']['sha256']
for path in FILES:
    assert sha(OUT / 'before' / path) == before['sourceBefore'][path]
    assert sha(OUT / 'after-evidence-images' / path) == intermediate['sourceBefore'][path]
    assert sha(OUT / 'pre-format' / path) == semantic['sourceBefore'][path]
for path, digest in before['sourceBefore'].items():
    if path not in FILES and not path.startswith(str(OUT.relative_to(ROOT)) + '/'):
        assert sha(ROOT / path) == digest, path
delta = ''.join(line for path in FILES for line in difflib.unified_diff(
    (OUT / 'before' / path).read_text().splitlines(keepends=True),
    (ROOT / path).read_text().splitlines(keepends=True),
    fromfile='a/' + path, tofile='b/' + path,
))
(OUT / 'repair-delta.diff').write_text(delta)
argv = ['git', 'diff', '--check', '--'] + FILES
result = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
log = OUT / 'git-diff-check.log'
log.write_bytes(result.stdout)
(OUT / 'git-diff-check.json').write_text(json.dumps({'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode, 'log': ref(log), 'sourceHashes': {p: sha(ROOT / p) for p in FILES}}, indent=2) + '\n')
artifacts = [ref(p) for p in sorted(OUT.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.name != 'push-capture.partial.log']
seal = {
    'schemaVersion': 1, 'type': 'body-ci-e2e-fixture-repair',
    'owner': '/root/b02_runtime_outcomes', 'scope': 'Exactly two unbound reviewer E2E fixture files; no production/schema/generated/ledger edit or acceptance promotion.',
    'sourceBefore': {p: before['sourceBefore'][p] for p in FILES},
    'sourceAfter': {p: sha(ROOT / p) for p in FILES},
    'changedPaths': FILES, 'delta': ref(OUT / 'repair-delta.diff'),
    'currentControls': [ref(OUT / p) for p in ['after-formatted-targeted.json', 'after-formatted-typecheck.json', 'format.json', 'git-diff-check.json']],
    'historicalControls': [ref(OUT / p) for p in ['before-targeted.json', 'after-evidence-targeted.json', 'after-targeted.json', 'after-typecheck.json', 'format-initial-check.json']],
    'artifacts': artifacts, 'fullBroaderAgentsSuiteOwner': '/root',
    'allFinalDeclaredSourcesMatch': True, 'productionContractContextUnchanged': True,
    'sealedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(OUT / 'repair-seal.json').write_text(json.dumps(seal, indent=2) + '\n')
print(json.dumps({'changedPaths': FILES, 'sourceAfter': seal['sourceAfter'], 'seal': ref(OUT / 'repair-seal.json'), 'delta': seal['delta'], 'currentControls': seal['currentControls']}))
