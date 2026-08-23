# PLAN: Dynamic Cross-Session Memory

## M1 — Persistence substrate + hydration (Phase 0+1)
- [ ] M1-T1 Implement `task-memory-store.ts`: load (schema+checksum validated), persist (atomic), reconcile (hash-based, DI fs), move-rebinding from workspaceMoves. IDs: stable strings `ev-<n>` style preserved.
- [ ] M1-T2 Thread through `initialSessionState` (options: persistentMemory, workspaceMoves; hydrate reconciled memory) and `runOnce` (post-run persist merged memory; derive moves from WorkspaceJournalService when instantiated).
- [ ] M1-T3 Unit/integration tests `sdk/src/__tests__/task-memory-store.test.ts` covering AC1–AC4.
## M2 — Runtime gap fixes
- [ ] M2-T1 Dedupe exact-duplicate strings in mergeTaskMemoryDraft list fields (respecting caps/order).
- [ ] M2-T2 compileTaskMemoryContext drops stale:true evidence from serialized block.
- [ ] M2-T3 Extend existing task-memory runtime tests for M2 behaviors.
## M3 — Eval harness
- [ ] M3-T1 `evals/memory-retention/` scenario runner + README: cold vs warm comparison, stale/rebound assertions (AC5/AC7 metrics), runnable via `bun test`.
## M4 — Validation & docs
- [ ] M4-T1 Typecheck: sdk, evals (+ common if touched indirectly).
- [ ] M4-T2 Run new tests + neighboring suites (initial-session-state, task-memory runtime tests).
- [ ] M4-T3 Update STATUS.md/LESSONS.md; note follow-on phases (consolidation, procedural library) as explicitly deferred.

Dependencies: M1→M2→M3→M4 (M3 depends on exported store API).
Risks: run.ts touch-points are large/fragile — minimal surgical edits only; sdk standalone constraint forbids indexer/runtime imports in sdk.
