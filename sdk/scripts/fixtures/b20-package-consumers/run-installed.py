#!/usr/bin/env python3
"""Fresh offline packed SDK cancellation proof; checkout imports are barred."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def snapshot():
    files = {}
    for folder in ['sdk/src', 'sdk/scripts', 'common/src', 'packages/agent-runtime/src', 'packages/indexer/src', 'packages/code-map/src', 'packages/internal/src']:
        for file in sorted((ROOT / folder).rglob('*')):
            if file.is_file():
                files[str(file.relative_to(ROOT))] = digest(file)
    for name in ['package.json', 'sdk/package.json', 'bun.lock', 'scripts/body-fixtures/b20-process-tree.mjs']:
        files[name] = digest(ROOT / name)
    return files

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output', help='New B20 evidence directory')
    args = parser.parse_args()
    out = (ROOT / args.output).resolve()
    assert out.is_relative_to(ROOT / 'docs/execution/body-roadmap/evidence/B20')
    out.mkdir(parents=True, exist_ok=False)
    before = snapshot()
    (out / 'source-before.json').write_text(json.dumps(before, indent=2))
    records = []
    scratch = Path(tempfile.mkdtemp(prefix='openbuff-b20-installed-'))
    complete = False
    (out / 'host.json').write_text(json.dumps({'isolatedHost': str(scratch)}))
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(scratch / 'home'), 'OPENBUFF_TELEMETRY': '0',
           'DO_NOT_TRACK': '1', 'B19_WORKSPACE_ROOT': str(ROOT)}
    Path(env['HOME']).mkdir()
    def command(name, argv, cwd, timeout=240):
        started = time.monotonic()
        with (out / (name + '.log')).open('wb') as log:
            run = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        record = {'command': list(map(str, argv)), 'cwd': str(cwd), 'exitCode': run.returncode,
                  'elapsedSeconds': time.monotonic() - started, 'log': name + '.log', 'logSha256': digest(out / (name + '.log'))}
        records.append(record)
        (out / 'commands.json').write_text(json.dumps(records, indent=2))
        assert run.returncode == 0, record
    try:
        bun = shutil.which('bun')
        assert bun
        env['PATH'] = str(Path(bun).parent) + ':' + env['PATH']
        command('build', [bun, 'run', 'scripts/build.ts'], ROOT / 'sdk')
        assert snapshot() == before, 'Source drift invalidates build'
        pack_node = Path('/home/ben/.local/share/mise/installs/node/26/bin/node')
        npm = Path('/home/ben/.local/share/mise/installs/node/26/lib/node_modules/npm/bin/npm-cli.js')
        env.update({'npm_config_offline': 'true', 'npm_config_ignore_scripts': 'true',
                    'npm_config_update_notifier': 'false', 'npm_config_cache': str(scratch / 'npm-cache')})
        command('pack', [str(pack_node), str(npm), 'pack', '.', '--ignore-scripts', '--offline', '--json', '--pack-destination', str(out)], ROOT / 'sdk')
        archives = list(out.glob('*.tgz'))
        assert len(archives) == 1
        package_root = scratch / 'node_modules/@openbuff/sdk'
        package_root.mkdir(parents=True)
        with tarfile.open(archives[0], 'r:gz') as archive:
            for member in archive.getmembers():
                parts = Path(member.name).parts
                assert parts[0] == 'package' and '..' not in parts and (member.isfile() or member.isdir())
                target = package_root.joinpath(*parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
        artifacts = {str(p.relative_to(ROOT / 'sdk/dist')): digest(p) for p in (ROOT / 'sdk/dist').rglob('*') if p.is_file()}
        assert artifacts == {str(p.relative_to(package_root / 'dist')): digest(p) for p in (package_root / 'dist').rglob('*') if p.is_file()}
        package = json.loads((package_root / 'package.json').read_text())
        dependencies = {}
        for name in package['dependencies']:
            assert not name.startswith(('@codebuff/', '@openbuff/'))
            actual = next((p.resolve() for p in [ROOT / 'sdk/node_modules' / name, ROOT / 'node_modules' / name] if (p / 'package.json').is_file()), None)
            assert actual, name
            target = scratch / 'node_modules' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(actual, target_is_directory=True)
            dependencies[name] = {'path': str(actual), 'manifestSha256': digest(actual / 'package.json')}
        shutil.copyfile(HERE / 'consumer.cjs', scratch / 'consumer.cjs')
        shutil.copyfile(ROOT / 'scripts/body-fixtures/b20-process-tree.mjs', scratch / 'tree.mjs')
        shutil.copyfile(HERE.parent / 'b19-package-consumers/reject-workspace-loader.mjs', scratch / 'reject.mjs')
        for format in ['cjs', 'esm']:
            entry = scratch / ('host.' + ('cjs' if format == 'cjs' else 'mjs'))
            entry.write_text("const sdk = " + ("require('@openbuff/sdk'); const {run}=require('./consumer.cjs');" if format == 'cjs' else "await import('@openbuff/sdk'); const {run}=await import('./consumer.cjs');") +
                             f"\nrun(sdk, '{format}', process.argv[2]).catch(error => {{ console.error(error); process.exitCode=1; }});\n")
            command(format, ['/usr/bin/node', '--experimental-loader', str(scratch / 'reject.mjs'), str(entry), str(out / (format + '.json'))], scratch, 30)
        assert snapshot() == before, 'Source drift invalidates installed consumer evidence'
        assert artifacts == {str(p.relative_to(ROOT / 'sdk/dist')): digest(p) for p in (ROOT / 'sdk/dist').rglob('*') if p.is_file()}, 'Artifact drift'
        (out / 'result.json').write_text(json.dumps({'status': 'passed', 'sourceSha256': digest(out / 'source-before.json'),
            'tarballSha256': digest(archives[0]), 'artifacts': artifacts, 'dependencies': dependencies,
            'runtime': {'node': subprocess.check_output(['/usr/bin/node', '--version'], text=True).strip(), 'bun': subprocess.check_output([bun, '--version'], text=True).strip()},
            'scope': 'Packed Node CJS/ESM cancellation and deadline; existing external dependencies linked; no fresh install or native containment claim',
            'commands': records}, indent=2))
        complete = True
    finally:
        # Fixture oracles run before runner teardown. Failed attempts remain.
        if complete:
            shutil.rmtree(scratch)

if __name__ == '__main__':
    main()
