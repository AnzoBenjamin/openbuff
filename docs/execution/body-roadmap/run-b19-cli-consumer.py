#!/usr/bin/env python3
"""Build and observe a new owned B19 CLI read/edit/terminal consumer."""

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
import socketserver
import subprocess
import tempfile
import threading


ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/B19/continuation-20261111'
PEER = '''const fs = require('node:fs')
fs.writeFileSync('command.json', JSON.stringify({
  content: fs.readFileSync('input.txt', 'utf8'),
  environment: Object.fromEntries(['PROJECT_VALUE', 'OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
}), { flag: 'wx' })
'''
STRATEGY = '''export default {
  id: 'b19-owned', displayName: 'Owned B19 proof', model: 'fixture/local',
  outputMode: 'structured_output', terminalPermissionProfile: 'full-access',
  toolNames: ['read_files', 'edit_transaction', 'run_terminal_command', 'set_output'],
  handleSteps: function* () {
    const read = (yield { toolName: 'read_files', input: { paths: ['input.txt'] } }).toolResult;
    function capability(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.readCapability === 'string') return value.readCapability;
      for (const sub of Object.values(value)) { const item = capability(sub); if (item) return item; }
    }
    const basis = capability(read);
    if (!basis || !JSON.stringify(read).includes('before')) throw new Error('Missing observed edit basis');
    yield { toolName: 'edit_transaction', input: { edits: [
      { type: 'str_replace', path: 'input.txt', replacements: [{ oldString: 'before\\n', newString: 'after\\n', basedOnRead: basis }] }
    ] } };
    // The command is owned fixture data, never derived from the user prompt.
    yield { toolName: 'run_terminal_command', input: { process_type: 'SYNC', command: __COMMAND__ } };
    yield { toolName: 'set_output', input: { observed: true } };
  },
};
'''


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(path):
    return {'path': path.resolve().relative_to(ROOT).as_posix(), 'sha256': sha(path)}


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def invoke(argv, cwd, env, output, errors=None, timeout=60):
    started = datetime.now(timezone.utc).isoformat()
    with output.open('xb') as stream, (errors or Path(os.devnull)).open('wb') as err:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=stream, stderr=err if errors else subprocess.STDOUT,
                                 start_new_session=True)
        try:
            status = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            status = 124
    return {'argv': argv, 'cwd': str(cwd), 'exitCode': status, 'startedAt': started,
            'finishedAt': datetime.now(timezone.utc).isoformat(), 'log': ref(output),
            **({'stderr': ref(errors)} if errors else {})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-manifest', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(BASE.resolve()):
        parser.error('CLI proof output must stay in the owned B19 continuation')
    manifest_path = args.source_manifest.resolve(strict=True)
    manifest = json.loads(manifest_path.read_text())
    compiler = Path(manifest['bun']['path']).resolve(strict=True)
    assert manifest['card'] == 'B19' and manifest['inputs'] and sha(compiler) == manifest['bun']['sha256']
    assert manifest['bun']['version'] == '1.4.4'

    def verify_inputs():
        assert all((ROOT / filename).is_file() and sha(ROOT / filename) == digest
                   for filename, digest in manifest['inputs'].items()), 'B19 CLI source changed'

    verify_inputs()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    bindings = {'sourceManifest': ref(manifest_path), 'before': manifest['inputs'],
                'compiler': {'path': str(compiler), 'sha256': sha(compiler)}}
    shutil.copyfile(Path(__file__), out / 'runner.py')
    version = json.loads((ROOT / 'cli/package.json').read_text())['version']
    with tempfile.TemporaryDirectory(prefix='openbuff-b19-cli-') as temp:
        tmp = Path(temp)
        for name in ['home', 'xdg', 'project', 'config', 'cache', 'data']:
            (tmp / name).mkdir(mode=0o700)
        env = {'PATH': os.environ['PATH'], 'HOME': str(tmp / 'home'),
               'XDG_CONFIG_HOME': str(tmp / 'xdg'), 'XDG_CACHE_HOME': str(tmp / 'cache'),
               'XDG_DATA_HOME': str(tmp / 'data'), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
               'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'BUN_OPTIONS': '--no-env-file'}
        sidecar = ROOT / 'rust/target/release/openbuff-intelligence'
        assert sidecar.is_file(), 'Select the existing release intelligence sidecar before this portable CLI proof'
        build_env = {**env, 'CARGO_NET_OFFLINE': 'true', 'OPENBUFF_COMPILER_BIN': str(compiler),
                     'OPENBUFF_INTELLIGENCE_BINARY': str(sidecar)}
        build = invoke([str(compiler), '--no-env-file', '--no-install', 'run', 'cli/scripts/build-binary.ts',
                        'openbuff', version, '--smoke-built-binary'], ROOT, build_env,
                       out / 'build.log', timeout=295)
        write(out / 'build-receipt.json', {**build, 'selectedExistingIntelligenceSidecar': ref(sidecar)})
        assert build['exitCode'] == 0, build
        verify_inputs()
        # Keep only the current Linux package assets, not pre-existing Windows
        # or experimental binaries in the shared ignored build directory.
        built = ROOT / 'cli/bin'
        selected = [built / name for name in ['openbuff', 'openbuff-intelligence',
                    'repository-intelligence-manifest.json', 'tree-sitter-manifest.json', 'rg']]
        selected += list(built.glob('*.wasm')) + list((built / 'tree-sitter-queries').glob('*.scm'))
        for file in selected:
            assert file.is_file() and not file.is_symlink(), file
            dest = out / 'bin' / file.relative_to(built)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, dest)
        binary = out / 'bin/openbuff'
        with binary.open('rb') as stream:
            assert stream.read(4) == b'\x7fELF'
        assert sha(binary) == sha(built / 'openbuff')
        package_inventory = {p.relative_to(out / 'bin').as_posix(): sha(p)
                             for p in (out / 'bin').rglob('*') if p.is_file()}
        checks = []
        for label, flags in [('version', ['--version']), ('help', ['run', '--help'])]:
            result = invoke([str(binary), *flags], tmp / 'project', env, out / (label + '.log'))
            assert result['exitCode'] == 0, result
            checks.append(result)
        write(out / 'smoke-receipts.json', checks)
        project = tmp / 'project'
        node = '/usr/bin/node'
        assert Path(node).is_file()
        strategy = STRATEGY.replace('__COMMAND__', json.dumps(f'exec {shlex.quote(node)} ./peer.cjs'))
        agents = project / '.agents'
        agents.mkdir()
        (agents / 'b19-owned.mjs').write_text(strategy)
        (out / 'strategy.mjs').write_text(strategy)
        (out / 'peer.cjs').write_text(PEER)
        (project / 'peer.cjs').write_text(PEER)
        (project / 'input.txt').write_bytes(b'before\n')
        connections = []

        class Capture(socketserver.BaseRequestHandler):
            def handle(self):
                connections.append(self.client_address[0])
                # The configured route retains its required HTTPS scheme.
                # This observer counts TCP connections before TLS and must
                # never serve inference; any connection fails the proof.

        with socketserver.TCPServer(('127.0.0.1', 0), Capture) as recorder:
            thread = threading.Thread(target=recorder.serve_forever, daemon=True)
            thread.start()
            try:
                cfg = {'autoFileChangeHooks': False, 'defaultModel': 'fixture/local',
                       'providers': {'fixture': {'type': 'openai-compatible',
                         'baseURL': f'https://127.0.0.1:{recorder.server_address[1]}/v1',
                         'apiKeyEnv': 'CUSTOM_PROVIDER_KEY', 'models': ['local']}}}
                write(out / 'config.json', cfg)
                run_env = {**env, 'OPENBUFF_CONFIG_DIR': str(tmp / 'config'),
                           'OPENBUFF_PROVIDER_CONFIG': str(out / 'config.json'), 'OPENBUFF_PROCESS_SUPERVISION': '0',
                           'PROJECT_VALUE': 'captured-cli-project', 'OPENAI_API_KEY': 'b19-synthetic-canonical',
                           'CUSTOM_PROVIDER_KEY': 'b19-synthetic-configured'}
                result = invoke([str(binary), '--approval-mode', 'allow-all', 'run', '--json',
                                 '--trust-project-agents', '--agent', 'b19-owned', '--timeout', '30',
                                 '-p', 'Verify the owned B19 fixture'], project, run_env, out / 'run.log',
                                out / 'run.stderr.log', timeout=100)
            finally:
                recorder.shutdown()
                thread.join()
        write(out / 'run-receipt.json', {**result, 'environmentKeys': sorted(run_env),
                                         'providerConnections': connections})
        assert result['exitCode'] == 0, result
        assert connections == [], 'Fixture unexpectedly tried its provider'
        assert all(line.startswith('{') for line in (out / 'run.log').read_text().splitlines() if line)
        events = [json.loads(line) for line in (out / 'run.log').read_text().splitlines() if line]
        finishes = [event for event in events if event['type'] == 'finish']
        assert len(finishes) == 1 and finishes[0]['runOutcome']['termination'] == 'completed'
        selected = {'read_files', 'edit_transaction', 'run_terminal_command'}
        results = [event for event in events if event.get('type') == 'tool_result' and event.get('toolName') in selected]
        assert len(results) == 3 and {e['toolName'] for e in results} == selected
        actions = [event['actionOutcome'] for event in results]
        assert all(action['outcome'] == 'succeeded' for action in actions)
        assert len({action['runId'] for action in actions}) == 1 and len({action['actionId'] for action in actions}) == 3
        edit = next(action for action in actions if action['toolName'] == 'edit_transaction')
        assert edit['effect']['status'] == 'confirmed' and edit['effect']['receiptIds']
        terminal = next(e for e in results if e['toolName'] == 'run_terminal_command')['output'][0]['value']
        assert terminal['exitCode'] == 0 and terminal['executionBindingVersion'] == 2
        assert re.fullmatch('[a-f0-9]{64}', terminal['executionBindingDigest'])
        peer = json.loads((project / 'command.json').read_text())
        assert peer == {'content': 'after\n', 'environment': {'PROJECT_VALUE': 'captured-cli-project'}}
        assert (project / 'input.txt').read_bytes() == b'after\n'
        write(out / 'command.json', peer)
        verify_inputs()
        bindings.update(after=manifest['inputs'], binary=ref(binary), build=ref(out / 'build-receipt.json'),
                        packagedFiles=package_inventory, runner=ref(out / 'runner.py'))
        write(out / 'source-binding.json', bindings)
        limits = ['Local rebuilt Linux CLI with selected existing intelligence sidecar; no registry installation, native build or non-Linux assurance.',
                  'Owned loopback provider recorder and synthetic canaries; no OS-wide network-confinement claim.']
        write(out / 'result.json', {'passed': True, 'exitCode': result['exitCode'], 'binary': ref(binary),
             'checks': {'help': True, 'version': True, 'ownedAfterBytes': True, 'credentialScrub': True,
                        'realActionOutcomes': True, 'executionBindingV2': True}, 'networkRequests': connections,
             'limits': limits})
        write(out / 'assertion-addendum.json', {'passed': True, 'actions': actions,
                                               'terminalBindingDigest': terminal['executionBindingDigest'],
                                               'basis': ref(out / 'run.log')})
    print(json.dumps({'passed': True, 'result': ref(out / 'result.json'), 'sourceBinding': ref(out / 'source-binding.json')}))


if __name__ == '__main__':
    main()
