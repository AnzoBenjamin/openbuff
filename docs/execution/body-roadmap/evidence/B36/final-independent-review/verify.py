#!/usr/bin/env python3
"""Independent B36 receipt countersignature; never execute or rewrite prior checks."""
import datetime
import difflib
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[5]
BASE = HERE.parent
CURRENT = BASE / 'current-independent-review'
B02 = BASE.parent / 'B02/final-binding'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def write(name, value):
    (HERE / name).write_text(json.dumps(value, indent=2) + '\n')


seals = {
    CURRENT / 'manifest.json': 'eb310be784b27ae3b63af67bcedf320961550385997e443d8273435a1f4fba92',
    BASE / 'final-binding/manifest.json': 'd22be7639a4bfd6064d84b51da0b976acb4fdd9390b16ddd09fd6f6b3b8ac03b',
    BASE / 'independent-review/manifest-check.json': 'e856d4eab30d69db7055f7b4c760f72a8c187176744ae54bf55c87faff9a8fb1',
    B02 / 'manifest.json': '95901b10a4d4350f6392bf2f315f9f5b0dcd8925cfb427b9cf94f2ae57afcafa',
}
for path, digest in seals.items():
    assert sha(path) == digest, str(path)
current = read(CURRENT / 'manifest.json')
refresh = read(BASE / 'final-binding/manifest.json')
original = read(BASE / 'independent-review/manifest-check.json')
b02 = read(B02 / 'manifest.json')
assert original['reviewer'] == '/root/b03_mutation_evidence'
assert current['independence']['originalImplementationAuthoredByCurrentReviewer']
assert not current['independence']['newFullCardIndependentApproval']
assert b02['recommendation'] == 'approve_bounded_B02_outcome_tier_after_cancellation_followup'

# Snapshot every pre-existing B36 evidence file before any reconstruction output.
preserved = {
    str(p.relative_to(ROOT)): sha(p)
    for p in sorted(BASE.rglob('*'))
    if p.is_file() and HERE not in p.parents
}
bound_artifacts = {}


def bind(path, digest):
    actual = sha(path)
    assert actual == digest, str(path)
    bound_artifacts[str(path.relative_to(ROOT))] = actual


for path, digest in seals.items():
    bind(path, digest)
bind(BASE / 'manifest.json', original['producerManifestHash'])
for directory, manifest in [(CURRENT, current), (BASE / 'final-binding', refresh), (B02, b02)]:
    for name, digest in manifest['artifacts'].items():
        bind(directory / name, digest)
for entry in original['independentArtifacts']:
    bind(BASE / 'independent-review' / entry['file'], entry['sha256'])
for entry in original['producerArtifactChecks']:
    bind(BASE / entry['file'], entry['expected'])
for entry in current['priorArtifactChecks']:
    bind(ROOT / entry['path'], entry['sha256'])

sources = current['sourceHashes']
assert len(sources) == 15
assert sources == refresh['sourceHashes']
source_checks = []
original_sources = {entry['file']: entry['actual'] for entry in original['sourceChecks']}
assert set(original_sources) == set(sources)
for name, digest in sources.items():
    actual = sha(ROOT / name)
    assert actual == digest, name
    source_checks.append({
        'path': name, 'currentSha256': actual,
        'priorFinalBindingSha256': refresh['sourceHashes'][name],
        'originalIndependentSha256': original_sources[name],
        'matchesPriorFinalBinding': True,
        'matchesOriginalIndependent': actual == original_sources[name],
    })
assert [row['path'] for row in source_checks if not row['matchesOriginalIndependent']] == ['sdk/src/run.ts']
assert sources['sdk/src/run.ts'] == b02['sourceHashes']['sdk/src/run.ts']
# Supporting B02 source hashes are integrity checks, not approval of those cards.
for name, digest in b02['sourceHashes'].items():
    assert sha(ROOT / name) == digest, name

# Independently apply the sealed original integration patch to its Git preimage.
# Exact context/removal matching rejects fuzz or guessed snapshot reconstruction.
patch_path = BASE / 'independent-review/current-integration.diff'
patch = patch_path.read_text()
assert sha(patch_path) == original['integrationPatchHash']
section = re.split(r'(?m)^diff --git ', patch.split('diff --git a/sdk/src/run.ts b/sdk/src/run.ts\n', 1)[1], maxsplit=1)[0]
preimage_blob = re.search(r'^index ([0-9a-f]+)\.\.', section, re.M).group(1)
preimage = subprocess.check_output(['git', 'cat-file', 'blob', preimage_blob], cwd=ROOT)
old_lines = preimage.decode().splitlines(keepends=True)
out = []
cursor = 0
hunks = re.split(r'(?m)^@@ ', section)[1:]
for hunk in hunks:
    header, body = hunk.split('\n', 1)
    old_start, old_count, new_start, new_count = re.match(r'-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', header).groups()
    position = int(old_start) - 1
    assert cursor <= position
    out.extend(old_lines[cursor:position])
    cursor = position
    removed = added = 0
    for line in body.splitlines(keepends=True):
        if line.startswith('\\ No newline') or not line:
            continue
        kind, content = line[0], line[1:]
        assert kind in ' +-'
        if kind in ' -':
            assert old_lines[cursor] == content, (header, cursor)
            cursor += 1
            removed += 1
        if kind in ' +':
            out.append(content)
            added += 1
    assert removed == int(old_count or '1')
    assert added == int(new_count or '1')
out.extend(old_lines[cursor:])
reconstructed = ''.join(out)
reconstructed_sha = hashlib.sha256(reconstructed.encode()).hexdigest()
assert reconstructed_sha == original_sources['sdk/src/run.ts']
assert reconstructed.encode() == (CURRENT / 'prior-reviewed-run.ts').read_bytes()
(HERE / 'reconstructed-prior-run.ts').write_text(reconstructed)
delta = ''.join(difflib.unified_diff(
    reconstructed.splitlines(keepends=True),
    (ROOT / 'sdk/src/run.ts').read_text().splitlines(keepends=True),
    fromfile='prior-independently-reviewed/sdk/src/run.ts',
    tofile='current/sdk/src/run.ts',
))
assert delta == (CURRENT / 'shared-integration-delta.diff').read_text()
assert len(re.findall(r'^@@ ', delta, re.M)) == 5
(HERE / 'independently-reconstructed-delta.diff').write_text(delta)

commands = []
for name in ['integration-tests', 'fixture', 'sdk-typecheck']:
    receipt_path = CURRENT / (name + '.json')
    receipt = read(receipt_path)
    assert receipt['exit'] == 0
    assert receipt['sourceBefore'] == receipt['sourceAfter'] == sources
    assert receipt['sourceUnchangedDuringCommand']
    assert '--no-env-file' in receipt['argv']
    assert receipt['environment']['replacement']
    assert not receipt['environment']['bunEnvFileLoading']
    assert receipt['environment']['keys'] == ['HOME', 'LANG', 'NEXT_PUBLIC_CB_ENVIRONMENT', 'OPENBUFF_PROVIDER_CONFIG', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME']
    assert receipt['bun']['version'] == '1.3.5'
    assert receipt['bun']['sha256'] == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
    assert sha(pathlib.Path(receipt['bun']['path'])) == receipt['bun']['sha256']
    assert sha(CURRENT / receipt['log']) == receipt['logSha256']
    assert (CURRENT / (name + '.exit')).read_text().strip() == '0'
    assert datetime.datetime.fromisoformat(receipt['finishedAt']) > datetime.datetime.fromisoformat(receipt['startedAt'])
    commands.append({
        'receipt': str(receipt_path.relative_to(ROOT)), 'sha256': sha(receipt_path),
        'producer': '/root/b04_lock_cas', 'independentlyRerun': False,
        'argv': receipt['argv'], 'startedAt': receipt['startedAt'],
        'finishedAt': receipt['finishedAt'], 'exit': 0,
        'bun': receipt['bun'], 'logSha256': receipt['logSha256'],
    })
assert read(CURRENT / 'fixture-config.json') == {'providers': {}, 'autoFileChangeHooks': False, 'fileChangeHooks': []}
log = (CURRENT / 'integration-tests.log').read_text()
counts = re.findall(r'\n\s+(\d+) pass\n\s+(\d+) fail\n\s+(\d+) expect\(\) calls', log)
assert counts == [('22', '0', '143')]
assert len(re.findall(r'^\(pass\) ', log, re.M)) == 22
assert 'Ran 22 tests across 1 file.' in log
assert '$ tsc --noEmit -p .' in (CURRENT / 'sdk-typecheck.log').read_text()

# Independent explicit oracle; do not import or execute the producer's oracle.
expected = {
    'empty': ('passed', 'passed', 2),
    'preexisting': ('passed', 'passed', 2),
    'shifted': ('passed', 'passed', 2),
    'severity-escalation': ('new_errors', 'failed', 2),
    'timeout': ('failed', 'failed', 2),
    'exit127': ('unavailable', 'unknown', 2),
    'cancelled': ('cancelled', 'failed', 1),
    'missing-tool': ('unavailable', 'unknown', 2),
    'missing-language': ('unavailable', 'unknown', 0),
    'capped': ('incomplete', 'unknown', 2),
    'partial': ('unknown', 'unknown', 2),
    'unknown': ('unknown', 'unknown', 0),
}
observation = read(CURRENT / 'sdk-client-observations.json')
records = observation['records']
assert len(records) == 12 and {row['name'] for row in records} == set(expected)
assert observation['toolchain']['executable'] == commands[1]['bun']['path']
fixture_receipt = read(CURRENT / 'fixture.json')
assert datetime.datetime.fromisoformat(fixture_receipt['startedAt']) <= datetime.datetime.fromisoformat(observation['startedAt'])
assert datetime.datetime.fromisoformat(observation['finishedAt']) <= datetime.datetime.fromisoformat(fixture_receipt['finishedAt'])
case_checks = []
indexed = {}
for row in records:
    name = row['name']
    status, classification, launches = expected[name]
    diagnostic = next(z for z in row['sdkOutput'][0]['value'] if z.get('hookName') == 'diagnostic-delta')
    assert row['expectedStatus'] == diagnostic['diagnosticStatus'] == status, name
    assert row['clientClassification'] == classification and row['launches'] == launches, name
    assert status == 'passed' or classification != 'passed', name
    indexed[name] = (row, diagnostic)
    case_checks.append({'name': name, 'sdkDiagnosticStatus': status, 'cliClassification': classification, 'launches': launches, 'match': True})
for name in ['empty', 'preexisting', 'shifted', 'severity-escalation']:
    row, diagnostic = indexed[name]
    for side in ['before', 'after']:
        assert diagnostic['observations'][side]['coverage']['status'] == 'complete'
empty = indexed['empty'][1]['observations']
assert not empty['before']['diagnostics'] and not empty['after']['diagnostics']
assert all(c['exitCode'] == 0 and c['stdoutBytes'] == 0 for c in indexed['empty'][0]['commandResults'])
preexisting = indexed['preexisting'][1]['observations']
assert preexisting['before']['diagnostics'] == preexisting['after']['diagnostics']
assert preexisting['after']['diagnostics'][0]['severity'] == 'error'
shifted = indexed['shifted'][1]['observations']
assert shifted['before']['diagnostics'][0]['range']['start']['line'] == 1
assert shifted['after']['diagnostics'][0]['range']['start']['line'] == 5
escalated = indexed['severity-escalation'][1]
assert escalated['observations']['before']['diagnostics'][0]['severity'] == 'warning'
assert escalated['observations']['after']['diagnostics'][0]['severity'] == 'error'
assert len(escalated['newDiagnostics']) == 1
assert all(c['timedOut'] for c in indexed['timeout'][0]['commandResults'])
assert all(c['exitCode'] == 127 for c in indexed['exit127'][0]['commandResults'])
assert indexed['cancelled'][0]['commandResults'][0]['cancelled']
assert all('ENOENT' in c['errorMessage'] for c in indexed['missing-tool'][0]['commandResults'])
assert indexed['missing-language'][0]['commandResults'] == []
assert all(c['outputTruncated'] and c['stdoutBytes'] == 2097152 for c in indexed['capped'][0]['commandResults'])
assert all(c['exitCode'] == 0 and c['stdoutBytes'] == 10 for c in indexed['partial'][0]['commandResults'])
assert all('exitCode' not in c for c in indexed['unknown'][0]['commandResults'])

approval_receipt = read(B02 / 'approval-cancellation.json')
assert approval_receipt['exit'] == 0 and approval_receipt['sourceUnchangedDuringCommand']
assert approval_receipt['sourceBefore']['sdk/src/run.ts'] == sources['sdk/src/run.ts']
assert approval_receipt['sourceAfter']['sdk/src/run.ts'] == sources['sdk/src/run.ts']
assert sha(B02 / approval_receipt['log']) == approval_receipt['logSha256']
approvals = read(B02 / 'approval-cancellation/observations.json')
assert approvals['providerCalls'] == 0 and len(approvals['observations']) == 7
cancelled = next(z for z in approvals['observations'] if z['name'] == 'approval_cancelled')
assert cancelled['runOutcome']['termination'] == 'cancelled'
assert cancelled['trace'] == '' and cancelled['approvalRecords'] == []
assert [z['outcome'] for z in cancelled['actionOutcomes']] == ['cancelled']
for row in approvals['observations']:
    for grant in row['approvalRecords']:
        assert grant['consumedAt'] and grant['executionContextHash'] == row['approvals'][0]['executionContextHash']

# Finish with an integrity sweep after all independent reconstruction work.
for name, digest in sources.items():
    assert sha(ROOT / name) == digest, name
for name, digest in preserved.items():
    assert sha(ROOT / name) == digest, name
for name, digest in bound_artifacts.items():
    assert sha(ROOT / name) == digest, name
result = {
    'schemaVersion': 1, 'card': 'B36', 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'passed', 'decision': 'approve',
    'method': 'independent hash, exact patch reconstruction, source/delta and hardcoded receipt-oracle review; no test/typecheck/fixture reruns',
    'sourceChecks': source_checks,
    'reconstruction': {'preimageBlob': preimage_blob, 'preimageSha256': hashlib.sha256(preimage).hexdigest(), 'integrationPatchSha256': sha(patch_path), 'appliedHunks': len(hunks), 'reconstructedPriorSha256': reconstructed_sha, 'currentSha256': sources['sdk/src/run.ts'], 'deltaSha256': sha(HERE / 'independently-reconstructed-delta.diff'), 'deltaHunks': 5, 'b02SealMatch': True},
    'reusedCommands': commands, 'freshRecordedTests': {'pass': 22, 'fail': 0, 'assertions': 143, 'files': 1, 'independentlyRerun': False},
    'diagnosticCases': case_checks, 'actualChildLaunches': sum(z['launches'] for z in case_checks),
    'sdkTypecheckExit': 0, 'supportingB02ApprovalCases': 7, 'b02ApprovalCancellationVerified': True,
    'historicalCountsNotRerun': {'originalIndependentTests': 188, 'postimageControls': 10},
    'sealedArtifactHashes': bound_artifacts,
    'priorB36EvidenceHashes': preserved, 'allPriorB36EvidencePreserved': True,
    'independentlyExecutedProductChecks': 0,
    'authorship': {'reviewer': '/root/b03_mutation_evidence', 'authoredOriginalIndependentB36Review': True, 'authoredB36Implementation': False, 'authoredRootSharedRunDelta': False, 'authoredB01TailStore': True, 'approvesB01TailStore': False},
}
write('verification.json', result)
print(json.dumps({'decision': 'approve', 'sources': len(source_checks), 'sealedArtifacts': len(bound_artifacts), 'preservedB36Files': len(preserved), 'cases': len(case_checks), 'recordedTests': 22, 'recordedAssertions': 143, 'productChecksRerun': 0}))
