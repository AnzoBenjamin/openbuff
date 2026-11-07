"""Independent read-only review of the researcher-browser plan registry."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[6]
OUT = Path(__file__).resolve().parent
PATHS = ['docs/execution/body-roadmap/README.md',
         'docs/execution/body-roadmap/execution-plan.json',
         'docs/execution/body-roadmap/researcher-web-agent-browser.md',
         'docs/execution/body-roadmap/researcher-web-agent-browser.sources.json']

def sha(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()

def read(path):
    return json.loads((ROOT / path).read_text())

before = {path: sha(path) for path in PATHS}
registry = read(PATHS[1])
source = read(PATHS[3])
plan = (ROOT / PATHS[2]).read_text()
entry, = registry['addenda']
assert entry['id'] == 'RWEB' and entry['status'] == 'planned' and entry['requiredByCard'] == 'B33'
for ref in [registry['basePlan'], registry['specification'], entry['document'], entry['sourceInspection']]:
    assert sha(ref['path']) == ref['sha256']
candidate_path = 'docs/execution/body-roadmap/evidence/integration/first-wave-final-20261107/acceptance/candidate-ledger.json'
assert sha(candidate_path) == '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
candidate = read(candidate_path)
nodes = {node['nodeId']: node for node in candidate['nodes']}
assert len(nodes) == len(candidate['nodes']) == registry['baseCompletionNodeCount'] == 39
assert nodes['B33']['status'] == 'pending'
tasks = {task['id']: task for task in entry['tasks']}
assert set(tasks) == {f'RWEB-{number}' for number in range(5)} and len(entry['tasks']) == 5
assert all(task['status'] == 'planned' for task in tasks.values())
assert tasks['RWEB-0']['prerequisites'] == []
assert set(tasks['RWEB-1']['prerequisites']) == {'RWEB-0', 'B19', 'B20', 'B28'}
assert set(tasks['RWEB-3']['prerequisites']) >= {'B03', 'B05'}
assert set(tasks['RWEB-4']['prerequisites']) >= set(nodes['B33']['prerequisites'])
assert entry['readyPreparationTasks'] == ['RWEB-0']
visiting, complete = set(), set(nodes)
def visit(task_id):
    if task_id in complete:
        return
    assert task_id in tasks and task_id not in visiting
    visiting.add(task_id)
    for prerequisite in tasks[task_id]['prerequisites']:
        visit(prerequisite)
    visiting.remove(task_id)
    complete.add(task_id)
for task_id in tasks:
    visit(task_id)
assert all(task_id not in nodes for task_id in tasks)
assert source['implementationAccepted'] is False and source['prototypeStatus'] == 'not executed'
assert source['installedAgentBrowser'] is False
for path, expected in source['localSourceHashes'].items():
    assert sha(path) == expected
researcher = (ROOT / 'agents/researcher/researcher-web.ts').read_text()
helper = (ROOT / 'packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts').read_text()
assert "toolNames: ['web_search', 'set_output']" in researcher
assert 'https://html.duckduckgo.com/html/?q=' in helper
assert 'DuckDuckGo' in plan and 'search path uses Open Websearch' not in plan
links = []
for name in [PATHS[0], PATHS[2]]:
    for link in re.findall(r'\[[^\]]+\]\(([^)]+)\)', (ROOT / name).read_text()):
        if re.match(r'https?://', link):
            continue
        assert ((ROOT / name).parent / link.split('#')[0]).is_file()
        links.append({'from': name, 'target': link})
mechanical = read('docs/execution/body-roadmap/evidence/RWEB/planning-checks/result.json')
assert mechanical['valid'] and not mechanical['implementationAccepted']
for path, expected in mechanical['sourceHashes'].items():
    assert sha(path) == expected
after = {path: sha(path) for path in PATHS}
assert before == after
result = {'schemaVersion': 1, 'type': 'independent-researcher-browser-planning-inspection',
          'reviewer': '/root/first_wave_architect', 'inspectedAt': datetime.now(timezone.utc).isoformat(),
          'sourceBefore': before, 'sourceAfter': after, 'sourceStable': True,
          'basePlanAndSpecificationBound': True, 'baseCompletionNodes': len(nodes),
          'candidateSha256': sha(candidate_path), 'B33Status': nodes['B33']['status'],
          'taskPrerequisites': {key: task['prerequisites'] for key, task in tasks.items()},
          'acyclicKnownDependencies': True, 'readyPreparationTasks': entry['readyPreparationTasks'],
          'requiredByCard': entry['requiredByCard'], 'localSourceBindings': source['localSourceHashes'],
          'localLinksVerified': links, 'agentBrowserOnReviewerPath': shutil.which('agent-browser'),
          'upstreamIndependentFetch': False, 'prototypeExecutedByReviewer': False,
          'resolvedFinding': 'Stale Open Websearch description corrected to actual bounded DuckDuckGo HTML implementation',
          'scope': 'Plan architecture and source/registry consistency only; distribution, browser acquisition, prototype and workflow acceptance remain RWEB-0..4 work'}
with (OUT / 'inspection.json').open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
print(json.dumps({'valid': True, 'nodes': len(nodes), 'tasks': len(tasks), 'links': len(links), 'sourceStable': True}))
