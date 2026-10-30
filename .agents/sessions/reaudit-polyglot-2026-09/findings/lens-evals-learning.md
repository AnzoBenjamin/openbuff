# Audit findings: lens-evals-learning

- Subsystems: evals/buffbench, evals/compaction-retention, evals/memory-retention, common/telemetry-analytics, agent-runtime/orchestration-telemetry, sdk/harness-intelligence, scripts/eval-analysis
- Features: eval-orchestration, llm-judging, judge-calibration, run-comparison, proposal-promotion, lessons-extraction, trace-meta-analysis, retrieval-flow-metrics, gate-telemetry, analytics-sampling, verified-knowledge-store, mutation-gate
- Files covered: 23
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] correctness — evals/buffbench/proposals.ts:365 — EL-1: Proposal promotion gate uses a fixed raw delta (+0.25) with no significance test
- **Risk:** This is the only automated accept/reject decision in the self-improvement loop, and it can't tell noise from real improvement. Averages over 2 LLM judges on small task sets swing by more than 0.25 between runs on their own, so the loop will promote noise and reject real gains. compare-runs.ts:124 marks a regression at scoreDelta < -0.01, which fires on almost any rerun.
- **Fix:** Short term: add paired bootstrap confidence intervals and a Wilcoxon signed-rank test in TS (simple-statistics, or about 80 lines by hand) on per-task paired deltas. Proper fix: a Python stats sidecar (scipy.stats, statsmodels mixed-effects with task and judge as random effects) that reads FINAL_RESULTS/ANALYSIS JSON and returns {delta, ci95, p, effectSize, requiredN}. Feature unlocked: trustworthy auto-promotion, power analysis ('you need N=40 tasks to detect +0.3'), and sequential testing to stop evals early. TS can do the basic bootstrap/Wilcoxon; mixed-effects models and power analysis realistically need Python. Cost: low (sidecar reads existing JSON, no runtime coupling).
- **Evidence:** proposals.ts defaultPromotionPolicy {minTotalScoreDelta: 0.25, requireNoRegressions: true}; decideProposalPromotion compares comparison.overall.totalScoreDelta, a SUM of per-agent mean deltas, to the threshold. compare-runs.ts compareRuns works on averageScore only and never pairs runs by task. regression = scoreDelta < -0.01 || errorCountDelta > 0. judge.ts runs only judge-gpt and judge-gemini ('Run 2 judges in parallel') and averages them.

## [HIGH] state-mutation — evals/buffbench/lessons-extractor.ts:290 — EL-2: The learning loop is open: lessons go to append-only markdown and proposals are never applied or A/B-tested
- **Risk:** The project goal is 'an efficient learning agent' (docs/goal.md), but nothing learned from an eval run changes the agent without a human. agent-lessons/*.md is written and never read back into any prompt. applyProposals is always dry-run by design (proposals.ts header: 'manually stage reviewed changes in a separate worktree → re-eval'). decideProposalPromotion is only referenced from its test, not from any runner.
- **Fix:** Build a variant registry plus an orchestrator: proposal → materialize variant agent defs (a content-hashed id) → schedule paired eval on a held-out split → EL-1 stats gate → promote to a candidate channel. The orchestration and variant materialization can stay in TS. The optimizer is where another language adds real features: DSPy (MIPROv2/GEPA) or TextGrad in Python can search systemPrompt/guidance space using the existing judge as the metric, which TS has no mature equivalent for. Feature unlocked: automatic prompt optimization of agent templates with measured, gated promotion. Cost: medium. Needs a train/holdout task split and a budget cap per optimization run.
- **Evidence:** lessons-extractor.ts saveAgentLessons does appendFileSync to lessonsDir/<agent>.md. run-buffbench.ts runTask calls applyProposals({dryRun: true}) and stores only proposalDryRun summary. proposals.ts doc: 'This module never persists proposal changes.' The referencedBy graph shows decideProposalPromotion used only in __tests__/proposals.test.ts.

## [HIGH] performance — evals/buffbench/run-buffbench.ts:1 — EL-3: Eval execution is a single host process: pLimit concurrency (default 1), no container sandbox, host tmpdir installs
- **Risk:** Statistical power (EL-1) and optimization loops (EL-2) need hundreds to thousands of task runs per candidate. Today tasks run through pLimit(taskConcurrency=1) in one Bun process, and agents share the host filesystem and PATH. installBinaries runs npm/bun install on the host. A misbehaving agent can affect other concurrent tasks, and scale-out means running more laptops.
- **Fix:** Add a Rust or Go eval-fleet runner: a controller that fans tasks out to containers or microVMs (Docker/Podman, Firecracker, or gVisor), with per-task resource limits, network policy, content-addressed repo snapshot caches (a git worktree pool), and retry/resume from a task ledger. The TS runTask keeps working as the in-container entrypoint. Go is the pragmatic choice (docker/containerd SDKs, k8s Job API); Rust fits if it shares the native core from the prior audit. Feature unlocked: hundreds of parallel sandboxed tasks, resumable nightly runs, and seeds/repeats per task for variance estimates. TS can orchestrate Docker via dockerode, but microVM isolation and cgroup accounting are much weaker there. Cost: medium-high.
- **Evidence:** run-buffbench.ts: taskConcurrency = 1 default; const commitLimit = pLimit(taskConcurrency); Promise.allSettled(commitPromises) all in-process. installBinaries: fs.mkdtempSync(os.tmpdir()) and execInstall on the host with PATH/HOME. runTask writes traces straight into __dirname/logs. A code_search for clone/worktree/docker in agent-runner.ts and runners/codebuff.ts found no container isolation.

## [HIGH] performance — scripts/compare-buffbench-runs.ts:29 — EL-4: Eval analytics is ad-hoc JSON scanning across three divergent scripts with inconsistent exclusion rules
- **Risk:** Cross-run questions (trend over 30 nightlies, per-tool failure rates, cost/score Pareto by model) take a new bespoke script each time. The existing scripts disagree on which runs count. compare-buffbench-runs excludes overallScore <= 1.0, analyze-buffbench-logs excludes === 0, and run-buffbench.summarizeAgentRuns explicitly removed the '> 1.0 magic threshold' because it 'silently discarded genuine low measured scores'. So the two scripts reintroduce a bias the runner fixed and ignore scoringStatus.
- **Fix:** Normalize every run (FINAL_RESULTS, ANALYSIS, per-agent traces, gate telemetry) into Parquet with one schema (runs, tasks, judge_scores, tool_calls, retrieval_flow, costs) and query it with DuckDB. DuckDB is C++ with official Node bindings, so it can stay inside Bun, and Python/polars and notebooks read the same files. Make scoringStatus the only exclusion rule. Feature unlocked: SQL over every eval ever run, longitudinal dashboards, per-tool and per-phase failure slicing, and Jupyter/marimo analysis notebooks. TS can host DuckDB; the notebook and plotting layer is Python. Cost: low.
- **Evidence:** compare-buffbench-runs.ts: run1HasLowScores = results.some(r => r.overallScore == null || r.overallScore <= 1.0); population stdDev; no pairing beyond commonCommitShas. analyze-buffbench-logs.ts:40 excludes overallScore === 0. run-buffbench.ts summarizeAgentRuns comment: 'The old overallScore > 1.0 magic threshold here silently discarded genuine low measured scores'. meta-analyzer.ts and both scripts each readdirSync+JSON.parse every '*ANALYSIS*' file.

## [HIGH] correctness — evals/buffbench/judge.ts:373 — EL-5: Judge ensemble is 2 LLMs averaged with no reliability modeling; calibration checks only range agreement
- **Risk:** All learning signal comes from the judge. With 2 judges, the 'median' is just the lower judge's narrative, and a disagreement of 6 vs 9 averages to 7.5 with no uncertainty attached. judge-calibration.ts measures the fraction of scores falling in hand-set ranges (threshold 0.75). It doesn't measure rank correlation, inter-judge agreement, or per-judge bias, so judge drift that preserves ranges but reorders agents goes undetected. README still documents '3 judges… Gemini 2.5 Pro… median', which no longer matches the code.
- **Fix:** Report per-run judge variance and store per-judge raw scores, not just the average. Add inter-rater statistics (Krippendorff's alpha, ICC, Spearman/Kendall against the gold set) and fit a Bradley-Terry or Dawid-Skene style judge-bias model. The Python libraries here (krippendorff, pingouin, scipy, choix) are mature. Pairwise preference judging (A vs B on the same task) is statistically much stronger than absolute 0-10 scores for A/B work. Feature unlocked: calibrated scores with error bars, automatic judge down-weighting on drift, and cheaper evals from pairwise judging. TS can compute ICC and Spearman by hand; bias models are better in Python. Cost: low-medium.
- **Evidence:** judge.ts judgeCommitResult: judgePromises = [runSingleJudge(... 'judge-gpt'), runSingleJudge(... 'judge-gemini')]; averages completion/quality/overall; lower-median narrative. judge-calibration.ts evaluateCalibration: agree = actual >= min && actual <= max; agreementRate >= threshold (0.75). evals/README.md: 'Uses AI (Gemini 2.5 Pro)… Runs 3 judges in parallel and takes median'.

## [MEDIUM] correctness — evals/buffbench/meta-analyzer.ts:146 — EL-6: Meta-analysis and trace analysis are LLM-only summaries of JSON dumps, with no quantitative failure mining
- **Risk:** Cross-task patterns ('consistent weaknesses') come from GPT-5 reading JSON.stringify of every task summary. That output is non-reproducible, unverifiable, capped by context size, and costs a frontier-model call per run. No clustering, feature attribution, or failure-mode taxonomy is computed, so 'what should we fix next' has no evidence ranking.
- **Fix:** Extract structured features from traces (tool sequence n-grams, read-before-edit, retrieval-flow metrics, token and cost per phase, error classes, final-check signals). Train gradient-boosted failure predictors (lightgbm/xgboost + SHAP) and cluster failure narratives (sentence embeddings + HDBSCAN) in Python. Then have the LLM only write up the ranked, quantified clusters. Feature unlocked: reproducible, evidence-ranked failure taxonomies ('38% of failures: edit before relevant read, SHAP 0.41') and automatic task-difficulty estimates. TS has no SHAP, HDBSCAN, or GBDT ecosystem worth using. Cost: medium.
- **Evidence:** meta-analyzer.ts analyzeAllTasks builds a prompt with JSON.stringify(filteredAgentDefinitions) + JSON.stringify(taskSummaries), runs model 'openai/gpt-5' with a 30-minute timeout, and returns output.value as MetaAnalysisResult with no schema validation. trace-analyzer.ts is the same pattern per commit. retrieval-flow-metrics.ts:14 already computes structured per-run features (queryHitAtK, irrelevantReadRatio, toolCallsToFirstRelevantRead) that are never aggregated across runs.

## [MEDIUM] state-mutation — common/src/util/gate-telemetry.ts:36 — EL-7: Runtime telemetry is lossy by design: 2MB JSONL, one rotation generation, per-project, sync writes
- **Risk:** The gate telemetry is the only production-time signal about how base2 decides, and it's the natural training data for learned routing and gating. The 2MB cap with one '.1' generation throws history away, the files are scattered per project, and the sink warns it is 'NOT safe to reuse for a high-rate event stream' because every event is a synchronous lstat+open+append+close on the event loop.
- **Fix:** Emit OpenTelemetry spans and events (the OTel JS SDK is fine in TS) with an agent-run span tree: run → step → tool call → gate decision. Export them to a local OTel Collector (Go) or straight to a local DuckDB/Parquet sink with retention policies instead of 2MB rotation. The collector adds batching, tail sampling that keeps whole failed runs, redaction processors, and optional export to Jaeger/Grafana Tempo/Langfuse/Phoenix. Feature unlocked: full local trace history suitable as a learning corpus, flame-graph views of agent runs, and joins between eval results and runtime behavior. TS can emit OTel; the collector and processing are Go. Cost: low-medium. Keep the local-first default: no remote export unless the user configures it.
- **Evidence:** gate-telemetry.ts: GATE_TELEMETRY_MAX_BYTES = 2_000_000; rotation renames to `<sink>.1` 'ONE kept generation, overwriting the previous one'; path <projectRoot>/.openbuff/telemetry/base2-gate.jsonl. gate-telemetry-sink.ts createGateTelemetryRecorder doc: 'Each recorded event costs a synchronous lstat scan plus openSync/appendFileSync/closeSync … NOT safe to reuse for a high-rate event stream.'

## [MEDIUM] correctness — common/src/util/analytics-sampling.ts:5 — EL-8: Product analytics samples AGENT_STEP and TOOL_USE at 1%, which removes the learning signal
- **Risk:** The events that describe agent behavior (AGENT_STEP, TOOL_USE) are kept at 1%, hash-bucketed by user, so a given user's traces are either all kept or all dropped. That's fine for product metrics, but it makes real-usage data unusable for learning a router or failure predictor, and there's no local full-fidelity alternative outside the gate sink.
- **Fix:** Separate the two concerns. Keep remote analytics sampled, and add an opt-in, local-only, full-fidelity 'learning log' through the EL-7 OTel/Parquet pipeline, with outcome labels (user accepted, reverted, re-prompted, tests passed). Language: TS emission plus a DuckDB/Parquet store; Python for model training. Feature unlocked: per-user local learning from your own sessions (a BYOK-compatible 'agent that learns you'). Cost: low. Privacy stays local-first by construction.
- **Evidence:** analytics-sampling.ts SAMPLED_EVENT_RATES: AGENT_STEP, TOOL_USE, CLI_LOG, SLASH_COMMAND_USED all at DEFAULT_SAMPLED_RATE = 0.01; shouldTrackAnalyticsEvent buckets on hashString(event:samplingKey) where samplingKey prefers distinctId. analytics-dispatcher.ts no-ops in dev and only routes remote payloads.

## [MEDIUM] performance — sdk/src/services/local-harness-store.ts:62 — EL-9: Harness and knowledge store is one JSON file per record with linear list scans, so it can't serve as a learning memory
- **Risk:** VerifiedKnowledgeService.listFresh reads and schema-parses every artifact record, then filters by id prefix and expiry. There's no index, no similarity search, and no aggregation. Verified knowledge is exactly what a learning agent should retrieve by relevance, but the store only supports enumeration. Locking is a hand-rolled mkdir lock with busy-wait via Atomics.wait.
- **Fix:** Move the learning-relevant kinds (artifacts/knowledge, findings, validation) into SQLite (bun:sqlite already bundled, or the rusqlite kernel from the prior audit) with FTS5 + sqlite-vec, keeping the record schema and CAS revision semantics. Rust is only needed if you want the shared native store; TS on bun:sqlite can do this today. Feature unlocked: relevance- and trust-ranked retrieval of verified knowledge and past lessons at prompt time (the 'trust-scored retrieval ranking' that memory-retention/README lists as deferred). Cost: medium. local-harness-store.test.ts pins the lock/CAS behavior.
- **Evidence:** local-harness-store.ts writeJsonAtomic per record; listWithDiagnostics readdirSync + read() + recordSchema.safeParse for every file; withFilesystemLock mkdir lock with LOCK_WAIT_MS=10 busy-wait. harness-intelligence.ts VerifiedKnowledgeService.listFresh = store.list(...).filter(id.startsWith('knowledge-')).filter(expiresAt). memory-retention/README 'Deferred phases': 'Trust-scored retrieval ranking at injection time', 'Procedural recipe library', 'Background consolidation'.

## [MEDIUM] test-coverage — evals/compaction-retention/README.md:58 — EL-10: Retention evals are deterministic byte and recall checks only; model-in-the-loop quality and multi-pass drift are explicitly deferred
- **Risk:** Compaction and memory are central to an 'efficient' agent, yet nothing measures whether retained context helps the model act correctly or how retention degrades over repeated compaction cycles. Tuning of pruner caps is unguided.
- **Fix:** Add a parameter-sweep harness (compaction scale factors, block ceilings, window sizes) × cycle count, with a cheap LLM-in-the-loop probe ('continue the task' judged against must-survive facts). Run the grid in the EL-3 fleet and fit response surfaces in Python (scipy.optimize, or optuna for Bayesian optimization of the cap constants). Feature unlocked: data-driven, per-window-size compaction policies and a learned 'what to keep' scorer. TS can run the sweep; optuna/BO is Python. Cost: medium.
- **Evidence:** compaction-retention/README 'Out of scope / deferred': 'Model-quality questions (does the model act on retained evidence) — needs an LLM-in-the-loop eval'; 'Retention under repeated compaction cycles… multi-pass drift'. memory-retention/README: 'no … claims that memory improves LLM coding quality… not semantic answer quality, retrieval ranking, token cost'.

## [MEDIUM] api-contract — evals/buffbench/proposals.ts:112 — EL-11: The proposal action space is too narrow for learned optimization (append-only guidance, tool add/remove, model, budget)
- **Risk:** Optimizers (DSPy, TextGrad, evolutionary search) need to edit, reorder, and delete prompt sections, tune few-shot exemplars, and change spawnableAgents and handleSteps parameters. Append-only guidance grows systemPrompt monotonically, which works against the 'efficient' goal (token cost) and can't be undone by the loop.
- **Fix:** Version agent templates as structured, addressable sections (ids and hashes) and add reversible operations: replace_section, remove_section, set_exemplars, set_spawnable_agents, set_step_param. Each carries a provenance link to the eval evidence that justified it. Keep the Zod discriminated union in TS as the contract; Python optimizers emit JSON against the generated JSON Schema. Feature unlocked: prompt compression and optimization, not just accretion. TS can do all of this. Cost: low-medium.
- **Evidence:** proposals.ts header: 'Intentionally NOT supported … Editing existing systemPrompt text (only appending is allowed)… Arbitrary JSON mutations'. ProposalSchema = discriminatedUnion of the 5 kinds. The append_system_prompt_guidance case concatenates existing + separator + guidance.

## [MEDIUM] correctness — evals/buffbench/run-buffbench.ts:870 — EL-12: Aggregates are plain means with no per-task repeats, seeds, or variance, so every downstream decision is single-sample
- **Risk:** Each task runs once per agent. averageScore and averageCost are means over tasks with no standard error, no repeated trials for stochastic agents, and no cost-normalized metrics (score per dollar, Pareto front). Model and budget decisions (set_model/set_budget proposals) can't be judged on a cost-quality frontier.
- **Fix:** Add --repeats N and --seed, store per-trial rows, and report mean ± SE, pass@k, and score per dollar. Compute the Pareto front across agent and model variants. The EL-4 DuckDB/Parquet plus Python stats layer handles this; the reporting can be in TS. Feature unlocked: variance-aware leaderboards and cost-quality frontier routing decisions. Cost: low.
- **Evidence:** run-buffbench.ts post-run loop: agentData.averageScore = measuredRuns.reduce(sum overallScore)/length; averageCost and averageDuration are simple means; the Score Distribution section only prints raw score lists. runTask runs each agent once per commit via agents.map.

## [LOW] dependency-hygiene — scripts/run-mutation-gate.ts:9 — EL-13: The mutation gate is a thin env-flag wrapper; there's no mutation testing to measure eval and test oracle strength
- **Risk:** The self-improvement loop depends on the tests and deterministic signals (compile/test/lint clamps in deterministic-signals.ts) being strong oracles. Nothing measures their mutation score, so a weak oracle quietly lets bad agent changes score well.
- **Fix:** Run StrykerJS (TS, mature) on the judge, deterministic-signal, and proposal modules, and on eval-target repos where feasible. Use the Python-side analysis to weight tasks by oracle strength. Feature unlocked: oracle-strength-weighted eval scores. TS can do this. Cost: low.
- **Evidence:** run-mutation-gate.ts: spawn(command, args, { env: { ...process.env, OPENBUFF_MUTATION_GATE: '1' } }). It's only an env toggle and computes no mutation score.

## [LOW] api-contract — evals/README.md:34 — EL-14: The evals README describes the legacy git-evals system, not buffbench
- **Risk:** The documentation describes git-evals, 3 Gemini judges, and a 4-score rubric with efficiencyScore. buffbench actually uses 2 judges, a completion/quality/overall/idiom rubric, scoringStatus, deterministic clamping, and a lessons/proposals loop. Contributors building the learning loop will target the wrong contracts.
- **Fix:** Document the buffbench pipeline, the artifact schemas (FINAL_RESULTS, ANALYSIS, trace files), scoringStatus semantics, and the proposal loop. These should be generated from the Zod schemas, which also gives the EL-4 Parquet normalizer its contract.
- **Evidence:** README 'Judging System (judge-git-eval.ts) Uses AI (Gemini 2.5 Pro)… Runs 3 judges… median'; metrics include efficiencyScore. judge.ts JudgingResultSchema has no efficiencyScore; judgeAgents are judge-gpt/judge-gemini/judge-claude with only gpt and gemini invoked.

## Coverage receipt

### Subsystems
- evals/buffbench
- evals/compaction-retention
- evals/memory-retention
- common/telemetry-analytics
- agent-runtime/orchestration-telemetry
- sdk/harness-intelligence
- scripts/eval-analysis

### Features
- eval-orchestration
- llm-judging
- judge-calibration
- run-comparison
- proposal-promotion
- lessons-extraction
- trace-meta-analysis
- retrieval-flow-metrics
- gate-telemetry
- analytics-sampling
- verified-knowledge-store
- mutation-gate

### Files
- docs/goal.md
- evals/README.md
- evals/buffbench/run-buffbench.ts
- evals/buffbench/judge.ts
- evals/buffbench/judge-calibration.ts
- evals/buffbench/meta-analyzer.ts
- evals/buffbench/lessons-extractor.ts
- evals/buffbench/trace-analyzer.ts
- evals/buffbench/proposals.ts
- evals/buffbench/compare-runs.ts
- evals/buffbench/retrieval-flow-metrics.ts
- evals/buffbench/runners/runner.ts
- evals/compaction-retention/README.md
- evals/memory-retention/README.md
- common/src/util/gate-telemetry.ts
- common/src/util/analytics-sampling.ts
- common/src/util/analytics-dispatcher.ts
- packages/agent-runtime/src/orchestration/gate-telemetry-sink.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/services/local-harness-store.ts
- scripts/compare-buffbench-runs.ts
- scripts/analyze-buffbench-logs.ts
- scripts/run-mutation-gate.ts

### Domains
- correctness
- state-mutation
- performance
- test-coverage
- api-contract
- dependency-hygiene
