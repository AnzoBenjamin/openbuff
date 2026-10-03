# Audit findings: shard-evals-infra

- Subsystems: eval-buffbench-harness, eval-agent-runners, eval-statistics-layer, scripts-infra, ci-workflows-prepush
- Features: eval-isolation-sandboxing, eval-promotion-statistics, judge-variance-agreement, script-hot-path-need, ci-toolchain-matrix, pre-push-local-gate, eval-workflow-artifacts, eval-fleet-scaling
- Files covered: 34
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [HIGH] security — evals/subagents/test-repo-utils.ts:40 — Eval runner has NO container/microVM isolation — temp-dir + git clone only; external CLIs run unsandboxed on host
- **Risk:** Eval tasks execute untrusted model-generated commands directly on the CI/dev host. External CLIs run with --dangerously-skip-permissions (claude.ts:29) and --full-auto (codex.ts:40-46); final-check commands run via execAsync in the repo dir (agent-runner.ts:379+). A malicious eval task or hallucinating agent can exfiltrate env secrets (provider API keys are injected into CI env by .github/workflows/ci.yml) or escape the temp dir.
- **Fix:** Before P8: add an optional TS container wrapper (docker/podman or bun sandbox) around withTestRepo for external CLIs and final checks, opt-in via env flag — no language change needed. The Go fleet (P8-T3) is justified only once eval volume requires cross-machine sharding + hardened per-run isolation; it does not need to move earlier for safety alone.
- **Evidence:** evals/subagents/test-repo-utils.ts:40-70 mkdtemp-only isolation; evals/buffbench/runners/claude.ts:29 '--dangerously-skip-permissions'; evals/buffbench/runners/codex.ts:40-46 '--full-auto'; evals/buffbench/agent-runner.ts:379-454 runFinalCheckCommand execAsync on host. Candidate: Go fleet (P8-T3). Unlocks: container/microVM isolation, fleet-safe concurrency, reproducible envs, hard kill. Difficulty: M. Verdict: supports plan at P8; no earlier language adoption — a TS docker wrapper is the right interim step.

## [MEDIUM] correctness — evals/buffbench/statistics.ts:71 — TS statistics layer is sufficient for the promotion gate but lacks power/MDE analysis — small-n promotion decisions can mis-promote
- **Risk:** The P0-T6 promotion gate (proposals.ts decideProposalPromotion) gates on Wilcoxon p<=0.05 + bootstrap CI lower>0 over n=number of paired tasks. BuffBench task sets are small (single eval JSON files ~10-30 tasks), so (1) the Wilcoxon normal approximation is unreliable for n<~10 with no guard, and (2) with low power the gate flips on noise in BOTH directions — false accept (mis-promote a variant) and false reject (kill real improvements). No minimum-detectable-effect sizing exists to pick --repeats.
- **Fix:** Add to TS (no new dependency): (a) exact Wilcoxon or a small-n warning when n<10; (b) simulation-based power/MDE using the existing makeSeededRng so runs can size --repeats before promoting. Defer mixed-effects models and krippendorff alpha to the Python sidecar per plan.
- **Evidence:** evals/buffbench/statistics.ts:71-112 pairedBootstrapMeanDiffCI; :151-212 wilcoxonSignedRankTest (normal approx, no n<10 guard); evals/buffbench/proposals.ts decideProposalPromotion significance gate. Candidate: Python stats sidecar (P8-T4) only for mixed-effects/krippendorff/lightgbm/optuna; power analysis belongs in TS. Unlocks: promotion decisions safe at current task counts. Difficulty: S (TS power) / M (Python). Verdict: TS-is-right for the promotion gate; plan P8-T4 timing confirmed.

## [MEDIUM] correctness — evals/buffbench/judge.ts:321 — Per-judge raw scores recorded but never analyzed for agreement — nested judge×task variance has no home in TS
- **Risk:** perJudgeScores stores each judge's raw completionScore/codeQualityScore/overallScore specifically so downstream variance is recoverable, but no consumer computes inter-judge reliability (ICC/krippendorff) or a judge-random-effect. Judge calibration drift (judge-calibration.ts is an LLM replay eval, not agreement stats) silently shifts the promotion gate.
- **Fix:** Keep collecting per-judge raw scores in TS (already done). Implement judge-agreement (krippendorff alpha, ICC) and nested mixed-effects score models in the Python sidecar at P8-T4 as planned. TS-is-right for capture; Python-is-right for inference.
- **Evidence:** evals/buffbench/judge.ts:321-331 perJudgeScores preserved 'so downstream variance is recoverable'; grep shows no consumer computes ICC/agreement. Candidate: Python sidecar. Supports plan P8-T4; do not pull earlier.

## [MEDIUM] correctness — evals/buffbench/compare-runs.ts:107 — compare-runs regression detection uses fixed heuristics without uncertainty propagation
- **Risk:** compareRuns flags regression via fixed thresholds: scoreDelta < -0.01, errorCountDelta > 0, costIncreasePct > 20 && scoreDelta <= 0. With noisy per-run judge scores these fire on noise; the module ignores standardError/scoringStatus machinery added by P0-T6 in the same package.
- **Fix:** Thread mean±SE (already exported by statistics.ts) into compare-runs deltas and mark deltas within noise as 'flat' rather than regression/improvement. Pure TS change.
- **Evidence:** evals/buffbench/compare-runs.ts:107-127 threshold regression rule vs evals/buffbench/statistics.ts standardError export referenced only by run-buffbench.ts + tests. Candidate: none (stay TS). Unlocks: honest before/after reports. Difficulty: S. Verdict: TS-is-right.

## [LOW] performance — scripts/build-structural-map.ts:383 — Script hot paths (build-structural-map, measure-context-baseline, benchmark-providers, measure-perf-guards-baseline) are one-shot or network-bound — no native-speed need
- **Risk:** None material. build-structural-map runs staleness-check + renders a map via @codebuff/indexer + inspectCodebaseStructure (one-shot reporting); measure-context-baseline and measure-perf-guards-baseline are one-shot measurement harnesses (median/MAD over warmup+runs) whose measured code lives in the runtime, not the script; benchmark-providers is dominated by LLM HTTP latency. Bun is adequate for all.
- **Fix:** No action. When X-2 golden baselines show a runtime kernel (tokenizer, stream parse) needing native code, measure inside the runtime — do not rewrite these harness scripts in Rust/Go.
- **Evidence:** scripts/build-structural-map.ts:33-34 imports, :383-414 main (one-shot); scripts/measure-context-baseline.ts:149-623 main; scripts/benchmark-providers.ts:222-336 runTurn (HTTP-bound); scripts/measure-perf-guards-baseline.ts:244-253 assertParity. Candidate: none. Verdict: TS-is-right for the whole scripts/ hot-path question.

## [MEDIUM] security — evals/buffbench/agent-runner.ts:60 — Eval fleet runs serially per host with pLimit; Go fleet (P8-T3) unlocks parallel sharding + hard timeouts across machines — but current scale is single-job, 360min-bounded
- **Risk:** Isolation is per-run temp dirs only; a runaway agent (no fs/network caps) can exhaust disk or make outbound calls for up to 60 minutes (agent-runner.ts:60 timeout) per run. Concurrency 10 in CI amplifies blast radius on a shared runner. Go fleet would add per-job resource caps + network policy that TS cannot enforce in-process.
- **Fix:** Sequence: P1-T5 headless `openbuff run --json` first (TS), then the Go fleet when nightly wall-clock or host contamination forces it. Do not adopt Go for the scheduler before the protocol client exists.
- **Evidence:** evals/buffbench/agent-runner.ts:60 60-minute withTimeout; evals/buffbench/run-buffbench.ts:186,393 Promise.all over agents; .github/workflows/evals.yml:56-58 --concurrency 10; .github/workflows/nightly-evals.yml:19 timeout-minutes: 360. Candidate: Go fleet (P8-T3). Unlocks: cross-machine sharding, per-run resource caps. Difficulty: M-L. Verdict: supports plan; premature before P1-T5 headless mode.

## [MEDIUM] dependency-hygiene — .github/workflows/ci.yml:44 — CI/build matrix is Bun-only; adding Rust/Go/Python toolchains costs per-job setup+cache across a 10-package matrix — keep toolchains out of hot CI paths
- **Risk:** ci.yml runs a 10-package test matrix + integration matrix, all Bun-only (bun-version 1.3.5 pinned, setup-bun everywhere). Adding Go/Rust/Python toolchains naively multiplies: setup-action steps + ~1-3GB language caches per matrix job, rustup/cargo target caches for X-3b's 5+ targets (native-core-build.yml already previews this cost), and slower cold starts on every evals/buffbench/nightly job (which currently share the Bun-only dep cache).
- **Fix:** (1) Ship the P8-T3 Go runner as a cross-compiled release artifact downloaded at runtime — no setup-go in CI at all. (2) Python sidecar: pin via uv/venv, run only in nightly-evals.yml, never in the PR gate. (3) For X-3b, add one reusable workflow_call job + Swatinem/rust-cache instead of duplicating setup across the 10-package matrix. (4) Delete native-core-build.yml with X-3a.
- **Evidence:** .github/workflows/ci.yml:44-48 matrix; :95 bun-version 1.3.5; evals workflows single-job 360min; .github/workflows/native-core-build.yml still present though X-3a deletes it. Candidate: Go (as prebuilt binary), Python (nightly only), Rust (X-3b matrix). Unlocks: toolchain cost stays O(1) via workflow_call + binary artifacts. Difficulty: M. Verdict: supports plan; adopt toolchains only at first real consumer.

## [LOW] dependency-hygiene — scripts/check-ci-local.ts:23 — Pre-push/local gate (check-ci-local + install-pre-push-hook) is Bun-only and should stay so — language toolchains in the local gate would destroy dev-loop latency
- **Risk:** check-ci-local (Step A tool-def regen + drift, memory-drift/sync-agent-config gates, Step E full suites for agents+common) plus run-mutation-gate wrap every push. Adding Rust/Go/Python checks (fmt, vet, mypy) to this path would add 10s-60s+ per push and toolchain-install friction for every contributor, and the file is intentionally duplicated verbatim in install-pre-push-hook.ts (drift-guarded), doubling maintenance per language.
- **Fix:** Keep the pre-push gate Bun-only. Language-specific validation (cargo clippy, go vet, python lint) belongs in CI, not the push path; optionally add an opt-in `bun run check:native` for contributors touching native code.
- **Evidence:** scripts/check-ci-local.ts:23-26 FULL_SUITE_STEPS; :29-32 deliberate single-file duplication with install-pre-push-hook.ts; scripts/run-mutation-gate.ts:10 env passthrough. Candidate: none. Verdict: TS-is-right.

## [LOW] test-coverage — .github/workflows/buffbench.yml:41 — Nightly/buffbench eval workflows persist no artifacts — run logs and traces are lost with the runner, independent of any language choice
- **Risk:** buffbench.yml and nightly-evals.yml run evals with no actions/upload-artifact step; trace JSONs, ANALYSIS files, agent-lessons and error dumps written under evals/ (run-buffbench.ts:346, judge.ts:292) exist only on the ephemeral runner. Downstream DuckDB observatory (P8-T2) and OTel→Parquet log (P8-T1) will have nothing durable to ingest from CI runs.
- **Fix:** Add actions/upload-artifact for evals logs/agent-lessons/traces on both workflows (if: always()). This is a prerequisite for the DuckDB observatory and OTel→Parquet learning log and requires no new toolchain.
- **Evidence:** .github/workflows/buffbench.yml (no actions/upload-artifact step); .github/workflows/nightly-evals.yml:41-46 last step is 'echo Workflow completed'. Candidate: none (TS/YAML). Supports P8-T1/P8-T2 but is language-independent. Difficulty: S.

## [MEDIUM] test-coverage — .github/workflows/evals.yml:10 — evals.yml runs the eval set on every branch push gated only by a commit-message substring, single job, 360min cap
- **Risk:** evals.yml triggers on push to '**' but gates on the [buffbench] commit marker — a typo in the marker silently burns nothing, but a correct marker on any branch starts a 360-minute single-runner eval with live API keys and no artifact upload. Two overlapping pushes race on the same runner and provider quota with no concurrency group.
- **Fix:** Short term (TS): add concurrency group + artifact upload + cost-cap flag to run-eval-set. Long term (P8-T3): matrix-shard the fleet across runners. No earlier language adoption.
- **Evidence:** .github/workflows/evals.yml:10-11 push on '**'; :24-34 commit-message gate; :96 cd evals && bun run-eval-set --concurrency 10. Candidate: Go fleet later. Verdict: TS-is-right today.

## [LOW] correctness — evals/buffbench/agent-runner.ts:86 — Agent runner abstraction (Runner interface) and signal extractors are pure TS with no cross-language pressure
- **Risk:** None. Four runners implement a 2-method Runner interface with structured event streams; judging (judge.ts) and all signal extractors (plan-sharding-signals, retrieval-flow-metrics, idiom-*, thinker-harvest) are pure TS functions over trace JSON. Rewriting orchestration in Go would fork the event schema (PrintModeEvent) and the SDK client types for zero latency benefit — runs are minutes-long and LLM-bound.
- **Fix:** When P8-T3 lands, keep runners/judging/signal extraction in TS (or behind the P1 protocol client) and have the Go fleet only own process/container lifecycle, env provisioning and artifact shipping. Boundary: Go = jobd/executor, TS = eval logic.
- **Evidence:** evals/buffbench/agent-runner.ts:86-97 runner selection; runner.ts:19-31 Runner interface; compare-runs.ts / meta-analyzer.ts / plan-sharding-signals.ts / retrieval-flow-metrics.ts are pure TS over trace JSON. Candidate: Go fleet (P8-T3) as executor only. Difficulty: M. Verdict: TS-is-right for the orchestration + signal layer; Go for the fleet executor.

## [LOW] correctness — evals/buffbench/trace-analyzer.ts:163 — Trace/meta analyzers stuff unbounded JSON into prompts — a robustness gap that no language change fixes
- **Risk:** analyzeAgentTraces and analyzeAllTasks embed JSON.stringify(traces/summaries) directly into LLM prompts with a single global truncateTrace cap and return raw error strings as data (traceAnalysisStatus 'agent_error'). No prompt-size regression guard exists; this is an orchestration-quality gap, not a language gap — Python/Rust would not improve it.
- **Fix:** None required for the language audit; optionally cap JSON.stringify budgets per trace before LLM submission to bound token spend. TS-is-right.
- **Evidence:** evals/buffbench/trace-analyzer.ts:163-176 JSON.stringify(truncatedTraces) into LLM prompt; evals/buffbench/meta-analyzer.ts:120-130 same pattern; both return error strings as data. Candidate: none. Verdict: TS-is-right.

## Coverage receipt

### Subsystems
- eval-buffbench-harness
- eval-agent-runners
- eval-statistics-layer
- scripts-infra
- ci-workflows-prepush

### Features
- eval-isolation-sandboxing
- eval-promotion-statistics
- judge-variance-agreement
- script-hot-path-need
- ci-toolchain-matrix
- pre-push-local-gate
- eval-workflow-artifacts
- eval-fleet-scaling

### Files
- evals/buffbench/run-buffbench.ts
- evals/buffbench/agent-runner.ts
- evals/buffbench/runners/codebuff.ts
- evals/buffbench/runners/claude.ts
- evals/buffbench/runners/codex.ts
- evals/buffbench/runners/opencode.ts
- evals/buffbench/runners/runner.ts
- evals/buffbench/judge.ts
- evals/buffbench/statistics.ts
- evals/buffbench/proposals.ts
- evals/buffbench/compare-runs.ts
- evals/buffbench/meta-analyzer.ts
- evals/buffbench/lessons-extractor.ts
- evals/buffbench/trace-analyzer.ts
- evals/buffbench/retrieval-flow-metrics.ts
- evals/buffbench/plan-sharding-signals.ts
- evals/subagents/test-repo-utils.ts
- scripts/measure-perf-guards-baseline.ts
- scripts/check-ci-local.ts
- scripts/run-mutation-gate.ts
- scripts/generate-tool-definitions.ts
- scripts/sync-agent-config.ts
- scripts/dev.ts
- scripts/start-services.ts
- scripts/init-worktree.ts
- scripts/build-structural-map.ts
- scripts/measure-context-baseline.ts
- scripts/benchmark-providers.ts
- .github/workflows/ci.yml
- .github/workflows/evals.yml
- .github/workflows/nightly-evals.yml
- .github/workflows/buffbench.yml
- .github/workflows/native-core-build.yml
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- performance
- dependency-hygiene
- test-coverage
- error-handling
