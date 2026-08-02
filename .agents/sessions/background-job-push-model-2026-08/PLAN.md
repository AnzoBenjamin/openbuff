# Background Job Push Model & Drain Inversion — PLAN

<!-- current-task: M1 fix truncated/dropped predicate + bound returned events -->

Status legend: `[ ]` pending, `[~]` in_progress, `[x]` done, `[/]` cancelled, `[!]` blocked.

Ordering is strict: M2 depends on M1 landing; M3 depends on M2 (the poll loop
exists ONLY to drain, so it cannot be removed until draining is inverted); M4
depends on M3 (the digest's pending-lines bucket is only meaningful once output
enters the registry on write).

## Milestones

### M1 — Independent registry/bounding bugs (no design risk)
- [ ] M1-T1 Fix `truncatedAtCursor` in `common/src/util/job-registry.ts` to signal a real gap.
- [ ] M1-T2 Bound `check_job` returned `events` by an explicit ceiling in `sdk/src/tools/check-job.ts`.
- [ ] M1-T3 Validate: `common` + `sdk` typecheck; job-registry + check-job suites.

### M2 — Invert the drain (write-time, per-line events)
- [ ] M2-T1 Switch `startBackgroundJob` live path to a pipe + in-process line splitter teeing to BOTH the log file and `emitJobOutput` per line with write-time timestamps.
- [ ] M2-T2 Keep `readNewJobOutput`/file-read strictly as the cross-session RECOVERY fallback.
- [ ] M2-T3 Validate: `sdk` background-job suites (rework the readNewJobOutput assertions that lock in blob semantics).

### M3 — Replace poll loop with jobRegistry.wait()
- [ ] M3-T1 Delete checkJob's `while(true){drain;snapshot;sleep(200)}` loop; delegate follow mode to `jobRegistry.wait({predicate,timeoutMs,cursor})`.
- [ ] M3-T2 Preserve external contract: poll vs follow, matched latch, kill_on_timeout, full-window events.
- [ ] M3-T3 Validate: check-job suite + agent-runtime check-job handler.

### M4 — Pushed status digest + list_jobs pending signal
- [ ] M4-T1 Add a change-gated background-job digest to the base2 per-step observation (same rail/TTL as git_status), declarative, bounded, fixed no-action line, settlement tombstone.
- [ ] M4-T2 Add bucketed pending-output + gap signal to `list_jobs`.
- [ ] M4-T3 Validate: agents/base2 + agent-runtime suites; add regression tests (omit-when-unchanged, force-on-first-step/after-compaction/unacked-settlement, no-action-line contract, MEASURED token ceiling).

### M5 — Final validation & review
- [ ] M5-T1 Cross-package typecheck.
- [ ] M5-T2 Live end-to-end background-job smoke (dev-server-style job: start → accrue without polling → wait_for → settle → digest surfaces settlement once).
- [ ] M5-T3 Address automated reviewer gate blockers.

## DESIGN (authoritative)

### M1 — the two bugs
`truncatedAtCursor(record, cursor)` currently:
```ts
const first = record.events[0]
return first !== undefined && first.sequence <= cursor
```
This is true for a healthy buffer whose oldest retained event predates the
cursor — i.e. the normal case. It must instead track the highest evicted
sequence and report a gap only when the consumer's cursor is BELOW the oldest
still-retained event AND events were actually dropped past it. Concretely: a
gap exists when `dropped > 0` and the oldest retained event's sequence is
`> cursor + 1` (an unread event was evicted). Preferred implementation: record
`highestEvictedSequence` on the JobRecord (updated in `evictOverflow`) and
return `cursor < highestEvictedSequence`.

`check_job` events bound: after building `finalSnapshot.events`, cap the
returned array by total bytes (reuse `CHECK_JOB_OUTPUT_LIMIT`), keeping the
TAIL (newest) and prepending a dropped-events marker; set `truncated=true` when
this bound trims. This is independent of the registry ring buffer — it bounds
the single response payload.

### M2 — drain inversion
`startBackgroundJob` today:
```ts
child = spawn(shell, [...shellArgs, command], {
  stdio: ['ignore', outFd, outFd],
  detached: os.platform() !== 'win32',
})
```
Change to a piped stdout/stderr, tee each chunk to (a) the existing log fd
(preserving the durable projection + quota monitor + recovery) and (b) an
in-process line splitter that calls `emitJobOutput` per completed line with the
write-time timestamp. A trailing partial line is flushed on child exit.
`readNewJobOutput` is NO LONGER called on the live path; it remains only for
`getBackgroundJob` cross-session recovery where no in-process pipe exists.
Detach semantics: on non-Windows the child is still detached; the pipe is read
by the parent while attached, and recovery via the log file covers the
cross-session case. Quota monitor and kill/exit paths (`settleBackgroundJob`)
are unchanged.

### M3 — wait() delegation
Replace the loop body with a single `await jobRegistry.wait(registryJobId, {
predicate: waitFor ? (e)=> e.payload.type==='output' && matchWindowIncludes(e) : undefined,
timeoutMs: timeoutMs>0 ? timeoutMs : 0, cursor: entryCursor })`. For poll mode
(timeoutMs===0) do a single `snapshot` (no wait). Preserve: the mid-stream
match window (wait's predicate sees per-event data; the accumulation/bounding
for the returned payload stays), `matched` latch, `kill_on_timeout`, and
returning the full `[entryCursor, nextCursor)` window.

### M4 — digest
Injected via the base2 handleSteps generator (mirroring the `git_status`
yield), formatted into the `<programmatic_tool_result>` observation with
`timeToLive: 'agentStep'`, NOT `keepDuringTruncation`. Per-job line: jobId,
kind, label(≤60), state, exitCode(terminal only), pending bucket
(none/<10/<100/<1k/1k+ relative to a registry-held agentReadCursor), gap flag,
coarse elapsed bucket, and a ≤10-line tail ONCE on terminal transition.
Emission: omit when nothing changed; force on first step of a turn, first step
after compaction, and any unacknowledged settlement. Settlement tombstone
persists until acknowledged so TTL expiry cannot hide a finished job. Fixed
trailing line: "No action required unless you need this output." Ownership from
the trusted run owner, never model input. Whole block ≤ ~300 tokens, ≤10 jobs
then `+N more (list_jobs)`.

## Current state / resume
Design approved by user; artifacts created. Not yet implemented. Resume at
`<!-- current-task -->`. Execute M1→M5 strictly in order, validating at each
milestone boundary. The two most fragile edits are M2 (piped stdio in
startBackgroundJob) and M4 (new context consumer + token ceiling).
