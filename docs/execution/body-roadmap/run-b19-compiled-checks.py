#!/usr/bin/env python3
"""Build the two B19 standalone consumers and retain their 31 asserted cases."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/B19'


def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(file):
    return {'path': str(file.relative_to(ROOT)), 'sha256': sha(file)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('invocation')
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    if not args.invocation or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.invocation):
        parser.error('Use a unique alphanumeric invocation')
    manifest = (ROOT / args.manifest).resolve()
    frozen = json.loads(manifest.read_text())
    if frozen['card'] != 'B19' or not frozen['inputs']:
        parser.error('A B19 source manifest is required')
    out = BASE / 'continuation-20261111' / args.invocation
    if not out.resolve().is_relative_to(BASE.resolve()):
        parser.error('Evidence escaped B19')
    out.mkdir(parents=True, exist_ok=False)
    bun = Path(shutil.which('bun') or '').resolve()
    expected = json.loads((ROOT / 'package.json').read_text())['engines']['bun']
    version = subprocess.check_output([str(bun), '--version'], text=True).strip()
    if version != expected:
        parser.error(f'Expected Bun {expected}, found {version}')

    def check_sources():
        drift = [name for name, digest in frozen['inputs'].items()
                 if not (ROOT / name).is_file() or sha(ROOT / name) != digest]
        if drift:
            raise RuntimeError('Frozen input drift: ' + ', '.join(drift))

    rows = []
    with tempfile.TemporaryDirectory(prefix='openbuff-b19-compiled-') as temporary:
        home = Path(temporary)
        env = {'PATH': ':'.join([str(bun.parent), '/usr/local/bin', '/usr/bin', '/bin']),
               'HOME': str(home), 'XDG_CONFIG_HOME': str(home), 'TMPDIR': '/tmp', 'LANG': 'C.UTF-8',
               'NEXT_PUBLIC_CB_ENVIRONMENT': 'test', 'OPENBUFF_LOCAL_MODE': 'true',
               'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'BUN_OPTIONS': '--no-env-file'}
        capture = BASE / 'implementation/branch-controls-r3/sdk-supervision/compiled' / args.invocation
        env['B19_SDK_SUPERVISION_COMPILED_EVIDENCE_DIR'] = str(capture)
        for family, source in [
            ('sdk', 'sdk/src/__tests__/fixtures/b19-supervision-sdk-compiled-entry.ts'),
            ('external', 'sdk/src/__tests__/fixtures/external-branch-compiled-entry.ts'),
        ]:
            binary = out / ('b19-' + family)
            command = [str(bun), '--no-env-file', 'build', '--compile', str(ROOT / source), '--outfile', str(binary)]
            check_sources()
            with (out / (family + '-build.log')).open('xb') as log:
                build = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            check_sources()
            if build.returncode != 0 or binary.read_bytes()[:4] != b'\x7fELF':
                raise RuntimeError(f'{family} compiled build failed; retained log')
            cases = []
            for branch in ['initial', 'retry']:
                if family == 'sdk':
                    controls = ['happy', 'denied', 'unavailable', 'pre-aborted', 'literal-zero',
                                'delayed-cancel', 'exhausted-before-admission']
                    if branch == 'retry':
                        controls += ['exhausted-before-retry', 'retry-budget-exhausted']
                    cases.extend((branch, control, 'factory') for control in controls)
                    cases.append((branch, 'happy', 'sdk-run'))
                else:
                    controls = ['happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero',
                                'delayed-authorizer-cancellation']
                    if branch == 'retry':
                        controls.append('exhausted-before-later-branch')
                    cases.extend((branch, control, None) for control in controls)
            for branch, control, mode in cases:
                name = '-'.join(filter(None, [family, branch, control, mode]))
                command = [str(binary), '--repo', str(ROOT), '--branch', branch, '--control', control]
                if mode:
                    command += ['--mode', mode]
                check_sources()
                with (out / (name + '.log')).open('xb') as log:
                    result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
                check_sources()
                files = list(capture.glob(f'{mode}--supervised.self-exec.{branch}--{control}--*.json')) if mode else [
                    BASE / f'implementation/branch-controls-r3/external/compiled/supervised.self-exec.{branch}--{control}.json']
                assert len(files) == 1 and files[0].is_file(), 'Missing unique compiled capture'
                raw = json.loads(files[0].read_text())
                branch_field = 'targetBranch' if mode else 'matrixBranch'
                assert raw[branch_field] == 'supervised.self-exec.' + branch, 'Compiled capture branch mismatch'
                assert raw['control'] == control, 'Compiled capture control mismatch'
                if mode:
                    assert raw['mode'] == mode and raw['assertionsCompleted'] is True, 'Incomplete compiled SDK assertions'
                assert files[0].read_bytes() in (out / (name + '.log')).read_bytes(), 'Capture absent from original log'
                copy = out / (name + '.json')
                shutil.copyfile(files[0], copy)
                passed = result.returncode == 0 and raw['status'] == 'passed' and raw['executableSha256'] == sha(binary)
                row = {'family': family, 'branch': branch, 'control': control, 'mode': mode,
                       'argv': command, 'exitCode': result.returncode, 'passed': passed,
                       'capture': ref(copy), 'log': ref(out / (name + '.log')), 'binary': ref(binary),
                       'buildArgv': [str(bun), '--no-env-file', 'build', '--compile', str(ROOT / source), '--outfile', str(binary)],
                       'buildLog': ref(out / (family + '-build.log'))}
                rows.append(row)
                print(json.dumps({key: row[key] for key in ['family', 'branch', 'control', 'mode', 'passed']}), flush=True)
    assert len(rows) == 31
    report = {'card': 'B19', 'manifest': ref(manifest), 'runner': ref(Path(__file__)),
              'toolchain': {'path': str(bun), 'version': version, 'sha256': sha(bun)},
              'passed': all(row['passed'] for row in rows), 'cases': rows,
              'scope': '31 standalone compiled consumer cases; full CLI and native enforcement are separate gates.'}
    with (out / 'results.json').open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
