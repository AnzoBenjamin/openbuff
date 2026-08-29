# SPEC: Dynamic Cross-Session Memory

## Goal

Eliminate forced codebase re-analysis at every conversation start by persisting structured operational memory (TaskMemoryV1) per project root, reconciling its evidence against live file state at session start, and injecting only trustworthy (fresh or honestly-stale-marked) memory.

## Non-goals (this iteration)

- No background consolidation passes (sleep-time compute), no embedding/vector stores, no server.
- No changes to human-curated knowledge.md handling or memory-drift-guard.
- No auto-derived markdown injection into knowledge files.

## Requirements

1. R1 Persist committed task memory per project root at `<root>/.openbuff/memory/task-memory.json`; schema-validated (zod TaskMemoryV1), checksum-checked on load, atomic tmp+rename writes, corrupt/missing file degrades silently to no memory.
2. R2 Hydrate at session start: `initialSessionState` loads + reconciles persisted memory into `mainAgentState.taskMemory` when cwd is provided. Option `persistentMemory: boolean` (default true) disables entirely; failures never break session start.
3. R3 Reconciliation (DI-injectable fs): for each evidence item with a path — missing file ⇒ `{stale: true}`; sha256(content) ≠ freshnessHash ⇒ `{stale: true}`; match ⇒ refresh `verifiedAt`. Never delete entries (drift-detection-over-trust).
4. R4 Move rebinding: optional `workspaceMoves: {from,to}[]` input (caller derives from WorkspaceStateV1 journal change records with action 'move'); a stale-missing evidence path matching a move source is rebound to the destination (path updated, staleness recomputed against destination hash) instead of being orphaned.
5. R5 Cross-run merge on save: persisted memory merges with this run's final memory via existing append-only `mergeTaskMemoryDraft` semantics (dedupe exact-duplicate list strings); bounded by existing schema array caps.
6. R6 Stale-aware compilation: `compileTaskMemoryContext` excludes `stale: true` evidence from the injected `<task_memory>` block (counts still visible), so unverified facts are surfaced-not-trusted.
7. R7 Eval harness (deterministic, no LLM): scripted multi-session scenario proving warm-start advantage and correct stale/rebound behavior; metrics: reconcile outcome counts, compiled-context chars cold vs warm, wrong-memory count (must be 0).

## Acceptance criteria

- AC1 Second `initialSessionState` on unchanged project yields hydrated taskMemory whose evidence verifies fresh.
- AC2 Mutating an evidenced file marks exactly that evidence stale; unrelated evidence stays fresh.
- AC3 Renaming (move) an evidenced file with `workspaceMoves` supplied rebinds the entry; without it, entry is stale (not deleted).
- AC4 Corrupt/truncated memory file is ignored (fresh start) without throwing.
- AC5 Compiled context contains zero stale-evidence text; contains fresh decisions text.
- AC6 All new + existing affected tests pass; sdk + evals typechecks pass.

## Systems touched

- sdk/src/services/task-memory-store.ts (new): load/persist/reconcile.
- sdk/src/run-state.ts: hydration + options threading.
- sdk/src/run.ts: persist final memory post-run; supply workspace moves from journal when available.
- packages/agent-runtime/src/util/task-memory.ts: dedupe in merge/normalize + stale-aware compile.
- sdk/src/**tests**/task-memory-store.test.ts (new), evals/memory-retention/ (new harness).
- Plan artifacts: .agents/sessions/dynamic-cross-session-memory/{PLAN,STATUS}.md
