"""Correct root-cwd whitespace check; preserve the earlier mis-scoped receipt."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'rust').is_dir())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
FILES = [ROOT / 'rust/scripts/smoke-test-sidecar.sh', ROOT / '.github/workflows/rust-workspace.yml', OUT / 'git-diff-check-corrected.py']
snapshot = lambda: {str(p.relative_to(ROOT)): sha(p) for p in FILES}
assert not (OUT / 'git-diff-check-corrected.json').exists()
argv = ['git', 'diff', '--check', '--', 'rust/scripts/smoke-test-sidecar.sh']
before = snapshot()
started = datetime.datetime.now(datetime.timezone.utc)
with tempfile.TemporaryDirectory(prefix='openbuff-smoke-root-diff-') as owned:
    home = Path(owned) / 'home'
    home.mkdir()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': owned, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig')}
    result = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
after = snapshot()
log = OUT / 'git-diff-check-corrected.log'
log.write_bytes(result.stdout)
receipt = {'schemaVersion': 1, 'type': 'body-corrected-smoke-whitespace-command', 'owner': '/root/b02_runtime_outcomes', 'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode, 'startedUtc': started.isoformat(), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'runner': ref(OUT / 'git-diff-check-corrected.py'), 'log': ref(log), 'environment': {'replacement': True, 'values': env}, 'historicalMisScopedReceipt': ref(OUT / 'git-diff-check.json'), 'scope': 'Actual repository-root whitespace check of the modified smoke script; earlier Rust-cwd path receives no whitespace credit.', 'closed': True}
(OUT / 'git-diff-check-corrected.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert result.returncode == 0 and before == after
print(json.dumps({'exitCode': result.returncode, 'sourceStable': before == after, 'receipt': ref(OUT / 'git-diff-check-corrected.json')}))
