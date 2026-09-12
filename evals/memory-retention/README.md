# Memory retention eval

Deterministic, no-LLM scenarios proving that cross-session task memory behaves
honestly across the session boundary. The eval drives the SDK store APIs and
the agent-runtime context compiler directly:

- `saveMergedTaskMemory` persists merged memory under `<root>/.openbuff/memory/task-memory.json`.
- `loadPersistedTaskMemory` performs a schema-validated, checksum-shaped load.
- `reconcileTaskMemoryEvidence` hash-verifies evidence against disk, rebinds known moves, and marks stale entries without deleting them.
- `compileTaskMemoryContext` emits the V1 task-memory JSON supplied to the runtime; the eval parses that JSON when measuring recall and trust.
- `MemoryTurnContextV2Schema` and `compileMemoryV2Context` drive a schema-valid V2 fixture directly, with no model or network dependency.

Each test uses an isolated temporary workspace and removes it afterward.

## Scenarios

| ID | Claim under test |
| --- | --- |
| S1 | Cold start (no persisted memory) recalls nothing. |
| S2 | A warm unchanged session retains decisions and fresh evidence. |
| S3 | Mutating a file marks exactly its own evidence stale. |
| S4 | A rename rebinds via a known workspace move; without that knowledge it degrades to stale-not-deleted. |
| S5 | Paired cold and warm V1 contexts differ only in persisted-memory treatment. Warm context recalls unchanged and known-renamed evidence, excludes stale changed evidence until reread, and never relies on the old rename path. |
| S6 | A schema-valid V2 turn isolates unrelated and stale sentinels, exposes a replacement only after simulated reread, preserves symbol selector granularity, compiles known renames only at the new path, requires reread for unknown renames, and avoids duplicate exploration reads. |

## Metrics and formulas

S5 calculates metrics as local test values; it neither accumulates them globally
nor writes benchmark output. A **relevant fact** is a fresh evidence record for
an artifact required by the fixture. An **incorrect recall** is compiled
evidence known to be invalid because its artifact changed. The known renamed
record is relevant only when reconciliation and compilation both use its new
path and compiled JSON does not contain the old path.

- `eligibleRelevantFacts = count(relevant evidence records that remain fresh or are validly rebound)`
- `coldRelevantRecall = count(cold compiled evidence IDs intersect eligible relevant IDs)`
- `warmRelevantRecall = count(warm compiled evidence IDs intersect eligible relevant IDs)`
- `incrementalRelevantRecall = warmRelevantRecall - coldRelevantRecall`
- `coldIncorrectRecall = count(cold compiled evidence IDs intersect known-invalid IDs)`
- `warmIncorrectRecall = count(warm compiled evidence IDs intersect known-invalid IDs)`
- `incrementalIncorrectRecall = warmIncorrectRecall - coldIncorrectRecall`
- `staleEvidenceExposed = count(known-stale evidence IDs in warm compiled JSON)`
- `staleTrustViolations = count(warm compiled evidence marked stale or known stale)`
- `knownRenameRecovery = 1` only when the reconciled and compiled record uses the new path and compiled JSON omits the old path; otherwise `0`.
- `coldContextBytes` and `warmContextBytes` are UTF-8 byte lengths of the respective compiled context strings.

## Deterministic thresholds

The paired fixture requires exactly two eligible reusable facts. Cold relevant
recall must be `0`, warm relevant recall must equal eligible facts, and
incremental relevant recall must be `2`. Cold, warm, and incremental incorrect
recall must all be `0`; stale evidence exposure and stale trust violations must
also be `0`. Known rename recovery must be `1`. Cold context bytes must be `0`
and warm context bytes must be greater than cold context bytes. The changed
artifact is additionally required to remain absent before a fresh read and to
appear after fresh evidence is persisted and reconciled.

S6 records exact local V2 metrics: `coldReadAttempts = 4`,
`warmReadAttempts = 2`, and `duplicateReadsAvoided = 2`. These are actual
simulated read attempts over the same four workspace targets; verified file
selectors skip only their exact paths, while the stale symbol selector and
unknown rename still require reads. `networkCalls = 0` and `modelCalls = 0`;
a test-scoped fetch poison fails any accidental network access and is restored
in `finally`. `promptBytes` is measured from the UTF-8 compiled prompt and must
be positive, while the compiler output remains at or below the explicit
`MEMORY_V2_CONTEXT_MAX_CHARS = 12000` character bound. The replacement sentinel
is absent before reread and present afterward; the stale and unrelated
sentinels remain absent in both phases.

These are deterministic state and byte-count assertions. There are no provider
calls, network calls, timing thresholds, or claims that memory improves LLM
coding quality. The fixture measures evidence availability and integrity, not
semantic answer quality, retrieval ranking, token cost, or model behavior. Its
small synthetic files also do not predict context size for real repositories.

## Run

From the repository root, run the targeted package script exactly:

```bash
bun --cwd=evals run test:memory-retention
```

## Deferred phases (see `.agents/sessions/dynamic-cross-session-memory/SPEC.md`)

- Background consolidation of episodic logs into distilled insights
- Procedural recipe library with re-verification
- Trust-scored retrieval ranking at injection time
