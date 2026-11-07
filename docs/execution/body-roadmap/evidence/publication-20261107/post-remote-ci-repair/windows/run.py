"""Record bounded YAML/condition/order verification and whitespace validation."""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / '.github').is_dir())
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
BUN_SHA = 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
SOURCE = ROOT / '.github/workflows/rust-workspace.yml'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
assert sha(BUN) == BUN_SHA
assert not (OUT / 'run-results.json').exists()
files = [SOURCE, OUT / 'run.py', OUT / 'verify.ts', OUT / 'rust-workspace.before.yml', OUT / 'run-42317166029-failed.log']
snapshot = lambda: {str(p.relative_to(ROOT)): sha(p) for p in files}
commands = []
with tempfile.TemporaryDirectory(prefix='openbuff-windows-workflow-check-') as owned:
    home = Path(owned) / 'home'
    home.mkdir()
    env = {'PATH': str(BUN.parent) + ':/usr/bin:/bin', 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'), 'TMPDIR': owned, 'BUN_OPTIONS': '--no-env-file', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig')}
    for name, argv in [
        ('yaml-condition-order', [str(BUN), '--no-env-file', str(OUT / 'verify.ts')]),
        ('git-diff-check', ['git', 'diff', '--check', '--', '.github/workflows/rust-workspace.yml']),
    ]:
        before = snapshot()
        started = datetime.datetime.now(datetime.timezone.utc)
        result = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        after = snapshot()
        log = OUT / (name + '.log')
        log.write_bytes(result.stdout)
        receipt = {'schemaVersion': 1, 'type': 'body-remote-ci-repair-structural-command', 'reviewer': '/root/b02_runtime_outcomes', 'name': name, 'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode, 'startedUtc': started.isoformat(), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'environment': {'replacement': True, 'values': env, 'ownedEmptyHome': True}, 'toolchain': {'executable': str(BUN), 'version': '1.3.5', 'sha256': BUN_SHA}, 'runner': ref(OUT / 'run.py'), 'log': ref(log), 'scope': 'Linux structural verification only; real GitHub rerun validates Windows execution.', 'closed': True}
        path = OUT / (name + '.json')
        path.write_text(json.dumps(receipt, indent=2) + '\n')
        commands.append(ref(path))
        assert result.returncode == 0 and before == after
delta = ''.join(difflib.unified_diff((OUT / 'rust-workspace.before.yml').read_text().splitlines(keepends=True), SOURCE.read_text().splitlines(keepends=True), fromfile='a/.github/workflows/rust-workspace.yml', tofile='b/.github/workflows/rust-workspace.yml'))
(OUT / 'workflow-delta.diff').write_text(delta)
result = {'schemaVersion': 1, 'reviewer': '/root/b02_runtime_outcomes', 'sourceBefore': ref(OUT / 'rust-workspace.before.yml'), 'sourceAfter': ref(SOURCE), 'commands': commands, 'verification': ref(OUT / 'verification.json'), 'delta': ref(OUT / 'workflow-delta.diff'), 'allStructuralControlsPassed': True, 'windowsExecuted': False, 'realGitHubRerunRequired': True}
(OUT / 'run-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
