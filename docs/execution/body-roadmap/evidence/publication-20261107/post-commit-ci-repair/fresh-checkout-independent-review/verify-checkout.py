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
TREE = Path('/tmp/openbuff-ci-repair-index-2cnl65ge')
PARENT_REPORT = BASE / 'checkouts/e22d84cd4558/report.json'
EXPECTED_INDEX = '3b9697d1c50a1e7db164ec7119b607b9cbbecc01ba6b292b8f52b68360d4f7ea'
EXPECTED_LEDGER = '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
EXPECTED_INVENTORY = 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
EXPECTED_DELTA = '4450aed4a38b1630fe5715ddf6cb00785a5e718475dcb35c9a06c49e557fc30e'
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
before = index_bytes()
require(hashlib.sha256(before).hexdigest() == EXPECTED_INDEX == parent['stagedIndexSha256'], 'Staged index differs from reviewed materialization')
with (OUT / 'reviewed-index.nul.gz').open('xb') as output:
    output.write(gzip.compress(before, mtime=0))
inventory_path = PUB / 'curated-required-files.json'
delta_path = BASE / 'required-path-delta.json'
require(sha(inventory_path) == EXPECTED_INVENTORY, 'Historical inventory changed')
require(sha(delta_path) == EXPECTED_DELTA, 'Repair delta changed')
inventory = json.loads(inventory_path.read_text())
delta = json.loads(delta_path.read_text())
expected_delta = {
    'scripts/memory-drift-guard.ts': '546da641fa97462b7bfbf96d8483c40087f836841c4c84fc9c034e3828111e89',
    'scripts/__tests__/memory-drift-guard.test.ts': 'a89cb63cfc91a36c4b416c60c7cb4344e5f86da180a7e99699755725fbf1071e',
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
require(len(staged) == 4869, 'Unexpected staged entry count')
encoded = json.dumps({'indexSha256': EXPECTED_INDEX, 'files': staged}, sort_keys=True).encode()
with (OUT / 'materialized-staged-bindings.json.gz').open('xb') as output:
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
    BASE / 'independent-review/manifest.json': '3e675f3a479431b9df553b7f3dfb42134daee3c6f676d893ba3114c9d86466e5',
    BASE / 'acceptance-independent-review/manifest.json': '3bf4729d1976ee85ceae40f4f4ef169d14da9a2431f498e04de6e42f9f90e25b',
}
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
                           'allRestoredBytesIndependentlyMatched': True, 'restorationRerun': False},
    'frozenValidation': {'argv': argv, 'exitCode': result.returncode, 'result': validation},
    'parentReport': binding(PARENT_REPORT), 'noProductCommandsRun': True,
    'limitations': ['This reviews the recorded exact index; subsequent publication metadata is a separate index change.',
                    'The old inventory remains frozen and is explicitly supplemented, not asserted unchanged for its three overridden paths.',
                    'No implementation self-approval, provider/native execution, full roadmap completion or future-card acceptance is inferred.'],
})
print(json.dumps({'passed': True, 'stagedEntries': len(staged), 'historicalUnchanged': 2641, 'approvedOverrides': 3,
                  'accepted': 8, 'remaining': 31, 'reviewSha256': sha(OUT / 'review.json')}))
