# PLAN — Polyglot Roadmap v2

Spec: `SPEC.md`. Evidence:
- `.agents/sessions/reaudit-polyglot-2026-09/REAUDIT-REPORT.md` (re-audit, finding IDs such as SB-/IL-/LI-/EV-/ORCH-/S-/EL-/PC-/EXT-)
- `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md` (prior audit, whose Wave items are referenced as `old W#-#`)

Supersedes: `.agents/sessions/polyglot-native-waves/`. Its W0-1 scaffold (`packages/native-core`) is removed per locked decision D8 (task X-3); a fresh Rust workspace starts at P4/P5. Decisions D1–D9 are locked in SPEC.md.

Legend: `[ ]` pending · lang = implementation language · ships = the user-visible result · gate = the validation required before the task is done.

<!-- current-task: P0-T1 -->

## Cross-cutting foundations (run alongside P0–P1; later phases depend on them)

- [ ] X-1 Contract freeze + golden vectors: cap.v3 grammar, broker receipts v1, tool JSON-schema export, FileMutationResultV1/CommitReceiptV1, and the rg env override. (old W0-3) lang TS. gate: byte-exact fixture tests in common/sdk.
- [ ] X-2 Golden perf/latency baselines: token count, code_search, index refresh, stream parse, TUI keystroke latency, cold start. No native kernel ships without a before/after row. (old W0-2) lang TS. gate: rows committed via scripts/measure-perf-guards-baseline.ts.
- [ ] X-3a Remove the Wave-0 scaffold (D8): delete `packages/native-core/`, `.github/workflows/native-core-build.yml` and the `packages/native-core` project reference in the root `tsconfig.json`. Confirm there are no importers first (`query_index` references). Needs explicit user confirmation before the deletion runs. lang TS/YAML. gate: `bun run typecheck` + CI workflow tests.
- [ ] X-3b Fresh Rust cargo workspace (D8), created with the first real crate, the P5-T1 sandbox shim (or P4 if a native need appears earlier). It hosts the sidecar crates (shim, jobd, index, lanes, pty, infer) and napi kernels only where X-2 justifies them. CI runs the native path on every target and publishes checksummed artifacts; no JS mirror of native behavior is required (SPEC principle 2). (PC-6) lang Rust+YAML. gate: CI runs the native path on 5+ targets.
- [ ] X-4 Capability registry + tier reporting. A single `capabilities` map is advertised in protocol `initialize`, in `/doctor`, and in the status bar, e.g. sandbox tier, lsp servers, sidecars. lang TS. gate: unit tests; doctor-box shows the tiers.
- [ ] X-5 Sidecar supervisor. Spawns, health-checks, restarts and version-negotiates stdio JSON-RPC/MCP sidecars. Artifacts are checksum-verified downloads or optionalDependencies. lang TS. gate: crash/restart tests with a fake sidecar.
- [ ] X-6 Fix the prior report's citations (memory :1553, sixel lines) and mark polyglot-native-waves as superseded. (PC-7) lang docs.

## P0 — Safety & hygiene quick fixes (ships: safer defaults, honest evals)

- [ ] P0-T1 Build child-process env from an allowlist and strip BYOK/OAuth/credential vars (sdk/src/env.ts:49, run-terminal-command.ts:413/:485). (SB-2) lang TS. gate: test that the child env lacks the provider keys; security-reviewer.
- [ ] P0-T2 Approval reruns keep the original profile and use a one-shot approval token instead of `mode:'user'`. (SB-6) lang TS. gate: policy tests; security-reviewer.
- [ ] P0-T3 Fix the tmux-cli teardown stray `'>` and add a `bash -n` test for the generated helper. Verify how the tmux-test profile applies. (SB-5) lang TS.
- [ ] P0-T4 Launch Chrome with `--remote-debugging-pipe` and drop `--no-sandbox` where userns is available. (SB-7) lang TS.
- [ ] P0-T5 Tree-sitter `rootNode.hasError` preflight for all 13 languages. Replace `isResultDelimiterBalanced`. (LI-02 tier 0, EV-3) lang TS (web-tree-sitter already shipped). gate: preflight tests per language.
- [ ] P0-T6 Eval hygiene: use `scoringStatus` as the only exclusion rule, keep per-judge raw scores and variance, add `--repeats/--seed` and mean±SE plus score-per-dollar, and put a paired bootstrap + Wilcoxon on the promotion gate. (EL-1 lite, EL-4, EL-5 lite, EL-12) lang TS. gate: evals tests.
- [ ] P0-T7 Small correctness fixes:
  - derive the language-family maps from the registry and parse `.c` with tree-sitter-c (LI-11)
  - registry ToolSpec argv/transport (LI-13)
  - MCP client name `openbuff` (S4)
  - dedupe the MCP config merge (EXT-3)
  - move CLI `getDiffStats` off execSync (EV-6)
  - aggregate background-agent cost into the parent (ORCH-5)
  - rename sandbox-generator.test.ts or make it assert isolation (ORCH-2)
  - rewrite evals/README for buffbench (EL-14)

  lang TS.
- [ ] P0-T8 Structured diagnostics: JSON/SARIF modes (cargo, ruff, pyright, eslint, go vet, clang, MSBuild) with real ranges and fix-its captured. (LI-05) lang TS.

## P1 — Protocol-first core (ships: headless/CI mode, editor attach, Openbuff-as-MCP-server, syntax highlighting)

- [ ] P1-T1 Protocol v1 = ACP v1 (D9) via `@agentclientprotocol/sdk`: initialize + capabilities, session/new|load|prompt|cancel, update notifications, reverse requests for permission/fs/terminal. Openbuff additions (receipts, capabilities map, lanes, gate state, ask_user, custom tools) go in namespaced ACP extensions whose schemas are generated from Zod through the compile-tool-definitions pipeline. Adding the SDK dependency needs the dependency-manager plus explicit approval. (S1, PC-1, ALT-12) lang TS. gate: ACP conformance tests + extension golden vectors (X-1).
- [ ] P1-T2 `openbuff serve --stdio|--socket`: runs the core over the protocol. Approvals, events and custom tools become protocol messages. Local socket auth uses peer creds/token. (S1, S2 groundwork) lang TS. gate: protocol conformance tests; security-reviewer on socket auth.
- [ ] P1-T3 Refactor the in-process `OpenbuffClient.run()` into a protocol client binding; the old API stays as a compat shim. The TUI can attach behind a flag (D5), with detach/reattach to a live session. (S3) lang TS. gate: existing sdk/cli suites unchanged; tmux smoke attach/detach.
- [ ] P1-T4 `openbuff mcp`: MCP server exposing query_index, code-map/outline, cap-guarded reads, receipt-backed edits (opt-in), memory search and audit intelligence. (S4, old W5-3 MCP) lang TS (@modelcontextprotocol/sdk). gate: MCP roundtrip tests with Claude Desktop/Cursor-style clients.
- [ ] P1-T5 Headless/CI mode: `openbuff run --json` on the protocol, exit codes, and machine-readable events. lang TS.
- [ ] P1-T6 Real syntax highlighting using the already-shipped web-tree-sitter grammars (or shiki), with a styled-span protocol at the markdown/highlight boundary. (PC-4, old W4-1/W4-2 first cut) lang TS. gate: markdown-renderer fixture tests + tmux visual smoke.
- [ ] P1-T7 Quick OS integration: OSC 9/777 notifications on approval-needed or turn-done, wl-copy/Wayland clipboard, and a DA1/XTGETTCAP terminal image capability query. (S6 lite, S11) lang TS.

## P2 — Durability, undo & replay (ships: /undo-turn, session timeline, crash resume, `openbuff dash`)

- [ ] P2-T1 Inject Clock/IdGen through AgentRuntimeDeps; no direct randomUUID/Date.now in the runtime. (ORCH-6 prereq) lang TS.
- [ ] P2-T2 Append-only run journal on bun:sqlite, covering every LLM request/response, tool call/result and spawn. Resume a run at the in-flight step, subagents and background agents included. Journaling runs across handleSteps boundaries (a generator is re-driven by replay). (ORCH-1) lang TS. gate: kill-9 mid-tool-call resume test.
- [ ] P2-T3 `openbuff replay <run> --from-step N [--model M]` for deterministic replay/fork; a run can be exported as an eval fixture. (ORCH-6) lang TS.
- [ ] P2-T4 Turn snapshots v1 via git plumbing (private GIT_INDEX_FILE, write-tree, commit-tree onto a private ref), taken before and after each turn and each shell command. Adds `/undo-turn`, `/restore <turn>`, and bisect-by-turn. (EV-2 lite, EV-8, SB-3 partial) lang TS. gate: undo covers basher side effects in the tracked tree.
- [ ] P2-T5 Crash-atomic multi-file transactions: intent log with a transactionId in the receipts (a versioned addition). (EV-5) lang TS (renameat2 later via X-3).
- [ ] P2-T6 Promote workflow-engine to a persisted statechart that drives the gate (resumable, visualizable). (ORCH-7) lang TS.
- [ ] P2-T7 `openbuff dash`: localhost + token dashboard to replay journals, receipts and timelines; static HTML export. Replaces tmux-viewer as the user-facing tool. (S7) lang TS/React.
- [ ] P2-T8 Message-passing subagents: children return receipts and only the parent applies them. Supervision uses Bun Workers with hard kill and restart policies. (ORCH-3) lang TS. gate: spawn-settle fault-injection suite.

## P3 — Semantic code intelligence (ships: go-to-definition/find-refs/hover/rename in agent tools, diagnostic-delta gating, correct affected tests)

- [ ] P3-T1 LSP multiplexer: one warm server per language/root, driven by the ToolSpec registry. Document sync goes through the mutation broker. Handles cold-start and memory limits. (LI-01) lang TS (vscode-jsonrpc) + ecosystem servers (tsserver, pyright/ruff, rust-analyzer, gopls, clangd, jdtls, csharp-ls, sourcekit-lsp, …).
- [ ] P3-T2 Agent tools go_to_definition, find_references, hover_type, workspace_symbol, with cli renderers. (LI-01, Q2 #5) lang TS. gate: tool-registration consistency + per-language fixture tests.
- [ ] P3-T3 Diagnostic-delta preflight: reject an edit only if it introduces new LSP/compiler errors, and offer fix-its. Optional incremental daemons: tsc --watch, cargo check JSON, ruff server, dmypy. (LI-02 tiers 1–2) lang TS.
- [ ] P3-T4 SCIP ingestion: run scip-typescript/python/rust-analyzer/java/go/clang/dotnet/ruby when available and merge precise edges into the indexer graph. Tree-sitter edges stay as a fallback labeled `confidence:'heuristic'`. (LI-03) lang TS reader.
- [ ] P3-T5 Real import resolution from tree-sitter import nodes plus the ecosystem resolver (`ts.resolveModuleName`, etc.); remove the duplicate logic in chunks.ts. (LI-08) lang TS.
- [ ] P3-T6 Enrich types and docs via LSP hover/documentSymbol/inlayHint, cached by content hash. (LI-09) lang TS.
- [ ] P3-T7 Test impact analysis, tiered: per-language conventions, then graph/SCIP reverse deps, then build-tool queries, then coverage maps. Each result carries a confidence label. (LI-06) lang TS.
- [ ] P3-T8 Build graph via cargo metadata / go list / Gradle Tooling API / CMake File API / MSBuild / bazel / nx, giving owning-target builds. (LI-07) lang TS (+ Kotlin/Java Gradle tooling helper if required).
- [ ] P3-T9 Ranked repo map using personalized PageRank over the precise graph, wired into query_index. (LI-12) lang TS.
- [ ] P3-T10 Exact tokenizers: HF tokenizer.json per open-weight model, plus tiktoken for OpenAI families, cached with model discovery. Remove the fudge factors behind an eval-confirmed flag. (IL-7, old W1-1) lang TS (transformers.js) → napi kernel only if X-2 shows the need.
- [ ] P3-T11 Semgrep `--baseline-commit` SARIF hook for taint findings on new code only, surfaced in get_change_review_bundle. CodeQL optional (license). (LI-10) lang TS orchestration + semgrep (OCaml) sidecar.

## P4 — Semantic edits & review (ships: one-call refactors, structural review diffs, blame-aware context)

- [ ] P4-T1 `@ast-grep/napi` structural_replace / move_symbol / parameter edits for all 13 grammars. Output is full content, so the ledger/cap contracts are unchanged. (EV-3, LI-04) lang Rust prebuilt via napi.
- [ ] P4-T2 `rename_symbol` / extract / organize-imports as LSP WorkspaceEdits applied as a single broker receipt. (LI-04) lang TS.
- [ ] P4-T3 `apply_compiler_fix` from structured fix-its (P0-T8). lang TS.
- [ ] P4-T4 Ecosystem codemod adapters, detected per project: libCST (Python), OpenRewrite (JVM), jscodeshift/ts-morph, Roslyn fixers, clang-tidy fix-its, rust-analyzer SSR. (LI-04) lang: each tool's own ecosystem, as sidecars.
- [ ] P4-T5 Semantic review diffs: a difftastic JSON sidecar adds a `semantic_diff` field to review bundles, collapsing moves and reformat-only changes. (EV-7) lang Rust CLI sidecar.
- [ ] P4-T6 Git tools blame_context (historical intent attached to editAnchors), stage_hunks, commit. (EV-6) lang TS (git CLI) → gix via X-3 later.
- [ ] P4-T7 Word-level intra-line diffs in the TUI diff-viewer. (old W4-4) lang TS (diff lib) → napi imara-diff only if X-2 shows the need.
- [ ] P4-T8 Shell AST pre-check using tree-sitter-bash (or mvdan/sh WASM). Gives node-anchored "why denied" explanations and replaces the 5 divergent tokenizers. Stays advisory; it is not the boundary. (SB-10) lang TS.

## P5 — OS-enforced sandbox & process control (ships: enforced permission profiles, secret-less credentials, guaranteed kill/limits, terminal_session tool)

- [ ] P5-T1 Rust exec shim `openbuff-sandbox`, the first crate in the fresh workspace (X-3b). Probe the Landlock ABI at runtime (FS ≥5.13, REFER ≥5.19, TCP ≥6.7) and fall back to netns for network. It enforces profiles with Landlock + seccomp + user/net namespaces on Linux, Seatbelt SBPL on macOS, and AppContainer + Job Objects on Windows (D4 order). The lexical policy stays as the fast pre-check; the tier is reported via X-4. (SB-1) lang Rust. gate: adversarial escape tests; security-reviewer; the tier is always reported honestly.
- [ ] P5-T2 jobd supervisor: cgroups v2, pidfd, subreaper, kqueue, Job Objects. Provides tree kill, mem/cpu/pids caps, live RSS/CPU in the TUI, structured OOM, and a peer-cred-authenticated socket for reattach with exit codes across CLI restarts. (SB-4, SB-11) lang Rust.
- [ ] P5-T3 Egress proxy + secret broker: per-destination credential injection, an egress allowlist enforced via netns, and an audit log. Children never hold raw keys. (SB-2 full) lang Rust (hyper/rustls/rcgen).
- [ ] P5-T4 PTY host with a `terminal_session` tool: vt100 screen model, screen assertions, awaiting-input detection via the foreground pgrp, asciinema recordings. SYNC commands go PTY-backed with prompt detection. tmux-cli moves onto it (no /tmp executables). (SB-5, SB-9, old tmux sidecar) lang Rust (portable-pty + vt100/alacritty_terminal).
- [ ] P5-T5 Secret scanning: a gitleaks rule corpus for stream-time redaction and commit gating with rule IDs, plus optional trufflehog live verification. (SB-8) lang Go sidecar.
- [ ] P5-T6 MCP lockfile: pinned versions, checksums, capability grants, and MCP servers launched inside the sandbox shim. (EXT-3) lang TS + shim.
- [ ] P5-T7 Browser tool runs inside the shim with an egress allowlist. (SB-7 full) lang TS + shim.

## P6 — Parallel lanes & resident services (ships: best-of-N parallel implementations with auto-merge, live index, cross-terminal leases)

- [ ] P6-T1 `laneId` as a versioned addition to cap.v3 scope, broker receipts and FileMutationResult (X-1 vectors). (EV-1 prereq) lang TS.
- [ ] P6-T2 Lanes service: per-agent COW workspaces via gix in-memory trees, git worktree, and reflink/clonefile/overlayfs. Tests run per lane. (EV-1, SB-3 full) lang Rust (gix, via X-3 crate) exposed as a sidecar.
- [ ] P6-T3 Best-of-N orchestration: N lanes run tests in each, a comparison UI lets the user pick, and a `land_lane` tool lands via `git merge-tree --write-tree` with structured conflicts. (EV-10, Q2 #4) lang TS.
- [ ] P6-T4 Merge strategy: diff3 → mergiraf sidecar (D3) for syntax-aware 3-way merge. Stale-state becomes "rebase my edit". (EV-4) lang TS + Rust CLI sidecar.
- [ ] P6-T5 Resident daemon `openbuffd` (D1). It owns leases with fencing tokens, the job registry (absorbs jobd), the index, and the provider scheduler. The TS IndexManager/lease APIs become clients. (ORCH-4 prereq, old W5-1, PC-5) lang Rust.
- [ ] P6-T6 Index service inside the daemon:
  - notify-driven live watching and external-edit SDK events (old W5-2)
  - in-process ripgrep crates behind code_search, with `CODEBUFF_RG_PATH` still honored (old W2-1)
  - tantivy BM25/fuzzy/phrase tier behind queryIndex (old W2-2)
  - transactional redb/SQLite store (old W2-3)

  lang Rust. gate: MRR suites ≥ baseline; index-store lock/CAS semantics preserved or superseded by daemon tests.
- [ ] P6-T7 Native parse tier in the index service: native tree-sitter + rayon, `.scm` queries unchanged, buildTokenCallers conformance fixture extracted first, WASM fallback kept until parity. Retires the runtime grammar fetch. (old W3-1..W3-3) lang Rust.
- [ ] P6-T8 Cross-session provider scheduler: token buckets, priority lanes, a global BYOK spend/rate governor, EWMA provider health feeding failover. (ORCH-5, IL-8) lang Rust daemon + TS client.
- [ ] P6-T9 Fast range reads and large-dir listing, only if X-2 shows the need. Uses memmap2+memchr and getdents in the daemon or as a napi kernel. (old W1-3, readdir) lang Rust.

## P7 — Surfaces beyond the terminal (ships: IDE plugins, desktop app, phone approvals, native notifications, Python/Go SDKs)

- [ ] P7-T1 VS Code extension (TS) over ACP: shares selection and diagnostics, accepts hunks in the editor, and uses the approval UI. (S5) lang TS.
- [ ] P7-T2 Other editor clients: JetBrains (Kotlin), Neovim (Lua), Emacs (Elisp), Zed (native ACP). (S5) lang Kotlin/Lua/Elisp/Rust.
- [ ] P7-T3 Tauri 2 desktop client: split panes, rich media (images, 3D previews), tray, updater. It reuses the React components where possible. (S3, S11) lang Rust + TS.
- [ ] P7-T4 Mobile approver: Swift (APNs, Live Activities, watch) and Kotlin (FCM, Wear). Paired by QR code, relay E2E-encrypted with Noise/libsodium (D6). (S2) lang Swift/Kotlin + Rust/Go relay. gate: security-reviewer on pairing/relay.
- [ ] P7-T5 Native OS addon: arboard, actionable Approve/Deny notifications (notify-rust), tray-icon. Replaces the osascript/PowerShell spawns. (S6) lang Rust napi.
- [ ] P7-T6 Generated Python (pydantic/asyncio) and Go SDKs over the protocol; custom tools are reverse RPC. (S8, EXT-1) lang Python/Go (codegen from P1-T1 schema).
- [ ] P7-T7 TUI feature kernels: nucleo fuzzy matching (old W4-5), grapheme-correct wrap, and image decode/resize with sixel/kitty/iTerm2 unification (old W4-3). Each needs an X-2 baseline and a TS fallback. lang Rust napi.
- [ ] P7-T8 Fast bootstrap/startup: the TUI attaches to a warm daemon (P6-T5) for sub-100ms cold start. (old bootstrap finding) lang TS client + Rust daemon.

## P8 — Self-improving agent (ships: `openbuff evolve`, stats-gated promotions, learned router, smarter memory)

- [ ] P8-T1 Local learning log: OpenTelemetry spans, 100% local and opt-in, written as Parquet with outcome labels. Replaces the 2MB/1-generation telemetry cap and 1% sampling for local use; the optional Go OTel collector is supported. (EL-7, EL-8) lang TS (+ Go collector optional).
- [ ] P8-T2 DuckDB observatory: SQL over all eval runs and the learning log, longitudinal dashboards in `openbuff dash`, and notebooks. (EL-4) lang TS (duckdb node) + optional Python notebooks.
- [ ] P8-T3 Eval fleet: containerized/microVM parallel runner with repeats, resumable runs, a cost/quality Pareto front, and oracle strength via StrykerJS mutation. (EL-3, EL-12, EL-13, SB-12 shared) lang Go runner + TS runTask entry.
- [ ] P8-T4 Python stats + learn sidecar (uv-managed, D2), covering:
  - scipy/statsmodels paired and mixed-effects gates with power analysis
  - judge calibration: krippendorff, Bradley-Terry pairwise tournament, Dawid-Skene
  - failure mining: lightgbm+SHAP, HDBSCAN
  - optuna BO over pruner/compaction caps

  (EL-1 full, EL-5, EL-6, EL-10) lang Python.
- [ ] P8-T5 Variant registry + wire decideProposalPromotion into the runner. Widen the proposal action space (reversible section edits, exemplars, compression). Promotions go to a candidate channel. (EL-2, EL-11) lang TS.
- [ ] P8-T6 `openbuff evolve`: DSPy MIPROv2/GEPA or TextGrad optimizes agent prompts and tool descriptions on a train split, validates on held-out with the P8-T4 gate, and produces versioned overlays. Lessons are read back via P8-T8. (EL-2, IL-4) lang Python + TS orchestration.
- [ ] P8-T7 Learned router + bandit: a classifier trained on outcomes (Python) and exported to ONNX for TS inference. Thompson/LinUCB picks the variant per task type. Recommendations are transparent, and explicit routing still wins. (IL-3, EL Q2 #2/#3) lang Python train, TS/onnxruntime inference.
- [ ] P8-T8 Knowledge store: bun:sqlite FTS5 + sqlite-vec for lessons, harness knowledge and memory-v2. Ships memory-v2 `search()` (currently unsupported at :1553) and `compact()`, with a namespaced embeddings cacheKey. (EL-9, PC-4, old W4-6) lang TS (→ rusqlite kernel only if X-2 shows the need).
- [ ] P8-T9 Memory reranking + NLI: a cross-encoder reranker and a contradiction/staleness detector feeding revalidate/correct. (IL-5) lang TS (transformers.js / onnxruntime-node).
- [ ] P8-T10 Local offline embeddings behind EmbedFn, with cacheKey `local:onnx/<model>`. (old R5e, prior #4) lang TS onnxruntime-node → candle/ort sidecar if GPU EPs are needed.

## P9 — Extensibility & local-model superpowers (ships: plugin marketplace, hooks in any language, guaranteed-valid local tool calls)

- [ ] P9-T1 Declarative `agent.yaml`/JSON agents (prompt, tools, subagents, hooks) validated against the dynamic-agent-template schema. (EXT-2) lang TS.
- [ ] P9-T2 Hooks in any language: a lifecycle hooks field (pre/post tool, pre-commit, turn end) running executables over a JSON stdin/stdout contract inside the sandbox. (EXT-4) lang TS.
- [ ] P9-T3 JSON Schema tool descriptors + external executable/RPC tools (no Zod closure needed). (EXT-1) lang TS.
- [ ] P9-T4 QuickJS isolate for string handleSteps: CPU interrupt, memory caps, heap snapshot for durable generators (feeds P2-T2). Wire the existing `@jitl/quickjs-wasmfile-release-sync` dependency (sdk/package.json:62). Today `new Function` still runs at run-programmatic-step.ts:368. (ORCH-2, EXT-2) lang TS + QuickJS WASM. gate: escape tests; security-reviewer.
- [ ] P9-T5 WASM component plugins: a WIT world `openbuff:plugin` (tool, hook, agent-step) on wasmtime (sidecar) / jco, with capability grants, plus a signed registry with lockfile. (EXT-*, old plugin host) lang Rust host + any-language guests.
- [ ] P9-T6 Local inference provider (D7, locked: Rust sidecar `openbuff-infer` using mistral.rs or llama-cpp-2, supervised by X-5, never in-process under Bun): llama.cpp/mistral.rs with grammar-constrained tool calls compiled from the Zod schemas (llguidance/outlines-core). One KV sequence per run with delta appends, KV forks for spawn_agents, disk snapshots for instant resume, speculative decoding. The tool-call repair layers can be skipped on this path. (IL-1, IL-2) lang C++/Rust.
- [ ] P9-T7 Continuous local compaction: LLMLingua-2 extractive compression plus a local summarizer, and a looser governor for local runs. (IL-6) lang TS (ONNX) + P9-T6 engine.
- [ ] P9-T8 Per-project LoRA adapters trained from judge-verified local traces (unsloth/PEFT/TRL or mlx-lm) and hot-swapped in P9-T6. (IL-4, EL Q2 #4) lang Python.

## P10 — Frontier (ships: untrusted-repo mode, provenance prompts, GUI perception, voice, remote swarms)

- [ ] P10-T1 Untrusted-repo microVM tier: libkrun/Firecracker/gVisor/Virtualization.framework, VM snapshot/branch, docker/podman fallback. (SB-12) lang Rust.
- [ ] P10-T2 Syscall provenance: eBPF (aya) filtered by job cgroup, fanotify, EndpointSecurity, ETW, and seccomp_unotify live prompts ("reading ~/.ssh — allow?"). Provenance records are attached to receipts. (SB-13) lang Rust.
- [ ] P10-T3 GUI/screen perception exposed as MCP tools: Swift AX + ScreenCaptureKit, C# UIAutomation, Rust atspi/PipeWire. Approval-gated with a per-app allowlist. (S9) lang Swift/C#/Rust. gate: security-reviewer.
- [ ] P10-T4 Voice I/O: whisper.cpp + Silero VAD push-to-talk, piper TTS status. (S10) lang C++/Rust.
- [ ] P10-T5 Multi-machine swarms: remote workers over SSH/containers, one lane each, using daemon leases with fencing tokens. Elixir is considered only if clustering becomes a first-class goal. (ORCH-4) lang Rust daemon (or Elixir per D1 revisit).
- [ ] P10-T6 CRDT human+agent co-editing via Yjs through the editor bridges (P7-T1/T2). (EV-9) lang TS.
- [ ] P10-T7 Embedded LSP server exposing Openbuff intelligence to editors. This is lower value than P3's LSP client. (old W5-3 LSP) lang TS or Rust daemon.
- [ ] P10-T8 Single-binary distribution via cargo-dist for the daemon/sidecars, plus a reduced TS bundle. Retires vendored rg and WASM sibling shipping once P6-T6/T7 are the default, and moves checksums to build time. (old W5-4, prior #5) lang Rust + CI.
- [ ] P10-T9 Remaining evidence-gated kernels, only if X-2 rows justify them: stream XML tool-call parser (memchr/simd-json), ANSI/string utils (old W1-2), rusqlite hardened-open VFS. lang Rust napi.

## Dependencies

- X-1 and X-4 come before P1. X-5 comes before any sidecar (P3-T11, P4-T4/T5, P5, P6, P8-T4).
- P1-T1 → P1-T2 → P1-T3/T4/T5. P1 → P7 (all clients).
- P2-T1 → P2-T2 → P2-T3. P2-T2 is strengthened by P9-T4 (heap snapshots).
- P3-T1 → P3-T2/T3/T6 → P4-T2. P0-T8 → P3-T3, P4-T3. P3-T4 → P3-T7/T9.
- P5-T1 → P5-T3/T6/T7, P9-T2, P10-T1/T2. P5-T2 is absorbed into P6-T5.
- P6-T1 → P6-T2 → P6-T3/T4. P6-T5 → P6-T6/T7/T8, P7-T8, P10-T5.
- P0-T6 → P8-T4 → P8-T5 → P8-T6/T7. P8-T1 → P8-T2/T7/T9 training data.
- P9-T6 → P9-T7/T8. X-2 gates P3-T10 native, P4-T7 native, P6-T9, P7-T7, P8-T8 native, P10-T9.

Parallelizable tracks after P1: A (surfaces P7), B (durability P2→P6), C (intelligence P3→P4), D (security P5), E (learning P8), F (extensibility P9). Phase numbers set the priority order within each track, not strict serialization.

## Validation gates (every task)

1. `bun run typecheck` + affected `bun test` (behavioral oracle); `cargo test` for Rust; `pytest` for the Python sidecar.
2. Contract fixtures (X-1) green; any contract change is a versioned addition.
3. Native/sidecar tasks: the CI job runs the native path (X-3) and the capability tier is reported (X-4).
4. Security-boundary tasks: adversarial tests + security-reviewer.
5. TUI/client tasks: tmux-cli or browser visual smoke.
6. Learning tasks: promotions pass the paired significance gate on a held-out split.

## Risks

- Scope breadth. Mitigation: tracks run independently, every phase ships something on its own, and capability flags mean partially done tracks never block users.
- Build matrix and supply chain growth (Rust/Go/Python/Swift/Kotlin). Mitigation: sidecars are optional downloads with checksums; X-3 CI; dependency-reviewer on each new toolchain.
- Protocol lock-in. Mitigation: version negotiation in `initialize`, ACP compatibility, golden vectors.
- Sandbox false confidence. Mitigation: tier reporting (X-4), adversarial tests, and a fail-loud path when the requested tier is unavailable.
- Learning overfitting to evals. Mitigation: held-out splits, significance gates, candidate channel, easy rollback of overlays.
- License constraints (mergiraf GPL-3, CodeQL). Mitigation: user-installed sidecars only.
- Daemon ownership of the index/leases changes cross-process semantics. Mitigation: port the lock/CAS tests into daemon lifecycle tests before cutover.

## Traceability matrix (finding → task)

Re-audit:
- **Sandbox:**
  - SB-1 P5-T1
  - SB-2 P0-T1, P5-T3
  - SB-3 P2-T4, P6-T2
  - SB-4 P5-T2
  - SB-5 P0-T3, P5-T4
  - SB-6 P0-T2
  - SB-7 P0-T4, P5-T7
  - SB-8 P5-T5
  - SB-9 P5-T4
  - SB-10 P4-T8
  - SB-11 P5-T2, P6-T5
  - SB-12 P10-T1, P8-T3
  - SB-13 P10-T2
- **Inference & learning:**
  - IL-1 P9-T6
  - IL-2 P9-T6
  - IL-3 P8-T7
  - IL-4 P8-T6, P9-T8
  - IL-5 P8-T9
  - IL-6 P9-T7
  - IL-7 P3-T10
  - IL-8 P6-T8 (keep failover in TS)
- **Language intelligence:**
  - LI-01 P3-T1/T2
  - LI-02 P0-T5, P3-T3
  - LI-03 P3-T4
  - LI-04 P4-T1/T2/T4
  - LI-05 P0-T8
  - LI-06 P3-T7
  - LI-07 P3-T8
  - LI-08 P3-T5
  - LI-09 P3-T6
  - LI-10 P3-T11
  - LI-11 P0-T7
  - LI-12 P3-T9
  - LI-13 P0-T7
- **Edit & VCS:**
  - EV-1 P6-T1/T2
  - EV-2 P2-T4
  - EV-3 P0-T5, P4-T1
  - EV-4 P6-T4
  - EV-5 P2-T5
  - EV-6 P0-T7, P4-T6
  - EV-7 P4-T5
  - EV-8 P2-T4
  - EV-9 P10-T6
  - EV-10 P6-T3
- **Orchestration:**
  - ORCH-1 P2-T2
  - ORCH-2 P0-T7, P9-T4
  - ORCH-3 P2-T8
  - ORCH-4 P6-T5, P10-T5
  - ORCH-5 P0-T7, P6-T8
  - ORCH-6 P2-T1/T3
  - ORCH-7 P2-T6
  - ORCH-8 confirmed TS-adequate, no action
- **Surfaces:**
  - S1 P1-T1/T2
  - S2 P1-T2, P7-T4
  - S3 P1-T3, P7-T3
  - S4 P1-T4, P0-T7
  - S5 P7-T1/T2
  - S6 P1-T7, P7-T5
  - S7 P2-T7
  - S8 P7-T6
  - S9 P10-T3
  - S10 P10-T4
  - S11 P1-T7, P7-T3
- **Evals & learning:**
  - EL-1 P0-T6, P8-T4
  - EL-2 P8-T5/T6
  - EL-3 P8-T3
  - EL-4 P0-T6, P8-T2
  - EL-5 P0-T6, P8-T4
  - EL-6 P8-T4
  - EL-7 P8-T1
  - EL-8 P8-T1
  - EL-9 P8-T8
  - EL-10 P8-T4
  - EL-11 P8-T5
  - EL-12 P0-T6, P8-T3
  - EL-13 P8-T3
  - EL-14 P0-T7
- **Plan critique:**
  - PC-1 SPEC principle 1, P1
  - PC-2 SPEC principle 3
  - PC-3 SPEC principle 2
  - PC-4 P1-T6, P8-T8
  - PC-5 P6-T5 ordering
  - PC-6 X-3
  - PC-7 X-6
- **Extensibility:**
  - EXT-1 P9-T3, P7-T6
  - EXT-2 P9-T1/T4
  - EXT-3 P0-T7, P5-T6
  - EXT-4 P9-T2
  - ALT-12 SPEC architecture

Prior audit (Q1 table and top opportunities):
- highlighting: P1-T6
- images: P7-T7, P1-T7
- rich/word diffs: P4-T7
- fuzzy: P7-T7
- memory-v2 kernel: P8-T8
- code_search in-process rg: P6-T6
- index store + BM25: P6-T6
- parse tier: P6-T7
- tokenizer: P3-T10
- range reads/readdir: P6-T9
- stream XML parser: P10-T9
- tmux/PTY: P5-T4
- distribution: P10-T8
- bootstrap: P7-T8
- embeddings: P8-T10
- file watching: P6-T6
- daemon: P6-T5
- LSP server: P10-T7
- MCP server: P1-T4
- plugin host: P9-T5
- OS sandboxing: P5-T1
- grapheme layout: P7-T7
- incremental syntax-aware editing: P4-T1, P6-T7
- W0-1: X-3
- W0-2: X-2
- W0-3: X-1
