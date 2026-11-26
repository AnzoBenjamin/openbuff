#!/usr/bin/env python3
"""Replay B19's frozen local CI command surface on the current workflow matrix.

This is local command evidence, not a GitHub Actions run. Provisioned checkout,
credentials, installation/cache services, uploads and retries are outside it.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import yaml


ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/B19/continuation-20261111'
WORKFLOW = '.github/workflows/ci.yml'
CI_FLAGS = {'CODEBUFF_GITHUB_ACTIONS', 'NEXT_PUBLIC_CB_ENVIRONMENT', 'NEXT_PUBLIC_INFISICAL_UP'}
GUARDS = ['Check generated tool definitions are current', 'Memory drift + config sync',
          'Types declaration guard (runtime deps declare their typings)',
          'Check generated gate helpers are current', 'Typecheck']
KIND = 'b19-current-local-ci-replay'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(path):
    return {'path': path.resolve().relative_to(ROOT).as_posix(), 'sha256': sha(path)}


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    return ref(path)


def git(*args, env=None, data=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, env=env, input=data).decode().strip()


def test_files(package, wrapper):
    root = ROOT / package
    start = root / '__tests__' if wrapper == 'plain' else root
    files = []
    for directory, children, names in os.walk(start):
        children[:] = [name for name in children if name not in {'node_modules', '.git', 'dist'}]
        for name in names:
            file = Path(directory) / name
            if (name.endswith(('.test.ts', '.test.tsx')) and not file.is_symlink()
                    and (wrapper == 'plain' or not name.endswith('.integration.test.ts'))):
                files.append(file.relative_to(root).as_posix())
    return sorted(files, key=lambda name: name.encode())


def plan(manifest, compiler, head, base):
    assert sha(ROOT / WORKFLOW) == manifest['inputs'][WORKFLOW], 'CI workflow source drift'
    workflow = yaml.safe_load((ROOT / WORKFLOW).read_text())
    jobs = workflow['jobs']
    packages = jobs['test']['strategy']['matrix']['package']
    assert len(packages) == len(set(packages)) and all((ROOT / name / 'package.json').is_file() for name in packages)

    def ci_flags(job):
        setup = next(s for s in jobs[job]['steps'] if s.get('name') == 'Set environment variables')
        values = dict(re.findall(r'echo "([A-Z_]+)=([A-Za-z0-9_-]+)" >> \$GITHUB_ENV', setup['run']))
        expected = CI_FLAGS if job == 'test' else CI_FLAGS - {'NEXT_PUBLIC_INFISICAL_UP'}
        assert expected <= set(values), f'{job} lost a non-secret environment selector'
        return {key: values[key] for key in sorted(expected)}

    build_flags, test_flags = ci_flags('build-and-check'), ci_flags('test')
    test_step = next(s for s in jobs['test']['steps'] if s.get('id') == 'tests')
    package_script = test_step['with']['command']
    # These known selectors are implemented below; reject workflow drift in
    # their contract rather than silently replacing the CI test census.
    assert all(text in package_script for text in [
        'bun run test', 'bun test --isolate $TEST_FILES', "-name '*.test.tsx'", "! -name '*.integration.test.ts'",
        '-path ./node_modules', '-path ./.git', '-path ./dist',
    ])
    bun = [str(compiler), '--no-env-file', '--no-install']
    commands = []

    def add(name, argv, cwd='.', category='guard', environment=None):
        settings = test_flags if category in ('test', 'build') else build_flags
        commands.append({'name': name, 'argv': argv, 'cwd': cwd, 'category': category,
                         'environment': {**settings, **(environment or {})}})

    for label in GUARDS:
        step = next(s for s in jobs['build-and-check']['steps'] if s.get('name') == label)
        lines = [line.strip() for line in step['run'].splitlines() if line.strip() and not line.lstrip().startswith('#')]
        for i, line in enumerate(lines):
            command = shlex.split(line)
            assert command[0] in ('bun', 'git'), line
            argv = [*bun, *command[1:]] if command[0] == 'bun' else [shutil.which('git'), *command[1:]]
            add(re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-') + f'-{i + 1}', argv,
                category='typecheck' if label == 'Typecheck' else 'guard')
    add('provenance-range', [*bun, 'scripts/provenance-change-guard.ts', '--event', 'pull_request',
                             '--base', base, '--head', head])
    add('sdk-build', [*bun, 'run', 'build'], 'sdk', 'build')
    add('cli-prebuild-agents', [*bun, 'run', 'prebuild:agents'], 'cli', 'build')
    rosters = {}
    typechecks = []
    for name in packages:
        wrapper = 'plain' if name in ('.agents', 'agents') else 'cli' if name == 'cli' else None
        scripts = json.loads((ROOT / name / 'package.json').read_text())
        if 'typecheck' in scripts.get('scripts', {}):
            typechecks.append(scripts['name'])
        if wrapper == 'plain':
            assert scripts['scripts']['test'] == 'bun test __tests__'
        elif name == 'cli':
            assert scripts['scripts']['test'] == 'bun run scripts/run-cli-tests.ts'
        files = test_files(name, wrapper)
        assert files, name
        rosters[name] = {'package': name, 'fileCount': len(files), 'files': files,
                         'sourceHashes': {f: manifest['inputs'][f'{name}/{f}'] for f in files}}
        command = bun + (['run', 'test'] if wrapper else ['test', '--isolate', *['./' + f for f in files]])
        environment = {'CODEBUFF_WASM_DIR': str(ROOT / 'sdk/dist/wasm')} if name == 'packages/code-map' else {}
        add('test-' + name.replace('/', '-').lstrip('.'), command, name, 'test', environment)
    return packages, sorted(typechecks), rosters, commands


def compare_input_files(rest):
    snapshot = {name: sha(ROOT / name) for name in rest}
    assert snapshot == rest, 'Frozen B19 inputs changed'
    return snapshot


def summarize(text, expected_names, cwd):
    totals = {label: int(number) for number, label in re.findall(r'^\s+(\d+) (pass|fail|skip)$', text, flags=re.M)}
    ran = re.findall(r'^Ran (\d+) tests? across (\d+) files?\.', text, flags=re.M)
    actual = set()
    for name in re.findall(r'^([^\n]+\.test\.tsx?):$', text, flags=re.M):
        p = (cwd / name).resolve()
        if p.is_relative_to(cwd):
            actual.add(p.relative_to(cwd).as_posix())
    return {'nonVacuous': bool(ran) and totals.get('pass', 0) > 0,
            'missingDiscoveredFilesInLog': sorted(set(expected_names) - actual),
            'reportedFailureCounts': [totals.get('fail', -1)], 'counts': totals,
            'declaredFiles': len(expected_names), 'observedFiles': len(actual)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-manifest', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--node-provenance', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    assert out.is_relative_to(BASE.resolve())
    source_manifest = args.source_manifest.resolve(strict=True)
    frozen = json.loads(source_manifest.read_text())
    assert frozen['card'] == 'B19' and frozen['head'] == git('rev-parse', 'HEAD')
    compiler = Path(frozen['bun']['path']).resolve(strict=True)
    node = args.node.resolve(strict=True)
    provenance = args.node_provenance.resolve(strict=True)
    node_hash = json.loads(provenance.read_text())['nodeSha256']
    required_node = 'v' + (ROOT / '.node-version').read_text().strip()
    assert subprocess.check_output([str(node), '--version'], text=True).strip() == required_node
    compare_input_files(frozen['inputs'])
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='openbuff-b19-ci-') as scratch:
        temp = Path(scratch)
        env = {'PATH': os.pathsep.join([str(node.parent), str(compiler.parent), os.environ['PATH']]),
               'HOME': str(temp / 'home'), 'XDG_CONFIG_HOME': str(temp / 'xdg'), 'TMPDIR': str(temp / 'tmp'),
               'DO_NOT_TRACK': '1', 'OPENBUFF_TELEMETRY': '0', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
               'BUN_OPTIONS': '--no-env-file'}
        for name in ['home', 'xdg', 'tmp']:
            (temp / name).mkdir(mode=0o700)
        # The provenance guard consumes actual immutable Git objects. Stage only
        # the frozen B19 source roster in a private index; no refs are moved.
        indexed = {**env, 'GIT_INDEX_FILE': str(temp / 'candidate-index'),
                   'GIT_AUTHOR_NAME': 'B19 local proof', 'GIT_AUTHOR_EMAIL': 'b19-proof@example.invalid',
                   'GIT_COMMITTER_NAME': 'B19 local proof', 'GIT_COMMITTER_EMAIL': 'b19-proof@example.invalid'}
        git('read-tree', frozen['head'], env=indexed)
        git('add', '--pathspec-from-file=-', '--pathspec-file-nul', env=indexed,
            data=b''.join(os.fsencode(name) + b'\0' for name in frozen['inputs']))
        tree = git('write-tree', env=indexed)
        head = git('commit-tree', tree, '-p', frozen['head'], '-m', 'B19 local CI evidence candidate (not a branch)', env=indexed)
        base = git('merge-base', frozen['head'], 'origin/main', env=env)
        packages, typechecks, rosters, commands = plan(frozen, compiler, head, base)
        roster_file = write(out / 'rosters.json', {'workflow': ref(ROOT / WORKFLOW), 'ciMatrix': packages,
                             'typecheckWorkspaces': typechecks, 'rosters': rosters})
        toolchain = {'bun': frozen['bun'], 'node': {'path': str(node), 'sha256': node_hash, 'version': required_node,
                     'requirement': ref(ROOT / '.node-version'), 'provenance': ref(provenance)}}
        dispatch = write(out / 'dispatch.json', {'kind': KIND, 'sourceManifest': ref(source_manifest),
                         'recorder': ref(Path(__file__)), 'rosters': roster_file, 'commands': commands,
                         'toolchain': toolchain, 'provenanceRange': {'base': base, 'head': head, 'tree': tree}})
        results = []
        for index, row in enumerate(commands):
            cell = out / f'{index:02d}-{row["name"]}'
            cell.mkdir(mode=0o700)
            stable = sha(compiler) == frozen['bun']['sha256'] and sha(node) == node_hash
            assert stable
            before = write(cell / 'source-before.json', compare_input_files(frozen['inputs']))
            log = cell / 'command.log'
            cwd = (ROOT / row['cwd']).resolve()
            started = datetime.now(timezone.utc).isoformat()
            command_home = temp / f'command-{index:02d}'
            for name in ['home', 'xdg', 'tmp']:
                (command_home / name).mkdir(mode=0o700, parents=True)
            command_env = {**env, 'HOME': str(command_home / 'home'),
                           'XDG_CONFIG_HOME': str(command_home / 'xdg'), 'TMPDIR': str(command_home / 'tmp'),
                           **row['environment']}
            with log.open('xb') as stream:
                proc = subprocess.Popen(row['argv'], cwd=cwd, env=command_env,
                                        stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                        start_new_session=True)
                try:
                    exit_code = proc.wait(timeout=1500 if row['category'] == 'test' else 300)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                    exit_code = 124
            after = write(cell / 'source-after.json', compare_input_files(frozen['inputs']))
            stable = sha(compiler) == frozen['bun']['sha256'] and sha(node) == node_hash
            assert stable
            text = log.read_text(errors='replace')
            summary = summarize(text, rosters[row['cwd']]['files'], cwd) if row['category'] == 'test' else None
            observed_typechecks = (sorted(set(re.findall(r'^([^\s]+) typecheck: Exited with code 0$', text, flags=re.M)))
                                   if row['category'] == 'typecheck' else None)
            passed = (exit_code == 0 and (summary is None or (summary['nonVacuous'] and
                       not summary['missingDiscoveredFilesInLog'] and summary['reportedFailureCounts'] == [0]))
                      and (observed_typechecks is None or observed_typechecks == typechecks))
            result = {**row, 'passed': passed, 'exitCode': exit_code, 'sourceStable': True, 'toolchainStable': stable,
                      'sourceBefore': before, 'sourceAfter': after, 'testSummary': summary,
                      'observedTypechecks': observed_typechecks, 'log': ref(log), 'startedAt': started,
                      'finishedAt': datetime.now(timezone.utc).isoformat()}
            results.append(result)
            write(cell / 'invocation.json', result)
            print(row['name'], 'PASS' if passed else 'FAIL', summary and summary['counts'], flush=True)
            if not passed:
                print('\n'.join(text.splitlines()[-18:]), flush=True)
        passed = len(results) == len(commands) and all(r['passed'] for r in results)
        write(out / 'results.json', {'kind': KIND, 'complete': len(results) == len(commands), 'passed': passed,
             'sourceStable': True, 'toolchainStable': True, 'manifest': ref(source_manifest),
             'dispatchManifest': dispatch, 'ciMatrix': packages, 'typecheckWorkspaces': typechecks,
             'commands': results, 'expectedCommands': [r['name'] for r in commands],
             'scope': 'Current CI test discovery and local guards with workflow non-secret selectors, using preinstalled locked dependencies; hosted services, credentials, paid integration and deployment are not asserted.'})
        return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
