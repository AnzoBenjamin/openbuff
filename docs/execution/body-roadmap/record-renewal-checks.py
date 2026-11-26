#!/usr/bin/env python3
"""Run a predeclared, credential-free current-source roadmap renewal matrix.

Command packets are directly usable by a reviewer. A green packet never
asserts independent approval, behavioral completeness, or acceptance.
"""

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / 'test/fixtures/body/toolchain-manifest.json'
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def contained(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError(f'Not a repository-relative path: {name}')
    result = ROOT / path
    if not result.resolve().is_relative_to(ROOT):
        raise ValueError(f'Path escapes the repository: {name}')
    return result


def ref(file):
    return {'path': file.relative_to(ROOT).as_posix(), 'sha256': digest(file)}


def write(file, value):
    with file.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    return ref(file)


def now():
    return datetime.now(timezone.utc).isoformat()


def resolve_bun():
    selected = json.loads(MANIFEST.read_text())['tools']['bun']
    executable = Path(shutil.which('bun') or '/missing-bun').resolve(strict=True)
    version = subprocess.check_output([str(executable), '--version'], text=True).strip()
    host = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(os.uname().machine)
    platform = {'Linux': 'linux', 'Darwin': 'darwin'}.get(os.uname().sysname)
    expected = selected['expectedSha256ByHost'].get(f'{platform}-{host}')
    if version != selected['expectedVersion'] or not expected or digest(executable) != expected:
        raise ValueError('Bun executable does not match the reviewed toolchain manifest')
    return executable, {'version': version, 'sha256': expected, 'manifest': ref(MANIFEST)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--matrix', required=True)
    parser.add_argument('--evidence-dir', required=True)
    args = parser.parse_args()
    matrix_path = contained(args.matrix)
    matrix = json.loads(matrix_path.read_text())
    if matrix.get('schemaVersion') != 1 or not matrix.get('checks'):
        raise ValueError('Expected a nonempty schema-v1 renewal matrix')
    executable, toolchain = resolve_bun()
    output = contained(args.evidence_dir)
    output.mkdir(mode=0o700)  # Never overwrite a prior run.
    matrix_ref = ref(matrix_path)
    baseline = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    outcomes = []
    seen = set()
    for check in matrix['checks']:
        name, node = check['name'], check['nodeId']
        if not ID.fullmatch(name) or not ID.fullmatch(node) or name in seen:
            raise ValueError(f'Invalid or repeated check name: {name}')
        seen.add(name)
        cwd = contained(check.get('cwd', '.'))
        source_paths = sorted(set(matrix['sharedSources']) | set(check['sources']))
        if not source_paths or len(check['argv']) < 2 or check['argv'][0] != 'bun':
            raise ValueError(f'Check needs real source bindings and a Bun invocation: {name}')
        paths = {path: contained(path) for path in source_paths}

        def source_snapshot():
            return {name: digest(path) for name, path in paths.items()}

        before = source_snapshot()
        cell = output / name
        cell.mkdir(mode=0o700)
        argv = [str(executable), '--no-env-file', '--no-install', *[
            arg.replace('{capture}', str(cell / 'capture')) for arg in check['argv'][1:]
        ]]
        env = {
            'PATH': os.environ['PATH'],
            'LANG': 'C.UTF-8', 'TERM': 'xterm-256color', 'DO_NOT_TRACK': '1',
            'OPENBUFF_TELEMETRY': '0', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
            'BUN_OPTIONS': '--no-env-file',
        }
        if check.get('developmentRenderer') is True:
            env['NODE_ENV'] = 'development'
        timeout = check.get('timeoutSeconds', 180)
        if not isinstance(timeout, int) or not 1 <= timeout <= 900:
            raise ValueError(f'Invalid timeout for {name}')
        log = cell / 'command.log'
        started = now()
        timed_out = False
        with tempfile.TemporaryDirectory(prefix='openbuff-body-renewal-', dir='/tmp') as temporary, log.open('xb') as stream:
            # Keep per-command fixture roots outside the repository. Several
            # cells explicitly verify how production behaves outside Git.
            ephemeral = Path(temporary)
            for directory in ['home', 'config', 'tmp']:
                (ephemeral / directory).mkdir(mode=0o700)
            env.update(HOME=str(ephemeral / 'home'), XDG_CONFIG_HOME=str(ephemeral / 'config'),
                       TMPDIR=str(ephemeral / 'tmp'))
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                status = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, signal.SIGKILL)
                status = child.wait()
        after = source_snapshot()
        current = before == after and ref(matrix_path) == matrix_ref and digest(executable) == toolchain['sha256']
        text = log.read_text(errors='replace')
        totals = {label: int(number) for number, label in re.findall(r'^\s+(\d+) (pass|fail|skip)$', text, flags=re.M)}
        ran_tests = argv[3] != 'test' or (re.search(r'^Ran \d+ tests? across \d+ files?\.', text, flags=re.M) and totals.get('pass', 0) > 0)
        ok = status == 0 and current and bool(ran_tests)
        facts = {
            'name': name, 'nodeId': node, 'argv': argv, 'cwd': cwd.relative_to(ROOT).as_posix(),
            'exitCode': status, 'log': ref(log), 'sourceBefore': before, 'sourceAfter': after,
        }
        origin = write(cell / 'invocation.json', {
            'schemaVersion': 1, **facts, 'startedAt': started, 'finishedAt': now(),
            'timeoutSeconds': timeout, 'timedOut': timed_out,
            'environment': {'replacement': True, 'keys': sorted(env), 'envFileLoading': False},
            'toolchain': toolchain, 'inputMatrix': matrix_ref, 'counts': totals,
        })
        packet = write(cell / 'command-packet.json', {
            'schemaVersion': 1, 'type': 'body-acceptance-command', **facts, 'provenance': origin,
        }) if ok else None
        outcomes.append({'name': name, 'nodeId': node, 'passed': ok, 'invocation': origin,
                         'commandPacket': packet, 'counts': totals})
        print(name, 'PASS' if ok else 'FAIL', totals, flush=True)
        if not ok:
            print('\n'.join(text.splitlines()[-18:]), flush=True)
    write(output / 'summary.json', {
        'schemaVersion': 1, 'type': 'body-renewal-checks', 'baseGitHead': baseline,
        'inputMatrix': matrix_ref, 'toolchain': toolchain, 'checks': outcomes,
        'scope': 'Observed command execution only; pending independent behavior review and sealing.',
    })
    return 0 if all(item['passed'] for item in outcomes) else 1


if __name__ == '__main__':
    raise SystemExit(main())
