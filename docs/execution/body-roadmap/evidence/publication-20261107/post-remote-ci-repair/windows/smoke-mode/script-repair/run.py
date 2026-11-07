"""Record corrected direct smoke against an already proven current-source host binary."""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import stat
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'rust').is_dir())
SCRIPT = ROOT / 'rust/scripts/smoke-test-sidecar.sh'
WORKFLOW = ROOT / '.github/workflows/rust-workspace.yml'
BINARY = ROOT / 'rust/target/debug/openbuff-native'
BUILD = OUT.parent / 'host-build-current-source.json'
WORKFLOW_SHA = '0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
read = lambda p: json.loads(Path(p).read_text())
assert not (OUT / 'run-results.json').exists()
assert sha(BUILD) == '6cd6648fe64c4f3d284617df08dc6c76bc30b0d65776c713524dfa380ac9facb'
assert sha(OUT / 'smoke-test-sidecar.before.sh') == '3928fef2828a7ab4434431c7fee7ccf82afba0a2d43891e3867982b88cdcb96f'
assert stat.S_IMODE(SCRIPT.stat().st_mode) == 0o755
assert sha(WORKFLOW) == WORKFLOW_SHA
build = read(BUILD)
assert build['exitCode'] == 0 and build['sourceBefore'] == build['sourceAfter']
assert sha(BINARY) == build['binary']['sha256']
rust_context = {name: digest for name, digest in build['sourceBefore'].items() if name.startswith('rust/') and name != 'rust/scripts/smoke-test-sidecar.sh'}
for name, digest in rust_context.items():
    assert sha(ROOT / name) == digest, name
for name in ['cargo', 'rustc']:
    tool = build['rustToolchain'][name]
    assert sha(tool['path']) == tool['sha256']
assert build['rustToolchain']['pinnedVersion'] == '1.87.0'
files = [SCRIPT, WORKFLOW, BINARY, BUILD, OUT / 'run.py', OUT / 'smoke-test-sidecar.before.sh'] + [ROOT / name for name in rust_context]
snapshot = lambda: {str(p.relative_to(ROOT)): sha(p) for p in files}
commands = []
with tempfile.TemporaryDirectory(prefix='openbuff-smoke-script-repair-') as owned:
    home = Path(owned) / 'home'
    home.mkdir()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'), 'TMPDIR': owned, 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig')}
    for name, argv, expected in [
        ('shell-syntax', ['/usr/bin/bash', '-n', str(SCRIPT)], 0),
        ('daemon-placeholder', [str(BINARY), 'daemon'], 2),
        ('direct-corrected-smoke', [str(SCRIPT), str(BINARY)], 0),
        ('git-diff-check', ['git', 'diff', '--check', '--', 'rust/scripts/smoke-test-sidecar.sh'], 0),
    ]:
        before = snapshot()
        started = datetime.datetime.now(datetime.timezone.utc)
        result = subprocess.run(argv, cwd=ROOT / 'rust', env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        after = snapshot()
        stdout, stderr = OUT / (name + '.stdout.log'), OUT / (name + '.stderr.log')
        stdout.write_bytes(result.stdout)
        stderr.write_bytes(result.stderr)
        receipt = {'schemaVersion': 1, 'type': 'body-corrected-smoke-host-command', 'owner': '/root/b02_runtime_outcomes', 'name': name, 'argv': argv, 'cwd': str(ROOT / 'rust'), 'exitCode': result.returncode, 'expectedExitCode': expected, 'startedUtc': started.isoformat(), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'scriptMode': '0755', 'environment': {'replacement': True, 'values': env, 'stdinDevNull': True, 'ownedEmptyHome': True}, 'matchingHostBuildProvenance': ref(BUILD), 'rustToolchain': build['rustToolchain'], 'shell': {'path': '/usr/bin/bash', 'sha256': sha('/usr/bin/bash')}, 'binary': ref(BINARY), 'runner': ref(OUT / 'run.py'), 'stdout': ref(stdout), 'stderr': ref(stderr), 'scope': 'Local Linux shell/ordinary version/unknown-role/daemon-placeholder controls; no exec payload or Windows/downstream native acceptance claim.', 'closed': True}
        path = OUT / (name + '.json')
        path.write_text(json.dumps(receipt, indent=2) + '\n')
        commands.append(ref(path))
        assert result.returncode == expected and before == after, name
        if name == 'daemon-placeholder':
            assert json.loads(result.stdout) == {'ok': False, 'role': 'daemon', 'error': 'not_implemented'}
        if name == 'direct-corrected-smoke':
            for marker in ['smoke: version ok:', 'smoke: unknown-role exit 1 ok', 'smoke: not_implemented exit 2 ok', 'smoke: all checks passed']:
                assert marker in result.stdout.decode(), marker
        print(json.dumps({'name': name, 'exitCode': result.returncode, 'expected': expected, 'sourceStable': before == after}), flush=True)
delta = ''.join(difflib.unified_diff((OUT / 'smoke-test-sidecar.before.sh').read_text().splitlines(keepends=True), SCRIPT.read_text().splitlines(keepends=True), fromfile='a/rust/scripts/smoke-test-sidecar.sh', tofile='b/rust/scripts/smoke-test-sidecar.sh'))
(OUT / 'script-delta.diff').write_text(delta)
result = {'schemaVersion': 1, 'type': 'body-corrected-smoke-script-supplement', 'owner': '/root/b02_runtime_outcomes', 'scriptBefore': ref(OUT / 'smoke-test-sidecar.before.sh'), 'scriptAfter': ref(SCRIPT), 'scriptMode': '0755', 'workflow': ref(WORKFLOW), 'matchingHostBuildProvenance': ref(BUILD), 'rustRuntimeSourcesUnchanged': rust_context, 'binary': ref(BINARY), 'commands': commands, 'delta': ref(OUT / 'script-delta.diff'), 'allPassed': True, 'execPayloadExecuted': False, 'windowsExecuted': False, 'nativeAcceptanceClaimed': False, 'cargoBuildRepeated': False}
(OUT / 'run-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
