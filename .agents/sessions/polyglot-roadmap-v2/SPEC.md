# SPEC — Polyglot Roadmap v2 (protocol-first, capability-driven)

Supersedes `.agents/sessions/polyglot-native-waves/` (the "Rust hot paths via napi, behind frozen TS interfaces" plan). This roadmap covers every finding in:
- `.agents/sessions/reaudit-polyglot-2026-09/REAUDIT-REPORT.md` (89 findings, 8 lenses)
- `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md` (72 findings; prior Q1/Q2 and Waves 0–5)

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
   - (e) Native clients (Swift/Kotlin/Lua/Rust) that talk to the protocol
4. **Language by capability:**
   - **Rust:** sandbox shim, jobd, PTY host, index/lanes service, Tauri, napi kernels
   - **Go:** gitleaks, the optional OTel collector, the eval fleet runner
   - **Python** (uv-managed, never on the hot path): stats, DSPy/GEPA, LoRA, failure mining
   - **Swift/Kotlin:** mobile, JetBrains, OS accessibility
   - **Lua/Elisp:** editor clients
   - **C++ via Rust sidecars:** llama.cpp through mistral.rs/llama-cpp-2 (D7), whisper.cpp through whisper-rs
   - Each language ecosystem's own LSP/SCIP servers are consumed as they are.
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
