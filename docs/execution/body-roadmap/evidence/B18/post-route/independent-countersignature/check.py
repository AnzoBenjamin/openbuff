"""Read-only integrity, approval identity and original-command provenance check."""
from pathlib import Path
import hashlib, json
OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir() and (p / 'docs/execution/body-roadmap').is_dir())
def read(path): return json.loads(Path(path).read_text())
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def ref(path): return {'path': str(Path(path).resolve().relative_to(ROOT)), 'sha256': sha(path)}
def bound(row):
    path = ROOT / row['path']
    assert sha(path) == row['sha256'], row['path']
    return path
approval = read(OUT / 'approval.json')
review = read(OUT / 'review.json')
inspection = read(OUT / 'inspection.json')
assert approval['schemaVersion'] == review['schemaVersion'] == 1
assert approval['type'] == 'body-independent-approval' and review['type'] == 'body-implementation-review'
for key in ['nodeId', 'reviewer', 'implementationOwners', 'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts']:
    assert approval[key] == review[key], key
assert approval['decision'] == 'approve' and approval['independent']
assert approval['reviewer'] == '/root/b02_runtime_outcomes' and approval['reviewer'] not in approval['implementationOwners']
assert review['provenance'] == ref(OUT / 'approval.json')
assert approval['sourceContractHashes'] == inspection['sourceContractHashes']
for path, expected in approval['sourceContractHashes'].items(): assert sha(ROOT / path) == expected, path
for record in [approval, review]:
    for row in record['artifacts']: bound(row)
for row in approval['commandReceipts']:
    command = read(bound(row)); provenance = read(bound(command['provenance']))
    if 'provenanceCommandIndex' in command:
        assert isinstance(provenance, list) and isinstance(command['provenanceCommandIndex'], int)
        provenance = provenance[command['provenanceCommandIndex']]
    assert command['schemaVersion'] == 1 and command['type'] == 'body-acceptance-command'
    assert command['nodeId'] == approval['nodeId'] and command['argv'] == provenance['argv']
    assert command['exitCode'] == provenance.get('exit', provenance.get('exitCode')) == 0
    assert command['cwd'] == provenance['cwd']
    context = next(r for r in inspection['commandContexts'] if r['name'] == command['name'])
    assert command['sourceBefore'] == context['sourceBefore'] and command['sourceAfter'] == context['sourceAfter']
    if 'sourceBefore' in provenance:
        assert command['sourceBefore'] == provenance['sourceBefore'] and command['sourceAfter'] == provenance['sourceAfter']
    else:
        source_manifest = read(bound(command['provenanceSourceManifest']))
        source_map = {r['file']: r['sha256'] for r in source_manifest['currentSources']}
        stability = read(bound(command['sourceStability']))
        assert stability['allMatch'] and {r['file']: r['sha256'] for r in stability['sources']} == source_map
        assert command['sourceBefore'] == command['sourceAfter'] == source_map
    original_manifest = bound(inspection['originalReviewManifest'])
    assert command['log'] == ref(original_manifest.parent / provenance['log'])
    if provenance.get('logSha256'): assert command['log']['sha256'] == provenance['logSha256']
    for path, digest in command['sourceBefore'].items(): assert sha(ROOT / path) == digest, path
    for file in context['argvInputFiles'] + context['configurationFiles']: bound(file)
print(json.dumps({'nodeId': approval['nodeId'], 'allMatch': True, 'approval': ref(OUT / 'approval.json'),
    'review': ref(OUT / 'review.json'), 'sources': len(approval['sourceContractHashes']),
    'commands': len(approval['commandReceipts']), 'requiredReruns': inspection['requiredProductReruns']}))
