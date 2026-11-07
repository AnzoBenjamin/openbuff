# STATUS — Retrieval & Memory Quality Tier 1

## Current state
COMPLETE. All Tier 1A–1D edits landed with mutation receipts; all touched suites and typechecks green.

## Baseline benchmark numbers (pre-Tier-1, captured 2026-10-17)
- retrieval-quality (openbuff-repository-retrieval-v2, k=3, 20 docs / 18 queries):
  - recallAtK = 0.972222
  - meanReciprocalRank = 0.972222
  - nDCG@K = 0.97395
  - noiseRateAtK = 0.648148
- memory-retention eval: 6/6 pass (S1–S6); S5 observed compiledEvidenceCount=2, readEvidenceCount=2, boilerplateReadNoiseRatio=1.0 (stale entry correctly excluded; all surviving evidence is read-kind bookkeeping)

## Post-fix benchmark numbers (after Tier 1A–1D, 2026-10-17)
- retrieval-quality corpus (k=3): recallAtK = 0.972222, MRR = 0.972222, nDCG@K = 0.97395, noiseRateAtK = 0.648148 — unchanged vs baseline. Expected: this corpus scores the indexer's lexical channel over indexed metadata; Tier 1A/1B reweight code-map token scores and chunk call lists (metadata content), while Tier 1C filters second-hop relatedFiles, which this path-closed corpus does not exercise. The Tier 1C noise reduction is exercised by neighbors-mode graph queries (query.test.ts, 410/0).
- memory-retention eval: 6/6 pass. S5 boilerplateReadNoiseRatio stays 1.0 in-scenario (the eval constructs evidence manually without the sessionScoped flag, deliberately, to pin the compile contract); the durable-store noise drop is pinned by the new sdk test 'session-scoped read evidence stays ephemeral across saves' — derived reads no longer persist at all.

## Tier 1A–1D change summary (all with mutation receipts)
- 1A parse.ts: tf×IDF scoring (identifierCounts + per-language stoplist + df downweight replacing the popularity boost); identifier-captures coalescing guard (`parseResults.identifier ?? []`).
- 1B structure.ts: call-site captures must start with 'call' (@import.call leak fixed). chunks.ts: call dedup by name + count-sorted rank-then-cap.
- 1C query.ts: second-hop concept/import expansion requires the query token to match the node label (empty-token bypass for explicit-file neighbors mode); deterministic path tie-breaks.
- 1D task-memory: sessionScoped derived reads (ephemeral at persist), tightened rationale markers (causal/comparative reasoning required), duplicate-decision idempotent skip, content dedup scoped to LLM-authored kinds (read/edit exempt — freshnessHash distinguishes them).

## Validation results
- common: decision-rationale 5/0; typecheck clean.
- code-map: 156/1 (single failure 'packaged language WASM coverage' pre-exists at HEAD, verified via stash experiment); typecheck clean.
- indexer: 410/0; typecheck clean.
- agent-runtime: task-memory + record-decision 42/0; typecheck clean.
- sdk: task-memory-store 48/0; typecheck clean.
- evals: memory-retention 6/0.

## Blockers
(none)
