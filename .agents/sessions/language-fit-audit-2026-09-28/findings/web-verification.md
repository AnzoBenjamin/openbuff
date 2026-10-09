# Web verification of claims (2026-09-28/29)

Five researcher-web agents checked the unverified claims made by the shards. Each verdict carries its source. This file is authoritative over any shard claim that contradicts it.

## Sandbox / OS
- Landlock ABI kernels: v4=6.7 (TCP), v5=6.10 (ioctl dev), v6=6.12 (abstract-unix/signal scoping), v7=6.15 (audit), v8=7.0, v9=7.1, v10=7.2 (UDP), v11 in 7.3-rc. The rust `landlock` 0.4.7 crate supports up to V9. (docs.kernel.org/userspace-api/landlock.html; docs.rs/landlock)
- Ubuntu 23.10+/24.04 AppArmor restricts unprivileged userns by default, which breaks bwrap/netns sandboxes unless a bwrap AppArmor profile is loaded (Codex issue #15057). TRUE.
- macOS sandbox-exec/SBPL is deprecated but still works on macOS 15/26. Both Codex and Claude Code use it. Nested Seatbelt sandboxes fail.
- **Codex CLI (Rust) Linux sandbox now uses bubblewrap + seccomp by default. Landlock-only mode is REJECTED for filesystem-restricted policies because it cannot isolate unix sockets.** Codex on Windows uses dedicated local users + restricted tokens + ACLs + firewall rules. OpenAI evaluated and rejected AppContainer. Claude Code uses TS @anthropic-ai/sandbox-runtime driving bwrap+socat (Linux) and Seatbelt (macOS), plus an optional seccomp helper, and has no native Windows sandbox. IMPLICATION: the plan's "Landlock+seccomp primary" design (D4/P5-T1) should be revisited. The industry has converged on bwrap (namespaces) + seccomp, with Landlock as an add-on layer. The plan also assumes AppContainer on Windows, but prior art (Codex) rejected it.
- Crates: landlock 0.4.7 (official), seccompiler 0.5 (rust-vmm, 0.x), cap-std 4.0.3 (active), portable-pty 0.9 (wezterm, infrequent releases), cgroups-rs 0.5.1 ("heavy development"). command-group is frozen; its successor is **process-wrap 10.0.1**. pidfd_open needs 5.3; openat2 RESOLVE_BENEATH needs 5.6.
- Unprivileged cgroup v2: only memory+pids are delegated by default. cpu/io need an admin drop-in.

## Parsers / code intelligence
- tree-sitter-bash: covers heredoc/arithmetic/procsubst on paper, but has many open fidelity bugs in 2025-26 (heredoc+`;`, heredoc prefix-close, `$(( ))` in heredoc, redirect attachment). No release since Dec 2025. **brush-parser (Rust)**: active (v0.4.0 May 2026), 2,500+ differential tests against real bash, used standalone by Zed and Vite+. mvdan/sh (Go): mature, v3.14.1. Usable from JS via the `sh-syntax` npm package (Go GOOS=js WASM, v0.7.0). conch-parser: archived. IMPLICATION: for the shim's authoritative parser (D40), prefer **brush-parser** over tree-sitter-bash. tree-sitter-bash stays acceptable for the advisory TS pre-check, where ERROR means deny.
- github/stack-graphs: ARCHIVED Sep 2025.
- SCIP: moved to community governance (scip-code org, Mar 2026). The indexers are maintained but in maintenance mode, with no new features planned from Sourcegraph.
- oxc-parser / oxc-resolver napi work under Bun in practice. Both are very actively maintained. oxc-parser has a known native arena leak of about 0.75MB per parseSync call (issue #24472).
- @ast-grep/napi works under Bun. Built-in languages are JS/TS/TSX/HTML/CSS only. Other languages come via the @ast-grep/lang-* packages and registerDynamicLanguage.
- Native tree-sitter vs WASM: about 2.7-3.8x parse throughput (one reproducible benchmark). Language load is 20-70ms for WASM vs 0.1ms native.
- difftastic JSON is unstable (requires DFT_UNSTABLE) and has no move detection. GumTree 4.0 (Sep 2026) is active, detects moves and has a tree-sitter generator, but it is Java/LGPL.
- Semgrep rules relicensed Dec 2024 (not OSI). Opengrep (LGPL fork) is active at v1.30 but ships no maintained ruleset.
- tree-sitter-wasms 0.1.13 ships NO highlights.scm and uses stale 0.20.x grammars. **OpenTUI now ships its own TreeSitterClient + Code/Markdown/Diff renderables with highlighting.**

## Tokenizers / ML
- HF tokenizers is Rust-native, with JS/Python as bindings. tokenizers.js is a separate pure-JS port. tiktoken-rs is mature but NOT linear on pathological input (quadratic runs). GitHub's rust-gems `bpe` crate is linear. gpt-tokenizer is a pure-TS tiktoken port with the same algorithm.
- Claude has NO local tokenizer (count_tokens API only). Opus 4.7+ uses a new tokenizer that produces about 30% more tokens. Gemini has only an experimental text-only LocalTokenizer in the Python SDK. IMPLICATION: exact local counts are possible only for OpenAI and open-weight models. Everything else must calibrate from provider-reported usage.
- LLMLingua-2 exports cleanly to ONNX (community INT8 builds are about 178MB). No mature Rust port exists. The ort-based path is viable.
- `ort` is at 2.0.0-rc.13 (pin exact versions; used in production by HF TEI). fastembed-rs 7.1 is mature. candle is a viable pure-Rust alternative.
- **llama-server (llama.cpp binary)** is the most mature option: GBNF/JSON-schema, per-slot KV save/restore, OpenAI/Anthropic APIs, and prebuilt binaries for all platforms. The llama-cpp-2 crate is raw bindings with no semver. mistral.rs is active (llguidance), but on-disk KV save is unverified.
- node-llama-cpp Bun segfault oven-sh/bun#27320 is still OPEN.
- DSPy GEPA is available. **Ax (@ax-llm/ax, TS) ships AxGEPA and is production-leaning.** This makes the TS optimizer path credible. dspy.ts is experimental.
- LoRA: MLX-LM is native on Apple Silicon. Unsloth on Mac works via Studio only. TRL is CUDA-focused.

## Protocol / surfaces / runtime
- ACP: official SDKs in TS, Rust, Python, Kotlin and **Java**. Rust + TS reached 1.0 (Jun 2026). v2 Draft published Jul 2026. The TS AgentSideConnection is deprecated in favour of fluent agent()/client(). Remote HTTP/WebSocket transport has an RFD (Active, Jul 2026), not yet standard.
- ACP clients confirmed: Zed, JetBrains AI Assistant 2026.2 (not under WSL), Neovim (CodeCompanion, avante, agentic.nvim), Emacs agent-shell, marimo, Qt Creator, Sublime, Visual Studio, Obsidian and more. **VS Code has a popular third-party "ACP Client" extension (formulahendry) with 11 agents preconfigured.** A first-party Openbuff VS Code extension may be unnecessary at first: just get listed in that extension.
- **OpenTUI** moved to anomalyco/opentui. Its core is Zig, and the latest release is **v0.5.12** (the repo pins 0.2.2). It exposes Code/Markdown/Diff/TextTable renderables, a worker-based TreeSitterClient, and grapheme-aware width (unicode/wcwidth). OpenCode uses it in production. IMPLICATION: upgrading OpenTUI replaces the planned highlighting, markdown, width and diff work (P1-T6, P1-T10, P7-T7, D45). No new language is needed.
- Tauri v2 mobile is usable but rough. react-native-libsodium works with Expo (needs a dev client). No mainstream RN Noise library exists; build Noise on libsodium. expo-secure-store is fine.
- Bun: bun:sqlite FTS5 works on Linux/Windows (static SQLite). **On macOS it uses the old system SQLite (3.43), which has an FTS5 corruption bug (bun#31247)**, and loadExtension needs setCustomSQLite. Bun.secrets exists but is experimental. napi-rs rates Bun support as "best effort". **Bun Worker resourceLimits are NOT enforced** (bun#31411), which confirms D36 (process supervision). `bun build --compile` can embed .node addons.
- @napi-rs/keyring v2.1 is active (Bun untested). arboard is maintained by 1Password but has had no release in over a year.
- cargo-dist 0.33 is active, pre-1.0.

## Evals / infra
- StrykerJS has NO native Bun runner, only the community @hughescr/stryker-bun-runner (concurrency 1). cargo-mutants 27.x and mutmut 3.8 are mature. go-mutesting is fragmented across forks.
- Multi-SWE-bench (7 langs, Python/Docker harness) and SWE-bench Multilingual (9 langs incl. PHP/Ruby) are both consumable.
- Inspect AI: .eval/.json logs with a JSON schema, and strong agent-eval support (sandboxing, Claude Code/Codex via Inspect SWE). A candidate to CONSUME for the eval fleet instead of authoring one.
- gix 0.88: read-side status/diff is mostly done. Write-side workflows (checkout/merge/rebase/push/apply, worktree move/repair) are missing. Keep the git CLI for writes.
- OTel Collector ships as standalone binaries (consume). The OTel JS SDK on Bun has no official support; manual tracing works.
- `duckdb` npm is deprecated; use @duckdb/node-api. Its Bun crash (#151) is fixed, but Bun support is not official.
- WASI 0.3 ratified Jun 2026. Wasmtime 46+ has async components by default. jco supports WASI 0.3 on Node; Bun is untested upstream.
- quickjs-emscripten supports generators/async in-guest and runs on Bun. **No live VM snapshot/resume** (issue #152). JS_WriteObject serializes values and bytecode, not heap state. This confirms D35 (journal replay) over D11.
- whisper.cpp 1.9.4 is active. whisper-rs moved to Codeberg and lags upstream.
