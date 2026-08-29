# STATUS: Dynamic Cross-Session Memory

Updated: 2026-08-22 (implementation complete, awaiting final review gate)

## Completed

- M1: `sdk/src/services/task-memory-store.ts` — load (schema+checksum validated, corrupt-safe), atomic save with unique tmp suffix + 0o600 perms, hash reconciliation with move rebinding, path-traversal fail-closed guard, Promise.all batched hashing, exported `stableHash` with FNV-1a vector tests.
- M1: hydration wired in `initialSessionState` (options `persistentMemory`, `workspaceMoves`; never blocks session start) and post-run persistence in `runOnce` success path only (`collectWorkspaceMoves` at module scope derives moves from the workspace journal).
- M2: runtime gap fixes verified already-present (`uniqueRecent`/`normalizeEvidence` dedupe; `evidenceIsFresh` excludes stale from `<task_memory>`); covered by new runtime tests.
- M3: deterministic eval harness `evals/memory-retention/` (S1–S4, no LLM).
- M4: typechecks green (script:typecheck all packages, typecheck-sdk, typecheck-agent-runtime); tests green: sdk store 11/11, runtime task-memory 8/8, eval scenarios 4/4.
- Review hardening round applied: safeParse never-throw, traversal test with spying fs, missing-file case, FNV vectors, 0o600 assertion, module-scope helper, batched hashing, symlink-exposure doc note.

## Deferred (explicitly out of scope this iteration)

- Background consolidation (sleep-time distillation), procedural recipe library, trust-scored retrieval ranking — see SPEC non-goals.
- Shared FNV-1a helper in @codebuff/common (three copies now annotated; consolidation pending).

## Compatibility notes

- Pre-checksum `task-memory.json` records: none exist in any deployment (the store shipped alongside checksum enforcement), so `loadPersistedTaskMemory` discards them fail-closed rather than tolerate-and-upgrade. Revisit only if a deployed legacy format ever materializes.

## Blockers

- None. Fresh reviewer pass pending on final snapshot.
