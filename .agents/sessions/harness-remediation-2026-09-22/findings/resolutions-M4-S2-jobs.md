# Audit findings: resolutions-M4-S2-jobs

- Subsystems: sdk, packages/agent-runtime, common
- Features: background-process-jobs, background-agent-jobs, check-job-poll-follow, check-background-agent-poll-follow, job-digest-listing, kill-job, job-update-streaming-ipc, job-registry-core
- Files covered: 11

## [CRITICAL] correctness — packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts — [ALREADY-RESOLVED][M1-T7] check_background_agent returns tuple-wrapped output; foreign/not-found share one generic payload
- **Risk:** was: unrenderable tool results (output[0] undefined)
- **Fix:** none — confirmed fixed (M1-T7)
- **Evidence:** check-background-agent.ts: all three return sites return [{type:'json',value:...}] with no cast; M1-T7 comment documents both the tuple shape and anti-enumeration.

## [HIGH] correctness — sdk/src/tools/check-job.ts — [ALREADY-RESOLVED][M2-T4] check_job deadline math hardened (non-finite treated as omitted, 600s cap)
- **Risk:** was: NaN deadline, infinite hot-spin
- **Fix:** none — confirmed fixed (M2-T4 Fix 1)
- **Evidence:** sdk/src/tools/check-job.ts:219-250 resolveCheckJobWaitBounds with Number.isFinite guard (M2-T4 Fix 1 comment); 600s cap; tests in sdk/src/__tests__/check-job.test.ts:1341-1388 pin NaN/negative/oversized behavior.

## [HIGH] state-mutation — sdk/src/tools/background-jobs.ts — [ALREADY-RESOLVED][M2-T4] Recovered-job liveness re-check settles lost jobs on observation
- **Risk:** was: recovered job reads running forever
- **Fix:** none — confirmed fixed (M2-T4 Fix 2)
- **Evidence:** sdk/src/tools/background-jobs.ts:541-568 recheckRecoveredJobLiveness (isProcessAlive + /proc starttime pid-reuse guard, final flushJobLineCarry drain, settle 'lost'); invoked from check-job.ts:426-432 in the poll loop; test sdk/src/__tests__/check-job.test.ts:1391-1441.

## [HIGH] correctness — sdk/src/tools/background-jobs.ts — [ALREADY-RESOLVED][M2-T4] kill folds 'stopping' on delivery; SIGKILL escalation implemented
- **Risk:** was: leaked process + false terminal receipt
- **Fix:** none — confirmed fixed (M2-T4 Fix 3)
- **Evidence:** background-jobs.ts BackgroundJobStatus includes 'stopping' (27-36); killEscalationTimer field; scheduleKillEscalation (KILL_ESCALATION_DELAY_MS=5000, 1186-1230) SIGKILL-escalates and settles 'stopped' for recovered jobs; tests sdk/src/__tests__/kill-job.test.ts:83-135 assert stopping-until-exit.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/check-job.ts — [ALREADY-RESOLVED][M2-T4] check_job forwards the turn AbortSignal into the SDK follow loop
- **Risk:** was: in-flight follow leaked past turn abort
- **Fix:** none — confirmed fixed (M2-T4 Fix 4)
- **Evidence:** check-job.ts handleCheckJob destructures signal and injects it into the forwarded client tool call with M2-T4 Fix 4 comment; checkJob takes signal; jobRegistry.wait called with signal (check-job.ts:634-637).

## [MEDIUM] correctness — sdk/src/tools/check-job.ts — [ESCALATED] wait_for match window is per-call (collected starts empty each invocation)
- **Risk:** needle split across two polls never matches; follow mode burns timeout and can kill_on_timeout a healthy job
- **Fix:** File sdk/src/tools/background-jobs.ts: persist a bounded match window on the adapter (like lastCheckCursor, e.g. adapter.matchWindowState via appendBoundedCollected) and initialize `collected` from it in checkJob; or update common/src/tools/params/tool/check-job.ts wait_for description to state per-call matching explicitly. Test: sdk/src/__tests__/check-job.test.ts — needle spanning two sequential checkJob calls matches on the second.
- **Evidence:** sdk/src/tools/check-job.ts:494-495 matchWindow = collected + chunk + peekJobLineCarry(job); collected re-initialized per invocation; line-carry is peeked (not persisted) and folds only within one call.

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts — [ESCALATED] Kind confusion: check_background_agent accepts process jobs, check_job rejects bg-agent ids as bare not-found
- **Risk:** check_background_agent burns its timeout on shell jobs; check_job reports a list_jobs-displayed bg-agent id as bare not-found; model ping-pongs between broken-looking tools
- **Fix:** File sdk/src/tools/background-jobs.ts (getBackgroundJob) + packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts: add kind gate — check_job returns a routing error for agent-kind ids ('job X is an agent job — use check_background_agent'), check_background_agent returns a routing error for process-kind ids; include `kind` in both result payloads. Test: sdk/src/__tests__/check-job.test.ts with an agent-kind id, and background-agent-jobs.test.ts with a process-kind id.
- **Evidence:** check-background-agent.ts assertBackgroundAgentJobOwned has no kind gate; eventToSearchString returns '' for non-agent_chunk payloads; background-jobs.ts:193 JOB_ID_PATTERN rejects bg-agent-* ids.

## [MEDIUM] correctness — packages/agent-runtime/src/util/background-agent-jobs.ts — [ESCALATED] Chunk sequence numbers re-derived from buffer length desynchronize on eviction divergence
- **Risk:** droppedChunks misreport, skipped/duplicated chunks when view ring and registry buffer diverge
- **Fix:** File packages/agent-runtime/src/util/background-agent-jobs.ts (currentChunks): stamp the absolute sequence at append time (sequence already computed by appendBackgroundAgentChunk) and read it from the core event payload rather than re-deriving from buffer length; alternatively record firstSequence on the view when buffering starts. Test: packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts — evict core events, assert chunk sequences stay monotonic and droppedChunks is not inflated.
- **Evidence:** background-agent-jobs.ts:210-228 currentChunks derives firstSequence = job.nextSequence - chunkEvents.length from whatever the core ring still holds; appendBackgroundAgentChunk (527-566) evicts view chunks and core events independently; registry.emit is a silent no-op for unknown jobs.

## [MEDIUM] error-handling — sdk/src/job-update-forwarder.ts — [ESCALATED] job_update forwarding fires handleEvent with void — rejecting handler = unhandled rejection, no backpressure
- **Risk:** a rejecting async host handler becomes an unhandled rejection; slow host accumulates unbounded pending promises (memory + reordering)
- **Fix:** File sdk/src/job-update-forwarder.ts: wrap in Promise.resolve(handleEvent(ev)).catch(...) with a dropped-update counter, and bound the forward queue with a documented drop policy; surface dropped counts as a status event. Test: sdk/src/__tests__/run-job-updates.test.ts — rejecting handleEvent does not produce an unhandled rejection and increments the drop counter.
- **Evidence:** job-update-forwarder.ts:99 `void handleEvent({...})` with no await/catch and no queue bound; listener runs on every registry emit via subscribeAll.

## [MEDIUM] error-handling — common/src/util/job-registry.ts — [ESCALATED] assertOwned/ownedBy dereference owner fields with zero validation
- **Risk:** one stripped-owner hop makes every job tool throw a TypeError instead of returning not-found
- **Fix:** File common/src/util/job-registry.ts (ownedBy): return false when either side lacks string clientSessionId/rootRunId (fail closed). Add a handler-boundary owner validation in sdk/src/tools/{check-job,kill-job,list-jobs}.ts (reuse isBackgroundJobOwner from background-jobs.ts:1104) returning the generic not-found payload for a malformed owner. Test: sdk/src/__tests__/check-job.test.ts — missing owner yields not-found, not TypeError.
- **Evidence:** job-registry.ts:511-521 assertOwned -> ownedBy (780-786) reads job.owner.clientSessionId/rootRunId directly with no guard; sdk/src/run.ts clientToolCallSchema strips unknown keys so params.owner can arrive undefined.

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts — [ESCALATED] Log-quota truncation does not rebase job.readOffset
- **Risk:** post-truncation drains skip or duplicate output; recovered sessions inherit a wrong persisted offset
- **Fix:** File sdk/src/tools/background-jobs.ts: after truncateLogToTail, adjust job.readOffset = Math.max(0, job.readOffset - keepStart) at both call sites (quota monitor + exit path) and persist via writeBackgroundJobMetadata. Test: sdk/src/__tests__/check-job.test.ts — oversize log triggers truncation; assert post-truncation drain returns the tail text exactly once with no duplicate/skip.
- **Evidence:** background-jobs.ts:302-331 truncateLogToTail keeps tail without touching job.readOffset; called from the 250ms quota monitor (792-816) and exit path (846-855); readNewJobOutput (1346-1386) reads at job.readOffset and persists it.

## [MEDIUM] api-contract — common/src/tools/params/tool/list-jobs.ts — [ESCALATED] list_jobs rows emit lastSummary, which the outputSchema does not declare
- **Risk:** advertised agent progress hint stripped by any schema-faithful round trip; strict consumers reject the payload
- **Fix:** File common/src/tools/params/tool/list-jobs.ts: add `lastSummary: z.string().max(160).optional()` to the jobs element schema (mirroring LIST_JOBS_LAST_SUMMARY_MAX_CHARS). Test: sdk/src/__tests__/list-jobs.test.ts — parse an agent-row payload through the outputSchema and assert lastSummary survives.
- **Evidence:** list-jobs-view.ts ListJobsViewRow declares lastSummary?: string; sdk/src/tools/list-jobs.ts sets row.lastSummary for agent rows; common/src/tools/params/tool/list-jobs.ts jobs element schema has no lastSummary key (verified: zero matches).

## [MEDIUM] test-coverage — sdk/src/__tests__/check-job.test.ts — [ESCALATED] No boundary contract test validating job-tool handler output against jsonToolResultSchema tuple
- **Risk:** shape regressions survive green suites
- **Fix:** File sdk/src/__tests__/check-job.test.ts (or new boundary-contract.test.ts): iterate the four handlers, validate each returned output against its jsonToolResultSchema tuple (import from @codebuff/common). Remaining untested failure mode: wait_for needle split across two calls (see check-job window entry).
- **Evidence:** Handler tests unwrap results structurally; no test references jsonToolResultSchema/outputSchema validation. Individual failure modes ARE now covered (stopping/escalation: kill-job.test.ts:83-135; liveness: check-job.test.ts:1391-1441; NaN bounds: 1341-1388).

## [LOW] api-contract — common/src/util/job-registry.ts — [ESCALATED] lifecycle result stamped only when !== undefined
- **Risk:** cannot distinguish 'completed with no value' from 'not yet stamped / lost to eviction'
- **Fix:** File common/src/util/job-registry.ts: add `resultSettled?: boolean` to Job, set true on every terminal transition in appendEvent; have check-background-agent include `result: null` (or an explicit no-result marker) when state==='completed' && resultSettled && resultValue===undefined. Test: common/src/util/__tests__/job-registry.test.ts — lifecycle(completed) with result undefined stamps resultSettled; background-agent-jobs.test.ts — completed-with-no-value is distinguishable.
- **Evidence:** job-registry.ts:820-830 terminal stamping: `record.job.result = payload.result` only `if (payload.result !== undefined)`.

## [LOW] error-handling — sdk/src/tools/background-jobs.ts — [ESCALATED] readNewJobOutput swallows every fs/decoder error and returns ''
- **Risk:** silent output loss is indistinguishable from an idle job
- **Fix:** File sdk/src/tools/background-jobs.ts: make readNewJobOutput return {text, degraded} (or set job.outputDegraded) on catch; propagate a `degraded: true` field into the check_job/read_logs payload. Test: sdk/src/__tests__/check-job.test.ts — unreadable log file yields degraded:true with empty events.
- **Evidence:** background-jobs.ts readNewJobOutput: `if ('errorMessage' in opened) return ''` and bare catch returning '' around the read block; no degraded signal in the check_job payload.

## [LOW] performance — sdk/src/tools/list-jobs.ts — [ESCALATED] list_jobs runs up to three full ring-buffer scans per row
- **Risk:** tens of thousands of event visits per digest call on the model's polling path
- **Fix:** File sdk/src/tools/list-jobs.ts: compute `const snap0 = jobRegistry.snapshot(entry.jobId, 0)` once per row and reuse it for both the summary fallback and the terminal tail fallback. Test: sdk/src/__tests__/list-jobs.test.ts — assert (e.g. via a spied snapshot) at most 2 snapshot calls per row.
- **Evidence:** list-jobs.ts:87 single cursor snapshot; summary fallback snapshot(entry.jobId, 0) (~131) and terminal tail fallback snapshot(entry.jobId, 0) (~145) remain two additional full scans per row.

## [LOW] dependency-hygiene — sdk/src/tools/kill-job.ts — [ESCALATED] Cross-package relative type import alongside @codebuff/common value imports
- **Risk:** a future value import via the relative path would load a second common module instance, breaking the jobRegistry singleton identity
- **Fix:** File sdk/src/tools/{kill-job,list-jobs,check-job}.ts: change the relative type import to `@codebuff/common/tools/list`; optionally add an ESLint import rule (no-restricted-imports pattern '../../../common/**') in sdk. Test: typecheck-only — bun run typecheck after the change.
- **Evidence:** sdk/src/tools/kill-job.ts:8 imports CodebuffToolOutput from '../../../common/src/tools/list' (type-only) while jobRegistry comes from '@codebuff/common/util/job-registry'; same dual-specifier pattern in list-jobs.ts:22 and check-job.ts.

## [LOW] correctness — sdk/src/tools/check-job.ts — [SUMMARY] shard-jobs-ipc dispositions: ALREADY-RESOLVED 5, ESCALATED 13, ACCEPTED 0, FIXED 0
- **Risk:** none
- **Fix:** See per-finding entries.
- **Evidence:** SUMMARY: shard-jobs-ipc had 18 findings: ALREADY-RESOLVED 5, ESCALATED 13, ACCEPTED 0, FIXED 0. All 18 verified live; no stale audit entries.

## Coverage receipt

### Subsystems
- sdk
- packages/agent-runtime
- common

### Features
- background-process-jobs
- background-agent-jobs
- check-job-poll-follow
- check-background-agent-poll-follow
- job-digest-listing
- kill-job
- job-update-streaming-ipc
- job-registry-core

### Files
- packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts
- packages/agent-runtime/src/tools/handlers/tool/check-job.ts
- sdk/src/tools/check-job.ts
- sdk/src/tools/kill-job.ts
- sdk/src/tools/list-jobs.ts
- sdk/src/tools/background-jobs.ts
- sdk/src/job-update-forwarder.ts
- common/src/util/job-registry.ts
- common/src/util/list-jobs-view.ts
- common/src/tools/params/tool/list-jobs.ts
- common/src/tools/params/tool/check-job.ts

### Domains
- correctness
- state-mutation
- security
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
