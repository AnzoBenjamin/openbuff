"""Preserve script bytes, change only its mode, and record bounded host smoke."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import stat
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
ROOT = next(p for p in OUT.parents if (p / 'rust').is_dir())
RUST = ROOT / 'rust'
SCRIPT = RUST / 'scripts/smoke-test-sidecar.sh'
WORKFLOW = ROOT / '.github/workflows/rust-workspace.yml'
TOOLCHAIN = Path('/home/ben/.rustup/toolchains/1.87.0-x86_64-unknown-linux-gnu/bin')
CARGO = TOOLCHAIN / 'cargo'
RUSTC = TOOLCHAIN / 'rustc'
BINARY = RUST / 'target/debug/openbuff-native'
SCRIPT_SHA = '3928fef2828a7ab4434431c7fee7ccf82afba0a2d43891e3867982b88cdcb96f'
WORKFLOW_SHA = '0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3'
SCOPE = ROOT / 'docs/execution/body-roadmap/evidence/publication-20261107/post-remote-ci-repair/independent-review/smoke-mode-scope/scope.json'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
ref = lambda p: {'path': str(Path(p).relative_to(ROOT)), 'sha256': sha(p)}
mode = lambda p: oct(stat.S_IMODE(Path(p).stat().st_mode))
assert not (OUT / 'run-results.json').exists()
assert sha(SCRIPT) == SCRIPT_SHA and sha(WORKFLOW) == WORKFLOW_SHA
assert sha(OUT / 'smoke-test-sidecar.before.sh') == SCRIPT_SHA
assert sha(SCOPE) == '8fdea3ce0346cbc04d27d63badf90880964cd93ce51d89aaba91655669393295'
rust_sources = sorted(p for p in RUST.rglob('*') if p.is_file() and 'target' not in p.relative_to(RUST).parts and (p.suffix in ['.rs', '.toml'] or p.name == 'Cargo.lock'))
inputs = [SCRIPT, WORKFLOW, OUT / 'run.py', OUT / 'smoke-test-sidecar.before.sh', SCOPE] + rust_sources
snapshot = lambda: {str(p.relative_to(ROOT)): sha(p) for p in inputs}
before_mode = mode(SCRIPT)
index = subprocess.run(['git', 'ls-files', '--stage', '--', 'rust/scripts/smoke-test-sidecar.sh'], cwd=ROOT, stdout=subprocess.PIPE, check=True).stdout.decode()
assert index.startswith('100644 ')
preparation = {'scriptBefore': ref(SCRIPT), 'worktreeModeBefore': before_mode, 'indexBefore': index, 'bindingScopeBeforeMutation': ref(SCOPE), 'workflow': ref(WORKFLOW)}
(OUT / 'before.json').write_text(json.dumps(preparation, indent=2) + '\n')
os.chmod(SCRIPT, 0o755)
assert mode(SCRIPT) == '0o755' and sha(SCRIPT) == SCRIPT_SHA
assert sha(WORKFLOW) == WORKFLOW_SHA
commands = []
with tempfile.TemporaryDirectory(prefix='openbuff-smoke-mode-') as owned:
    home = Path(owned) / 'home'
    home.mkdir()
    env = {
        'PATH': str(TOOLCHAIN) + ':/usr/bin:/bin', 'HOME': str(home),
        'XDG_CONFIG_HOME': str(home / '.config'), 'TMPDIR': owned,
        'CARGO_HOME': '/home/ben/.cargo', 'RUSTC': str(RUSTC),
        'CARGO_NET_OFFLINE': 'true', 'LANG': 'C.UTF-8',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(home / '.gitconfig'),
    }
    def command(name, argv, expected=None):
        before = snapshot()
        started = datetime.datetime.now(datetime.timezone.utc)
        try:
            result = subprocess.run(argv, cwd=RUST, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            output, error, code = result.stdout, result.stderr, result.returncode
        except subprocess.TimeoutExpired as failure:
            output, error, code = failure.stdout or b'', (failure.stderr or b'') + b'\nCONTROL TIMEOUT\n', 124
        after = snapshot()
        stdout, stderr = OUT / (name + '.stdout.log'), OUT / (name + '.stderr.log')
        stdout.write_bytes(output)
        stderr.write_bytes(error)
        receipt = {'schemaVersion': 1, 'type': 'body-smoke-mode-host-command', 'reviewer': '/root/b02_runtime_outcomes', 'name': name, 'argv': argv, 'cwd': str(RUST), 'exitCode': code, 'expectedExitCode': expected, 'expectedExitMatched': expected is None or code == expected, 'startedUtc': started.isoformat(), 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'scriptMode': mode(SCRIPT), 'environment': {'replacement': True, 'values': env, 'stdinDevNull': True, 'ownedEmptyHome': True, 'offlineCargo': True}, 'rustToolchain': {'cargo': {'path': str(CARGO), 'sha256': sha(CARGO)}, 'rustc': {'path': str(RUSTC), 'sha256': sha(RUSTC)}, 'pinnedVersion': '1.87.0'}, 'runner': ref(OUT / 'run.py'), 'stdout': ref(stdout), 'stderr': ref(stderr), 'binary': ref(BINARY) if BINARY.is_file() else None, 'scope': 'Local Linux ordinary CLI/placeholder checks only; no Windows or downstream native acceptance claim.', 'closed': True}
        path = OUT / (name + '.json')
        path.write_text(json.dumps(receipt, indent=2) + '\n')
        commands.append(ref(path))
        assert before == after
        print(json.dumps({'name': name, 'exitCode': code, 'expected': expected, 'expectedMatched': receipt['expectedExitMatched']}), flush=True)
        return code, output, error
    code, output, _ = command('rustc-version', [str(RUSTC), '--version', '--verbose'], 0)
    assert code == 0 and b'rustc 1.87.0' in output and b'x86_64-unknown-linux-gnu' in output
    code, _, _ = command('host-build-current-source', [str(CARGO), 'build', '--workspace', '--offline', '--locked'], 0)
    assert code == 0 and BINARY.is_file()
    version_code, version_out, _ = command('binary-version', [str(BINARY), 'version'], 0)
    unknown_code, _, _ = command('binary-unknown-role', [str(BINARY), 'bogus-role'], 1)
    exec_code, exec_out, _ = command('binary-exec-placeholder', [str(BINARY), 'exec'], 2)
    smoke_code, _, _ = command('direct-script-smoke', [str(SCRIPT), str(BINARY)], 0)
assert sha(SCRIPT) == SCRIPT_SHA and sha(WORKFLOW) == WORKFLOW_SHA
summary = {'schemaVersion': 1, 'type': 'body-smoke-mode-supplement', 'owner': '/root/b02_runtime_outcomes', 'sourceTextChanged': False, 'script': ref(SCRIPT), 'worktreeModeBefore': before_mode, 'worktreeModeAfter': mode(SCRIPT), 'requestedGitModeBefore': '100644', 'requestedGitModeAfter': '100755', 'indexNotStaged': True, 'workflow': ref(WORKFLOW), 'commands': commands, 'matchingHostBuildCompleted': True, 'binary': ref(BINARY), 'ordinaryVersionPassed': version_code == 0 and bool(version_out.strip()), 'unknownRolePassed': unknown_code == 1, 'execPlaceholderPassed': exec_code == 2 and b'not_implemented' in exec_out, 'directSmokePassed': smoke_code == 0, 'windowsExecuted': False, 'downstreamNativeAcceptanceClaimed': False, 'sealedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
(OUT / 'run-results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
