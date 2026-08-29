# Background Job Push Model & Drain Inversion — LESSONS

## Decisions

- **Push metadata, pull content.** The split is by KIND of data, not by timing
  (running vs finished). Metadata is small, bucketable, change-gated → cache
  safe. Content is unbounded and mutates every step → injecting it invalidates
  the prompt-cache suffix with no ceiling. Fold the digest into the SAME per-step
  observation block that already carries `git_status` so the cache-invalidation
  boundary does not move versus today.
- **Fix ordering is a hard dependency chain, not a preference.** The checkJob
  poll loop exists specifically to drive `readNewJobOutput`. It cannot be
  removed (M3) before draining is inverted (M2). The digest's pending-lines
  bucket is meaningless (M4) before output enters the registry on write (M2).
  M1 is independent and cheap, so it goes first.
- **Tee for live, file-read for recovery.** Live jobs get a real in-process
  pipe + line splitter (write-time timestamps, per-line events). The log-file
  read path is retained ONLY as the cross-session recovery fallback, where no
  in-process pipe can exist by definition. This preserves the durable disk
  projection without letting it dictate live semantics.
- **The digest is declarative state, not a prompt.** Fixed "No action required
  unless you need this output." line, asserted in a test. It never creates a
  step, never wakes a finished turn, never asks a question — so a chatty dev
  server cannot interrupt the agent mid-task.

## Gotchas / traps

- `truncatedAtCursor` returning `first.sequence <= cursor` is true for a HEALTHY
  buffer — that is why every `check_job` reported `truncated:true, dropped:0`.
  The fix must key off events actually EVICTED past the cursor, not the oldest
  retained event.
- `CHECK_JOB_OUTPUT_LIMIT` (50_000) only bounds the `wait_for` match window via
  `appendBoundedCollected`; the returned `events` array is separately unbounded.
  Both need bounding.
- Event `timestamp` is currently POLL time, not write time (blob emission).
  Per-line teeing is what makes timestamps and the pending bucket truthful.
- Switching `startBackgroundJob` stdio from `['ignore', outFd, outFd]` to a pipe
  is the most safety-critical edit: it touches detach, log-quota monitor, and
  kill/exit settlement. Change the read source only; leave quota + settle paths
  intact.
- `sdk/src/__tests__/check-job.test.ts` asserts `readNewJobOutput` output
  directly (e.g. `expect(readNewJobOutput(job)).toBe('hello\n')`) — these lock
  in blob semantics and need REWORK, not extension, once draining is inverted.

## Corrections to earlier framing

- Earlier claim: "log file as source of truth contradicts PLAN.md's 'disk is a
  projection'." Half right. That invariant holds for LIFECYCLE state (genuinely
  registry-owned). It was never stated for OUTPUT. This is an UNSPECIFIED area
  of the unified-background-jobs design, not a violated invariant.

## Open risk to watch during M4

- If a job settles and its digest entry is dropped by `agentStep` TTL before the
  agent acts on it, the agent would never learn it finished. Requires a
  settlement tombstone that persists until acknowledged — not just a state read.

<!-- update_plan_status:appended -->

## Closure lessons — 2026-08-02T10:30:15.314Z

### Deviations accepted at closure (2026-08-02)

**Behavioral goal vs. specced mechanism are separable — and the goal is what matters.**
All three deviations (D1 interval drainer vs piped stdio, D2 retained `while` loop
with `wait()` as the wake, D3 real `list_jobs` + SDK gate vs bespoke base2 block)
satisfy the underlying requirement while diverging from the DESIGN's prescribed
mechanism. Writing the plan's DESIGN section as an implementation transcript
("switch stdio to a pipe", "delete the loop") rather than as an observable
contract ("an unpolled job still accrues events and settles") made these look
like failures when they were tradeoffs. Future plans should state DESIGN as
requirements + acceptance criteria, and keep prescribed mechanisms clearly marked
as one candidate implementation.

**D1 specifically: the risk calculus beat the elegance.**
Piped stdio was the cleanest way to get write-time timestamps, but it touches
detach, the log-quota monitor, and kill/exit settlement simultaneously — the three
most failure-prone paths in `startBackgroundJob`. A 250 ms interval drainer got
R3 (per-line events) and R4 (drain independent of `check_job`) with a fraction of
the blast radius. The cost is honest and bounded: timestamps are drain-time at
≤250 ms granularity, so sub-250ms bursts collapse into one tick. That was worth
it; a lost line or broken detach would not have been.

**D3 turned out better than the spec.**
Routing the digest through the real `list_jobs` tool instead of a hand-assembled
base2 block gave one source of truth for the digest shape (the tool's own schema
and tests), and the SDK-side fingerprint gate applies to model-initiated
`list_jobs` calls too — not just the pushed ones. When a plan specifies a bespoke
formatter that duplicates an existing tool's output, prefer the tool.

### The open risk flagged during planning came true

This file's pre-existing "Open risk to watch during M4" entry predicted exactly
what happened: the settlement tombstone (R7) was the piece that did not get
built. Flagging a risk in LESSONS is not the same as tracking it as a task — R7
was a numbered requirement in SPEC.md yet had no dedicated milestone task of its
own (it was folded into M4-T1's prose), so it fell through. **Requirements that
survive only inside another task's description are the ones that get dropped.**
Give each acceptance-criteria-bearing requirement its own checkbox.

### Residual risk of deferring R7 (accepted, bounded)

If a job settles and its digest entry is expired by `agentStep` TTL before the
agent acts, the agent can miss the completion. Four mitigations bound this:
settled jobs remain listable for the settled TTL; `end_turn` warns on running
process jobs; the live `job_update` rail surfaces settlement to the user
immediately; and a status/`exitCode`/`completedAt` change busts the digest
fingerprint, so the settlement digest IS emitted at least once. The gap is purely
TTL expiry before acknowledgement, never suppression. Three M4-T3 test cases
(force-after-compaction, unacked settlement, MEASURED token ceiling) remain
untestable until R7 lands.

### Process note: plan artifacts drifted from the code

At the time the user asked whether the plans were complete, `STATUS.md` claimed
M1–M4 done while `PLAN.md` still had every box unchecked and a `current-task`
pointer at M1 — and the session had no `STATE.json` at all. The code was well
ahead of both artifacts. Update the plan artifact at each milestone boundary, not
retroactively at closure; a stale artifact makes a finished session look
abandoned and forces a re-audit of the code to answer a simple status question.
