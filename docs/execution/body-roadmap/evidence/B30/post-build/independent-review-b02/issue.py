"""Issue fresh final seals from executed controls; never mutate the live ledger."""
from pathlib import Path
import datetime
import hashlib
import json

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir())
NODE = OUT.parents[1].name
AUTHOR = '/root/b02_runtime_outcomes'

def read(path):
    return json.loads(Path(path).read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    return {'path': str(Path(path).relative_to(ROOT)), 'sha256': sha(path)}

def references(value):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str) and 'sha256' in value:
            yield value
        for child in value.values():
            yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)

assert NODE in ['B03', 'B30']
assert not (OUT / 'approval.json').exists() and not (OUT / 'review.json').exists()
inputs = read(OUT / 'source-inputs.json')
inspection = read(OUT / 'inspection.json')
run = read(OUT / 'run-results.json')
assert inspection['allCurrentSourceAndContextBindingsMatch'] and run['allControlsPassed']
assert len(inspection['commandReceipts']) == (6 if NODE == 'B03' else 8)
assert len(inputs['sourceContractHashes']) == (83 if NODE == 'B03' else 62)
for name, digest in inputs['sourceContractHashes'].items():
    assert sha(ROOT / name) == digest, name
for row in run['commands']:
    command = read(ROOT / row['path'])
    assert sha(ROOT / row['path']) == row['sha256']
    assert command['exitCode'] == 0 and command['sourceBefore'] == command['sourceAfter']
    for name, digest in command['sourceBefore'].items():
        assert sha(ROOT / name) == digest, name

artifacts = {}
def include(row):
    path = ROOT / row['path']
    assert path.is_file() and sha(path) == row['sha256'], row['path']
    assert row['path'] not in artifacts or artifacts[row['path']] == row
    artifacts[row['path']] = row

for path in sorted(OUT.rglob('*')):
    if path.is_file() and '__pycache__' not in path.parts:
        include(ref(path))
for value in [inputs, inspection]:
    for row in references(value):
        include(row)
# Seal historical original maps/logs and issued counterpart reviews without
# changing their recorded inputs or granting them current command credit.
historical = inspection['historicalEvidence'] + inspection.get('historicalAttempts', [])
for row in historical:
    path = ROOT / row['path']
    if path.suffix != '.json':
        continue
    document = read(path)
    if document.get('log'):
        include(document['log'])
    if document.get('provenance'):
        include(document['provenance'])
    if path.name == 'approval.json' and (path.parent / 'review.json').is_file():
        include(ref(path.parent / 'review.json'))
post3d = ROOT / 'docs/execution/body-roadmap/evidence' / NODE / 'post-3D-context/independent-review-b02'
for filename in ['inspection-initial.py', 'inspection-initial-failure.json', 'inspect.py', 'inspection.json', 'SOURCE-REVIEW.md', 'run.py', 'dependency-scope.py', 'dependency-scope.json']:
    path = post3d / filename
    if path.is_file():
        include(ref(path))
build = read(ROOT / inputs['finalBuildContext']['receipt']['path'])
if build.get('log'):
    include({'path': build['log'], 'sha256': build['logSha256']} if isinstance(build['log'], str) else build['log'])

limits = [
    'No independent implementation approval of reviewer-authored B02/B08 prerequisites or unrelated guard/perf/indexer repairs; hashes bind command/dependency context only.',
    'B01 shipped-base2 integration and live ledger/card promotion are excluded.',
    'No universal arbitrary-host receipt authentication, OS filesystem/network exclusion, crash reclamation or universal descendant cleanup.',
    'No installed/native assurance, real provider/billing admission, task acceptance or held-out empirical learning/improvement claim.',
    'Historical maps, approvals, author quality commands and failed packaging attempts receive no current command credit.',
    'Source dependency binding is bounded static/explicit dynamic traversal, not universal loader tracing; external versions are lock/manifest-bound.',
]
scope = (
    'B03 current source SDK mutation authority, controlled filesystem, journal, JSON/headless/CLI/ACP tier after settled root build; 83 accepted contracts and six fresh actual-source controls; unchanged assurance limits.'
    if NODE == 'B03' else
    'B30 current controlled process/environment/accounting/artifact isolation after falsy-cause/empty-error/attempt-identity cleanup and comparator eligibility/finite-cost repair, following settled root build; 62 accepted contracts and eight fresh actual-source controls; unchanged assurance limits.'
)
common = {
    'schemaVersion': 1, 'nodeId': NODE, 'reviewer': AUTHOR,
    'implementationOwners': ['/root/b03_mutation_evidence', '/root', '/root/b04_lock_cas'] if NODE == 'B03' else ['/root', '/root/b03_mutation_evidence'],
    'independent': True, 'decision': 'approve', 'scope': scope,
    'scopeLimits': limits, 'sourceContractHashes': inputs['sourceContractHashes'],
    'commandReceipts': inspection['commandReceipts'],
    'artifacts': [artifacts[name] for name in sorted(artifacts)],
    'supportingEvidence': [{'role': role, 'evidence': ref(OUT / filename)} for filename, role in [
        ('inspection.json', 'Fresh original source maps, immutable lineage and independent persisted oracle inspection'),
        ('SOURCE-REVIEW.md', 'Attributable current source findings, controls and explicit assurance limits'),
        ('dependency-scope.json', 'Actual-root dependency reasons; all accepted contracts directly bound; no retroactive map trimming'),
        ('assessment.json', 'Independent byte or artifact/isolation replay'),
    ]],
    'independenceDisclosure': 'Reviewer made no implementation/test edits for this node and is outside all listed owners. Earlier reviewer-authored B02/B08 and unrelated repairs receive no independent implementation approval.',
    'historicalFailedAttemptDisclosures': [
        'Former missing /tmp and initial count/output packaging attempts remain historical; original maps and failures are preserved.',
        'Bun --isolate process-exit assumptions were corrected in the harness with test afterAll; historical attempts remain uncredited.',
        'Prior broad maps became historical after unrelated 3D test drift and root CLI generation. Earlier arbitrary prompt/path-literal edges bound the old bundle; no original map was trimmed or rewritten.',
        'B30 post-3D inspection path failure, partial normalizations and subsequent build drift remain preserved. This new decision uses only fresh post-build controls.',
    ] + (['Initial B03 final seal packaging stopped before approval because the build log was a string path rather than an object ref. The exact runner/failure is retained; packaging now binds the recorded logSha256 without rerunning or replacing controls.'] if NODE == 'B03' else []),
    'uncreditedHistoricalContext': historical,
    'finalBuildContext': inputs['finalBuildContext'],
    'requiredProductReruns': [], 'productEditsMade': False,
    'productCommandsRerun': True,
    'reviewBasis': 'New attributable post-build independent decision from exact fresh original command/source maps and independent persisted oracle replay; historical approvals are not reused.',
    'issuedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
approval = {'type': 'body-independent-approval', **common}
(OUT / 'approval.json').write_text(json.dumps(approval, indent=2) + '\n')
review = {'type': 'body-implementation-review', **common, 'provenance': ref(OUT / 'approval.json')}
(OUT / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
print(json.dumps({'nodeId': NODE, 'sources': len(common['sourceContractHashes']), 'commands': len(common['commandReceipts']), 'artifacts': len(common['artifacts']), 'approval': ref(OUT / 'approval.json'), 'review': ref(OUT / 'review.json')}))
