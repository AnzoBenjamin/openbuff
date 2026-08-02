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
