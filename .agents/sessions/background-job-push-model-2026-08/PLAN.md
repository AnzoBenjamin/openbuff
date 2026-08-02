# Background Job Push Model & Drain Inversion — PLAN

<!-- current-task: none -->

Status legend: `[ ]` pending, `[~]` in_progress, `[x]` done, `[/]` cancelled, `[!]` blocked.

**Session closed 2026-08-02.** M1–M5 delivered with three recorded deviations
from the original DESIGN (see §Deviations). One requirement (R7 settlement
tombstone) is explicitly DEFERRED, not delivered — its residual risk is stated
below. Shipped in commits `e5797f4fe` (push model + list_jobs) and
`a7650cfdd` (reviewer nits); further list_jobs schema/doc nits are uncommitted
in the working tree at closure time.

Ordering was strict: M2 depended on M1 landing; M3 depended on M2 (the poll loop
existed ONLY to drain, so it could not be removed until draining was inverted);
M4 depended on M3 (the digest's pending-lines bucket is only meaningful once
output enters the registry on write).

## Milestones

### M1 — Independent registry/bounding bugs (no design risk) — DONE
- [x] M1-T1 Fix `truncatedAtCursor` in `common/src/util/job-registry.ts` to signal a real gap. (Now returns `first.sequence > cursor + 1` — a gap only when unread events were actually evicted; 3 regression tests in `job-registry.test.ts` cover healthy-buffer, evicted, and caught-up cursors.)
- [x] M1-T2 Bound `check_job` returned `events` by an explicit ceiling in `sdk/src/tools/check-job.ts`. (`CHECK_JOB_POLL_ACCUMULATION_CAP` = 2× `CHECK_JOB_OUTPUT_LIMIT` bounds both the `wait_for` match window and the returned payload; `truncated: true` when trimmed. Covered by the oversized-single-event and chatty-follow OOM tests.)
- [x] M1-T3 Validate: `common` + `sdk` typecheck; job-registry + check-job suites. (check-job 41/41; job-registry suites green; typechecks clean.)

### M2 — Invert the drain (write-time, per-line events) — DONE WITH DEVIATION (D1)
- [x] M2-T1 Live path drains independently of `check_job` and emits per-line `output` events. **Deviation D1:** implemented as a job-owned 250 ms interval drainer (`logQuotaTimer` → `readNewJobOutput` → `emitJobOutputLines`) plus a `hasLiveDrainer` single-drainer gate, NOT the specced piped stdio + in-process splitter. `stdio` remains `['ignore', outFd, outFd]`.
- [x] M2-T2 Keep `readNewJobOutput`/file-read strictly as the cross-session RECOVERY fallback. (Partially superseded by D1: `readNewJobOutput` is now ALSO the live drain source, but it is called from exactly one owner per job — the interval for live jobs, `check_job` for recovered jobs — so the shared `readOffset`/`decoder`/`lineCarry` cursor is never double-drained.)
- [x] M2-T3 Validate: `sdk` background-job suites. (`MAX_LINE_BYTES` force-flush, `hasLiveDrainer` pre-drain, `wait_for`-via-`lineCarry`, and settled-TTL prune/recovery tests added; blob-semantics assertions reworked.)

### M3 — Replace poll loop with jobRegistry.wait() — DONE WITH DEVIATION (D2)
- [x] M3-T1 Follow mode is event-driven via `jobRegistry.wait()`. **Deviation D2:** the `while (true)` loop in `check-job.ts` is RETAINED, but each iteration now awaits `jobRegistry.wait(registryJobId, { timeoutMs: Math.min(POLL_INTERVAL_MS, remaining) })` instead of `sleep(200)`. Matches wake immediately; the 200 ms cap only bounds how long a quiet iteration blocks.
- [x] M3-T2 Preserve external contract: poll vs follow, matched latch, `kill_on_timeout`, full-window events. (Verified: `timeout_seconds: 0`/absent = single non-blocking poll; follow without `wait_for` blocks to exit or deadline; `matched` only emitted when `wait_for` was supplied.)
- [x] M3-T3 Validate: check-job suite + agent-runtime check-job handler. (41/41 check-job; agent-runtime handler suites green.)

### M4 — Pushed status digest + list_jobs pending signal — DONE WITH DEVIATION (D3)
- [x] M4-T1 Change-gated background-job digest in the per-step observation. **Deviation D3:** base2 yields a plain programmatic `list_jobs` after the initial and mid-loop `git_status` (same rail, `agentStep` TTL), and the change-gate lives in the SDK dispatch (`applyListJobsDigestGate` in `sdk/src/run.ts`) rather than in base2. Per-turn row fingerprint (jobId|status|pending|gap|completedAt|exitCode, folded with `truncatedCount`) suppresses an unchanged repeat digest into `{ unchanged: true, note }`. **NOT delivered:** the settlement tombstone (R7), the coarse elapsed bucket, the `+N more (list_jobs)` line (`truncatedCount` is used instead), and the MEASURED token-ceiling test.
- [x] M4-T2 Bucketed pending-output + gap signal on `list_jobs`. (`common/src/util/list-jobs-view.ts` pure helpers; pending buckets relative to the `check_job` consumer cursor, `gap` from ring truncation, terminal tail ≤10, row cap 10 with `truncatedCount`, fixed no-action note. `list_jobs` never advances `lastCheckCursor`. Dual-id recovered jobs reverse-resolve to the user-facing jobId.)
- [x] M4-T3 Validate: regression tests for omit-when-unchanged, no-action-line contract, cursor immutability, gap, terminal tail, dual-id rediscovery, and the suppressed-variant schema. (34/34 across list-jobs-view, list-jobs, run-list-jobs-gate, list-jobs-params.) **NOT covered:** force-on-first-step-after-compaction, unacked-settlement forcing, and the MEASURED token ceiling — all downstream of the deferred R7.

### M5 — Final validation & review — DONE
- [x] M5-T1 Cross-package typecheck. (All 11 packages green via the `script:typecheck` hook.)
- [x] M5-T2 Live end-to-end background-job smoke. (Real `startBackgroundJob` → `check_job` follow matched `READY-TOKEN` → `list_jobs` digest with matching jobId and pending bucket → clean kill. **Not exercised:** "settlement surfaces exactly once" — unverifiable while R7 is deferred.)
- [x] M5-T3 Address automated reviewer gate blockers. (All reviewer gates reached LOOKS_GOOD or NON_BLOCKING; blocking findings on the dual-id remap, follow-without-`wait_for`, and fd leak were repaired and re-reviewed.)

## Deviations from DESIGN (accepted at closure)

**D1 — Interval drainer instead of piped stdio (M2-T1).**
Spec called for `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` with an
in-process line splitter teeing to both the log fd and `emitJobOutput`. Shipped
instead: the existing fd-based spawn plus a per-job 250 ms interval that calls
`readNewJobOutput` → `emitJobOutputLines`.
- *Requirements met:* R3 (per-line `output` events) and R4 (draining no longer
  depends on `check_job`; an unpolled job still accrues events and settles).
- *Requirement partially met:* R3's "write-time timestamps". Timestamps are
  DRAIN-time with ≤250 ms granularity, not true write-time. AC3 ("lines written
  seconds apart appear as distinct events with distinct timestamps") holds at
  second scale; sub-250ms bursts collapse into one drain tick.
- *Why accepted:* the piped-stdio edit is the single most safety-critical change
  in the plan (detach, log-quota monitor, kill/exit settlement). The interval
  drainer achieves the behavioral goal without touching detach semantics, and
  the final drain + `flushJobLineCarry` on exit/error guarantees no trailing
  line is lost.

**D2 — `while (true)` retained around `jobRegistry.wait()` (M3-T1).**
Spec said delete the loop. Shipped: the loop remains, but the body awaits
`jobRegistry.wait()` with `timeoutMs: Math.min(POLL_INTERVAL_MS, remaining)`.
- *Requirement met in substance:* R5's real goal — no 200 ms quantization on a
  match, no dead `wait()` on the shell path — is achieved. `wait()` is now the
  wake mechanism.
- *Residual:* the periodic re-entry still exists so the loop can re-drain a
  recovered (non-live-drainer) job and re-evaluate `lineCarry`, which `wait()`
  alone cannot observe. Removing the loop entirely would require moving carry
  inspection into the registry.

**D3 — Digest = plain `list_jobs` + SDK-side gate (M4-T1).**
Spec described a bespoke digest block assembled in base2 with per-job elapsed
buckets and a `+N more (list_jobs)` overflow line. Shipped: base2 yields the
real `list_jobs` tool, and suppression is a per-run fingerprint gate in
`sdk/src/run.ts`.
- *Better than spec:* one source of truth for the digest shape (the tool's own
  schema/tests), and the gate applies to model-initiated `list_jobs` calls too.
- *Divergent details:* `truncatedCount` replaces `+N more`; no elapsed bucket;
  gate state is per-`run()` (per turn) rather than per-agent-context.

## Deferred requirement

**R7 — settlement tombstone: DEFERRED (not implemented).**
Requirement: "Settlement is surfaced at least once even if `agentStep` TTL
expires the digest before acknowledgement." No tombstone exists in the job code
(`grep tombstone` matches only `sdk/src/services/workspace-mutation-broker.ts`,
unrelated).

*Residual risk:* if a job settles and the digest entry carrying its terminal
state is expired by `agentStep` TTL before the agent acts on it, the agent can
miss the completion. Mitigations already in place that reduce (not eliminate)
the exposure:
- Settled jobs stay listable for the whole settled TTL, so any later `list_jobs`
  still reports the terminal state and `exitCode`.
- `end_turn` warns about still-running process jobs.
- The live `job_update` rail surfaces settlement to the USER immediately (M5 of
  the unified-background-jobs session), so a human sees it even when the agent
  does not.
- A status/`exitCode`/`completedAt` change busts the digest fingerprint, so the
  settlement digest is emitted at least once — the gap is purely TTL expiry
  before acknowledgement, not suppression.

*To implement later:* persist an unacknowledged-settlement flag per job in the
registry, force digest emission while any flag is set, and clear the flag when
the agent observes the terminal row. That also unlocks the three untested M4-T3
cases (force-after-compaction, unacked settlement, MEASURED token ceiling).

## DESIGN (historical — as originally specified)

The original M1–M4 design specification is preserved verbatim in this file's
git history (see the pre-closure revision). It is intentionally not restated
here, because §Deviations above is now the authoritative record of what shipped
and how it differs.

## Current state / resume

Closed. Nothing to resume. The only carried-forward work item is R7
(settlement tombstone) plus its three dependent M4-T3 test cases; open a new
session if that becomes a priority.
