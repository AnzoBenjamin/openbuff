#!/usr/bin/env python3
"""Retain current B19 test inputs, original captures and per-suite results."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/B19'
SUITES = [
    'common/src/util/__tests__/execution-context.test.ts',
    'common/src/util/__tests__/execution-context-oracles.test.ts',
    *['sdk/src/__tests__/' + name + '.test.ts' for name in [
        'execution-approval', 'execution-launch', 'execution-launch-timers',
        'host-config', 'run-host-contract-controls', 'env', 'file-change-hooks',
        'terminal-execution-branch-controls', 'session-git-execution-branch-controls',
        'toolchain-execution-branch-controls', 'lsp-execution-branch-controls',
        'external-execution-branch-controls', 'chrome-sdk-execution-branch-controls',
        'blender-sdk-execution-branch-controls',
        'supervision-sdk-execution-branch-controls',
        'execution-launch-oracles', 'run-host-execution', 'run-mcp-execution',
        'toolchain-execution', 'bootstrap-execution-authority',
        'harness-enforcement', 'run-targeted-validation',
        'get-change-review-bundle', 'diagnostic-delta',
    ]],
    'packages/indexer/src/scip-execution-branch-controls.test.ts',
    'cli/src/commands/__tests__/index-execution-branch-controls.test.ts',
]


def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(file):
    return {'path': str(file.relative_to(ROOT)), 'sha256': sha(file)}


def sources():
    names = subprocess.check_output([
        'git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
        'common', 'sdk', 'packages', 'cli', 'agents', 'scripts', 'evals', 'test', '.agents', '.github/workflows',
        'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json',
    ], cwd=ROOT).split(b'\0')
    paths = {os.fsdecode(name) for name in names if name}
    paths.add(str(Path(__file__).resolve().relative_to(ROOT)))
    paths.add('docs/execution/body-roadmap/run-b19-compiled-checks.py')
    return {name: sha(ROOT / name) for name in sorted(paths)
            if (ROOT / name).is_file() and not name.endswith('.tsbuildinfo')
            and not name.startswith('.agents/sessions/')}


def write(file, value):
    with file.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('invocation', help='Unique name inside continuation-20261111')
    parser.add_argument('--suite', action='append', choices=SUITES,
                        help='Run a selected suite; defaults to the full B19 roster')
    args = parser.parse_args()
    if not args.invocation or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.invocation):
        parser.error('Use a unique alphanumeric invocation name')
    bun = Path(shutil.which('bun') or '').resolve()
    expected = json.loads((ROOT / 'package.json').read_text())['engines']['bun']
    version = subprocess.check_output([str(bun), '--version'], text=True).strip()
    if version != expected:
        parser.error(f'Current repository requires Bun {expected}, found {version}')
    out = BASE / 'continuation-20261111' / args.invocation
    if not out.resolve().is_relative_to(BASE.resolve()):
        parser.error('Evidence directory escaped B19')
    out.mkdir(parents=True, exist_ok=False)
    frozen = sources()
    manifest = out / 'source-manifest.json'
    write(manifest, {'card': 'B19', 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                     'inputs': frozen, 'bun': {'path': str(bun), 'version': version, 'sha256': sha(bun)}})
    branches = BASE / 'implementation/branch-controls-r3'
    captures = {
        'B19_TERMINAL_BRANCH_R3_EVIDENCE_DIR': branches / 'terminal/runs' / args.invocation,
        'B19_TOOLCHAIN_BRANCH_EVIDENCE_DIR': branches / 'toolchain/runs' / args.invocation,
        'B19_EXTERNAL_EVIDENCE_DIR': branches / 'external',
        'B19_CHROME_SDK_EVIDENCE_DIR': BASE / 'implementation/chrome-sdk-branch-controls-r1/runs' / args.invocation,
        'B19_BLENDER_SDK_EVIDENCE_DIR': BASE / 'continuation-20261111/blender-sdk-controls/runs' / args.invocation,
        'B19_SDK_ORACLE_EVIDENCE_DIR': BASE / 'continuation-20261111/sdk-oracle-controls/runs' / args.invocation,
        'B19_SDK_SUPERVISION_EVIDENCE_DIR': branches / 'sdk-supervision/runs' / args.invocation,
    }
    rows = []
    with tempfile.TemporaryDirectory(prefix='openbuff-b19-check-') as temporary:
        home = Path(temporary)
        (home / 'config').mkdir()
        env = {'PATH': ':'.join(dict.fromkeys([str(bun.parent), '/usr/local/bin', '/usr/bin', '/bin'])),
               'HOME': str(home), 'XDG_CONFIG_HOME': str(home / 'config'), 'TMPDIR': '/tmp',
               'LANG': 'C.UTF-8', 'TERM': 'xterm-256color', 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test',
               'OPENBUFF_LOCAL_MODE': 'true', 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
               'BUN_OPTIONS': '--no-env-file', **{key: str(value) for key, value in captures.items()}}
        for index, suite in enumerate(args.suite or SUITES):
            if sources() != frozen:
                raise RuntimeError('Source changed before dispatch; freeze a new invocation')
            argv = [str(bun), '--no-env-file', 'test', str(ROOT / suite)]
            log = out / f'{index:02d}-{Path(suite).stem}.log'
            external = captures['B19_EXTERNAL_EVIDENCE_DIR']
            # Identical refusal captures are still newly produced observations.
            # Include rewrite identity so a repeated deterministic case is retained.
            external_before = {file: (sha(file), file.stat().st_mtime_ns, file.stat().st_ctime_ns)
                               for file in external.rglob('*.json')
                               if 'compiled' not in file.relative_to(external).parts} if external.is_dir() else {}
            started = datetime.datetime.now(datetime.timezone.utc).isoformat()
            with log.open('xb') as stream:
                result = subprocess.run(argv, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
            stable = sources() == frozen
            # External fixtures reuse their lane filenames. Copy the original
            # bytes immediately after each invocation before another can write.
            originals = out / f'{index:02d}-external-originals'
            copied = []
            if external.is_dir():
                for file in sorted(external.rglob('*.json')):
                    if 'compiled' in file.relative_to(external).parts:
                        continue
                    if external_before.get(file) == (sha(file), file.stat().st_mtime_ns, file.stat().st_ctime_ns):
                        continue
                    target = originals / file.relative_to(external)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(file, target)
                    copied.append(ref(target))
            row = {'suite': suite, 'argv': argv, 'startedAt': started,
                   'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'exitCode': result.returncode, 'sourceStable': stable, 'log': ref(log),
                   'externalOriginals': copied}
            write(out / f'{index:02d}-result.json', row)
            rows.append(row)
            print(json.dumps({key: row[key] for key in ['suite', 'exitCode', 'sourceStable']}), flush=True)
            if not stable:
                raise RuntimeError('Source changed during execution; receipts retained without current credit')
    artifacts = [ref(file) for key, directory in captures.items() if key != 'B19_EXTERNAL_EVIDENCE_DIR'
                 and directory.is_dir() for file in sorted(directory.rglob('*')) if file.is_file()]
    passed = all(row['exitCode'] == 0 and row['sourceStable'] for row in rows)
    write(out / 'results.json', {'card': 'B19', 'manifest': ref(manifest), 'passed': passed,
                                'suites': rows, 'captures': artifacts,
                                'environment': {'replacement': True, 'keys': sorted(env)},
                                'scope': 'Executed suites and original captures; final edge/oracle adjudication is separate.'})
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
