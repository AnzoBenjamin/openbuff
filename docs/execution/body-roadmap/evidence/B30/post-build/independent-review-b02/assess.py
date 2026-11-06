from pathlib import Path
import json, hashlib, math

OUT = Path(__file__).resolve().parent
def read(file): return json.loads(file.read_text())
def finite(value):
    if isinstance(value, float): assert math.isfinite(value)
    elif isinstance(value, dict):
        for v in value.values(): finite(v)
    elif isinstance(value, list):
        for v in value: finite(v)

art = read(OUT / 'artifact-fixture/fixture-report.json')
iso = read(OUT / 'isolation-fixture/isolation-report.json')
assert len(art['population']) == 2
assert len({p['artifactRoot'] for p in art['population']}) == 2
assert len({p['runId'] for p in art['population']}) == 2
populations = []
for p in art['population']:
    root = Path(p['artifactRoot'])
    actual = read(root / 'FINAL_RESULTS.json')
    runs = [r for agent in actual['agents'].values() for r in agent['runs']]
    assert len(runs) == len(p['attempts']) == 8
    assert sum(r['cost'] for r in runs) == p['spend']['agentCostUsd'] == 12
    assert sum(r['runOutcome']['termination'] == 'completed' for r in runs) == 2
    assert {lang for r in runs for lang in r['languages']} == {'typescript', 'python'}
    assert {r['providerRoute'] for r in runs} == {'offline/provider-a', 'offline/provider-b'}
    assert all(r['judging']['overallScore'] == 10 for r in runs)
    assert actual['agents']['agent-a']['measuredRunCount'] == 2
    assert actual['agents']['agent-b']['measuredRunCount'] == 0
    model = p['modelAttempts']
    assert len(model) == 16
    assert len(list((root / 'sdk-attempts').glob('*-started.json'))) == 16
    assert len(list((root / 'sdk-attempts').glob('*-settled.json'))) == 16
    assert sum(a['costUsd'] or 0 for a in model) == p['spend']['availableAuxiliaryCostUsd'] == 2
    assert sum(a['costUsd'] is None for a in model) == p['spend']['unknownAuxiliaryCostAttempts'] == 8
    assert p['spend']['wholeExperimentCostComplete'] is False
    assert all(r['executionScope'] == 'trusted_task' for r in runs)
    populations.append({'runId': p['runId'], 'agentAttempts': len(runs), 'completed': 2, 'agentCostUsd': 12, 'auxiliaryAttempts': 16, 'knownAuxiliaryCostUsd': 2, 'unknownAuxiliaryCosts': 8, 'wholeExperimentCostComplete': False, 'fileCount': len([f for f in root.rglob('*') if f.is_file()]), 'languages': sorted({l for r in runs for l in r['languages']}), 'routes': sorted({r['providerRoute'] for r in runs})})

replayed = {}
for side in ['before', 'after']:
    records = [r for p in sorted((OUT / 'artifact-fixture' / side).glob('*-ANALYSIS.json')) for r in read(p)['results']]
    completed = [r for r in records if r['runOutcome']['termination'] == 'completed']
    assert len(records) == 6 and len(completed) == 4
    assert sum(r['cost'] for r in records) == 14
    replayed[side] = {id: sum(r['overallScore'] for r in completed if r['agentId'] == id) / 2 for id in ['repeat-agent', 'zero-agent']}
assert replayed == {'before': {'repeat-agent': 8.0, 'zero-agent': 0.0}, 'after': {'repeat-agent': 4.75, 'zero-agent': 0.25}}
finite(art['comparison'])
assert {r['name']: r['exit'] for r in art['refusals']} == {'invalid-nonfinite': 1, 'insufficient': 1, 'incomparable-population': 1}
assert art['cli']['exit'] == 0 and '8.00 → 4.75 (-3.25)' in art['cli']['stdout']
assert all((OUT / 'artifact-fixture' / (r['name'] + '.exit')).read_text().strip() == '1' for r in art['refusals'])

assert len(iso['observations']) == 7
assert sorted(o['agentId'] for o in iso['observations']) == sorted(['isolation-fixture', 'isolation-fixture', 'judge-gpt', 'judge-gemini', 'buffbench-lessons-extractor', 'trace-analyzer', 'buffbench-meta-analyzer'])
for o in iso['observations']:
    assert o['controllerSentinelPresent'] is False
    assert o['ambientProviderConfigPresent'] is False
    assert o['defaultUserConfigPresent'] is False
    assert not Path(o['home']).exists() and not Path(o['cwd']).exists()
    assert o['fetch']['attempted'] == o['fetch']['forwarded'] == 0
    assert o['eventsReplayed'] > 0
valid = iso['unavailable']
assert valid['output'] == {'type': 'error', 'message': valid['expectedMissingCredential']}
assert valid['runOutcome']['termination'] == 'failed'
o = valid['observations'][1]
assert o['agentId'] == valid['agentId'] == 'valid-no-key-fixture'
assert o['providerConfigSourcePaths'] == [valid['providerConfig']]
assert o['selectedProviderCredentials'] == [{'providerId': 'b30-no-key', 'credentialEnv': 'B30_MISSING_API_KEY', 'present': False}]
assert o['fetch']['attempted'] == o['fetch']['forwarded'] == 0
assert o['controllerSentinelPresent'] is False and not Path(o['home']).exists()
guard = iso['fetchGuardControl']['observation']['fetch']
assert guard['attempted'] == guard['refused'] == 1 and guard['forwarded'] == 0
assert iso['fetchGuardControl']['output']['value']['initiated'] is True
assert iso['missingAgent']['output']['message'].startswith('Invalid agent ID: "base2"')
assert iso['rejectedCallback'] is True
assert iso['trusted'][0]['value']['stdout'] == 'sentinel=controller-only\n'
report = {'verdict': 'approve B30 current bound source within declared environment-isolation scope', 'populations': populations, 'recomputedComparisonMeans': replayed, 'comparisonPopulationPerSide': {'attempts': 6, 'eligibleScores': 4, 'costUsd': 14}, 'actualSDKTaskAndAuxiliaryWorkers': 7, 'validMissingCredential': {'agent': valid['agentId'], 'termination': valid['runOutcome']['termination'], 'fetchAttempts': 0, 'forwarded': 0}, 'fetchGuardControl': guard, 'scope': 'Source SDK process environment/home replacement; SDK global fetch refusal control only; no OS/filesystem/network confinement or real billing/improvement claim.'}
(OUT / 'assessment.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
