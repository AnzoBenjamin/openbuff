# STATUS — Retrieval & Memory Quality Tier 1

## Current state
- SPEC.md, PLAN.md created (M0 done).
- Phase: benchmark harness + baseline (M1/M2).

## Completed
- [x] M0 session artifacts
- [x] M1 benchmark metrics: `noiseRateAtK`/`recallAtK` already emitted by `packages/indexer/src/retrieval-quality.ts`; `boilerplateReadNoiseRatio` added to `evals/memory-retention/scenario.test.ts` S5
- [x] M2 baseline numbers (below)

## Baseline benchmark numbers (pre-Tier-1, captured 2026-10-17)
- retrieval-quality (openbuff-repository-retrieval-v2, k=3, 20 docs / 18 queries):
  - recallAtK = 0.972222
  - meanReciprocalRank = 0.972222
  - nDCG@K = 0.97395
  - noiseRateAtK = 0.648148
- memory-retention eval: 6/6 pass (S1-S6); S5 observed compiledEvidenceCount=2, readEvidenceCount=2, boilerplateReadNoiseRatio=1.0 (stale entry correctly excluded; all surviving evidence is read-kind bookkeeping)

## Pending
- [x] M0 session artifacts
- [x] M1 benchmark metrics
- [x] M2 baseline numbers
- [ ] M3–M6 Tier 1A–1D edits
- [ ] M7 validation
- [ ] M8 post-fix numbers + LESSONS

## Baseline benchmark numbers
(to be filled after M1 harness lands and baselines run)

## Post-fix benchmark numbers
(pending)

## Blockers
(none)
