#!/usr/bin/env python3
"""Produce explicit B19 clause verdicts from retained original tests and captures.

This report never promotes the card or renews accepted source scopes.
"""
import hashlib
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/execution/body-roadmap/evidence/B19/continuation-20261111'
CANONICAL = Path('/tmp/openbuff-b19-recovery-20261111/docs/execution/body-roadmap/evidence/B19/implementation/final-matrix-adjudication-13')
REF_CACHE = {}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ref(path):
    path = path.resolve()
    if path not in REF_CACHE:
        REF_CACHE[path] = {'path': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
                           'sha256': sha(path)}
    return dict(REF_CACHE[path])


def read(path):
    return json.loads(path.read_text())


def verify(value):
    path = ROOT / value['path']
    assert path.is_file() and sha(path) == value['sha256'], value
    return path


def declared_test_title(line, anchor):
    # The selected anchor must belong to a quoted test title. Template slots
    # and test.each substitutions retain the rest of the exact declaration.
    for quote in ("'", '"', '`'):
        pattern = re.escape(quote) + r'((?:\\.|[^' + re.escape(quote) + r'\\])*)' + re.escape(quote)
        for candidate in re.findall(pattern, line):
            if anchor in candidate:
                return candidate
    return None


def test_title_pattern(title):
    slots = re.split(r'(%[sdjifp]|\$\{[^}]+\})', title)
    body = ''.join(r'.+?' if re.fullmatch(r'%[sdjifp]|\$\{[^}]+\}', part) else re.escape(part)
                   for part in slots)
    return re.compile(r'(?:.+ > )?' + body)


COMMON = 'common/src/util/__tests__/execution-context.test.ts'
APPROVAL = 'sdk/src/__tests__/execution-approval.test.ts'
HOST = 'sdk/src/__tests__/host-config.test.ts'
LAUNCH = 'sdk/src/__tests__/execution-launch.test.ts'
TIMERS = 'sdk/src/__tests__/execution-launch-timers.test.ts'
SDK = 'sdk/src/__tests__/run-host-contract-controls.test.ts'
HOOKS = 'sdk/src/__tests__/file-change-hooks.test.ts'
RUN = 'sdk/src/__tests__/run-host-execution.test.ts'
MCP = 'sdk/src/__tests__/run-mcp-execution.test.ts'
SDK_ORACLES = 'sdk/src/__tests__/execution-launch-oracles.test.ts'

EXTRA = {
 'permit': (COMMON, 'copied, foreign, wrong-target and already-used permits cannot dispatch'),
 'observer': (COMMON, 'dispatch alone never implies observed start; invalid/duplicate/stale observations refuse'),
 'origin': (COMMON, 'delegation cannot relabel the origin of an authentic destination'),
 'transfer-signal': (COMMON, 'transfer removes the sender resource signal but preserves the original absolute cap'),
 'transfer-new': (COMMON, 'first-unprepared transfer preserves sender correlation/cap and receiver cancellation=%s'),
 'transfer-admission': (COMMON, 'transferred admission preserves authority deadline origin=%s'),
 'reuse-operation': (COMMON, 'reuse binds every operation and rechecks basis before use'),
 'reuse-restart': (COMMON, 'resource reuse requires the same restart policy'),
 'root-time': (COMMON, 'root configuration time counts and large deadlines are chunked'),
 'timer-unbounded': (TIMERS, 'unbounded schedules nothing and exhausted callbacks remain asynchronous'),
 'timer-early': (TIMERS, 'early and late timer frames recheck fixed time without duration renewal'),
 'hook-default': (RUN, 'configured hooks default to 300 seconds, honor -1, and do not infer repository scripts'),
 'hook-cap': (HOOKS, 'hook local %s and parent %s preserve the effective cap %s'),
 'hook-infer': (HOOKS, 'reaches one mediated hook launch'),
 'hook-missing': (HOOKS, 'missing captured configuration is unavailable and creates no launch'),
 'hook-capture': (HOOKS, 'hook configuration, files, env and shell are copied before inference waits'),
 'root-config': (RUN, 'the root deadline starts before a blocking configuration read'),
 'root-async': (RUN, 'a pending asynchronous spawn setup cannot renew the root deadline'),
 'captured-env': (RUN, 'configuration and child env stay captured while asynchronous setup waits'),
 'captured-sync': (RUN, 'synchronous config readers cannot change the already captured child env or execution profile'),
 'detached-real': (RUN, 'detached real child survives sender cancellation but stops at the transferred finite cap'),
 'mcp-capture': (MCP, 'captures config, expansion environment and loopback once before later caller/global mutation'),
 'mcp-trusted': (MCP, 'only explicitly declared trusted %s credentials reach a child'),
 'mcp-no-key': (MCP, 'undeclared canonical and configured credentials are absent from the real child'),
 'mcp-isolation': (MCP, 'run owners, host epochs, modes and profiles never share a child'),
 'mcp-wait': (MCP, 'one concurrent request can cancel while the shared child serves its other owner lease'),
 'mcp-generation': (MCP, 'catalog/call require the current lease and an exited child obtains a fresh admitted generation'),
 'no-policy-context': (APPROVAL, 'a positive callback without current approval context never issues authority'),
 'host-auth': (HOST, 'copied snapshots and provider contexts are not authentic handles'),
 'host-store': (HOST, 'disabled credential store reads neither ambient tokens nor ambient credential files'),
 'host-home': (HOST, 'ancestor discovery stops at captured home and never substitutes ambient home'),
 'real-async-sync': ('sdk/src/__tests__/toolchain-execution.test.ts', 'real async runtime output and start observation stay distinct from ENOENT'),
 'real-sync': ('sdk/src/__tests__/toolchain-execution.test.ts', 'real spawnSync records a returned PID and exact replacement environment'),
 'bootstrap': ('sdk/src/__tests__/bootstrap-execution-authority.test.ts', 'rejects unrelated targets before async/sync policy under %s'),
 'high-impact': (APPROVAL, 'trusted MCP startup still requires approval for a classified high-impact effect'),
 'v2-effect': ('sdk/src/__tests__/harness-enforcement.test.ts', 'literal preprocessor bytes stay a pattern while a separate option is unsupported'),
 'snapshot-caps': ('sdk/src/__tests__/run-targeted-validation.test.ts', 'before and after snapshot caps are separate and both retain the original action cap'),
 'snapshot-capture': ('sdk/src/__tests__/run-targeted-validation.test.ts', 'validation scope, hook config, env and shell are captured before the first snapshot await'),
 'snapshot-after-refusal': ('sdk/src/__tests__/run-targeted-validation.test.ts', 'after snapshot preserves %s refusal and rejects passing hooks'),
 'snapshot-error': ('sdk/src/__tests__/run-targeted-validation.test.ts', 'reports a post-validation identity failure as a re-attestation error, not drift'),
 'snapshot-membership': ('sdk/src/__tests__/run-targeted-validation.test.ts', 'refuses validation before hooks when status membership overflows'),
 'snapshot-tail': ('sdk/src/__tests__/get-change-review-bundle.test.ts', 'full Git diff tails change independently of retained presentation bytes'),
 'snapshot-files': ('sdk/src/__tests__/get-change-review-bundle.test.ts', 'snapshot identity is independent of display truncation and includes every changed file'),
 'b36-status': ('sdk/src/__tests__/diagnostic-delta.test.ts', '%s retains command status through delta and hooks'),
 'mcp-real-env': ('sdk/src/__tests__/external-execution-branch-controls.test.ts', 'real.mcp-env captured destination'),
 'sdk-oracle.missing-authorizer': (SDK_ORACLES, 'approval.missing-authorizer: identical intended target refuses at host intake while explicit allow-all launches'),
 'sdk-oracle.mcp-missing-authorizer': (SDK_ORACLES, 'real.mcp-env: owned stdio preserves missing-authorizer host-intake refusal and explicit allow-all launches'),
 'sdk-oracle.sync-required': (SDK_ORACLES, 'sync.limit and review.admission.sync: real legacy adapter refuses required cooperative cancellation before spawnSync'),
 'sdk-oracle.concurrent-isolation': (SDK_ORACLES, 'review.config.isolation: two simultaneous SDK strategies read no ambient configuration'),
 'sdk-oracle.fresh-retry': (SDK_ORACLES, 'review.authority.v2-and-retry: fresh high-impact approval after %s preserves target grants through preflight'),
}

# Each phrase preserves a distinct requirement in the canonical oracle. A
# pending reason names the exact unproved experiment rather than a suite total.
# Entries: requirement, supporting proof IDs, raw fields, optional pending reason.
CLAUSES = {
 'env.merge-scrub': [
  ('Inherited/replacement environments; canonical and configured apiKeyEnv sentinels; undefined deletion; reinjection overrides; ordinary project variables and PATH; only allowed final values', ['common-env','common-replacement','launch-real-env'], ['adapterCalls/options/env','spawns/env','boundaryCalls/env'])],
 'env.destination': [
  ('Only captured delegated keys reach one trusted destination; copied handle refuses', ['common-delegation','mcp-trusted'], ['boundaryCalls/env','peer/env']),
  ('Expired, wrong-origin, wrong-destination and wrong-owner authentic delegation never delegates', ['origin','core-oracle.authentic-delegation-expiry','core-oracle.authentic-delegation-scope'], ['events','policyInputs','facts/environment/delegationIds']),
  ('Parent RPC child receives no automatic provider key', ['sdk-consumers','mcp-no-key'], ['boundaries/env','supervisedSeeds'])],
 'env.capture': [
  ('Ambient/config/env-input mutation during deferred authorization leaves captured final environment and binding intact', ['launch-deferred','host-snapshot','captured-env','captured-sync'], ['policyInputs/binding','adapterCalls/options/env']),
  ('An explicit changed request receives a fresh binding and fresh decision', ['host-snapshot','core-oracle.intended-env-fresh-decision'], ['policyInputs/binding/environmentDigest','policyInputs/bindingDigest','facts/environment/keyedDigest'])],
 'env.digest': [
  ('Exact key and value mutations alter keyed environment digest', ['approval-binding','core-oracle.env-digest-key-value'], ['facts/environment/keyedDigest']),
  ('Public facts contain no environment values, key material or plain secret hashes', ['common-env','core-oracle.public-env-privacy'], ['events/facts/environment']),
  ('Per-host epoch changes invalidate cross-epoch comparisons', ['mcp-isolation','core-oracle.host-epoch-digests'], ['events/facts/environment/keyEpochId','facts/hostContextId','facts/environment/keyedDigest'])],
 'approval.b18': [
  ('Exact bytes/effects/profile/basis remain B18 bound and v1 cannot authorize a v2 grant', ['approval-binding','approval-v1','approval-shell-roster'], ['policyInputs/binding','policyInputs/classification']),
  ('Forged, copied and consumed private target permits refuse; atomic B18 grant consumption occurs once', ['permit','approval-race','approval-receipt'], ['events']),
  ('Missing authorizer refuses at host intake before any target handle; an identical intended target with explicit allow-all is admitted and launches', ['no-policy-context','approval-background','sdk-oracle.missing-authorizer'], ['observation/intendedTarget','observation/refusalStage','observation/missing/selectedTargetDispatchCount','observation/explicitAllowAll/policyInputs'])],
 'admission.zero': [
  ('Denied/unavailable/already-aborted/literal-zero/delayed-cancellation/exhausted-later-target cases have zero selected target dispatch; late policy release cannot spawn', ['common-cancel','launch-unavailable','sdk-native'], ['result/controlCoverage/selectedTargetDispatchCount','result/controlCoverage/lateTargetDispatchCount','controlBoundary','upstreamGate','events']),
  ('Zero selected-target count preserves earlier helpers and public-intake refusals separately', ['sdk-native'], ['result/controlCoverage/earlierHelperLaunchIds','otherBranchDispatchEvents','callbackReached'])],
 'profile.truth': [
  ('Requested/available/active/enforced match declared actual adapter; full-access remains full-access; no-launch active=null', ['common-phase','launch-real-env','sdk-native'], ['events/facts/profile']),
  ('Unsupported required backend enforcement refuses instead of silently degrading', ['launch-unavailable','sdk-native'], ['execution/facts/profile','execution/refusal'])],
 'deadline.budget': [
  ('One absolute monotonic parent/action expiry; approval/probe time counts; retries receive remaining time', ['common-budget','launch-deferred','root-config','root-async'], ['clockTransitions','events/facts/deadlines','preparedAttempts']),
  ('Invalid clock/duration vectors refuse', ['common-clocks','core-oracle.cross-domain-seeds','core-oracle.nonfinite-clocks','core-oracle.invalid-durations','core-oracle.expiry-overflow','core-oracle.backward-versus-seed'], ['rootSeed','rootLifetime','budget']),
  ('Explicit unbounded arms no local timer and cannot replace a finite parent', ['timer-unbounded','common-budget','hook-cap'], ['events/facts/deadlines'])],
 'hooks.config': [
  ('Omitted/false auto inference is off; true enables inference; explicit configured hooks still run', ['hook-default','hook-infer'], ['adapterCalls/options','policyInputs/target']),
  ('Captured trusted configuration and owner/profile/admission reach the hook', ['sdk-consumers','hook-capture','hook-missing'], ['capturedHostConfiguration','events/facts']),
  ('Omitted local hook timeout is300s; -1 is unbounded; a finite parent wins', ['hook-default','hook-cap'], ['events/facts/deadlines','adapterCalls/options'])],
 'hooks.snapshot': [
  ('Both before/after snapshot Git launches preserve exact env/owner/admission/deadline and never retry via ambient runGit', ['snapshot-caps','snapshot-capture','snapshot-after-refusal'], ['fixtureCase/phase','adapterCalls/options','events/facts']),
  ('Preserve snapshot byte completeness and B36 unavailable/failed evidence', ['snapshot-tail','snapshot-files','snapshot-membership','snapshot-error','b36-status'], ['result/status','result/assurance','projected/observations','delta/diagnosticStatus'])],
 'resource.compatibility': [
  ('Compatible owner-domain/context reuse and request-local signals; different owners/epochs/mode/profile/restart policy do not share', ['common-reuse','mcp-isolation','reuse-restart','mcp-wait'], ['events','request','boundaryCalls/signalPresent']),
  ('Different environment/delegation/origin/generation never reuse', ['mcp-generation','origin','core-oracle.env-only-resource-nonreuse','core-oracle.delegation-only-resource-nonreuse'], ['facts/resourceId','facts/resourceGeneration','facts/environment/delegationIds','policyInputs/binding/delegationDigest']),
  ('B20 release/eviction/cleanup remains separate', [], [])],
 'detach.transfer': [
  ('Transfer requires private receiver/permit/record and preserves original correlation', ['common-transfer','transfer-new','approval-background'], ['events/facts/correlation','events/facts/ownerId','events/facts/resourceGeneration']),
  ('Detach retains selected limit; parent return does not release child lease or certify death', ['transfer-signal','detached-real'], ['result/controlCoverage/successfulTransferredResourceSurvivesSender','boundaries'])],
 'sync.limit': [
  ('Production async route delivers resource signal to actual spawn', ['real-async-sync','launch-real-env'], ['spawns','boundaryCalls']),
  ('Legacy sync honestly reports unavailable cooperative cancellation and refuses when required', ['common-sync','real-sync','sdk-oracle.sync-required'], ['observation/refusal','observation/requiredEvents','observation/selectedTargetDispatchCount','observation/positive/calls']),
  ('Capture alone does not certify cancellation', ['real-sync'], ['children'])],
 'real.key-free': [
  ('Harmless real children observe only synthetic allowed markers; no providers; owned empty HOME/XDG; replacement env; --no-env-file', ['common-real-env','launch-real-env','sdk-strategy'], ['children','peer/env','sourceResults/environment']),
  ('Distinguish real child environment from injected Node/Chrome/LSP/source-supervision capture', ['common-real-env','real-sync'], ['children/kind','evidenceKind','syntheticPidCount'])],
 'real.mcp-env': [
  ('Real local stdio recorder verifies exact replacement environment including upstream HOME/PATH defaults', ['mcp-real-env','mcp-capture','mcp-trusted','mcp-no-key'], ['boundaryCalls/env','peer/env']),
  ('Owned stdio propagates an actual missing-authorizer host-intake unavailable refusal with zero spawn; explicit allow-all starts its identical intended child', ['common-delegation','sdk-oracle.mcp-missing-authorizer'], ['observation/transport','observation/observations/refusalStage','observation/observations/spawns','observation/observations/events'])],
 'strategy.sdk': [
  ('Trusted strategy chooses/completes real SDK read/edit/command with explicit full access; bytes/effects/B02 receipts; zero provider calls', ['sdk-strategy'], ['output','actions','execution','launches','network']),
  ('Required native-unavailable second scenario launches zero target', ['sdk-native'], ['output','execution','launches'])],
 'route.precedence': [
  ('Recommendation cannot replace explicit user/model/agent route; actual captured consumers choose selected provider/model', ['sdk-consumers'], ['captures','recommendation','explicitRoute']),
  ('Strategy retains ownership of task sequence', ['sdk-strategy'], ['output','actions'])],
 'source.stability': [
  ('Frozen source/toolchain/fixture roster before execution; failures retained; after-execution hashes match', ['source-freeze'], ['sourceResults/manifest','sourceResults/suites/sourceStable','compiledResults/runner']),
  ('Exact sorted affected-package CI discovery/invocation and non-author final review', [], [], 'Earlier whole-package CI, guard, typecheck, CLI rebuild/consumer, package consumer and independent Blender/core review originals are retained. Root must join the final exact affected-package discovery/invocation and non-author review to the added core/SDK oracle source roster; prerequisite source-scope renewals remain separate.')],
 'review.config.isolation': [
  ('env/inheritEnv remain child controls; captured cwd/project/home/global/selection/trust governs host config without real-home fallback', ['host-isolation','host-relative','host-home','host-store','common-replacement'], ['capturedHostConfiguration']),
  ('Poison ambient config inputs and assert zero ambient config reads in two concurrently active SDK scopes', ['host-credentials','sdk-consumers','sdk-oracle.concurrent-isolation'], ['observation/overlap','observation/scopes/ambientConfigReads','observation/scopes/explicitConfigReads','observation/unattributedAmbientReads'])],
 'review.config.cache-completeness': [
  ('Strict immutable per-run host snapshot; no shared mutable host config cache; earlier run retains captured contents after hot changes', ['host-snapshot','host-auth','sdk-consumers','captured-env'], ['captures','capturedHostConfiguration']),
  ('New config/trust/env inputs require a new host context/run; missing required/partial selected load is unavailable', ['host-required','host-snapshot','host-relative'], ['configReads'])],
 'review.config.actual-consumers': [
  ('Actual getModelForRequest/context windows/stream/plain/structured/OpenCode fallback/selected credential port use one snapshot', ['sdk-consumers'], ['snapshotId','captures','transports','contextWindows','fallback','credentialCalls','replacementCredentialCalls']),
  ('Readable-root containment including direct LSP path plus hooks and supervision seed use same captured snapshot while child env remains separate', ['sdk-consumers','sdk-fallback'], ['containment','supervisedSeeds','execution','launches'])],
 'review.admission.sync': [
  ('PreparedLaunch.admitSync uses registered synchronous policy; Promise/async-required/missing policy refuses synchronously without async policy entry', ['common-sync'], ['events']),
  ('Unavailable required capability gives zero real spawnSync; production owning-target/build/SCIP use async', ['real-sync','sdk-oracle.sync-required'], ['spawns/kind','policy/kind','observation/refusal','observation/selectedTargetDispatchCount'])],
 'review.deadline.action-derivation': [
  ('Capture absolute root seed before synchronous configuration; preserve parent deadline/domain; register action before async preflight; memoized narrow adapter derivation cannot renew', ['root-config','root-async','common-budget','approval-background'], ['events/facts/deadlines','privateRegistrations']),
  ('Backward-vs-seed/cross-domain/nonfinite/overflow inputs refuse', ['common-clocks','core-oracle.cross-domain-seeds','core-oracle.nonfinite-clocks','core-oracle.invalid-durations','core-oracle.expiry-overflow','core-oracle.backward-versus-seed'], ['rootSeed','rootLifetime','budget']),
  ('Long native timers use bounded chunks without deadline renewal', ['root-time','timer-long','timer-early'], ['clockTransitions'])],
 'review.git.producer-closure': [
  ('All applicable original26producers; push seven queries; direct workspace/status/bundle; both snapshot passes; bounded/legacy identity; journal/broker host observation; direct gitBranch host operation', ['sdk-strategy'], ['fixtureCase/producerId','fixtureCase/branchId','fixtureCase/phase','events/facts/correlation']),
  ('Bootstrap denial cannot become successful fallback identity', ['bootstrap','sdk-native'], ['result','execution'])],
 'review.branch.expansion': [
  ('Freeze original producer/branch matrix and execute each applicable edge/parameter selector;136branch entries,14versions,8SCIPindexers x4paths,6diagnostics x3phases,LSP restart/reacquire,3Chrome,5Blender', [], ['selector-joins','edge-coverage','blender-sdk-case-joins']),
  ('Counts alone never establish execution coverage', [], ['case-index'])],
 'review.resource.request-versus-lifetime': [
  ('Only exact host context/lifetime/owner reuses; A cancellation cannot cancel resource held by B; spawn gets lifetime signal and wait/admission requester signal', ['common-reuse','mcp-wait','transfer-signal'], ['request','boundaryCalls','events']),
  ('Private lease/use permit ties to generation; foreign/fabricated handles refuse', ['reuse-operation','permit','mcp-generation'], ['events/facts/resourceGeneration','events/facts/leaseId'])],
 'review.authority.v2-and-retry': [
  ('StoredExecutionAuthorityV2 exact canonical29ordered binding; v1 never grants v2; atomic matching B18 consume issues one private permit', ['approval-binding','approval-v1','approval-race','approval-receipt','permit'], ['policyInputs/binding']),
  ('Every high-impact retry after dispatch/failure/uncertainty needs fresh explicit decision; preflight cannot consume target grant', ['approval-enoent','high-impact','sdk-oracle.fresh-retry'], ['observation/requests','observation/decisions','observation/preflights','observation/attempts','observation/grants'])],
 'review.mcp.captured-destination': [
  ('Opaque keyed destination and once-captured resolved bytes determine key/admission/delayed transport; no legacy public cache key/plain per-value hashes', ['mcp-capture','mcp-isolation','common-env','core-oracle.public-env-privacy'], ['destinationId','boundaryCalls/env','authorizerInputs/binding']),
  ('Explicit destination/owner-set/expiry delegation only; client variables never expanded', ['origin','mcp-trusted','core-oracle.authentic-delegation-expiry','core-oracle.authentic-delegation-scope'], ['peer/env','events','policyInputs'])],
 'review.detach.receiver': [
  ('Private offer -> accept -> commit; bind target after commit on new owner/generation; preserve min old/receiver deadline and original correlation', ['common-transfer','transfer-new','approval-background'], ['events','events/facts']),
  ('Delegated receiver must belong to captured permitted owner set; bare detach grants no authority', ['approval-background','core-oracle.delegated-transfer-owner-set'], ['events','facts/resourceGeneration','policyInputs','dispatchInput/env'])],
 'review.receipt.phase-truth': [
  ('Planned/admitted/dispatched/spawn-observed/no-launch/dispatch-failed/reused stay separate; active=null until actual observed start', ['common-phase','common-enoent','sdk-native','real-async-sync'], ['events/phase','events/facts/profile']),
  ('ENOENT has not-observed start; reused receipt cites original observed process and new lease', ['approval-enoent','common-reuse','mcp-generation'], ['events/originalLaunchId','events/facts/leaseId'])],
 'review.v2.classification-source': [
  ('Exact complete classification plus command identity enters canonical v2 binding before authorization; post-capture mutations leave snapshot intact', ['common-classification','approval-binding','approval-shell-roster'], ['policyInputs/classification','policyInputs/binding']),
  ('Unsupported required classification refuses with zero dispatch; common owns computation and never imports SDK or trusts caller input digest', ['common-classification','v2-effect','core-oracle.unsupported-required-classification','core-oracle.caller-digest-refusal'], ['policyInputs/classification','policyInputs/binding','events']),
  ('Canonical effect/parser vectors establish ordering and null/empty semantics', ['approval-binding','approval-shell-roster','v2-effect','core-oracle.independent-v2-tuple'], ['bindingTuple','canonicalBindingBytes'])],
 'review.launch.observation-facade': [
  ('Launch-bound observer lacks root registration authority; dispatch alone keeps active=null; success names correct launch/generation and missing/failed spawn never observed', ['observer','common-enoent','real-async-sync'], ['events/facts','events/phase']),
  ('Reuse cites original process; LSP peer captured at actual CodebuffSpawn boundary, separate from real OS process evidence', ['common-reuse'], ['events/originalLaunchId','result/peerCaptures','evidenceKind'])],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-results', type=Path, default=BASE / 'final-controls-r3/results.json')
    parser.add_argument('--join-directory', type=Path, default=BASE / 'capture-joins/current-r3')
    parser.add_argument('--cli-directory', type=Path, default=BASE / 'cli-consumer-r3')
    parser.add_argument('--package-directory', type=Path, default=BASE / 'package-consumers/runs/fresh-r6')
    parser.add_argument('--ci-results', type=Path)
    parser.add_argument('--final-review', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    OUT = args.out.resolve()
    assert OUT.is_relative_to(BASE / 'capture-joins')
    closure = read(CANONICAL / 'closure-requirements.json')
    focused = read(args.source_results)
    assert focused['passed']
    manifest_path = verify(focused['manifest'])
    manifest = read(manifest_path)
    join_report = read(args.join_directory / 'report.json')
    assert join_report['sourceResults']['sha256'] == sha(args.source_results)
    joins = read(verify(join_report['artifacts']['selector-joins.json']))
    cases = read(verify(join_report['artifacts']['case-index.json']))
    edge_rows = read(verify(join_report['artifacts']['edge-coverage.json']))
    compiled_results_path = verify(join_report['compiledResults'])
    logs = []
    for i, suite in enumerate(focused['suites']):
        receipt_path = args.source_results.parent / f'{i:02d}-result.json'
        assert suite['sourceStable'] and suite['exitCode'] == 0
        assert read(receipt_path) == suite
        logs.append({'source': suite['suite'], 'log': verify(suite['log']),
                     'receipt': receipt_path, 'sourceDispatchManifest': ref(manifest_path)})
    broad = read(BASE / 'broad-sdk-runtime/results.json')
    assert broad['passed']
    for receipt in broad['workspaces']:
        assert receipt['exitCode'] == 0
        roster = {str(Path(arg).relative_to(ROOT)) for arg in receipt['command']
                  if arg.endswith(('.test.ts', '.test.tsx')) and Path(arg).is_relative_to(ROOT)}
        assert len(roster) == receipt['fileCount']
        logs.append({'source': None, 'roster': roster,
                     'log': verify({'path': receipt['log'], 'sha256': receipt['logSha256']}),
                     'receipt': BASE / 'broad-sdk-runtime/results.json', 'sourceDispatchManifest': None})
    for entry in logs:
        entry['lines'] = entry['log'].read_text().splitlines()
    structured_logs = []
    for entry in logs:
        if entry['source'] != SDK:
            continue
        for number, line in enumerate(entry['lines'], 1):
            if line.startswith(('B19_SDK_STRATEGY ', 'B19_SDK_CAPTURED_CONSUMERS ', 'B19_SDK_CAPTURED_HOOK ', 'B19_SDK_REQUIRED_UNAVAILABLE ')):
                prefix, _, payload = line.partition(' ')
                structured_logs.append({'id': prefix, 'log': ref(entry['log']), 'line': number,
                                        'lineSha256': hashlib.sha256(line.encode()).hexdigest(),
                                        'receipt': ref(entry['receipt']), 'observed': json.loads(payload)})
    blender_suite = 'sdk/src/__tests__/blender-sdk-execution-branch-controls.test.ts'
    focused_blender = [case for case in cases if case['schema'] == 'blender-sdk']
    blender_originals = []
    if any(log['source'] == blender_suite for log in logs):
        assert len(focused_blender) == 35, 'Declared final Blender suite must retain all 35 callback captures'
        for case in focused_blender:
            assertion = case['assertion']
            log_path = verify(assertion)
            line = log_path.read_text().splitlines()[assertion['line'] - 1]
            blender_originals.append({'capture': case['capture'], 'manifest': ref(manifest_path),
                'sameSourceInvocation': True,
                'assertion': {'source': assertion['testSource'], 'log': ref(log_path),
                              'line': assertion['line'], 'text': line}})
    else:
        # Historical focused runs predate the Blender suite. Their independently
        # sealed Blender supplement remains separate; a declared final suite
        # with missing captures can never substitute this older run.
        blender_manifest_path = BASE / 'blender-sdk-controls/final-manifest.json'
        blender_manifest = read(blender_manifest_path)
        assert blender_manifest['status'] == 'passed'
        blender_log_path = ROOT / blender_manifest['finalLog']
        blender_log = blender_log_path.read_text().splitlines()
        for claim in blender_manifest['cases']:
            path = ROOT / claim['artifact']
            assert sha(path) == claim['sha256']
            data = read(path)
            assert data['sourceHashes'] == blender_manifest['sourceHashes']
            name = f"sdk.blender {data['branch']} {data['control']}"
            passing = [(i, value) for i, value in enumerate(blender_log, 1)
                       if (match := re.fullmatch(r'\(pass\) (.*?) \[[^\]]+\]', value)) and
                       (match.group(1) == name or match.group(1).endswith(' > ' + name))]
            assert len(passing) == 1, name
            blender_originals.append({'capture': ref(path), 'manifest': ref(blender_manifest_path),
                'sameSourceInvocation': False,
                'assertion': {'source': {'path': blender_suite, 'sha256': data['sourceHashes'][blender_suite]},
                              'log': ref(blender_log_path), 'line': passing[0][0], 'text': passing[0][1]}})
    blender = []
    for original in blender_originals:
        path = verify(original['capture'])
        data = read(path)
        assert data['status'] == 'passed'
        assert all(sha(ROOT / file) == digest for file, digest in data['sourceHashes'].items()), data['caseId']
        assert data['targetBoundaryCount'] == (1 if data['control'] == 'happy' else 0)
        blender.append({'edgeId': 'sdk.blender::' + data['branch'], 'caseId': data['caseId'],
                        'control': data['control'], 'capture': ref(path), 'manifest': original['manifest'],
                        'assertion': original['assertion'], 'sameSourceInvocation': original['sameSourceInvocation'],
                        'callbackReached': data['callbackReached'], 'targetBoundaryCount': data['targetBoundaryCount'],
                        'sdkHelperBoundaryCount': data['sdkHelperBoundaryCount'],
                        'earlierBlenderHelperCount': data['earlierBlenderHelperCount'],
                        'requestedProfile': data['requestedProfile'], 'limitations': data['limitations'],
                        'evidenceKind': data['evidenceKind'], 'route': 'OpenbuffClient.run SDK callback', 'acceptance': False})
    assert len(blender) == 35
    core_vectors_path = BASE / 'core-oracle-controls/control-vectors.json'
    core_vectors = read(core_vectors_path)
    assert sha(ROOT / core_vectors['sourceFile']) == core_vectors['sourceSha256']
    assert len(core_vectors['vectors']) == core_vectors['testGroups']
    assert sum(v['caseCount'] for v in core_vectors['vectors']) == core_vectors['caseCount']
    vector_metadata = {'core-oracle.' + v['vectorId']: v for v in core_vectors['vectors']}
    assert all(len(v['selectors']) == v['caseCount'] for v in vector_metadata.values())
    expected_selectors = {proof_id: v['selectors'] for proof_id, v in vector_metadata.items()}
    expected_selectors['sdk-oracle.fresh-retry'] = [EXTRA['sdk-oracle.fresh-retry'][1].replace('%s', outcome)
                                                  for outcome in ['ENOENT','failing-child','unobserved-child']]
    specs = ({k: (v['path'], v['anchor']) for k, v in closure['specificTestSources'].items()} | EXTRA |
             {proof_id: (v['sourceFile'], v['sourceNameTemplate']) for proof_id, v in vector_metadata.items()})
    proofs = {}
    for proof_id, (name, anchor) in specs.items():
        source = ROOT / name
        text = source.read_text()
        pos = text.find(anchor)
        if pos == -1:
            proofs[proof_id] = {'status': 'pending-anchor-missing', 'source': ref(source), 'anchor': anchor}
            continue
        line_no = text.count('\n', 0, pos) + 1
        source_lines = text.splitlines()
        end = next((i for i in range(line_no, len(source_lines)) if re.match(r'\s*(?:test|it)(?:\(|\.each)', source_lines[i])), min(line_no + 180, len(source_lines)))
        starts = [i for i in range(line_no) if re.match(r'\s*(?:test|it)(?:\(|\.each)', source_lines[i])]
        start = starts[-1] if starts else line_no - 1
        block = '\n'.join(source_lines[start:end])
        title = declared_test_title(source_lines[line_no - 1], anchor)
        if title is None:
            proofs[proof_id] = {'status': 'pending-test-title-missing', 'source': ref(source), 'anchor': anchor}
            continue
        pattern = test_title_pattern(title)
        passed = []
        for log in logs:
            if log['source'] not in (None, name):
                continue
            if log['source'] is None and name not in log['roster']:
                continue
            for number, value in enumerate(log['lines'], 1):
                match = re.fullmatch(r'\(pass\) (.*?) \[[^\]]+\]', value)
                if match and pattern.fullmatch(match.group(1)):
                    passed.append({'log': ref(log['log']), 'line': number, 'text': value,
                                   'testName': match.group(1), 'receipt': ref(log['receipt']),
                                   'sourceDispatchManifest': log['sourceDispatchManifest']})
        expectations = [{'line': i + 1, 'text': source_lines[i]} for i in range(start, end)
                        if 'expect(' in source_lines[i] or 'throw new Error' in source_lines[i]]
        frozen_sha = manifest['inputs'].get(name)
        current_sha = sha(source)
        bound_passes = [p for p in passed if p['sourceDispatchManifest'] is not None]
        missing_selectors = [selector for selector in expected_selectors.get(proof_id, [])
                             if not any(p['testName'] == selector or p['testName'].endswith(' > ' + selector)
                                        for p in bound_passes)]
        specific_dispatch_joined = bool(bound_passes) and not missing_selectors
        proofs[proof_id] = {'status': 'asserted-current-original-test' if specific_dispatch_joined and frozen_sha == current_sha and expectations else 'pending-specific-current-assertion-join',
                            'source': ref(source), 'dispatchManifestSha256': frozen_sha,
                            'sourceMatchesOriginalManifest': frozen_sha == current_sha, 'anchor': anchor,
                            'declaredTestTitle': title, 'specificOriginalDispatchJoined': specific_dispatch_joined,
                            'expectedSelectors': expected_selectors.get(proof_id, []), 'missingExpectedSelectors': missing_selectors,
                            'vectorManifest': ref(core_vectors_path) if proof_id in vector_metadata else None,
                            'declaredVector': vector_metadata.get(proof_id),
                            'startLine': start + 1, 'excerpt': block, 'assertions': expectations, 'passingOriginals': passed}
    assert set(CLAUSES) == {c['controlId'] for c in closure['controlRequirements']}
    sdk_capture_groups = {
        'sdk-oracle.missing-authorizer': ['missing-authorizer'],
        'sdk-oracle.mcp-missing-authorizer': ['mcp-missing-authorizer'],
        'sdk-oracle.sync-required': ['sync-required-cooperative-cancellation'],
        'sdk-oracle.concurrent-isolation': ['concurrent-sdk-isolation'],
        'sdk-oracle.fresh-retry': ['fresh-retry-' + outcome for outcome in ['ENOENT','failing-child','unobserved-child']],
    }
    for proof_id, case_names in sdk_capture_groups.items():
        proofs[proof_id]['oracleCaptureCaseIds'] = [c['caseId'] for c in cases
            if c['schema'] == 'sdk-oracle' and c['selectorKey'][2] in case_names]
    source_drift = [{'path': name, 'manifestSha256': digest,
                     'currentSha256': sha(ROOT / name) if (ROOT / name).is_file() else None}
                    for name, digest in manifest['inputs'].items()
                    if not (ROOT / name).is_file() or sha(ROOT / name) != digest]
    required_final_sources = {core_vectors['sourceFile'], SDK_ORACLES, blender_suite,
                              'sdk/src/__tests__/fixtures/b19-launch-oracles.ts',
                              'sdk/src/__tests__/fixtures/b19-blender-sdk-branch-controls.ts'}
    missing_final_sources = sorted(required_final_sources - set(manifest['inputs']))
    compiled = read(compiled_results_path)
    verify(compiled['manifest'])
    assert compiled['passed'] and all(c['passed'] and c['exitCode'] == 0 for c in compiled['cases'])
    same_freeze = compiled['manifest']['sha256'] == focused['manifest']['sha256']
    proofs['source-freeze'] = {'status': 'asserted-current-original-command' if not source_drift and not missing_final_sources and same_freeze else 'pending-final-source-freeze',
        'kind': 'frozen-source-roster-and-original-command-receipts', 'manifest': ref(manifest_path),
        'sourceResults': ref(args.source_results), 'compiledResults': ref(compiled_results_path),
        'sameCompiledAndSourceFreeze': same_freeze, 'missingFinalSources': missing_final_sources,
        'liveSourceDrift': source_drift, 'focusedSuiteReceipts': [ref(log['receipt']) for log in logs if log['source'] is not None],
        'evidenceBoundary': 'Source/toolchain roster for these retained source and compiled commands. Earlier failed invocations remain retained independently; package CI and non-author review are separate root proofs.',
        'acceptance': False}
    final_root_proof = None
    assert (args.ci_results is None) == (args.final_review is None), 'Final CI and independent review must be supplied together'
    if args.ci_results is not None and args.final_review is not None:
        ci = read(args.ci_results)
        review = read(args.final_review)
        assert ci['complete'] and ci['passed'] and ci['sourceStable'] and ci['toolchainStable']
        assert ci['manifest']['sha256'] == focused['manifest']['sha256']
        verify(ci['manifest'])
        dispatch = read(verify(ci['dispatchManifest']))
        assert ci['ciMatrix'] == ['.agents', 'agents', 'cli', 'common', 'evals', 'packages/agent-runtime',
                                  'packages/indexer', 'packages/internal', 'sdk', 'scripts']
        assert len(ci['typecheckWorkspaces']) == 11 and len(ci['commands']) == 39
        assert len(dispatch['commands']) == len(ci['commands'])
        assert dispatch['sourceManifest']['sha256'] == focused['manifest']['sha256']
        rosters = read(verify(dispatch['rosters']))
        verify(rosters['workflow'])
        assert rosters['ciMatrix'] == ci['ciMatrix'] and rosters['typecheckWorkspaces'] == ci['typecheckWorkspaces']
        for roster in rosters['rosters'].values():
            assert roster['fileCount'] == len(roster['files']) > 0
            assert roster['files'] == sorted(roster['files'], key=lambda name: name.encode())
            for name, digest in roster['sourceHashes'].items():
                source_path = (ROOT / roster['package'] / name).resolve()
                assert manifest['inputs'][str(source_path.relative_to(ROOT))] == digest
        assert ci['expectedCommands'] == [row['name'] for row in ci['commands']]
        assert all(row['passed'] and row['sourceStable'] and row['toolchainStable'] and row['exitCode'] == 0
                   for row in ci['commands'])
        for row, planned in zip(ci['commands'], dispatch['commands']):
            assert all(row[name] == planned[name] for name in ['name', 'argv', 'cwd', 'category'])
            verify(row['log'])
            assert read(verify(row['sourceBefore'])) == manifest['inputs']
            assert read(verify(row['sourceAfter'])) == manifest['inputs']
            if row['testSummary'] is not None:
                summary = row['testSummary']
                assert summary['nonVacuous'] and not summary['missingDiscoveredFilesInLog']
                assert all(count == 0 for count in summary['reportedFailureCounts'])
        assert review['kind'] == 'b19-final-independent-composition-review'
        assert review['reviewer'] != '/root' and review['verdict'] == 'APPROVE'
        expected_review_inputs = {
            'sourceManifest': manifest_path, 'sourceResults': args.source_results,
            'compiledResults': compiled_results_path, 'ciResults': args.ci_results,
            'packageResults': args.package_directory / 'raw.json',
            'cliSourceBinding': args.cli_directory / 'source-binding.json',
        }
        for name, expected_path in expected_review_inputs.items():
            assert verify(review[name]).resolve() == expected_path.resolve()
        verify(review['oracleResults'])
        final_root_proof = {'status': 'asserted-current-original-command',
            'kind': 'exact-ci-and-independent-composition-review',
            'ciResults': ref(args.ci_results), 'dispatchManifest': ci['dispatchManifest'],
            'review': ref(args.final_review), 'manifest': ref(manifest_path),
            'acceptance': False}
        proofs['final-ci-review'] = final_root_proof
    controls = []
    for control in closure['controlRequirements']:
        clauses = []
        for i, (phrase, proof_ids, fields, *missing) in enumerate(CLAUSES[control['controlId']], 1):
            if control['controlId'] == 'source.stability' and i == 2 and final_root_proof:
                proof_ids, fields, missing = ['final-ci-review'], ['ciResults', 'review'], []
            unjoined = [p for p in proof_ids if proofs[p]['status'] not in
                        ('asserted-current-original-test','asserted-current-original-command')]
            reason = missing[0] if missing else None
            if unjoined:
                reason = (reason + ' ' if reason else '') + 'Specific source/assertion joins unresolved: ' + ', '.join(unjoined)
            clauses.append({'clauseId': control['controlId'] + ':' + str(i), 'requirement': phrase,
                            'status': 'pending' if reason else 'passed-at-declared-evidence-boundary',
                            'proofIds': proof_ids, 'assertedObservedFields': fields,
                            'structuredLogIds': [x['id'] for x in structured_logs] if any(p in ['sdk-consumers','sdk-strategy','sdk-native'] for p in proof_ids) else [],
                            'captureSchemaIds': control['candidateCaptureSchemaIds'],
                            'caseIds': [c['caseId'] for c in cases if c['schema'] in control['candidateCaptureSchemaIds']],
                            'missingClauseOrScenario': reason,
                            'evidenceLimit': 'Core test assertions plus declared real/injected consumer receipts; no OS/process-tree claim inferred from synthetic PID or event.',
                            'acceptance': False})
        controls.append({'controlId': control['controlId'], 'canonicalOracle': control['canonicalOracle'],
                         'status': 'passed-complete-declared-oracle' if all(c['status'].startswith('passed') for c in clauses) else 'pending-complete-oracle',
                         'clauses': clauses, 'acceptance': False})
    control_index = {c['controlId']: c for c in controls}
    verdicts = []
    for edge in edge_rows:
        required = edge['requiredControlIds']
        selected = [j for j in joins if j['edgeId'] == edge['edgeId']]
        blockers = [{'controlId': control_id, 'clauseId': clause['clauseId'], 'missingScenario': clause['missingClauseOrScenario']}
                    for control_id in required if control_id in control_index
                    for clause in control_index[control_id]['clauses'] if clause['status'] == 'pending']
        positive = [cases[j['caseIds'][0]] for j in selected if j['canonicalStateSlot'] == 'positive' and j['caseIds']]
        positive_observed = any(c['observations']['targetDispatchEvents'] or c['observations']['targetEventPhases'].get('resource-reused')
                                or c['observations']['selectedTargetDispatchCount'] for c in positive)
        launch_edge = edge['edgeId'] != 'native.selection::native.unavailable'
        passed_selectors = all(j['caseIds'] and j['assertionJoined'] for j in selected) and bool(selected)
        selector_boundary_passed = passed_selectors and (positive_observed or not launch_edge)
        current_status = 'source-backed-not-applicable' if edge['sourceApplicability'] == 'source-backed-not-applicable' else (
            'pending-producer-selector-boundary' if not selector_boundary_passed else
            'pending-complete-required-oracles' if blockers else 'passed-declared-producer-selector-boundary')
        if edge['producerId'] == 'sdk.blender':
            upgrade = [c for c in blender if c['edgeId'] == edge['edgeId']]
            assert len(upgrade) == 7 and any(c['control'] == 'happy' and c['callbackReached'] for c in upgrade)
        else:
            upgrade = []
        verdicts.append({**edge, 'selectorBoundaryVerdict': 'passed-asserted-declared-boundary' if selector_boundary_passed else 'source-N/A' if edge['sourceApplicability'] != 'applicable' else 'pending',
                         'positiveSelectedDispatchOrReuseObserved': positive_observed,
                         'caseIds': [j['caseIds'][0] for j in selected if j['caseIds']], 'requiredOracleBlockers': blockers,
                         'missingRawCaptureRowIds': [j['rowId'] for j in selected if not j['caseIds']],
                         'sdkCallbackUpgrade': upgrade, 'finalEvidenceVerdict': current_status, 'acceptance': False})
    sdk_oracle_captures = [{name: case[name] for name in ['caseId','selectorKey','capture','assertion','sourceRefs','receipt','fields','acceptance']}
                          for case in cases if case['schema'] == 'sdk-oracle']
    cli_directory = args.cli_directory.resolve()
    assert cli_directory.is_relative_to(BASE), 'CLI evidence must stay inside this B19 continuation'
    cli_result = read(cli_directory / 'result.json')
    cli_child = read(cli_directory / 'command.json')
    cli_addendum = read(cli_directory / 'assertion-addendum.json')
    assert cli_result['passed'] and cli_result['exitCode'] == 0 and all(cli_result['checks'].values())
    assert cli_addendum['passed'] and cli_result['networkRequests'] == []
    verify(cli_result['binary'])
    assert cli_child['content'] == 'after\n' and cli_child['environment']['PROJECT_VALUE'] == 'captured-cli-project'
    assert 'OPENAI_API_KEY' not in cli_child['environment'] and 'CUSTOM_PROVIDER_KEY' not in cli_child['environment']
    cli_records = [(number, json.loads(line)) for number, line in enumerate((cli_directory / 'run.log').read_text().splitlines(), 1)
                   if line.startswith('{')]
    completed = [record for _, record in cli_records if record.get('type') == 'finish']
    assert len(completed) == 1 and completed[0]['runOutcome']['termination'] == 'completed'
    actions = [record['actionOutcome'] for _, record in cli_records
               if record.get('type') == 'tool_result' and record.get('toolName') in ['read_files','edit_transaction','run_terminal_command']]
    assert len(actions) == 3 and all(action['outcome'] == 'succeeded' for action in actions)
    assert len({action['runId'] for action in actions}) == 1 and len({action['actionId'] for action in actions}) == 3
    edit = next(action for action in actions if action['toolName'] == 'edit_transaction')
    assert edit['effect']['status'] == 'confirmed' and edit['effect']['receiptIds']
    terminals = [(number, value['value']) for number, record in cli_records
                 if record.get('type') == 'tool_result' and record.get('toolName') == 'run_terminal_command'
                 for value in record['output'] if value['type'] == 'json']
    assert len(terminals) == 1 and terminals[0][1]['exitCode'] == 0
    assert terminals[0][1]['executionBindingVersion'] == 2 and re.fullmatch('[a-f0-9]{64}', terminals[0][1]['executionBindingDigest'])
    cli_supplement = {'status': 'asserted-supplemental-rebuilt-cli-consumer', 'acceptance': False,
        'artifacts': {name: ref(cli_directory / name) for name in ['result.json','run.log','command.json','assertion-addendum.json','peer.cjs','strategy.mjs','runner.py','config.json']},
        'binary': cli_result['binary'], 'completedRun': completed[0]['runOutcome'], 'actions': actions,
        'terminalResult': {'log': ref(cli_directory / 'run.log'), 'line': terminals[0][0], 'value': terminals[0][1]},
        'childReceipt': cli_child, 'providerRecorderConnections': 0,
        'limits': cli_result['limits'] + ['Supplemental CLI read/edit/command and child-environment receipt; no canonical edge denominator, prerequisite renewal, OS/process-tree or installation acceptance credit.']}
    OUT.mkdir(parents=True, exist_ok=False)
    artifact_names = ['source-assertions.json','control-adjudication.json','edge-adjudication.json','structured-logs.json','blender-sdk-case-joins.json','sdk-oracle-case-joins.json','cli-supplement.json']
    for name, value in [('source-assertions.json', proofs), ('control-adjudication.json', controls), ('edge-adjudication.json', verdicts),
                        ('structured-logs.json', structured_logs), ('blender-sdk-case-joins.json', blender),
                        ('sdk-oracle-case-joins.json', sdk_oracle_captures), ('cli-supplement.json', cli_supplement)]:
        (OUT / name).write_text(json.dumps(value, indent=2) + '\n')
    counts = {'controls': len(controls), 'completeOraclesPassed': sum(c['status'].startswith('passed') for c in controls),
              'completeOraclesPending': sum(c['status'].startswith('pending') for c in controls),
              'clauses': sum(len(c['clauses']) for c in controls),
              'clausesPassed': sum(cl['status'].startswith('passed') for c in controls for cl in c['clauses']),
              'clausesPending': sum(cl['status'] == 'pending' for c in controls for cl in c['clauses']),
              'applicableSelectorBoundariesPassed': sum(e['selectorBoundaryVerdict'].startswith('passed') for e in verdicts),
              'blenderSdkCallbackCasesJoined': len(blender),
              'sdkOracleCaptureCasesJoined': len(sdk_oracle_captures),
              'sourceNA': sum(e['selectorBoundaryVerdict'] == 'source-N/A' for e in verdicts)}
    report = {'card': 'B19', 'acceptance': False, 'counts': counts,
              'canonical': ref(CANONICAL / 'closure-requirements.json'), 'joinReport': ref(args.join_directory / 'report.json'),
              'generator': ref(Path(__file__)), 'sourceResults': ref(args.source_results),
              'compiledResults': ref(compiled_results_path), 'architecture': ref(BASE / 'architect-review.md'),
              'coreVectorManifest': ref(core_vectors_path),
              'packageSupplementalResults': [ref(args.package_directory / f'{mode}.result.json') for mode in ['cjs','esm']],
              'finalRootProof': final_root_proof,
              'retainedRootGates': {name: ref(BASE / path) for name, path in {
                  'remainingPackageCI': 'remaining-gates-r1/results.json',
                  'guardChecks': 'guard-gates-r1/results.json', 'workspaceTypechecks': 'sequential-typechecks/results.json',
                  'cliBuild': 'cli-build/result.json', 'independentCoreReview': 'final-review.md',
                  'independentBlenderReview': 'blender-review-addendum.md',
              }.items()},
              'artifacts': {name: ref(OUT / name) for name in artifact_names},
              'separateRootGates': ['Accepted-source-scope/prerequisite renewals',
                  'Final exact affected-package CI discovery/invocation and source joins',
                  'Final non-author composition/oracle review', 'Publication/installation acceptance gates'],
              'limits': ['A passed clause is limited to its actual assertion/declared consumer boundary.',
                         'Candidate schema case IDs are supporting candidates; only proof IDs establish this clause verdict.',
                         'Synthetic Node/Chrome/LSP/source-supervision observations never establish real OS starts/death or containment.',
                         'Package and compiled supplements retain their own source/build/runtime identities.',
                         'All pending requirements name concrete missing scenarios; no card acceptance is promoted.']}
    (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    md = '# B19 clause adjudication\n\n'
    md += f"Complete oracles: {counts['completeOraclesPassed']}/{counts['controls']}; passed clauses: {counts['clausesPassed']}/{counts['clauses']}; pending clauses: {counts['clausesPending']}. "
    md += f"Asserted applicable selector boundaries: {counts['applicableSelectorBoundariesPassed']}; source N/A edges: {counts['sourceNA']}.\n\n"
    md += '| Control | Verdict | Exact pending clause/scenario |\n| --- | --- | --- |\n'
    for c in controls:
        pending = '; '.join(cl['missingClauseOrScenario'] for cl in c['clauses'] if cl['status'] == 'pending')
        md += f"| {c['controlId']} | {c['status']} | {pending or 'All listed clauses joined to specific current assertions.'} |\n"
    md += '\nEvery canonical oracle is preserved in control-adjudication.json, decomposed into explicit clauses, asserted fields, original assertion/source references and missing scenarios. '
    launch_edges = [e for e in verdicts if e['sourceApplicability'] == 'applicable' and e['edgeId'] != 'native.selection::native.unavailable']
    md += f"{sum(e['positiveSelectedDispatchOrReuseObserved'] for e in launch_edges)}/{len(launch_edges)} applicable launch edges have asserted positive selected dispatch/reuse. Native unavailable is separately an asserted bootstrap refusal. "
    md += f"Final edge verdicts remain tied to their required complete control clauses; {len(blender)} Blender SDK callback receipts and {len(sdk_oracle_captures)} SDK oracle captures are individually joined. "
    md += 'The rebuilt CLI read/edit/command and captured child-environment supplement links its original NDJSON and exact v2 terminal binding. All acceptance fields remain false.\n'
    (OUT / 'README.md').write_text(md)
    print(json.dumps(counts, indent=2))


if __name__ == '__main__':
    main()
