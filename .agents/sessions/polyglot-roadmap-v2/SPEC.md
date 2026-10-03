# SPEC — Polyglot Roadmap v2 (protocol-first, capability-driven)

Supersedes `.agents/sessions/polyglot-native-waves/` (the "Rust hot paths via napi, behind frozen TS interfaces" plan). This roadmap covers every finding in:
- `.agents/sessions/reaudit-polyglot-2026-09/REAUDIT-REPORT.md` (89 findings, 8 lenses)
- `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md` (72 findings; prior Q1/Q2 and Waves 0–5)
- `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT-POLYGLOT-DEPTH-2026-09-27.md` (depth audit: 8 subsystem shards, ~100 findings; source of the 2026-09-27 amendments below)

## Goal

Get past the five architectural ceilings the re-audit found:
- no out-of-process protocol
- no OS sandbox
- a single shared workspace
- no learning loop
- no semantic language tooling

Use other languages where they give access to a capability TS/Bun can't reach: OS APIs, ecosystem-native analyzers, the ML/stat stack, native clients. Every phase ships something users can see.

## Architecture principles (binding for all tasks)

1. **Protocol-first core.** `openbuff-core` stays TS/Bun. It owns sessions, the agent loop, tools, cap.v3, the mutation broker, the run journal and approvals.
   - It speaks ACP v1 (JSON-RPC 2.0) over stdio, plus a unix socket as an Openbuff extension, with Openbuff features as namespaced ACP extensions (D9).
   - The schema is generated from the existing Zod definitions.
   - Today's in-process `OpenbuffClient.run()` becomes one binding of that protocol, and keeps working (compat shim).
2. **Capabilities, not duplicate implementations.** A sidecar or native module advertises a capability. If the module is missing, the capability is simply not advertised.
   - There is no requirement to keep a native and a JS implementation byte-identical (lesson PC-3).
   - The one exception is pure-kernel napi code where a TS fallback already exists.
3. **Allowed integration mechanisms, in order of preference:**
   - (a) TS in-process
   - (b) Supervised sidecar over MCP/JSON-RPC stdio, in the best language for the job
   - (c) WASM component or QuickJS isolate, for untrusted code
   - (d) napi, only for sub-ms chatty TUI kernels or existing prebuilt addons (e.g. `@ast-grep/napi`)
   - (e) Native clients only where a platform mandates them; prefer TS (Expo) or existing ACP clients
4. **Language by capability:** Authored: TS (core, TUI, policy, orchestration, VS Code extension, mobile via Expo); Rust (one workspace → one multi-call native binary: exec/sandbox, daemon, infer/ML, plugin host); Python (offline only: training, ONNX export, statistical oracles; uv-managed). Consumed as-is: C/C++ via Rust crates (llama.cpp, whisper.cpp, SQLite, tree-sitter grammars), OpenTUI's Zig core, gitleaks rules as data, OTel collector, Opengrep, ruff, oxc, ast-grep, ripgrep, git, SCIP indexers, LSP servers, mergiraf, existing ACP editor clients. Declarative: JSON Schema contracts, agent.yaml, language/sensitive-path/secret-rule data tables with generated bindings. A new authored language requires a dated D-entry showing a platform mandate.
5. **Contracts stay frozen, with explicit versions.** The following only change through versioned additions with golden vectors, never implicit edits:
   - cap.v3 grammar
   - broker receipts (schemaVersion 1)
   - tool schemas (three-mirror codegen)
   - `FileMutationResultV1` / `CommitReceiptV1`
   - `CODEBUFF_RG_PATH`
   - release inputs
   - The `laneId` and protocol additions are v2 schemas.
6. **Graceful degradation and honest reporting.** Every native or sidecar tier reports its actual enforcement level (e.g. "sandbox: landlock+seccomp" vs "sandbox: lexical-only"). It must never silently claim a stronger guarantee than it provides.
7. **Local-first / BYOK is preserved.** No hosted inference. Learning data stays local unless the user opts in. The mobile relay is E2E-encrypted.

## Non-goals

- Rewriting the agent loop, the OpenTUI TUI, or the published SDK surface in another language.
- Big-bang migrations. Every capability is additive and can be switched on or off.
- Replacing `agents/` templates. They gain declarative and isolated execution options but are not rewritten.
- Multi-tenant or hosted services.

## Requirements (grouped by track; task IDs in PLAN.md)

- **R-A Protocol & surfaces:**
  - ACP server `openbuff serve`
  - MCP server `openbuff mcp`
  - Headless/CI mode
  - TUI attach/detach
  - Editor clients (VS Code, JetBrains, Neovim, Zed, Emacs)
  - Tauri desktop
  - Mobile approver
  - Generated Python/Go SDKs
  - OS notifications, clipboard, tray
  - TUI rendering addons
- **R-B Durability & workspace:**
  - Injected clock/id
  - Run journal
  - Mid-step resume
  - Deterministic replay
  - Turn snapshots with /undo and a timeline
  - Crash-atomic transactions
  - Dashboard
  - Persisted workflow statechart
  - Message-passing subagents with supervision
  - Lanes (`laneId`, COW worktrees, best-of-N, merge, land)
  - Resident daemon
  - Index service
  - Native parse tier
  - Cross-session scheduler
- **R-C Intelligence & edits:**
  - Tree-sitter preflight for all languages
  - LSP multiplexer and navigation tools
  - Diagnostic-delta gating
  - Structured diagnostics and fix-its
  - SCIP call graph
  - Real import resolution
  - Type enrichment
  - Test impact analysis (TIA) and build graph
  - Repo map
  - Compiler daemons
  - Semgrep taint checks
  - Exact tokenizers
  - Structural rewrites (ast-grep, LSP rename, codemods)
  - Semantic review diffs
  - Blame/stage/commit tools
  - Word diffs
- **R-D Security & process control:**
  - P0 leak and bypass fixes
  - OS sandbox shim
  - Shell AST pre-check
  - jobd
  - Egress proxy and secret broker
  - PTY host with `terminal_session`
  - Secret scanning
  - MCP server sandboxing and lockfile
  - Browser inside the sandbox
  - microVM tier
  - Provenance
- **R-E Learning & local models:**
  - Eval hygiene and statistics gate
  - Local learning log (OTel → Parquet)
  - DuckDB observatory
  - Eval fleet (repeats, containers, mutation oracle)
  - Python stats sidecar
  - Promotion wiring and variant registry
  - DSPy `openbuff evolve`
  - Failure mining
  - Learned router and bandit
  - Lessons knowledge store
  - Memory reranking, NLI and semantic search
  - Local inference provider (constrained decoding, KV reuse)
  - Local compaction
  - Local embeddings
  - LoRA adapters
- **R-F Extensibility:**
  - Declarative `agent.yaml`
  - Hooks in any language
  - JSON Schema tool descriptors
  - QuickJS isolate for string handleSteps
  - WASM component plugins
  - Signed plugin registry
- **R-G Frontier:**
  - GUI/screen perception
  - Voice I/O
  - Multi-machine swarms
  - Embedded LSP server
  - Single-binary distribution
  - Evidence-gated performance kernels

## Acceptance criteria

- Every finding ID in both audit reports maps to at least one PLAN task, or to an explicit "confirmed, no action" entry. See the traceability matrix in PLAN.md.
- Every phase milestone ships at least one feature a user can see, with a demo script. Tmux-cli smoke tests cover TUI surfaces.
- Contract fixtures (X-1) stay green on every phase. Any protocol or laneId change is a versioned addition.
- Each native or sidecar capability:
  - is optional
  - ships as per-platform prebuilt artifacts (optionalDependencies or a downloaded, checksum-verified sidecar)
  - has a CI job that actually runs the native path (lesson PC-6)
  - reports its enforcement or availability tier
- Security-boundary tasks (P0 security, P5, P9 isolation, P10) get a security-reviewer pass and adversarial tests.
- Learning-loop promotions require a statistically significant paired improvement on a held-out split. The P0-T6 gate comes first; the P8 sidecar strengthens it.

## Locked decisions (2026-09-26)

Locked by the user before P1. Changing one requires a new dated entry here, not a silent edit.

| ID | Decision | Locked choice | Evidence / rationale | Applies at |
|---|---|---|---|---|
| D1 | Resident daemon language | **Rust** | Shares crates with the sandbox shim (landlock, seccompiler, nix) and the index/lanes service (gix, tantivy, notify, tree-sitter); ships as one static binary. A TS-first daemon would pay for the boundary twice (PC-5). | P6-T5 |
| D2 | Python as an optional dependency | **Accepted: optional, uv-managed, `openbuff learn`/`evolve` only, never on the hot path** | DSPy/GEPA, scipy/statsmodels and TRL/unsloth have no TS equivalents. | P8-T4 |
| D3 | mergiraf | **External CLI installed by the user, detected and invoked as a git merge driver; diff3 fallback. Never linked or bundled.** | GPL-3.0-only; Openbuff is Apache-2.0 (LICENSE). Its Rust API is officially unstable ("not designed to be used as a library"). | P6-T4 |
| D4 | Sandbox platform order | **Linux → macOS → Windows** | Landlock FS needs kernel ≥5.13 (≥5.19 for cross-dir rename, `REFER`) and TCP needs ≥6.7 (ABI v4); probe the ABI at runtime and fall back to netns for network. macOS `sandbox-exec`/SBPL still works unprivileged (Codex precedent) but is deprecated, so P10-T1 VMs are the hedge. Windows uses AppContainer + Job Objects. | P5-T1 |
| D5 | TUI becomes a protocol client by default | **Opt-in flag until P7, then the default** | Keeps the in-process path stable while the protocol matures and editor clients prove it. | P1-T3, P7 |
| D6 | Mobile approval relay | **LAN or self-hosted relay first, Noise E2E encryption; any hosted relay is opt-in later** | Preserves local-first/BYOK and the "no hosted backend" rule. | P7-T4 |
| D7 | Local inference binding | **Rust sidecar from the start (mistral.rs or llama-cpp-2), supervised via X-5, JSON-RPC over stdio. Never in-process under Bun.** | node-llama-cpp has an open Bun segfault under sustained load (oven-sh/bun#27320, Bun 1.3.8); a model crash must not take down the TUI. The sidecar implements constrained decoding, KV sequences/forks and state snapshots itself. | P9-T6 |
| D8 | `packages/native-core` | **Remove the Wave-0 scaffold; start a fresh Rust cargo workspace at P4/P5 (first real crate: the P5-T1 sandbox shim)** | Wave 0 cost 4 repair rounds on dual-implementation parity for trivial exports (PC-3). The new workspace hosts sidecar crates first and napi kernels only where X-2 justifies them. | X-3 |
| D9 | Protocol wire format | **Adopt ACP v1 (JSON-RPC 2.0 over stdio) via `@agentclientprotocol/sdk`, with Openbuff-specific features (receipts, lanes, capabilities, gate state) as namespaced ACP extensions** | ACP v1 is backed by Zed and JetBrains and has official TS/Rust/Python/Kotlin libraries; existing clients include Zed, JetBrains AI Assistant, Neovim (CodeCompanion/avante), Emacs (agent-shell). VS Code has only third-party clients, so P7-T1 remains. Remote HTTP/WebSocket transport is still WIP upstream, so `--socket` stays an Openbuff extension. | P1-T1 |

## Depth-audit amendments (2026-09-27)

From `AUDIT-REPORT-POLYGLOT-DEPTH-2026-09-27.md`. These extend D1–D9 without contradicting them; task wording lives in PLAN.md. Where an amendment modifies a locked-decision-adjacent behavior, it is recorded here per the dated-entry rule.

| ID | Amendment | Locked choice | Evidence / rationale | Applies at |
|---|---|---|---|---|
| D10 | Shell parse gate in the sandbox shim | After P5-T1 exists, the authoritative command gate is the shim's real shell parser (structured argv plan or refuse); the TS lexical policy is demoted to fast pre-check/cross-check. Until then, property-based differential tests compensate for lexical unsoundness. | terminal-command-policy.ts (2451 lines) approximates context-free shell semantics with regex heuristics; false negatives are workspace-escape vectors. Extends P4-T8/P5-T1 rather than contradicting SPEC. | P4-T8, P5-T1 |
| D11 | Persistent QuickJS VM for handleSteps | P9-T4 is specified as a persistent per-run VM (one VM held across STEP/STEP_ALL yields) with bytecode/heap-snapshot checkpoints into the P2-T2 run journal — not a one-shot isolate. Replaces the in-memory generator registry and retires serialized-handleSteps duplication. | The in-memory generator registry leaks on abnormal exit and loses all state on crash; JS_WriteObject checkpoints deliver durable resume (feeds ORCH-1/P2-T2). Highest-leverage single change in the agents subsystem. | P9-T4, P2-T2 |
| D12 | Evidence-gated napi kernel tier, ordered by X-2 | Kernel candidates have quantified evidence: tiktoken token counting (fudge factors 1.35/1.0/1.1 exist only because gpt-tokenizer BPE stalls CI on 5MB bodies), semantic cosine dot-product (~20k × 1536-dim linear scan per query), grapheme wrap (code-point splitting breaks emoji ZWJ). Prefer maintained prebuilts over new crates; scalar JS paths stay as fallbacks. | Each deletes an entire layer of dependency-driven approximation, not just latency. | X-2, P3-T10, P6-T7, P7-T7 |
| D13 | X-2 honesty prerequisites | The three TS-path index fixes (stat-gated hashing in metadata-indexer, interval-stack assignDepths, bounded vocabulary scan) are hard prerequisites of the X-2 index baseline; X-2 rows must separately attribute walk+hash / parse / score / persist / query-p99. | Without them the baseline mis-attributes O(project bytes) re-hashing and O(n²) containment filtering to WASM parsing and would produce a fraudulent evidence gate. | X-2a → X-2 |
| D14 | TS-first transactional index store | P6-T6a lands bun:sqlite WAL behind the existing loadIndex/saveIndex signatures (deleting the 430-line advisory lock) before P6; the daemon's redb/rusqlite store supersedes it later. A Rust store never precedes the X-3b workspace. | Whole-document JSON rewrite + hand-rolled advisory lock is a correctness sink fixable in TS today; D8 ordering is preserved. | P6-T6a, P6-T6 |
| D15 | Gitleaks as the single secret-rule authority | The gitleaks TOML ruleset is the rule authority; the TS TOKEN_SHAPES table is codegen'd from it (three-mirror step) with the frozen `[REDACTED]` contract pinned by golden vectors. Stream-time redaction stays in-process TS. | The current corpus is 5 token shapes vs ~200 gitleaks rules; hand-syncing two corpora is the drift class three-mirror codegen exists to prevent. | P5-T5 |
| D16 | language-capabilities.ts is the sidecar capability manifest | The serialized registry (parser names, LSP argv/transport/detect/rootMarkers, validation stages) is the capability-advertisement format consumed by the Rust parse/LSP tier and reported via X-4; SupportedLanguageId/LanguageToolRole/LanguageValidationStage freeze as versioned contracts with golden vectors. | The registry is inert TS data today; freezing it as the wire manifest avoids a second source of truth. | X-4, P3-T1 |
| D17 | z.toJSONSchema(io:'input') is the published language-neutral artifact | Per-tool JSON Schema artifacts are published alongside TS interfaces with golden vectors; the TS mapper's silent `any` fallback throws in CI. Feeds P7-T6 Python/Go codegen and P9-T3. | It is already the de facto cross-language ABI; pinning it prevents silent contract drift. | X-1, P7-T6, P9-T3 |
| D18 | Eval isolation precedes the Go fleet | P8-T0: an opt-in TS docker/podman wrapper around withTestRepo for external CLIs and final checks, plus eval artifact uploads in CI, land before P8. The Go fleet (P8-T3) owns only process/container lifecycle; runner orchestration, judging and signal extractors stay TS. | Eval runners execute untrusted model output unsandboxed on a host seeded with provider keys (--dangerously-skip-permissions / --full-auto); buffbench.yml/nightly-evals.yml persist no artifacts today, so P8-T1/T2 would have nothing to ingest. | P8-T0, P8-T3 |

## Protocol reliability amendments (2026-09-28)

From user-reported session evidence (2026-09-28), not a filed audit report: stringified-JSON tool-argument failures (`expected object, received string` on `edits`/`agents`/`followups`), lost or fragmented subagent output (reviewer attestation loops, `last_message` agents returning dozens of omitted chunks, structured-output agents whose content never reaches the parent), silent false completions from repair agents, and the context-pruner crash (`"answers" in value` on a non-object, reproduced 3x). These extend D1–D18; task wording lives in PLAN.md (PR- tasks).

| ID | Amendment | Locked choice | Evidence / rationale | Applies at |
|---|---|---|---|---|
| D19 | Typed subagent handoff envelope | Every subagent result is validated against a versioned envelope schema with an explicit outcome (`ok` / `missing_output` / `schema_invalid` / `truncated` / `crashed`); the runtime receipt layer re-verifies mutation claims and the parent receives the status verbatim. A silent empty or falsely-completed result is a contract violation. | A repair-editor reported an error "already resolved" without editing and the diagnostic persisted; reviewer receipts arrived `truncated:true` with omitted transcript segments. | PR-T1, before P2-T8 |
| D20 | Out-of-band output store | Full subagent/reviewer output is persisted out-of-band (run journal or content-addressed scratch) and the parent receives a bounded summary plus a pointer; inline payload truncation is removed, and `last_message` fragment streams are merged into one message before envelope validation. | `last_message` agents (git-committer, debugger) returned dozens of token-sized fragments with 100+ omitted items; commit hashes and push failures were cut off; spawn-agent-utils truncates handoffs (~3k chars + 800-char tail). | PR-T2, rides P2-T2 |
| D21 | Argument normalization at the tool boundary | Strings containing valid JSON are unserialized to the declared object/array type at dispatch, logged and counted (never silently); tool schemas whose deep nesting empirically triggers double-encoding are flattened. | Repeated `expected object, received string` on `edits`, `agents`, `followups`; truncated serialized payloads are rejected rather than repaired. | PR-T3 |
| D22 | Plain-text edit payloads | File content (oldString/newString bodies) moves out of JSON string fields into plain-text edit blocks (SEARCH/REPLACE or unified diff) with JSON carrying only metadata (path, occurrence, readCapability). Control fields keep native provider tool-calling; XML is never parsed from model text. Behind an eval-confirmed flag with JSON as fallback. | Escaping is the dominant failure mode for code-in-JSON arguments; deep object arrays are the dominant double-encoding trigger. JSON between processes (ACP wire, receipts, sidecars) is confirmed correct and unchanged (D9, D17). | PR-T4, feeds P9-T6 |
| D23 | Content-hash attestation + gate arming policy | Reviewer receipts bind to per-file content hashes, not session timestamps; docs-only/non-source edits do not re-arm the review gate; the memory-drift guard accepts a recorded review receipt instead of forcing a timestamp-only knowledge.md touch. | Every doc-only edit re-armed the full review gate; the pre-push guard forced repeated timestamp-only knowledge.md edits. | PR-T5, binds to X-1 cap.v3/content-hash |
| D24 | Fail-loud structured outputs | Structured-output agents (researcher-web, librarian, thinker, debugger) that never call set_output or fail schema validation return a typed `missing_output` envelope to the parent instead of silence; fix the context-pruner crash on non-object outputs. | The context-pruner failed 3x with `"answers" in value` on a non-object; the suspected silent output loss matches the user's cross-project report (inferred, not traced). | PR-T6 |

## Compaction quality & archive recall amendments (2026-09-28)

User-reported, 2026-09-28: the compaction pass is too lightweight (drops must-survive evidence) and `recall_context` effectively returns nothing. Existing machinery: deterministic retention evals (`evals/compaction-retention`, `compaction-fidelity`, `memory-retention`) already measure recall; P9-T7 (local compaction) and P8-T8 (knowledge store) exist but do not fix the hosted-model path. D25–D28 below extend D1–D24; task wording lives in PLAN.md (CQ- tasks).

| ID | Amendment | Locked choice | Evidence / rationale | Applies at |
|---|---|---|---|---|
| D25 | Eval-gated hosted-model retention floor | The hosted-model context pruner gets a recall floor enforced by the existing deterministic evals: the pinned `<knowledge_memory>` block must preserve open blocker records verbatim, eviction pointers for every archived segment, and the next-action/goal line; a failing recall floor blocks the change (same discipline as any other gate). | The compaction is too lightweight today and drops issues; `evals/compaction-fidelity` already measures exactly this but no task acts on its results. | CQ-T1 |
| D26 | Evictions become archived first-class records | Every evicted segment is persisted as a retrievable archive record (content, provenance, eviction reason, bounded per run), not just a pointer-only hint; archive writes ride the D20 out-of-band store / P2-T2 journal substrate. | `recall_context` returns empty when nothing was archived because most evictions persist only re-run hints. | CQ-T2, rides D20/P2-T2 |
| D27 | recall_context is indexed, not brute-force | `recall_context` retrieves from the archive index (FTS/BM25 over archived transcripts) rather than substring scans; an empty result must be distinguishable from a failed index. | Today recall is substring-search at best over archives that mostly do not exist; P8-T8 supplies the store but is phase 8 and not wired to within-session archives. | CQ-T3 |
| D28 | Language roles for compaction | Selection (what to keep) is a model task → the D2 Python sidecar remit extends to compaction: LLMLingua-2, local summarizers and rerankers run natively in Python instead of TS/ONNX ports (P9-T7's quality core moves here). Retrieval (how to find) stays a Rust/X-3b task: tantivy BM25 over archives rides P6-T6, SIMD/memchr parsing rides P10-T9 evidence gating. | LLMLingua-2 is Python-native; forcing TS (ONNX) means a port. Rust gives fast retrieval but does not decide what to keep. | CQ-T1 (Python), CQ-T3 (Rust) |

## Polyglot re-audit amendments (2026-09-28)

From `.agents/sessions/polyglot-reaudit-2026-09-28/AUDIT-REPORT.md` §7. Accepted by the user 2026-09-28. D31 amends D15; D34 amends D28 (serving half) and D2; D35 amends D11; D36 amends P2-T8.

| ID | Amendment | Locked choice | Applies at |
|---|---|---|---|
| D29 | Open language registry as the single polyglot authority | Open-string language ids with a `generic` tier; Linguist/Helix snapshot overlay; profile fields grammar, manifests, testConventions, commands + runner prefix, artifactDirs, toolchainHomes, egressRegistries, credentialFiles, dialects; manifest `registryRevision` + `contentHash`, tolerant reader. Consumers (base2 gate helpers, affected tests, hooks, indexer, code-map) must not keep private tables. Extends D16. | X-4, P3-T1, P0-E1 |
| D30 | Shared text codec + Unicode module | One BOM/EOL-preserving decode/encode used by every read/edit/redaction path; grapheme/word segmentation, code-point-safe truncation; frozen cross-language hash encodings. | P0-E1, X-1 |
| D31 | One secret-rule authority | gitleaks TOML codegen to TS and Rust plus configured `apiKeyEnv` values; consumers: env strip, redaction, outbound filter, staged gate, log sanitizer. No Go runtime sidecar. | P0-S1, P5-T5 |
| D32 | Parsed command policy now | TS tree-sitter-bash AST pre-check where ERROR = deny; read-only profile is an allowlist; per-agent permission profiles derived from templates/handoff. Shim parser choice is D40. | P0-S1, P4-T8 |
| D33 | Honest-tier result contract | Every capability-dependent result carries tier/confidence (validation per file, affected tests, preflight availability, undo coverage, memory provenance), exposed via X-4 CapabilitiesMapV1. | X-4 |
| D34 | Single ML inference runtime | Rust `ort` (ONNX Runtime) sidecar serves compaction selection, reranker, NLI and embeddings; Python only trains/exports; tiny routers score in TS. | CQ-T1, P8-T7/T9/T10, P9-T7 |
| D35 | Durable resume via deterministic journal replay | First-party agents run as trusted host modules and resume by P2-T2 replay; QuickJS only for untrusted agents; no heap snapshots. | P9-T4, P2-T2 |
| D36 | Process-based subagent supervision | Supervision boundary is an OS process, not a Worker. | P2-T8 |
| D37 | Polyglot verification gate | Committed fixture repos + mise-pinned CI job; eval language strata; promotion requires no per-language regression; per-language mutation tools. | P8-T0, P8-T3, CI |

## Language-fit review (2026-09-28, accepted)

Accepted by the user on 2026-09-28, based on `.agents/sessions/language-fit-audit-2026-09-28/LANGUAGE-FIT-REPORT.md` (22 snapshot-bound shards + web verification). Question reviewed: is TS kept only where it is the best implementation, and is every other language choice the best one? Test applied per feature: best-in-class library/ecosystem, runtime properties needed (isolation, latency, memory, OS APIs), distribution cost, and what the choice unlocks downstream. Portfolio cost counts: every authored language adds a toolchain, CI matrix, release artifacts and reviewer skill.

| ID | Proposal | Rationale | Applies at |
|---|---|---|---|
| D38 | CONFIRMED, tightened: authored = TS; Rust (one cargo workspace → one multi-call native binary); Python offline only (training/export/oracles; never spawned on a user-facing path except `openbuff learn`/`evolve`). A new authored language requires a dated D-entry showing a platform mandate. | Go/Swift/Kotlin/Lua/Elisp authorship is justified only where a platform forbids alternatives. Fewer toolchains = cheaper CI and one native crate graph shared by shim, daemon, index, tokenizers and inference. | Principle 4, P8-T3, P5-T5 |
| D39 | CONFIRMED; additionally evaluate Inspect AI as a consumable harness. | Nothing in the fleet needs a Go-only library; Rust shim already provides isolation. | P8-T3 |
| D40 | AMENDED — authority is brush-parser (Rust) in the Rust `exec` role; interim TS AST is sh-syntax (mvdan/sh via WASM); tree-sitter-bash stays advisory only (fidelity bugs); mvdan/sh also serves as a CI differential oracle. | The 2451-line regex policy is the root of most HIGH security findings; a parsed argv plan also enables exec-without-shell and per-command sandbox profiles. | P4-T8, P5-T1, D10 |
| D41 | AMENDED — exact counts only for OpenAI + open-weight models (HF tokenizers Rust / GitHub bpe for linear worst case); Claude/Gemini have no local tokenizer → calibrate from provider-reported usage; prefer prebuilt bindings over new crates. | HF `tokenizers` is Rust-native (JS is a port); exact counts remove the 1.35/1.0/1.1 fudge factors and make compaction/eviction budgets exact. | P3-T10, D12 |
| D42 | CONFIRMED as written. | Warm servers only pay off if they outlive one CLI process and are shared across lanes. | P3-T1, P6-T5 |
| D43 | CONFIRMED, amended — Expo/React Native + react-native-libsodium (Noise over libsodium) + expo-secure-store; relay is Rust (snow), not Go. | One codebase reusing the generated Zod/ACP types beats two native apps for an approval UI. | P7-T4 |
| D44 | CONFIRMED, amended — also get listed in the existing third-party VS Code 'ACP Client' extension before authoring our own. | Kotlin/Lua/Elisp authorship buys little over existing clients. | P7-T1/T2/T3 |
| D45 | REPLACED by D47. | Avoids a second native layer under the TUI; OpenTUI already owns text buffers natively. Verify OpenTUI core scope before adopting. | D12, P7-T7 |
| D46 | AMENDED — oxc-parser/oxc-resolver confirmed (note the oxc-parser parseSync arena leak in long-lived processes); ruff is CLI/LSP-only (no library); biome only where the project already uses it; add @ast-grep/lang-* packs for non-JS languages. | Best-in-class analyzers already exist in Rust; tree-sitter stays the generic tier. | P3-T5, P3-T4 |

## Language-fit follow-up amendments (2026-09-28)

Accepted with the review above (same report). These extend D1–D46 without contradicting them; task wording lives in PLAN.md.

| ID | Amendment | Applies at |
|---|---|---|
| D47 | Upgrade OpenTUI from 0.2.2 to 0.5.x and adopt its native Code/Markdown/Diff/TextTable renderables, TreeSitterClient highlighting and native grapheme width; no authored Zig. Amends P1-T6, P1-T10, P7-T7 and D45. | P1-T6, P1-T10, P7-T7 |
| D48 | Linux sandbox primary is bubblewrap + seccomp (Codex precedent; Landlock-only cannot isolate unix sockets), with Landlock BestEffort layered on; macOS stays Seatbelt; Windows uses restricted token + dedicated user + ACL + firewall rules instead of AppContainer. Amends D4/P5-T1. | P5-T1, P10-T1 |
| D49 | One Rust multi-call binary `openbuff-native <role>` (roles: exec, daemon, infer, plugin-host, a11y) shipped as ONE artifact beside the Bun binary; jobd merges into the daemon. | X-3b, P5-T1, P6-T5, P9-T6, P9-T5, P10-T8 |
| D50 | Split the mutation broker: TS keeps API, cap.v3 and receipt policy; the Rust daemon owns the commit primitive (dirfd writes, renameat2, OS locks) and the receipt/journal store; the TS path remains a degraded tier reported via X-4. Amends Principle 1. | P6-T5, P2-T5 |
| D51 | Daemon D1-min (rusqlite store, leases with fencing tokens, notify watcher, broker commit authority) is scheduled right after the first Rust role, in parallel with the exec role — not in P6. Drop redb; rusqlite is the only daemon store. | P6-T5/T6, P2-T2 |
| D52 | Local inference consumes the llama-server binary under X-5 (grammar/JSON-schema constrained decoding, per-slot KV save/restore, prebuilt binaries); authored llama-cpp-2 bindings only if an eval proves a need for KV forks. Amends D7. D28's serving half is superseded by D34. | P9-T6, P9-T7 |
| D53 | handleSteps bundles are built with Bun.build (retiring toString/new Function and the generated-helper duplication); the base2 gate loop is refactored into an explicit host-side statechart (XState v5). | P9-T4, P2-T6 |
