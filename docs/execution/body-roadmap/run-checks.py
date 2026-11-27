#!/usr/bin/env python3
"""Record current-source integration checks without inheriting user credentials."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('check')
parser.add_argument('--bun', default=os.environ.get('BODY_BUN', 'bun'))
parser.add_argument('--evidence-dir', type=Path,
                    default=ROOT / 'docs/execution/body-roadmap/evidence/integration')
args = parser.parse_args()
OUT = ROOT / args.evidence_dir
if not OUT.is_relative_to(ROOT):
    raise SystemExit('Persistent acceptance evidence must stay inside the repository')
OUT_RELATIVE = OUT.relative_to(ROOT)
if '..' in OUT_RELATIVE.parts:
    raise SystemExit('Persistent acceptance evidence must not traverse parent directories')
bun_executable = shutil.which(args.bun)
if bun_executable is None:
    raise SystemExit('Resolve Bun 1.3.5 and provide its executable in BODY_BUN')
BUN = Path(bun_executable).resolve()
NODE = shutil.which('node')


def open_evidence_directory(create=False):
    """Anchor every output component without following substituted symlinks."""
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise SystemExit('Evidence recording requires no-follow directory handles')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(ROOT, flags)
    try:
        for component in OUT_RELATIVE.parts:
            if create:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_current_evidence_directory(descriptor):
    current = open_evidence_directory()
    try:
        held = os.fstat(descriptor)
        named = os.fstat(current)
        if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
            raise SystemExit('Evidence directory changed while recording; no receipt is sealed')
    finally:
        os.close(current)


def sha(file):
    with file.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
        return digest.hexdigest()


def source_hashes():
    tracked = subprocess.check_output(['git', 'diff', '--name-only', '--diff-filter=ACMR', '-z'], cwd=ROOT).split(b'\0')
    added = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=ROOT).split(b'\0')
    source_roots = {'agents', 'cli', 'common', 'sdk', 'packages', 'scripts', 'evals', 'test'}
    names = {os.fsdecode(name) for name in tracked if name}
    names.update(os.fsdecode(name) for name in added if name
                 and os.fsdecode(name).split('/')[0] in source_roots)
    configs = ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.base.json', 'tsconfig.json',
               'sdk/package.json', 'sdk/tsconfig.json', 'cli/package.json', 'cli/tsconfig.json',
               'cli/src/agents/bundled-agents.generated.ts',
               'docs/execution/body-roadmap/run-checks.py',
               '.agents/sessions/body-capability-review-2026-11-05/PLAN.md',
               '.agents/sessions/body-capability-review-2026-11-05/SPEC.md']
    names = {name for name in names if not name.startswith(('.agents/sessions/', 'docs/execution/'))
             and Path(name).suffix in ['.ts', '.tsx', '.json', '.md', '.py']}
    return {name: sha(ROOT / name) for name in sorted(names | set(configs)) if (ROOT / name).is_file()}


def tests(*files):
    # Absolute file names select these exact suites rather than Bun substring
    # filters that also discover copied historical test snapshots.
    return [str(BUN), '--no-env-file', 'test', '--isolate', *[str(ROOT / file) for file in files]]


commands = {
    'b01-core': tests('sdk/src/__tests__/audit-intelligence.test.ts',
                      'common/src/tools/params/__tests__/write-audit-findings.test.ts',
                      'sdk/src/__tests__/write-audit-findings.test.ts',
                      'agents/__tests__/gate-reviewer.test.ts',
                      'agents/__tests__/code-reviewer.test.ts'),
    'base2': tests('agents/__tests__/base2.test.ts',
                   'agents/__tests__/base2-writer-spawn-rules.test.ts'),
    'approval-bridge': tests('sdk/src/__tests__/serve-approval-bridge.test.ts',
                           'sdk/src/__tests__/serve-bridge.test.ts'),
    'sdk-3d': tests('sdk/src/__tests__/3d-assets.test.ts'),
    'sdk-socket': tests('sdk/src/__tests__/serve-socket.test.ts',
                        'sdk/src/__tests__/serve-bridge.test.ts',
                        'sdk/src/__tests__/acp-outcomes.test.ts'),
    'typecheck': [str(BUN), '--no-env-file', 'run', 'typecheck'],
    'typecheck-after-socket': [str(BUN), '--no-env-file', 'run', 'typecheck'],
    'cli-typecheck': [str(BUN), '--no-env-file', 'run', '--cwd', 'cli', 'typecheck'],
    'tool-definitions': [str(BUN), '--no-env-file', 'run', 'generate-tool-definitions'],
    'gate-helpers': [str(BUN), '--no-env-file', 'run', 'scripts/generate-gate-helpers.ts', '--check', 'agents/base2/base2.ts'],
    'agent-bundle': [str(BUN), '--no-env-file', 'run', 'cli/scripts/prebuild-agents.ts'],
    'cli-build': [str(BUN), '--no-env-file', 'run', 'cli/scripts/build-binary.ts',
                  'openbuff', json.loads((ROOT / 'cli/package.json').read_text())['version'],
                  '--smoke-built-binary'],
    'sdk-build': [str(BUN), '--no-env-file', 'run', '--cwd', 'sdk', 'build'],
    'cli-help': [str(BUN), '--no-env-file', 'run', 'cli/src/index.tsx', '--help'],
    'binary-help': [str(ROOT / 'cli/bin/openbuff'), '--help'],
    'binary-version': [str(ROOT / 'cli/bin/openbuff'), '--version'],
    'binary-run-help': [str(ROOT / 'cli/bin/openbuff'), 'run', '--help'],
    'cli-tests': [str(BUN), '--no-env-file', 'run', '--cwd', 'cli', 'test'],
    'agents-suite': [str(BUN), '--no-env-file', 'run', '--cwd', 'agents', 'test'],
    'common-suite': [str(BUN), '--no-env-file', 'run', '--cwd', 'common', 'test'],
    'diff-check': ['git', 'diff', '--check'],
}

name = args.check
guards = {'memory-drift', 'sync-agent-config', 'determinism', 'mock-module',
          'project-root', 'byok-wording', 'dependency-provenance', 'types-declaration'}
if name.startswith('guard-') and name.removeprefix('guard-') in guards:
    commands[name] = [str(BUN), '--no-env-file', 'run', '--cwd', 'scripts',
                      'guard:' + name.removeprefix('guard-')]
packages = {'runtime-suite': 'packages/agent-runtime', 'sdk-suite': 'sdk',
            'sdk-suite-unrestricted': 'sdk',
            'sdk-suite-after-socket': 'sdk',
            'indexer-suite': 'packages/indexer', 'evals-suite': 'evals',
            'internal-suite': 'packages/internal', 'scripts-suite': 'scripts'}
if name in packages:
    files = subprocess.check_output(
        ['rg', '--files', str(ROOT / packages[name]), '-g', '*.test.ts', '-g', '*.test.tsx',
         '-g', '!*.integration.test.ts', '-g', '!**/node_modules/**', '-g', '!**/dist/**'],
        cwd=ROOT, text=True).splitlines()
    if not files:
        raise SystemExit('No test suites discovered for ' + packages[name])
    commands[name] = [str(BUN), '--no-env-file', 'test', '--isolate', *sorted(files)]
if name not in commands:
    raise SystemExit('Unknown check: ' + name)
if subprocess.check_output([str(BUN), '--version'], text=True).strip() != '1.3.5':
    raise SystemExit('Acceptance requires Bun 1.3.5')
output_descriptor = open_evidence_directory(create=True)
for extension in ['.log', '.json', '.exit']:
    try:
        os.stat(name + extension, dir_fd=output_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        continue
    raise SystemExit('Evidence already exists for ' + name + '; select a fresh --evidence-dir')
before = source_hashes()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
with tempfile.TemporaryDirectory(prefix='openbuff-body-integration-') as temporary:
    base = Path(temporary)
    (base / 'home').mkdir()
    (base / 'config').mkdir()
    provider_config = base / 'provider.json'
    provider_config.write_text('{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n')
    env = {
        'PATH': ':'.join(dict.fromkeys([str(BUN.parent), *([str(Path(NODE).parent)] if NODE else []),
                                        '/usr/local/bin', '/usr/bin', '/bin'])),
        'HOME': str(base / 'home'), 'XDG_CONFIG_HOME': str(base / 'config'),
        'TMPDIR': '/tmp', 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
        'OPENBUFF_PROVIDER_CONFIG': str(provider_config),
        'NEXT_PUBLIC_CB_ENVIRONMENT': 'test', 'OPENBUFF_LOCAL_MODE': 'true',
        'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1',
        'BUN_OPTIONS': '--no-env-file',
    }
    if name in packages or name in {'cli-tests', 'agents-suite', 'common-suite'}:
        # Package tests select their own fake project configuration. A global
        # override defeats those tests; empty HOME/XDG and --no-env-file keep
        # user credentials outside the runner environment.
        del env['OPENBUFF_PROVIDER_CONFIG']
    require_current_evidence_directory(output_descriptor)
    log_descriptor = os.open(name + '.log', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=output_descriptor)
    with os.fdopen(log_descriptor, 'w+b') as log:
        result = subprocess.run(commands[name], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        log.flush()
        log.seek(0)
        log_bytes = log.read()
        held_log = os.fstat(log.fileno())
after = source_hashes()
require_current_evidence_directory(output_descriptor)
named_log = os.stat(name + '.log', dir_fd=output_descriptor, follow_symlinks=False)
if (held_log.st_dev, held_log.st_ino) != (named_log.st_dev, named_log.st_ino):
    raise SystemExit('Evidence log changed while recording; no receipt is sealed')
log_text = log_bytes.decode(errors='replace')
count = re.search(r'\n\s+(\d+) pass\n(?:\s+\d+ skip\n)?\s+(\d+) fail', log_text)
receipt = {
    'schemaVersion': 1, 'check': name, 'argv': commands[name], 'cwd': str(ROOT),
    'startedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'elapsedSeconds': time.monotonic() - start, 'exitCode': result.returncode,
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'toolchain': {'executable': str(BUN), 'version': '1.3.5', 'sha256': sha(BUN)},
    'environment': {'replacement': True, 'keys': sorted(env), 'ephemeralHome': True, 'envFileLoading': False},
    'sourceBefore': before, 'sourceAfter': after, 'sourceUnchangedDuringCommand': before == after,
    'log': str(OUT_RELATIVE / (name + '.log')), 'logSha256': hashlib.sha256(log_bytes).hexdigest(),
    'counts': {'pass': int(count[1]), 'fail': int(count[2])} if count else None,
}
for extension, contents in [('.json', json.dumps(receipt, indent=2) + '\n'),
                            ('.exit', str(result.returncode) + '\n')]:
    require_current_evidence_directory(output_descriptor)
    descriptor = os.open(name + extension, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=output_descriptor)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(contents)
os.close(output_descriptor)
print(json.dumps({key: receipt[key] for key in ['check', 'exitCode', 'sourceUnchangedDuringCommand', 'elapsedSeconds', 'counts']}))
print('\n'.join(log_text.splitlines()[-12:]))
raise SystemExit(result.returncode)
