# Audit findings: r8-rust-evals-providers

- Subsystems: rust-workspace-openbuff-native, evals-buffbench, scripts-ci-guards, packages-internal-providers, github-workflows-ci
- Features: D49-multi-call-binary, PC-6-rust-ci-native-path, buffbench-statistics, proposal-promotion-gate, openai-compatible-provider-wrapper, openrouter-provider-wrapper, buffbench-ci-trigger
- Files covered: 19
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [MEDIUM] test-coverage — .github/workflows/buffbench.yml:5 — Evals never gate PRs — buffbench is workflow_dispatch-only and evals.yml requires a [buffbench] commit tag
- **Risk:** BuffBench runs are manual-only (workflow_dispatch) or commit-message-gated ([buffbench] tag in evals.yml:24), so changes to judge.ts, statistics.ts, proposals.ts, or runner logic merge to main with zero eval execution. The eval harness cannot catch regressions in the harness itself; only its unit tests (which do run under ci.yml's repo-wide bun test) protect it.
- **Fix:** Add a lightweight deterministic gate to ci.yml (evals/buffbench __tests__ already exist and do run via the repo-wide bun test find); for the LLM-judged eval itself, add a scheduled or label-triggered required check on buffbench-critical paths (judge.ts, statistics.ts, proposals.ts, runners/) so a regression in scoring or the promotion gate cannot merge silently.
- **Evidence:** buffbench.yml trigger block is `on: workflow_dispatch:` only; evals.yml 'Check commit message' step greps for the literal tag; grep of .github/workflows shows run-buffbench only in buffbench.yml:47 and nightly-evals.yml:50, never in a PR-gating job.

## [MEDIUM] correctness — evals/buffbench/run-buffbench.ts:244 — Promotion gate (decideProposalPromotion) is never invoked in the live eval loop
- **Risk:** run-buffbench.ts applies proposals as a dry-run (applyProposals) but never calls decideProposalPromotion, so the minTotalScoreDelta / no-regressions / significance gate exists only in tests. The closed loop described in proposals.ts (dry-run → promote decision) is not enforced anywhere in the live pipeline; promotion decisions are ad-hoc human calls with no recorded verdict.
- **Fix:** Wire decideProposalPromotion into the run-buffbench lessons/proposals flow (emit the report as part of run output and record accept/reject with reasons), and default requireSignificance to true wherever paired per-task scores are available; keep false only when pairs are structurally unavailable.
- **Evidence:** code_search shows decideProposalPromotion referenced only in proposals.ts:385 and __tests__/proposals.test.ts (lines 76, 116, 179, 241); run-buffbench.ts imports applyProposals (line 14) and calls it at 244 but never decideProposalPromotion.

## [LOW] correctness — evals/buffbench/statistics.ts:251 — Wilcoxon varW<=0 branch returns applicable:true with a neutral z=0/p=1 result
- **Risk:** When the tie-corrected variance collapses to <= 0, the test returns applicable:true with z=0 and pValueTwoSided=1. Callers treating applicable=true as 'a computed p-value' get a degenerate neutral verdict mislabeled as computed. In practice p=1 still blocks promotion (p > maxPValue), but the semantics are inconsistent with the not-applicable path and mislead log readers.
- **Fix:** Return applicable:false with an explicit degenerate-variance reason (mirroring WILCOXON_NOT_APPLICABLE_REASON) so the fail-closed contract in proposals.ts:430-436 blocks promotion uniformly; or document why a degenerate ranking should count as a computed test.
- **Evidence:** wilcoxonSignedRankTest lines 249-257: `if (varW <= 0) return { statistic: W, n, z: 0, pValueTwoSided: 1, applicable: true }` — no reason field, unlike the n<10 branch which returns applicable:false.

## [LOW] error-handling — evals/buffbench/statistics.ts:79 — pairedBootstrapMeanDiffCI returns an all-zero sentinel CI for empty pairs
- **Risk:** Empty input yields {meanDiff:0, lower:0, upper:0} indistinguishable from a real measurement of exactly zero effect with a degenerate zero-width CI. decideProposalPromotion guards this upstream (fail-closed on empty pairedScores), but any future caller reading the CI directly could interpret [0,0] as 'precisely measured, no improvement' rather than 'no data'.
- **Fix:** Return a structured empty verdict (e.g. applicable:false / reason) like the Wilcoxon path, or at minimum document that lower=upper=0 is an empty-input sentinel, not a tight CI around zero effect.
- **Evidence:** pairedBootstrapMeanDiffCI: `if (pairs.length === 0) return { meanDiff: 0, lower: 0, upper: 0, iterations }` — no explicit empty flag; contrast wilcoxonSignedRankTest which returns an explicit applicable:false + reason for the same condition.

## [MEDIUM] correctness — rust/crates/openbuff-native/src/lib.rs:74 — D49 exec role plan (bubblewrap+seccomp) is Linux-only while CI ships the binary for windows-msvc and apple-darwin
- **Risk:** The D49 multi-call binary is built, smoke-tested, and uploaded for x86_64-pc-windows-msvc and x86_64-apple-darwin, but the planned exec implementation (bubblewrap+seccomp) only exists on Linux. Without a planned cfg-gated fallback, the shipped darwin/windows artifacts will contain an exec role that fails at runtime, and the not_implemented → implemented transition will silently break those targets.
- **Fix:** State the platform contract in lib.rs/main.rs now (exec role is linux-gnu/musl targets only; other targets return a structured 'unsupported_platform' error), and plan a cfg(target_os) split so the darwin/windows artifacts either omit the exec role or map it to platform-native sandboxing (sandbox-exec / AppContainer) explicitly.
- **Evidence:** main.rs USAGE lists all five roles unconditionally; rust-workspace.yml uploads openbuff-native-{x86_64-pc-windows-msvc, x86_64-apple-darwin} artifacts; lib.rs doc comment promises 'real role implementations land with P5-T1+' with no platform-scoping note.

## [LOW] dependency-hygiene — rust/crates/openbuff-native/src/lib.rs:74 — 'Zero external deps' charter comment will be violated by the planned rusqlite daemon role
- **Risk:** The charter comment 'zero external deps is a charter requirement' conflicts with the planned daemon implementation (rusqlite, which bundles C sqlite3 and requires a cc toolchain) and exec (libseccomp/bubblewrap interplay). The 1.87.0 toolchain pin plus MSRV-audit process (documented in rust-toolchain.toml) is good, but the charter language will force either a silent charter break or an artificial std-only sqlite client.
- **Fix:** Amend the charter to scope 'zero deps' to the current dispatch milestone, and pre-register the planned dependency set (rusqlite bundled feature, its cc build, MSRV evidence) in Cargo.toml workspace.dependencies with the same reviewed-bump discipline as the toolchain pin.
- **Evidence:** lib.rs:74 'zero external deps is a charter requirement'; rust-toolchain.toml pins channel 1.87.0 with a 'bump deliberately' policy; Cargo.toml [workspace.dependencies] is empty with a comment anticipating shared deps.

## [MEDIUM] dependency-hygiene — packages/internal/src/openai-compatible/openai-compatible-provider.ts:1 — Two hand-rolled provider wrappers vendored from upstream SDKs — drift risk with no upstream-tracking policy
- **Risk:** openai-compatible is effectively a vendored copy of @ai-sdk/openai-compatible (same public surface, same provider-utils helpers, pinned local VERSION), and openrouter-ai-sdk is a fork of @openrouter/ai-sdk-provider. Both drift from upstream bug/security fixes silently; the OpenRouter fork additionally carries oddities (hardcoded 'openai/gpt-3.5-turbo-instruct' completion routing, deprecated baseUrl alias) that must be maintained by hand as @ai-sdk/provider V2/V3 specs evolve.
- **Fix:** If there are no intentional local patches, replace the openai-compatible wrapper with the upstream @ai-sdk/openai-compatible package and keep only the OpenRouter fork (which carries real local behavior: extraBody, billing-summary chunks, finish-reason mapping). For the fork, add a VENDORED_FROM/UPSTREAM header with the upstream commit and a periodic drift check, or upstream the local features to @openrouter/ai-sdk-provider.
- **Evidence:** openai-compatible-provider.ts mirrors @ai-sdk/openai-compatible's createOpenAICompatible shape (provider-utils helpers, VERSION from ./version.ts); provider.ts hardcodes the gpt-3.5-turbo-instruct completion routing and a deprecated baseUrl alias; packages/internal deps are @ai-sdk/provider ^2.0.1, @ai-sdk/provider-utils ^3.0.17, ai ^5.0.52.

## [LOW] api-contract — packages/internal/src/openrouter-ai-sdk/provider.ts:18 — OpenRouterProvider extends LanguageModelV2 — provider factory typed as a model instance
- **Risk:** The OpenRouterProvider callable is declared to extend LanguageModelV2 itself, conflating the provider factory with a model instance. This makes the provider assignable where a LanguageModelV2 is expected (e.g. as a model argument), which the AI-SDK spec does not intend, and can mask type errors when consumers pass the provider instead of a created model.
- **Fix:** Type OpenRouterProvider after the upstream provider shape (callable returning LanguageModelV2, not extending it), aligning with the openai-compatible sibling, and add a compile-time structural check against the upstream ProviderV2 helper types.
- **Evidence:** provider.ts line 18: `export interface OpenRouterProvider extends LanguageModelV2` while its call signatures return OpenRouterChatLanguageModel/OpenRouterCompletionLanguageModel; the sibling OpenAICompatibleProvider correctly extends Omit<ProviderV2, 'imageModel'> instead.

## [LOW] test-coverage — .github/workflows/rust-workspace.yml:110 — Rust CI has no clippy/fmt gate — build-test runs only cargo build + cargo test
- **Risk:** The Rust CI matrix faithfully runs build + test + smoke (PC-6 satisfied), but neither leg runs cargo clippy or cargo fmt --check, so lint-level regressions (unsafe patterns, needless clones) and formatting drift reach main un-gated. check-ci-local also has no Rust step, so pre-push local coverage mirrors CI exactly (no lint) rather than exceeding it.
- **Fix:** Add `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check` to the build-test job (one extra cached step, O(1) per the charter).
- **Evidence:** cargo build/test steps at .github/workflows/rust-workspace.yml lines ~110-125; no clippy/rustfmt invocation anywhere in the file; check-ci-local.ts FULL_SUITE_STEPS covers only agents and common.

## [LOW] state-mutation — evals/buffbench/run-buffbench.ts:244 — Verified: proposal dry-run path never persists — no state-mutation leak from evals into agent definitions
- **Risk:** Positive: applyProposals deep-copies definitions (structuredClone) and never persists; the eval loop only produces a dry-run report, and the promotion decision remains manual. No auto-write path exists from eval results to agent definitions, so the eval harness cannot mutate shipped agent configs.
- **Fix:** None required; optionally emit decideProposalPromotion's report into the run output artifacts so the dry-run → decision chain is recorded even while promotion remains manual.
- **Evidence:** proposals.ts applyProposals doc: 'human-reviewable dry-run report'; module header: 'This module never persists proposal changes'; run-buffbench.ts line 244 is the only non-test call site.

## Coverage receipt

### Subsystems
- rust-workspace-openbuff-native
- evals-buffbench
- scripts-ci-guards
- packages-internal-providers
- github-workflows-ci

### Features
- D49-multi-call-binary
- PC-6-rust-ci-native-path
- buffbench-statistics
- proposal-promotion-gate
- openai-compatible-provider-wrapper
- openrouter-provider-wrapper
- buffbench-ci-trigger

### Files
- rust/Cargo.toml
- rust/crates/openbuff-native/src/lib.rs
- rust/crates/openbuff-native/src/main.rs
- rust/rust-toolchain.toml
- .github/workflows/rust-workspace.yml
- rust/scripts/smoke-test-sidecar.sh
- evals/buffbench/statistics.ts
- evals/buffbench/proposals.ts
- evals/buffbench/run-buffbench.ts
- evals/buffbench/plan-sharding-signals.ts
- evals/package.json
- scripts/check-ci-local.ts
- scripts/measure-perf-guards-baseline.ts
- .github/workflows/buffbench.yml
- .github/workflows/evals.yml
- .github/workflows/ci.yml
- packages/internal/src/openai-compatible/openai-compatible-provider.ts
- packages/internal/src/openrouter-ai-sdk/provider.ts
- packages/internal/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
