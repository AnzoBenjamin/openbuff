# Background Job Push Model & Drain Inversion — STATUS

## Current state — M1–M4 implemented; awaiting gate on M4 files

### Done
- M1: truncatedAtCursor gap predicate; bound returned events; tests.
- M2: live 250ms drain, per-line events, hasLiveDrainer, peekJobLineCarry.
- M3: checkJob wait() wake; matched=false; follow without wait_for; OOM bounds tests.
- Adapter TTL prune + recovery settledAt / no post-TTL re-cache; lastCheckCursor for live observability.
- Reviewer nits: wait_for-via-lineCarry test; MAX_LINE_BYTES force-flush test (export MAX_LINE_BYTES).
- **M4:**
  - Pure helpers `common/src/util/list-jobs-view.ts` + unit tests.
  - `list_jobs` schema + SDK: pending bucket, gap, optional terminal tail, note line; does not advance lastCheckCursor.
  - base2 yields programmatic `list_jobs` after initial + mid-loop `git_status` (pushed status digest).

### Validation (local)
- check-job 41/41; list-jobs-view + list-jobs 12/12; combined suites 53/53.
- typecheck: common, sdk, agents clean.

### Pending
- Runtime validation/reviewer gate on M4 dirty set.
- M5: cross-package smoke + live dev-server if desired.

## Resume
If gate returns blockers, fix finding-scoped issues only. M5 is optional next after LOOKS_GOOD.

<!-- update_plan_status:appended -->
## Session closed — M1–M5 delivered, R7 deferred — 2026-08-02T10:29:36.462Z

The session is closed with M1–M5 delivered and one requirement (R7) explicitly deferred. Rather than checking boxes silently, `PLAN.md` was rewritten to be honest about what shipped: every milestone line now carries the concrete evidence for its claim, and a new §Deviations section records three places where the implementation diverged from the original DESIGN.

### What shipped

- **M1 (registry/bounding bugs):** `truncatedAtCursor` now reports a gap only when unread events were actually evicted (`first.sequence > cursor + 1`) instead of firing on every healthy buffer; `CHECK_JOB_POLL_ACCUMULATION_CAP` bounds both the `wait_for` match window and the returned `events` payload. check-job 41/41.
- **M2 (drain inversion):** live jobs drain independently of `check_job` and emit per-line `output` events, with a `hasLiveDrainer` single-drainer gate so the shared `readOffset`/`decoder`/`lineCarry` cursor is never double-drained. Final drain + `flushJobLineCarry` on exit/error guarantees no trailing line is lost.
- **M3 (poll loop):** follow mode is event-driven through `jobRegistry.wait()`; a match wakes immediately with no 200 ms quantization.
- **M4 (digest + list_jobs):** base2 pushes a programmatic `list_jobs` on the same rail as `git_status`; the SDK gates unchanged repeat digests into `{ unchanged: true, note }`; `list_jobs` gained pending buckets relative to the `check_job` cursor, a `gap` flag, terminal tails, a 10-row cap with `truncatedCount`, and dual-id reverse-resolution so recovered jobs expose the user-facing jobId. 34/34 across the four related suites.
- **M5 (validation):** all 11 packages typecheck; live real-spawn smoke passed (start → follow matched `READY-TOKEN` → digest → clean kill); every reviewer gate reached LOOKS_GOOD or NON_BLOCKING after repairing the dual-id, follow-without-`wait_for`, and fd-leak blockers.

### Three recorded deviations

- **D1** — a 250 ms interval drainer replaced the specced piped stdio + line splitter. Achieves R3/R4, but timestamps are drain-time at ≤250 ms granularity rather than true write-time. Accepted because piped stdio is the single most safety-critical edit in the plan (detach, quota monitor, kill/exit settlement).
- **D2** — the `while (true)` loop in `check-job.ts` was retained, with `jobRegistry.wait()` as the wake mechanism instead of `sleep(200)`. R5's real goal is met; the periodic re-entry survives so the loop can still re-drain recovered jobs and re-inspect `lineCarry`, which `wait()` alone cannot observe.
- **D3** — the digest is the real `list_jobs` tool plus an SDK-side fingerprint gate, not a bespoke base2 block. Better in that the digest has one source of truth and the gate also covers model-initiated calls; divergent in that `truncatedCount` replaces `+N more`, there is no elapsed bucket, and gate state is per-run rather than per-agent-context.

### Deferred: R7 settlement tombstone

Not implemented — `grep tombstone` matches only the unrelated workspace-mutation broker. If a job settles and its digest entry is expired by `agentStep` TTL before the agent acts, the agent can miss the completion. Four mitigations bound the exposure: settled jobs stay listable for the settled TTL, `end_turn` warns on running process jobs, the live `job_update` rail shows the user immediately, and a status/`exitCode`/`completedAt` change busts the fingerprint so the settlement digest is emitted at least once. The gap is purely TTL expiry before acknowledgement, not suppression. This also leaves three M4-T3 cases untested (force-after-compaction, unacked settlement, MEASURED token ceiling).
