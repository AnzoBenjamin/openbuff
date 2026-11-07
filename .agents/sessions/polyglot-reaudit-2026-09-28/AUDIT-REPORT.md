# Audit Report — polyglot-reaudit-2026-09-28

Generated 2026-09-28. Synthesized from 21 shard finding files (≈383 raw findings, ≈45 of them confirmations).

> Scope note: the synthesizer sandbox allows reads only inside `findings/`, so `../SPEC.md` was **not read**. The three SPEC questions are taken from the lens tags: [POLY] does it work for every language, [LANG] does the plan use the best language/mechanism, [BEST] is current code best-in-language. Check section 1 against SPEC.md before relying on it.

Shard IDs: CM=w1-code-map, SLT=w1-sdk-language-tooling, EV=w1-evals, DOC=w1-docs, IDX=w1-indexer, EDT=w1-runtime-edits-preflight, AG=w1-agents-prompts, REG=w1-common-language-registry, SDK=w2-sdk-core, RT=w2-runtime-core, CLI=w2-cli, INF=w2-infra-internal-scripts, P12=w2-plan-p1-p2, P34=w2-plan-p3-p4, P56=w2-plan-p5-p6-rust, P710=w2-plan-p7-p10-x, CMP=w3-compaction, CC=w3-common-core, TH=w3-runtime-tool-handlers, CLR=w3-cli-remaining, SVC=w3-sdk-services.

## 1. Executive summary

- **[POLY] Does it work for every language? No.** The harness is JS/TS-first. There are 12 registry languages and 15 tree-sitter grammars. Everything else gets no profile, no symbols and no LSP, and **nothing reports that it is missing**. Gate, test and command logic in base2 is hardcoded to JS conventions and bun, so Ruby/PHP/Swift/C edits skip the final reviewer entirely (AG, REG, CM).
- **Edit safety is not language-neutral.** One CRITICAL (rewrite_symbol can delete to EOF in brace-free languages) and several HIGHs:
  - Indentation fallback drops the re-indented replacement.
  - CRLF files are rewritten as LF.
  - BOM hash mismatch.
  - Python/Go preflight rejects valid code.
  - Grammar-less files fail open (EDT, SDK).
- **Security has 17 HIGH findings, mostly shared-root.** Main themes: provider secrets leak to child processes, the read-only terminal profile runs build scripts, `run_terminal_command` is full-access for every agent, and the approval classifier is `^`-anchored. Also: ACP sessionId path traversal, browser `file://`, MCP SSRF via IPv6-mapped hosts, CRLF bypasses redaction, and eval secrets are exposed to untrusted runners (SDK, TH, SVC, CC, EV, INF).
- **[LANG] Does the plan use the best mechanism? Mostly yes.** About 60% of judged tasks are confirmed keep. The change-approach cluster is concentrated in a few areas:
  - Highlighting (P1-T6): use shiki.
  - Supervision (P2-T8): use processes, not Workers.
  - Resume (P9-T4): QuickJS heap snapshot is infeasible; use journal replay.
  - ML inference (CQ-T1/D28, P8-T9/T10): one Rust `ort` sidecar, with Python off the hot path.
  - Imports (P3-T5): oxc-resolver plus tree-sitter captures.
  - Sandbox details (P5-T1..T3): Landlock v5/v6 scopes, userns-less network fallback, toolchain homes.
  - Go toolchains (P5-T5, P8-T3): drop them.
  - redb (P6-T6): drop it.
- **[BEST] Is current code best in its language? Often not.** Recurring problems:
  - O(n²) hot paths: eviction re-tokenization, journal full-history per step, markdown re-parse, `join('')` per tool call, JVM import resolution O(imports×files), unbounded Levenshtein.
  - Ad-hoc locks without reclaim or fsync.
  - Eval statistics that pseudo-replicate repeats and ignore noise.
  - Monolith files: base2 12.7k lines, run.ts 2.9k, run-agent-step.ts 3.2k.
- **One root cause covers most [POLY] findings:** a closed registry that consumers bypass with private tables (≥11 shards). A second covers most security findings: regex-based shell and secret policies instead of one parsed or codegen'd authority. Fixing those two in `common/` resolves roughly 40% of findings.
- **Evaluation cannot currently detect polyglot regressions.** Task sets are TS-dominated, `languages` metadata is never consumed, the judge gold set is 4 TS cases, the mutation oracle is StrykerJS only, and CI has no non-TS job (EV, INF, P710).

### Polyglot capability tier (honest)

| Capability | Tier today | Evidence |
|---|---|---|
| Parsing/symbols | Partial: 15 grammars. Kotlin/Swift/GDScript queries are thin, and the global node-kind map is noisy. None for Scala/Lua/Elixir/Dart/Zig/Haskell/Bash/HCL/config formats | CM, REG |
| Imports/graph | Heuristic/weak: per-line regex in ~12 languages. Multi-line TS/Go/Rust/Python imports are missed, Rust workspaces are mis-resolved, and only a single root manifest is read | CM, IDX, P34 |
| Diagnostics | Partial: 6 structured parsers plus regex. Misses mypy, go build, GHC, dart, elixir, terraform. JSON is parsed after middle-truncation | SLT |
| Tests/build | JS-first: affected tests use JS naming only; hooks are root-manifest only and run whole-repo commands; base2 falls back to bun/gradlew; assurance is overstated | SLT, AG |
| Edits/preflight | Safe only for brace + grammar languages. Unsafe for brace-free/grammar-less languages, CRLF and BOM files | EDT, SDK |
| Highlighting | None: `highlightCode` is a stub for every language | CLI, P12 |
| Docs | TS-only: no language matrix, TS-only hook examples, and the inferred-hook safety claim is wrong | DOC, INF |
| Evals | TS-only signal: no per-language strata, TS mutation oracle, TS-only gold set and retention fixtures | EV, P710, CMP |

## 2. Top 15 highest-leverage fixes

| # | Sev | Lens | file:line | Fix | Shards |
|---|---|---|---|---|---|
| 1 | CRITICAL | POLY | packages/agent-runtime/src/tools/handlers/tool/rewrite-symbol.ts:104 (structural-read.ts:459) | Never mint a cap for a heuristic slice; fail closed when there is no AST match; stop the brace scan at a same-indent line | EDT |
| 2 | HIGH | POLY | packages/agent-runtime/src/process-str-replace.ts:2330 | Use `replaceContent` from the indentation fallback and enforce the uniqueness/allowMultiple gate on it | EDT |
| 3 | HIGH | POLY/BEST | sdk/src/change-file.ts:1342, process-edit-transaction.ts:1144, common/src/util/redact-secrets.ts:42 | One shared text codec (fatal + ignoreBOM, record BOM/EOL, re-emit) for every read/edit/redaction path | SDK, EDT, CC |
| 4 | HIGH | POLY | sdk/src/env.ts:69 | Strip every configured `apiKeyEnv` plus a codegen'd secret list from the child env; unify with outbound-filter and redaction | SDK, SVC, CC |
| 5 | HIGH | BEST | packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:42 | Derive `permission_profile` from agentTemplate/handoff; least-privilege by default | TH |
| 6 | HIGH | POLY | sdk/src/tools/terminal-command-policy.ts:1255 | Make the read-only profile an allowlist of inspection executables; deny build/run verbs for every ecosystem | SDK |
| 7 | HIGH | POLY | sdk/src/services/harness-enforcement.ts:171 | Parse the shell and classify every simple command (strip env/sudo/`-c`); move per-ecosystem verb tables into data | SVC |
| 8 | HIGH | BEST | sdk/src/services/acp/session-data.ts:354 | Validate sessionId (`^[A-Za-z0-9._-]{1,128}$`) and assert the path stays inside journalDir | SVC |
| 9 | HIGH | BEST | sdk/src/tools/browser-logs.ts:2130 | Allowlist http/https/about:blank and enforce it with CDP Fetch interception | SVC |
| 10 | HIGH | BEST | common/src/mcp/client.ts:470 | Parse IPv6 fully (mapped/compat/NAT64/6to4), strip the trailing dot, test through `new URL().hostname` | CC |
| 11 | HIGH | BEST | evals/buffbench/setup-test-repo.ts:191; .github/workflows/buffbench.yml:35; runners/claude.ts:49 | Tokenless origin, no token logging, allowlisted runner env, explicit secrets instead of `toJSON(secrets)`; land P8-T0 | EV, INF |
| 12 | HIGH | POLY | agents/base2/base2.ts (gate-helpers region: isReviewableGateFile, isCoverageEvidenceFile, inferPackageTestCommand) | Generate source/test/command tables from the registry profile; reviewer must run for all languages | AG |
| 13 | HIGH | POLY | sdk/src/tools/run-targeted-validation.ts:103 | Compute coverage per changed file; report `reduced` plus `uncoveredFiles` when any file has no hook | SLT |
| 14 | HIGH | POLY | packages/agent-runtime/src/util/preflight-syntax-validation.ts:85 | Route .py/.go through tree-sitter; gate on the error delta (pre vs post); disable near-match autocorrect when no grammar exists | EDT |
| 15 | HIGH | POLY | common/src/util/language-capabilities.ts:1; language-capability-manifest.ts:83 | Open the registry (generic tier + external catalogue overlay; open-string ids, registryRevision/contentHash); all consumers derive from it | REG, CM, IDX, SLT, AG |

## 3. Cross-cutting findings

- **A. Closed registry plus private per-consumer tables.**
  - Shards: REG, CM, IDX, SLT, AG, EDT, SVC, CLI, DOC, P34, P56.
  - Root cause: `SUPPORTED_LANGUAGE_IDS` is a closed enum. Code-map, indexer, audit-intelligence, harness-intelligence, file-change-hooks, base2, dependency-manager, the specialist router and getLanguageFamily each keep their own extension/manifest/test tables, and those tables drift.
  - Fix: one open registry with extensions/filenames/shebangs, grammar, manifests, testConventions, commands plus runner prefix, artifactDirs, toolchain homes, egress registries and credential files. Seed it from linguist/Helix. Every consumer derives from it, with parity tests.
- **B. JS-only ignore and build-dir lists.**
  - Shards: IDX (file-walker.ts:8, query.ts:63), P12/CLI (index-workspace-watcher.ts:13), SLT (harness-intelligence.ts:56; code-search.ts:25 over-excludes tracked `build/`), TH (read-subtree.ts:340), P12 (P2-T4 snapshots), P56 (P6-T2 lanes, P6-T6), SVC (review-bundle lockfiles), CLR.
  - Root cause: every walker hardcodes node_modules/dist and matches only the top-level segment.
  - Fix: a shared `isArtifactPath` built from .gitignore plus registry artifactDirs, gated on a sibling manifest and matched per segment.
- **C. Test and command conventions are JS/bun only.**
  - Shards: AG, SLT, IDX, EV (deterministic-signals.ts:78), CLI (/init), P34.
  - Fix: registry testConventions/commands, delivered to agents as a structured `languageProfile` on agentState rather than prompt prose (AG strings.ts).
- **D. Code-point vs grapheme vs UTF-16.**
  - Shards: CLI (text-layout.ts:26, diff padEnd, concept-index slice), CC (string.ts:34, stable-hash.ts:14, saxy fromCharCode), SDK (chunk decode in run-terminal-command.ts:653), RT/CMP/SDK (Latin-tuned token estimates), IDX (ASCII posting tokenizer), P710 (memory-v2 lexicalTokens), SVC (chunk ids strip non-ASCII).
  - Fix: a shared Unicode module providing Intl.Segmenter grapheme/word, code-point-safe truncation, a `\p{L}\p{N}` tokenizer, StringDecoder and a script-aware token estimate, with golden vectors.
- **E. UTF-8/BOM/CRLF/quoted paths.**
  - Shards: SDK, EDT, CC (redaction; content-hash lone CR/BOM), EDT (edit-blocks EB-SEC-2), SVC (porcelain without `-z`), RT (backslash paths in eviction), P710 (sidecar stderr).
  - Fix: one text codec (Top #3) and `git -z`/`core.quotePath=false` everywhere.
- **F. Env and secret handling fragmented.**
  - Shards: SDK (env.ts:69 denylist), SVC (outbound-filter.ts:30; operator-service has its own patterns), CC (5 token shapes), P56 (staged-path gate), REG (sensitive-paths .tfvars/.toml), EV/INF (tokens exposed in evals).
  - Fix: one gitleaks-TOML-codegen'd rule set plus configured apiKeyEnv values. Consumers: env strip, redaction, outbound filter, staged gate and logs.
- **G. Regex shell policy at the wrong layer.**
  - Shards: SDK (≥5 lexers), SVC (`^`-anchored classifier), TH (full-access everywhere), P34/P56 (P4-T8/P5-T1).
  - Fix: one AST classifier in TS now (tree-sitter-bash; ERROR node means deny), an allowlist for read-only, per-agent profiles, and OS enforcement later in the shim.
- **H. Honest capability reporting violated (principle 6).** Examples:
  - `truncated` conflates no-grammar with budget (CM parse.ts:290).
  - Targeted validation reports `full` (SLT).
  - Preflight returns `valid:true` when unavailable (EDT).
  - An empty affected-tests result reads as "none" (SLT).
  - Undo claims (P12 P2-T4).
  - Memory-skip fabricates listings and search results (TH).
  - Regex outline invents methods (EDT).
  - Fix: tier/confidence fields on every result, plus X-4 CapabilitiesMapV1 (P710).
- **I. TS-only tests, evals, CI and examples.**
  - Shards: EV, CMP, IDX (retrieval corpus), CM (fixtures), SLT, INF (ci.yml:117, dependabot, hooks.json), DOC, P710.
  - Fix: committed polyglot fixture repos, a mise-pinned CI job, per-language eval strata and promotion gates.
- **J. Python/ML runtimes on the hot path vs D2.**
  - Shards: CMP/P710 (CQ-T1/D28 LLMLingua in Python), P710 (P8-T9 transformers.js, P8-T10 onnxruntime-node, P8-T7 ONNX, P8-T2 duckdb napi, P9-T7).
  - Fix: one Rust `ort` sidecar (openbuff-ml, X-5 supervised). Python only trains and exports. Small models are scored in pure TS.
- **K. Nondeterminism bypassing Clock/IdGen.**
  - Shards: AG (base2 Date.now/Math.random), RT (tool-stream-parser.ts:217 and others; replay key built from a fresh uuid), CC (job-registry.ts:720 sweep), P12 (workflow-engine.ts:50, ACP ids).
  - Fix: an injected-deps lint rule and stable replay keys.
- **L. Ad-hoc locks and durability.**
  - Shards: SVC (task-memory lock never reclaimed; Atomics.wait busy-wait; no fsync), SDK (broker mkdir lock plus hard links; no Windows retry), CLI (run-state no fsync; /init linkSync), SVC (model-discovery cache), TH (write_todos in process.cwd()/.omx).
  - Fix: one durable-write plus lock primitive (fsync file and dir, pid-reclaim, link fallback, Windows retry), migrated later to P6-T5 leases.
- **M. process.cwd() instead of the run cwd.** SDK (provider-config.ts:1010), TH (write-todos.ts:76, find-files.ts:52). Fix: thread cwd through.
- **N. Hand-duplicated tool surfaces.**
  - Shards: TH (5 discovery-memory wrappers; ~13 forwarders), CC (JSON Schema is strict while the runtime is lenient; AgentState has no schema), P12/P710 (MCP/SDK codegen).
  - Fix: generate forwarders, MCP tools and SDK types from D17 schemas.

## 4. PLAN item verdict table

Disagreements are marked ⚠. Severity is the highest any shard assigned.

| Task | Verdict | Recommended language+mechanism | Key reason | Sev | Shard |
|---|---|---|---|---|---|
| P0-T5 (marked done) | change-approach (reopen) | TS; tree-sitter for .py/.go too; error-delta gate | Python/Go bypass tree-sitter and reject valid code | HIGH | EDT |
| P0-T8 | keep | TS; basedpyright gate, ruff applicability | Small parser gaps | LOW | P34, SLT |
| LI-11 (marked done) | change-approach (reopen) | TS; derive getLanguageFamily from a registry `dialects` field | The parallel table still exists | MED | REG |
| P1-T1 | keep | TS ACP SDK; `_openbuff.dev/*` namespace, agent() API, IdGen ids | Drift from the design | MED | P12 |
| P1-T2 | keep (change SSRF mechanism) | TS; dns.lookup + connect to vetted IP (undici lookup unreliable under Bun) | DNS-rebinding TOCTOU | MED | P12 |
| P1-T3 | keep | TS; add a `session/attach` + resumeToken design | Conflicts with connection-owned sessions | MED | P12 |
| P1-T4 | keep | TS MCP SDK; tools from D17 | — | LOW | P12, TH |
| P1-T5 | keep | TS; `run --json` = ndjson of ACP updates | Avoids a third schema | LOW | P12 |
| P1-T6 | change-approach | TS shiki (JS regex engine) primary; tree-sitter optional tier; fence alias normalizer | 15 grammars and no highlights.scm; highlighter is a stub | HIGH | P12, CLI, CM |
| P1-T7 | keep | TS escape sequences; async spawns; tmux passthrough | — | LOW | P12, CLR |
| P1-T9 | keep | TS reordering; no Rust launcher | Cost is sequencing | MED | P12, CLI |
| P1-T10 | keep | TS remark + block cache + virtualization | Currently O(n²) per message | HIGH | P12, CLI |
| P2-T1 | keep | TS; extend Clock to workflow-engine and runtime stragglers | Many bypasses remain | MED | P12, RT, AG |
| P2-T2 | keep (change batching) | bun:sqlite; in-memory seq, transactions, delta payloads, per-run files | llm_request stores the full history per step: O(n²) | HIGH | P12, RT |
| P2-T3 | keep | TS; bind replay to P2-T4 tree ids | Workspace is not replayed | MED | P12 |
| P2-T4 | change-approach | git plumbing + `add -A`, shadow repo, report uncovered ignored side-effects | Overstates undo for non-JS artifacts | HIGH | P12 |
| P2-T5 | keep | TS; intents in the journal; fsync ordering, per-OS atomic replace | Crash atomicity is under-specified | MED | P12, EDT |
| P2-T6 | keep | Hand-rolled data statechart; XState only after P9-T4 | — | LOW | P12 |
| P2-T7 | keep | Bun.serve; Host/Origin checks, token via fragment then cookie | DNS rebinding | LOW | P12 |
| P2-T8 | change-approach | Bun.spawn child processes + IPC + process groups | Workers cannot hard-kill or isolate | HIGH | P12, AG |
| P2-T9 | ⚠ disagreement | P12: adopt @parcel/watcher (prebuilt). CLI: per-dir non-recursive fs.watch with an fd cap is the right interim, napi is waste | Both agree the ignore set must be polyglot | HIGH | P12, CLI |
| P3-T1 | keep (change servers) | TS vscode-jsonrpc behind an LspHost interface (daemon later); basedpyright + ruff server, Roslyn LSP, jdtls `-data`, kotlin-lsp; add zls/metals/etc. | Server lifetime; stale servers; roster gaps | MED | P34, REG, SLT |
| P3-T2 | keep | TS thin tools; report `unavailable` tier | — | LOW | P34, TH |
| P3-T3 | keep (change primary) | LSP pull diagnostics + tier-0 tree-sitter error delta; drop tsc --watch/dmypy | Absolute validity blocks broken files | MED | P34, EDT, SLT |
| P3-T4 | keep | SCIP; TS reader interim, canonical reader in the Rust daemon; add scip-java (Kotlin/Scala) | stack-graphs archived | LOW | P34, IDX |
| P3-T5 | change-approach | oxc-resolver (napi) + tree-sitter import captures + ecosystem tools (go list, cargo metadata, venv sys.path) | ts.resolveModuleName is JS-only; regex misses multi-line | HIGH | CM, IDX, P34 |
| P3-T6 | keep | Key on CodeChunk.hash/stableChunkId | — | LOW | P34 |
| P3-T7 | change-approach | Runner-native tier 0 (jest --findRelatedTests, go list, nx affected…), per-language conventions, confidence labels, rank by precision | JS-only and unlabelled today | MED | SLT, P34 |
| P3-T8 | ⚠ disagreement | SLT: Gradle init script + BSP, no JVM helper. P34: Gradle Tooling API helper is correct. Both: tool-native JSON queries (cargo metadata, msbuild -getItem, CMake File API, swift describe, bazel/buck2/pants/nx/turbo) | — | MED | SLT, P34 |
| P3-T9 | keep | TS personalized PageRank on CSR; prune concept/import hub nodes | Current map is alphabetical | MED | IDX, P34 |
| P3-T10 | change-approach | tiktoken WASM / HF tokenizers napi; calibrate Claude/Gemini via provider count endpoints or usage EMA | Exact local tokenizers are impossible for closed models; BPE stalls | MED | P34, RT |
| P3-T11 | change-approach | Opengrep CLI (SARIF) default, semgrep detected; no sidecar | Semgrep rules licensing (unverified) | MED | P34, SLT |
| P4-T1 | change-approach | @ast-grep/napi + registerDynamicLanguage/lang-* pinned to the same grammar revisions (or ast-grep CLI); move_symbol via LSP/SCIP | Only web languages built in; WASM vs native skew | MED | CM, EDT, P34 |
| P4-T2 | keep | TS; versioned documentChanges, hash check, capability probe | Stale edits | LOW | EDT, P34 |
| P4-T3 | keep | TS; auto-apply machineApplicable/ruff-safe only; LSP quickfix | ruff applicability dropped | LOW | P34, SLT |
| P4-T4 | keep (extend) | Detected CLIs; add Go/Ruby/PHP/Swift/Elixir codemods; Comby tier | Coverage gaps | MED | P34, EDT |
| P4-T5 | change-approach | Moves from chunk hashes + git `--color-moved`; difftastic only for reformat detection | difftastic has no move detection and unstable JSON (unverified) | MED | P34 |
| P4-T6 | keep | git CLI for stage/commit; gix reads only | gix skips hooks/signing | LOW | P34 |
| P4-T7 | keep | jsdiff diffWordsWithSpace + Intl.Segmenter; drop imara-diff | — | LOW | P34, CLI |
| P4-T8 | ⚠ disagreement on shim parser | All agree: TS tree-sitter-bash pre-check, ERROR → deny, one AST walk. Authoritative shim parser: P34 says brush-parser; P56 says native tree-sitter-bash sharing .scm plus direct execve (brush divergence is an escape vector); CM says mvdan/sh if strict. mvdan/sh as CI oracle: P34, P56 | Five divergent lexers; no Windows/PowerShell tier | MED | P34, P56, CM, SDK |
| P5-T1 | change-approach | Rust `landlock` crate BestEffort to ABI v6 (unix/signal scopes, ioctl); network tiers Landlock TCP → seccomp → netns if userns; Windows restricted token + low IL + Job; toolchain-home roots from the registry | Escapes and breakage on hardened distros / non-JS toolchains | HIGH | P56 |
| P5-T2 | change-approach | Rust lib in openbuffd; systemd transient scope via zbus; pidfd via rustix | Unprivileged cgroups fail | MED | P56 |
| P5-T3 | change-approach | Rust hudsucker; CONNECT passthrough default; placeholder-token broker; per-ecosystem proxy/CA env and registry allowlist | Hand-rolled MITM; JVM/pip/cargo trust stores | HIGH | P56 |
| P5-T4 | keep (refine) | portable-pty + alacritty_terminal; pgrp/read-blocked detection; spawn via shim | vt100 thinner; PTY outside the sandbox | MED | P56 |
| P5-T5 | change-language | No Go runtime sidecar. P56: Rust regex+aho-corasick scanner on vendored gitleaks TOML. INF: gitleaks in CI/pre-push + TS codegen. TruffleHog is AGPL, user-installed only | Extra toolchain; ⚠ minor split on whether a runtime Rust scanner is needed | MED | P56, INF, CC |
| P5-T6 | keep (extend) | Lock entries {launcher, resolved, integrity} per ecosystem | uvx/docker/binary unverifiable | MED | P56 |
| P5-T7 | change-approach | Dedicated browser shim profile (nested userns allowed) + --proxy-server + CDP Fetch; URL scheme allowlist now | file:// exfil; Chrome sandbox conflict | HIGH | P56, SVC |
| P6-T1 | keep | TS X-1 v2 schemas; laneId in the D16 handshake | — | LOW | P56 |
| P6-T2 | change-approach | `git worktree add` + reflink-copy; gix reads only; per-ecosystem lane seeding (.venv recreate, CARGO_TARGET_DIR, bazel output_base) | gix gaps; non-relocatable build dirs | HIGH | P56 |
| P6-T3 | keep | git merge-tree --write-tree -z; probe git ≥2.38 | — | LOW | P56 |
| P6-T4 | keep | mergiraf external; zdiff3 fallback | — | LOW | P56 |
| P6-T5 | keep | Rust; jsonrpsee over UDS/named pipe; typify from D17; flock singleton; fencing tokens | Leases are per-process today | MED | P56, SVC |
| P6-T6 | change-approach | rusqlite on the P6-T6a schema (drop redb); tantivy with a code tokenizer; notify + age-sweep fallback; registry excludes | Avoids a second migration | MED | P56, IDX, CMP |
| P6-T6a | keep | bun:sqlite WAL; STRICT schema reusable by rusqlite; no FTS5 unicode61 ranking | — | LOW | IDX, P56 |
| P6-T7 | keep | Native tree-sitter + rayon; one grammar manifest for WASM and native | Version skew | LOW | CM, P56 |
| P6-T8 | keep | governor crate; failover stays in TS | — | LOW | P56 |
| P6-T9 | change-approach | pread + memchr on live files; mmap only for immutable artifacts | SIGBUS kills the daemon | MED | P56 |
| X-3b | keep (+BEST amendments) | edition 2024, resolver 3, rust-version, lints, cargo-deny, native-runner matrix, cargo-dist + attestations + codesign | MSRV incident; license policy unenforced | MED | P56, INF, DOC |
| X-4 | keep | Add CapabilitiesMapV1 embedding the manifest | Maps may diverge | LOW | P710 |
| X-5 | change-approach | TS vscode-jsonrpc or full JSON-RPC (string ids, notifications, reverse requests), `$/ping` liveness, artifact sha256 + Sigstore verify | Drops messages; no integrity | MED | P710, INF |
| P7-T1 | keep | TS ACP ClientSideConnection | — | LOW | P710 |
| P7-T2 | change-approach | Configs for existing ACP hosts + thin ext-method adapters | Four bespoke clients | MED | P710 |
| P7-T3 | keep (fix assumption) | Tauri 2; reuse P2-T7 DOM components, not OpenTUI; WebGL probe | TUI components are not DOM | MED | P710 |
| P7-T4 | change-language | Rust `snow` Noise via UniFFI; Rust relay; native Swift/Kotlin shells | Three crypto implementations | MED | P710 |
| P7-T5 | change-approach | napi arboard for clipboard; actionable notifications via the Tauri app; CLI OSC fallback | notify-rust actions are Linux-only (unverified) | MED | P710, CLR |
| P7-T6 | change-approach | Generate from D17 on official ACP SDKs; add Rust/Kotlin/C# | Python/Go only | HIGH | P710 |
| P7-T7 | change-approach ⚠ | Intl.Segmenter first (grapheme fix); nucleo napi keep. Image resize: P710 says @img/sharp prebuilt; CLI says the Rust napi image kernel is confirmed | Split on the image path | MED | P710, CLI |
| P7-T8 | keep | TS client + Rust daemon | — | LOW | P710 |
| P8-T0 | keep (land now; harden) | TS/YAML; rootless podman `--network none`, env allowlist; INF suggests gVisor/microVM + egress proxy | Open while runners leak secrets | HIGH | EV, P710, INF |
| P8-T1 | change-approach | OTLP-JSON NDJSON + DuckDB COPY to Parquet; OTel GenAI conventions | No JS Parquet writer / Go collector | MED | P710, EV |
| P8-T2 | ⚠ disagreement | P710: out-of-process duckdb CLI / duckdb-wasm (napi crash class). EV: @duckdb/node-api | — | MED | P710, EV |
| P8-T3 | change-approach | Extend the TS P8-T0 wrapper or reuse Inspect/SWE-bench harnesses; per-language mutators (mutmut, cargo-mutants, PIT, gremlins, Stryker.NET) | StrykerJS is TS-only; Go fleet redundant | HIGH | EV, P710, INF |
| P8-T4 | keep | Python/uv; statsmodels MixedLM, scipy exact Wilcoxon, krippendorff, choix, crowd-kit | — | LOW | P710, EV |
| P8-T4a | keep (implement) | TS exact/permutation Wilcoxon, BCa, SE-based flat band, Holm | Current stats unsound | HIGH | EV, P710 |
| P8-T5 | keep | TS | — | LOW | P710 |
| P8-T6 | keep | DSPy GEPA/MIPROv2; drop TextGrad; split by language | — | LOW | P710 |
| P8-T7 | change-approach | Pure TS scoring from exported coefficients/trees; bandits in TS | onnxruntime/VW too heavy | MED | P710 |
| P8-T8 | keep | bun:sqlite FTS5; setCustomSQLite on macOS for sqlite-vec | loadExtension disabled on macOS (unverified) | MED | P710 |
| P8-T9 | change-language | Shared Rust `ort` sidecar | Second ML runtime in-process | MED | P710 |
| P8-T10 | change-approach | Tier 0 ollama/llama-server; tier 1 fastembed-rs/ort sidecar; code-aware multilingual models, per-language MRR | onnxruntime-node under Bun | MED | P710 |
| P9-T1 / P9-T1a | keep | TS; JSON-Schema-first agent.yaml, YAML 1.2 safe | Declarative agents can load without code trust | MED | AG, SVC, P710 |
| P9-T2 | keep | stdio JSON-RPC 2.0 hooks with per-event schema | Under-specified | LOW | SVC, P710 |
| P9-T3 | keep | TS + ajv | — | LOW | P710 |
| P9-T4 | change-approach | QuickJS for untrusted only; first-party agents as trusted host modules; durable resume = journal replay (optional wasm-memory snapshot) | JS_WriteObject cannot checkpoint generators; host fs/crypto missing | HIGH | AG, P710 |
| P9-T5 | keep | wasmtime sidecar authoritative; jco trusted only; sigstore + minisign | jco has no limits | MED | P710 |
| P9-T6 | change-approach | llama-cpp-2 + llguidance primary, mistral.rs alternative; tier-0 external servers | Coverage, time-to-value | MED | P710 |
| P9-T7 | keep | Fix lang line (no in-process ONNX) | Contradicts D28 | LOW | P710 |
| P9-T8 | keep | unsloth/TRL, mlx-lm; GGUF LoRA conversion | — | LOW | P710 |
| P10-T1 | keep | Rust; libkrun primary | — | LOW | P710 |
| P10-T2 | keep (caveat) | aya/fanotify/ferrisetw; ES entitlement or report none; in-toto provenance | — | MED | P710 |
| P10-T3 | change-language | One Rust MCP server (objc2 AX, windows-rs UIA, atspi) | Three toolchains; accesskit is the wrong role | MED | P710 |
| P10-T4..T9 | keep | As planned (sherpa-onnx optional; yrs; bun --compile) | — | LOW | P710 |
| CQ-T1 / D28 | change-language | Rust `ort` sidecar for LLMLingua-2 ONNX; structure-aware/Drain compression first; mask code/paths; Python for training only | Python on the hot path; English prose model drops code | HIGH | P710, CMP |
| CQ-T3 (marked done) | change-approach (reopen) | Tokenizer contract: plain-text projection + trigram + code-identifier field; cached index; bm25 ordering | Escaped `\n` and whole-token mismatch give empty recall | HIGH | CMP |

## 5. Per-lens findings (de-duplicated; Top-15 and cross-cutting items referenced, not repeated)

### [POLY]

**Code-map / parsing**
- [HIGH] packages/code-map/src/languages.ts:60: only 15 grammars. Add pinned tree-sitter-wasms grammars and tags.scm (Bash, Lua, Scala, Elixir, Dart, HTML/CSS, config). (CM)
- [HIGH] packages/code-map/src/chunks.ts:340: per-line import regex misses multi-line/Go blocks/Rust use-trees. Use AST captures. (CM, P34)
- [MED] structure.ts:72: global DEFINITION_NODE_KINDS collides across grammars. Move to per-language tags queries. (CM)
- [MED] tree-sitter-kotlin/swift-tags.scm:6: navigation calls, properties and extensions are not captured. (CM)
- [MED] parse.ts:290: unsupported language is reported as `truncated`. Split the coverage fields. (CM)
- [MED] structure.ts:299: code-map extension tables drift from the registry. Add a parity test. (CM)
- [LOW] languages-m7.test.ts:24: no Kotlin/Swift/GDScript/TSX fixtures. (CM)

**Indexer**
- [HIGH] metadata-indexer.ts:1558: Rust `crate::`/`super::`/`mod` and grouped `use` are mis-resolved in workspaces. (IDX)
- [HIGH] metadata-indexer.ts:1038: no import extraction for Scala/Lua/Zig/Elixir/Haskell/Dart/Bash/Vue/Svelte/Terraform; Kotlin `as` dropped; Swift unresolved. (IDX)
- [MED] metadata-indexer.ts:1606: single root go.mod/tsconfig; no src-layout/go.work/include dirs. (IDX)
- [MED] metadata-indexer.ts:1164: manifest/CI discovery is GitHub-only and JS-leaning; duplicate helper in query.ts:1194. (IDX)
- [MED] retrieval-quality.test.ts:20: the golden corpus is this TS repo only. (IDX)
- [MED] semantic.ts: no per-language or non-English embedding eval. (P710)
- [LOW] query-data.ts:139: ASCII-only posting tokenizer that disagrees with the query tokenizer. (IDX)
- [LOW] query.ts:535: no test-path classifier; the depth penalty hurts Maven layouts. (IDX)

**Registry / profiles**
- [MED] language-profiles.ts:171: Gradle manifests suppressed; Kotlin has no manifests. (REG)
- [MED] language-capabilities.ts:300: missing extensions/manifests (.cu, .ipynb, go.work, .sln, .erb, .blade.php); multi-dot extensions rejected; C# rootMarkers empty. (REG, P34)
- [MED] agents/idioms/python.md:1: idioms are version-agnostic. Add a declared-version rule. (REG)
- [MED] language-capabilities.ts:480: jdtls has no `-data`; superseded kotlin/csharp servers; gdscript needs the editor. (REG, P34)
- [MED] engine-profiles.ts:250: engines are detected from generic dir names (Config/, Assets/, addons/). (REG)
- [MED] project-file-tree.ts:70: text assets (.svg, Unity YAML, .gltf) are hidden as binary. (REG)
- [LOW] language-profiles.ts:270: ambiguous aliases (`.net`, `rust`, `swift`) override repo detection. (REG)

**SDK language tooling**
- [MED] file-change-hooks.ts:72: root-only manifest probe; missing ecosystems (mix, dart, zig, sbt, terraform, shellcheck). (SLT)
- [MED] file-change-hooks.ts:320: Python hooks ignore uv/poetry/pipenv runners. (SLT)
- [MED] harness-intelligence.ts:366: affected tests are JS naming only, with no confidence field. (SLT, P34)
- [MED] harness-intelligence.ts:28: workspace discovery misses Gemfile/composer/CMake/godot; Cargo.lock looked up at the member dir. (SLT)
- [MED] audit-intelligence.ts:50: private extension/test tables. (SLT)
- [MED] language-diagnostics.ts:213: column-less, go build, GHC, Elixir, Dart and Terraform formats are not parsed. (SLT)
- [LOW] code-search.ts:25: `!**/build/**` hides tracked source. (SLT)
- [LOW] harness-intelligence.test.ts:87: no non-JS fixtures. (SLT)

**Runtime edits**
- [HIGH] process-str-replace.ts:2090: near-match autocorrect with no grammar relies only on bracket balance. Disable it; add JSON/YAML/TOML parsers. (EDT)
- [MED] process-structured-edit.ts:613: Python local/parenthesized imports and TS import-equals are mis-ranged. (EDT)
- [MED] structural-read.ts:76: only C-family comment extension (decorators/attributes orphaned); no qualified symbols. (EDT)
- [MED] common/src/tools/params/edit-blocks.ts:41: 7+ `=`/`<`/`>` at column 0 collides. Use variable-length fences. (EDT)
- [MED] read-outline.ts:97: JS regex fallback. Use universal-ctags or per-profile regexes. (EDT)
- [LOW] preflight-syntax-validation.ts:58: .mjs/.cjs/.mts/.cts/.pyi dispatch; JS-only symbol boost. (EDT)

**Runtime core / compaction**
- [HIGH] archive-recall-index.ts:75: JSON-escaped text glues `n` to line-leading tokens. (CMP)
- [HIGH] archive-recall-index.ts:278: FTS5 whole-token vs substring scanner; empty result reported as healthy. (CMP)
- [HIGH] agents/context-pruner.ts:2760: only `exit N` kept; failing test names dropped; VALIDATION_TOOLS unused. (CMP)
- [HIGH] simplify-tool-results.ts:8: head-only 2k excerpt loses the failure summary tail. (CMP)
- [MED] tool-result-eviction.ts:205: substring over JSON-escaped content misses backslash paths. (RT)
- [MED] spawn-agent-utils.ts: librarian cleanup hardcodes `/tmp`, leaking clones on macOS/Windows. (RT)
- [MED] token-counter.ts: Latin-tuned fudge factors; calibrate from provider usage. (RT, SDK)
- [MED] context-pruner.ts (CQ-T1): LLMLingua would drop code tokens. Mask code, paths and identifiers. (P710)
- [MED] archive-recall-index.test.ts: no non-JS runner output fixtures. (CMP)
- [LOW] spawn-agent-utils.ts: brief path regex rejects Makefile/go.mod at root. (RT)

**Agents**
- [MED] test-writer.ts:74: write globs cannot express `_test.go`, `test_*.py` or `spec/`; bun example. (AG)
- [MED] dependency-manager.ts: manifest cross-check incomplete; unbounded timeout; gradle report used as sync. (AG)
- [MED] base2.ts selectSpecialistReviewersInline: manifest regex misses requirements/csproj/mix/pubspec. (AG)
- [LOW] code-reviewer.ts: no per-language pitfall list; JS-isms. librarian.ts:90 has `*.ts` examples. (AG)

**SDK core / services / tools**
- [MED] sdk/src/tools/run-terminal-command.ts:653: per-chunk decode splits UTF-8. (SDK)
- [MED] get-change-review-bundle.ts:133: porcelain without `-z` mangles non-ASCII paths. (SVC)
- [MED] get-change-review-bundle.ts:36: no lockfile/generated awareness; unbounded buffering. (SVC)
- [MED] repository-identity.ts:36: git required; wrong root for submodules. (SVC)
- [MED] load-agents.ts:64: agents must be TS/JS (P9-T1). (SVC)
- [MED] memory-v2/coordinator.ts:413: chunk ids strip non-ASCII; selectorFacet lowercases paths. (SVC)
- [MED] bun-sqlite-memory-repository.ts: lexicalTokens discards non-ASCII. (P710)
- [MED] read-docs.ts:68: Context7 only; no ecosystem/version routing. (TH)
- [MED] read-subtree.ts:340: sequential scan; build dirs exhaust the 5000 cap. (TH)
- [MED] skill.ts:61: global skill shadows project skill. (TH)

**CLI**
- [HIGH] text-layout.ts:26: code-point wrapping (see D). (CLI)
- [HIGH] cli/src/utils/clipboard.ts:174: no Wayland/WSL; sync exec; Windows `clip` codepage. (CLR)
- [MED] markdown-renderer.tsx: no CJK/Thai word breaks or bidi isolation. (CLI)
- [MED] project-picker.ts:3: no manifest walk-up. (CLI)
- [MED] commands/init.ts:27: stack-agnostic stub; TS type files always written. (CLI)
- [MED] commands/image.ts:13: paths with spaces break. (CLR)
- [MED] use-path-tab-completion.ts:39: Windows paths/separators. (CLR)
- [LOW] index-workspace-watcher.ts:63: extensionless deletes become ambiguous. (CLI)
- [LOW] diff-viewer.tsx:492: padEnd by UTF-16. (CLI)
- [LOW] concept-index.ts:65: surrogate split. (CLI)
- [LOW] use-suggestion-engine.ts:413: lexical-only ranking. (CLR)
- [LOW] git.ts:8: git-only VCS. (CLR)

**Evals / infra / docs**
- [HIGH] evals/buffbench/eval-codebuff.json:4: TS task sets; Python sets have no deterministic checks. (EV)
- [HIGH] evals/buffbench/types.ts:42: `languages` is never consumed. Add per-language strata. (EV)
- [HIGH] .github/workflows/ci.yml:117: no polyglot CI job. (INF)
- [HIGH] docs/architecture.md:105: no user-facing languages matrix. (DOC)
- [MED] deterministic-signals.ts:78: non-TS compile commands get weaker caps. (EV)
- [MED] eval-idioms-v1.json:16: ref-name SHAs; mutating gofmt. (EV)
- [MED] judge-gold-set.json:5: 4 TS cases. (EV)
- [MED] openbuff.d.example/hooks.json:1: TS-only examples. (DOC, INF)
- [MED] .github/dependabot.yml:1: no cargo. (INF)
- [LOW] compaction-retention/scenario.test.ts:60: .ts-only fixtures. (EV)
- [LOW] scripts/harness-language-server.ts:14: not an LSP adapter. (INF)

### [LANG]
(Plan-level items are in section 4. Code-level [LANG] items:)
- [MED] sdk/src/tools/language-diagnostics.ts:86: replace hand-coded regexes with a data-driven problemMatcher registry; unknown severity should map to warning. (SLT)
- [MED] sdk/src/tools/file-change-hooks.ts:158: whole-repo commands; use the owning package/target. (SLT)
- [MED] packages/indexer/src/query.ts:444: substring+IDF. Use BM25F now; tantivy with a code tokenizer at P6-T6. (IDX)
- [MED] packages/indexer/src/repo-map.ts:62: alphabetical truncation; PPR over references/calls edges only. (IDX, P34)
- [MED] packages/agent-runtime/src/util/token-counter.ts: BPE kernel should be tiktoken WASM/native behind the TS facade. (RT, P34)
- [MED] sdk/src/tools/terminal-command-policy.ts:1: retire the regex lexers in favour of a parsed-argv policy (G). (SDK, P34)
- [MED] sdk/src/services/workspace-mutation-broker.ts:278: hard-link dependency. Add a fallback; OS atomic primitives via napi later. (SDK)
- [MED] common/src/util/stable-hash.ts:14: FNV over UTF-16 units is not reproducible cross-language. Freeze the contract or bump the version. (CC)
- [MED] common/src/util/content-hash.ts:68: cap.v3 key is process-random. Document TS-only verification or define a key handshake. (CC)
- [MED] common/src/tools/compile-tool-definitions.ts:28: artifacts are strict-shape while the runtime is lenient; `*/` unescaped. (CC)
- [MED] common/src/types/session-state.ts:380: no schema artifact; the hash regex has `/i`. (CC)
- [MED] tools/handlers/tool/get-affected-tests.ts:21: hand-copied forwarders; generate from D17. (TH)
- [MED] cli/src/utils/terminal-images.ts:17: detection misses WezTerm/Ghostty/foot; no tmux passthrough; kitty chunk keys wrong. (CLI)
- [MED] cli/src/chat.tsx: no virtualization (P1-T10). (CLI)
- [LOW] cli/src/components/tools/run-terminal-command.tsx:49: concatenated streams; head-only; add per-runner summarizers. (CLR)
- [LOW] cli/scripts/build-binary.ts:230: unescaped `--define`; tarball integrity unchecked. (CLI)
- [LOW] sdk/src/native/ripgrep.ts:150: `@codebuff/sdk` fallback path; keep rg external. (SDK)
- [LOW] packages/agent-runtime/src/util/stream-xml-parser.ts: keep in TS; widen fence regex. (RT)
- [LOW] docs: AGENTS.md:11 / CONTRIBUTING.md:83 omit the polyglot architecture and rust/; rust/README.md:9 does not list the existing crate. (DOC)

### [BEST]

**Runtime core / edits**
- [HIGH] tool-result-eviction.ts:336: two full re-tokenizations per iteration. Use per-candidate deltas and a WeakSet. (RT)
- [HIGH] run-agent-step.ts: journal stores the full history per step. Store deltas. (RT)
- [HIGH] process-str-replace.ts:1397: unbounded Levenshtein. Use banded/bit-parallel, length caps, top-K heap. (EDT)
- [MED] run-programmatic-step.ts: replay key is a fresh uuid. Key on (runId, step, index). (RT)
- [MED] tool-stream-parser.ts:217 and others: nondeterminism bypasses (K). (RT)
- [MED] stream-parser.ts:668: `join('')` per tool call. (RT)
- [MED] process-edit-transaction.ts:944: diffChars ledger. Record exact spans. (EDT)
- [MED] run-agent-step.ts / tool-executor.ts: >3k-line modules. (RT)
- [LOW] tool-executor.ts: floating onCostCalculated promise; ad-hoc gate-state casts. (RT)
- [LOW] tool-stream-parser.old.ts: dead file (re-flag). (RT)
- [LOW] background-agent-jobs.ts: per-chunk stringify. (RT)
- [LOW] line-coordinates.ts:147: confirmed fail-closed; rolling-hash option. (EDT)

**Compaction**
- [MED] archive-recall-index.ts:283: per-call rebuild without a transaction; bm25 discarded. (CMP)
- [MED] compaction-verification.ts:58: misses write_file path; false-flags long commands. (CMP)
- [MED] context-pruner.ts:708: estimate ignores tool parts; chars/3. (CMP)
- [MED] context-archive.ts:267: only tool messages are recallable; user/assistant messages unbounded. (CMP)
- [LOW] context-consolidation-runner.ts:123: fire-and-forget write. (CMP)
- [LOW] context-pruner.ts:2047: duplicated regex tables. (CMP)

**Agents**
- [HIGH] agents/base2/base2.ts: 12.7k-line monolith; repair handoff copy-pasted four times. (AG)
- [MED] base2.ts: Date.now/Math.random ids. (AG)
- [MED] base2.ts: system prompt duplication; repo-specific validation map shipped to all users. (AG)
- [MED] agents/editor/editor.ts:30: hardcoded model ids contradict BYOK; createReviewer ignores its model argument. (AG)
- [LOW] file-picker.ts: summary is the basename; duplicated helper. (AG)

**SDK**
- [HIGH] sdk/src/services/memory-v2/operator-service.ts:499: 10k cap below the 20k compaction threshold. (SVC)
- [HIGH] sdk/src/services/task-memory-store.ts:771: lock never reclaimed. (SVC)
- [MED] sdk/src/tools/file-change-hooks.ts:791: diagnostics parsed after truncation. (SLT)
- [MED] file-change-hooks.ts:761: same-project hooks run concurrently (dotnet/cargo lock collisions). (SLT)
- [MED] sdk/src/services/harness-intelligence.ts:315: 14 sync spawnSync probes, uncached. (SLT)
- [MED] harness-intelligence.ts:73: unbounded sync tree walk. (SLT)
- [MED] sdk/src/services/audit-intelligence.ts:135: snapshot hashes only the first 256KB. (SLT)
- [MED] sdk/src/tools/language-diagnostics.ts:1050: SARIF charOffset becomes a fake 1:1 fix range. (SLT)
- [MED] sdk/src/services/workspace-mutation-broker.ts:246: single lock, ~10 fsyncs per file, no pruning. (SDK)
- [MED] sdk/src/provider-config.ts:1010: uses process.cwd(). (SDK)
- [MED] sdk/src/impl/llm.ts:536: single 10-min timeout; no idle timeout. (SDK)
- [MED] sdk/src/services/local-harness-store.ts:226: Atomics.wait busy-wait; no fsync. (SVC)
- [MED] sdk/src/services/sidecar-supervisor.ts: drops notifications and string ids; no liveness check. (P710)
- [LOW] language-diagnostics.ts:425: go test regex keeps indentation. (SLT)
- [LOW] sdk/src/tools/3d-assets.ts:125: DAE branch is a no-op. (SLT)
- [LOW] sdk/src/run.ts:1: 40-branch dispatcher. (SDK)
- [LOW] sdk/src/model-discovery.ts:399: non-atomic cache write. (SVC)
- [LOW] sdk/src/impl/embeddings.ts: cacheKey omits dimensions. (P710)

**Runtime tool handlers**
- [HIGH] tools/handlers/tool/list-directory.ts:25: memory-skip fabricates a listing. (TH)
- [MED] code-search.ts:34 / glob / find_files_matching_content: memory-skip results not re-matched. (TH)
- [MED] query-index.ts:55: 5 duplicated memory wrappers. (TH)
- [MED] write-todos.ts:76: writes to cwd `.omx`; shared across sessions. (TH)
- [MED] find-files.ts:152: dead training LLM call. (TH)
- [LOW] web-search.ts:93: inconsistent error shapes. (TH)
- [LOW] tools/handlers/tool/__tests__: missing handler tests. (TH)

**Common**
- [HIGH] common/src/util/messages.ts:131: a media-before-json tool result is dropped with its call. (CC)
- [MED] common/src/util/content-hash.ts:70: scope path not NFC/case-normalized. (CC)
- [MED] common/src/util/saxy.ts:400: `_final` never calls back on unclosed tags; fromCharCode. (CC)
- [MED] common/src/util/partial-json-delta.ts:28: infinite loop on a leading comma; O(n²). (CC)
- [MED] common/src/util/job-registry.ts:720: sweep uses Date.now. (CC)
- [MED] common/src/tools/params/utils.ts:75: silent JSON repair; primitive-string re-decoding. (CC)
- [LOW] common/src/util/string.ts:34: surrogate splits; MIDDLE overflow; unescaped regex. (CC)
- [LOW] common/src/mcp/client.ts:620: connect race; locale sort. (CC)
- [LOW] common/src/env-schema.ts:26: PostHog host default. (CC)

**CLI**
- [HIGH] cli/src/utils/markdown-renderer.tsx: full re-parse per chunk (P1-T10). (CLI)
- [HIGH] cli/src/utils/index-workspace-watcher.ts:36: watcher disabled on Linux+Bun (P2-T9). (CLI)
- [MED] text-layout.ts:4: double measure per keystroke. (CLI)
- [MED] markdown-renderer.tsx: raw ``` counting breaks on ~~~ and 4+ fences. (CLI)
- [MED] markdown-renderer.tsx: per-character React nodes. (CLI)
- [MED] cli/src/utils/run-state-storage.ts:236: no fsync; unlink-then-rename; colliding temp names. (CLI)
- [MED] text-layout.ts: no grapheme/CJK/RTL/alias fixtures. (CLI)
- [LOW] commands/init.ts:70: linkSync without fallback. (CLI)
- [LOW] run-state-storage.ts:333: three separate files per save. (CLI)
- [LOW] concept-index.ts:236: per-entry prepare; no transaction. (CLI)
- [LOW] diff-viewer.tsx:318: unmemoized parse. (CLI)
- [LOW] path-completion.ts:51: stat per entry. (CLR)
- [LOW] use-clipboard.ts:13: duplicate formatter; createRequire. (CLR)

**Evals**
- [HIGH] evals/buffbench/run-buffbench.ts:829: repeats treated as independent tasks. (EV)
- [HIGH] evals/buffbench/compare-runs.ts:127: noise-blind classification; significance off by default. (EV)
- [MED] statistics.ts:196: normal-approximation Wilcoxon; percentile bootstrap. (EV)
- [MED] evals/subagents/test-repo-utils.ts:59: swallows init failure; shell interpolation. (EV)
- [MED] run-buffbench.ts:825: unpinned toolchains; seed is a no-op. (EV)
- [MED] judge.ts:384: only 2 of 3 judges run. (EV)

**Infra / docs / Rust**
- [MED] .github/workflows/ci.yml:29: Bun 1.3.5 vs pinned 1.3.11. (INF)
- [MED] .github/workflows/evals.yml:4: runs on every push; no concurrency or artifacts. (INF)
- [MED] packages/internal/package.json:43: vendored forks without provenance; usage overwrite bug (openai-compatible-chat-language-model.ts:630). (INF)
- [MED] rust/Cargo.toml: resolver 2 / edition 2021. (P56)
- [MED] .github/workflows/rust-workspace.yml: no deny/clippy/fmt/--locked; cross `cargo test`; no signing plan. (P56, INF)
- [MED] docs/testing.md:9: contradictory `bun --cwd` guidance. (DOC)
- [MED] WINDOWS.md:139: legacy env var; wrong PowerShell syntax. (DOC)
- [LOW] eslint.config.js:132: orphan plugin rules; mixed typescript-eslint versions (inferred). (INF)
- [LOW] rust/rust-toolchain.toml: 1.87 pin duplicated in CI. (P56)
- [LOW] .github/workflows/mirror-dot-agents.yml:14: dead workflow still triggers. (INF)
- [LOW] WINDOWS.md:5: removed hosted flows. docs/local-mode.md:21: OPENBUFF_LOCAL_MODE unclear. docs/configuration.md:508: no drift guard. (DOC)

## 6. Security findings

**HIGH**
- env.ts:69: provider keys leak to children (Top #4). (SDK)
- terminal-command-policy.ts:1255: read-only profile runs repo code (Top #6). (SDK)
- handlers/run-terminal-command.ts:42: full-access for every agent (Top #5). (TH)
- harness-enforcement.ts:171: `^`-anchored approvals bypass (Top #7). (SVC)
- acp/session-data.ts:354: path traversal (Top #8). (SVC)
- browser-logs.ts:2130: file:// and no egress (Top #9). (SVC)
- mcp/client.ts:470: SSRF bypass (Top #10). (CC)
- redact-secrets.ts:42: CRLF bypass. (CC)
- redact-secrets.ts:15: 5-shape corpus; `gh[o rus]_` typo; D15 codegen missing. (CC)
- setup-test-repo.ts:191: token in origin, prefix logged. (EV)
- runners/claude.ts:49 (and codex/opencode): full host env for unsandboxed runners. (EV)
- buffbench.yml:35: `toJSON(secrets)`; no permissions block. (INF)
- docs/configuration.md:512: docs claim package.json scripts are not executed; they are. (DOC)
- PLAN P5-T1: Landlock v5/v6 scopes missing. (P56)
- SPEC D4/P5-T1: netns fallback fails without userns. (P56)
- PLAN P5-T3: egress proxy/secret broker design. (P56)

**MEDIUM**
- terminal-command-policy.ts:23: publish/global-install not denied. (SDK)
- serve/outbound-filter.ts:30: redacts only 3 providers. (SVC)
- skills/load-skills.ts:238: project skills trusted by default; no size cap; symlink escape. (SVC)
- cli/src/utils/open-file.ts:47: raw path in `shell:true`; TTY editors spawned detached. (CLR)
- project-path-containment.ts:420: NTFS ADS / 8.3 names. (CC)
- sensitive-paths.ts:27: *.tfvars, credentials.toml, .vault-token, .p8. (REG)
- run-terminal-command.ts (staged gate): ecosystem credential files not blocked. (P56)
- test-repo-utils.ts:45: parentSha shell interpolation. (EV)
- rust-workspace.yml:18: no permissions/timeout; tag pins. (INF)
- Plan-level: P1-T2 SSRF pinning, P3-T11 licensing, P4-T8 parser soundness + Windows shell tier, P5-T1 D10 parse gate, P5-T1 AppContainer, P5-T7, X-3b signing/attestation, P7-T4 crypto, P9-T5, P10-T2. (P12, P34, P56, P710)

**LOW**
- PLAN P4-T8: tree-sitter-bash not shipped; hasError must deny. (CM)
- grammar-wasm-repair.ts:90: GDScript from a personal repo; runtime WASM not hash-verified. (CM)
- cli/src/pre-init/tree-sitter-wasm.ts:35: argv[0] wasm without hash. (CLI)
- cli/src/utils/skill-registry.ts:29: trust default mismatch. (CLR)
- messages.ts:690: unredacted history log. (CC)
- openbuff.d.example/providers.json:285: real GCP project id. (INF)
- P2-T7 dashboard Host/Origin. (P12)
- mirror-dot-agents.yml PAT URL. (INF)

## 7. Proposed SPEC/PLAN amendments (all PROPOSED)

- **D29 (PROPOSED) Open language registry as the single polyglot authority.**
  - Open-string ids with a generic tier.
  - Linguist/Helix snapshot overlay.
  - Fields: grammar, manifests, testConventions, commands + runner prefix, artifactDirs, toolchainHomes, egressRegistries, credentialFiles, dialects.
  - Manifest `registryRevision` + `contentHash`, tolerant reader.
  - Evidence: REG, CM, IDX, SLT, AG, P56, SVC.
- **D30 (PROPOSED) Shared text codec and Unicode module.**
  - BOM/EOL-preserving decode/encode.
  - Grapheme/word segmentation, code-point-safe truncation, Unicode tokenizer.
  - Frozen cross-language hash encodings.
  - Evidence: SDK, EDT, CC, CLI, IDX, P710.
- **D31 (PROPOSED) One secret-rule authority.**
  - gitleaks TOML codegen to TS/Rust, plus configured apiKeyEnv values.
  - Consumers: env strip, redaction, outbound filter, staged gate, log sanitizer.
  - No Go runtime sidecar; amends D15.
  - Evidence: SDK, CC, SVC, P56, INF.
- **D32 (PROPOSED) Parsed command policy now.**
  - TS tree-sitter-bash AST pre-check; ERROR means deny.
  - Allowlist read-only profile; per-agent profiles from templates.
  - Shim parser choice decided after resolving the P4-T8 disagreement.
  - Evidence: SDK, SVC, TH, P34, P56.
- **D33 (PROPOSED) Honest-tier result contract.**
  - Every capability-dependent result carries tier/confidence: validation per file, affected tests, preflight availability, undo coverage, memory provenance.
  - Expose via X-4 CapabilitiesMapV1.
  - Evidence: CM, SLT, EDT, TH, P12, P710.
- **D34 (PROPOSED) Single ML inference runtime.**
  - Rust `ort` sidecar for compaction, reranker, NLI and embeddings.
  - Python for train/export only; small routers scored in TS.
  - Amends D2/D28; affects CQ-T1, P8-T7/T9/T10, P9-T7.
  - Evidence: CMP, P710.
- **D35 (PROPOSED) Durable resume via deterministic journal replay.**
  - First-party agents run as trusted host modules; QuickJS only for untrusted agents.
  - Amends D11/P9-T4.
  - Evidence: AG, P710, RT.
- **D36 (PROPOSED) Process-based subagent supervision.** Amends P2-T8. Evidence: P12, AG.
- **D37 (PROPOSED) Polyglot verification gate.**
  - Committed fixture repos plus a mise-pinned CI job.
  - Eval language strata; promotion requires no per-language regression.
  - Per-language mutation tools.
  - Evidence: EV, INF, P710, IDX, CM.
- **New/changed tasks (PROPOSED):**
  - **P0-S1 security quick fixes:** ACP sessionId validation, browser scheme allowlist, MCP IPv6/trailing dot, CRLF redaction, dynamic env strip, eval token/env, buffbench secrets, docs hook-safety correction.
  - **P0-E1 edit safety:** rewrite_symbol fail-closed; indentation fallback uses replaceContent + uniqueness; CRLF/BOM in all transaction paths; no-grammar autocorrect off.
  - **Reopen** P0-T5, LI-11 and CQ-T3.
  - **New X-6** shared artifact/ignore helper.
  - **New X-7** shared durable-write/lock primitive.
  - **Change** P3-T5, P3-T7, P1-T6, P2-T4, P6-T2, P6-T6, P5-T1/T2/T3 as in section 4.
  - **Resolve before scheduling:** the P2-T9 watcher, P3-T8 Gradle, P4-T8 shim parser, P7-T7 image and P8-T2 DuckDB disagreements.
  - **Land** P8-T0 before any eval-driven promotion.

## 8. Coverage

| Shard | Scope (subsystems / features) | Files | Findings | Self-reported unverified / not read |
|---|---|---|---|---|
| CM w1-code-map | packages/code-map | 18 | 15 | Whether callers pre-filter unsupported extensions (parse.ts:290) |
| SLT w1-sdk-language-tooling | sdk language tooling, hooks, audit, 3d | 16 | 22 | — |
| EV w1-evals | evals buffbench/stats/isolation | 36 | 16 | Judge sampling params ("none visible") |
| DOC w1-docs | docs, root md, examples | 27 | 12 | Whether OPENBUFF_LOCAL_MODE is read |
| IDX w1-indexer | packages/indexer | 11 | 15 | CONFIG_EXTENSIONS call site (pom.xml classification) |
| EDT w1-runtime-edits-preflight | edit/preflight paths | 23 | 15 | — |
| AG w1-agents-prompts | agents, prompts, P9-T1/T4, P2-T8 | 17 | 17 | — |
| REG w1-common-language-registry | registry, profiles, idioms, sensitive paths | 22 | 15 | — |
| SDK w2-sdk-core | run, llm, broker, terminal policy, env | 16 | 12 | classifyTerminalHarnessAction coverage; token estimator body not read |
| RT w2-runtime-core | agent loop, executor, tokens, eviction | 13 | 16 | — |
| CLI w2-cli | cli rendering, watcher, startup, storage | 16 | 24 | Test file contents not read |
| INF w2-infra-internal-scripts | .github, internal, scripts, examples | 24 | 14 | ESLint plugin error inferred, not run |
| P12 w2-plan-p1-p2 | P1/P2 tasks | 16 | 18 | highlights.scm absence per grammar; Bun resourceLimits; undici under Bun (all inferred) |
| P34 w2-plan-p3-p4 | P3/P4 tasks | 13 | 23 | Windows spawn path not read |
| P56 w2-plan-p5-p6-rust | P5/P6, X-3b | 17 | 32 | — |
| P710 w2-plan-p7-p10-x | P7–P10, X-4/X-5, CQ-T1 | 11 | 48 | — |
| CMP w3-compaction | pruner, archive, recall | 13 | 14 | — |
| CC w3-common-core | common core utils | 17 | 18 | sensitive-paths temp coverage; logger redaction; PostHog client init |
| TH w3-runtime-tool-handlers | tool handlers | 28 | 12 | — |
| CLR w3-cli-remaining | cli commands/hooks/utils | 17 | 10 | Build-dir exclusion in the file-tree source |
| SVC w3-sdk-services | sdk services, ACP, browser, memory-v2 | 22 | 15 | — |

Total: ≈383 raw findings across 21 shards (all present and non-empty). After dedup (approximate): **CRITICAL 1, HIGH ≈58, MEDIUM ≈170, LOW ≈105** (LOW includes ≈45 confirmations).

**Claims made from domain knowledge without web verification.** No shard reports web research, so treat these as unverified until checked:
- Semgrep 2024-12 rules licensing; CodeQL CLI license.
- Built-in language set of @ast-grep/napi; tree-sitter-wasms@0.1.13 grammar list.
- difftastic has no move detection and its JSON is unstable.
- stack-graphs archived; conch-parser unmaintained; brush-parser fidelity.
- JetBrains kotlin-lsp and Elixir "Expert" status; basedpyright feature set.
- Landlock ABI v5/v6 kernel versions; Ubuntu ≥23.10 userns restriction.
- notify-rust action support per OS; Bun `loadExtension` on macOS; Bun Worker resourceLimits; undici dispatcher under Bun fetch.
- Blender 5.0 Collada removal; Go 1.24 `go build -json`; deprecated `duckdb` node package; gix worktree gaps.

**Needs follow-up.**
- Read SPEC.md and confirm the three questions and the D-numbering (D29+ assumes D28 is the last).
- Resolve the ⚠ disagreements in section 4.
- Verify the CM parse.ts caller filtering and the SDK harness-action classifier coverage before finalizing their severities.
