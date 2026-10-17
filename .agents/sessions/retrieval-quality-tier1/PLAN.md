# PLAN — Retrieval & Memory Quality Tier 1

## Milestones
- [ ] M0: Session artifacts (SPEC.md, PLAN.md, STATUS.md)
- [ ] M1: Benchmark harness — noise-ratio + recall@k in retrieval-quality eval and memory-retention eval
- [ ] M2: Baseline numbers captured into STATUS.md
- [ ] M3: Tier 1A code-map tf×IDF token scoring
- [ ] M4: Tier 1B code-map call dedup/rank + @import.call leak fix
- [ ] M5: Tier 1C indexer graph-expansion restriction + deterministic tie-break
- [ ] M6: Tier 1D task-memory curated write-path + rationale gate + hash dedup
- [ ] M7: Validation (typecheck + targeted tests per package)
- [ ] M8: Post-fix benchmark numbers recorded; STATUS/LESSONS reconciled

## Tasks
- [ ] P1 Write PLAN.md/STATUS.md scaffolding (current task)
- [ ] P2 Add `noiseRatio` + `recallAtK` metrics to `packages/indexer/src/retrieval-quality.test.ts` harness and `evals/memory-retention/scenario.test.ts` reporting (boilerplate-read noise ratio for compiled context). Run baselines with bun test, record numbers in STATUS.md.
- [ ] P3 Tier 1A: `packages/code-map/src/parse.ts` — keep per-capture counts; score = tf-in-file × IDF-style `log(N/(1+filesContaining))`; remove `boostScoresByExternalCalls` popularity multiplier (fold into IDF); update `parse.test.ts` deliberately. Keep same-language caller rule and public function signatures where possible.
- [ ] P4 Tier 1B: `packages/code-map/src/chunks.ts` + `structure.ts` — dedup chunk calls by name (min line + count, sorted by count desc, then line); per-language stoplist extension of IGNORE_TOKENS; exclude `import.`-prefixed captures from call sites in structure.ts:941; rank-then-cap with kept/total truncation metadata where the schema allows. Update chunks.test.ts cap assertions deliberately.
- [ ] P5 Tier 1C: `packages/indexer/src/query.ts` — restrict `getRelatedFiles` second-hop expansion to file↔file edges (references/calls/resolved imports); require concept/import tokens to appear in query tokens otherwise; deterministic tie-break by path on final sort; skip reciprocal relatedFiles pairs. Update query.test.ts graph-boost/related reasons assertions deliberately.
- [ ] P6 Tier 1D: `packages/agent-runtime/src/util/task-memory.ts` + `sdk/src/services/task-memory-store.ts` + `common/src/util/decision-rationale.ts` — stop deriving durable `read` evidence from whole-file read_files results (keep `edit` evidence; reads capped ephemeral, e.g. last 8, dropped on merge); require rationale clause in hasDecisionRationale (reject bare keyword matches); content-hash dedup (stableHash of kind+normalized summary) at write and merge; stop round-trip echo of compiled <knowledge_memory> blocks into the draft. Update task-memory tests + retention evals S5/S6 budgets deliberately while keeping S3/S4 staleness semantics.
- [ ] P7 Validation: `bun run typecheck` at repo root (or per touched package), then `bun test` for packages/code-map, packages/indexer, packages/agent-runtime (task-memory suites), sdk (task-memory-store), evals (memory-retention). Repair exact failures only.
- [ ] P8 Record post-fix benchmark numbers in STATUS.md; add LESSONS.md entries.

## Dependencies
P2 → P3..P6 (baseline must exist first). P3/P4 share code-map tests but different files — run as separate edit transactions; P5 and P6 are independent. P7 after all edits.

## Risks
- Retrieval quality may regress on the existing DCG fixture — benchmark first makes this visible.
- parse.test.ts pins "every capture is a token" contract; scoring change must keep the token *set* stable and only reweight, unless tests are deliberately updated.
- Task-memory read-evidence removal touches evals/memory-retention S2 (warm retention expects read evidence); keep reads available in-session via working set so S2 still passes.
- The retention eval S6 pins MEMORY_V2_CONTEXT_MAX_CHARS === 12000 — Tier 1D does not change V2 caps; only V1 write-path.

## Validation gates
- Baseline + post-fix benchmark numbers must both be present in STATUS.md.
- All targeted package tests green or failures explicitly scoped with reason.