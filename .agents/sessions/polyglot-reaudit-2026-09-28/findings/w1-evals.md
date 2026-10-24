# Audit findings: w1-evals

- Subsystems: evals
- Features: buffbench, eval-statistics, retention-evals, judge-calibration, deterministic-signals, eval-task-sets, eval-isolation, proposal-promotion
- Files covered: 36
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — evals/buffbench/setup-test-repo.ts:191 — [BEST] GitHub token embedded in origin remote of the repo the untrusted agent operates on, and its prefix is logged
- **Risk:** effectiveCloneUrl with `https://${githubToken}@github.com/` is written as the `origin` remote (git remote add, :222) so it persists in <repo>/.git/config. The agent under test (and external CLIs run with --dangerously-skip-permissions / --full-auto) can read and exfiltrate CODEBUFF_GITHUB_TOKEN. Lines 196 and 349 also print the first 10 chars of the token to CI logs.
- **Fix:** Pass credentials via `git -c http.extraHeader="Authorization: Bearer ..."` or GIT_ASKPASS helper for the fetch only, then `git remote set-url origin <tokenless url>` (or remove origin) before handing the dir to the agent. Remove the token-prefix logging. Add a test asserting .git/config contains no token.
- **Evidence:** setup-test-repo.ts:191-194 builds token URL; :222 `['remote','add','origin',effectiveCloneUrl]`; :196 `Token prefix: ${githubToken.substring(0, 10)}`; :349 `Token format: ${token.substring(0, 10)}...`.

## [HIGH] security — evals/buffbench/runners/claude.ts:49 — [LANG] P8-T0 isolation still open: external runners inherit full host env while running unsandboxed
- **Risk:** claude.ts:39/49 (`--dangerously-skip-permissions`, `...process.env`), codex.ts:35/47 (`--full-auto`, `...process.env`), opencode.ts:113 spread every host secret (provider keys, CODEBUFF_GITHUB_TOKEN) into processes executing model-authored code. D18 correctly orders isolation before the fleet but nothing has landed.
- **Fix:** Land P8-T0 now: run runners/final checks in rootless podman/docker with an allowlisted env (only the one provider key), no host mounts except the repo dir, egress restricted. Prefer reusing an existing sandbox (Inspect AI sandbox providers, SWE-bench per-instance images, or Dagger/testcontainers) over a bespoke wrapper. Gate: smoke test that `env` inside the runner lacks unrelated secrets.
- **Evidence:** code_search runners/: claude.ts:39,49,53; codex.ts:35,47,49; opencode.ts:113,116. PLAN.md:164 P8-T0 `[ ]`.

## [HIGH] test-coverage — evals/buffbench/eval-codebuff.json:4 — [POLY] Task sets are TS/JS-dominated; only Python appears in real repos and with zero deterministic checks; no Rust/Go/Java/C#/C++/Ruby/PHP/Swift/Kotlin real-repo tasks
- **Risk:** codebuff/openbuff-v2 (TS, bun), manifold (TS, yarn) and plane (mostly TS + Django api) dominate. saleor/plane are the only Python sources and define no initCommand or finalCheckCommands, so Python tasks are judged by LLM only (no pytest clamp). The only Rust/Go coverage is 3 synthetic seed fixtures in eval-idioms-v1. A Rust/Go/Java regression in the harness (paths, tool output parsing, build detection) would not be caught.
- **Fix:** Add a polyglot task set drawn from existing benchmarks: SWE-bench Multilingual (9 languages), Multi-SWE-bench (Java/TS/JS/Go/Rust/C/C++), SWE-PolyBench (Java/JS/TS/Python). Reuse their per-instance Docker images and FAIL_TO_PASS/PASS_TO_PASS test lists as finalCheckCommands. Require ≥N tasks per language in a CI-sized subset. Add pytest/Django initCommand+finalCheckCommands to saleor/plane sets.
- **Evidence:** code_search initCommand: only eval-codebuff*.json (`bun install`) and eval-manifold*.json (`yarn install`); no match in eval-saleor*.json / eval-plane*.json. .py paths only in saleor/plane/idioms; .rs/.go only in eval-idioms-v1.json:54,77.

## [HIGH] correctness — evals/buffbench/types.ts:42 — [POLY] `languages` task metadata is never consumed: no per-language breakdown in results, comparisons or promotion
- **Risk:** Only types.ts declares `languages?: string[]`; run-buffbench.ts, compare-runs.ts, format-output.ts, main-nightly.ts never read it. Aggregates are per-agent means over all tasks, so a Rust/Python regression is diluted by the TS majority and invisible in compareRuns and decideProposalPromotion.
- **Fix:** Infer language per task (explicit `languages` else diff-path extension, reuse idiom-pattern-signals languageForDiffPath), aggregate mean±SE per language in AgentEvalResults, and make compareRuns flag per-language regressions; promotion must require no significant regression in any language stratum.
- **Evidence:** code_search `\blanguages\b` over run-buffbench.ts, types.ts, format-output.ts, main-nightly.ts, compare-runs.ts → single hit types.ts:42. eval-idioms-v1.json:20,43,66 sets languages but nothing reads it.

## [HIGH] correctness — evals/buffbench/run-buffbench.ts:829 — [BEST] Repeats are flattened into independent tasks, so paired tests pseudo-replicate
- **Risk:** `--repeats` duplicates each commit into the flat run list; the resulting runs are indistinguishable from distinct tasks. Feeding them into wilcoxonSignedRankTest/pairedBootstrapMeanDiffCI (proposals.ts:422-426) treats k repeats of one task as k independent pairs. That inflates n, shrinks the CI and understates p. Task-level and run-level variance are never separated.
- **Fix:** Tag runs with (taskId, repeatIndex). Average within task before paired tests, or use a cluster/hierarchical bootstrap (resample tasks, then repeats). Report within-task vs between-task variance. Long-term, run a mixed-effects model (statsmodels MixedLM / bambi) in the P8-T4 sidecar.
- **Evidence:** run-buffbench.ts:828-831 `commitsToRun.flatMap((c) => Array.from({ length: repeats }, () => c))`; :890 standardError over all measuredRuns; proposals.ts:422-426 consume pairedScores without task grouping.

## [HIGH] correctness — evals/buffbench/compare-runs.ts:127 — [BEST] Regression/improvement classification ignores noise, and the significance gate is off by default with no multiple-comparison control
- **Risk:** Any agent with scoreDelta < -0.01 is a regression and > 0.01 is an improvement. With LLM-judge SD around 1-2 points on 10-30 tasks, this is mostly noise. decideProposalPromotion defaults requireSignificance to undefined/false (defaultPromotionPolicy :379-383), so promotion is based on raw totalScoreDelta ≥ 0.25 summed across agents. There is no Holm/BH correction when many agents or proposals are tested.
- **Fix:** Thread scoreStandardError into compareRuns and classify `flat` when |delta| < 2·SE_diff (P8-T4a). Make requireSignificance default true for promotion. Apply Holm-Bonferroni across agents/proposals/languages. Add a power/MDE check that rejects underpowered comparisons.
- **Evidence:** compare-runs.ts:127 `scoreDelta < -0.01`, :135 `scoreDelta > 0.01`; proposals.ts:178 'Defaults to false', :379-383 defaultPromotionPolicy has no requireSignificance; PLAN.md:175 P8-T4a `[ ]`.

## [MEDIUM] correctness — evals/buffbench/statistics.ts:196 — [BEST] Wilcoxon uses a normal approximation with no small-n exact path; bootstrap is a plain percentile CI
- **Risk:** For n<~20 nonzero diffs (typical eval sets), the normal+continuity approximation misstates p. Discrete 0-10 judge scores also produce heavy ties. The percentile bootstrap undercovers at small n. Bootstrap index uses floor((1-α/2)·B), which is off by one from the conventional quantile. These are acceptable in TS but must be fixed before the gate relies on them.
- **Fix:** Implement the exact Wilcoxon null distribution by DP over rank sums for n≤25 (trivial in TS; with ties, use exact permutation of signs), or a sign-flip permutation test with the seeded RNG. Use BCa or studentized bootstrap, or at minimum warn when n<10. Keep this in TS per P8-T4a; scipy.stats.wilcoxon(method='exact'|'permutation') can serve as a cross-check oracle in tests.
- **Evidence:** statistics.ts:193-205 z with continuity correction, `2 * (1 - normalCdf(|z|))`; :100-106 percentile indices; no n guard.

## [MEDIUM] test-coverage — evals/buffbench/__tests__/fixtures/judge-gold-set.json:5 — [POLY] Judge calibration gold set is 4 TS-centric cases; idiomScore and non-TS judging are uncalibrated
- **Risk:** Gold cases: gold-clean-pass-typescript, gold-broken-build, gold-partial-implementation, gold-injection-in-diff. The 0.75 threshold (judge-calibration.ts:56) lets 1 of 4 fail. Idiom Compliance (judge.ts:196) applies only to non-TS tasks, yet no Python/Rust/Go case checks it. Calibration also uses replay clients only, so live judge drift is not measured. There is no inter-judge agreement statistic.
- **Fix:** Expand to ≥5 cases per language (Python/Rust/Go/Java at minimum), with pairs of idiomatic vs non-idiomatic diffs asserting idiomScore ordering. Run a periodic live calibration job and report Krippendorff's alpha / Spearman between judges (P8-T4 sidecar or a TS implementation).
- **Evidence:** judge-gold-set.json:5,13,29,37 ids; judge-calibration.ts:56 `threshold = 0.75`; judge-calibration.test.ts:59 makeReplayClient; judge.ts:146,196 idiom only for non-TS.

## [MEDIUM] correctness — evals/buffbench/deterministic-signals.ts:78 — [POLY] Check classifier misses common non-TS compile/typecheck commands, which get the weaker generic cap
- **Risk:** COMPILE_TOKENS covers typecheck/tsc/build/compile only. `cargo check`, `mypy`, `pyright`, `javac`, `mvn -q verify`, `gradle check`, `swiftc`, `go vet` (classified lint) fall to generic (cap 6) or lint (cap 7) instead of compile (cap 3). A Rust or Python type error is therefore clamped far less than a TS type error, a language-biased scoring rule.
- **Fix:** Add compile tokens `cargo check`, `mypy`, `pyright`, `javac`, `kotlinc`, `swiftc`, `dotnet build`, `mvn compile`, `gradle build`; test tokens `cargo test`, `go test`, `dotnet test`, `mvn test`, `rspec`, `phpunit`, `ctest`. Better, let eval JSON declare `{command, category}` explicitly and use the heuristic only as a fallback. Add per-language classifier tests.
- **Evidence:** deterministic-signals.ts:78-99 token lists; :200-207 caps compile 3 / test 5 / lint 7; generic 6 at :246.

## [MEDIUM] correctness — evals/buffbench/eval-idioms-v1.json:16 — [POLY] Idiom seed fixtures reference non-SHA refs on an unverified repo; the top-level gofmt check mutates the tree
- **Risk:** sha/parentSha are ref names ('seed-python-idioms-v1-parent'), not commits. They resolve only if codebuff/idiom-seed-fixtures exists and publishes those branches/tags, and nothing pins content. The mutable refs break reproducibility. The top-level fallback `gofmt -w . && git diff --exit-code` (:11) rewrites files, unlike the per-commit read-only `test -z "$(gofmt -l .)"` (:69).
- **Fix:** Vendor the fixtures in-repo (file:// or generated at setup) or pin real commit SHAs. Add a CI check that each task's parentSha resolves. Replace the mutating gofmt command with `gofmt -l`.
- **Evidence:** eval-idioms-v1.json:2 repoUrl codebuff/idiom-seed-fixtures; :16-17,39-40,62-63 ref-name shas; :11 vs :69 gofmt commands.

## [MEDIUM] error-handling — evals/subagents/test-repo-utils.ts:59 — [BEST] withTestRepo swallows initCommand failure and interpolates parentSha into shell strings
- **Risk:** The init failure is only logged (:59-63), so the eval proceeds on a repo without dependencies and scores measure environment breakage, not agent quality. setupTestRepo throws in the same case (setup-test-repo.ts:325-330), an inconsistent contract. The `git fetch --depth 1 origin ${parentSha}` / `git checkout ${parentSha}` strings run via execSync (:45,49) from eval-JSON values (shell injection surface). stdio 'ignore' hides clone errors.
- **Fix:** Throw on init failure (or mark the run as setup_failed and exclude it from means). Use execFileSync with argv arrays and validate SHAs against /^[0-9a-f]{7,40}$/.
- **Evidence:** test-repo-utils.ts:45,49 template-string execSync; :53-63 catch→console.error; setup-test-repo.ts:320-330 rethrows.

## [MEDIUM] state-mutation — evals/buffbench/run-buffbench.ts:825 — [BEST] Reproducibility: seed does not affect execution, and toolchains/containers are unpinned
- **Risk:** The comment says the seed 'does not alter agent execution'. Judges have no temperature/seed control visible in judge.ts. initCommands use whatever host bun/yarn/python/cargo is installed. Run-to-run drift is therefore unattributable, and non-TS tasks depend on host toolchains CI may lack.
- **Fix:** Record model ids, judge prompts hash, toolchain versions and container digests in FINAL_RESULTS. Run each eval set in a pinned image (SWE-bench-style per-repo Dockerfile or devcontainer/Nix flake). Pass temperature 0/seed to judges where providers support it, and report judge self-consistency across repeats.
- **Evidence:** run-buffbench.ts:825-827 comment; :670-683 seed only logged; judge.ts:216-226 judge models without sampling params.

## [MEDIUM] correctness — evals/buffbench/judge.ts:384 — [BEST] Only 2 of 3 configured judges run: score is a 2-way mean and 'median' narrative is the lower judge
- **Risk:** judge-claude is configured (:226) but never invoked. With 2 judges, one failure halves the ensemble (partial_judge_failure), and there is no tie-break or disagreement signal. The averaged score and the lower judge's narrative can disagree.
- **Fix:** Run all 3 judges and use the true median score, or document why claude is excluded (e.g., self-preference bias when evaluating Claude runners). Record per-judge scores and flag |Δ|>3 disagreements for review.
- **Evidence:** judge.ts:216,221,226 three judge configs; :384-387 only judge-gpt and judge-gemini; :426-430 lower-median selection; :433-441 average.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:167 — [LANG] P8-T3 bespoke Go fleet plus StrykerJS oracle is not the best choice for a polyglot harness
- **Risk:** A new Go process/container manager duplicates mature sandbox runners. StrykerJS measures oracle strength only for JS/TS, so mutation-based oracle strength would be blind for Python/Rust/Go/Java tasks, the exact polyglot gap.
- **Fix:** Prefer reuse. For container/microVM lifecycle, use Inspect AI sandboxes (docker/k8s), the SWE-bench harness image model, or Dagger/testcontainers, driven from the TS runTask. If a native fleet is still wanted, Go is fine (containerd/firecracker-go-sdk ecosystem), but keep it thin per D18. For oracle strength, use per-language mutators: Stryker (JS/TS/C#/Scala), mutmut/cosmic-ray (Python), cargo-mutants (Rust), go-mutesting/gremlins (Go), PIT (Java).
- **Evidence:** PLAN.md:167 'Go runner + TS runTask entry ... oracle strength via StrykerJS mutation'; SPEC.md:191 D18 limits Go to lifecycle.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:168 — [LANG] P8-T1/T2/T4/T6 mechanisms confirmed with refinements
- **Risk:** Largely sound. Remaining risks: the deprecated `duckdb` node package (use @duckdb/node-api), pandas-based stats, and ad-hoc span schemas that are not queryable across tools.
- **Fix:** P8-T1: emit OTel GenAI semantic-convention spans and write Parquet via the collector or duckdb COPY. P8-T2: DuckDB via @duckdb/node-api reading Parquet directly. P8-T4: scipy.stats (exact/permutation Wilcoxon), statsmodels MixedLM or bambi for task×repeat random effects, the krippendorff package, polars over pandas. Keep exact Wilcoxon/power in TS per P8-T4a. P8-T6: DSPy 3 GEPA/MIPROv2 is the right choice. P8-T7: the ONNX export path is fine.
- **Evidence:** PLAN.md:165-178 task wording; SPEC.md:168 D2 Python optional/uv-managed.

## [LOW] test-coverage — evals/compaction-retention/scenario.test.ts:60 — [POLY] Retention/fidelity/edit-block evals plant only .ts paths
- **Risk:** Path-retention and edit-block scenarios use exclusively .ts fixtures, so compaction heuristics that key on TS path shapes, or edit-block parsing of Python indentation, Go tabs or Rust lifetimes ('<<' / '>>' collisions), are untested.
- **Fix:** Parametrize planted paths and edit bodies over a language matrix (py with significant whitespace, go with tabs, rs with generics/lifetimes, java, C# with #region, Makefile tabs) and assert identical retention/fidelity.
- **Evidence:** compaction-retention/scenario.test.ts:60,77,91-92; compaction-fidelity/scenario.test.ts:50-53; edit-blocks/scenario.test.ts:80,131,151,184,238; memory-retention/scenario.test.ts:156,172-173 — all .ts.

## Coverage receipt

### Subsystems
- evals

### Features
- buffbench
- eval-statistics
- retention-evals
- judge-calibration
- deterministic-signals
- eval-task-sets
- eval-isolation
- proposal-promotion

### Files
- evals/buffbench/statistics.ts
- evals/buffbench/setup-test-repo.ts
- evals/buffbench/deterministic-signals.ts
- evals/buffbench/judge-calibration.ts
- evals/buffbench/proposals.ts
- evals/buffbench/run-buffbench.ts
- evals/buffbench/compare-runs.ts
- evals/buffbench/judge.ts
- evals/buffbench/types.ts
- evals/buffbench/agent-runner.ts
- evals/buffbench/runners/claude.ts
- evals/buffbench/runners/codex.ts
- evals/buffbench/runners/opencode.ts
- evals/buffbench/eval-idioms-v1.json
- evals/buffbench/eval-saleor.json
- evals/buffbench/eval-saleor2.json
- evals/buffbench/eval-saleor-hard.json
- evals/buffbench/eval-plane.json
- evals/buffbench/eval-plane2.json
- evals/buffbench/eval-plane-hard.json
- evals/buffbench/eval-manifold.json
- evals/buffbench/eval-manifold2.json
- evals/buffbench/eval-manifold-hard.json
- evals/buffbench/eval-codebuff.json
- evals/buffbench/eval-codebuff2.json
- evals/buffbench/eval-codebuff-hard.json
- evals/buffbench/eval-openbuff-v2.json
- evals/buffbench/__tests__/judge-calibration.test.ts
- evals/buffbench/__tests__/fixtures/judge-gold-set.json
- evals/subagents/test-repo-utils.ts
- evals/compaction-retention/scenario.test.ts
- evals/compaction-fidelity/scenario.test.ts
- evals/memory-retention/scenario.test.ts
- evals/edit-blocks/scenario.test.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
