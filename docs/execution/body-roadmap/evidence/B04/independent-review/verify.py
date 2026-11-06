from pathlib import Path
import json, hashlib, subprocess, os, datetime, re

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[5]
PRODUCER = OUT.parent
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(n, value): (OUT / n).write_text(json.dumps(value, indent=2) + '\n')
p = json.loads((PRODUCER / 'manifest.json').read_text())
assert sha(BUN) == 'a56093cbdd2efc7290a744ccc39971dcc4be52c5732be15c7fb1465cc119c8de'
sources = p['sourceHashes']
assert all(sha(ROOT / f) == h for f, h in sources.items())
assert all(sha(PRODUCER / f) == h for f, h in p['artifacts'].items())
assert p['testCounts'] == {'passed': 147, 'failed': 0}
for entry in p['commands']:
    file = PRODUCER / entry['receipt']
    assert sha(file) == entry['sha256']
    receipt = json.loads(file.read_text())
    assert receipt['exit'] == 0 and receipt['sourceUnchangedDuringCommand']
    assert sha(PRODUCER / receipt['log']) == receipt['logSha256']
    assert (PRODUCER / (receipt['command'] + '.exit')).read_text().strip() == '0'
    assert all(sha(ROOT / f) == h for f, h in receipt['sourceAfter'].items())
    assert all(sha(ROOT / f) == h for f, h in receipt['configHashes'].items())
shared = PRODUCER / p['sharedSdkTypecheck']['receipt']
assert sha(shared) == p['sharedSdkTypecheck']['sha256']
assert json.loads(shared.read_text())['exit'] == 0
write('producer-integrity.json', {'allMatch': True, 'manifestHash': sha(PRODUCER / 'manifest.json'), 'sources': sources, 'producerArtifacts': p['artifacts'], 'commands': p['commands'], 'sharedSdkTypecheck': p['sharedSdkTypecheck']})
commands = []
config = OUT / 'fixture-config.json'; config.write_text('{}\n')
env = {k: os.environ[k] for k in ['HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] if k in os.environ}
env.update({'PATH': str(BUN.parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'), 'OPENBUFF_PROVIDER_CONFIG': str(config), 'NEXT_PUBLIC_CB_ENVIRONMENT': 'test'})
def run(name, argv):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(argv, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
    commands.append({'name': name, 'argv': argv, 'cwd': str(ROOT), 'startedUtc': started, 'exit': result.returncode, 'log': name + '.log'})
    write('commands.json', commands)
    print(name, result.returncode, flush=True)
    assert result.returncode == 0
run('tests', [str(BUN), '--no-env-file', 'test', '--isolate', 'sdk/src/__tests__/workspace-mutation-broker.test.ts', 'packages/indexer/src/index-store.test.ts', 'packages/indexer/src/index-manager.test.ts', 'cli/src/utils/__tests__/turn-snapshots.test.ts', 'packages/indexer/src/index-manager-semantic.test.ts'])
text = (OUT / 'tests.log').read_text()
count = re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail', text)
assert count and (int(count[1]), int(count[2])) == (147, 0)
rows = []
for line in text.splitlines():
    try: value = json.loads(line)
    except ValueError: continue
    if isinstance(value, dict) and 'b04' in value: rows.append(value)
assert len(rows) == 9
write('runtime-observations.json', rows)
assert all(sha(ROOT / f) == h for f, h in sources.items())
write('source-stability.json', {'allMatch': True, 'sources': sources, 'producerManifestHash': sha(PRODUCER / 'manifest.json')})
print('Independent B04 tests147 and source/artifact integrity passed', flush=True)
