# Memory retention eval

Deterministic (no-LLM) scenario proving cross-session task memory behaves
honestly across the session boundary. Drives the SDK store API directly:

- `saveMergedTaskMemory` — persists merged memory under `<root>/.openbuff/memory/task-memory.json`
- `loadPersistedTaskMemory` — schema-validated, checksum-shaped load
- `reconcileTaskMemoryEvidence` — hash-verifies evidence against disk, rebinds known moves, marks stale entries (never deletes)

## Scenarios

| ID | Claim under test |
|----|------------------|
| S1 | Cold start (no persisted memory) recalls nothing |
| S2 | Warm unchanged session retains decisions with fresh evidence |
| S3 | Mutating a file marks exactly its own evidence stale |
| S4 | Renames rebind via workspace moves; without journal knowledge they degrade to stale-not-deleted |

Compiled-context exclusion of stale evidence lives in the runtime suite
(`packages/agent-runtime/src/util/__tests__/task-memory.test.ts`).

## Run

```bash
bun --cwd=evals test memory-retention
```

## Deferred phases (see .agents/sessions/dynamic-cross-session-memory/SPEC.md)

- Background consolidation of episodic logs into distilled insights
- Procedural recipe library with re-verification
- Trust-scored retrieval ranking at injection time
