# Audit findings: p3-coherence-e-pagerank-tokens

- Subsystems: packages/indexer, packages/agent-runtime-util-token-counter, scripts-perf-baseline, scripts-calibrate-openai-tokens, plan-doc-polyglot-roadmap-v2
- Features: P3-T9-ranked-repo-map-pagerank, P3-T10-exact-tokenizers
- Files covered: 12

## [LOW] correctness — packages/indexer/src/pagerank.ts:30 — P3-T9 VERDICT: MATCHES (a) personalized PageRank is deterministic and bounded-work
- **Risk:** None observed: the algorithm matches the plan text (personalized PageRank over the precise graph, deterministic, capped).
- **Fix:** No action — implementation matches the plan's P3-T9 claim.
- **Evidence:** pagerank.ts:30-77 (params doc + clamp constants), :116 'const nodeIds = Array.from(adjacency.keys()).sort()' (deterministic order), :88-92 node-count guard, :160-215 bounded power iteration with L1 delta break. query.ts:35-44 (QueryOptions.pageRankWeight), :185/:198/:245 (pageRankWeight threaded through querySearch), :684-720 blendPageRankScores (seeds = lexical hits, additive pageRankWeight x pageRank, per-file contribution bounded by weight). Tests: packages/indexer/src/pagerank.test.ts:235-271 pin default damping, clamps; :360-376 pin default == weight 0 and boost changes ranking.

## [LOW] correctness — packages/indexer/src/query.ts:684 — P3-T9 VERDICT: MATCHES (b) pageRankWeight default 0 is genuinely a no-op — byte-identical ranking
- **Risk:** None observed: the default path truly adds nothing (not even a matchedOn 'graph' tag or a PageRank computation), so scores and ordering are byte-identical before/after the feature.
- **Fix:** No action.
- **Evidence:** query.ts:684-700 blendPageRankScores opens with 'if (pageRankWeight <= 0 || !Number.isFinite(pageRankWeight) || directResults.size === 0) return' — no getPageRankAdjacency call, no score write, no matchedOn change at weight 0; the function is otherwise additive (result.score += pageRankWeight * pageRank). Doc comment at query.ts:35-44 states 'Default: 0 (opt-in) — omitting it keeps ranking byte-identical'. pagerank.test.ts:360-365 asserts queryIndex(...) === queryIndex(..., { pageRankWeight: 0 }).

## [LOW] api-contract — packages/indexer/src/index-manager.ts:406 — P3-T9 residual: IndexManager.query/queryBlended option types still omit pageRankWeight
- **Risk:** IndexManager.query/queryBlended (and therefore CLI/MCP surfaces routed through IndexManager) cannot opt in to PageRank ranking; only direct queryIndex callers can. The earlier audit finding (p3-c-indexer.md, index-manager.ts:406) is still open — the plan says 'wired into query_index', which is technically satisfied via queryIndex itself, but the higher-level manager path is not.
- **Fix:** Either add pageRankWeight to the IndexManager option types or document in query.ts/index-manager that the PageRank opt-in is a direct-queryIndex-only knob until wired. Still consistent with the ACCEPTED note (no production consumer exists at all), so LOW.
- **Evidence:** code_search for pageRankWeight across packages/indexer/src/index-manager.ts and types.ts returns 0 matches; query.ts:185/:198/:245 show pageRankWeight flows only through the direct queryIndex entry point. Earlier shard finding p3-c-indexer.md [LOW] flagged the same gap (index-manager.ts:406) and STATUS.md:344 lists other P3 remediations but not this one.

## [LOW] api-contract — packages/indexer/src/repo-map.ts:108 — P3-T9 VERDICT: MATCHES (c) rankedRepoMap exported eval-only, no production consumer — and documented as ACCEPTED, not silent dead code
- **Risk:** None: the dead-code state is explicitly accepted in the plan and honestly labeled in the module docs, so it is not silently dead.
- **Fix:** No action — the acceptance is documented, not silent dead code.
- **Evidence:** repo-map.ts:100-142 rankedRepoMap (P3-T9 doc comment, PageRank options pass-through, score-desc/path-asc sort); index.ts:44 re-export; referencedBy for rankedRepoMap lists only packages/indexer/src/pagerank.test.ts (:11, :403-426); no cli/src or sdk/src references found. PLAN.md:107 '(DONE: landed — opt-in pageRankWeight, default byte-identical. ACCEPTED: rankedRepoMap remains an exported eval utility with no production consumer.)'; STATUS.md:325 describes it identically. repo-map.ts:80-84 buildRepoMap is also explicitly 'Prototype-only ... not used by the default query_index path'.

## [LOW] correctness — packages/indexer/src/pagerank.ts:60 — P3-T9 VERDICT: MATCHES (d) damping clamp is now EXCLUSIVE of 1 (earlier audit non-convergence risk fixed), with iteration/epsilon/node caps
- **Risk:** None observed: the earlier damping-clamp admitted exactly 1.0 = non-convergence risk is remediated.
- **Fix:** No action.
- **Evidence:** pagerank.ts:60-77 MIN_PAGERANK_DAMPING=1e-6, MAX_PAGERANK_DAMPING=1-1e-6 with the EXCLUSIVE doc comment; :222-233 sanitize clamps into [min,max]. pagerank.test.ts:239-271 'clamps damping into (0, 1) exclusive (damping 1 never converges)' asserts damping:1 output === damping:1-1e-6 output and damping:0 === 1e-6. maxIterations clamped [1,200] (:55-57), epsilon floored at 1e-12 (:58-59), MAX_PAGERANK_NODES=50_000 skips iteration above the cap (:88-92).

## [LOW] correctness — packages/indexer/src/pagerank.ts:136 — P3-T9 VERDICT: MATCHES (e) PageRank adjacency cache is WeakMap-bounded per immutable index object
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** pagerank.ts:136-168 pageRankAdjacencyCache = new WeakMap<MetadataIndex, Map<string, PageRankEdge[]>>() with the same immutable-index/WeakMap-per-revision rationale as query.ts's adjacencyCache (query.ts:117-119 + getAdjacency :808-816).

## [LOW] correctness — packages/indexer/src/repo-map.ts:15 — P3-T9 VERDICT: MATCHES (f) code-point ordering, not localeCompare, in repo-map paths (earlier remediation landed)
- **Risk:** None observed: the earlier repo-map localeCompare remediation has landed in this slice's files.
- **Fix:** No action for this slice.
- **Evidence:** repo-map.ts:11-18 'Deterministic code-point string comparison (locale-independent). ICU's localeCompare is environment-dependent...' compareStrings uses a<b/a>b; used at :92 (buildRepoMap sort), :139 (rankedRepoMap score-desc + compareStrings tie-break). code_search for localeCompare in packages/indexer/src/repo-map.ts returns no comparison uses. Note: localeCompare remains elsewhere in the repo (e.g. common/src/mcp/client.ts:597, agents/base2/gate-committed-surface.ts) — outside this shard's slice.

## [LOW] correctness — packages/agent-runtime/src/util/token-counter.ts:132 — P3-T10 VERDICT: MATCHES (a) ExactTokenCounter seam + OPENBUFF_EXACT_TOKENS truthy gate; flag-off = estimator byte-identical with 1.35/1.0/1.1 fudge factors still active
- **Risk:** None observed: the seam matches the plan's DEFERRED note — the gate exists, providers do not.
- **Fix:** No action.
- **Evidence:** token-counter.ts: 'export interface ExactTokenCounter' + TokenizerFamily type; registerExactTokenCounter/clearExactTokenCountersForTest/exactTokenCounterForModel dispatch; exactTokenCountingEnabled reads process.env.OPENBUFF_EXACT_TOKENS with /^(1|true|yes|on)$/i truthy test, deliberately not module-cached, doc: 'unset/off keeps the gpt-tokenizer + fudge estimator byte-identical'. countTokens: exact path entered only when 'model !== undefined && exactTokenCountingEnabled()' AND a provider matches; every miss falls through to estimateTokensForSerialized. Flag-off: ANTHROPIC_TOKEN_FUDGE_FACTOR=1.35 / OPENAI=1.0 / GEMINI=1.1 constants and fudgeFactorForModel are unchanged and applied on every path (incl. the capped-sample extrapolation and the chars/3 error fallback). No production registration exists: referencedBy for registerExactTokenCounter lists only packages/agent-runtime/src/util/__tests__/token-counter.test.ts — consistent with 'tiktoken/HF providers stay dependency-gated' (no tiktoken/HF dependency present).

## [LOW] correctness — packages/agent-runtime/src/util/token-counter.ts:195 — P3-T10 VERDICT: MATCHES (b) getTokenizerForModel family cache exists (bounded 1000-entry LRU)
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** token-counter.ts TOKENIZER_FAMILY_CACHE = new LRUCache<string, TokenizerFamily>(1000) with bounded-churn doc; getTokenizerForModel memoizes resolveTokenizerFamily; exactFamilyMatcher routes matcher dispatch through the cache; tokenizerFamilyCacheSizeForTest exported for bound assertions. Production consumers: none yet (tests only) — expected for a seam whose providers are deferred.

## [LOW] test-coverage — scripts/measure-perf-guards-baseline.ts:1100 — P3-T10 VERDICT: MATCHES (c) CASE 6c 5MB pathological estimator row exists, is bounded, and is falsifiable — measures what D12 asked
- **Risk:** None observed: the row is exactly the D12 ask — the pathological input that stalls gpt-tokenizer, measured with bounded BPE work.
- **Fix:** No action.
- **Evidence:** measure-perf-guards-baseline.ts runCase6 CASE 6c: buildBlockBody(5 * 1024 * 1024) aperiodic body (20k balanced prelude + rotating 15k mono-density code/prose/separator/comment blocks, 60k rotation > 20k sample); pathologicalEstimator BPE-encodes ONLY text.slice(0, 20_000) ('the body is never BPE-encoded'); accuracy validated against an independently computed full-BPE count of an 80k sibling within 8% tolerance, with two falsifiability guards asserted to MISS (naive chars/3, unrepresentative wrong-window sample) so the check CAN fail; boundedness guard throws if median > 2000 ms/op ('the >2min full-BPE CI stall this row guards against'). Header comment maps '5MB pathological estimator (D12/P3-T10 ... own pass/fail, no parity row) ........ CASE 6c'.

## [LOW] test-coverage — scripts/package.json:22 — P3-T10 VERDICT: MATCHES (d) calibrate-openai-tokens.ts exists and is registered as a repo script
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** scripts/calibrate-openai-tokens.ts exists (374 lines): compares countTokens/countTokensJson with model 'openai/gpt-4o' against POST https://api.openai.com/v1/responses/input_tokens, prints per-workload ratios + aggregate + verdict, 'EVIDENCE-GENERATING ONLY: this script never edits the fudge factor and never flips a flag', network-gated on OPENAI_API_KEY and import.meta.main-guarded. scripts/package.json:22 '"calibrate:openai-tokens": "bun run calibrate-openai-tokens.ts"'. Hermetic unit test scripts/__tests__/calibrate-openai-tokens.test.ts injects mocked fetch.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:108 — P3-T10 COHERENCE (e): [ ] checkbox is accurate — remaining work is correctly scoped — but the '(DONE: ...)' prefix inside an unchecked item is self-contradictory phrasing
- **Risk:** Two conflicting signals in one line: the checkbox says pending while the parenthetical says DONE; a skimmer reading only 'DONE:' could over-count the task as complete, while the checkbox alone under-communicates that a real seam + X-2 row landed. Substance is accurate either way.
- **Fix:** Rephrase the P3-T10 parenthetical from '(DONE: ...)' to '(PARTIAL: seam + flag + CASE 6c landed; providers and the fudge-factor flip remain)' and drop the future-tense 'lands this wave' for CASE 6c. No source change needed.
- **Evidence:** PLAN.md:108 '[ ] P3-T10 ... (DONE: the ExactTokenCounter seam + flag landed; the X-2 5MB pathological estimator row lands this wave (CASE 6c ...). DEFERRED: tiktoken/HF providers stay dependency-gated; the fudge factors remain active pending the eval-confirmed flip per plan. UNBLOCK PATH: scripts/calibrate-openai-tokens.ts is the evidence-generating harness ...)'. Source confirms every clause: seam+gate landed (token-counter.ts), CASE 6c landed (measure-perf-guards-baseline.ts), no tiktoken/HF dependency, fudge factors 1.35/1.0/1.1 active, harness present and registered. The remaining work is accurately scoped: it is exactly the task's own headline that is incomplete (HF tokenizer.json per open-weight model + tiktoken for OpenAI families + 'Remove the fudge factors behind an eval-confirmed flag'), so the unchecked [ ] is honest. Minor wording inconsistencies: (1) the '(DONE: ...)' label inside an UNCHECKED item reads ambiguously to a checkbox-skimmer — sibling tasks use 'DONE' only on [x] items (P3-T3/T4/T9) and 'PARTIAL' for incomplete gates (P3-T2); 'PARTIAL:' or 'PARTIAL (seam landed):' would remove the ambiguity; (2) 'the X-2 5MB pathological estimator row lands this wave' is future tense although CASE 6c already exists in source (verified) — tense, not substance.

## [LOW] dependency-hygiene — packages/agent-runtime/package.json:30 — P3-T10 (f): gpt-tokenizer exact-version pin (audit dependency-hygiene deferral) is still open — caret ^2.8.1 resolves to 2.9.0 in bun.lock
- **Risk:** A caret bump to a future gpt-tokenizer minor could change count behavior or the allowedSpecial error semantics that token-counter.ts documents and tests pin, silently shifting compaction-trigger estimates; the audit's deferred exact-version pin has not landed.
- **Fix:** Pin gpt-tokenizer to the resolved exact version (2.9.0) in packages/agent-runtime/package.json (or record the pin as an explicit deferral with rationale in the plan), so the 2.9.0-behavior comment and test pins cannot drift under a caret bump.
- **Evidence:** packages/agent-runtime/package.json:30 '"gpt-tokenizer": "^2.8.1"'; bun.lock:135 + :994 resolve gpt-tokenizer@2.9.0. token-counter.ts BPE_SPECIAL_TOKEN_ESCAPE comment claims 'allowedSpecial:"none" is not a valid value in gpt-tokenizer 2.9.0 — it throws TypeError' — behavior pinned to the resolved minor while the declared range permits future minors. Language-fit audit cb-rt-util [LOW] recommended 'Pin gpt-tokenizer and ai to exact versions'; no pin landed. Consistency with plan: P3-T10's 'Keep the TS gpt-tokenizer path as the fallback tier' is satisfied (the estimator IS the current path), but the pin itself is plan-silent and remains open.

## Coverage receipt

### Subsystems
- packages/indexer
- packages/agent-runtime-util-token-counter
- scripts-perf-baseline
- scripts-calibrate-openai-tokens
- plan-doc-polyglot-roadmap-v2

### Features
- P3-T9-ranked-repo-map-pagerank
- P3-T10-exact-tokenizers

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- packages/agent-runtime/package.json
- packages/agent-runtime/src/util/token-counter.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index.ts
- packages/indexer/src/pagerank.test.ts
- packages/indexer/src/pagerank.ts
- packages/indexer/src/query.ts
- packages/indexer/src/repo-map.ts
- scripts/calibrate-openai-tokens.ts
- scripts/measure-perf-guards-baseline.ts
- scripts/package.json

### Domains
- correctness
- api-contract
- dependency-hygiene
- test-coverage
