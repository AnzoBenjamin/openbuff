# Re-audit Report — Openbuff polyglot (reaudit-polyglot-2026-09)

Generated 2026-09-26. Synthesized from 8 shard finding files (89 findings: 1 CRITICAL, 38 HIGH, 37 MEDIUM, 13 LOW). All claims come from the shard findings. Source was not re-read during synthesis, so every file:line below is as reported by its shard.

## Top 10 highest-leverage fixes
1. [HIGH] api-contract — sdk/src/client.ts:47 — Ship versioned ACP/JSON-RPC `openbuff serve` protocol (S1, PC-1, ALT-12)
2. [CRITICAL] security — sdk/src/tools/terminal-command-policy.ts:2092 — Enforce profiles via native Landlock/Seatbelt exec shim (SB-1)
3. [HIGH] security — sdk/src/env.ts:49 — Allowlist child env; strip all credentials (SB-2)
4. [HIGH] security — sdk/src/tools/run-terminal-command.ts:340 — Approval reruns keep profile; one-shot token (SB-6)
5. [HIGH] correctness — common/src/util/language-capabilities.ts:102 — Add TS LSP client driving real servers (LI-01)
6. [HIGH] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts:76 — Tree-sitter hasError preflight for all languages (LI-02, EV-3)
7. [HIGH] state-mutation — cli/src/utils/run-state-storage.ts:321 — Per-turn content snapshots enabling real /undo (EV-2, SB-3, EV-8)
8. [HIGH] state-mutation — sdk/src/services/workspace-mutation-broker.ts — Workspace lanes: per-agent COW worktrees (EV-1, EV-4)
9. [HIGH] state-mutation — packages/agent-runtime/src/run-programmatic-step.ts — Append-only run journal plus deterministic replay (ORCH-1, ORCH-6)
10. [HIGH] correctness — evals/buffbench/proposals.ts:365 — Paired significance gate, then closed learning loop (EL-1, EL-2, IL-4)

---

## 1. Executive thesis

The real ceilings are architectural, not about speed. The 8 lenses independently hit the same five walls:

1. **No out-of-process protocol.** The agent is callable only through in-process JS closures (`run()` with handleEvent/requestApproval; S1, S2, S8, EXT-1). That blocks desktop, IDE, mobile approval, non-JS SDKs, remote workers, and consumption as an MCP server.
2. **No OS sandbox.** The "boundary" is a 2452-line lexical bash parser in front of `bash -c` (SB-1). Every child inherits every API key (SB-2), and an approval turns off the policy entirely (SB-6).
3. **A single shared workspace.** There is one working tree behind one mkdir lock (EV-1). There are no per-agent lanes, no file-state checkpoints (EV-2), and shell writes are invisible to receipts (SB-3). Parallel agents clobber each other, and turns cannot be undone.
4. **No learning loop.** Lessons are append-only markdown that nothing reads (EL-2). Promotion uses a raw +0.25 delta with no statistics (EL-1). Telemetry is capped at 2 MB and sampled at 1% (EL-7, EL-8). Routing is done by regex (IL-3). This contradicts docs/goal.md.
5. **No semantic language tooling.** The registry names tsserver, pyright, rust-analyzer, gopls, and others, but nothing speaks LSP (LI-01). The call graph matches unique names only (LI-03). Preflight does nothing for 10 of 13 languages (LI-02). Diagnostics are scraped with regexes and compiler fix-its are thrown away (LI-05).

Another language matters in three places:

- **At the edges:** OS APIs such as Landlock/seccomp pre-exec, cgroups/pidfd, AX/UIA, APNs, and mic capture; native clients (Swift, Kotlin, Tauri); editor plugins (Kotlin, Lua).
- **As sidecars where the ecosystem lives in that language:** Python for DSPy/stats/LoRA, Go for gitleaks and mvdan/sh, Rust for ast-grep, mergiraf, difftastic, gix/jj, and llama.cpp bindings; each ecosystem's own LSP/SCIP indexer.
- **Not as accelerators.** Most of the high-value items (protocol, LSP client, journal, SQLite FTS5, MCP server, significance tests, structured diagnostics) are TS-doable today.

## 2. Why the prior plan is limited

The prior plan was "Rust hot paths via napi behind frozen TS interfaces" (.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md and polyglot-native-waves/).

- **PC-1 — Framing caps value.** SPEC.md:5 puts all native work "behind existing TS interfaces", and :9-17 freezes run.ts, ToolResultOutput, and the agent templates. The unlocks the audit itself named (daemon, LSP, MCP server, plugins, sandbox) are new process topologies or trust boundaries, so they cannot sit behind an unchanged in-process signature.
- **PC-2 — One integration mechanism.** SPEC.md:50 requires every module to be an in-process napi `.node` file. That excludes Python, Go, and WASM, gives no crash isolation (a Rust panic kills the TUI), and requires a 7-leg build matrix per binding.
- **PC-3 — The dual-implementation parity tax is proven.** Wave 0 (version/stripAnsi/countBytes, where countBytes is just `input.len()`) took 4 repair rounds and a 410-line wrapper (STATUS.md:36-57, index.ts). Waves 1-3 inherit the same byte-identical rule on far larger surfaces.
- **PC-4 — No user-visible feature before Wave 4.** Waves 1-3 are validated only by "tests pass unchanged". The first visible wins need no new language: highlighting via the already-shipped web-tree-sitter (syntax-highlighter.tsx:9-18 is a stub), and FTS5 memory search via bun:sqlite (bun-sqlite-memory-repository.ts:1553).
- **PC-5 — The topology pivot comes last, so the boundary gets paid for twice.** The W5-1 daemon depends on the W2 in-process modules, and W2-3 ports lock/CAS tests that a daemon would make unnecessary (PLAN.md:23, :44, :50).
- **PC-6 — CI never runs the native path.** native-core-build.yml:116-135 tests only the JS fallback, parity tests skip without the binary, and prebuilds are unpublished.
- **PC-7 — Citation errors, and a missed existing extension surface.** Spot-check found 3 of 5 citations accurate:
  - The memory-v2 cite :2670 is wrong; the correct line is :1553.
  - terminal-images.ts:155 is kitty chunking, not the sixel path (sixel is at :37/:196/:218).
  - The report frames "MCP server" as a Wave 5 native unlock and never mentions the existing full MCP client (common/src/mcp/client.ts: stdio, SSE, HTTP).
- **Also missed by the prior plan (from other lenses):**
  - It never identified the lexical policy as the thing to re-ground in a kernel boundary (SB-1).
  - It proposed an embedded LSP *server*, when Openbuff needs to *consume* LSP (LI-01).
  - A faster native tree-sitter still builds the same wrong name-matched call graph (LI-03).
  - Its tiktoken item misses open-weight tokenizers (IL-7).

## 3. Q1 — Components that benefit from a different language (feature standpoint)

### 3a. Must be another language (TS cannot reach the capability)

Ranked by feature impact.

| # | Component | Evidence | Language + library | Feature unlocked | Could TS do it? |
|---|---|---|---|---|---|
| 1 | Terminal exec boundary | terminal-command-policy.ts:2092; run-terminal-command.ts:508 | Rust shim: `landlock`, `seccompiler`, `nix` unshare; macOS SBPL; Windows AppContainer + Job Objects (codex-rs precedent) | Enforced profiles; lexical false-denies can be relaxed | No on Linux/Windows (no pre-exec hook in Bun). macOS `sandbox-exec` or `bwrap` shell-out is a partial option |
| 2 | Process-tree control / jobd | background-jobs.ts:55-75, :782, :1144, :1291 | Rust or Go: cgroups v2, pidfd, PR_SET_CHILD_SUBREAPER, SO_PEERCRED, Job Objects | Guaranteed tree kill, mem/cpu/pids caps, live RSS, true reattach with exit codes (SB-4, SB-11) | Partial: `systemd-run --user --scope`. pidfd/subreaper are not reachable |
| 3 | Egress proxy + secret broker | env.ts:49; run-terminal-command.ts:413/:485 | Rust hyper+rustls+rcgen or Go goproxy, enforced by netns | Agents use gh/npm/cloud CLIs without ever holding raw secrets (SB-2) | Proxy yes; forcing children through it no |
| 4 | Workspace lanes / COW / merge | workspace-mutation-broker.ts; process-edit-transaction.ts | Rust gix/git2 in-memory trees, reflink-copy/clonefile/overlayfs; mergiraf (GPL-3.0, sidecar) | Best-of-N parallel agents, auto-merge of disjoint AST edits (EV-1, EV-4, SB-3) | `git worktree` and diff3 yes; in-memory trees, COW, and syntax-aware merge no |
| 5 | Multi-language structural rewrite | process-structured-edit.ts; rewrite-symbol.ts; structure.ts:71 | Rust ast-grep via existing `@ast-grep/napi`; libCST (Py), dst (Go), OpenRewrite (JVM) | rename/structural_replace/move-symbol in one deterministic call (LI-04, EV-3) | TS/JS only (ts-morph/recast) |
| 6 | Learning loop optimizer | lessons-extractor.ts:290; proposals.ts; usage-observer.ts | Python: DSPy MIPROv2/GEPA, TextGrad; unsloth/PEFT/TRL, mlx-lm LoRA | Auto prompt optimization with gated promotion; per-project adapters (EL-2, IL-4) | No credible TS ecosystem |
| 7 | Eval statistics & failure mining | proposals.ts:365; judge.ts:373; meta-analyzer.ts:146 | Python: scipy, statsmodels mixed effects, krippendorff/pingouin/choix, lightgbm+SHAP, HDBSCAN, optuna | Power analysis, calibrated judges, ranked failure taxonomies, BO over pruner caps (EL-1, EL-5, EL-6, EL-10) | Bootstrap/Wilcoxon yes; the rest no |
| 8 | Local inference engine | model-provider.ts; llm.ts | llama.cpp (C++) via llama-cpp-2 or node-llama-cpp; mistral.rs; MLX; llguidance/outlines-core | Grammar-constrained tool calls, KV reuse and forking for subagents, speculative decoding, instant /resume (IL-1, IL-2, IL-6) | Partial via node-llama-cpp (native underneath; Bun compatibility unverified) |
| 9 | Mobile/remote approval | run.ts:236-241, :850 | Swift (APNs, Live Activities), Kotlin (FCM, Wear); Noise/libsodium relay | Approve long runs from phone or watch (S2) | Lesser version via RN/PWA |
| 10 | GUI/screen perception | slash-commands.ts | Swift AX + ScreenCaptureKit; C# UIAutomation; Rust atspi | Verify native/sim/game UIs; approval-gated (S9) | No |
| 11 | Editor plugins | open-file.ts:56-126 | Kotlin (JetBrains), Lua (Neovim), Elisp, Rust→WASM (Zed); TS for VS Code | Bidirectional editor link, hunk accept in editor (S5) | VS Code family only |
| 12 | Desktop shell | cli/src/index.tsx; app.tsx | Rust Tauri 2 | Split panes, rich media, tray, detach/attach (S3, S11) | Electron yes; Tauri gives size, tray, and updater natively |
| 13 | Native PTY host | tmux-cli.ts:485; run-terminal-command.ts:508 | Rust portable-pty + vt100/alacritty_terminal; Go creack/pty | `terminal_session` tool, awaitingInput detection via tcgetpgrp, no /tmp executable (SB-5, SB-9) | `script -q` + xterm-headless partial; foreground-pgrp needs native |
| 14 | Secret scanning corpus | redact-secrets.ts:15-21; run-terminal-command.ts:34 | Go gitleaks/trufflehog (live verification) | Stream-time redaction, commit gating with rule IDs, "key is LIVE" (SB-8) | Rules portable; verification and corpus maintenance are the Go value |
| 15 | OS integration | clipboard-image.ts:76; clipboard.ts:163-190 | Rust arboard, notify-rust, tray-icon | Wayland copy, actionable Approve/Deny notifications (S6) | OSC 9/777 and wl-copy only |
| 16 | Structural review diff | get-change-review-bundle.ts | Rust difftastic sidecar (`--display json`) | Reformat-collapsed semantic diffs for reviewers (EV-7) | No maintained TS differ |
| 17 | Eval fleet | run-buffbench.ts | Go (containerd/k8s) or Rust; Firecracker/gVisor/libkrun | Hundreds of sandboxed, resumable, repeated trials (EL-3, SB-12) | dockerode possible; weaker isolation |
| 18 | Untrusted-repo microVM | terminal-command-policy.ts:2100 | libkrun, Firecracker, gVisor, Virtualization.framework | Full access inside a disposable VM (SB-12) | docker/podman shell-out only |
| 19 | Provenance | run-terminal-command.ts:432/:478 | Rust aya eBPF, fanotify, EndpointSecurity, ETW, seccomp_unotify | "This command read ~/.ssh — allow?" (SB-13) | No |
| 20 | Voice I/O | command-registry.ts | whisper.cpp, piper, cpal | Push-to-talk, spoken status (S10) | No |
| 21 | Language analyzers themselves | language-capabilities.ts | Each ecosystem's LSP/SCIP indexer, semgrep (OCaml), CodeQL | Types, precise refs, taint (LI-03, LI-09, LI-10) | Consumption is TS; the engines are not |

### 3b. TS is fine — these were missed, not blocked by language

| Component | Evidence | Feature | Note |
|---|---|---|---|
| ACP/JSON-RPC server `openbuff serve` | client.ts:47; run.ts:241-244 | Headless/CI, editor attach, generated Python/Go SDKs (S1, S8) | Rust daemon optional later |
| MCP server `openbuff mcp` | common/src/mcp/client.ts:137 | Expose query_index, cap reads, and memory to Cursor/Claude/Zed (S4) | @modelcontextprotocol/sdk |
| LSP client/multiplexer | language-capabilities.ts:102 | definition/refs/hover/rename/diagnostic delta (LI-01, LI-09) | vscode-jsonrpc; registry needs ToolSpec argv (LI-13) |
| SCIP ingestion | parse.ts:513 | Precise cross-file/cross-lang call graph (LI-03) | TS reader over native indexers |
| Structured diagnostics + fix-its | language-diagnostics.ts:71 | apply_compiler_fix (LI-05) | JSON/SARIF modes |
| Test-impact + build-target graph | harness-intelligence.ts:356, :395 | Correct affected tests for Go/Py/Rust/JVM; per-target builds (LI-06, LI-07) | Native build-tool CLIs |
| Import resolution | metadata-indexer.ts:106 | `ts.resolveModuleName`, tree-sitter import nodes (LI-08) | Counterexample to "move to Rust" |
| Ranked repo map | repo-map.ts:58 | Personalized PageRank (LI-12) | |
| Durable run journal + replay | run-programmatic-step.ts; orchestration-ledger.ts | Resume mid-tool-call, `openbuff replay --from-step` (ORCH-1, ORCH-6) | bun:sqlite; BEAM would not make generators serializable |
| handleSteps isolation | run-programmatic-step.ts (`new Function`) | Untrusted programmatic agents, CPU interrupt, heap snapshots (ORCH-2) | quickjs-emscripten |
| Supervision via Workers | spawn-agents.ts | Hard kill, restart policies (ORCH-3) | Requires message-passing refactor first |
| Provider scheduler | spawn-agents.ts selectAgentAttempt | Token buckets, priority, cross-session budgets (ORCH-5, IL-8) | Cross-process needs a daemon (any language) |
| Declarative workflow gate | workflow-engine.ts | Persisted, resumable, visual gate (ORCH-7) | XState or promote engine |
| Declarative agents / hooks / tool descriptors | load-agents.ts:122; custom-tool.ts:9; load-skills.ts:96 | agent.yaml, hooks in any language, JSON Schema tools (EXT-1, EXT-2, EXT-4) | |
| MCP lockfile + capabilities | load-mcp-config.ts:129 | Pinned, checksummed, sandboxable servers (EXT-3) | |
| SQLite FTS5 + sqlite-vec knowledge store | local-harness-store.ts:62 | Trust-ranked retrieval of lessons/knowledge (EL-9, PC-4) | bun:sqlite |
| Reranker/NLI for memory | concept-index.ts:40 | Contradiction/staleness detection (IL-5) | transformers.js/onnxruntime-node |
| Open-weight tokenizers | token-counter.ts:46 | Exact budgets for Qwen/GLM/DeepSeek (IL-7) | @huggingface/transformers |
| OTel spans + Parquet/DuckDB | gate-telemetry.ts:36; compare-buffbench-runs.ts:29 | Local learning corpus, SQL over all evals (EL-4, EL-7, EL-8) | Collector optional (Go) |
| Turn snapshots v1 | run-state-storage.ts:321 | /undo-turn via git plumbing (EV-2, EV-8) | jj-lib later |
| Transaction intent log | change-file.ts | Crash-atomic multi-file edits (EV-5) | renameat2 needs native |
| blame_context / stage_hunks / land_lane | git-status.ts:30; git-branch.ts | Historical intent, hunk commits, merge-tree landing (EV-6, EV-10) | gix later |
| Session dashboard | tmux-viewer README | `openbuff dash` replay/audit (S7) | localhost + token |
| CRDT human+agent | edit-application-coordinator.ts | Live co-editing (EV-9) | Yjs; needs editor bridge |
| Shell AST lint layer | terminal-command-policy.ts:1130 | Node-anchored "why denied", safe rewrites (SB-10) | tree-sitter-bash already shippable |
| Highlighting | syntax-highlighter.tsx:9-18 | Visible in phase 1 (PC-4) | web-tree-sitter or shiki |
| Failover/discovery | failover.ts | Keep in TS; add EWMA health (IL-8) | Confirmed TS-appropriate |
| SDK concurrency | sdk/src/tools/concurrency.ts | None needed (ORCH-8) | Confirmed TS-appropriate |

## 4. Q2 — Brand-new features (deduplicated, ranked)

1. **Headless protocol, editor attach, and any-language SDKs**: S1, S8, ALT-12, PC-1.
2. **Enforced sandbox profiles**, including a secret-less credential broker and egress allowlist: SB-1, SB-2, SB-7, EXT-3.
3. **Undo any turn, including shell side effects, plus a session timeline and bisect-by-turn**: EV-2, EV-8, SB-3, S7.
4. **Best-of-N parallel agent lanes** with syntax-aware auto-merge and landing: EV-1, EV-4, EV-10, SB-3.
5. **Semantic code intelligence**: LSP definition/refs/hover, diagnostic-delta preflight, and SCIP-precise blast radius: LI-01, LI-02, LI-03, LI-09.
6. **One-call semantic refactors** (rename_symbol, structural_replace, apply_compiler_fix): LI-04, EV-3, LI-05.
7. **Remote/mobile approvals** with actionable OS notifications: S2, S6.
8. **Durable runs that survive reboot/OOM**, plus `replay --from-step --model`: ORCH-1, ORCH-6, ORCH-7.
9. **Closed learning loop**: variant registry, a stats-gated promotion step, DSPy prompt optimization, local learning log, and learned router: EL-1, EL-2, EL-8, EL-11, IL-3, IL-4.
10. **Openbuff as an MCP server** for other agents and IDEs: S4.
11. **Guaranteed job control**: tree kill, resource caps, reattach after CLI restart: SB-4, SB-11.
12. **Local-model superpowers**: constrained decoding, KV forking, continuous local compaction: IL-1, IL-2, IL-6.
13. **Marketplace-safe plugins**: declarative agents, hooks in any language, WASM components, sandboxed handleSteps: EXT-1, EXT-2, EXT-4, ORCH-2.
14. **Correct affected tests and target-level builds** in non-JS monorepos: LI-06, LI-07.
15. **Desktop client**: split panes, rich media, tray: S3, S11.
16. **PTY terminal_session tool** with awaiting-input detection: SB-5, SB-9.
17. **Semantic review diffs** and taint-checked agent edits: EV-7, LI-10.
18. **Cross-process lease/job daemon** leading to multi-machine swarms, plus a global BYOK spend/rate scheduler: ORCH-4, ORCH-5.
19. **Eval fleet** with repeats, Pareto cost-quality, and oracle strength: EL-3, EL-12, EL-13.
20. **Untrusted-repo microVM mode**, syscall provenance, and GUI perception: SB-12, SB-13, S9.
21. **Voice I/O**: S10.

## 5. Alternative architecture

This consolidates ALT-12 with the sandbox, surfaces, and edit lenses.

1. **openbuff-core (TS/Bun), protocol-first.**
   - Owns sessions, the agent loop, tools, cap.v3, broker, run journal, and approvals.
   - Speaks versioned JSON-RPC 2.0 (ACP-compatible, version negotiated in `initialize`) over stdio or a unix socket. The schema is generated from the existing Zod definitions.
   - Approvals, events, and custom tools become protocol messages (reverse requests).
   - Today's TS API becomes one client binding of this protocol.
2. **Thin clients:**
   - OpenTUI CLI
   - ACP editors (VS Code in TS, JetBrains in Kotlin, Neovim in Lua, Zed)
   - Tauri desktop
   - Swift/Kotlin mobile approver
   - CI / headless
   - Generated Python/Go SDKs
3. **Supervised sidecars (MCP or JSON-RPC), each in its best language, each advertised as a capability.** If a sidecar is missing, the capability simply isn't advertised; there is no dual implementation (fixes PC-3). Candidates:
   - Rust sandbox exec shim + jobd (cgroups, pidfd, subreaper)
   - Rust index/lanes service (tantivy+notify, gix, reflink)
   - LSP multiplexer driving ecosystem servers, plus SCIP indexers
   - Python learn/stats sidecar (uv-managed, never on the hot path)
   - Go gitleaks and an optional OTel collector
   - difftastic and mergiraf CLIs
4. **WASM components** (WIT world `openbuff:plugin` on wasmtime/jco) and a QuickJS isolate for untrusted plugins and handleSteps, with capability grants.
5. **napi only** for sub-millisecond, chatty TUI kernels (fuzzy match, highlight spans), plus existing prebuilt addons (@ast-grep/napi).
6. **Resident daemon (later).** It takes over leases, the job registry, the scheduler, and the index, which turns cross-process and multi-machine operation into a transport change rather than a rewrite (ORCH-4, SB-11, PC-5). Go or Rust for a single static binary; Elixir only if multi-node clustering becomes a first-class goal.

## 6. Phased roadmap (every phase ships a user-visible feature)

| Phase | Ships to users | Work (language) |
|---|---|---|
| P0 | Safer defaults, no "command denied" regressions | Section 7 quick fixes (TS) |
| P1 | **Headless/CI mode and editor attach**; `openbuff mcp` server; syntax highlighting | ACP server, MCP server, web-tree-sitter highlight (TS) |
| P2 | **/undo-turn and session timeline/dashboard**; resume after crash | git-plumbing snapshots, append-only journal, run journal on bun:sqlite, `openbuff dash` (TS) |
| P3 | **Go-to-definition, find-refs, and diagnostic-delta preflight in agent tools**; correct affected tests | LSP multiplexer, SCIP reader, JSON/SARIF diagnostics, TIA/build graph (TS + ecosystem servers) |
| P4 | **One-call refactors** (rename, structural_replace, apply_compiler_fix) | ast-grep napi, LSP WorkspaceEdit via broker |
| P5 | **Enforced sandbox + secret broker**; guaranteed kill_job and resource caps | Rust exec shim, jobd, egress proxy, loud tier reporting |
| P6 | **Parallel best-of-N lanes** with auto-merge | Lane ids in broker/cap.v3; gix/reflink; diff3 → mergiraf sidecar |
| P7 | **Phone/desktop approvals and notifications**; desktop client | Swift/Kotlin companions, Tauri, arboard/notify-rust |
| P8 | **Self-improving agent**: stats-gated promotion, DSPy-optimized prompts, learned router | TS variant registry, Python learn/stats sidecar, OTel/Parquet learning log |
| P9 | **Plugin marketplace**: declarative agents, hooks, WASM plugins; local-model constrained decoding and KV reuse | WIT/wasmtime, QuickJS isolate, llama.cpp/mistral.rs provider |
| P10 | Untrusted-repo microVM, provenance prompts, GUI perception, voice | libkrun/Firecracker, eBPF/ES, AX/UIA, whisper.cpp |

## 7. Quick TS-only fixes discovered

- **Child env leaks all BYOK/OAuth keys.** `getSystemProcessEnv` returns `process.env` (sdk/src/env.ts:49), merged at run-terminal-command.ts:413/:485. Fix: build the child env from an allowlist and strip credential vars (SB-2).
- **tmux teardown ends in a stray `'>`.** This is a bash parse error, so `stop` and `rm` never run and sessions/helpers leak (agents/tmux-cli.ts, near :760-770). Fix: remove it and add a `bash -n` test (SB-5).
- **Approval rerun uses `mode:'user'`,** which disables all profile policy (run-terminal-command.ts ~:340; terminal-command-policy.ts:2100). Fix: rerun with the original mode plus a one-shot approval token (SB-6).
- **Chrome runs with `--no-sandbox` and an unauthenticated CDP TCP port** (browser-logs.ts:572-573). Fix: use `--remote-debugging-pipe` and drop `--no-sandbox` where userns is available (SB-7).
- **Preflight is a no-op for 10 of 13 languages** (preflight-syntax-validation.ts:76-90). Fix: reject on web-tree-sitter `rootNode.hasError` and report the first ERROR/MISSING node. Also replace `isResultDelimiterBalanced` (process-str-replace.ts:1728) with the same check (LI-02, EV-3).
- **Eval scripts reintroduce the score-threshold bias the runner removed** (compare-buffbench-runs.ts `<= 1.0`, analyze-buffbench-logs.ts:40 `=== 0`). Fix: use `scoringStatus` as the only exclusion rule (EL-4).
- **Promotion gate has no statistics** (proposals.ts:365). Fix: add paired bootstrap CI + Wilcoxon (EL-1).
- **`decideProposalPromotion` is referenced only from its test.** Fix: wire it into a runner (EL-2).
- **Judges:** store per-judge raw scores and variance (EL-5).
- **Aggregates:** add `--repeats/--seed`, mean ± SE, and score-per-dollar (EL-12).
- **evals/README documents legacy git-evals** (3 Gemini judges, efficiencyScore). Fix: document buffbench (EL-14).
- **Gate telemetry sink:** async batching; retention policy instead of 2 MB/1 generation (EL-7).
- **Affected tests:** per-language naming conventions from the registry (LI-06).
- **Build targets:** `cargo check -p` / `go build ./pkg/...` target ownership (LI-07).
- **Imports:** extract from tree-sitter nodes and resolve with `ts.resolveModuleName` (LI-08).
- **Language families:** derive the 3 duplicated extension→family maps from the registry; parse `.c` with tree-sitter-c (LI-11).
- **Registry ToolSpec:** launchable argv/transport; Kotlin root markers (LI-13).
- **Diagnostics:** JSON/SARIF modes and non-zero ranges (LI-05).
- **Open-weight tokenizer fudge factors** (IL-7).
- **MCP client still branded `codebuff`** (common/src/mcp/client.ts:137) (S4).
- **MCP config:** factor out the duplicated sync/async merge logic (load-mcp-config.ts:129-278) (EXT-3).
- **Clipboard/notifications:** wl-copy fallback; `readClipboardText` Wayland; OSC 9/777 notifications (S6).
- **Terminal images:** capability query (DA1/XTGETTCAP) instead of env sniffing (S11).
- **CLI git:** move `getDiffStats` off the UI-thread `execSync` (cli/src/utils/git.ts:38) (EV-6).
- **Background cost:** aggregate background-agent cost into the parent (ORCH-5).
- **Clock/IdGen:** inject through AgentRuntimeDeps (ORCH-6).
- **sandbox-generator.test.ts** asserts no isolation. Fix: rename it or make it assert isolation (ORCH-2).
- **Native CI:** add a matrix test job that asserts `nativeAvailable` (PC-6).
- **Prior report citations:** fix memory :1553 and the sixel lines (PC-7).

## 8. Cross-cutting findings, domain index, coverage, follow-ups

### Cross-cutting (2+ shards)
- **Protocol/daemon boundary:** S1, S2, S8, PC-1, PC-5, ALT-12, EXT-1, ORCH-4, SB-11. This is the keystone.
- **OS sandbox as a real boundary:** SB-1, SB-2, SB-6, SB-7, SB-12, EXT-3 (MCP servers), EL-3 (eval isolation).
- **Single workspace / no content store:** EV-1, EV-2, EV-5, EV-8, SB-3, ORCH-4.
- **Journaling / replay:** ORCH-1, ORCH-6, EV-8, S7, EL-7.
- **Learning loop absent:** EL-1, EL-2, EL-8, EL-11, IL-3, IL-4, EL-9.
- **Tree-sitter is underused:** LI-02, LI-08, EV-3, SB-10, PC-4. The grammars already ship.
- **ast-grep structural edits:** LI-04 = EV-3 (deduplicated).
- **SQLite/FTS5 retrieval:** EL-9, IL-5, PC-4.

### Findings by domain (IDs; severity)
- **Security:** SB-1 CRIT; SB-2, SB-6, ORCH-2 HIGH; SB-7, SB-8, SB-10, SB-12, S9, LI-10, EXT-3 MED.
- **Correctness:** SB-4, SB-5, IL-1, IL-3, LI-01, LI-02, LI-03, EV-3, EV-4, S3, EL-1, EL-5, PC-3, PC-4 HIGH; SB-9, IL-5, IL-7, LI-05, LI-06, LI-07, LI-08, LI-09, ORCH-4, ORCH-6, S6, S7, EL-6, EL-8, EL-12, PC-7 MED; LI-13, S10, S11 LOW.
- **State mutation:** SB-3, EV-1, EV-2, ORCH-1, EL-2, IL-4 HIGH; SB-11, EV-5, EV-8, EL-7 MED.
- **Error handling:** ORCH-3 HIGH; EV-9 LOW.
- **Performance:** IL-2, EL-3, EL-4 HIGH; IL-6, EV-6, ORCH-5, EL-9 MED; ORCH-8 LOW.
- **Dependency hygiene:** PC-2 HIGH; EL-13 LOW.
- **Test coverage gaps:** PC-6, EL-10 MED; SB-13, LI-11 LOW.
- **API/ABI contract:** S1, S2, S4, S5, LI-04, PC-1, PC-5, EXT-1, EXT-2, ALT-12 HIGH; S8, EL-11, EV-7 (tagged correctness), EXT-4 MED; IL-8, LI-12, ORCH-7, EV-10, EL-14 LOW.

### Coverage
- lens-sandbox.md: 13 (1 CRIT, 5 HIGH, 6 MED, 1 LOW)
- lens-inference-learning.md: 8 (4 HIGH, 3 MED, 1 LOW)
- lens-language-intel.md: 13 (4 HIGH, 6 MED, 3 LOW)
- lens-edit-vcs.md: 10 (4 HIGH, 4 MED, 2 LOW)
- lens-orchestration.md: 8 (3 HIGH, 3 MED, 2 LOW)
- lens-surfaces.md: 11 (5 HIGH, 4 MED, 2 LOW)
- lens-evals-learning.md: 14 (5 HIGH, 7 MED, 2 LOW)
- lens-plan-critique-extensibility.md: 12 (8 HIGH, 4 MED)
- **Total: 89 findings across 8 shards.** All shards were present and non-empty.

### Needs follow-up / unverified
- **QuickJS contradiction.** ORCH-2 says string handleSteps run via `new Function` in the host realm and that no QuickJS isolate exists. EXT-2 and PC-7 cite a QuickJS sandbox (sdk/package.json:62 `@jitl/quickjs-wasmfile-release-sync`). A human should confirm which execution path is live.
- **tmux-test policy scope (SB-5, unverified):** whether tmux-cli handleSteps commands are evaluated under the `tmux-test` profile. Setup uses `cat >`, `find -exec rm`, and `chmod`, which that profile denies. Also confirm the teardown `'>` line position.
- **terminal-images sixel null return:** not verified at the corrected lines (PC-7).
- **Bun compatibility of node-llama-cpp:** unverified (IL-1, IL-2).
- **Kotlin LSP status:** official JetBrains kotlin-lsp vs fwcd needs checking (LI-13).
- **Licensing:** mergiraf is GPL-3.0 (sidecar only?); CodeQL CLI is limited to OSS/research (EV-4, LI-10).
- **Line numbers:** run-terminal-command.ts ~:340 (SB-6) and tmux-cli.ts :760-770 are approximate in the shards.
- **Severity calibration:** severities are shard-assigned. Several "HIGH" items are feature gaps rather than defects; prioritization above is by feature leverage, not defect severity.
