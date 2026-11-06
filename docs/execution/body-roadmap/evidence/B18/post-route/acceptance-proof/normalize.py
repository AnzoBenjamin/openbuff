"""Normalize already closed, independently approved evidence; never run products."""
from pathlib import Path
import datetime, hashlib, json, sys

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'sdk').is_dir() and (p / 'docs/execution/body-roadmap').is_dir())
INPUT = OUT / 'normalization-inputs.json'

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def ref(path):
    path = Path(path).resolve()
    assert path.is_file() and path.resolve().is_relative_to(ROOT.resolve()), path
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}

def checked(row):
    path = ROOT / row['path']
    assert sha(path) == row['sha256'], 'Artifact drift: ' + row['path']
    return path

def source_check(sources):
    assert sources
    for path, digest in sources.items():
        assert sha(ROOT / path) == digest, 'Source drift: ' + path

def sources_from(manifest):
    return manifest.get('sourceHashes') or {row['file']: row['sha256'] for row in manifest['currentSources']}

def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

inputs = json.loads(INPUT.read_text())
manifest_path = checked(inputs['manifest'])
manifest = json.loads(manifest_path.read_text())
sources = sources_from(manifest)
source_check(sources)

def original_command(provenance, command_index=None):
    path = checked(provenance)
    value = json.loads(path.read_text())
    if command_index is not None:
        assert isinstance(command_index, int) and isinstance(value, list)
        value = value[command_index]
    return value

def command_sources(original):
    if 'sourceBefore' in original:
        before, after = original['sourceBefore'], original['sourceAfter']
        method = 'Exact unchanged sourceBefore/sourceAfter maps in original command receipt'
    else:
        stability = json.loads(checked(inputs['sourceStability']).read_text())
        assert stability['allMatch']
        frozen = {row['file']: row['sha256'] for row in stability['sources']}
        assert frozen == sources
        before = after = sources
        method = 'Frozen final-review currentSources and unchanged source-stability evidence; original command is a manifest entry'
    assert before == after
    source_check(before)
    assert all(before.get(path) == digest for path, digest in sources.items())
    return before, after, method

if '--check' in sys.argv:
    review = json.loads((OUT / 'review.json').read_text())
    assert review['schemaVersion'] == 1 and review['type'] == 'body-implementation-review'
    assert review['nodeId'] == inputs['nodeId'] and review['decision'] == 'approve'
    assert review['reviewer'] == '/root/b02_runtime_outcomes'
    assert review['implementationOwners'] == inputs['implementationOwners']
    assert review['independent'] and review['reviewer'] not in review['implementationOwners']
    assert review['sourceContractHashes'] == sources and review['provenance'] == inputs['manifest']
    assert review['scope'] == inputs['scope']
    for row in review['artifacts']:
        checked(row)
    for row in review['commandReceipts']:
        command = json.loads(checked(row).read_text())
        assert command['type'] == 'body-acceptance-command' and command['schemaVersion'] == 1
        assert command['nodeId'] == review['nodeId'] and command['exitCode'] == 0
        original = original_command(command['provenance'], command.get('provenanceCommandIndex'))
        assert command['argv'] == original['argv']
        assert command['exitCode'] == original.get('exit', original.get('exitCode'))
        before, after, method = command_sources(original)
        assert command['sourceBefore'] == before and command['sourceAfter'] == after
        log = manifest_path.parent / original['log']
        assert command['log'] == ref(log)
        checked(command['log'])
    print(json.dumps({'nodeId': review['nodeId'], 'review': ref(OUT / 'review.json'), 'allMatch': True,
        'sourceCount': len(sources), 'commandCount': len(review['commandReceipts']), 'sealedArtifactCount': len(review['artifacts'])}))
    raise SystemExit(0)

assert '--create' in sys.argv, 'Use --create once or --check read-only'
assert not (OUT / 'review.json').exists(), 'Never overwrite an authoritative review'
assert inputs['implementationOwners'] and '/root/b02_runtime_outcomes' not in inputs['implementationOwners']
artifacts = {}
visited = set()

def seal(path, expected=None):
    row = ref(path)
    if expected: assert row['sha256'] == expected, 'Historical artifact drift: ' + row['path']
    if row['path'] in artifacts: assert artifacts[row['path']] == row['sha256']
    artifacts[row['path']] = row['sha256']
    return row

def artifact_path(base, name):
    relative = Path(name)
    assert not relative.is_absolute()
    return ROOT / relative if relative.parts[0] in ['docs', '.agents', 'scripts', 'sdk', 'common', 'cli', 'packages', 'evals'] else base / relative

def seal_manifest(path, expected=None):
    seal(path, expected)
    if str(path.relative_to(ROOT)) in [row['manifest']['path'] for row in inputs.get('uncreditedHistoricalContext', [])]:
        return
    if path in visited: return
    visited.add(path)
    value = json.loads(path.read_text())
    base = path.parent
    for field in ['artifacts', 'evidence', 'boundEvidence', 'preservedArtifacts']:
        rows = value.get(field, [])
        if isinstance(rows, dict): rows = [{'file': name, 'sha256': digest} for name, digest in rows.items()]
        for row in rows:
            child = artifact_path(base, row.get('file', row.get('path')))
            seal(child, row['sha256'])
            if child.name == 'manifest.json': seal_manifest(child, row['sha256'])
    for field in ['producerManifest', 'priorReviewManifest']:
        if value.get(field):
            digest = value.get(field + 'Hash') or value.get(field + 'Sha256')
            seal_manifest(ROOT / value[field], digest)
    if value.get('runner'): seal(ROOT / value['runner']['file'], value['runner']['sha256'])

seal_manifest(manifest_path, inputs['manifest']['sha256'])
for row in inputs.get('additionalHistoricalManifests', []): seal_manifest(checked(row), row['sha256'])
for row in inputs.get('additionalProvenance', []): seal(checked(row), row['sha256'])
if inputs.get('sourceStability'): seal(checked(inputs['sourceStability']))
command_refs = []
(OUT / 'commands').mkdir()
for specification in inputs['commands']:
    provenance = specification['provenance']
    original = original_command(provenance, specification.get('commandIndex'))
    seal(checked(provenance))
    assert original.get('exit', original.get('exitCode')) == 0
    log = manifest_path.parent / original['log']
    if original.get('logSha256'): assert sha(log) == original['logSha256']
    before, after, method = command_sources(original)
    normalized = {'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': inputs['nodeId'],
        'name': specification['name'], 'argv': original['argv'], 'exitCode': original.get('exit', original.get('exitCode')),
        'cwd': original['cwd'], 'log': seal(log), 'sourceBefore': before, 'sourceAfter': after,
        'creditedSourceContractHashes': sources, 'sourceBindingDerivation': method, 'provenance': provenance,
        'scope': inputs['scope'], 'closed': True, 'normalizationOnly': True,
        'broaderInputsDoNotWidenImplementationApproval': len(before) > len(sources)}
    if specification.get('commandIndex') is not None: normalized['provenanceCommandIndex'] = specification['commandIndex']
    if inputs.get('sourceStability'):
        normalized['sourceStability'] = inputs['sourceStability']
        normalized['provenanceSourceManifest'] = inputs['manifest']
    for field in ['startedAt', 'finishedAt', 'startedUtc', 'finishedUtc', 'elapsedSeconds', 'environment']:
        if field in original: normalized[field] = original[field]
    output = OUT / 'commands' / (specification['name'] + '.json')
    write(output, normalized)
    command_refs.append(seal(output))

for path in sorted(OUT.rglob('*')):
    if path.is_file(): seal(path)
review = {'schemaVersion': 1, 'type': 'body-implementation-review', 'nodeId': inputs['nodeId'],
    'decision': 'approve', 'reviewer': '/root/b02_runtime_outcomes', 'implementationOwners': inputs['implementationOwners'],
    'independent': True, 'scope': inputs['scope'], 'sourceContractHashes': sources, 'provenance': inputs['manifest'],
    'commandReceipts': command_refs, 'artifacts': [{'path': path, 'sha256': digest} for path, digest in sorted(artifacts.items())],
    'normalizationOnly': True, 'newFullCardOrPrerequisiteApproval': False,
    'approvalAuthority': 'The same reviewer mechanically normalizes the prior bounded approval against its actual unchanged current source bindings and closed evidence.',
    'originalScopeExclusions': inputs['exclusions'], 'independenceDisclosure': inputs['independenceDisclosure'],
    'historicalFailedAttemptDisclosures': inputs['historicalFailedAttemptDisclosures'],
    'uncreditedHistoricalContext': inputs.get('uncreditedHistoricalContext', []),
    'ownerIdentityAuthority': inputs['ownerIdentityAuthority'], 'normalizedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
write(OUT / 'review.json', review)
print(json.dumps({'nodeId': inputs['nodeId'], 'review': ref(OUT / 'review.json'), 'sourceCount': len(sources),
    'commandCount': len(command_refs), 'sealedArtifactCount': len(artifacts)}))
