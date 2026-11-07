"""Observe exact frozen validator calls without changing any digest or source."""
import datetime
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path

if not __debug__:
    raise RuntimeError('Optimized scope recording is unsupported')
OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[6]
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
LEDGER = ROOT / 'docs/execution/body-roadmap/ledger.json'
INVENTORY = ROOT / 'docs/execution/body-roadmap/evidence/publication-20261107/curated-required-files.json'
TARGETS = ['scripts/memory-drift-guard.ts', 'scripts/__tests__/memory-drift-guard.test.ts',
           '.github/workflows/rust-workspace.yml']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def binding(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'bytes': path.stat().st_size}


assert sha(VALIDATOR) == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
assert sha(LEDGER) == '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
assert sha(INVENTORY) == 'f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731'
ledger = json.loads(LEDGER.read_text())
inventory = json.loads(INVENTORY.read_text())
before = {path: sha(ROOT / path) for path in TARGETS}
spec = importlib.util.spec_from_file_location('frozen_ledger_scope', VALIDATOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.sha256
calls = []
call_count = 0


def observe(path):
    global call_count
    digest = original(path)
    caller = inspect.currentframe().f_back
    if caller.f_code.co_name == 'file_binding':
        call_count += 1
        relative = str(path.relative_to(ROOT))
        if relative in TARGETS:
            row = {'path': relative, 'actualSha256': digest,
                   'expectedSha256': caller.f_locals['expected'], 'label': caller.f_locals['label']}
            frame = caller
            while frame:
                if frame.f_code.co_name == 'command_provenance':
                    command = frame.f_locals['command']
                    row['commandProvenance'] = command.get('provenance')
                    row['commandArgv'] = command.get('argv')
                if frame.f_code.co_name == 'validate' and 'check' in frame.f_locals:
                    row['activeCheck'] = frame.f_locals['check']
                frame = frame.f_back
            calls.append(row)
    return digest


module.sha256 = observe
validation = module.validate(ledger, ROOT)
after = {path: sha(ROOT / path) for path in TARGETS}
assert before == after
assert validation['valid'], validation['errors']
assert sha(LEDGER) == '64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b'
accepted = [node for node in ledger['nodes'] if node['status'] == 'accepted']
result = {'schemaVersion': 1, 'type': 'independent-remote-ci-repair-binding-scope',
          'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'reviewer': '/root/b04_lock_cas',
          'method': 'Run frozen validate() with a digest observer that delegates every original calculation unchanged; record actual file_binding calls for all three proposed source files.',
          'ledger': binding(LEDGER), 'validator': binding(VALIDATOR), 'frozenInventory': binding(INVENTORY),
          'sourceBefore': before, 'sourceAfter': after, 'sourceStable': True,
          'actualFileBindingCallCount': call_count, 'targetBindingCalls': calls,
          'directAcceptedSourceContracts': {path: [node['nodeId'] for node in accepted if path in node['sourceContractHashes']] for path in TARGETS},
          'frozenInventoryRows': {path: [row for row in inventory['files'] if row['path'] == path] for path in TARGETS},
          'acceptedPrerequisiteRows': {node['nodeId']: node['acceptedPrerequisites'] for node in accepted},
          'validation': validation, 'sourceLedgerStagingOrHistoricalArtifactsEdited': False}
with (OUT / 'active-bindings.json').open('x') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps({'report': binding(OUT / 'active-bindings.json'), 'totalCalls': call_count,
                  'targetCallCount': len(calls), 'callsByPath': {path: len([row for row in calls if row['path'] == path]) for path in TARGETS},
                  'directContracts': result['directAcceptedSourceContracts'],
                  'inventoryMembership': {path: bool(rows) for path, rows in result['frozenInventoryRows'].items()},
                  'valid': validation['valid']}))
