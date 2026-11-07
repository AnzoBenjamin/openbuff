from pathlib import Path
import datetime, hashlib, json, re, subprocess, sys, tempfile, time

root = Path('/home/ben/Code/CLI/openbuff')
here = Path(__file__).resolve().parent
original = root / 'docs/execution/body-roadmap/evidence/B02/independent-approval/approval.json'
old = json.loads(original.read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
ref = lambda path: {'path': str(path.relative_to(root)), 'sha256': sha(path)}
bun = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
assert sha(bun) == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
name = sys.argv[1]
if name == 'plan':
    assert not (here / 'plan.json').exists()
    changes = [path for path, value in old['sourceContractHashes'].items() if sha(root / path) != value]
    assert changes == ['sdk/src/serve/event-bridge.ts']
    old_commands = {}
    drift = []
    inputs = set(old['sourceContractHashes'])
    for reference in old['commandReceipts']:
        path = root / reference['path']
        assert sha(path) == reference['sha256']
        receipt = json.loads(path.read_text())
        old_commands[path.name] = receipt
        inputs.update(receipt['sourceBefore'])
        mismatch = [source for source, value in receipt['sourceBefore'].items() if sha(root / source) != value]
        assert mismatch == changes
        drift.append({'receipt': reference, 'driftedInputs': mismatch})
    inputs.update(json.loads((here.parent / 'deslop-event-bridge-review/audit.json').read_text())['sourceAfter'])
    inputs.update(['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json', 'sdk/package.json', 'sdk/tsconfig.json', 'cli/package.json', 'cli/tsconfig.json', 'packages/agent-runtime/package.json', 'packages/agent-runtime/tsconfig.json', 'node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/tsc.js', str(Path(__file__).resolve().relative_to(root)), str((here / 'counterexamples.ts').relative_to(root)), str((here / 'network-guard-test.ts').relative_to(root))])
    matrix = {}
    for operation in ['multifile-producer-tests', 'ci-sorted-producer-tests', 'actual-consumers', 'approval-cancellation', 'counterexamples', 'sdk-typecheck', 'runtime-typecheck', 'cli-typecheck']:
        prior = old_commands[operation + '-01.json']
        argv = prior['argv'][:]
        if operation in ['multifile-producer-tests', 'ci-sorted-producer-tests']:
            argv[4:4] = ['--preload', str(here / 'network-guard-test.ts')]
        elif operation in ['actual-consumers', 'approval-cancellation']:
            argv[-1] = str(here / operation)
        elif operation == 'counterexamples':
            argv[-1] = str(here / 'counterexamples.ts')
        matrix[operation] = {'argv': argv, 'cwd': prior['cwd']}
    consumers = [old_commands[f'consumer-tests-{index:02d}.json']['argv'][-1] for index in range(1, 11)]
    matrix['consumer-tests'] = {'argv': [str(bun), '--no-env-file', 'test', '--isolate', '--preload', str(here / 'network-guard-test.ts'), *consumers], 'cwd': str(root)}
    plan = {'schemaVersion': 1, 'author': '/root/b03_mutation_evidence', 'scope': old['scope'], 'sourceContractHashes': {path: sha(root / path) for path in old['sourceContractHashes']}, 'sourceBefore': {path: sha(root / path) for path in sorted(inputs)}, 'originalAuthority': ref(original), 'driftedOriginalCommands': drift, 'commands': matrix, 'policy': 'Replace all drifted required receipts without rewriting prior source maps. Equivalent focused suites may batch; retain both previously tested producer orders. No complete package/runtime discovery claim.'}
    (here / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps({'sourceDrift': changes, 'driftedCommandCount': len(drift), 'newCommandGroups': list(matrix), 'boundInputs': len(inputs)}, indent=2))
    sys.exit(0)
plan = json.loads((here / 'plan.json').read_text())
assert not (here / (name + '.original.json')).exists()
command = plan['commands'][name]
before = {path: sha(root / path) for path in plan['sourceBefore']}
assert before == plan['sourceBefore']
with tempfile.TemporaryDirectory(prefix='b02-deslop-refresh-') as temporary:
    temporary = Path(temporary)
    home = temporary / 'home'; home.mkdir()
    xdg = temporary / 'xdg'; xdg.mkdir()
    provider = temporary / 'providers.json'
    provider.write_text('{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n')
    env = {'PATH': str(bun.parent) + ':/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'XDG_CONFIG_HOME': str(xdg), 'TMPDIR': str(temporary), 'LANG': 'C.UTF-8', 'OPENBUFF_PROVIDER_CONFIG': str(provider), 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test', 'OPENBUFF_TELEMETRY': '0', 'DO_NOT_TRACK': '1', 'MUTATION_FIXTURE_NETWORK_TRACE': str(here / (name + '-network'))}
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    timer = time.monotonic()
    result = subprocess.run(command['argv'], cwd=command['cwd'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    after = {path: sha(root / path) for path in plan['sourceBefore']}
    log = here / (name + '.log'); log.write_bytes(result.stdout)
    counts = {key: re.findall(pattern, result.stdout.decode(errors='replace')) for key, pattern in {'passed': r'\n\s+(\d+) pass', 'failed': r'\n\s+(\d+) fail', 'assertions': r'(\d+) expect\(\) calls', 'files': r'Ran \d+ tests across (\d+) files'}.items()}
    traces = [dict(ref(path), observed=json.loads(path.read_text())) for path in sorted(here.glob(name + '-network.*.json'))]
    observation_paths = []
    if name in ['actual-consumers', 'approval-cancellation']:
        observation_paths = [path for path in (here / name).rglob('*') if path.is_file()]
    elif name == 'counterexamples':
        observation_paths = [path for path in [here / 'counterexample-observations.json'] if path.exists()]
    receipt = {'schemaVersion': 1, 'nodeId': 'B02', 'author': '/root/b03_mutation_evidence', 'name': name, 'purpose': 'Original current execution for independent B02 source/Bun acceptance refresh.', 'argv': command['argv'], 'cwd': command['cwd'], 'startedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'elapsedSeconds': time.monotonic() - timer, 'exitCode': result.returncode, 'log': ref(log), 'sourceBefore': before, 'sourceAfter': after, 'sourceStable': before == after, 'testCounts': counts, 'toolchain': {'path': str(bun), 'sha256': sha(bun), 'version': '1.3.5'}, 'environment': {'replacement': True, 'keys': sorted(env), 'HOME': 'owned ephemeral empty directory', 'XDG_CONFIG_HOME': 'owned ephemeral empty directory', 'providerConfig': 'owned empty providers', 'bunEnvFileLoading': False}, 'networkTraces': traces, 'artifacts': [ref(path) for path in observation_paths]}
    (here / (name + '.original.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'name': name, 'exitCode': result.returncode, 'counts': counts, 'sourceStable': before == after, 'networkTraces': traces, 'observations': len(observation_paths)}, indent=2))
    if result.returncode:
        print(result.stdout.decode(errors='replace')[-9000:])
    assert before == after
    if result.returncode == 0 and 'tests' in name:
        assert traces and all(trace['observed'] == {'fetchCalls': 0} for trace in traces)
    sys.exit(result.returncode)
