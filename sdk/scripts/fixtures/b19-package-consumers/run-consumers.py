#!/usr/bin/env python3
"""Offline B19 packed consumers against a fresh source-stable Bun 1.4.4 build."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NODE = Path('/usr/bin/node')
PACK_NODE = Path('/home/ben/.local/share/mise/installs/node/26/bin/node')
NPM_CLI = Path('/home/ben/.local/share/mise/installs/node/26/lib/node_modules/npm/bin/npm-cli.js')
SCRIPTS = ['consumer-common.cjs', 'consumer-esm.mjs', 'consumer-cjs.cjs', 'peer.cjs', 'reject-workspace-loader.mjs', 'prepare-build.py']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_record(file):
    return {'sha256': sha(file.read_bytes()), 'bytes': file.stat().st_size}


def checked_reference(reference, label):
    if not isinstance(reference, dict) or not isinstance(reference.get('path'), str) or not isinstance(reference.get('sha256'), str):
        raise ValueError(label + ' must contain a path and SHA-256')
    file = (ROOT / reference['path']).resolve(strict=True)
    if not file.is_relative_to(ROOT) or not file.is_file():
        raise ValueError(label + ' must reference an existing repository file')
    observed = file_record(file)
    if observed['sha256'] != reference['sha256']:
        raise ValueError(label + ' hash differs from its recorded reference: ' + reference['path'])
    return {'path': str(file.relative_to(ROOT)), **observed}


def validate_build_ready(reference, build_sha256, expected_candidate):
    ready_reference = checked_reference({'path': reference, 'sha256': build_sha256}, 'Build-ready observation')
    ready = json.loads((ROOT / ready_reference['path']).read_text())
    if ready.get('schemaVersion') != 1 or ready.get('type') != 'body-package-build-ready-observation' or ready.get('card') != 'B19':
        raise ValueError('Expected a fresh B19 package build-ready observation')
    execution_ref = checked_reference(ready.get('executionReceipt'), 'Observed build command receipt')
    execution = json.loads((ROOT / execution_ref['path']).read_text())
    if execution.get('exitCode') != 0 or execution.get('timedOut') is not False or execution.get('sourceChangesDuringCommand') != [] or execution.get('command') != ['bun', 'run', '--cwd', 'sdk', 'build'] or execution.get('cwd') != str(ROOT):
        raise ValueError('Observed build did not complete the expected workspace build command')
    if ready.get('bunVersion') != '1.4.4':
        raise ValueError('Expected the currently supported Bun 1.4.4 build')
    candidate_reference = checked_reference(expected_candidate, 'Expected source manifest')
    if ready.get('sourceBefore') != candidate_reference:
        raise ValueError('Build-ready observation is not bound to the expected source manifest')
    after_reference = checked_reference(ready.get('sourceAfter'), 'Post-build source manifest')
    before = json.loads((ROOT / candidate_reference['path']).read_text()).get('files')
    after = json.loads((ROOT / after_reference['path']).read_text()).get('files')
    if not isinstance(before, dict) or not before or before != after:
        raise ValueError('Build source observations do not establish zero source drift')
    for name, digest in before.items():
        checked_reference({'path': name, 'sha256': digest}, 'Current build source input')
    log_reference = checked_reference(ready.get('log'), 'Observed build log')
    if log_reference['path'] != str((ROOT / execution_ref['path']).parent.joinpath(execution['log']).relative_to(ROOT)):
        raise ValueError('Build log does not match the observed build command receipt')
    return {'observation': ready_reference, 'executionReceipt': execution_ref, 'log': log_reference,
            'sourceBefore': candidate_reference, 'sourceAfter': after_reference, 'sourceInputs': len(before),
            'sourceChangesDuringCommand': [], 'bunVersion': ready['bunVersion'],
            'distBinding': 'Dist bytes independently observed by this consumer invocation before packing.'}


def inventory(directory):
    return {str(p.relative_to(directory)): file_record(p)
            for p in sorted(directory.rglob('*')) if p.is_file()}


def source_snapshot():
    result = {}
    for folder in ['sdk/src', 'sdk/scripts', 'common/src', 'packages/agent-runtime/src', 'packages/indexer/src', 'packages/code-map/src', 'packages/internal/src']:
        for name, record in inventory(ROOT / folder).items():
            result[folder + '/' + name] = record
    for name in ['sdk/package.json', 'sdk/tsconfig.json', 'package.json', 'bun.lock']:
        result[name] = file_record(ROOT / name)
    for name in SCRIPTS + ['run-consumers.py', 'README.md']:
        result[str((HERE / name).relative_to(ROOT))] = file_record(HERE / name)
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def run_command(out, name, command, cwd, env, timeout=45):
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    timed_out = False
    with (out / (name + '.stdout.log')).open('wb') as log:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
    result = {'command': [str(part) for part in command], 'cwd': str(cwd), 'startedAt': started,
              'durationSeconds': time.monotonic() - start, 'exitCode': code, 'timedOut': timed_out,
              'stdout': str(out / (name + '.stdout.log')), **file_record(out / (name + '.stdout.log'))}
    write_json(out / (name + '.command.json'), result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attempt', help='Unique immutable attempt directory name')
    parser.add_argument('--build-ready', required=True, help='Fresh build-ready observation reference')
    parser.add_argument('--output-dir', default='docs/execution/body-roadmap/evidence/B19/continuation-20261111/package-consumers/runs')
    parser.add_argument('--build-ready-sha256', required=True)
    parser.add_argument('--candidate-manifest', required=True)
    parser.add_argument('--candidate-manifest-sha256', required=True)
    args = parser.parse_args()
    if not all(re.fullmatch(r'[0-9a-f]{64}', value) for value in [args.build_ready_sha256, args.candidate_manifest_sha256]):
        parser.error('Exact lowercase SHA-256 pins are required')
    if not args.attempt.replace('-', '').replace('_', '').isalnum():
        parser.error('Attempt name must contain only letters, digits, hyphens and underscores')
    out = (ROOT / args.output_dir / args.attempt).resolve()
    owned = ROOT / 'docs/execution/body-roadmap/evidence/B19'
    if not out.is_relative_to(owned.resolve()):
        parser.error('Output directory must stay under owned B19 evidence')
    out.mkdir(parents=True, exist_ok=False)
    for name in SCRIPTS + ['run-consumers.py', 'README.md']:
        shutil.copyfile(HERE / name, out / (name + '.source.txt'))
    before = source_snapshot()
    write_json(out / 'source-before.json', before)
    dist_observed_at = datetime.now(timezone.utc).isoformat()
    artifacts_before = inventory(ROOT / 'sdk/dist')
    write_json(out / 'dist-before.json', artifacts_before)
    record = {'schemaVersion': 1, 'card': 'B19', 'status': 'running', 'buildReadyReference': args.build_ready,
              'distObservation': {'observedAt': dist_observed_at, 'inventory': str(out / 'dist-before.json'),
                                  'basis': 'Current consumer invocation, before pack; not a historical build-output attestation'},
              'scope': 'package-public boundary only; no B19/B31/all-feature/OS/process-tree/installation acceptance', 'commands': {}}
    scratch = None
    try:
        # Reject an unbound, failed, stale, or altered build reference before any subprocess.
        record['buildReadyBinding'] = validate_build_ready(args.build_ready, args.build_ready_sha256, {'path': args.candidate_manifest, 'sha256': args.candidate_manifest_sha256})
        assert NODE.is_file() and PACK_NODE.is_file() and NPM_CLI.is_file(), 'Pinned runtime or local npm is unavailable'
        runtime = subprocess.check_output([NODE, '--version'], text=True).strip()
        assert runtime == 'v20.20.2', 'Consumer runtime pin changed: ' + runtime
        pack_runtime = subprocess.check_output([PACK_NODE, '--version'], text=True).strip()
        assert pack_runtime == 'v26.1.0', 'Pack runtime pin changed: ' + pack_runtime
        npm_version = json.loads((NPM_CLI.parent.parent / 'package.json').read_text())['version']
        assert npm_version == '11.13.0', 'Local npm pin changed: ' + npm_version
        record['runtimes'] = {'consumer': {'path': str(NODE), 'version': runtime, **file_record(NODE)},
                              'pack': {'path': str(PACK_NODE), 'version': pack_runtime, **file_record(PACK_NODE)},
                              'npm': {'path': str(NPM_CLI), 'version': npm_version, **file_record(NPM_CLI)}}
        assert all(name in artifacts_before for name in ['index.mjs', 'index.cjs', 'index.d.ts']), 'Missing built SDK artifact'
        pack_home = out / 'pack-home'
        pack_home.mkdir()
        pack_env = {'PATH': str(PACK_NODE.parent) + ':/usr/bin:/bin', 'HOME': str(pack_home),
                    'npm_config_cache': str(out / 'npm-cache'), 'npm_config_update_notifier': 'false',
                    'npm_config_ignore_scripts': 'true', 'npm_config_offline': 'true'}
        pack = run_command(out, 'pack', [PACK_NODE, NPM_CLI, 'pack', '.', '--ignore-scripts', '--offline', '--json', '--pack-destination', out], ROOT / 'sdk', pack_env)
        record['commands']['pack'] = pack
        assert pack['exitCode'] == 0 and not pack['timedOut'], 'Offline local pack failed'
        archives = list(out.glob('*.tgz'))
        assert len(archives) == 1, 'Expected exactly one local package tarball'
        tarball = archives[0]
        record['tarball'] = {'path': str(tarball), **file_record(tarball)}
        scratch = Path(tempfile.mkdtemp(prefix='openbuff-b19-package-consumer-'))
        record['isolatedConsumerDirectory'] = str(scratch)
        sdk_dir = scratch / 'node_modules/@openbuff/sdk'
        sdk_dir.mkdir(parents=True)
        with tarfile.open(tarball, 'r:gz') as archive:
            for member in archive.getmembers():
                member_path = Path(member.name)
                assert member_path.parts and member_path.parts[0] == 'package', 'Unexpected tarball root'
                assert not member_path.is_absolute() and '..' not in member_path.parts, 'Unsafe tarball path'
                assert member.isfile() or member.isdir(), 'Unexpected tarball link or special file'
                relative = Path(*member_path.parts[1:])
                target = sdk_dir / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
                    target.chmod(member.mode & 0o777)
        extracted = inventory(sdk_dir)
        write_json(out / 'extracted-artifacts.json', extracted)
        assert {name[5:]: value for name, value in extracted.items() if name.startswith('dist/')} == artifacts_before, 'Packed dist differs from the current pre-pack observation'
        package = json.loads((sdk_dir / 'package.json').read_text())
        assert package['name'] == '@openbuff/sdk'
        dependencies = {}
        for name, declared in package['dependencies'].items():
            assert not name.startswith(('@codebuff/', '@openbuff/')), 'Workspace dependency cannot be linked'
            candidates = [ROOT / 'sdk/node_modules' / name, ROOT / 'node_modules' / name]
            actual = next((candidate.resolve() for candidate in candidates if (candidate / 'package.json').is_file()), None)
            assert actual is not None, 'Declared dependency is not already installed: ' + name
            manifest = json.loads((actual / 'package.json').read_text())
            assert manifest['name'] == name, 'Dependency directory does not match its declared name'
            if declared[:1].isdigit():
                assert manifest['version'] == declared, 'Installed exact dependency pin differs: ' + name
            link = scratch / 'node_modules' / name
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(actual, target_is_directory=True)
            dependencies[name] = {'declared': declared, 'version': manifest['version'], 'installedDirectory': str(actual),
                                  'manifest': file_record(actual / 'package.json')}
        write_json(out / 'linked-dependencies.json', dependencies)
        record['dependencies'] = {'count': len(dependencies), 'manifest': str(out / 'linked-dependencies.json'),
                                  'lockfile': file_record(ROOT / 'bun.lock'),
                                  'policy': 'Only existing manifest-declared third-party packages linked individually; no node_modules root or workspace-source aliases'}
        for name in SCRIPTS:
            shutil.copyfile(HERE / name, scratch / name)
        write_json(scratch / 'package.json', {'name': 'b19-tarball-consumer', 'private': True, 'type': 'module'})
        child_env = {'PATH': '/usr/bin:/bin', 'HOME': str(scratch / 'home'), 'NODE_ENV': 'test',
                     'OPENBUFF_PROCESS_SUPERVISION': '0', 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
                     'B19_WORKSPACE_ROOT': str(ROOT)}
        (scratch / 'home').mkdir()
        for format, entry in [('esm', 'consumer-esm.mjs'), ('cjs', 'consumer-cjs.cjs')]:
            command = [NODE, '--experimental-loader', './reject-workspace-loader.mjs', './' + entry, out / (format + '.result.json')]
            record['commands'][format] = run_command(out, format, command, scratch, child_env)
        results = {}
        for format in ['esm', 'cjs']:
            result_file = out / (format + '.result.json')
            results[format] = json.loads(result_file.read_text()) if result_file.is_file() else {'status': 'missing-result'}
        record['consumerResults'] = {format: {'status': result['status'], 'scenarios': len(result.get('scenarios', [])),
                                           'fetchCalls': result.get('fetchCalls'), 'failure': result.get('failure')} for format, result in results.items()}
        assert all(record['commands'][format]['exitCode'] == 0 and not record['commands'][format]['timedOut'] and results[format]['status'] == 'passed' for format in results), 'At least one actual tarball consumer failed'
        record['status'] = 'scoped-checks-passed'
    except Exception as error:
        record['status'] = 'failed'
        record['failure'] = str(error)
    finally:
        after = source_snapshot()
        write_json(out / 'source-after.json', after)
        artifacts_after = inventory(ROOT / 'sdk/dist')
        write_json(out / 'dist-after.json', artifacts_after)
        record['sourceChangesDuringCommand'] = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
        record['distChangesDuringCommand'] = sorted(name for name in set(artifacts_before) | set(artifacts_after) if artifacts_before.get(name) != artifacts_after.get(name))
        if record['sourceChangesDuringCommand'] or record['distChangesDuringCommand']:
            record['status'] = 'source-drift'
        if scratch is not None:
            # Keep generated peer traces on both successful and failed attempts.
            scenarios = scratch / 'scenarios'
            if scenarios.exists():
                shutil.copytree(scenarios, out / 'scenario-files')
            shutil.rmtree(scratch)
        write_json(out / 'raw.json', record)
        print(json.dumps(record))
    return 0 if record['status'] == 'scoped-checks-passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
