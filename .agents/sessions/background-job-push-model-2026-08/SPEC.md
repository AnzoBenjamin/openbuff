# Background Job Push Model & Drain Inversion — SPEC

## Problem

The agent is the only background-job consumer still forced to poll. Hands-on
exercise of `run_terminal_command` (BACKGROUND) + `check_job` / `list_jobs` /
`read_logs` / `kill_job`, plus a background `spawn_agents` file-picker, surfaced
concrete defects rooted in one design flaw: **job output only enters the
registry as a side effect of the agent calling `check_job`.**

Live push already exists for the human (`sdk/src/run.ts` →
`jobRegistry.subscribeAll` → `sdk/src/job-update-forwarder.ts` →
`cli/src/utils/sdk-event-handlers.ts:handleJobUpdate`), and the runtime already
pushes a per-step `git_status` observation into the agent's context. Background
jobs were never wired into that push rail for the agent.

## Confirmed defects (evidence)

1. `truncated: true, dropped: 0` on every `check_job`. `truncatedAtCursor`
   (common/src/util/job-registry.ts) returns `first.sequence <= cursor`, true
   for a HEALTHY buffer. It must compare against the highest EVICTED sequence.
2. Returned `events` array is unbounded. `CHECK_JOB_OUTPUT_LIMIT` (50_000) in
   sdk/src/tools/check-job.ts only bounds the `wait_for` match window
   (`appendBoundedCollected`), never the returned events. One poll of a chatty
   job returned ~4,000 lines in a single event.
3. Output arrives as giant undifferentiated blobs. `readNewJobOutput`
   (sdk/src/tools/background-jobs.ts) emits all bytes since last offset as ONE
   `output` event, stamped at POLL time, not write time. Job-3's three lines
   written 25s apart collapsed into one event.
4. Draining is a side effect of polling. `readNewJobOutput` is called from ONE
   production site: the `while(true)` loop in check-job.ts. Unpolled jobs
   produce no events; `read_logs` and `check_job` mutate shared cursor/offset
   state.
5. `list_jobs` gives no progress signal (no cursor, no pending-output count).
6. `jobRegistry.wait()` (event-driven, no sleep-poll, self-cleaning) is DEAD
   CODE on the shell path because checkJob must poll to drain.

## Goals

- Push bounded job STATE metadata into the agent's per-step observation; keep
  job CONTENT pull-only.
- Invert draining so output enters the registry on write, per line, with
  write-time timestamps — independent of polling.
- Replace checkJob's hand-rolled poll loop with `jobRegistry.wait()`.
- Fix the two independent registry/bounding bugs first (cheap, no design risk).

## Non-goals

- No change to the human-facing `job_update` → CLI live render pipeline
  (already correct).
- No change to lifecycle state ownership (registry-owned; genuinely correct).
- No auto-kill of long-runners; end_turn still warns, never kills.
- No change to cross-session recovery's on-disk projection contract (it stays
  the durable fallback where no in-process pipe can exist).

## Requirements

- R1: `truncated` is true IFF unread events were actually evicted for that
  cursor; `dropped` and `truncated` never contradict.
- R2: `check_job` returned `events` are bounded by an explicit ceiling
  regardless of how chatty the job is.
- R3: Live shell jobs emit per-line `output` events with write-time timestamps.
- R4: Draining no longer depends on `check_job` being called; an unpolled job
  still accrues registry events and settles.
- R5: `checkJob` follow mode delegates to `jobRegistry.wait()` — no sleep loop.
- R6: A change-gated, bounded background-job digest is injected into the agent's
  per-step observation block (same rail/TTL as `git_status`), declarative only,
  with a fixed "no action required unless you need this output" contract line.
- R7: Settlement is surfaced at least once even if `agentStep` TTL expires the
  digest before acknowledgement (settlement tombstone).
- R8: `list_jobs` exposes a per-job pending-output signal (bucketed) and a gap
  flag.

## Acceptance criteria

- AC1: A live dev-server-style job, never polled, shows accruing registry
  events and a terminal state after exit (R4).
- AC2: A chatty job's `check_job` response is bounded and reports
  `truncated`/`dropped` consistently (R1, R2).
- AC3: Lines written seconds apart appear as distinct events with distinct
  write-time timestamps (R3).
- AC4: `wait_for` resolves without 200ms quantization and with no sleep loop
  (R5); existing check-job suite semantics preserved.
- AC5: The digest appears in the agent observation, is omitted when nothing
  changed, force-emits on first step of a turn / after compaction / on
  unacknowledged settlement, and carries the fixed no-action line asserted in a
  test (R6, R7).
- AC6: Cross-package typecheck clean; job suites green; live end-to-end smoke.

## Relevant systems / files

- common/src/util/job-registry.ts — registry, `snapshot`, `wait`,
  `truncatedAtCursor`, ring buffer, `subscribeAll`.
- sdk/src/tools/background-jobs.ts — `startBackgroundJob`, `readNewJobOutput`,
  `emitJobOutput`, `settleBackgroundJob`, stdio wiring.
- sdk/src/tools/check-job.ts — poll loop to be replaced; `CHECK_JOB_OUTPUT_LIMIT`.
- sdk/src/tools/list-jobs.ts, read-logs.ts, kill-job.ts.
- sdk/src/run.ts (:541 subscribeAll; :1326 end_turn branch).
- sdk/src/job-update-forwarder.ts (human push; reference).
- agents/base2/base2.ts (git_status yield pattern → digest injection site).
- packages/agent-runtime/src/util/messages.ts (`expireMessages`, agentStep TTL).
- packages/agent-runtime/src/run-programmatic-step.ts
  (`formatProgrammaticToolResultMessage`).
- Tests: common/src/util/__tests__/job-registry.test.ts,
  sdk/src/__tests__/check-job.test.ts (asserts readNewJobOutput semantics — will
  need rework), packages/agent-runtime/.../check-job.test.ts (asserts dropped:0).

## Risks

- Switching `startBackgroundJob` stdio from `['ignore', outFd, outFd]` to a pipe
  touches the most safety-critical detach/quota/kill code.
- sdk/src/__tests__/check-job.test.ts asserts `readNewJobOutput` output directly
  and will need rework, not just extension.
- The digest is a new context consumer landing on top of in-flight
  `context-budget.ts` / `measure-context-baseline.ts` work; needs a MEASURED
  token ceiling.
- PLAN.md of unified-background-jobs claims "disk is a projection, never
  consulted for live state" — that holds for lifecycle, NOT output. This spec
  formalizes the output source-of-truth question left unspecified there.
