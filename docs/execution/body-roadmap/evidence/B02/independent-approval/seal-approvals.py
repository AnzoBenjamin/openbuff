#!/usr/bin/env python3
"""Fresh independent receipt/oracle inspection; no product execution or old writes."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[6]
EVIDENCE = ROOT / 'docs/execution/body-roadmap/evidence'
SCRIPT = Path(__file__).resolve()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(path, expected=None):
    actual = sha(path)
    assert expected is None or actual == expected, f'changed evidence: {path}'
    return {'path': str(path.relative_to(ROOT)), 'sha256': actual}


def load(path):
    return json.loads(path.read_text())


def write(directory, name, data):
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(data, indent=2) + '\n')
    return ref(path)


def verify_inputs(command):
    assert command['sourceBefore'] == command['sourceAfter']
    for name, digest in command['sourceBefore'].items():
        ref(ROOT / name, digest)


def test_counts(path):
    match = re.search(r'\n\s+(\d+) pass\n\s+(\d+) fail', path.read_text())
    assert match, path
    return {'passed': int(match[1]), 'failed': int(match[2])}


def check_old_manifest(directory, expected):
    manifest_ref = ref(directory / 'manifest.json', expected)
    manifest = load(directory / 'manifest.json')
    for name, digest in manifest['sourceHashes'].items():
        ref(ROOT / name, digest)
    raw = [ref(directory / name, digest) for name, digest in manifest['artifacts'].items()]
    return manifest, manifest_ref, raw


def check_normalized(command_ref):
    path = ROOT / command_ref['path']
    ref(path, command_ref['sha256'])
    command = load(path)
    origin_ref = command['provenance']
    origin_path = ROOT / origin_ref['path']
    ref(origin_path, origin_ref['sha256'])
    origin = load(origin_path)
    selected = origin['invocations'][command['provenanceInvocationIndex']] if 'provenanceInvocationIndex' in command else origin
    assert command['argv'] == selected['argv']
    assert command['exitCode'] == selected['exit'] == 0
    assert command['sourceBefore'] == origin['sourceBefore']
    assert command['sourceAfter'] == origin['sourceAfter']
    verify_inputs(command)
    assert command['log']['path'] == str((origin_path.parent / selected['log']).relative_to(ROOT))
    assert command['log']['sha256'] == selected['logSha256']
    ref(ROOT / command['log']['path'], selected['logSha256'])
    return command


tail_old = EVIDENCE / 'B01/tail-store/independent-review'
tail_out = EVIDENCE / 'B01/tail-store/independent-approval'
tail_manifest, tail_manifest_ref, tail_raw = check_old_manifest(
    tail_old, '5cc7923f65436045011abc83d0c013599a798dfe2d24ee50ee15e09f6858004e')
tail_sources = tail_manifest['sourceHashes']
tail_commands = []
tail_artifacts = []
tail_context = set()
for name in ['tests', 'fixture', 'counterexamples', 'sdk-typecheck']:
    original_path = tail_old / f'{name}.json'
    original = load(original_path)
    assert original['exit'] == 0 and original['sourceUnchangedDuringCommand'] is True
    verify_inputs(original)
    origin_ref = ref(original_path, tail_manifest['artifacts'][f'{name}.json'])
    log = ref(tail_old / original['log'], original['logSha256'])
    normalized = {
        'schemaVersion': 1, 'type': 'body-acceptance-command', 'nodeId': 'B01',
        'name': 'tail/store ' + name, 'argv': original['argv'], 'exitCode': original['exit'],
        'log': log, 'sourceBefore': original['sourceBefore'], 'sourceAfter': original['sourceAfter'],
        'provenance': origin_ref, 'cwd': original['cwd'], 'startedAt': original['startedAt'],
        'finishedAt': original['finishedAt'], 'artifacts': [origin_ref, log],
    }
    command_ref = write(tail_out, f'commands/{name}.json', normalized)
    check_normalized(command_ref)
    tail_commands.append(command_ref)
    tail_artifacts.extend([origin_ref, log, command_ref])
    tail_context.update(original['sourceBefore'])
assert test_counts(tail_old / 'tests.log') == {'passed': 59, 'failed': 0}
tail_oracle = load(tail_old / 'fixture-report.json')
assert tail_oracle['allAssertionsPassed'] and len(tail_oracle['cases']) == 5
assert tail_oracle['codingFetch'] == {'attempted': 0, 'forwarded': 0}
cases = tail_oracle['cases']
assert cases['equalLengthUntrackedTail']['beforeSize'] == cases['equalLengthUntrackedTail']['afterSize']
assert cases['equalLengthUntrackedTail']['beforeSnapshot'] != cases['equalLengthUntrackedTail']['afterSnapshot']
assert cases['equalLengthUntrackedTail']['validation']['status'] == 'failed'
assert cases['equalLengthGitTail']['retainedPrefixEqual'] and cases['equalLengthGitTail']['complete']
assert cases['equalLengthGitTail']['beforeFullSha256'] != cases['equalLengthGitTail']['afterFullSha256']
assert cases['membershipOverflow']['hooksRan'] is False
assert cases['membershipOverflow']['validation']['status'] == 'failed'
assert cases['durableQuarantine']['lostSidecarStillUnavailable'] is True
tail_probe = load(tail_old / 'quarantine-observations.json')
assert tail_probe['fetchCalls'] == 0 and len(tail_probe['observations']) == 2
for row in tail_probe['observations']:
    assert len(row['after']['diagnostics']) == 1 and 'error' in row['directRead']
    assert 'errorMessage' in row['bundle']['value'] and row['rawBytes'] == '{broken'
for name in ['fixture-report.json', 'quarantine-observations.json', 'producer-fixture.ts',
             'quarantine-counterexamples.ts', 'run-verification.py', 'verify-artifacts.py']:
    tail_artifacts.append(ref(tail_old / name, tail_manifest['artifacts'][name]))

b02_old = EVIDENCE / 'B02/final-binding'
b02_out = EVIDENCE / 'B02/independent-approval'
b02_manifest, b02_manifest_ref, b02_raw = check_old_manifest(
    b02_old, '95901b10a4d4350f6392bf2f315f9f5b0dcd8925cfb427b9cf94f2ae57afcafa')
b02_previous_proof = load(EVIDENCE / 'B02/acceptance-proof/review.json')
b02_commands = b02_previous_proof['commandReceipts']
b02_sources = load(b02_old / 'producer-tests.json')['sourceBefore']
b02_artifacts = []
b02_context = set()
for command_ref in b02_commands:
    command = check_normalized(command_ref)
    b02_context.update(command['sourceBefore'])
    b02_artifacts.extend([command_ref, command['provenance'], command['log']])
counts = {}
for name in ['producer-tests', 'consumer-tests', 'multifile-producer-tests', 'ci-sorted-producer-tests']:
    command = load(b02_old / f'{name}.json')
    counts[name] = {'passed': 0, 'failed': 0}
    for invocation in command['invocations']:
        observed = test_counts(b02_old / invocation['log'])
        assert observed == invocation['testCounts']
        for key in observed:
            counts[name][key] += observed[key]
assert counts['producer-tests'] == counts['multifile-producer-tests'] == counts['ci-sorted-producer-tests'] == {'passed': 436, 'failed': 0}
assert counts['consumer-tests'] == {'passed': 239, 'failed': 0}
actual = load(b02_old / 'actual-consumers/observations.json')
assert actual['providerCalls'] == 0 and len(actual['observations']) == 9
terminations = {'happy_generator': 'completed', 'fatal_generator': 'failed', 'awaited_rejection': 'failed',
                'pre_cancel': 'cancelled', 'mid_cancel': 'cancelled', 'zero_cost': 'budget_exhausted',
                'zero_steps': 'step_exhausted', 'recovered_accepted': 'completed', 'completed_rejected': 'completed'}
sqlite_checks = []
for row in actual['observations']:
    journal = Path(row['journalPath'])
    assert row['runOutcome']['termination'] == terminations[row['name']]
    assert row['exitCode'] == (0 if row['name'] in ['happy_generator', 'recovered_accepted'] else 1)
    wal = Path(str(journal) + '-wal')
    assert not wal.exists() or wal.stat().st_size == 0, 'immutable read requires checkpointed WAL'
    with sqlite3.connect(journal.as_uri() + '?mode=ro&immutable=1', uri=True) as connection:
        terminal = [value for (payload,) in connection.execute("select payload from run_events where event_type='step_boundary' order by seq")
                    if (value := json.loads(payload)).get('terminal') is True]
    assert len(terminal) == (0 if row['name'] == 'pre_cancel' else 1)
    if terminal:
        assert terminal[0]['runOutcome'] == row['runOutcome']
        assert terminal[0]['taskAcceptance'] == row['taskAcceptance']
    for field in ['runOutcome', 'actionOutcomes', 'taskAcceptance']:
        assert row['cliMessage'][field] == row[field]
    ref(journal.parent / 'stdout.ndjson', row['stdoutSha256'])
    sqlite_checks.append({'name': row['name'], 'journal': ref(journal), 'terminalEvents': len(terminal),
                          'runOutcome': row['runOutcome'], 'cliAndSdkEqual': True, 'exitCode': row['exitCode']})
approval = load(b02_old / 'approval-cancellation/observations.json')
assert approval['providerCalls'] == 0 and len(approval['observations']) == 7
cancelled = next(row for row in approval['observations'] if row['name'] == 'approval_cancelled')
assert cancelled['runOutcome']['termination'] == 'cancelled'
assert cancelled['trace'] == '' and cancelled['approvalRecords'] == []
assert cancelled['actionOutcomes'] and all(row['outcome'] == 'cancelled' for row in cancelled['actionOutcomes'])
counter = load(b02_old / 'counterexample-observations.json')
assert len(counter['observations']) == 9
for row in counter['observations']:
    if 'exitCode' in row:
        assert row['exitCode'] == (0 if row['name'] == 'accepted-headless' else 1)
    elif row['name'] in ['max_tokens', 'max_turn_requests']:
        assert row['result']['runOutcome']['termination'] == ('budget_exhausted' if row['name'] == 'max_tokens' else 'step_exhausted')
    elif row['name'] == 'rejected-task':
        assert row['result']['taskAcceptance']['status'] == 'rejected'
    else:
        assert row['result']['runOutcome']['termination'] == 'completed'
        assert row['result']['taskAcceptance']['status'] == 'accepted'
        event = next(event for event in row['events'] if event['type'] == 'tool_result')
        if row['name'] == 'conflicting-action':
            assert event['actionOutcome']['outcome'] == 'failed'
for name in ['counterexamples.ts', 'run-verification.py', 'verify-artifacts.py', 'verify-sqlite.py',
             'fixture-config.json', 'counterexample-observations.json', 'actual-consumers/observations.json',
             'approval-cancellation/observations.json']:
    b02_artifacts.append(ref(b02_old / name, b02_manifest['artifacts'][name]))
for invocation in [Path(actual['invocationDir']), Path(approval['invocationDir'])]:
    for path in sorted(invocation.rglob('*')):
        if path.is_file():
            b02_artifacts.append(ref(path, b02_manifest['artifacts'][str(path.relative_to(b02_old))]))

# Reread every original seal after immutable SQLite inspection to prove old evidence was not changed.
check_old_manifest(tail_old, tail_manifest_ref['sha256'])
check_old_manifest(b02_old, b02_manifest_ref['sha256'])


def publish(directory, node, owners, scope, sources, command_refs, artifacts, original, raw, limits, observations):
    context = set()
    for command_ref in command_refs:
        context.update(check_normalized(command_ref)['sourceBefore'])
    assert set(sources) <= context
    inspection = write(directory, 'current-inspection.json', {
        'schemaVersion': 1, 'nodeId': node, 'reviewer': '/root/b04_lock_cas',
        'checkedAt': datetime.now(timezone.utc).isoformat(), 'sourceContractHashes': sources,
        'reviewedSourceCount': len(sources), 'currentCommandInputCount': len(context),
        'commandCount': len(command_refs), 'allDeclaredCommandInputsCurrent': True,
        'oldEvidenceUnchanged': True, 'productCommandsRerun': False,
        'observations': observations,
    })
    unique = {entry['path']: entry for entry in [*artifacts, inspection, ref(SCRIPT)]}
    authority = {
        'schemaVersion': 1, 'type': 'body-independent-approval', 'nodeId': node,
        'reviewer': '/root/b04_lock_cas', 'implementationOwners': owners,
        'independent': True, 'decision': 'approve', 'scope': scope,
        'sourceContractHashes': sources, 'commandReceipts': command_refs,
        'reviewedAt': datetime.now(timezone.utc).isoformat(), 'scopeLimits': limits,
        'artifacts': list(unique.values()),
        'supportingEvidence': [{**entry, 'credit': 'raw-data-only'} for entry in [original, *raw]],
        'supportingEvidencePolicy': 'Prior reviews and historical command records are preserved hashed raw data. Only this new structured approval supplies current review authority, and only commandReceipts supplies passing command credit. No internal stale or rejected historical seal is promoted.',
    }
    approval_ref = write(directory, 'approval.json', authority)
    review = {key: authority[key] for key in ['schemaVersion', 'nodeId', 'reviewer', 'implementationOwners',
             'independent', 'decision', 'scope', 'sourceContractHashes', 'commandReceipts', 'scopeLimits']}
    review.update({'type': 'body-implementation-review', 'provenance': approval_ref,
                   'artifacts': [approval_ref, *authority['artifacts']]})
    review_ref = write(directory, 'review.json', review)
    return {'nodeId': node, 'approval': approval_ref, 'review': review_ref,
            'sourceCount': len(sources), 'commandCount': len(command_refs), 'contextCount': len(context)}


tail_result = publish(tail_out, 'B01', ['/root/b03_mutation_evidence', '/root'],
    'B01 tail/store subset only: full untracked-file and bounded Git-output identity, complete status membership refusal, mid-validation drift rejection, and persistent corrupt/quarantined finding evidence in actual bundle/store consumers. Canonical attribution is the original independent tail/store reviewer, /root/b04_lock_cas.',
    tail_sources, tail_commands, tail_artifacts, tail_manifest_ref, tail_raw,
    ['No B01 main coverage/maturity/specialist-gate approval and no full B01 card acceptance.',
     'Shared dependency identities are context for this subset, not B36 or other-card implementation approval; this reviewer authored B36.',
     'No atomic OS snapshot/fence, universal descendant settlement, provider/native/installed-package assurance.',
     'Initial quarantine counterexample failure and original producer typecheck failure remain uncredited historical data.'],
    {'tests': {'passed': 59, 'failed': 0}, 'producerOracleCases': 5, 'independentQuarantineCases': 2,
     'providerCalls': 0, 'sourceInspection': [
         {'path': 'sdk/src/tools/git-status.ts', 'line': 16, 'observed': 'Collector hashes every chunk before applying retained-prefix cap.'},
         {'path': 'sdk/src/tools/get-change-review-bundle.ts', 'line': 415, 'observed': 'Full file read loop hashes every byte and verifies handle/path metadata before accepting identity.'},
         {'path': 'sdk/src/tools/get-change-review-bundle.ts', 'line': 650, 'observed': 'Truncated status membership refuses identity; passing hooks cannot repair stale preimages.'},
         {'path': 'sdk/src/services/local-harness-store.ts', 'line': 392, 'observed': 'Only exact atomic diagnostic temp suffix is skipped; valid .tmp. IDs retain raw quarantine evidence.'},
     ]})
b02_result = publish(b02_out, 'B02', ['/root/b02_runtime_outcomes', '/root'],
    'B02 source TS/Bun runtime execution/action/task outcome separation, cancellation checkpoints and SDK/serve/CLI consumers, including approval-cancel unwinding and preserved journal/headless/CLI outcome identity. Scope is the bounded independently reviewed B02 lane only.',
    b02_sources, b02_commands, b02_artifacts, b02_manifest_ref, b02_raw,
    ['No B01 main specialist/gate acceptance and no B36 or other-card implementation approval; this reviewer authored B36.',
     'The extra 26 SDK typecheck inputs are current command context only, outside independent B02 implementation approval.',
     'No native/installed-package/provider/OS-fence/process-tree/cross-process-budget or universal trusted-generator isolation assurance.',
     'Only the recorded ten-file runtime subset and orders are credited; not the full 138-file runtime CI schedule.',
     'Initial multifile failures and before-correction commands remain uncredited historical evidence; no whole-plan/card-ledger completion is implied.'],
    {'counts': counts, 'actualSqliteSdkHeadlessCliCases': sqlite_checks,
     'approvalCases': 7, 'approvalCancellationRunAndActionsCancelled': True,
     'approvalCancellationEffectAndGrantAbsent': True, 'independentAcpHeadlessCases': 9,
     'providerCalls': 0, 'sourceInspection': [
         {'path': 'common/src/types/run-outcome.ts', 'line': 27, 'observed': 'Task acceptance is modeled separately from execution termination and action results.'},
         {'path': 'packages/agent-runtime/src/run-programmatic-step.ts', 'line': 605, 'observed': 'Abort checks surround generator advancement; terminal catch preserves cancellation/failed run outcome.'},
         {'path': 'packages/agent-runtime/src/tools/tool-executor.ts', 'line': 3928, 'observed': 'Abort signal is checked before recovery can convert cancellation to malformed-result output.'},
         {'path': 'sdk/src/run.ts', 'line': 1997, 'observed': 'Settled action evidence is projected after runtime unwinding without replacing terminal reason.'},
     ]})
print(json.dumps({'results': [tail_result, b02_result], 'productCommandsRerun': False}, indent=2))
