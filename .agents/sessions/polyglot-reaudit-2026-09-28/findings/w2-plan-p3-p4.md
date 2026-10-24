# Audit findings: w2-plan-p3-p4

- Subsystems: .agents, sdk, packages, cli
- Features: P3-T1, P3-T2, P3-T3, P3-T4, P3-T5, P3-T6, P3-T7, P3-T8, P3-T9, P3-T10, P3-T11, P4-T1, P4-T2, P4-T3, P4-T4, P4-T5, P4-T6, P4-T7, P4-T8
- Files covered: 13
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T1: TS vscode-jsonrpc multiplexer is right for now, but server-process ownership must be designed to move into the Rust openbuffd (D1)
- **Risk:** LSP traffic is JSON and I/O-bound, so TS in-process (mechanism a) costs nothing in speed. The loss is in lifetime. Servers owned by one CLI process die with it, and jdtls, rust-analyzer and Roslyn take 10–60s to warm up. They cannot be shared across sessions or lanes (P6-T2) or across TUI detach/reattach (P1-T3). If P3-T1 hard-codes process ownership into the TS core, P6-T5 pays for the boundary twice, which is exactly the PC-5 lesson D1 was written to avoid.
- **Fix:** Keep vscode-jsonrpc in TS for P3-T1, but put a transport-agnostic LspHost interface (spawn/route/didChange/request) between the agent tools and the servers. At P6-T5, run the host inside openbuffd as Rust using lsp-types plus async-lsp (client-side tower design, the same shape as Helix's helix-lsp and Zed's lsp crate). tower-lsp is server-only, so it is the wrong crate here. The TS core then becomes a client over the daemon socket, and servers stay warm per (language, root, laneId). Advertise it via X-4 as `lsp: in-process` vs `lsp: daemon`.
- **Evidence:** PLAN P3-T1 'lang TS (vscode-jsonrpc)'. D1 says the daemon owns the index and leases. P6-T5 'The TS IndexManager/lease APIs become clients'. The PC-5 rationale in SPEC D1 is 'A TS-first daemon would pay for the boundary twice'. P6-T2 lanes need a per-lane workspace root for each server.

## [MEDIUM] correctness — common/src/util/language-capabilities.ts:176 — [LANG] P3-T1: server choices should change: basedpyright over pyright, Roslyn LSP over csharp-ls, jdtls needs a per-root -data dir, JetBrains kotlin-lsp over fwcd
- **Risk:** pyright-langserver lacks the semantic tokens, inlay hints and extra diagnostics that basedpyright ships as a drop-in. csharp-ls is a single-maintainer server built on older Roslyn workspaces. Microsoft's Roslyn LSP (Microsoft.CodeAnalysis.LanguageServer, the one C# Dev Kit uses) is the reference server. jdtls is registered as argv ['jdtls'] with no `-data`, so two roots share one workspace dir and corrupt each other's index. The registry leaves C# rootMarkers empty (:335), so .sln/.csproj roots are never detected.
- **Fix:** Python: basedpyright-langserver --stdio first, pyright second, plus ruff server (`ruff server`) as a second co-attached server for lint and fix-its; the multiplexer must support N servers per language. C#: Roslyn LSP (download it from the NuGet feed as a checksum-verified sidecar, the way the Dev Kit does), with csharp-ls as fallback. Set rootMarkers to ['*.sln','*.slnx','*.csproj']. Java: pass `-data <stateDir>/jdtls/<sha(root)>` per root. Kotlin: JetBrains kotlin-lsp first (Gradle/Maven/JPS aware), fwcd kotlin-language-server as a deprecated fallback. Keep rust-analyzer, gopls, clangd (tiered on whether compile_commands.json exists), sourcekit-lsp, ruby-lsp and intelephense.
- **Evidence:** language-capabilities.ts:165 languageServer ['pyright','pylsp']. :176 argv ['pyright-langserver','--stdio']. :295 argv ['jdtls'] with no -data. :332 argv ['csharp-ls']. :335 rootMarkers: []. PLAN P3-T1 lists 'pyright/ruff … jdtls, csharp-ls'.

## [MEDIUM] correctness — common/src/util/language-capabilities.ts — [POLY] P3-T1: the LSP roster covers only the 13 registered languages; there is no honest tier for Zig, Elixir, Haskell, Lua, Scala, Dart, Terraform, shell or config formats
- **Risk:** The product claims to work on repos in any language. Outside the registry, the P3 tools (go_to_definition and the rest) silently fail or fall back to tree-sitter with no reported tier, which breaks SPEC principle 6. The config languages (YAML, JSON, TOML) appear in almost every repo and have mature schema-aware servers.
- **Fix:** Add registry entries: data-only entries for LSP-only languages, with no tree-sitter queries required. Zig: zls. Elixir: Expert (the official merger of ElixirLS, Lexical and Next LS), else elixir-ls. Haskell: haskell-language-server-wrapper. Lua: lua-language-server. Scala: metals. Dart/Flutter: `dart language-server`. Terraform: terraform-ls. Shell: bash-language-server (it wraps shellcheck). YAML: yaml-language-server with SchemaStore. JSON: vscode-json-language-server. TOML: taplo lsp. Also OCaml (ocamllsp) and Nix (nil/nixd). Report the per-language X-4 tier as `semantic: lsp|heuristic|none`.
- **Evidence:** PLAN P3-T1 ends its list with '…'. P4-T1 says 'all 13 grammars'. The registry only has entries for ts/py/rs/go/java/cs/c/ruby/php/swift (language-capabilities.ts:132-487).

## [LOW] test-coverage — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T2: confirmed
- **Risk:** None in the language choice. The agent tools are thin TS wrappers over P3-T1 requests.
- **Fix:** Keep TS. Each per-language fixture test should also assert the reported tier when the server is missing (tool returns `unavailable` plus the reason, never an empty success).
- **Evidence:** PLAN P3-T2 lang TS. The gate is tool-registration consistency plus per-language fixtures.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T3: confirmed TS; make LSP pull diagnostics the primary delta source and compiler daemons the fallback
- **Risk:** Running tsc --watch next to tsserver, or dmypy next to basedpyright, duplicates memory and can disagree with the LSP view the agent sees. Pull diagnostics give deterministic before/after snapshots.
- **Fix:** Primary: LSP 3.17 textDocument/diagnostic plus workspace/diagnostic (supported by basedpyright, rust-analyzer, gopls, Roslyn, clangd, tsserver via typescript-language-server). Use publishDiagnostics with a settle timeout where pull is unsupported. Fallback: cargo check --message-format=json, ruff check --output-format=json and similar, parsed by the existing P0-T8 parsers. Drop tsc --watch and dmypy from the default set.
- **Evidence:** PLAN P3-T3 'Optional incremental daemons: tsc --watch, cargo check JSON, ruff server, dmypy'. language-diagnostics.ts structuredDiagnosticParsers already cover cargo/ruff/pyright/eslint/go vet/SARIF.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T4: SCIP confirmed over LSIF, stack-graphs and Glean; languages without an indexer need a labelled tier
- **Risk:** LSIF is superseded and stack-graphs has been archived by GitHub. Glean needs a Haskell/C++ server plus Angle schemas, which is too heavy for a local-first CLI. SCIP has maintained indexers: scip-typescript, scip-python, rust-analyzer scip, scip-go, scip-java (Java/Scala/Kotlin), scip-clang, scip-dotnet, scip-ruby. Swift, PHP, GDScript, Elixir and others have no production SCIP indexer, so their edges stay heuristic.
- **Fix:** Keep a TS reader using @bufbuild/protobuf with the scip.proto schema. Run indexers as background jobs under X-5 with the heuristic tier labelled per file. Move storage and merging into the P6-T6 daemon index later. For languages without an indexer, allow an LSP-derived fallback (documentSymbol plus references batch crawl) labelled confidence:'lsp-derived'.
- **Evidence:** PLAN P3-T4 'scip-typescript/python/rust-analyzer/java/go/clang/dotnet/ruby … Tree-sitter edges stay as a fallback labeled heuristic'.

## [MEDIUM] correctness — packages/code-map/src/chunks.ts:343 — [LANG] P3-T5: use oxc-resolver (prebuilt napi) instead of ts.resolveModuleName, plus per-ecosystem resolvers; the current regex import extraction misses multi-line imports
- **Risk:** ts.resolveModuleName requires loading the whole typescript package and only models TS semantics. It ignores bundler aliases, Yarn PnP and some package.json exports/imports conditions. The current extractImportSites is a per-line regex, so `import {\n a,\n b\n} from 'x'` (the common prettier output) yields no specifier, and it also drops Python relative-import levels and Go import blocks `import (\n "a"\n)`.
- **Fix:** JS/TS: oxc-resolver (Rust, enhanced-resolve-compatible, handles tsconfig paths/references, exports/imports conditions and PnP). It is an existing prebuilt napi addon, so it is allowed under mechanism (d). Get import nodes from tree-sitter queries, not regex. Go: `go list -json -deps ./...`. Rust: `cargo metadata --format-version 1` plus the module tree from rust-analyzer/SCIP. Python: sys.path from the project interpreter (`<venv>/bin/python -c 'import sys,json;print(json.dumps(sys.path))'`) plus importlib.metadata/RECORD for installed distributions. JVM: classpath from the P3-T8 Gradle/Maven helper. C/C++: -I flags from compile_commands.json. C#: project references from MSBuild.
- **Evidence:** chunks.ts:343-470 extractImportSites is line-by-line regex (fromMatch requires `from` on the same line). Go only matches single-line `import "x"` (:409-412). PLAN P3-T5 names `ts.resolveModuleName`.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T6: confirmed
- **Risk:** None. hover/documentSymbol/inlayHint through the P3-T1 host, cached by content hash, matches the chunk hash contract already in chunks.ts.
- **Fix:** Key the cache on the existing CodeChunk.hash/stableChunkId rather than a separate hash scheme, so P6-T6a's frozen stableChunkId contract covers it.
- **Evidence:** chunks.ts CodeChunk.hash/stableChunkId. PLAN P3-T6.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:366 — [POLY] P3-T7: today's TIA conventions tier is JS-only; the coverage tier needs per-test contexts and should be ranked by precision, not cost
- **Risk:** Current candidates are only `<stem>.test.ext`, `<stem>.spec.ext` and `__tests__/`. That returns nothing for Python (test_*.py, tests/), Go (*_test.go), Rust (inline #[cfg(test)] and tests/), Java/Kotlin (src/test mirror *Test), C# (*.Tests projects), Ruby (spec/*_spec.rb) and PHP (tests/*Test.php). Per-file coverage without per-test attribution cannot say which tests to run.
- **Fix:** Conventions tier: move the per-language patterns into the registry (D16). Coverage tier with per-test attribution: coverage.py dynamic contexts (`--cov-context=test`, pytest-cov); JaCoCo per-test sessions (or the OpenClover per-test feature); Go `go test -coverprofile` per package plus `-run` bisection; llvm-cov per test binary with LLVM_PROFILE_FILE=%p; c8/istanbul per test file via NODE_V8_COVERAGE per worker. Bun coverage has no per-test mode, so label it per-file. Store maps keyed by commit and invalidate by the diff. Rank results coverage > build-graph > SCIP > conventions, each carrying its confidence.
- **Evidence:** harness-intelligence.ts:366-371 candidates list. PLAN P3-T7 orders 'conventions, then graph/SCIP, then build-tool, then coverage'.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:427 — [LANG] P3-T8: the build-graph list omits buck2, pants, turbo, Maven, SwiftPM and sbt; prefer tool-native JSON queries over helper programs where they exist
- **Risk:** Today every Cargo/Go/uv package gets the same hard-coded command list with no owning target. The planned list misses common monorepo tools, so those repos fall back to whole-workspace builds.
- **Fix:** Bazel: `bazel query 'rdeps(//..., set(<files>))' --output=label` (cquery for configured targets). buck2: `buck2 uquery owner(<file>)` / BXL. Pants: `pants --changed-since=HEAD list`/`peek`. nx: `nx show projects --affected --json`. turbo: `turbo ls --affected --output=json`. Cargo: `cargo metadata`. Go: `go list -json`. Gradle: the Tooling API helper in Kotlin/JVM (correct, since no CLI query exists). Maven: `mvn -q help:evaluate`/`dependency:tree -DoutputType=dot`. MSBuild: `dotnet msbuild -getProperty/-getItem` JSON (SDK 8+), which avoids a C# helper. CMake: File API reply JSON. SwiftPM: `swift package describe --type json`. sbt/mill: BSP (`bsp` over JSON-RPC, which also gives targets for Scala/Kotlin). Mark every target confirmed or inferred.
- **Evidence:** harness-intelligence.ts:427-435 hard-coded commands per manager. PLAN P3-T8 list: 'cargo metadata / go list / Gradle Tooling API / CMake File API / MSBuild / bazel / nx'.

## [LOW] performance — packages/indexer/src/repo-map.ts:69 — [LANG] P3-T9: confirmed TS personalized PageRank; move it with the graph into the daemon at P6-T5
- **Risk:** Personalized PageRank over about 100k nodes and 1M edges using CSR typed arrays takes tens of ms in TS, so petgraph adds nothing until the graph itself lives in Rust. The current repo map is a prototype that sorts alphabetically, takes the first 40 files, and is not wired into query_index.
- **Fix:** Store the graph in TS as Float64Array/Int32Array CSR with power iteration. Personalize on the edited files plus query hits. When P6-T6 owns the graph, rank in Rust (petgraph or hand CSR) next to the data rather than shipping the graph over the boundary.
- **Evidence:** repo-map.ts:69-71 sorts by path and slices to maxFiles. Its docblock says 'Prototype-only … not used by the default query_index path'.

## [MEDIUM] correctness — packages/agent-runtime/src/util/token-counter.ts:88 — [LANG] P3-T10: 'exact tokenizers' cannot be local for Claude or Gemini; use the official HF tokenizers napi addon and tiktoken WASM, and calibrate closed models via provider count endpoints
- **Risk:** Anthropic publishes no current tokenizer and Gemini's is not published for local use, so removing the 1.35/1.1 fudge factors is impossible locally for the two main hosted families. transformers.js pulls in an ONNX/runtime stack just to tokenize. Building a new tiktoken crate in X-3b duplicates maintained prebuilts. Separately, no-model callers such as countTokensForFiles silently get the Anthropic 1.35 factor.
- **Fix:** OpenAI families: `tiktoken` npm (the Rust core compiled to WASM, maintained) or js-tiktoken with o200k_base. Measure the >=5MB row first, since the Rust BPE core avoids gpt-tokenizer's long-run stall. Open-weight models: the official HuggingFace `tokenizers` Node binding (napi prebuilt, mechanism d) loading each model's tokenizer.json, cached with model discovery. Anthropic/Gemini: keep an estimator, but calibrate the per-session factor from the provider's count_tokens/countTokens endpoint (BYOK, the user's own provider, opt-in) and report `tokenizer: exact|calibrated|estimated` via X-4. No new X-3b crate is needed.
- **Evidence:** token-counter.ts:2 gpt-tokenizer gpt-4o. :88-90 fudge factors. :49 MAX_BPE_ENCODE_CHARS cap. :256 legacy 'anthropic/claude' sentinel for no-model callers. PLAN P3-T10 '(a) adopt an existing maintained prebuilt tiktoken napi … else (b) add tiktoken in the X-3b workspace', 'lang TS (transformers.js)'.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P3-T11: default to Opengrep (LGPL fork), with Semgrep CE as a detected alternative; the SARIF ingest already exists
- **Risk:** Semgrep's Dec-2024 licensing change restricts the maintained Semgrep rules (Semgrep Rules License) from use in products like Openbuff, and moved features out of CE. Opengrep restores intra-file taint, fingerprints and Windows support under LGPL-2.1. CodeQL's CLI license forbids use on private or closed repos without GHAS, so it can only be user-installed and detected, never defaulted.
- **Fix:** Invoke `opengrep scan --baseline-commit <sha> --sarif` (or `semgrep ci`-equivalent flags when only semgrep is installed) as a detected CLI. It is a one-shot process, not a JSON-RPC sidecar, so no X-5 supervision is needed. Use opengrep-rules or user-supplied rules and never bundle the Semgrep Registry rules. Add ast-grep YAML rules (P4-T1 engine) as the zero-install lint tier. Parse through the existing sarifParser and put the findings in get_change_review_bundle.
- **Evidence:** language-diagnostics.ts sarifParser already gates on /\bsemgrep\b/ and SARIF 2.1.0. PLAN P3-T11 'semgrep (OCaml) sidecar', 'CodeQL optional (license)'. get-change-review-bundle.ts has no findings source beyond LocalHarnessStore.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P4-T1: @ast-grep/napi only has HTML/JS/TS/TSX/CSS built in; 'all 13 grammars' needs registerDynamicLanguage plus lang packages, and move_symbol is not a structural operation
- **Risk:** Without per-language dynamic grammars, structural_replace silently fails for Python, Go, Rust, Java and the rest. GDScript has no @ast-grep/lang-* package. move_symbol needs reference updates across files, which only LSP or SCIP can supply. A purely syntactic move breaks importers.
- **Fix:** Use @ast-grep/napi with registerDynamicLanguage and the prebuilt @ast-grep/lang-{python,go,rust,java,c,cpp,csharp,kotlin,swift,ruby,php,…} packages. Build and ship a GDScript tree-sitter dylib from the vendored grammar, or report that language as unsupported. Alternatively shell out to the `ast-grep` CLI (`--json=stream`), which has about 25 languages built in, for the non-JS tier. Define move_symbol as an ast-grep extract plus insert followed by the P4-T2 LSP rename/update-imports (or SCIP references), labelled heuristic when no server exists.
- **Evidence:** PLAN P4-T1 '@ast-grep/napi structural_replace / move_symbol / parameter edits for all 13 grammars'. SPEC principle 3(d) allows existing prebuilt addons.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P4-T2: confirmed LSP WorkspaceEdit; needs a capability probe per server
- **Risk:** Support for rename, source.organizeImports and refactor.extract varies by server (bash-ls, lua-ls and yaml servers are weak), and resource operations (file rename/create) inside a WorkspaceEdit must go through the broker.
- **Fix:** Keep TS. Check prepareRename and the codeActionKinds the server advertises. Map documentChanges including RenameFile/CreateFile into one broker receipt. When a server lacks rename, fall back to an ast-grep identifier rename labelled heuristic.
- **Evidence:** PLAN P4-T2. P3-T1 → P4-T2 dependency.

## [LOW] correctness — sdk/src/tools/language-diagnostics.ts:45 — [LANG] P4-T3: confirmed TS; auto-apply only machineApplicable fixes and add LSP quickfix code actions as a second source
- **Risk:** The contract already warns that a missing applicability must not be auto-applied. ruff, eslint and SARIF fixes carry no applicability field.
- **Fix:** Auto-apply only cargo/rustc fixes graded machineApplicable, and ruff fixes whose `fix.applicability` is 'safe' (parse that field, which the ruff JSON parser currently drops). Present everything else for confirmation. Merge LSP codeAction kind quickfix with isPreferred as an equivalent source.
- **Evidence:** language-diagnostics.ts:42-48 applicability doc. The ruffJsonParser (:682-750) ignores fix.applicability.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P4-T4: the codemod list skips Go, Ruby, PHP, Swift and Elixir, and some adapters have mechanism caveats
- **Risk:** Repos in the missing ecosystems get no semantic codemods. OpenRewrite needs the Gradle/Maven plugin; its Moderne CLI is proprietary. rust-analyzer SSR is an LSP extension request (experimental/ssr), not a separate tool.
- **Fix:** Add: Go via gopls code actions, `gofmt -r` and gopatch/eg. Ruby via `rubocop -a` and Synvert. PHP via Rector. Swift via swift-syntax-based swift-format/SwiftRefactor. Elixir via Igniter/Sourceror. Kotlin via OpenRewrite. C# via `dotnet format` analyzers. Invoke OpenRewrite through the project's own rewrite-gradle/maven plugin (`rewrite:run`, with dryRun to get patches). Route rust-analyzer SSR through the P3-T1 host. Offer Comby as the language-agnostic tier. All run as detected CLIs, so no bundling.
- **Evidence:** PLAN P4-T4 'libCST (Python), OpenRewrite (JVM), jscodeshift/ts-morph, Roslyn fixers, clang-tidy fix-its, rust-analyzer SSR'.

## [MEDIUM] correctness — sdk/src/tools/get-change-review-bundle.ts:262 — [LANG] P4-T5: difftastic does not detect moves and its JSON output is explicitly unstable; detect moves from existing chunk hashes instead
- **Risk:** The ship criterion 'collapsing moves' cannot be met by difftastic: its docs state it does not detect moved code. `--display=json` requires DFT_UNSTABLE=yes and its schema can change without notice, which conflicts with SPEC principle 5 contract stability. GumTree does detect moves, but it is a JVM tool and a heavy dependency.
- **Fix:** Use difftastic only to suppress reformat-only changes (per-file 'no syntactic change' signal), pinned by version with a schema-guard test. Detect moves in TS from packages/code-map: a removed CodeChunk and an added CodeChunk with equal `hash` but a different path or qualifiedName is a move, and an equal stableChunkId with a different hash is an edit. Also use `git diff --color-moved=dimmed-zebra` or `--color-moved-ws=ignore-all-space` as the line-level move tier. Emit semantic_diff from those sources.
- **Evidence:** chunks.ts CodeChunk.hash and stableChunkId (sha256 of path+qualifiedName+kind). The get-change-review-bundle.ts value payload (:258-271) only has the raw diff. PLAN P4-T5 'difftastic JSON sidecar … collapsing moves and reformat-only changes'.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P4-T6: git CLI confirmed for stage and commit permanently; gix only for read paths in the daemon
- **Risk:** gix does not run hooks (pre-commit, commit-msg), GPG/SSH signing or credential helpers. Moving commit or stage to gix would silently bypass repo hooks and signing policy.
- **Fix:** stage_hunks: `git apply --cached --recount` with a generated patch. commit: git CLI. blame_context: `git blame --porcelain -w -C -M` now. Adopt gix-blame and in-memory merge-tree inside openbuffd (P6) only for read-heavy paths. Change the plan wording to 'gix for reads only'.
- **Evidence:** PLAN P4-T6 'lang TS (git CLI) → gix via X-3 later'. get-change-review-bundle.ts already shells out to git via runGit.

## [LOW] performance — cli/src/components/tools/diff-viewer.tsx:279 — [LANG] P4-T7: confirmed TS; use jsdiff diffWordsWithSpace (or git --word-diff=porcelain), not diff-match-patch; imara-diff napi is never justified here
- **Risk:** diff-match-patch's upstream is archived and it is character-level, which needs cleanup passes. Intra-line inputs are at most a few hundred chars, so a napi kernel cannot beat JS once napi call overhead is counted. Naive word splitting also breaks CJK text and emoji.
- **Fix:** Pair del/add rows with the existing pairSideBySideRows, then run jsdiff `diffWordsWithSpace` on each pair (tokenizing with Intl.Segmenter granularity:'word' so CJK works), with a length cap. When the diff comes from git, `git diff --word-diff=porcelain` is an alternative source. Remove the 'napi imara-diff' branch from the plan.
- **Evidence:** diff-viewer.tsx:279-313 pairSideBySideRows already pairs del/add runs. PLAN P4-T7 '(diff lib) → napi imara-diff only if X-2 shows the need'.

## [MEDIUM] security — sdk/src/tools/terminal-command-policy.ts:900 — [LANG] P4-T8: tree-sitter-bash is fine for the advisory pre-check but wrong for the D10 gate and the oracle; use brush-parser in the Rust shim and mvdan/sh `shfmt --to-json` as the test oracle
- **Risk:** tree-sitter-bash is error-tolerant: it produces ERROR nodes and accepts input bash rejects, and it diverges on heredoc and case edge cases. That makes it unsound as the authoritative parse. `bash -n` only checks syntax and produces no execution traces, so the planned differential test compares against a boolean. Meanwhile the file keeps at least five divergent lexers (tokenizeTmuxShellWords, splitReadOnlyShellSegments, scanActiveShellSyntax, extractSubstitutionsAndRemainder, quotedContentRanges, plus regex token matching).
- **Fix:** Pre-check (TS, P4-T8): tree-sitter-bash via the already-shipped web-tree-sitter, where any ERROR/MISSING node means deny with a node-anchored reason. Replace the five lexers with one AST walk. Oracle (dev/CI only): mvdan/sh `shfmt --to-json` (the most faithful bash/POSIX/mksh parser) run as a CLI over the adversarial corpus, comparing command/argv/redirect extraction. Use `bash -x` under an env-scrubbed sandbox for real trace comparison. Shim (P5-T1, Rust): brush-parser (bash-compatible, maintained) in-crate as the D10 authoritative parser. conch-parser is unmaintained and should not be used.
- **Evidence:** terminal-command-policy.ts: tokenizeTmuxShellWords (~:900), splitReadOnlyShellSegments, scanActiveShellSyntax, extractSubstitutionsAndRemainder, quotedContentRanges, and the regex `match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)` in findTraversalPath and findOutsideAbsolutePath. PLAN P4-T8 'differential tests … against real `bash -n` execution traces'. SPEC D10.

## [MEDIUM] security — sdk/src/tools/terminal-command-policy.ts — [POLY] P4-T8: the shell policy and planned AST are POSIX/bash-only, with no tier for PowerShell or cmd.exe on Windows
- **Risk:** D4 puts Windows third, but run_terminal_command already runs there. A bash-grammar pre-check will misparse PowerShell or cmd syntax and fail open or closed unpredictably, with no honest report.
- **Fix:** Report `shell-policy: posix-ast` vs `shell-policy: unsupported-shell (lexical)` via X-4. For PowerShell, use the PowerShell AST (`[System.Management.Automation.Language.Parser]::ParseInput`) through a pwsh helper, or tree-sitter-powershell for the pre-check. Until then, deny-by-default for non-POSIX shells in restricted profiles.
- **Evidence:** terminal-command-policy.ts is written entirely around POSIX quoting and operators (splitReadOnlyShellSegments, `$(`/backticks). There is only a win32 path special-case (isWindows) for temp roots. PLAN P4-T8 names tree-sitter-bash and mvdan/sh only. This is inferred from policy code; the Windows spawn path was not read.

## [LOW] correctness — sdk/src/tools/language-diagnostics.ts:755 — [BEST] P0-T8 parsers: pyrightJsonParser gate /\bpyright\b/ does not match basedpyright
- **Risk:** If P3 adopts basedpyright, `basedpyright --outputjson` output silently skips the structured parser: there is no word boundary between 'd' and 'p'. It falls to the regex pass and loses ranges and rule codes.
- **Fix:** Gate on /\b(?:based)?pyright\b/ and add a fixture for basedpyright JSON (same schema).
- **Evidence:** language-diagnostics.ts pyrightJsonParser `if (!/\bpyright\b/i.test(input.command)) return []`.

## Coverage receipt

### Subsystems
- .agents
- sdk
- packages
- cli

### Features
- P3-T1
- P3-T2
- P3-T3
- P3-T4
- P3-T5
- P3-T6
- P3-T7
- P3-T8
- P3-T9
- P3-T10
- P3-T11
- P4-T1
- P4-T2
- P4-T3
- P4-T4
- P4-T5
- P4-T6
- P4-T7
- P4-T8

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- packages/agent-runtime/src/util/token-counter.ts
- sdk/src/tools/language-diagnostics.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/tools/get-build-targets.ts
- packages/code-map/src/chunks.ts
- packages/indexer/src/repo-map.ts
- sdk/src/tools/get-change-review-bundle.ts
- sdk/src/tools/terminal-command-policy.ts
- cli/src/components/tools/diff-viewer.tsx
- common/src/util/language-capabilities.ts
- sdk/src/services/harness-intelligence.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
