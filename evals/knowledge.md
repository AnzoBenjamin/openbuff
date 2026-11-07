For the evals package, please check the results by running the typechecker only for this package. No need to typecheck everything else:

cwd: evals

> bun run typecheck

- _Knowledge refresh 2026-10-28 (compaction-fidelity F1 fixture staleness guard touch): touched evals — `evals/compaction-fidelity/scenario.test.ts` fixture bodies now carry padding (`'context filler '.repeat(250)`) after each planted fact: the truncation wave-1 identity-carrying eviction tombstone (~220 chars) is LONGER than the bare fact line, so evicting an unpadded body was net-NEGATIVE and the minSavingsTokens floor correctly no-oped (probe: evictedCount 0, tokensSaved 0), leaving F1's `evictedCount > 0` assertion failing. With padding the probe shows 12 evictions / 7,806 tokens saved and all six cited results kept full with their planted facts intact; suite F1–F5 5/5. This entry keeps `evals/knowledge.md` newer than its sibling for the pre-push memory-drift guard._
