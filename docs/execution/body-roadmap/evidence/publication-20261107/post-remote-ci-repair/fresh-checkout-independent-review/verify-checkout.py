#!/usr/bin/env python3
"""Bounded read-only verification of the repaired staged materialization."""
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

if not __debug__:
    raise RuntimeError('Run checkout verification without Python optimization')
OUT = Path(__file__).resolve().parent
BASE = OUT.parent
PUB = BASE.parent
ROOT = OUT.parents[6]
TREE = Path('/tmp/openbuff-remote-ci-repair-index-7j_asiof')
PARENT_REPORT = BASE / 'checkouts/cfbcbbb500db/report.json'
EXPECTED_INDEX = '1572d282f8bebdefd69a118ca5aa802abdff2ae13a102511e3b25c981b37d8ad'
EXPECTED_LEDGER = 'fe0e337cb0675613310f1b86dd58d823f187e0672b0ea5b8a4a8060121f7e83c'
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
EXPECTED_DELTA = '73fa66f24bbdb2407e482d894f5fbca21195aa4893da952b7ad7b31dbff5992f'
EXPECTED_VALIDATOR = '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def binding(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'bytes': path.stat().st_size}


def index_bytes():
    return subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=ROOT, capture_output=True, check=True).stdout


def write_json(name, value):
    with (OUT / name).open('x') as output:
        json.dump(value, output, indent=2)
        output.write('\n')


parent = json.loads(PARENT_REPORT.read_text())
require(sha(PARENT_REPORT) == 'b79d16c477615b6bbea521fe5002723591b3580cb250b071813a23b930241275', 'Parent report changed')
require(parent['destination'] == str(TREE) and parent['passed'], 'Unexpected parent result')
before = index_bytes()
require(hashlib.sha256(before).hexdigest() == EXPECTED_INDEX == parent['stagedIndexSha256'], 'Staged index differs from reviewed materialization')
with (OUT / 'reviewed-index.final.nul.gz').open('xb') as output:
    output.write(gzip.compress(before, mtime=0))
inventory_path = PUB / 'curated-required-files.json'
delta_path = BASE / 'required-path-delta.json'
require(sha(inventory_path) == EXPECTED_INVENTORY, 'Historical inventory changed')
require(sha(delta_path) == EXPECTED_DELTA, 'Repair delta changed')
inventory = json.loads(inventory_path.read_text())
delta = json.loads(delta_path.read_text())
expected_delta = {
    'scripts/memory-drift-guard.ts': 'c106b63b9e163d16e123efc4959ea47a75aaeeee0f255ec16069a4e7b63e7929',
    'scripts/__tests__/memory-drift-guard.test.ts': 'b62f546c8f630618b68c02711f6d91cf452bb823ac32a1eed0f82e55ee820085',
    'docs/execution/body-roadmap/ledger.json': EXPECTED_LEDGER,
}
overrides = {entry['path']: entry for entry in delta['changes']}
require(len(delta['changes']) == len(overrides) == 3 and {path: entry['sha256'] for path, entry in overrides.items()} == expected_delta, 'Unexpected required-path override')
required = {entry['path']: entry for entry in inventory['files']}
require(len(required) == len(inventory['files']) == 2644, 'Unexpected inventory membership')
require(delta['historicalInventory'] == {'path': str(inventory_path.relative_to(ROOT)), 'sha256': EXPECTED_INVENTORY}, 'Delta inventory binding differs')
require(delta['candidate']['sha256'] == EXPECTED_LEDGER, 'Delta candidate is not approved')
for path, override in overrides.items():
    require(override['previousSha256'] == required[path]['sha256'], 'Override does not bind original historical hash')
require(sha(ROOT / 'docs/execution/body-roadmap/ledger.json') == EXPECTED_LEDGER, 'Live ledger is not approved candidate')
require((ROOT / delta['candidate']['path']).read_bytes() == (TREE / 'docs/execution/body-roadmap/ledger.json').read_bytes(), 'Materialized ledger differs from exact approved candidate')

staged = []
for raw in before.split(b'\0'):
    if not raw:
        continue
    metadata, encoded_path = raw.split(b'\t', 1)
    mode, oid, stage = metadata.decode().split()
    path = encoded_path.decode()
    target = TREE / path
    require(stage == '0' and mode in {'100644', '100755', '120000'}, 'Unmerged/Gitlink/unsupported entry: ' + path)
    if mode == '120000':
        require(target.is_symlink(), 'Missing staged symlink: ' + path)
        payload = os.readlink(target).encode()
    else:
        require(target.is_file() and not target.is_symlink(), 'Missing or nonregular staged file: ' + path)
        payload = target.read_bytes()
        require(bool(target.stat().st_mode & 0o111) == (mode == '100755'), 'Materialized executable mode differs: ' + path)
    actual_oid = hashlib.sha1(b'blob ' + str(len(payload)).encode() + b'\0' + payload).hexdigest()
    require(actual_oid == oid, 'Materialized content differs from Git blob: ' + path)
    staged.append({'path': path, 'mode': mode, 'gitBlobOid': oid, 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)})
require(len(staged) == 5146, 'Unexpected staged entry count')

by_path = {row['path']: row for row in staged}
smoke = by_path['rust/scripts/smoke-test-sidecar.sh']
require(smoke['mode'] == '100755' and smoke['gitBlobOid'] == '28b9401810fce5ace2008c7ee6574943e44bc411'
        and smoke['sha256'] == '4e14f7277fff234942723c0c22399b8f66bf24b098c1797d6eb3341524f0ee81', 'Smoke script does not match approved bytes/mode')
require(by_path['.github/workflows/rust-workspace.yml']['sha256'] == '0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3', 'Workflow differs from approval')
changed_paths = subprocess.check_output(['git', 'diff', '--cached', '--name-only', '-z'], cwd=ROOT).decode().split('\0')
changed_paths = [path for path in changed_paths if path]
repair_prefix = str(BASE.relative_to(ROOT)) + '/'
ordinary = {'scripts/memory-drift-guard.ts', 'scripts/__tests__/memory-drift-guard.test.ts',
            '.github/workflows/rust-workspace.yml', 'rust/scripts/smoke-test-sidecar.sh',
            'docs/execution/body-roadmap/ledger.json', 'docs/execution/body-roadmap/STATE.md'}
require({path for path in changed_paths if not path.startswith(repair_prefix)} == ordinary,
        'Staged delta contains unexpected source/state paths')
require(all(path in by_path for path in changed_paths), 'Staged deletion is outside authorized repair')
encoded = json.dumps({'indexSha256': EXPECTED_INDEX, 'files': staged}, sort_keys=True).encode()
with (OUT / 'materialized-staged-bindings.final.json.gz').open('xb') as output:
    output.write(gzip.compress(encoded, mtime=0))


def verify_required():
    for path, historical in required.items():
        expected = overrides.get(path, historical)
        target = TREE / path
        require(target.is_file() and not target.is_symlink(), 'Missing/nonregular inventory path: ' + path)
        require(sha(target) == expected['sha256'] and target.stat().st_size == expected['bytes'], 'Inventory/delta mismatch: ' + path)


verify_required()
protected_expected = {
    inventory_path: EXPECTED_INVENTORY,
    delta_path: EXPECTED_DELTA,
    ROOT / 'docs/execution/body-roadmap/ledger.json': EXPECTED_LEDGER,
    ROOT / 'docs/execution/body-roadmap/validate-ledger.py': EXPECTED_VALIDATOR,
    PUB / 'archive/sealed-evidence.tar.gz': '301f2e8ef2e17a1b0416b54b907328b186947fd5f76f261ee7457ddcc66e4271',
    PUB / 'archive/rehydrate.py': '3fbf1b955b018357f6758cccf698eaf283511916c11273347d887027bdd51871',
    PUB / 'git-fixture/sealed-git-fixture.tar.gz': 'f298550c8f8f24965d9be2fd707cf6e0261716a33cce77ba1a49f7673de3b531',
    PUB / 'git-fixture/rehydrate.py': 'f936c122fef9f6a86f86a6f529f14882795198cd46f236dd3e62c34a102bab6f',
    PUB / 'independent-review/archive-review-manifest.json': '8ddb0289f2bc1f76b79faf6f7a36ac0f1151b31ecb530e34c116eaa9115bfe81',
    PUB / 'independent-review/fresh-checkout/review-manifest.json': '92b3cbe5345881cddf9efbfbcc9199e48ff96fb0cd9cc2348227c07b2a4eb528',
    BASE / 'independent-review/manifest.json': '692ed8c437ae2629e3a8f47d72a376602690e14427cd8d4ea9cc32c733aa4c5d',
    BASE / 'acceptance-independent-review/manifest.json': '5d1706fe76b9cb5c9ef18f3cbbdf6d2a82111645db8a9ae2c154dda8d144e48f',
}
protected_expected.update({
    BASE / 'independent-review/smoke-script-review/manifest.json': 'c615e296221f06c5826021f066cda20f051406520419b68862dba76967908c75',
    PUB / 'archive/archive-manifest.checked.json': '10cd5954b23ded435418e101f3f3c1ba17f1e10bb176a70dc11c992882505903',
    PUB / 'post-commit-ci-repair/required-path-delta.json': '4450aed4a38b1630fe5715ddf6cb00785a5e718475dcb35c9a06c49e557fc30e',
})
restored = []
permission_adjustments = []
allowed_permission_adjustments = {
    "node_modules/typescript/bin/tsc": (0o777, 0o755),
    "node_modules/typescript/lib/tsc.js": (0o666, 0o644),
}
for relative, count in [('archive/archive-manifest.checked.json', 186), ('git-fixture/manifest.json', 27)]:
    manifest_path = PUB / relative
    manifest = json.loads(manifest_path.read_text())
    require(len(manifest['files']) == count, 'Unexpected restoration manifest count')
    for row in manifest['files']:
        target = TREE / row['path']
        require(target.is_file() and not target.is_symlink(), 'Restored path is missing/nonregular')
        require(sha(target) == row['sha256'] and target.stat().st_size == row['bytes'], 'Restored bytes differ')
        actual_mode = target.stat().st_mode & 0o777
        require(bool(actual_mode & 0o111) == bool(row['mode'] & 0o111), 'Restored executable status differs')
        if actual_mode != row['mode']:
            require(allowed_permission_adjustments.get(row['path']) == (row['mode'], actual_mode), 'Unexpected restored permission difference: ' + row['path'])
            permission_adjustments.append({'path': row['path'], 'manifestMode': oct(row['mode']), 'actualMode': oct(actual_mode), 'reason': 'Frozen os.open creation applies022 umask; executable bits preserved'})
    restored.append({'manifest': binding(manifest_path), 'paths': count, 'bytesAndExecutableModesVerified': True})
require({row['path'] for row in permission_adjustments} == set(allowed_permission_adjustments), 'Permission observation changed')
promotion_path = BASE / 'promotion.json'
promotion = json.loads(promotion_path.read_text())
for key in ['previousLedger', 'candidate', 'liveLedger', 'approval', 'promoter']:
    row = promotion[key]
    require(sha(ROOT / row['path']) == row['sha256'], 'Promotion reference differs')
require(promotion['candidatePromotedByteForByte'] and promotion['candidate']['sha256'] == EXPECTED_LEDGER,
        'Promotion was not exact')
require(promotion['validation']['valid'] and len(promotion['validation']['accepted']) == 8 and len(promotion['validation']['remaining']) == 31,
        'Promotion validation differs')
protected = []
for source, digest in protected_expected.items():
    require(sha(source) == digest and sha(TREE / source.relative_to(ROOT)) == digest, 'Protected materialized artifact differs: ' + str(source))
    protected.append(binding(source))

active = []
ledger = json.loads((TREE / 'docs/execution/body-roadmap/ledger.json').read_text())
for node in ledger['nodes']:
    if node['status'] != 'accepted':
        continue
    receipt_ref = node['acceptanceReceipt']
    require(sha(TREE / receipt_ref['path']) == receipt_ref['sha256'], 'Missing active acceptance receipt')
    receipt = json.loads((TREE / receipt_ref['path']).read_text())
    refs = [receipt_ref, receipt['manifest']]
    refs.extend(review['evidence'] for review in receipt['independentReviews'])
    refs.extend(check['evidence'] for check in receipt['requiredChecks'])
    for reference in refs:
        require(sha(TREE / reference['path']) == reference['sha256'], 'Active evidence unavailable: ' + reference['path'])
    active.append({'nodeId': node['nodeId'], 'requiredCommandCount': len(receipt['requiredChecks']), 'refs': refs})
require(len(active) == 8, 'Accepted node count differs')
for command in parent['commands']:
    require(command['exitCode'] == 0, 'Parent materialization command failed')
    for stream in ['stdout', 'stderr']:
        reference = command[stream]
        require(sha(ROOT / reference['path']) == reference['sha256'], 'Parent command log changed')
    parsed = json.loads((ROOT / command['stdout']['path']).read_text())
    if command['name'] == 'base-restoration':
        require(parsed['verified'] and parsed['restored'] == 186, 'Wrong parent base restoration result')
    elif command['name'] == 'git-fixture-restoration':
        require(parsed['verified'] and parsed['restored'] == 27, 'Wrong parent supplemental restoration result')

# This is an evidence consistency check; no product commands or restoration reruns.
argv = [sys.executable, '-B', str(TREE / 'docs/execution/body-roadmap/validate-ledger.py')]
result = subprocess.run(argv, cwd=TREE, capture_output=True, text=True, timeout=60,
                        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
for name, value in [('ledger-validation.stdout.log', result.stdout), ('ledger-validation.stderr.log', result.stderr)]:
    with (OUT / name).open('x') as output:
        output.write(value)
require(result.returncode == 0, 'Materialized frozen validator failed: ' + result.stdout + result.stderr)
validation = json.loads(result.stdout)
require(validation['valid'] and not validation['errors'], 'Invalid materialized evidence')
require(validation['accepted'] == ['B01', 'B02', 'B03', 'B04', 'B08', 'B18', 'B30', 'B36'] and len(validation['remaining']) == 31, 'Unexpected acceptance expansion')
verify_required()
require(index_bytes() == before, 'Staged index changed during review')
for source, digest in protected_expected.items():
    require(sha(source) == digest and sha(TREE / source.relative_to(ROOT)) == digest, 'Protected binding changed during review')
write_json('review.json', {
    'schemaVersion': 1, 'type': 'independent-repaired-checkout-consistency-review',
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reviewer': '/root/b04_lock_cas',
    'decision': 'approve-exact-reviewed-index-and-repair-delta',
    'scope': 'Staged blob/mode availability, frozen inventory plus exactly three approved overrides, and active evidence/ledger consistency only. No product behavior or new acceptance credit.',
    'checkout': str(TREE), 'indexSha256': EXPECTED_INDEX, 'stagedIndexUnchanged': True,
    'stagedEntriesVerified': len(staged), 'gitlinks': 0, 'blobAndExecutableModesMatch': True,
    'historicalInventory': binding(inventory_path), 'requiredPathDelta': binding(delta_path),
    'unchangedHistoricalRequiredPaths': 2641, 'approvedChangedRequiredPaths': list(overrides.values()),
    'all2644RequiredPathsMatchBeforeAndAfter': True, 'approvedLedgerSha256': EXPECTED_LEDGER,
    'activeEvidence': active, 'protectedBindings': protected, 'originalsUnchanged': True,
    'archiveRestoration': {'baseFiles': 186, 'supplementFiles': 27, 'parentLogsHashVerified': True,
                           'allRestoredBytesIndependentlyMatched': True, 'archiveExecutableModesPreserved': True, 'permissionAdjustments': permission_adjustments, 'manifests': restored, 'restorationRerun': False},
    'approvedSmokeScript': smoke, 'stagedChangedPaths': changed_paths, 'promotion': binding(promotion_path),
    'frozenValidation': {'argv': argv, 'exitCode': result.returncode, 'result': validation},
    'parentReport': binding(PARENT_REPORT), 'noProductCommandsRun': True,
    'limitations': ['This reviews the recorded exact index; subsequent publication metadata is a separate index change.',
                    'The old inventory remains frozen and is explicitly supplemented, not asserted unchanged for its three overridden paths.',
                    'No implementation self-approval, provider/native execution, full roadmap completion or future-card acceptance is inferred.'],
})
print(json.dumps({'passed': True, 'stagedEntries': len(staged), 'historicalUnchanged': 2641, 'approvedOverrides': 3,
                  'accepted': 8, 'remaining': 31, 'reviewSha256': sha(OUT / 'review.json')}))
