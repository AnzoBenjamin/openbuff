#!/usr/bin/env python3
"""Verify an isolated published distribution and read its matching workflow."""

import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import time

OUT = Path(__file__).resolve().parent
METADATA = Path('/tmp/openbuff-agent-browser-registry-latest.json')
ARCHIVE = Path('/tmp/openbuff-agent-browser-0.41.2.tgz')
VERSION = '0.41.2'


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


metadata = json.loads(METADATA.read_text())
assert metadata['name'] == 'agent-browser' and metadata['version'] == VERSION
assert metadata['license'] == 'Apache-2.0'
algorithm, integrity = metadata['dist']['integrity'].split('-', 1)
assert algorithm == 'sha512'
with ARCHIVE.open('rb') as handle:
    digest = hashlib.file_digest(handle, algorithm).digest()
assert digest == base64.b64decode(integrity)
with ARCHIVE.open('rb') as handle:
    assert hashlib.file_digest(handle, 'sha1').hexdigest() == metadata['dist']['shasum']

workspace = Path(tempfile.mkdtemp(prefix='openbuff-rweb-toolchain-'))
with tarfile.open(ARCHIVE, 'r:gz') as archive:
    members = archive.getmembers()
    assert sum(member.size for member in members) <= 130 * 1024 * 1024
    for member in members:
        assert member.isfile() or member.isdir()
        target = workspace / member.name
        assert target.resolve().is_relative_to(workspace / 'package')
    archive.extractall(workspace, filter='data')

package = workspace / 'package'
manifest = json.loads((package / 'package.json').read_text())
assert manifest['version'] == VERSION
assert manifest['engines'] == metadata['engines']
native = package / 'bin/agent-browser-linux-x64'
assert native.is_file()
archive_mode = native.stat().st_mode & 0o777
native.chmod(0o755)
assert os.access(native, os.X_OK)
node = shutil.which('node')
assert node
for name in ['home', 'config', 'cache', 'data', 'runtime', 'artifacts']:
    (workspace / name).mkdir(mode=0o700)
environment = {
    'PATH': '/usr/local/bin:/usr/bin:/bin',
    'HOME': str(workspace / 'home'),
    'XDG_CONFIG_HOME': str(workspace / 'config'),
    'XDG_CACHE_HOME': str(workspace / 'cache'),
    'XDG_DATA_HOME': str(workspace / 'data'),
    'XDG_RUNTIME_DIR': str(workspace / 'runtime'),
    'LANG': 'C.UTF-8',
    'TERM': 'dumb',
}
commands = []


def run(name, argv, output_name):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    start = time.monotonic()
    result = subprocess.run(argv, cwd=workspace, env=environment,
                            capture_output=True, timeout=30)
    stdout = OUT / output_name
    stderr = OUT / f'{name}.stderr.log'
    with stdout.open('xb') as handle:
        handle.write(result.stdout)
    with stderr.open('xb') as handle:
        handle.write(result.stderr)
    commands.append({
        'name': name, 'argv': argv, 'cwd': str(workspace),
        'startedAt': started, 'elapsedSeconds': time.monotonic() - start,
        'exitCode': result.returncode,
        'stdout': {'path': str(stdout), 'sha256': sha(stdout)},
        'stderr': {'path': str(stderr), 'sha256': sha(stderr)},
        'environment': {'replacement': True, 'keys': sorted(environment),
                        'privateHome': str(workspace / 'home')},
    })
    with (OUT / f'{name}.json').open('x') as handle:
        json.dump(commands[-1], handle, indent=2)
        handle.write('\n')
    assert result.returncode == 0, (name, result.returncode)
    return result.stdout.decode()


# The selected distribution supplies the workflow before any browser command.
guide = run('native-core-guide', [str(native), 'skills', 'get', 'core'], 'core-guide.md')
wrapper = [node, str(package / 'bin/agent-browser.js')]
wrapper_guide = run('wrapper-core-guide', [*wrapper, 'skills', 'get', 'core'],
                    'wrapper-core-guide.md')
assert guide == wrapper_guide
native_version = run('native-version', [str(native), '--version'], 'native-version.log').strip()
wrapper_version = run('wrapper-version', [*wrapper, '--version'], 'wrapper-version.log').strip()
assert VERSION in native_version and native_version == wrapper_version
node_version = run('node-version', [node, '--version'], 'node-version.log').strip()
assert int(node_version.lstrip('v').split('.')[0]) >= 24
run('native-help', [str(native), '--help'], 'native-help.log')

files = [{'path': str(path.relative_to(package)), 'bytes': path.stat().st_size,
          'sha256': sha(path)} for path in sorted(package.rglob('*')) if path.is_file()]
with (OUT / 'published-package.json').open('xb') as handle:
    handle.write(METADATA.read_bytes())
result = {
    'schemaVersion': 1,
    'type': 'researcher-browser-verified-development-toolchain',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'version': VERSION,
    'distribution': {'url': metadata['dist']['tarball'],
                     'sha256': sha(ARCHIVE), 'integrity': metadata['dist']['integrity'],
                     'integrityVerified': True,
                     'packageMetadata': {'path': str(OUT / 'published-package.json'),
                                         'sha256': sha(OUT / 'published-package.json')},
                     'engines': manifest['engines'], 'license': manifest['license']},
    'host': {'system': platform.system(), 'architecture': platform.machine()},
    'workspace': str(workspace),
    'native': {'path': str(native), 'sha256': sha(native), 'version': native_version,
               'archiveMode': archive_mode, 'activeMode': native.stat().st_mode & 0o777},
    'wrapper': {'path': str(package / 'bin/agent-browser.js'),
                'sha256': sha(package / 'bin/agent-browser.js'),
                'node': node, 'nodeVersion': node_version, 'version': wrapper_version},
    'matchingCoreGuides': True,
    'packageFiles': files,
    'commands': commands,
    'scope': 'Isolated extracted development distribution; no package postinstall, browser installation or Openbuff integration executed.',
    'researcherImplementationAccepted': False,
}
with (OUT / 'toolchain.json').open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
print(json.dumps({'version': VERSION, 'nativeVersion': native_version,
                  'nodeVersion': node_version, 'workspace': str(workspace),
                  'packageFiles': len(files), 'matchingCoreGuides': True}))
