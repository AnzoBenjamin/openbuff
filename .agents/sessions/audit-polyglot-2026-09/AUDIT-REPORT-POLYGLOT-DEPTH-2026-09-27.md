# Polyglot Depth Audit — Openbuff (2026-09-27)

Companion to `AUDIT-REPORT.md` (unmodified; the roadmap PLAN cites it as prior evidence). This audit answers the narrower question the roadmap does not: **which parts of the codebase would genuinely be better in a different language, why, what each migration unlocks, and what new features the polyglot end-state enables.**

Performed against structural snapshot `4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba`.

## Method and coverage

- 8 read-only audit shards, one per top-level subsystem, each bound to the snapshot and persisted under `findings/`: `shard-sdk-2.md`, `shard-agent-runtime.md`, `shard-parse-index.md`, `shard-cli-tui.md`, `shard-common-polyglot.md`, `shard-agents.md`, `shard-evals-infra.md`, `shard-infra-native.md` (~100 findings; no CRITICAL; the security HIGHs are carried findings already tracked in the roadmap).
- Candidate language amendments were weighed against locked SPEC decisions D1–D9 by a decision pass: all 9 survive in some form, with 3 sub-claim rejections (arboard "missing from plan" — it is P7-T5; "Rust store before the daemon" — do the TS sqlite version first; "build a tiktoken crate now" — prefer a prebuilt).
- Out of scope: hosted web surfaces (removed from this fork), `.agents/` planning artifacts, and the 5 pre-existing shard files from the 2026-09-26 run (superseded by this sweep).
- Coverage limitation, recorded honestly: the runtime `evaluate_audit_coverage` machine-check rejects parent-rebuilt receipts (by design; receipts must come from the shards' own `write_audit_findings` emissions, which all 8 did — each is snapshot-bound to the same inventory snapshot). Subsystem coverage was therefore confirmed manually: every top-level subsystem is covered by exactly one fresh shard.
- No source files were modified; no validations run (audit-only per request).

---

## 1. Verdict summary

The locked architecture (TS protocol-first core + supervised sidecars in the best language per capability + evidence-gated napi kernels) is **well-supported by the code**. The 8 shards independently converged on it rather than against it. What the audit adds is:

1. **One warranted challenge to the locked plan:** the 2451-line lexical `terminal-command-policy.ts` should be promoted from "advisory pre-check, not the boundary" (P4-T8's cap) to the authoritative parse gate *inside* the planned Rust sandbox shim once it exists (P5-T1).
2. **A set of evidence-gated napi kernel candidates with quantified hot loops** (tiktoken token counting; semantic cosine dot-product; grapheme wrap) — the strongest of which can justify the first X-2 baseline rows.
3. **Prerequisite TS fixes without which the X-2 evidence gate itself would lie** (index refresh re-hashing, O(n²) depth assignment, vocabulary scans). These must land before baselining.
4. **Plan gaps to add** (startup latency, image renderer integration, interim Linux watcher, large-session rendering, eval containerization/artifacts).
5. **An explicit "stays TS, do not migrate" list** so kernel work is not swept across cold-path or contract-critical code.

---

## 2. Components that are much better in another language (Q1)

### 2a. Tier 1 — must be another language (TS cannot reach the capability)

| # | Component | Evidence | Language | What it unlocks | Difficulty |
|---|---|---|---|---|---|
| 1 | Terminal exec boundary + **shell parse gate** | sdk/src/tools/terminal-command-policy.ts (2451 lines; regex `quotedContentRanges`/`splitReadOnlyShellSegments`/`scanActiveShellSyntax` approximate context-free shell semantics; false negatives are workspace-escape vectors) | Rust (in the planned `openbuff-sandbox` shim, P5-T1) | A **sound argv-plan-or-refuse gate** (real shell parser co-located with enforcement) instead of lexical approximation; OS-enforced profiles (Landlock/seccomp/Seatbelt/AppContainer); the weakest security link becomes the strongest | High (adversarial tests, security review, 3-OS matrix) |
| 2 | Process-tree supervision | sdk/src/tools/background-jobs.ts (250ms userspace poller; orphans detached children on crash; pid-reuse guard Linux-only) and packages/agent-runtime/src/util/background-agent-jobs.ts (in-process Map + view-owned AbortControllers; reconcile-and-mark-interrupted on crash; app-heuristic caps standing in for OS accounting) | Rust (`jobd`, P5-T2, absorbed by daemon P6-T5) | Guaranteed tree kill, cgroups v2/pidfd/subreaper/Job Objects, mem/cpu/pids caps, live RSS, crash-survivable reattach with exit codes. **Supervision of agent runs — not just spawned commands — belongs here** | High (agents move across a process boundary; chunk streaming becomes IPC) |
| 3 | Index/lanes service | packages/indexer/src/index-store.ts (whole-JSON rewrite per save + fsync/rename + ~430-line hand-rolled advisory lock :757–940), grammar-wasm-repair.ts (400-line pinned-WASM download/verify surface), watching disabled on Linux+Bun | Rust (daemon, P6-T5/T6/T7; D1) | notify-driven live watching (today: 5-min staleness heuristic only), tantivy BM25/fuzzy/phrase, transactional store, concurrent readers+writer, deletion of the WASM-grammar distribution surface for the CLI binary | High, correctly sequenced after the daemon exists |
| 4 | Workspace lanes / COW / merge | workspace-mutation-broker.ts (single workspace behind one mkdir lock) | Rust (gix in-memory trees, reflink/clonefile; mergiraf as GPL sidecar, D3) | Best-of-N parallel agents, syntax-aware auto-merge, `land_lane` via merge-tree | High |
| 5 | Learning-loop optimizers | evals/buffbench/proposals.ts, lessons-extractor.ts | Python (P8-T4, uv-managed) | DSPy/GEPA prompt optimization, scipy/statsmodels mixed effects, krippendorff/Bradley-Terry judge calibration, lightgbm+SHAP failure mining, optuna BO over pruner caps | Medium (sidecar, never hot path) |
| 6 | Local inference | sdk/src/impl/model-provider.ts | C++/Rust sidecar (llama.cpp via mistral.rs/llama-cpp-2; D7) | Grammar-constrained tool calls, KV sequence forks for spawn_agents, disk snapshots for instant resume; never in-process under Bun (segfault precedent) | High |
| 7 | Surfaces beyond terminal | cli (TUI), approvals, editors | Swift/Kotlin (mobile, P7-T4), Tauri (desktop, P7-T3), Kotlin/Lua/Elisp/Zed-native (editors, P7-T2) | Push approvals, Live Activities, split panes/rich media/tray, bidirectional editor links | Medium per surface |
| 8 | Secret corpus authority | common/src/util/redact-secrets.ts:15–21 (5 token shapes + 1 keyword regex; misses JWTs, entropy, most providers) | Go gitleaks (P5-T5) — **but only as rule authority**; stream-time TS redaction stays in-process | ~200 rules + entropy detection + live key verification; the TS regex table is **codegen'd from the gitleaks TOML** (three-mirror pattern) so the two corpora cannot drift | Low |
| 9 | Eval fleet isolation | evals/subagents/test-repo-utils.ts:40–70 (mkdtemp + clone only; external CLIs run `--dangerously-skip-permissions` / `--full-auto` unsandboxed on a CI runner seeded with provider keys) | Go (P8-T3) + interim TS docker/podman wrapper **now** | Sandboxed, resumable, repeated trials at fleet scale; the TS wrapper closes the hole before P8 | Medium interim / High fleet |

### 2b. Tier 2 — evidence-gated napi kernels (each needs its X-2 row first)

Ranked by clarity of the quantified evidence:

1. **Token counting** (packages/agent-runtime/src/util/token-counter.ts). The whole design is shaped around one JS dependency limitation: gpt-tokenizer BPE is pathological (5MB body stalled CI >2min), forcing a 100k-char cap + 20k-sample extrapolation (~2% error) and three hand-tuned fudge factors (1.35 Anthropic / 1.0 OpenAI / 1.1 Gemini). A tiktoken napi kernel gives exact per-model counts and **deletes an entire layer of dependency-driven complexity**, not just latency. Clean pure-function boundary; LRU cache stays TS. May be pulled forward ahead of P3-T10 as the first kernel — prefer an existing prebuilt; build in the X-3b workspace only if no maintained prebuilt passes dependency review.
2. **Semantic cosine similarity** (packages/indexer/src/semantic.ts:63–75, :205–217). Linear scan of ~20k × 1536-dim vectors per query (~30M multiply-adds + allocations, then sort) — the clearest quantified hot loop in the repo, with a plain-data contract. SIMD/batched dot-product kernel fits the D8 workspace charter exactly; scalar JS path stays as the fallback. Caveat to encode in the task: vectors persist as JSON number arrays, so **loading cost may rival compute cost** — pair with a binary vector container or the sqlite store below.
3. **Grapheme-correct text wrap** (cli/src/utils/text-layout.ts:31–33, 80–84). Splits on code points via `Array.from`, not grapheme clusters (emoji ZWJ/skin-tone split across lines; width mis-measure), and re-measures per char per keystroke (chat.tsx:1531) and per code-block line per frame. Kernel: intl grapheme segmentation + unicode-width + greedy wrap, shared by text-layout and the markdown renderer. This is also a **correctness** fix, not just speed.
4. **Tree-sitter preflight/parse tier** (packages/agent-runtime/src/util/preflight-syntax-validation.ts). JS/TS preflight **fails open in Node** (Bun.Transpiler guard returns valid:true), so the edit-cascade gate is absent outside Bun; Python/Go validation is hand-rolled heuristics with both FP and FN. Route all languages through tree-sitter grammars; a Rust binding is the throughput option. Supports the P0-T5 → P6-T7 progression.
5. **Image decode/encode pipeline** (cli/src/utils/image-handler.ts:120–190 — up to 16 full Jimp decode/resize/encode passes synchronously; thumbnail bilinear resize in JS; sdk browser-logs.ts hand-rolled PNG/APNG+CRC32+pixel-diff). P7-T7 kernel scope should extend from decode to encode/resize, and (per §4) must include a renderer-integration protocol.

### 2c. Explicitly TS-is-right (do not migrate)

- **cap.v3 encode/decode** (common/src/util/content-hash.ts) — the HMAC key is module-scope `randomBytes(32)`; tokens are irreducibly in-process. No sidecar can mint or verify them without a key-sharing ABI. Keep in TS; publish grammar + golden vectors before any daemon ever verifies snapshots.
- **Agent loop / run orchestration** (run.ts, run-agent-step.ts, main-prompt.ts) — I/O-bound on LLM latency; a language change worsens complexity risk. Protocol-first TS core is locked.
- **llm.ts streaming/retry/failover and all provider adapters** (packages/internal openai-compatible/openrouter) — thin AI-SDK-v5 integration layers; vendor-quirk error mapping (array-wrapped payloads, Google RPC reason extraction) is hard-won and behaviorally pinned. **No HTTP/JSON error-mapping crosses into Rust.**
- **Mutation broker receipt journal / workspace-journal** — correctly durable in TS (fsync file+dir, staged writes, fail-closed recovery). Rust adds risk, not guarantees.
- **Streaming XML tool-call parser** (stream-xml-parser.ts, tool-stream-parser.ts) — bounded O(chunk) scan at network cadence; per-chunk FFI marshaling would cost more than the scan.
- **Workflow engine, orchestration ledger, agent-attempt selection** — advisory/pure TS.
- **Fuzzy matching at command-palette scale** — nucleo kernel scoped to large-corpus history search only.
- **memory-v2 bun:sqlite repository** — bun:sqlite *is* the native kernel; the real cost is the JS lexical fold over up to 10k events — use the probed-but-unused FTS5 to prefilter in SQL instead.
- **ripgrep integration** — external native binary is the correct pattern.
- **MCP client** — @modelcontextprotocol/sdk is canonical; the found gaps (clients never closed, cache never invalidated, no timeouts, `isError` ignored → MCP tool errors reach the model as success-shaped text) are all TS-only fixes.
- **Evals judging/signals/statistics core, scripts/, pre-push gate** — Go fleet owns only process/container lifecycle when it lands.
- **agents/ prompt surfaces** — locked non-goal; only descriptor-generated contract sections change.
- **Provider/tool-call serialization glue** (prepareTools, phantom-tool filtering) — vendor-quirk-heavy; a port re-derives lost knowledge.
- **Orphans, never port:** saxy.ts and partial-json-delta.ts have **zero production consumers** (test-only imports) and are O(n²) if revived; min-heap.ts is dead code. Delete or wire, never port.

---

## 3. What features the polyglot end-state unlocks (Q2)

Deduplicated against the roadmap's own Q2 list; these are the **additions and sharpenings** from this audit, not a repeat:

1. **A sound shell gate, not a heuristic one** — the shim's real shell parser converts "command denied" false-denies and false-allows into a parseable argv plan with per-node "why denied" explanations (extends P4-T8/P5-T1).
2. **Durable programmatic agents** — a persistent per-run QuickJS VM with bytecode/heap-snapshot checkpoints replaces the leak-prone in-memory generator registry: true generator serialization, replay, crash resume, and retirement of the serialized-handleSteps duplication machinery (gate-helper codegen + freshness tests + the 3166-line context-pruner inline). The single highest-leverage change in the agents subsystem.
3. **Exact token budgets** — per-model exact counts remove ~2% extrapolation error and the fudge-factor layer, tightening context-budget decisions and cost accounting.
4. **Live index + honest baselines** — notify-driven watching (recursive watching is entirely disabled on Linux+Bun today; age-sweeps only) plus TS-path fixes that let X-2 measure reality instead of mis-attributing hashing/walk/persist costs to WASM parsing.
5. **Transactional index store** — bun:sqlite WAL behind the existing `loadIndex`/`saveIndex` signatures deletes the 430-line advisory lock and the whole-document rewrite; superseded later by the daemon's redb/rusqlite store.
6. **Fast, correct TUI** — startup under ~150ms (OSC probe parallelized, tree-sitter init deferred off module scope, registries loaded post-first-frame), no full-document markdown re-parse per chunk (per-block AST prefix caching + viewport virtualization), correct grapheme wrap, real sixel/kitty images with cell placement/ids/eviction.
7. **Descriptor-driven agent contract** — base2's ~40-agent roster and tool names become generated data (Zod/JSON-Schema → prose), wire-stable under ACP namespacing; `agent.yaml v0` from the existing SpecialistConfig factory lets non-TS authors write agents; structured JSON-RPC hook receipts retire receipt-parsing out of message text.
8. **Honest evals** — containerized interim isolation for untrusted CLIs, artifact uploads so the OTel/Parquet and DuckDB observatory tracks have data to ingest, small-n Wilcoxon guard + power/MDE sizing so the promotion gate cannot mis-promote on noise in either direction.
9. **Single rule authority for secrets** — gitleaks TOML as the corpus of record, codegen'd into the TS hot path; no drift between stream-time redaction and commit gating.
10. **Capability-advertised language intelligence** — the inert `language-capabilities.ts` registry becomes the serialized sidecar capability manifest (parsers, LSP argv/transport/rootMarkers), consumed by the Rust tier and reported honestly via X-4.
11. **Language-neutral tool ABI** — `z.toJSONSchema(io:'input')` pinned as the published artifact feeding Python/Go SDK codegen and JSON-Schema tool descriptors; the TS mapper's silent `any` fallback must throw in CI.

---

## 4. Accepted plan amendments (for the roadmap maintainers)

All are extensions of the locked SPEC, not contradictions. Task wording:

- **X-2a (new, prerequisite to X-2's index rows)** — TS-path index fixes before baselining: (1) metadata-indexer refresh gates hashing on stat mtime+size (:262–303); (2) structure.ts `assignDepths` → interval-stack sweep (:355–374); (3) bound the query-data vocabulary substring scan (:46–73). X-2 index rows must separately report walk+hash / parse / score / persist / query-p99, including cold first-ever parse. lang TS.
- **X-1 (extend)** — publish per-tool `z.toJSONSchema(io:'input')` artifacts + golden vectors; mapper `any` fallback throws in CI; base2 spawn-contract/toolNames emission rides this pipeline (also referenced from P1-T1).
- **X-3b (extend)** — commit `rust-toolchain.toml` (the MSRV/resolver incident is already-paid tax); charter rules: no dual JS mirror of any napi export (single-source Rust + thin TS shim, or a property-based cross-mode fuzz gate running the actual binary — the PC-3 lesson); carry forward the scaffold's degraded-mode/telemetry loading pattern as a design note (the one high-quality part of native-core worth referencing before deletion); first napi kernel candidate = semantic dot-product (X-2-gated, with binary vector container note).
- **X-4 (extend)** — capability map sourced from `language-capabilities.ts`, serialized at sidecar handshake; freeze `SupportedLanguageId`/`LanguageToolRole`/`LanguageValidationStage` with golden vectors.
- **P1-T1 (extend)** — emit the base2 spawn-contract paragraph, `toolNames`/`programmaticToolNames`, and per-agent tool bindings from Zod descriptors; retire the roster-drift/parity test family's prose-sync role.
- **P1-T9 (new)** — CLI startup-path latency: run `detectTerminalTheme` concurrently with `initializeApp` (index.tsx:333–343 blocks up to 600ms before `parseCliArgs`); defer `Parser.init` (pre-init/tree-sitter-wasm.ts:77–93 readFileSync at module scope) and agent/skill registry loads to post-first-frame; pre-warm rg extraction. lang TS. gate: cold-start X-2 row + tmux smoke.
- **P1-T10 (new)** — Large-session rendering: per-block AST prefix caching (re-parse only the trailing unclosed segment; markdown-renderer.tsx:1197 re-parses the whole document per chunk), viewport-windowed block virtualization in the ~1900-line chat.tsx, memo per-block markdown by content hash. lang TS. gate: rerender-perf integration test regression-free.
- **P2-T9 (new, small)** — Interim index watcher for Linux+Bun: worker-thread non-recursive per-directory watchers with an fd cap (or documented age-sweep tier) until P6-T6 notify lands. Do not build a napi watcher kernel just to delete it at P6-T6.
- **P3-T10 (amend)** — tiktoken pull-forward: commit the X-2 token-count baseline row (including a ≥5MB pathological input), then (a) adopt an existing prebuilt tiktoken napi if dependency review passes, else (b) add tiktoken in the X-3b workspace. Keep the TS gpt-tokenizer path as the fallback tier.
- **P4-T8 / P5-T1 (amend)** — shell-parser gate progression: after P5-T1 exists, the TS policy is demoted to fast pre-check/cross-check; the authoritative gate is the shim's shell parser ingesting a structured argv plan or refusing. Until then, add property-based differential tests (policy decisions vs. real `bash -n` traces over an adversarial corpus) as compensation for lexical unsoundness. Tier reported honestly via X-4 (`sandbox: lexical-only` vs `sandbox: parse+landlock`).
- **P5-T5 (extend)** — gitleaks TOML as the single rule authority; TS `TOKEN_SHAPES` codegen'd from it (three-mirror step) with the frozen `[REDACTED]` contract pinned by golden vectors; stream-time redaction remains in-process TS.
- **P6-T6a (new)** — transactional bun:sqlite WAL store behind existing `loadIndex`/`saveIndex`/`computeIndexSnapshotId` signatures; delete the advisory-lock machinery; snapshotId golden vectors; `chunk-freshness` stableChunkId contract frozen. Superseded by the daemon's redb/rusqlite store at P6-T6.
- **P7-T5 (amend)** — explicitly covers clipboard image get/put via arboard and absorbs the blocking text-clipboard `execSync` path (clipboard.ts:120–146).
- **P7-T7 (amend)** — image kernel deliverable includes the OpenTUI renderer-integration protocol (cell placement, image ids, eviction/DELETE-on-scroll, kitty id + chunked-m correctness, sixel implementation at terminal-images.ts:196–199).
- **P8-T0 (new, pre-P8)** — opt-in TS docker/podman wrapper around eval `withTestRepo` for external CLIs and final checks; artifact uploads (`actions/upload-artifact`, `if: always()`) in buffbench.yml/nightly-evals.yml; concurrency group + cost-cap in evals.yml. lang TS/YAML. gate: untrusted runner cannot reach host env secrets in a container-run smoke.
- **P8-T4a (new, small, TS)** — exact Wilcoxon or n<10 guard warning; simulation-based power/MDE via the seeded RNG to size `--repeats`; thread mean±SE into compare-runs delta classification. gate: promotion gate rejects underpowered comparisons.
- **P9-T1a (new, precursor)** — agent.yaml v0 generated from `SpecialistConfig` (specialists, researcher-docs, browser-use); prose stays as data. Full declarative surface stays at P9-T1.
- **P9-T2 (amend)** — structured JSON-RPC hook receipts; `collectHookFailures` text parsing retired; `terminal_session` returns structured stdout blocks.
- **P9-T4 (amend)** — QuickJS as a **persistent per-run VM** (one VM held across STEP/STEP_ALL yields, not per-step instantiation): host↔VM boundary is `HandleStepsYieldValueSchema`; generator state checkpointed via JS bytecode/heap serialization into the P2-T2 run journal, replacing the in-memory generator registry (and its runId-collision warnings). Prioritize within track F.

---

## 5. Ranked top-5 macro migrations

(napi micro-kernels are a separate tier, ordered by X-2 evidence, per §2b.)

1. **Rust sandbox shim `openbuff-sandbox`** (P5-T1, first X-3b crate, now extended with the shell-parser gate) — highest leverage: converts the weakest security link; shares crates with everything downstream.
2. **Rust jobd + resident daemon** (P5-T2 → P6-T5, D1) — crash-survivable supervision of agent runs and commands that TS fundamentally cannot provide.
3. **Rust index service** (P6-T5/T6/T7) — capability unlock (live watching, BM25, transactional store, deleted WASM-grammar surface), correctly sequenced after the TS pre-fixes and TS-first store keep the interim honest.
4. **Go gitleaks sidecar** (P5-T5) — low difficulty, high security leverage, and the codegen tie-in strengthens the TS hot path for free.
5. **Rust local inference sidecar** (P9-T6, D7) — capability with no TS path at all; ranked last only because it is deep in the phase order.

## 6. Shards and coverage

| Shard | Subsystem(s) | Findings | Key verdict |
|---|---|---|---|
| shard-sdk-2 | sdk-core, llm stack, terminal policy, supervision, mutation, browser, filesystem, native binding | 14 (1 HIGH) | Shell gate → shim (the one warranted challenge); broker/llm/cdp stay TS |
| shard-agent-runtime | loop, streaming parse, token counting, context, edit txn, jobs, orchestration, sandboxing | 11 | tiktoken kernel; persistent QuickJS; jobd absorbs supervision; 5 TS-is-right flags |
| shard-parse-index | parse tier, chunks, grammar lifecycle, store, query, metadata graph, semantic, walk | 15 (2 HIGH) | Locked sequencing correct; X-2 prerequisite fixes; cosine kernel; sqlite store first |
| shard-cli-tui | shell, startup, render, layout, images, clipboard, memory-v2, watcher, rg, fuzzy | 16 (4 HIGH) | Grapheme wrap kernel; image renderer-integration spec; startup + markdown re-parse are TS work |
| shard-common-polyglot | contracts, hashing, redaction, xml/json streaming, registry, mcp, codegen | 13 (1 HIGH) | cap.v3 irreducibly TS; gitleaks rule authority; orphaned saxy/partial-json-delta |
| shard-agents | tmux-cli, basher, librarian, editor, base2 gate, pruner, specialists, researchers | 14 (2 HIGH) | Serialized handleSteps is the constraint; descriptors; tmux-cli helper retirement unmapped in PLAN |
| shard-evals-infra | harness, runners, statistics, scripts, CI | 12 (1 HIGH) | No eval isolation today; TS docker wrapper now; no earlier Python |
| shard-infra-native | native-core, internal providers, build-tools, CI | 11 (1 HIGH) | D8 deletion confirmed safe (zero consumers); PC-6 still true; carry the loading pattern forward |

One PLAN-mapping follow-up noted by the agents shard: no current task names the retirement of the tmux-cli `/tmp` helper (its ~190-line inline bash helper, capture lifecycle, and 24h `find -exec rm` sweep); when P5-T4 lands, add the tmux-cli migration as its explicit consumer.
