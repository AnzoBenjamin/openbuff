#!/usr/bin/env python3
"""Check the new research plan without changing the frozen completion graph."""

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
BASE = ROOT / 'docs/execution/body-roadmap'
OUT = Path(__file__).resolve().parent
observations = {}


def read(path, expected=None):
    target = ROOT / path
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert expected is None or digest == expected, ('hash mismatch', path)
    observations[path] = digest
    return target.read_text()


registry = json.loads(read('docs/execution/body-roadmap/execution-plan.json'))
for field in ('basePlan', 'specification'):
    ref = registry[field]
    read(ref['path'], ref['sha256'])

candidate = json.loads(read(
    'docs/execution/body-roadmap/evidence/integration/'
    'first-wave-final-20261107/acceptance/candidate-ledger.json',
    '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758',
))
nodes = {node['nodeId']: node for node in candidate['nodes']}
assert len(nodes) == registry['baseCompletionNodeCount'] == 39
assert nodes['B33']['status'] == 'pending'
assert nodes['B33']['prerequisites'] == ['B03', 'B05', 'B19', 'B20', 'B28']

assert len(registry['addenda']) == 1
entry = registry['addenda'][0]
assert entry['id'] == 'RWEB' and entry['status'] == 'planned'
assert entry['requiredByCard'] == 'B33'
assert entry['affectedCards'] == ['B19', 'B20', 'B28', 'B33']
document = read(entry['document']['path'], entry['document']['sha256'])
inspection = json.loads(read(
    entry['sourceInspection']['path'], entry['sourceInspection']['sha256'],
))
assert inspection['implementationAccepted'] is False
assert inspection['installedAgentBrowser'] is False
assert inspection['prototypeStatus'] == 'not executed'
for path, digest in inspection['localSourceHashes'].items():
    read(path, digest)

expected = {
    'RWEB-0': [],
    'RWEB-1': ['RWEB-0', 'B19', 'B20', 'B28'],
    'RWEB-2': ['RWEB-1'],
    'RWEB-3': ['RWEB-2', 'B03', 'B05'],
    'RWEB-4': ['RWEB-3', 'B03', 'B05', 'B19', 'B20', 'B28'],
}
tasks = {task['id']: task for task in entry['tasks']}
assert len(tasks) == len(entry['tasks']) == len(expected)
assert set(tasks) == set(expected)
done = set(nodes)
for task_id, prerequisites in expected.items():
    task = tasks[task_id]
    assert task['status'] == 'planned'
    assert task['prerequisites'] == prerequisites
    assert set(prerequisites) <= done, ('unknown or cyclic prerequisite', task_id)
    assert task_id in document
    done.add(task_id)
assert set(nodes['B33']['prerequisites']) <= set(tasks['RWEB-4']['prerequisites'])
assert entry['readyPreparationTasks'] == ['RWEB-0']
assert 'every RWEB task' in entry['acceptanceRule']

checked_links = []
for path, content in [
    (entry['document']['path'], document),
    ('docs/execution/body-roadmap/README.md',
     read('docs/execution/body-roadmap/README.md')),
]:
    for link in re.findall(r'\[[^\]]+\]\(([^)]+)\)', content):
        if re.match(r'https?://', link):
            continue
        target = (ROOT / path).parent / link.split('#')[0]
        assert target.is_file(), ('broken local link', path, link)
        checked_links.append({'from': path, 'target': link})

result = {
    'schemaVersion': 1,
    'type': 'researcher-browser-planning-check',
    'valid': True,
    'implementationAccepted': False,
    'completionNodeCount': len(nodes),
    'requiredByCard': 'B33',
    'tasks': expected,
    'readyPreparationTasks': entry['readyPreparationTasks'],
    'sourceHashes': observations,
    'localLinks': checked_links,
    'scope': 'Planning consistency only; installation and browser workflows unexecuted.',
}
output = OUT / 'result.json'
with output.open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
print(json.dumps({'valid': True, 'tasks': len(tasks), 'localLinks': len(checked_links)}))
