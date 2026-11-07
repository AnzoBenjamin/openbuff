# P2-T2 (ORCH-1): Append-Only Run Journal on bun:sqlite

Design doc, 2026-09-28. Source-backed; grounds every write point and interface
in verified symbols. This is the REMAINING P2-T2 proper (the durable event
journal). The compaction-archive persistence slice already shipped separately
(PLAN.md P2-T2 archive-persistence slice) and is a non-goal here.

## 1. Goals / Non-Goals

### Goals
- A durable, append-only event journal recording every LLM request/response,
  tool call/result, spawn, and step boundary of a run, keyed by `runId` and an
  intra-run monotonic gap-free `seq`.
- Resume at the in-flight step after a hard crash (`kill -9`), including a crash
  mid-tool-call, by detecting the last incomplete event and re-driving the
  `handleSteps` generator via replay of journaled `tool_result`s.
- Cover the generator boundary: generator state lives only in-memory
  (`AgentRunContextRegistry`, run-programmatic-step.ts:55-134) and cannot be
  serialized, so resume re-drives the generator from the top, feeding journaled
  results so it fast-forwards deterministically to the crash point.
- Cover subagents and background agents in the resume model.
- Additive and optional: a run without a journal writer wired behaves exactly
  as today.

### Non-Goals
- The compaction-archive persistence slice is already shipped and is NOT
  re-litigated here. `AgentState.compactionArchive` (including D26
  `tool_result_eviction` snapshots, common/src/types/context-archive.ts)
  already round-trips through the CLI checkpoint, chat-state, and SDK restore
  seams.
- QuickJS heap-snapshot resume is P9-T4, not this task. Serializing generator
  bytecode/heap via `JS_WriteObject` to replace `new Function`
  (run-programmatic-step.ts:368) is explicitly deferred; this design uses
  replay, not heap snapshots. ("P2-T2 is strengthened by P9-T4".)
- Not a general telemetry/analytics sink. `trackEvent` and the in-memory
  orchestration ledger stay as-is.

## 2. bun:sqlite Schema

Single append-only table. bun:sqlite WAL is the sanctioned TS store per
D14 / P6-T6a.

```sql
-- run_journal.db (one file per host/session; runs namespaced by runId)
CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,   -- intra-run monotonic, gap-free per runId
  step_number INTEGER NOT NULL,   -- mirrors loopAgentSteps / runProgrammaticStep stepNumber
  event_type  TEXT    NOT NULL,   -- CHECK enum below
  correlation TEXT,               -- agentStepId | toolCallId | spawnId | childRunId (nullable)
  payload     TEXT    NOT NULL,   -- JSON; full, untruncated (see §8)
  created_at  INTEGER NOT NULL,   -- injected Clock.now() at append (§5)
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_events_run_step
  ON run_events (run_id, step_number, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_correlation
  ON run_events (run_id, correlation);
```

`event_type` enum (CHECK): `llm_request`, `llm_response`, `tool_call`,
`tool_result`, `spawn`, `step_boundary`, `error`.

### Append-only + WAL rationale
- Append-only: rows are only ever INSERTed, never UPDATEd/DELETEd (except
  retention rotation, §8). Mirrors the existing in-memory
  `appendOrchestrationEvent` shape (orchestration-ledger.ts), which assigns
  `sequence = (last?.sequence ?? -1) + 1` and a `timestamp` — the precedent for
  the record shape here. The ledger is capped in-memory
  (`MAX_LEDGER_EVENTS`, `compactEvents`) and lives on `AgentState`; the journal
  is durable and uncapped-per-run (retention is by rotation, not by dropping
  mid-run events).
- WAL: `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` gives durable
  appends with concurrent readers (a resume reader can scan while a writer
  appends) and a well-defined recovery point after `kill -9`: WAL replay on
  next open recovers all committed appends.
- `(run_id, seq)` PK enforces the gap-free monotonic ordering resume depends
  on; `seq` is minted the same way the ledger mints `sequence`.

## 3. Write Points (pseudo-code insertion points)

All appends go through a single `JournalWriter.append(runId, event)` (§7).

### 3a. llm_request / llm_response — run-agent-step.ts, around the stream call
`runAgentStep` mints `agentStepId` at line 538 and builds the stream via the
`promptAiSdk`/stream seam shortly after. Journal request immediately before the
stream is created, response after `processStream` returns:

```ts
// before getAgentStreamFromTemplate(...) / promptAiSdk(...)
journal?.append(runId, {
  eventType: 'llm_request', stepNumber, correlation: agentStepId,
  payload: { model, messages: agentState.messageHistory, system, n },
})
// ... const { fullResponse, toolCalls, toolResults, messageId } = await processStream(...)
journal?.append(runId, {
  eventType: 'llm_response', stepNumber, correlation: agentStepId,
  payload: { messageId, fullResponse, toolCalls, toolResults },
})
```

### 3b. tool_call / tool_result — run-programmatic-step.ts, around executeSingleToolCall
`executeSingleToolCall` mints `toolCallId` at line 892; the generator loop
calls it at ~642 and `addAgentStep` at ~658. Journal `tool_call` before
execution and `tool_result` after:

```ts
// inside executeSingleToolCall, after toolCallId minted (line 892)
journal?.append(runId, {
  eventType: 'tool_call', stepNumber, correlation: toolCallId,
  payload: { toolName: toolCallToExecute.toolName, input: toolCallToExecute.input },
})
await executeToolCall({ ... toolCallId ... })
journal?.append(runId, {
  eventType: 'tool_result', stepNumber, correlation: toolCallId,
  payload: { toolName, result: latestToolResult },
})
```

The `tool_result` append is the completion marker: a crash between `tool_call`
and `tool_result` for the same `toolCallId` is exactly the mid-tool-call kill-9
case (§4). This must also be added to the model-driven tool path inside
`processStream` (same toolCallId contract) so both paths are covered.

### 3c. spawn — spawn-agents handlers
Spawns append a `spawn` event carrying `childRunId` (or `spawnId`/`jobId` for
background) as `correlation`, mirroring the ledger's `spawn_started`/
`spawn_finished` pair and background-agent-jobs `startedAt`/`completedAt`:

```ts
journal?.append(runId, {
  eventType: 'spawn', stepNumber, correlation: childRunId,
  payload: { agentType, background: isBackground, spawnParams, jobId },
})
```

### 3d. step_boundary — at each addAgentStep
`addAgentStep` is the closest existing "journal write" seam (called after each
generator tool call, run-programmatic-step.ts:~658, and after each LLM step in
`loopAgentSteps`). Emit `step_boundary` co-located:

```ts
await addAgentStep({ ... stepNumber, status: 'completed', startTime })
journal?.append(runId, {
  eventType: 'step_boundary', stepNumber, correlation: agentStepId ?? null,
  payload: { status: 'completed', childRunIds, credits },
})
```

`error` events are appended in the catch blocks of both `runProgrammaticStep`
(~685) and `loopAgentSteps`.

## 4. Resume Model

### 4a. Crash detection
On restart, `JournalReader.lastEvent(runId)` reads the highest-`seq` row. The
tail classifies the run:
- tail `tool_call` with no matching `tool_result` (same `correlation`) →
  in-flight tool call (the kill-9-mid-tool-call case).
- tail `llm_request` with no `llm_response` → in-flight LLM step; re-issue the
  request (the LLM call has no local side effect, so re-issue is safe even
  though providers are non-idempotent).
- tail `step_boundary`/`tool_result` → clean step boundary; continue the loop.

### 4b. Re-driving the generator by replay
Generator state is not serializable and lives only in
`AgentRunContextRegistry` (run-programmatic-step.ts:55-134), wiped by the crash.
Resume re-drives `handleSteps` from the top:
1. Reconstruct initial `agentState` (from the last persisted checkpoint /
   journaled `llm_request` payload — message history is journaled).
2. Re-instantiate the generator via the same path (run-programmatic-step.ts:
   ~360-470).
3. Drive `generator.next(...)` (line 572) but, instead of executing each
   yielded tool call, feed the journaled `tool_result` for the matching
   `toolCallId` back into the generator so its control flow fast-forwards
   deterministically to the last completed `tool_result`.
4. At the first tool call with no journaled `tool_result` (the in-flight one),
   stop replaying and execute it for real, then continue live.

This survives handleSteps boundaries: the generator is never resumed mid-frame;
it is deterministically reconstructed by replaying its inputs.

### 4c. Idempotency (side-effecting tools must not re-execute)
Core correctness rule: during replay, a `tool_call` that already has a journaled
`tool_result` is NEVER re-executed — the recorded result is returned to the
generator instead. This prevents a mid-tool-call resume from re-running a
completed side effect (e.g. a `write_file`/`run_terminal_command` that succeeded
before the crash). Only the single tool call whose `tool_result` is missing is
executed live on resume. Implemented as a replay-mode short-circuit inside the
tool dispatch (`executeSingleToolCall`/`executeToolCall`) keyed on `toolCallId`.

### 4d. Subagents and background agents
- Foreground subagents run their own nested `loopAgentSteps` with their own
  `runId` and journal stream. On resume, a parent `spawn` event whose
  `childRunId` has a journal with an unfinished tail → the child resumes from
  its own journal (recursive §4b). A `spawn` whose child journal shows a clean
  terminal `step_boundary`/finish → treat the child complete and feed its
  recorded output back to the parent.
- Background agents are today process-scoped with no disk recovery
  (background-agent-jobs.ts: process-scoped, never outlive the CLI process). A
  kill-9 destroys the live coroutine and its `AbortController`.
  **Recommended policy (staged):** slice 1 uses re-spawn from the parent's
  durable `spawn` intent (`reconcileInterruptedBackgroundAgentIntents` already
  marks vanished jobs `interrupted`), guarded to only re-spawn when the intent
  is re-runnable or the background agent's effects are idempotent. Full
  resume-from-own-journal parity for background agents is a later slice once the
  background coroutine writes its own journal stream.

## 5. Determinism dependency (P2-T1 precedes deterministic replay)

Deterministic replay requires P2-T1 (injected Clock/IdGen): replayed steps must
mint the SAME ids (`agentStepId`, `toolCallId`, `xml-` tool ids) and the SAME
state timestamps (`archivedAt`, ledger `timestamp`, background job
`startedAt`/`completedAt`) so the reconstructed `agentState` byte-matches the
pre-crash state. Ordering: **P2-T1 lands first**; without it, replay reconstructs
state whose ids/timestamps differ from the journal, breaking correlation.
The journal's own `created_at` uses the injected Clock too, so a replay harness
can pin it.

## 6. kill-9 resume test design

Simulate a mid-tool-call crash deterministically without an actual `kill -9`:
1. Wire a test `JournalWriter` over an in-memory / temp-file bun:sqlite DB and a
   deterministic Clock/IdGen (P2-T1).
2. Run a scripted agent whose `handleSteps` yields a side-effecting tool call
   (e.g. a spy `write_file`) whose result is journaled, then a SECOND tool call
   that throws a sentinel "crash" AFTER its `tool_call` is journaled but BEFORE
   its `tool_result` — emulating the kill-9 window.
3. Assert the journal tail is a `tool_call` with no `tool_result`.
4. Start a fresh runtime pointed at the same journal; assert:
   - the first (completed) tool call is NOT re-executed (spy call count stays 1),
   - the generator fast-forwards to the second tool call and executes it live,
   - the run resumes at the correct `stepNumber` and completes.
This is the gate for the task.

## 7. Interfaces (additive, optional on AgentRuntimeDeps)

```ts
export interface JournalEvent {
  eventType: 'llm_request' | 'llm_response' | 'tool_call' | 'tool_result'
    | 'spawn' | 'step_boundary' | 'error'
  stepNumber: number
  correlation?: string | null
  payload: unknown // JSON-serializable
}

export interface JournalWriter {
  /** Append one event; mints seq monotonically per runId. Best-effort or
   *  awaited depending on the hot-path decision (§8). */
  append(runId: string, event: JournalEvent): void | Promise<void>
}

export interface JournalReader {
  lastEvent(runId: string): (JournalEvent & { seq: number }) | undefined
  events(runId: string): Array<JournalEvent & { seq: number }>
  /** tool_result payload for a toolCallId, if journaled (replay short-circuit). */
  toolResultFor(runId: string, toolCallId: string): unknown | undefined
}
```

Both hang off `AgentRuntimeDeps` as optional fields
(`journalWriter?: JournalWriter`, `journalReader?: JournalReader`) so
non-journaled runs are byte-identical to today (same additive pattern P2-T1
uses for clock/idGen).

## 8. Risks
- **Hot-path write latency**: an awaited synchronous append per event adds
  latency to every tool call/LLM step. Mitigation: WAL + `synchronous=NORMAL`,
  and a best-effort fire-and-forget append with a bounded in-process queue
  flushed at step boundaries; the resume contract only needs the `tool_call`
  durably present before the tool executes, so that one append is awaited while
  the rest can batch.
- **Unbounded journal growth**: retention/rotation by run age or count (rotate
  completed runs older than N; keep the last M runs). Never drop mid-run events
  of an unfinished run.
- **Payload size**: unlike the 4k-truncated compaction archive, the journal
  stores FULL payloads (replay needs exact tool results). Bound via retention,
  not truncation; document the size tradeoff.
- **Subagent/background resume complexity**: the recursive child-journal resume
  and the background re-spawn-vs-resume decision are the highest-complexity
  surface; stage them (§9) behind the foreground single-run resume.
- **Non-idempotent tools during the in-flight window**: only the one tool whose
  `tool_result` is missing re-executes; if it had partially applied a side
  effect before the crash, re-execution may double-apply. Mitigation: pair with
  P2-T5 (crash-atomic multi-file transactions / intent log) for the tools that
  need exactly-once; document that plain tools are at-least-once on the
  in-flight call only.

## 9. Staged slice plan
- **Slice 1 — journal write + foreground read/replay.** JournalWriter/Reader
  interfaces + bun:sqlite WAL impl; wire the four write points for a single
  foreground run; replay short-circuit in tool dispatch; the kill-9 mid-tool-call
  resume test (§6). Gate: that test + agent-runtime typecheck/tests. Depends on
  P2-T1 for deterministic ids/timestamps.
- **Slice 2 — subagent resume.** Recursive child-journal resume; a nested-spawn
  crash/resume test. Gate: nested resume test.
- **Slice 3 — background-agent policy.** Re-spawn-from-intent (default) with the
  idempotency guard, then optional resume-from-own-journal once background
  coroutines journal. Gate: interrupted-background-job reconcile + resume test.
- **Slice 4 — retention/rotation + hot-path batching.** Rotation policy and the
  batched-append performance path with a latency benchmark.

Cross-refs: rides D14/P6-T6a (bun:sqlite WAL sanctioned store), requires P2-T1
(determinism), strengthened later by P9-T4 (heap snapshots), pairs with P2-T5
(crash-atomic tool transactions) for exactly-once side effects.
