# Language-fit audit: report (2026-09-28)

Inputs:
- 22 audit shards, all bound to snapshot 49801b44…d824d: 12 codebase (cb-*), 4 deep gap passes (gap-*), 6 plan (plan-R*).
- 5 web-verification researchers. Their results are in `findings/web-verification.md`, which overrides any shard that disagrees with it.
- Per-shard detail with file:line evidence is in `findings/`.

## 1. Answer

**TS is mostly in the right place, but not everywhere.**
- About 65% of roughly 230 codebase features are best left in TS. That covers the agent loop, the SDK, ACP, orchestration, TUI composition, evals, and policy decisions.
- Three independent shards support the SPEC non-goal "don't rewrite the agent loop".

**About 35 codebase features (~15%) are in TS but should be Rust.** They reduce to about 20 capabilities. Every one needs either pre-exec OS control or a long-lived process that is the only writer:
- Sandbox, exec and PTY.
- Walk, parse, watch and index.
- Broker commit, journal, leases and job supervision.
- Memory store.
- Socket authentication.

**About 24 features should use existing software instead of our own code.** Examples:
- OpenTUI 0.5 renderables.
- brush-parser.
- oxc-resolver.
- ast-grep lang packs.
- SCIP.
- The gitleaks ruleset.
- ipaddr parsing.
- @ai-sdk Responses.
- llama-server.
- Inspect AI / SWE-bench.
- StrykerJS / cargo-mutants.

**About 19 features are code that should be data.** Examples:
- Language, sensitive-path and secret tables.
- Tool, handoff and session JSON Schemas.
- Routing, validation and reviewer contracts in agent.yaml.
- The base2 gate as a statechart.

**The plan has the opposite problem in several places.** It authors languages it doesn't need:
- Go: eval fleet, gitleaks sidecar, OTel collector.
- Swift/Kotlin: mobile, accessibility.
- Kotlin/Lua/Elisp: editor clients.
- C#: UIAutomation.
- Elixir: swarms.
- A Python runtime sidecar.

Audit and web evidence show no Go, Swift, Kotlin, C#, Elixir or Zig authorship is needed. Python is only ever offline.

**The plan also contradicts itself.** Principle 4 and the task text for P2-T8, P5-T5, P8-T3, P8-T4, P9-T4, P7-T2/T4 and P10-T3/T5 still name languages or mechanisms that D31, D35, D36 and D38–D44 replace.

**Biggest missed opportunity: an OpenTUI upgrade from 0.2.2 to 0.5.x.**
- It deletes about 1,500 lines of hand-written code: the markdown renderer, the highlighter stub, text wrap, and the diff viewer.
- It delivers P1-T6, P1-T10, P7-T7 and D45 without writing Zig or Rust.

**Biggest unlock: the Rust multi-call native binary.**
- An `exec` role first, then a `daemon` role.
- Together they unblock about 20 planned features.

## 2. Portfolio

| Bucket | Codebase features (12 cb shards, ±3) | What goes here |
|---|---|---|
| KEEP TS | ~150 | Agent loop, SDK run/LLM/failover, ACP server, tool dispatch, policy *decisions*, orchestration, TUI composition, eval orchestration and judging, stream redaction, VS Code extension, mobile via Expo |
| MOVE → Rust (authored) | ~35 → ~20 capabilities | exec/sandbox/PTY/jobs, walker/parse/watch/index/tantivy, broker commit + journal + leases, memory store (rusqlite NOFOLLOW), socket peer-cred / Windows pipes, tokenizers, ort ML, wasmtime plugin host, a11y, voice |
| CONSUME | ~24 | OpenTUI 0.5 (Zig core), brush-parser, sh-syntax (interim), bwrap+seccomp / Seatbelt, oxc-parser/resolver, ast-grep lang-*, SCIP indexers, gitleaks rules, llama-server, fastembed/ort, whisper.cpp, git CLI (writes) + gix (reads), rg, Inspect AI / Multi-SWE-bench, StrykerJS / cargo-mutants / mutmut, DuckDB, OTel collector binary, Sigstore, existing ACP editor clients |
| DECLARATIVE / CODEGEN | ~19 | Language registry, sensitive paths, secret rules, CIDR blocklist, cap.v3 spec vectors, tool / handoff / session JSON Schemas, agent.yaml (router triggers, validation commands, reviewer contract, action allowlists), base2 gate statechart |
| Python (offline only) | 2 | scipy oracle fixtures, SWE-bench harness; later DSPy/GEPA, LoRA (MLX-LM), ONNX export |
| DELETE | ~8 (gap-misc) | openrouter-ai-sdk runtime fork, build-tools Nx executor, saxy.ts, partial-json-delta.ts, agents-graveyard (after moving 2 imports), dead PostHog code |
| Go / Zig / Swift / Kotlin / C# / Elixir | 0 | none justified |

Authored languages should be TS, Rust (one workspace and one binary), and Python only offline. Zig is used only through OpenTUI releases; we don't write it.

## 3. Per-feature verdicts

Sev is the highest severity any shard gave the feature.

### Shell policy and sandbox

| Feature | Today | Plan | Best | Unlocks now → next | Sev | Shards |
|---|---|---|---|---|---|---|
| Command parsing | 12+ hand-rolled lexers + regex in terminal-command-policy.ts / harness-enforcement.ts; segment-anchored bypasses (`cd x && git push`) | D32 tree-sitter-bash TS pre-check; D40 tree-sitter-bash in shim | Now: sh-syntax (mvdan/sh WASM) as single TS AST. Shim authority: **brush-parser** (tree-sitter-bash has open heredoc/redirect bugs) | Kills bypass class; node-anchored denials → exec-without-shell, per-command profiles | HIGH | gap-sdk-deep, cb-sdk-tools, plan-RC, plan-RD, web |
| OS sandbox | none; `bash -c` via child_process | D4 Landlock+seccomp primary; AppContainer on Windows | **bwrap + seccomp** primary on Linux, Landlock as an extra layer; Seatbelt on macOS; Windows uses a restricted token + dedicated user + ACL (Codex precedent), not AppContainer | Real enforcement tiers → sandboxed hooks, MCP servers, browser, eval containers | HIGH | cb-sdk-tools, plan-RD, web |
| Secret rules | 5 TS token shapes | D15/D31 gitleaks codegen, no Go runtime | Confirm: gitleaks.toml → TS + Rust codegen; binary only in CI | One rule authority for env strip, redaction, egress | HIGH | cb-common, plan-RD |
| MCP SSRF guard | hand IPv6 parsing, gaps | — | CONSUME ipaddr.js (TS) / ipnet (Rust) | Closes mapped / NAT64 / 6to4 gaps | MED | cb-common |
| Egress proxy + secret broker | — | P5-T3 Rust hyper | Rust **hudsucker**, CONNECT passthrough by default, placeholder tokens | Children never hold keys | MED | plan-RD |

### Process, PTY and jobs

| Feature | Today | Best | Unlocks | Sev | Shards |
|---|---|---|---|---|---|
| Terminal exec | run-terminal-command.ts:578 `bash -c`, no PTY, Windows kills only the direct child | Rust `exec` role: parse → confine → execve; portable-pty; **process-wrap** (not command-group) | terminal_session, kill-tree, limits | HIGH | cb-sdk-tools, web |
| Background jobs | TS supervisor, pid reuse risk | daemon role (pidfd, sysinfo) | Jobs survive TUI; attach/detach | MED | cb-sdk-tools, gap-sdk-deep |
| Bash mode | no PTY, dies with TUI | daemon PTY host | Persistent shells | MED | cb-cli-services |
| Subagent supervision | in-process | Bun process per subagent (D36); Bun Worker resourceLimits **not enforced** | Crash and limit containment | HIGH | cb-rt-loop, web |

### Filesystem, broker, journal and daemon

| Feature | Today | Plan | Best | Sev | Shards |
|---|---|---|---|---|---|
| Mutation broker | TS, TOCTOU-prone | stays TS (Principle 1) | **Split**: API / cap.v3 / receipts stay TS; commit primitive (dirfd, renameat2, locks) + receipt store move to daemon; TS path kept as a degraded tier | HIGH | cb-sdk-services, plan-RB |
| Run journal | bun:sqlite; `MAX(seq)` then INSERT, no txn | P2-T2 bun:sqlite | Now: BEGIN IMMEDIATE + synchronous=FULL at tool_call; later rusqlite in daemon | MED | cb-rt-util, plan-RB |
| Path leases | process-local Map | — | Daemon lease authority with fencing tokens | MED | cb-rt-util, plan-RB |
| Store engine | JSON + advisory lock | D14 bun:sqlite, then redb/rusqlite | Drop redb; rusqlite only; bundle modern SQLite (macOS system SQLite 3.43 has an FTS5 corruption bug) | MED | plan-RB, gap-cli-deep, web |
| Memory-v2 store | bun:sqlite, can't verify opened files | — | rusqlite NOFOLLOW + cap-std in daemon | HIGH | cb-cli-services |
| Socket listener | TS, token printed to stderr | P1-T2 TS | Daemon: peer_cred + Windows named pipes | MED | cb-sdk-core, plan-RA |
| Daemon timing | P6 | D1 Rust, P6 | **Split and reorder**: D1-min (store, leases, watcher, broker commit) right after the first crate; D1-full in P6 | HIGH | plan-RB, plan-RFG |

### Code intelligence

| Feature | Today | Best | Sev | Shards |
|---|---|---|---|---|
| File walking | TS walker, re-hashes everything | Rust `ignore` parallel walker | HIGH | cb-code-intel |
| Parsing | web-tree-sitter WASM + repair code | native tree-sitter + rayon in daemon (~3–4× faster, ~0.1 ms vs 20–70 ms language load) | HIGH | cb-code-intel, web |
| Watching | Bun recursive watcher, **disabled on Linux** | notify + debouncer in daemon | HIGH | cb-code-intel |
| Index orchestration | per-process | shared daemon index across lanes | HIGH | cb-code-intel |
| Import resolution | per-line regex, ~12 languages | CONSUME oxc-resolver (JS/TS) + SCIP; stack-graphs is archived | HIGH | cb-code-intel, plan-RC, web |
| Call graph / TIA | none | CONSUME SCIP (community-governed, maintenance mode) | MED | cb-code-intel, plan-RC |
| Search postings | TS BM25 | ranking stays in TS; postings in tantivy | MED | cb-code-intel |
| LSP multiplexer | — | D42: process boundary from day one; implement in TS, daemon optional | LOW | plan-RC |
| Semgrep | — | Opengrep engine; rules need our own curation (Semgrep rules are not OSI-licensed) | MED | plan-RC, web |

### Edits

| Feature | Best | Sev | Shards |
|---|---|---|---|
| Symbol location / rewrite_symbol | tree-sitter queries for comment/decorator attachment; ast-grep napi + lang-* packs (napi has JS languages only) | HIGH | cb-rt-edits, plan-RC, web |
| Import edits (~40 regexes) | tree-sitter/ast-grep queries; **missing from plan** | MED | cb-rt-edits, plan-RC |
| Syntax preflight | Bun.Transpiler for JS/TS; tree-sitter for Python/Go (P0-T5 marked DONE, but Python/Go still use heuristics) | HIGH | cb-rt-edits, plan-RC |
| Fuzzy match / diff ledger / CRLF-BOM / cap hashing | KEEP TS with algorithm fixes (bit-parallel Myers, ledger built from splices); D30 codec | MED | cb-rt-edits |
| Semantic diffs | GumTree 4 (moves, tree-sitter) over difftastic (unstable JSON, no moves) | LOW | web |

### Tokenization, compaction and ML

| Feature | Today | Plan | Best | Sev | Shards |
|---|---|---|---|---|---|
| Token counting | gpt-tokenizer + 1.35/1.1/1.0 fudge factors | D41 Rust tiktoken-rs + HF tokenizers | Exact only for OpenAI and open-weight models (HF tokenizers Rust; rust-gems `bpe` for linear worst case). **Claude/Gemini have no local tokenizer** → calibrate from provider-reported usage | MED | cb-rt-util, plan-RC, plan-RE, web |
| Compaction selection | TS extractive pruner | D28 Python sidecar vs D34 Rust ort | **D34 wins**: LLMLingua-2 ONNX via ort in the `infer` role; Python only exports | MED | cb-rt-util, plan-RE, web |
| Embeddings / rerank / NLI | JS cosine over JSON text | TS onnxruntime-node | fastembed-rs / ort in `infer`; sqlite-vec after SQLite is bundled | MED | gap-cli-deep, plan-RE |
| Local inference | — | D7 authored mistral.rs / llama-cpp-2 sidecar | **CONSUME llama-server** (GBNF / JSON-schema, per-slot KV save/restore, prebuilt binaries) under X-5; author only if an eval proves a need for KV forks | MED | plan-RE, web |
| Stats gate | TS, pseudo-replication | P8-T4 Python sidecar | TS gate + exact Wilcoxon + a checked-in scipy oracle; Python offline | MED | cb-evals-infra, plan-RE |
| Prompt evolution | — | DSPy Python | DSPy offline, **or Ax (TS, ships AxGEPA)**; evaluate Ax first | MED | web |
| LoRA | — | unsloth / TRL | MLX-LM on Apple Silicon, TRL on CUDA; offline | LOW | web |

### TUI

| Feature | Today | Best | Sev | Shards |
|---|---|---|---|---|
| OpenTUI version | pinned 0.2.2 | **Upgrade to 0.5.x**: Code / Markdown / Diff / TextTable renderables, worker TreeSitterClient, grapheme width. Deletes ~1.5k lines; 1–2 engineer-weeks over 3 staged steps | HIGH | gap-cli-deep, web |
| Markdown | remark re-parses the whole message every 100 ms | OpenTUI Markdown renderable (interim: block cache) | HIGH | cb-cli-tui, gap-cli-deep |
| Syntax highlighting | stub returning one span | OpenTUI TreeSitterClient; drop the shiki option | MED | cb-cli-tui, plan-RA |
| Wrap / width | two width models, code-point splitting | OpenTUI native width; Intl.Segmenter where needed | MED | cb-cli-tui |
| Images / clipboard | Kitty re-transmits each render; sync clipboard blocks up to 5 s | TS protocol fixes; async; arboard later | MED | cb-cli-tui |
| Tray / actionable notifications | — | P7-T5 napi in Bun is **not viable** (main thread, signed bundle) → daemon or Tauri | HIGH | plan-RA |

### Protocol and surfaces

| Feature | Plan | Best | Sev | Shards |
|---|---|---|---|---|
| ACP server | TS | KEEP; migrate off the deprecated AgentSideConnection to the fluent SDK 1.0 | LOW | web |
| VS Code | author extension | First get listed in the existing **ACP Client** extension (formulahendry); build our own only for Openbuff-specific UX | MED | web |
| JetBrains / Neovim / Emacs / Zed | author Kotlin / Lua / Elisp | Zero code; CI smoke test per client (D44 confirmed) | MED | plan-RA, web |
| Mobile approver | Swift + Kotlin, Rust/Go relay | Expo + react-native-libsodium (Noise on libsodium) + expo-secure-store; Rust relay (snow) (D43 confirmed) | MED | plan-RA, web |
| Generated SDKs | Python / Go | Official ACP Python/Java/Kotlin SDKs + JSON Schema codegen; Go only on request | MED | plan-RA |
| Tauri desktop | Tauri | KEEP; the "reuse React components" claim is false (OpenTUI isn't DOM) | MED | plan-RA |

### Agents and orchestration

| Feature | Today | Best | Sev | Shards |
|---|---|---|---|---|
| base2 gate | ~5.3k-line implicit `while(true)` in a 12.7k-line file (~72% orchestration, ~12% generated duplicate helpers, ~9% prompt, ~7% policy) | Explicit statechart (XState v5) run host-side, with TS guards | HIGH | gap-agents-deep, cb-agents, plan-RB |
| handleSteps serialization | toString() + new Function → 4 helper copies, ~1.5k generated lines | Bun.build bundle per agent; trusted = host module + journal replay; untrusted = quickjs-emscripten (no live snapshot exists → D35 confirmed) | HIGH | gap-agents-deep, plan-RFG, web |
| Router / validation commands / gate file classes / reviewer contract / browser policy | regex/prompt tables; skips .rb .php .swift .c .cpp .gd | Data in agent.yaml + language registry, enforced at runtime | MED | cb-agents |
| Plugins | — | wasmtime `plugin-host` role; jco in-process rejected for untrusted guests | HIGH | plan-RFG |
| Hooks in any language | — | exec + JSON stdio, gated on the shim tier | HIGH | plan-RFG |

### Contracts and common

Make these language-neutral, with CODEGEN to Rust and Python (cb-common, HIGH):
- Language registry.
- Sensitive paths.
- Tool schemas (commit the JSON Schema artifacts).
- Handoff and session contracts.
- cap.v3 spec and test vectors.

Also: split `common` so a lean contracts package carries no server-only dependencies.

### Evals and infra

- **Eval fleet (P8-T3).** Drop Go. Orchestrate in TS with a GitHub Actions matrix and podman or the shim. Evaluate Inspect AI as a harness to consume. Source: cb-evals-infra, plan-RE, web.
- **Mutation testing.** run-mutation-gate.ts has no engine behind it. Use StrykerJS through the community Bun runner (concurrency 1), plus cargo-mutants and mutmut.
- **Per-language strata.** Add language tags and consume Multi-SWE-bench / SWE-bench Multilingual (PHP and Ruby only in the latter).
- **Tooling.** Consume DuckDB (@duckdb/node-api) and hyperfine.
- **Versions and pinning.** Eval workflows pin Bun 1.3.5, but `engines` needs 1.3.11. GitHub Actions are not pinned.

### Dead or broken code (gap-misc)

- The openrouter fork runtime has no production callers. Delete it and keep only the types.
- The Nx infisical executor is unused. Delete it.
- `bun up/down/ps` call db scripts that don't exist.
- check-env-architecture scans the deleted `web/` directory.
- saxy.ts and partial-json-delta.ts are imported only by their own tests.
- agents-graveyard has 2 live imports from eval-task-generator.
- canvas and gif-encoder-2 are root dependencies used only by tmux-viewer.
- The example providers.json contains a real-looking GCP project id.

## 4. Unlock graph

```
X-1 contract artifacts + data-table codegen (S–M)
 ├─► Rust `exec` role (bash AST via brush-parser → bwrap/seccomp/Landlock | Seatbelt → execve)
 │     ├─► sandboxed hooks P9-T2, MCP sandbox/lockfile P5-T6, browser-in-shim P5-T7
 │     ├─► egress proxy/secret broker P5-T3, eval containers P8-T0/T3
 │     └─► microVM P10-T1, syscall provenance P10-T2
 └─► Rust `daemon` role, D1-min (rusqlite store + ignore walker + notify + leases/fencing + broker commit)
       ├─► live index + native parse + tantivy (P6-T6/T7), SCIP / call graph → TIA
       ├─► journal/leases single writer → lanes/best-of-N (P6-T2), swarms P10-T5
       ├─► jobd + PTY → terminal_session, persistent bash mode, TUI attach/detach P1-T3
       ├─► socket peer-cred + Windows pipes; memory store; tokenizer RPC; LSP mux (D42)
       └─► tray/notifications P7-T5, warm start P7-T8, one-binary distribution P10-T8
OpenTUI 0.5 upgrade ─► highlighting P1-T6, large-session rendering P1-T10, width (D45/P7-T7), diff renderer
Language registry (D29) ─► gate coverage for all languages, affected tests, hooks, LSP mux, eval strata
`infer` role (llama-server + ort + whisper.cpp) ─► local inference, local compaction, embeddings/rerank, voice
`plugin-host` role (wasmtime) + Sigstore lockfile ─► plugin marketplace
```

### Top 10 moves

Ranked by features unlocked × severity ÷ cost:

1. **Segment-anchored policy bypass fix plus a single AST authority** (sh-syntax), now, in TS.
2. **OpenTUI 0.5 upgrade.**
3. **Contract and data-table codegen** (X-1, D29, D31).
4. **Rust `exec` role** (brush-parser, bwrap+seccomp, Seatbelt).
5. **Daemon D1-min.**
6. **handleSteps bundling, plus the gate as a statechart.**
7. **oxc-resolver and ast-grep lang packs** for imports, symbols and import edits.
8. **Journal hardening:** seq inside the transaction, fsync at tool_call.
9. **`infer` role consuming llama-server and ort**, replacing the Python sidecar and the TS onnxruntime path.
10. **Delete dead code and fix broken scripts.**

## 5. Plan items to change

**Principle 4 and 3(e):** rewrite to the portfolio in §2. This requires a D-entry for any new authored language.

**Change these tasks:**

| Task | Change to |
|---|---|
| P2-T8 | Workers → processes (D36) |
| P5-T5 | Go sidecar → codegen (D31) |
| P8-T3 | Go → TS + containers |
| P8-T1 | Drop the authored Go collector; consume the binary |
| P8-T4 | Sidecar → offline |
| CQ-T1, P8-T9, P8-T10, P9-T7 | Python / onnxruntime-node → ort `infer` (D34) |
| P9-T4 | Remove heap snapshots (D35) |
| P7-T2 | Zero code |
| P7-T4 | Expo + Rust relay |
| P7-T5 | Tray moves to daemon or Tauri |
| P10-T3 | Rust-only a11y (objc2 / windows / atspi) |
| P10-T5 | Drop Elixir; ACP over ssh |
| P1-T6, P1-T10, P7-T7 | OpenTUI upgrade |

**Drop:**
- redb (P6-T6).
- Stream-XML and ANSI kernels (P10-T9).
- P10-T7, deferred.

**Reorder:**
- The TS AST pre-check and bypass fixes go into P0-S1.
- The `exec` role becomes the first Rust crate.
- D1-min runs in parallel with the shim, not after P6.
- P9-T2 hooks are gated on the shim tier.
- Split P9-T5b (Sigstore lockfile) out and share its format with P5-T6.

**Reopen:**
- P0-T5: Python/Go preflight still uses heuristics.
- P2-T1: determinism leaks remain (randomUUID, Date.now).

## 6. Revised decisions

D38–D46 are PROPOSED in SPEC.md. Verdicts and new entries D47+:

| ID | Verdict / new text |
|---|---|
| D38 | **Confirm, tightened.** Authored languages: TS; Rust (one workspace, one multi-call binary); Python offline only. New authored languages need a platform-mandate D-entry. |
| D39 | **Confirm.** Also evaluate Inspect AI as the harness. |
| D40 | **Amend.** Authority is brush-parser in the Rust `exec` role. The interim TS AST is sh-syntax (mvdan/sh WASM). tree-sitter-bash is advisory only. mvdan/sh also serves as a CI oracle. |
| D41 | **Amend.** Use Rust tokenizers / `bpe` where exact counts exist (OpenAI, open-weight). Calibrate Claude/Gemini from provider usage. Prefer prebuilt bindings. |
| D42 | **Confirm.** |
| D43 | **Confirm.** Expo + react-native-libsodium + expo-secure-store; Rust relay (snow). |
| D44 | **Confirm.** Also get listed in the existing VS Code ACP Client extension before authoring our own. |
| D45 | **Replace with D47.** |
| D46 | **Amend.** Use oxc-parser/resolver (watch the parseSync leak in long-lived processes). ruff is CLI/LSP only. biome only where the project already uses it. ast-grep lang-* packs. |
| D47 (new) | Upgrade OpenTUI to 0.5.x and use its Code/Markdown/Diff/TextTable renderables and native width. No authored Zig. |
| D48 (new) | Linux sandbox is bwrap + seccomp, with Landlock BestEffort layered on. macOS uses Seatbelt. Windows uses restricted token + dedicated user + ACL, not AppContainer. Amends D4. |
| D49 (new) | One Rust multi-call binary `openbuff-native` with roles exec, daemon, infer and plugin-host (a11y later), shipped alongside the Bun binary. |
| D50 (new) | Split the mutation broker: TS keeps API, capability and receipt policy; the daemon owns the commit primitive and the receipt/journal store. Amends Principle 1. |
| D51 (new) | Daemon D1-min (store, leases, watcher, broker commit) is scheduled right after the first Rust role, not in P6. Drop redb; rusqlite is the only store. |
| D52 (new) | Local inference consumes llama-server under X-5. Authored bindings only if an eval proves a need for KV forks. Amends D7. D28 is superseded by D34. |
| D53 (new) | handleSteps are bundled per agent. The base2 gate becomes a host-side statechart. |

## 7. Defects to fix now

These apply regardless of language:

- Regex approval classifiers are anchored to the whole command. `cd x && git push` and `true && sudo …` escape gating. Source: gap-sdk-deep. Found by reading code, not executed.
- `open-file.ts` substitutes an unquoted path into a `shell:true` editor command. Source: gap-cli-deep.
- The run-journal seq race (read MAX, then INSERT, with no transaction). Source: cb-rt-util.
- ripgrep: an existing binary is trusted without a hash check. OpenTUI tarballs are fetched without integrity checks. Sources: cb-cli-services, plan-RFG.
- The OAuth `state` parameter equals the PKCE verifier. Source: cb-cli-services.
- The APNG codec reuses the first frame's IHDR, so resized frames corrupt the output. Source: gap-sdk-deep.
- The scroll listener re-subscribes on every render. Chat state is written three times per turn, synchronously. Source: gap-cli-deep.
- `bun up` is broken, and check-env-architecture is a no-op. Source: gap-misc.

## 8. Coverage and confidence

**Covered subsystems** (checked manually against the inventory):
- sdk, packages (agent-runtime, code-map, indexer, internal, build-tools), cli, common, agents, .agents, evals, scripts, .github, rust.
- docs, test, agents-graveyard, openbuff.d.example, root config.
- Out of scope (config only): .claude, .commandcode, .vscode, .bin.

**Machine check not run.** The shards issued snapshot-bound structuralReceipts. The orchestrator never got the receipt objects back, so `evaluate_audit_coverage` did not run. Coverage was assessed by hand.

**Deep reads** (full file reads) in the gap pass:
- terminal-command-policy.ts, browser-logs.ts, background-jobs.ts, harness-enforcement.ts.
- base2.ts in full (12,729 lines).
- The previously unread sdk/tools and agents files.

**Still partial or unread:**
- context-pruner.ts lines 241–2453.
- About half of cli/src/state, init, hooks and components (listed in gap-cli-deep).
- Some scripts (init-worktree, sync-agent-config, tmux-viewer).
- About 40 vendored provider files, sampled only.
- Some memory-v2 internals.

None of these are likely to change a portfolio-level verdict. They could add LOW or MEDIUM per-feature rows.

**Verified vs. unverified.** Web-verified claims are listed in `findings/web-verification.md`. Still unverified:
- The OpenTUI 0.5 API surface against the repo's usage, including migration breakage.
- That the LLMLingua-2 ONNX export works unmodified.
- quickjs async generator overhead.
- wasmtime binary size.
- sigstore-js under Bun.
- objc2 ScreenCaptureKit coverage.
- The landlock multithreaded restrict_self behavior.
- The policy bypasses, which were found by reading code, not by running tests.

**Counts** are hand-classified, ±3 per bucket.
