# Audit findings: cb-evals-infra

- Subsystems: evals, scripts, .github, packages
- Features: eval-statistics, significance-gated-promotion, llm-judge, judge-calibration, deterministic-signals, eval-fleet-orchestration, external-agent-runners, test-repo-setup, llm-analyzers-lessons, retrieval-analytics-store, compare-runs, compaction-retention-eval, mutation-gate, perf-measurement, static-guards, ci-local-mirror, harness-language-server, codegen-structural-map, tmux-harness, eval-workflows, rust-workspace-ci, provider-sdks, build-tools-executor, per-language-eval-strata
- Files covered: 31
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] correctness — evals/buffbench/statistics.ts:155 — Eval statistics (Wilcoxon/bootstrap): KEEP TS for gating + ADD Python/scipy parity oracle (not a runtime sidecar)
- **Risk:** wilcoxonSignedRankTest always uses the normal approximation (z with continuity+tie correction, erf A&S 7.1.26). BuffBench task sets are small (tens of tasks, repeats default 1), where the normal approx p-value is materially off vs the exact null distribution; promotions gated on p<=0.05 can flip. Bootstrap uses a single percentile CI (no BCa), which undercovers at small n. A Python stats sidecar (P8-T4) as a runtime dependency would add process/IPC + toolchain cost for ~200 lines of math.
- **Fix:** NOW: keep the dependency-free TS module (deterministic, seeded mulberry32, already imported by proposals.ts). Add an exact Wilcoxon path for n<=~25 (enumerate 2^n or DP over rank sums, trivial in TS) and optionally BCa. Add a CI fixture test whose expected p-values/CI bounds were generated once by scipy.stats.wilcoxon / scipy.stats.bootstrap (checked-in JSON, no Python at CI runtime). LATER: Python (scipy/statsmodels/pandas) as an OFFLINE analysis notebook/CLI over logs JSONL for mixed-effects models (task random effect, per-language strata) — not a sidecar in the gate path. Recommend P8-T4 be rescoped to 'offline oracle + reports'.
- **Evidence:** statistics.ts:1-6 (no npm imports policy), :70-112 bootstrap percentile CI, :155-213 normal-approx Wilcoxon; consumers proposals.ts decideProposalPromotion, run-buffbench.ts:15 standardError. Cost: exact-Wilcoxon + oracle fixture ~0.5-1 day; Python sidecar ~1-2 weeks + CI toolchain. Confidence: high on mechanism; medium on magnitude. Web-verify: scipy.stats.wilcoxon method='auto' exact threshold (believed n<=50, no ties/zeros in recent SciPy).

## [MEDIUM] correctness — evals/buffbench/proposals.ts:379 — Significance-gated proposal promotion: KEEP TS, flip requireSignificance default on
- **Risk:** defaultPromotionPolicy gates only on totalScoreDelta>=0.25 (a sum across agents, no variance) and no-regression flags; the Wilcoxon+bootstrap gate is opt-in (policy.requireSignificance). With judge noise, promotions can be accepted on noise. No multiple-comparison control when several agents/proposals are evaluated.
- **Fix:** Keep in TS (pure, co-located with ProposalSchema/zod). Default requireSignificance=true once pairedScores are always emitted by runBuffBench repeats; add Holm-Bonferroni across agents; require repeats>=3 for promotion. This is the 'significance-gated promotions' unlock and needs no new language.
- **Evidence:** proposals.ts:379-383 default policy; :385-445 decideProposalPromotion (significance optional, fail-closed only if enabled); run-buffbench.ts:670-682 repeats=1 default. Cost ~1 day. Confidence high.

## [LOW] correctness — evals/buffbench/judge.ts:338 — LLM judge pipeline: KEEP TS
- **Risk:** None language-related; judge runs as an OpenbuffClient agent with zod JudgingResultSchema and deterministic clamps. Inspect AI (Python) would duplicate the SDK/agent-definition surface.
- **Fix:** Keep. Optionally export judge I/O as Inspect-compatible log format later for external comparability; do not port.
- **Evidence:** judge.ts:49-94 JudgingResultSchema, :247-336 runSingleJudge, :338-507 judgeCommitResult via @openbuff/sdk. Cost 0. Confidence high. Web-verify: Inspect AI log schema stability.

## [LOW] test-coverage — evals/buffbench/judge-calibration.ts:53 — Judge gold-set calibration: KEEP TS
- **Risk:** Agreement is range-hit rate only; no chance-corrected agreement.
- **Fix:** Keep TS; optionally add Spearman/Kendall vs gold ordinal scores (tiny pure functions). No Python needed.
- **Evidence:** judge-calibration.ts:53-93 evaluateCalibration (threshold 0.75). Cost <0.5 day. Confidence high.

## [LOW] correctness — evals/buffbench/deterministic-signals.ts:112 — Deterministic judge signals/clamps: KEEP TS
- **Risk:** Token heuristics already cover cargo/go/ruff/rubocop/dotnet; classification by command string is language-agnostic.
- **Fix:** Keep. For per-language strata, tag FinalCheckOutput with a language field instead of inferring.
- **Evidence:** deterministic-signals.ts:78-99 tokens, :112-125 classifyCommand, :222-269 clamp. Cost 0. Confidence high.

## [MEDIUM] performance — evals/buffbench/run-buffbench.ts:661 — Eval fleet orchestration: KEEP TS + CONTAINERIZE/SHARD (support D39, drop Go P8-T3)
- **Risk:** Throughput is bound by LLM latency (60-min per-task timeout), git shallow fetch, and a single 6h GH runner at taskConcurrency=1 — not by orchestrator CPU. A Go fleet runner would re-implement p-limit/zod/SDK wiring and the OpenbuffClient in-process runner (CodebuffRunner needs the TS SDK), creating a second orchestration codebase with no measured bottleneck it fixes.
- **Fix:** NOW: shard tasks across a GH Actions matrix (task-id slices -> runBuffBench taskIds) and raise taskConcurrency; run each task in a Docker container (repo+binInstalls baked) for isolation. LATER: if >1 host is needed, use an existing queue (GH matrix, k8s Jobs, Modal) driving the same TS entrypoint, not a bespoke Go daemon. Revisit Go only if profiling shows orchestrator overhead.
- **Evidence:** run-buffbench.ts:661-683 taskConcurrency=1, repeats=1; agent-runner.ts:93 60-minute timeout, :96-130 runner selection incl. in-process CodebuffRunner; buffbench.yml / nightly-evals.yml single job timeout-minutes 360. Cost: matrix sharding ~1-2 days; containerization ~1 week; Go fleet ~3-6 weeks. Confidence high that Go is unnecessary.

## [LOW] correctness — evals/buffbench/runners/claude.ts:83 — External agent runners (claude/codex/opencode): KEEP TS
- **Risk:** Subprocess + stream-json parsing is idiomatic in Node/Bun. Note: stdout chunks are split on newlines without carrying a partial-line buffer, so a JSON event spanning two chunks is appended as text (not a language issue).
- **Fix:** Keep TS; add a line carry buffer (readline over child.stdout).
- **Evidence:** runners/claude.ts:83-143 per-chunk split/JSON.parse, catch appends raw line; runners/runner.ts Runner interface. Cost <0.5 day. Confidence high.

## [LOW] correctness — evals/buffbench/setup-test-repo.ts:102 — Test repo setup (git clone/fetch): KEEP TS
- **Risk:** execFileSync git with retry is fine; shell would lose the self-clone guard and typed tests. Logs 10-char token prefix (hygiene, not language).
- **Fix:** Keep; for containerized fleet, pre-bake repos at parentSha into images/cache instead of per-run fetch.
- **Evidence:** setup-test-repo.ts:47-75 retry, :120-139 file:// self-clone guard, :193-194 token prefix log. Cost 0. Confidence high.

## [LOW] correctness — evals/buffbench/lessons-extractor.ts:172 — LLM analyzers (trace/meta/lessons extractor): KEEP TS now; Python DSPy evolve LATER as offline optimizer
- **Risk:** These are SDK agents (gpt-5) with structured output; porting gains nothing now. DSPy/GEPA-style prompt evolution is Python-native and would be an offline loop.
- **Fix:** Keep TS. LATER: offline Python DSPy job that reads logs JSONL + proposals and emits append_system_prompt_guidance proposals, which re-enter the TS applyProposals + significance gate.
- **Evidence:** lessons-extractor.ts:32-168 agent def, :172-285 extractAgentLessons; trace-analyzer.ts:37-40; meta-analyzer.ts:1-40. Cost DSPy loop ~1-2 weeks. Confidence medium. Web-verify: DSPy optimizer (GEPA/MIPROv2) current API.

## [LOW] performance — evals/buffbench/retrieval-analytics-store.ts:13 — Retrieval analytics JSONL store: KEEP JSONL writer; CONSUME DuckDB for analysis
- **Risk:** Append-only JSONL is correct for writers; cross-run analysis currently needs bespoke TS scripts.
- **Fix:** Keep writer. Query with DuckDB (read_json_auto over .agents/analytics/*.jsonl and eval logs) from CLI/Python; no new service.
- **Evidence:** retrieval-analytics-store.ts:13-29 appendFileSync JSONL schemaVersion 1. Cost ~0.5 day for queries. Confidence high.

## [LOW] correctness — evals/buffbench/compare-runs.ts:76 — Before/after run comparison: KEEP TS
- **Risk:** Deltas are mean differences without variance; totals sum across agents. Statistical judgement belongs in the significance gate.
- **Fix:** Keep; surface standardError and n per agent in AgentRunDelta.
- **Evidence:** compare-runs.ts:76-184 compareRuns thresholds (-0.01, 20% cost). Cost <0.5 day. Confidence high.

## [LOW] test-coverage — evals/compaction-retention/scenario.test.ts:286 — Compaction retention scenario eval: KEEP TS
- **Risk:** Must drive agents/context-pruner.ts handleSteps in-process; any other language cannot.
- **Fix:** Keep; optionally emit the metrics table as JSON for DuckDB trend tracking.
- **Evidence:** scenario.test.ts:31-33 imports contextPruner, :286-316 runHandleSteps generator loop, S1-S11. Cost 0. Confidence high.

## [MEDIUM] test-coverage — scripts/run-mutation-gate.ts:1 — Mutation gate: CONSUME StrykerJS (TS), cargo-mutants (rust/), mutmut (future Python)
- **Risk:** The 'mutation gate' is only an env-setting spawn wrapper (OPENBUFF_MUTATION_GATE=1); there is no mutation engine, so test-suite strength is unmeasured.
- **Fix:** Adopt StrykerJS with the command runner (bun test) scoped to high-value pure modules (statistics.ts, deterministic-signals.ts, proposals.ts, context-pruning) with incremental mode; cargo-mutants in rust-workspace.yml once real crates exist; mutmut for any Python oracle. Keep the wrapper as the entrypoint.
- **Evidence:** run-mutation-gate.ts:1-18 spawn with env only. Cost StrykerJS setup ~1-2 days; CI time significant (nightly only). Confidence high on gap. Web-verify: StrykerJS Bun support (no native bun runner believed; command runner works).

## [LOW] performance — scripts/measure-perf-guards-baseline.ts:1 — Perf baselines (measure-*.ts): KEEP TS for in-process microbench; CONSUME hyperfine for process-level rows
- **Risk:** Rows must call shipped TS functions (parseStreamChunk, cachedRegExp), which hyperfine cannot; but the manual-only cold-start rows are exactly hyperfine's use case.
- **Fix:** Keep hand-rolled median/MAD harness (or mitata). Add hyperfine --warmup for CLI cold-start in nightly, exporting JSON.
- **Evidence:** measure-perf-guards-baseline.ts:1-67 (median/MAD, manual-only cold-start/TUI rows at :50-56). Cost ~0.5 day. Confidence high.

## [LOW] correctness — scripts/determinism-guard.ts:1 — Static guards (determinism/memory-drift/byok): KEEP TS; optional ast-grep for AST precision
- **Risk:** Regex/line scanning with baselines works; AST matching would reduce marker-window false negatives.
- **Fix:** Keep TS; consider ast-grep rules for Date.now/randomUUID if false positives appear.
- **Evidence:** determinism-guard.ts:1-80 regex+baseline+8-line marker window; memory-drift-guard.ts CHECKERS 1274-1290 (git + markdown checks). Cost 0. Confidence high.

## [LOW] dependency-hygiene — scripts/check-ci-local.ts:353 — Local CI mirror: KEEP TS (act not a replacement)
- **Risk:** act would need Docker and secrets and still diverge; the TS script runs targeted steps with locks/timeouts.
- **Fix:** Keep; optionally document act for workflow-syntax smoke only.
- **Evidence:** check-ci-local.ts:16-26 tracked paths/steps, :127-241 lock, :353-437 runCiLocalChecks. Cost 0. Confidence medium. Web-verify: act service-container/secret parity.

## [LOW] correctness — scripts/harness-language-server.ts:14 — Harness language-server adapter: KEEP (trivial argv wrapper)
- **Risk:** None; shell:false argv spawn is safer than a shell script equivalent.
- **Fix:** Keep.
- **Evidence:** harness-language-server.ts:1-19. Cost 0. Confidence high.

## [LOW] correctness — scripts/generate-tool-definitions.ts:13 — Codegen + structural map: KEEP TS
- **Risk:** Both import TS sources (compileToolDefinitions, @codebuff/indexer, audit-intelligence); must stay TS.
- **Fix:** Keep; replace execSync npx prettier string with execFileSync argv.
- **Evidence:** generate-tool-definitions.ts:7,52-56; build-structural-map.ts:33-34 imports. Cost 0. Confidence high.

## [LOW] correctness — scripts/tmux/tmux-send.sh:319 — tmux TUI harness: KEEP shell
- **Risk:** Shell is the natural fit for tmux send-keys; YAML escaping via sed/echo is fragile for multiline text.
- **Fix:** Keep; emit JSONL via jq instead of hand-escaped YAML if logs are machine-read.
- **Evidence:** tmux-send.sh:79-336, :319-331 YAML escaping. Cost minimal. Confidence high.

## [MEDIUM] dependency-hygiene — .github/workflows/buffbench.yml:17 — Eval workflows (buffbench/nightly-evals): KEEP YAML; fix Bun drift + pin actions + add matrix
- **Risk:** Workflows pin bun 1.3.5 while evals/package.json engines requires bun 1.3.11; buffbench/nightly use tag refs (@v6,@v2,@v5) while ci.yml SHA-pins; secrets passed via toJSON(secrets). Single 6h job caps fleet size.
- **Fix:** Align bun-version with engines, SHA-pin actions, add strategy.matrix sharding over task ids and upload per-shard JSON for merge + significance gating.
- **Evidence:** buffbench.yml:14-17,34-35; nightly-evals.yml:17-20,36-37; evals/package.json engines bun 1.3.11; ci.yml:24-29 SHA pins. Cost ~0.5-1 day. Confidence high.

## [LOW] test-coverage — .github/workflows/rust-workspace.yml:18 — Rust workspace CI: KEEP
- **Risk:** Build+test only; no mutation or benchmarks yet.
- **Fix:** Add cargo-mutants nightly once first real crate ships.
- **Evidence:** rust-workspace.yml:18-38. Cost 0. Confidence high.

## [LOW] dependency-hygiene — packages/internal/src — Vendored provider SDKs (openai-compatible, openrouter-ai-sdk): KEEP TS (skimmed)
- **Risk:** Must plug into the AI SDK LanguageModel interface in-process; no alternative language applies. Skimmed via structure only.
- **Fix:** Keep; track upstream @ai-sdk/openai-compatible to reduce fork drift.
- **Evidence:** packages/internal/src tree: openai-compatible/chat/openai-compatible-chat-language-model.ts, openrouter-ai-sdk/chat/index.ts (structure only, not line-read). Cost 0. Confidence medium.

## [LOW] dependency-hygiene — packages/build-tools/executors/infisical-run/executor.ts:22 — Nx Infisical executor: KEEP TS
- **Risk:** Nx executors are TS by contract.
- **Fix:** Keep.
- **Evidence:** executor.ts:22-61. Cost 0. Confidence high.

## [MEDIUM] test-coverage — evals/buffbench/run-buffbench.ts:476 — Per-language eval strata: CONSUME SWE-bench/Multi-SWE-bench harness (Python+Docker) as external strata
- **Risk:** Eval sets (eval-codebuff/manifold/plane/saleor) are few repos; no per-language stratification in results; polyglot claims are unmeasured. Building per-language Docker envs in-house duplicates SWE-bench harness work.
- **Fix:** NOW: add a language tag to EvalCommitV2 and stratify summaries/significance per language. NEXT: wrap SWE-bench (Python/Docker) and Multi-SWE-bench as an external runner that invokes the CLI in its containers, feeding results into the TS judge/stats. Python lives only in that harness.
- **Evidence:** run-buffbench.ts:476-493 EvalCommitV2/EvalDataV2 schemas (no language field); evals/package.json test:swe-bench script exists. Cost tagging ~1 day; SWE-bench integration ~1-2 weeks. Confidence medium. Web-verify: Multi-SWE-bench language coverage and harness CLI.

## Coverage receipt

### Subsystems
- evals
- scripts
- .github
- packages

### Features
- eval-statistics
- significance-gated-promotion
- llm-judge
- judge-calibration
- deterministic-signals
- eval-fleet-orchestration
- external-agent-runners
- test-repo-setup
- llm-analyzers-lessons
- retrieval-analytics-store
- compare-runs
- compaction-retention-eval
- mutation-gate
- perf-measurement
- static-guards
- ci-local-mirror
- harness-language-server
- codegen-structural-map
- tmux-harness
- eval-workflows
- rust-workspace-ci
- provider-sdks
- build-tools-executor
- per-language-eval-strata

### Files
- evals/package.json
- evals/compaction-retention/scenario.test.ts
- evals/buffbench/statistics.ts
- evals/buffbench/judge.ts
- evals/buffbench/judge-calibration.ts
- evals/buffbench/run-buffbench.ts
- evals/buffbench/agent-runner.ts
- evals/buffbench/setup-test-repo.ts
- evals/buffbench/runners/runner.ts
- evals/buffbench/runners/claude.ts
- evals/buffbench/deterministic-signals.ts
- evals/buffbench/compare-runs.ts
- evals/buffbench/proposals.ts
- evals/buffbench/trace-analyzer.ts
- evals/buffbench/meta-analyzer.ts
- evals/buffbench/lessons-extractor.ts
- evals/buffbench/retrieval-analytics-store.ts
- scripts/run-mutation-gate.ts
- scripts/determinism-guard.ts
- scripts/memory-drift-guard.ts
- scripts/check-ci-local.ts
- scripts/measure-perf-guards-baseline.ts
- scripts/harness-language-server.ts
- scripts/build-structural-map.ts
- scripts/generate-tool-definitions.ts
- scripts/tmux/tmux-send.sh
- .github/workflows/ci.yml
- .github/workflows/buffbench.yml
- .github/workflows/nightly-evals.yml
- .github/workflows/rust-workspace.yml
- packages/build-tools/executors/infisical-run/executor.ts

### Domains
- performance
- correctness
- dependency-hygiene
- test-coverage
