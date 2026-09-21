# Audit findings: shard-jobs

- Subsystems: sdk-job-tools, sdk-job-adapter, sdk-run-dispatch, job-registry-core, list-jobs-view, job-update-forwarder, runtime-job-handlers, runtime-background-agent-adapter, runtime-end-turn-spawn
- Features: check_job, check_background_agent, list_jobs, kill_job, read_logs, background-run-terminal-command, spawn_agents-background, end_turn-pending-jobs, job-update-forwarding, job-registry-lifecycle, cursor-continuity, cross-session-recovery, list-jobs-digest-gate
- Files covered: 22
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [HIGH] security — sdk/src/run.ts:1928 — SDK end_turn lists ALL running jobs process-wide with no owner scoping (cross-session leak)
- **Risk:** The SDK-side end_turn branch calls jobRegistry.listRunning() with no owner filter and only filters kind === 'process'. Because the registry is a process-wide singleton, any concurrent run/session in the same process (web server hosting multiple runs, parallel SDK runs) leaks other sessions' jobIds, full command lines (which may embed secrets/tokens in env-prefixed commands) and start times into this run's end_turn output. It is also inconsistent with the runtime handler (end-turn.ts), which correctly fails closed and scopes by (clientSessionId, rootRunId) and additionally covers agent jobs, which this branch omits entirely.
- **Fix:** Resolve the trusted owner exactly as the runtime handler does (resolveRuntimeJobOwner from session state, fail closed to a plain 'Turn ended.' when absent) and pass it to jobRegistry.listRunning(owner). Better: delete the SDK-side duplicate and let the runtime's scoped handleEndTurn own this output.
- **Evidence:** run.ts lines 1927-1949: `const runningJobs = jobRegistry.listRunning().filter((job) => job.kind === 'process')` — no owner argument, no session scoping; contrast end-turn.ts lines 44-53 which pass the resolved owner and fail closed when absent.

## [HIGH] correctness — sdk/src/run.ts:732 — Job ownership is keyed on a per-run() random promptId, so jobs become unmanageable (foreign) in every later run of the same session
- **Risk:** promptId is regenerated on every run() call, and clientSessionId: promptId is half of the registry's ownership key. A shell job or background agent spawned in turn N is stamped with turn N's promptId; in turn N+1 the trusted owner has a new promptId, so jobRegistry.assertOwned returns 'foreign' and check_job / kill_job / read_logs(jobId) all return the generic 'No background job found' error. The disk-recovery restamp path only upgrades UNKNOWN_JOB_OWNER records, never a real previous owner, so it does not help. Meanwhile the end_turn output explicitly tells the agent to 'Use check_job/read_logs/kill_job to manage them' — advice that fails on the next turn. The flagship dev-server workflow (start in one prompt, check in the next) is broken at the ownership layer, which is very plausibly why check_job is reported broken in practice.
- **Fix:** Derive clientSessionId from a stable per-CLI-session identity (the harness session id) instead of the per-run promptId, or have the SDK dispatch path treat a matching rootRunId plus a process-local session attestation as sufficient and restamp the record's clientSessionId to the current run on first successful owned contact (registry-side, never model-controlled).
- **Evidence:** run.ts line 732 `const promptId = Math.random().toString(36).substring(2, 15)`; lines 795-802 build trustedJobOwner with clientSessionId: promptId; line 1380 passes clientSessionId: promptId into callMainPrompt; background-jobs.ts resolveRestampedOwner upgrades only isUnknownJobOwner(currentOwner).

## [HIGH] error-handling — sdk/src/job-update-forwarder.ts:96 — createJobUpdateForwarder discards handleEvent rejections via `void`, creating unhandled-rejection crash risk and silently dropped job_update events
- **Risk:** handleEvent is invoked as `void handleEvent({...})`. In run.ts the injected handleEvent is an async host callback (webhook/socket write) whose rejection is now an unhandled promise rejection — which terminates the Node process under default settings. A single transient host-callback failure during a chatty job's output stream can therefore crash the whole CLI/host, and the failure is invisible (no log, no counter). Note the registry's subscribeAll contract isolates only synchronous listener throws; the async rejection escapes it.
- **Fix:** Use `Promise.resolve(handleEvent(event)).catch(() => {})` (optionally counting/ logging drop), or queue events onto the run's existing serialized callbackQueue so rejections are observed and ordering is preserved.
- **Evidence:** job-update-forwarder.ts lines 96-105: `void handleEvent({ type: 'job_update', ... })` — no .catch, no await; notifyAllSubscribers in job-registry.ts wraps only synchronous throws.

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts:1195 — kill_job reports killed:true / status 'stopped' on signal delivery, with no SIGKILL escalation or liveness verification
- **Risk:** killBackgroundJob settles the job 'stopped' synchronously when terminateProcessTree returns true, but 'true' only means the signal was delivered, not that the process died. A SIGTERM-resistant child (common: nvim-watching dev servers, trap handlers, grandchildren that escaped the group on Windows where group signaling is skipped) keeps running while the registry and list_jobs forever report status 'stopped'. There is no SIGKILL escalation and no post-kill liveness verification, and the runtime handler's comment claims 'SIGTERM with SIGKILL escalation' that does not exist anywhere in the implementation.
- **Fix:** After SIGTERM, wait a bounded grace period (e.g. 2-5s) for exit and verify with isProcessTreeAlive, then escalate to SIGKILL and only then settle 'stopped'; if the process is still alive after SIGKILL, report an explicit error instead of 'stopped'.
- **Evidence:** background-jobs.ts killBackgroundJob: `killed = terminateProcessTree(job.child, signal)` then immediately `settleBackgroundJob(job, 'stopped', job.exitCode)`; terminateProcessTree (lines 36-53) returns the bare result of kill()/child.kill(signal).

## [MEDIUM] performance — sdk/src/tools/list-jobs.ts:17 — list_jobs process tail lines have no per-line char bound, so one huge output line floods the digest
- **Risk:** extractTailLines splits buffered output events on newlines and pushes whole lines with no per-line character cap (only the line count is capped at 10). A process job that prints one giant line (progress bars, minified bundles, base64 blobs — up to the 10MB log quota / 256KB registry byte bound per event) puts up to 10 lines of that size directly into row.tail of the list_jobs digest, blowing the context budget the digest is designed to protect and degrading every list_jobs call.
- **Fix:** Cap each retained line (e.g. last 2000 chars) in extractTailLines, mirroring extractAgentTailLines; the registry's 256KB output bound does not help because the cap is per-line, not per-row.
- **Evidence:** list-jobs.ts lines 17-27 push unbounded `line` values; contrast common/src/util/list-jobs-view.ts extractAgentTailLines lines 195-197 which slice to the last 20k chars.

## [MEDIUM] state-mutation — sdk/src/run.ts:2285 — SDK check_job follow loop ignores the run AbortSignal — an aborted run's follow blocks up to 600s
- **Risk:** The SDK dispatch passes `signal` to run_terminal_command, git_status and others, but checkJob accepts no signal and its follow loop (registry.wait with timeoutMs, capped at 200ms per iteration, up to timeout_seconds=600) ignores run abort entirely. An aborted or timed-out run keeps the check_job tool call alive for up to 10 minutes, delaying cancellation cleanup and keeping the process busy. The runtime's check_background_agent by contrast threads `signal` into waitForBackgroundAgentJob and settles on abort.
- **Fix:** Add an optional signal to checkJob, pass the run signal at the dispatch site, and register an abort listener that settles the loop immediately (the registry's wait() already supports signal and detaches its listener on settle).
- **Evidence:** run.ts lines 2285-2290 call checkJob with no signal argument; checkJob's params type has no signal; the follow loop's only exits are matched/finished/deadline.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts:51 — check_background_agent wait_for with explicit timeout_seconds=0 follows for 30s, contradicting the schema's '0 = poll immediately' contract
- **Risk:** resolveCheckBackgroundAgentWaitBounds treats wait_for with timeout_seconds=0 (the schema default) as follow mode with a 30s default deadline. The tool's published input schema states '0 (default) returns immediately with whatever new chunks exist (poll mode)'. A model that follows the schema blocks its turn for 30 seconds instead of getting an immediate poll — a silent contract violation that produces tight retry loops and wasted turns, and exactly the kind of mismatch that makes polling tools feel broken in real runs.
- **Fix:** Either make the schema description match the implementation ('wait_for without timeout_seconds follows for up to 30s') or treat an explicit timeout_seconds=0 as poll mode and reserve the 30s default for an omitted field (distinguish undefined from 0 in resolveCheckBackgroundAgentWaitBounds).
- **Evidence:** check-background-agent.ts lines 51-75 follow/timeoutMs resolution vs common/src/tools/params/tool/check-background-agent.ts lines 31-36 '0 (default) returns immediately with whatever new chunks exist (poll mode)'.

## [MEDIUM] correctness — sdk/src/tools/list-jobs.ts:96 — list_jobs computes agent-job pending from cursor 0, so consumed background agents always report unread output
- **Risk:** For agent-kind rows the cursor falls back to 0 because only process adapters expose lastCheckCursor, so `pending` counts every retained agent_chunk since job start regardless of what check_background_agent already delivered. A fully-consumed background agent (or a terminal one) permanently advertises pending '<10'/more, misleading the model into re-polling a job it already read to the end, and making the digest row lie about unread work.
- **Fix:** Track a per-job consumer cursor for agent jobs too (the adapter's consumerCursors already has this data — surface a default consumer key or expose the minimum across consumers), so pending reflects genuinely unread chunks.
- **Evidence:** list-jobs.ts lines 96-105: `const cursor = adapter?.lastCheckCursor ?? 0` then `bucketPendingLines(countPendingOutputLines({ eventsAfterCursor: snap?.events ?? [], lineCarry }))` with comment 'agent jobs have no process adapter (miss → cursor 0)'.

## [LOW] correctness — sdk/src/tools/check-job.ts:341 — check_job advances nextCursor past events silently dropped by the 50KB presentation cap, making them unrecoverable via the cursor
- **Risk:** buildCheckJobPollResult re-snapshots the full [entryCursor, nextCursor) window and then applies boundEventsToOutputTail with a 50k-char cap. When events fall off the head (remaining budget exhausted), they are removed from the returned payload while nextCursor is still advanced past them, and lastCheckCursor is set to that nextCursor. A consumer that honors nextCursor can never refetch the dropped output through check_job (only by re-reading logFile with read_logs). The `truncated` flag documents the loss but the cursor-continuity guarantee — the core invariant a job poller must provide — is broken on the truncation path.
- **Fix:** Advance lastCheckCursor only through the sequence of the last event actually returned (or keep a bounded per-job replay window so a truncated poll can be refetched), so `truncated: true` always comes with a usable recovery cursor.
- **Evidence:** check-job.ts buildCheckJobPollResult lines 341-360: finalSnapshot taken from entryCursor, then `nextCursor = finalSnapshot?.nextCursor` after boundEventsToOutputTail may have dropped/sliced events, with `job.lastCheckCursor = nextCursor`.

## [LOW] state-mutation — sdk/src/tools/background-jobs.ts:505 — Background job metadata writes are non-atomic (O_TRUNC in place); a crash mid-write permanently destroys cross-session recovery
- **Risk:** safeWriteJobMetadata rewrites the metadata JSON in place with O_TRUNC and a single writeSync. A crash or power loss mid-write leaves truncated JSON; recoverBackgroundJob then JSON.parse-fails and returns undefined, so the job is unrecoverable exactly when recovery matters (after a crash). The codebase already has an atomic JSON writer (WorkspaceMutationBroker.writeJsonDurable) that is not reused here.
- **Fix:** Write metadata via temp-file + rename (the repo already has writeJsonDurable / writeJsonAtomic in sdk services — reuse them), keeping O_NOFOLLOW on the final path.
- **Evidence:** background-jobs.ts safeWriteJobMetadata lines 505-528: `fs.constants.O_WRONLY | fs.constants.O_TRUNC` then a single fs.writeSync; recoveryBackgroundJob returns undefined on JSON.parse failure (background-jobs.ts recoverBackgroundJob catch).

## [LOW] state-mutation — sdk/src/tools/background-jobs.ts:900 — Recovered running jobs lose the log-quota drainer and monitor entirely — an unkillable/recovered job's log grows unbounded
- **Risk:** A job recovered from disk while its process is still alive has hasLiveDrainer undefined, so its log is only drained when check_job polls. Nothing re-applies the 10MB log-quota monitor or the periodic metadata readOffset persistence: a recovered runaway job's log grows without bound on disk, and a recovered running job that is never polled never persists readOffset, so repeated crashes re-read the whole log. The live-spawn path enforces both; the recovery path silently drops the guarantees.
- **Fix:** On recovery of a running job, attach the same 250ms drainer+quota monitor (or drain on a shared timer) so quota enforcement and cursor persistence survive restarts.
- **Evidence:** background-jobs.ts recoverBackgroundJob returns `{ ..., decoder: new StringDecoder('utf8'), ... }` with no hasLiveDrainer and no interval; check-job.ts comment 'Recovered and test-registered jobs leave this undefined and keep draining via check_job's readNewJobOutput'.

## [LOW] error-handling — sdk/src/tools/read-logs.ts:270 — readTail propagates raw fs.readSync exceptions out of read_logs instead of returning an error-shaped output
- **Risk:** readTail opens the fd safely, but the read loop's fs.readSync calls run inside try/finally with no catch: a transient I/O error (EIO on a removed tmpfs file, stalled NFS) throws out of readLogs for both the jobId and path branches, surfacing as a generic tool failure instead of the structured errorMessage shape every other failure path returns. The loop also re-reads from a size captured at open, so a truncated-during-scan file reads zeros rather than erroring.
- **Fix:** Wrap the read loop body and translate throw into { errorMessage: ... } consistent with the safeOpenJobLogForRead failure shape already returned by the function.
- **Evidence:** read-logs.ts lines 243-310: `const buf = Buffer.alloc(length); fs.readSync(fd, buf, 0, length, offset)` with `try { ... } finally { fs.closeSync(fd) }` and no catch converting to { errorMessage }.

## [LOW] state-mutation — packages/agent-runtime/src/util/background-agent-jobs.ts:745 — MAX_CONSUMER_CURSORS eviction can evict a steady poller's cursor because Map re-set does not refresh insertion order
- **Risk:** setConsumerCursor evicts the oldest-inserted key when the map exceeds 32 entries, but because re-setting an existing key does NOT refresh Map insertion order, a steady poller that registered early is still 'oldest' and can be evicted by 32 one-off consumers (e.g. successive list_jobs-derived probes or short-lived pollers). Losing the active consumer's cursor silently replays the retained buffer on its next cursorless poll and flips truncated to true.
- **Fix:** Delete-then-set on every cursor write to refresh insertion order, or use an LRU (common/src/util/lru-cache.ts exists) so the actively-polling consumer can never be the eviction victim.
- **Evidence:** background-agent-jobs.ts lines 745-762: `job.consumerCursors.set(consumerId, nextCursor); if (job.consumerCursors.size > MAX_CONSUMER_CURSORS) { const oldest = job.consumerCursors.keys().next().value ... }` — re-set does not refresh order.

## [LOW] error-handling — common/src/util/job-registry.ts:1010 — A throwing wait() predicate propagates out of registry emit paths and can break the append pipeline
- **Risk:** notifyWaiters invokes waiter.predicate(event) with no try/catch, inside appendEvent. check_background_agent builds its predicate from eventToSearchString (JSON.stringify in try/catch, safe), but any future caller-supplied predicate that throws turns every emit for that job into a thrown error — for the process-job path this surfaces inside readNewJobOutput's catch (swallowed, output silently stops being mirrored), for agent chunk appends it can reject the spawn path. One bad listener type breaks emit for all waiters of the job.
- **Fix:** Wrap each waiter predicate call in try/catch (treat throw as no-match), matching the isolation already applied to subscribeAll listeners.
- **Evidence:** job-registry.ts notifyWaiters lines ~1010-1025: `(terminal || (waiter.predicate?.(event) ?? false))` — a throwing predicate aborts notifyWaiters mid-iteration; appendEvent has no try around the notification block.

## [LOW] correctness — common/src/util/job-registry.ts:213 — Registry byte bound measures UTF-16 chars while the adapter byte caps measure UTF-8 bytes — bounds diverge up to 4x
- **Risk:** The registry's 256KB output-byte bound is computed with JS string .length (UTF-16 code units) while the agent adapter enforces its per-chunk cap with Buffer byte length. CJK/emoji-heavy output undercounts by up to ~3x, so a chatty multibyte job can hold ~3x the intended memory per job. Harmless for correctness of cursors, but the bound documented as protecting the runtime is loose by a variable factor.
- **Fix:** Standardize on Buffer.byteLength(Buffer.from(serialized)) or a cheap UTF-8 estimate in payloadByteSize so both bounds measure the same quantity.
- **Evidence:** job-registry.ts payloadByteSize lines ~213-222 uses `.length`; background-agent-jobs.ts appendBackgroundAgentChunk uses Buffer.byteLength for its 64KB cap.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/check-job.ts:49 — Trusted-owner injection rides through the client-tool input envelope via unchecked casts — a version-skewed runtime/SDK pair silently bricks all job tools
- **Risk:** The runtime stamps a trusted `owner` into ProcessJobClientToolCall and forwards it with `as unknown as ClientToolCall<ToolName>`, while the published tool schemas deliberately omit any owner field. The cross-package contract (runtime input shape -> SDK dispatch expectation) is enforced nowhere in the type system: an SDK/runtime version skew (older SDK ignoring or rejecting the injected owner, or a renamed field) degrades silently to every job tool returning not_found rather than a loud contract error. The double casts at each handler also suppress any future schema drift detection.
- **Fix:** Move the trusted owner out of the tool-input envelope into an explicit side-channel parameter of requestClientToolCall (e.g. a trustedContext argument), eliminating the cast and making the version-skew visible in types.
- **Evidence:** check-job.ts lines 49-55 build ProcessJobClientToolCall with owner and cast `clientToolCall as unknown as ClientToolCall<ToolName>`; published schema in common/src/tools/params/tool/check-job.ts exposes no owner field.

## [LOW] security — sdk/src/tools/background-jobs.ts:900 — Ownerless jobs are invisible to update forwarding and claimable by any trusted session (documented first-claimer takeover)
- **Risk:** resolveRestampedOwner intentionally lets the first trusted caller claim an ownerless job (disk metadata without a real owner). All normal SDK spawns are stamped with a real owner, so the window is narrow (direct CLI/test spawns), but the same mechanism means a restarted session that finds ownerless metadata takes over a job it did not spawn. Separately, the job-update forwarder hard-skips UNKNOWN_JOB_OWNER jobs, so ownerless jobs run completely invisibly to the host UI — no job_update events at all — while still being listed by end_turn's (currently unscoped) path.
- **Fix:** Record the spawning session identity immutably at create time (even for ownerless spawns) and restrict first-claim restamping to same-OS-user + spawn-time proximity, and/or emit an anonymized job_update skeleton for ownerless jobs so hosts can see unknown-activity instead of silence.
- **Evidence:** background-jobs.ts resolveRestampedOwner comment 'any trusted session may claim an ownerless job'; job-update-forwarder.ts lines 37-42 skip UNKNOWN_JOB_OWNER jobs entirely.

## [MEDIUM] test-coverage — sdk/src/__tests__/check-job.test.ts:1 — No tests for cross-run ownership handoff, forwarder rejection handling, unscoped SDK end_turn, kill escalation, or abort during follow
- **Risk:** The suite covers the happy paths well (poll/follow/cursors/loop-breakers are genuinely well tested), but the failure modes most likely to make the system 'feel broken in practice' are untested: (1) a second run() with a fresh promptId polling a job from the first run (the cross-turn scoping break); (2) handleEvent rejecting inside createJobUpdateForwarder (unhandled rejection); (3) the SDK-side end_turn branch listing other sessions' jobs; (4) SIGTERM-resistant child surviving kill_job; (5) run abort during a check_job follow; (6) a 1MB single-line job flooding list_jobs tail. All of the HIGH/MEDIUM findings above would have been caught by these tests.
- **Fix:** Add: (1) a two-run() ownership test; (2) a rejecting-handleEvent forwarder test asserting no unhandled rejection; (3) an owner-injection assertion on the SDK end_turn branch; (4) a SIGTERM-ignoring fixture asserting escalation; (5) an abort-signal test for checkJob follow.
- **Evidence:** Test inventory from referencedBy + file reads: sdk/src/__tests__/{check-job,list-jobs,kill-job,read-logs,run-job-updates,run-list-jobs-gate}.test.ts, packages/agent-runtime/src/__tests__/{background-agent-jobs,end-turn-pending-jobs}.test.ts, tools/handlers/tool/__tests__/{check-job,list-jobs,kill-job,read-logs}.test.ts, common/src/util/__tests__/{job-registry,list-jobs-view}.test.ts — none cover the cross-run or failure-injection paths above.

## Coverage receipt

### Subsystems
- sdk-job-tools
- sdk-job-adapter
- sdk-run-dispatch
- job-registry-core
- list-jobs-view
- job-update-forwarder
- runtime-job-handlers
- runtime-background-agent-adapter
- runtime-end-turn-spawn

### Features
- check_job
- check_background_agent
- list_jobs
- kill_job
- read_logs
- background-run-terminal-command
- spawn_agents-background
- end_turn-pending-jobs
- job-update-forwarding
- job-registry-lifecycle
- cursor-continuity
- cross-session-recovery
- list-jobs-digest-gate

### Files
- sdk/src/tools/background-jobs.ts
- sdk/src/tools/check-job.ts
- sdk/src/tools/list-jobs.ts
- sdk/src/tools/kill-job.ts
- sdk/src/tools/read-logs.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/job-update-forwarder.ts
- sdk/src/run.ts
- common/src/util/job-registry.ts
- common/src/util/list-jobs-view.ts
- common/src/tools/params/tool/check-job.ts
- common/src/tools/params/tool/check-background-agent.ts
- common/src/tools/params/tool/list-jobs.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/util/runtime-job-owner.ts
- packages/agent-runtime/src/tools/handlers/tool/check-job.ts
- packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts
- packages/agent-runtime/src/tools/handlers/tool/kill-job.ts
- packages/agent-runtime/src/tools/handlers/tool/list-jobs.ts
- packages/agent-runtime/src/tools/handlers/tool/read-logs.ts
- packages/agent-runtime/src/tools/handlers/tool/end-turn.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
