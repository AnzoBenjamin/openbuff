from pathlib import Path
import datetime, hashlib, json, re, subprocess, sys, tempfile

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
raw = root / 'docs/execution/body-roadmap/evidence/integration/deslop-sdk-indexer-internal'
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
relative = lambda path: str(path.relative_to(root))
assert not (here / 'audit.json').exists()
manifest = raw / 'manifest.json'
assert digest(manifest) == 'eb605fb73cb1825e1349f4284da7cc3957dea2e11589e0ed12e468db06d78eb7'
assert digest(raw / 'report.md') == '5701636d6410b7604456b50079fa38f64351b6e2dd37dfbbee671f0a04421360'
receipts = {name: json.loads((raw / (name + '.json')).read_text()) for name in ['bridge-before', 'bridge-after', 'typecheck-sdk', 'lint-changed']}
paths = set(receipts['bridge-after']['sourceAfter'])
paths.update(['common/src/tools/results/filesystem.ts', 'common/src/protocol/acp-ext-v1.ts', 'common/src/util/action-outcomes.ts', 'common/src/types/run-outcome.ts', 'common/src/types/print-mode.ts', 'common/src/testing/fixtures/file-mutation.ts', 'sdk/src/run.ts', relative(Path(__file__).resolve())])
before = {path: digest(root / path) for path in sorted(paths)}
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
verified = []
for artifact in json.loads(manifest.read_text())['files']:
    assert digest(root / artifact['path']) == artifact['sha256'], artifact['path']
    verified.append(artifact)
target = 'sdk/src/serve/event-bridge.ts'
before_hash = '7dd82864629462568c563a5791336073a46a8d8b4dab0ff7ec24fad87bca4af2'
after_hash = '20daae14096a76c175ec2478219c9cf4a0aa0ba071c1533d6be6bcfbca824768'
assert before[target] == after_hash
delta = (raw / 'cleanup-delta.diff').read_text()
assert [line for line in delta.splitlines() if line.startswith('-') and not line.startswith('---')] == ['-      let mutation: MutationResultSummary | undefined', '-          mutation = parsed']
assert not [line for line in delta.splitlines() if line.startswith('+') and not line.startswith('+++')]
with tempfile.TemporaryDirectory(prefix='bridge-review-before-') as temporary:
    old = Path(temporary) / target
    old.parent.mkdir(parents=True)
    old.write_bytes((root / target).read_bytes())
    subprocess.run(['git', 'apply', '-R', str(raw / 'cleanup-delta.diff')], cwd=temporary, check=True)
    assert digest(old) == before_hash
    (here / 'event-bridge-before.ts.txt').write_bytes(old.read_bytes())
for name, receipt in receipts.items():
    assert receipt['exitCode'] == 0 and receipt['sourceStable']
    assert receipt['sourceBefore'] == receipt['sourceAfter']
    assert digest(root / receipt['log']['path']) == receipt['log']['sha256']
    assert digest(Path(receipt['bun']['path'])) == receipt['bun']['sha256']
    mismatches = [path for path, expected in receipt['sourceAfter'].items() if digest(root / path) != expected]
    assert mismatches == ([target] if name == 'bridge-before' else []), mismatches
    if name.startswith('bridge-'):
        assert receipt['counts'] == {'pass': ['64'], 'fail': ['0'], 'assertions': ['186'], 'files': ['3']}
        log = (root / receipt['log']['path']).read_text()
        assert len(re.findall(r'^\(pass\)', log, re.M)) == 64 and '(fail)' not in log
        assert receipt['networkTraces']
        for trace in receipt['networkTraces']:
            assert digest(root / trace['path']) == trace['sha256']
            assert json.loads((root / trace['path']).read_text()) == trace['observed'] == {'fetchCalls': 0}
old_scope = {v['path']: v['sha256'] for v in json.loads((raw / 'scope-before.json').read_text())['files']}
new_scope = {v['path']: v['sha256'] for v in json.loads((raw / 'scope-after.json').read_text())['files']}
assert set(old_scope) == set(new_scope) and len(old_scope) == 60
assert [path for path in old_scope if old_scope[path] != new_scope[path]] == [target]
assert all(digest(root / path) == expected for path, expected in new_scope.items())
after = {path: digest(root / path) for path in sorted(paths)}
assert before == after
result = {
    'schemaVersion': 1, 'reviewer': '/root/b03_mutation_evidence',
    'purpose': 'Independent static delta, artifact seal, source closure and recorded behavior-oracle verification for two deleted dead statements only.',
    'argv': [sys.executable, relative(Path(__file__).resolve())], 'cwd': str(root),
    'startedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'exitCode': 0, 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': True,
    'beforeSha256': before_hash, 'afterSha256': after_hash,
    'reconstructedBefore': {'path': relative(here / 'event-bridge-before.ts.txt'), 'sha256': digest(here / 'event-bridge-before.ts.txt')},
    'verifiedOriginalManifest': {'path': relative(manifest), 'sha256': digest(manifest)},
    'verifiedArtifactCount': len(verified), 'scopeFileCount': 60, 'unchangedScopeFiles': 59,
    'creditedBehaviorRuns': [{'path': relative(raw / (name + '.json')), 'sha256': digest(raw / (name + '.json')), 'counts': receipts[name]['counts']} for name in ['bridge-before', 'bridge-after']],
    'verification': ['Original report/manifest pins and every manifest artifact matched.', 'Reverse-applied exact two-deletion patch reconstructs the sealed before source.', 'Both bridge runs passed 64 / 0 / 186 / 3; actual pass lines and guard traces matched.', 'All post-cleanup command source maps match current bytes.', 'Only event-bridge.ts differs between original before and after maps.', 'Current closure remained byte-stable throughout read-only verification.'],
    'scopeLimits': ['No new product run; existing focused executions are credited only for their recorded current post-cleanup source map.', 'Current additional common/source dependency hashes are integrity context, not separately approved implementation or a claim that prior receipts hashed every transitive input.', 'No independent approval of B03 mutations, reviewer-owned implementation, whole B02 producer/consumer lane, provider calls or OS isolation.'],
}
(here / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'exitCode': 0, 'verifiedArtifactCount': len(verified), 'sourceStable': True, 'sourceCount': len(before), 'changedScopeFiles': [target], 'beforeSha256': before_hash, 'afterSha256': after_hash}, indent=2))
