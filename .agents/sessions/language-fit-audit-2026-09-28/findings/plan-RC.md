# Audit findings: plan-RC

- Subsystems: .agents
- Features: tree-sitter-preflight, lsp-multiplexer, navigation-tools, diagnostic-delta-gating, structured-diagnostics-fixits, scip-call-graph, import-resolution, type-enrichment, tia, build-graph, repo-map, compiler-daemons, semgrep-taint, exact-tokenizers, ast-grep-structural-rewrite, lsp-rename, compiler-fix-apply, codemods, semantic-review-diffs, blame-stage-commit, word-diffs, shell-ast-precheck, syntax-highlighting, import-edits, gate-file-classification, symbol-comment-attachment, D41, D42, D46
- Files covered: 9
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:38 — P0-T5 Tree-sitter preflight for all languages: CHANGE→tree-sitter for py/go now (TS WASM), native tree-sitter in Rust index (P6-T7) later
- **Risk:** The plan marks P0-T5 DONE for all 13 languages, but the codebase still runs hand-rolled Python-indentation and Go-brace heuristics instead of the tree-sitter ERROR check. Those heuristics produce false positives that block valid edits and false negatives that let broken files land. So two syntax oracles disagree on the same file: near-match uses tree-sitter and the preflight uses the heuristics. JS/TS preflight uses Bun.Transpiler and is skipped entirely under Node, which leaves SDK consumers unvalidated. The registry has 12 language ids while the plan says 13, so the count is unreconciled.
- **Fix:** Best choice: one preflight oracle. Route .py and .go through detectSyntaxErrorViaTreeSitter, fail-open when no grammar is available, and keep delimiter balance only as the no-grammar fallback. Keep Bun.Transpiler for JS/TS under Bun. Under Node, consume oxc-parser (Rust napi), which also returns precise error spans. Later, P6-T7 moves parsing to the tree-sitter crate with statically linked grammars plus rayon inside the Rust index service; WASM stays as the SDK fallback. Now: no false blocks on valid Python/Go, and every edit path (str_replace, edit_transaction, write_file, near-match) gives the same verdict. Later: incremental reparse with retained trees in the daemon, more grammars without shipping .wasm files, and removal of the runtime grammar-download repair path.
- **Evidence:** PLAN.md:38 claims DONE for 13 languages. cb-rt-edits 'Syntax preflight' finding cites preflight-syntax-validation.ts validatePythonSyntax and validateGoSyntax (heuristics) and validateJavaScriptLikeSyntax (Bun guard). language-capabilities.ts:1-14 lists 12 ids. cb-code-intel 'Tree-sitter WASM parse' covers the native move and the WASM repair burden (grammar-wasm-repair.ts, pre-init/tree-sitter-wasm.ts). Cost: 2-3 days for py/go, about 2 days for oxc-parser napi plus platform binaries, 2-3 weeks for the native tier at P6-T7. Confidence: high on the gap. Web claims (not verified this shard): native tree-sitter is commonly cited as 2-5x faster than WASM; oxc-parser napi works under Bun.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:51 — P0-T8 Structured diagnostics and fix-its: KEEP (TS parsers over each tool's JSON/SARIF); add LSP pull diagnostics for tsc
- **Risk:** The TS parsers over cargo NDJSON, ruff JSON, pyright --outputjson, eslint JSON, go vet -json and SARIF are the right mechanism. This is bounded parsing of tool-native output with nothing hot and no language gain from porting. One gap: tsc has no JSON mode, so TS diagnostics still come from text scraping unless they come from tsserver.
- **Fix:** Keep in TS. Feed the P3-T1 multiplexer's textDocument/diagnostic (pull) results through the same LanguageDiagnostic type so TS and Swift, which have no JSON CLI output, get structured ranges and code actions. Now: nothing more is needed. Later: P3-T3 delta gating and P4-T3 apply_compiler_fix consume one normalized diagnostic stream.
- **Evidence:** PLAN.md:51 (DONE, 31/31). cb-sdk-tools 'language-diagnostics.ts:70 KEEP' notes that tsc has no JSON and that an LSP client may be better. Cost: none now, S when P3-T1 lands. Confidence: high.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:99 — P3-T1 LSP multiplexer: CHANGE→TS vscode-jsonrpc in a detached supervised process (D42), registry ToolSpecs fixed first
- **Risk:** The TS implementation with vscode-jsonrpc is the right language choice: the heavy work runs in the ecosystem servers, and the multiplexer is plain JSON-RPC routing. The plan's in-process wording conflicts with D42, though. Warm servers that die with each CLI process never pay back their 5-60s cold starts, for example rust-analyzer or jdtls. The ToolSpec registry the task says will drive the multiplexer is incomplete: csharp has rootMarkers [] (it needs *.sln/*.csproj), kotlin has manifestNames [], gdscript has empty argv over TCP 6005 and needs a running Godot editor, java has no detect probe, and Python lists only pyright with no ruff server spec. Document sync through the mutation broker only works if the broker publishes change events across the process boundary.
- **Fix:** Best choice: a standalone TS process, 'openbuff-lsp', supervised by X-5 over JSON-RPC. It holds one server per (language, root), idle-evicts under an RSS budget, and receives didChange from broker receipt events. Fix the registry rows before starting: csharp rootMarkers to *.sln/*.csproj, kotlin manifests to build.gradle(.kts), a java detect probe, and a gdscript note that it is attach-only. Offer typescript-language-server now, with tsgo (the native TS 7 LSP) as a detected upgrade, and basedpyright/ty as detected Python alternatives. Now: go-to-definition, references, hover and diagnostics for 11 languages, with warm servers shared across lanes and sessions. Later: the process moves into openbuffd (P6-T5) unchanged, and P10-T7's embedded LSP server reuses the same client pool.
- **Evidence:** PLAN.md:99. language-capabilities.ts:325-331 (csharp rootMarkers []), :490-491 (kotlin manifestNames []), :570-576 (gdscript argv [] over tcp), :282-287 (java has no detect). cb-common 'Language capability registry' recommends codegen from the Helix languages.toml roots and language-servers. Cost: M-L (3-4 weeks for multiplexer, lifecycle and fixtures) plus S for the registry fixes. Confidence: high on the registry gaps, medium on the tsgo/ty maturity dates. Web claims (unverified): tsgo ships an LSP preview; ty (Astral) is in beta.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:100 — P3-T2 Navigation tools (definition/refs/hover/workspace_symbol): KEEP TS; add a tree-sitter/SCIP fallback tier with confidence labels
- **Risk:** These are thin TS tool handlers over the multiplexer, which is correct. The plan defines no behavior for when no server is installed, which is the common case for Ruby, PHP, Swift, Kotlin and GDScript users. Without a fallback, the tools either error out or silently return nothing, which violates D33 honest tiers.
- **Fix:** Keep in TS. Resolve in order: live LSP, then the SCIP index (P3-T4), then tree-sitter name matching labeled confidence:'heuristic'. Every response carries its tier in the result per D33. Now: the tools are useful in every language on day one. Later: SCIP answers find-references across the whole repo without a warm server.
- **Evidence:** PLAN.md:100. SPEC D33 (honest-tier result contract). cb-code-intel 'Call graph' notes the heuristic edges are bare-name matching. Cost: S on top of P3-T1. Confidence: high.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:101 — P3-T3 Diagnostic-delta gating + compiler daemons: KEEP TS gate; CHANGE daemons→LSP-hosted (tsserver/tsgo, rust-analyzer flycheck, ruff server, pyright watch) inside the D42 process
- **Risk:** TS is right for the delta gate, since it is policy that compares diagnostic sets keyed by rule, range and message. The separate daemon list (tsc --watch, cargo check JSON, ruff server, dmypy) duplicates what the LSP servers already do incrementally. It would mean a second process per language with its own lifecycle and memory. tsc --watch has no machine output, and dmypy is mypy-only while the registry defaults to pyright.
- **Fix:** Implement delta = new errors minus baseline diagnostics captured at read time, keyed by (file, code, message, relocated range), with fix-its offered from P0-T8 and LSP codeActions. Host the incremental checking in the P3-T1 servers: tsserver/tsgo, rust-analyzer flycheck (cargo check JSON), ruff server, and pyright or basedpyright in watch mode. Fall back to one-shot JSON CLIs when no server runs. Now: edits get rejected only for errors they introduce. Later: the same baseline cache feeds review bundles and TIA.
- **Evidence:** PLAN.md:101. language-capabilities.ts:140-171 (python typeChecker pyright/mypy). SPEC D42. Cost: M (2 weeks). Confidence: medium-high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:102 — P3-T4 SCIP call graph: KEEP TS reader now (@bufbuild/protobuf over scip.proto); CHANGE storage→Rust index service (scip crate) at P6
- **Risk:** Consuming SCIP indexers is the right mechanism: scip-typescript, scip-python, rust-analyzer scip, scip-java, scip-go, scip-clang, scip-dotnet and scip-ruby. Today's call graph is bare-name file-to-file matching, which drops edges for common names and adds wrong edges on collisions, so TIA and PageRank rest on bad data. The risks sit elsewhere. Indexers are heavy one-shot runs; scip-java needs a JVM and scip-python forks pyright. Merged edges are written into the whole-document JSON index, which multiplies an already O(index) rewrite. The plan names no maintenance-status check for each indexer.
- **Fix:** Now: a TS reader decodes index.scip into symbol-level def/ref edges keyed by file content hash and stored with confidence:'precise'. Heuristic edges stay as fallback. Run indexers only when detected, in the background, and invalidate per package. Later, at P6-T6/T7: ingest with the scip Rust crate in the index service, next to tantivy and redb, so edges are stored incrementally. Now: symbol-level 'who calls X', and the precondition for P3-T7 and P3-T9. Later: incremental re-indexing per changed package in the daemon.
- **Evidence:** PLAN.md:102. cb-code-intel 'Call graph: CONSUME SCIP' (metadata-indexer.ts:924-1003, unique-candidate rule :983-989) and 'Persistence' (index-store.ts:154-199 full rewrite). Cost: M in TS, M-L for running indexers. Confidence: medium. Web claims (unverified): current maintenance status of scip-ruby, scip-dotnet and scip-clang; scip crate API stability.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:103 — P3-T5 Real import resolution: CHANGE→oxc-resolver napi now (JS/TS), tree-sitter import nodes for extraction; per-ecosystem resolvers elsewhere
- **Risk:** The plan names ts.resolveModuleName. It is slow (it loads the TypeScript compiler, about 10MB), needs a CompilerHost, and does not implement bundler/package.json exports conditions the way enhanced-resolve does. The codebase has two divergent sets of regex import extractors (metadata-indexer.ts and chunks.ts), hand-rolled tsconfig paths, and a Go suffix fallback that is O(N) per import. D46 already proposes oxc-resolver for this.
- **Fix:** Now: consume oxc-resolver through its napi binding from TS. It gives enhanced-resolve semantics including tsconfig paths, exports/imports conditions and workspace symlinks. Extract imports from tree-sitter import nodes, one query per grammar, and delete both regex sets. For other languages, use go list for Go, cargo metadata for Rust, and precomputed path maps for Java/PHP/Python. Pyright's resolver via LSP or SCIP can serve as the precise tier. Later: the same oxc-resolver crate runs natively in the Rust index pass. Avoid stack-graphs (archived). Now: correct edges for monorepos and exports maps, and one source of truth. Later: import edits (see the missing-capability finding) and TIA reverse deps.
- **Evidence:** PLAN.md:103. cb-code-intel 'Import resolution' (metadata-indexer.ts:1025-1105, :1516-1624, Go O(N) at :1605-1621; chunks.ts:340-474). SPEC D46. Cost: S for oxc-resolver napi, 1 week for tree-sitter extraction. Confidence: high on the gaps. Web claims (unverified): oxc-resolver napi works on Bun; stack-graphs is archived.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:104 — P3-T6 Type enrichment: KEEP TS; source from SCIP hover docs first, LSP hover/inlayHint only for dirty files
- **Risk:** Calling LSP hover and inlayHint per symbol across a repo means thousands of round-trips and cold-server stalls. SCIP SymbolInformation already carries signatures and documentation in batch.
- **Fix:** Keep TS orchestration and cache by content hash in the index store. Use SCIP documentation and signature fields for bulk enrichment, and LSP hover only for files edited in this session. Now: typed repo-map and outline entries without warming every server. Later: move the cache into the daemon's redb store.
- **Evidence:** PLAN.md:104. cb-code-intel 'Symbol extraction' notes that the heuristic names are syntactic only. Cost: S-M. Confidence: medium.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:105 — P3-T7 Test impact analysis: KEEP TS orchestration; CONSUME native related-test queries per ecosystem
- **Risk:** The tiered design with confidence labels is right. The tier-1 'per-language conventions' do not exist in data form: gate test detection recognizes only TS/JS test patterns and ignores test_*.py, *_test.go and *_spec.rb, and validation-command inference is duplicated and hardcodes this monorepo's layout. The plan does not name the ecosystem tools that already compute related tests.
- **Fix:** Put testPatterns and a testCommand per language in the D29 registry, which also drives the gate predicates. Consume vitest related / jest --findRelatedTests, go list -deps -test, cargo metadata plus nextest, pytest-testmon, bazel query rdeps, and nx affected. Coverage-map tiers come from c8/istanbul per-test output and coverage.py contexts. Now: correct affected tests beyond TS. Later: SCIP reverse deps give symbol-level impact.
- **Evidence:** PLAN.md:105. cb-agents 'Gate file classification' (gate-paths.ts:101-105, TS/JS-only test patterns) and 'Validation command inference' (base2.ts:9694, editor.ts:1308). Cost: M. Confidence: high.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:106 — P3-T8 Build graph: KEEP TS shell-outs; CHANGE Gradle→init-script JSON (no authored Kotlin/Java helper)
- **Risk:** cargo metadata, go list -json, the CMake File API, the MSBuild -getProperty/-getItem JSON flags, bazel query and nx graph --file all emit JSON, so TS is right. The optional Kotlin/Java Gradle Tooling API helper adds an authored JVM toolchain, which D38 rejects, for data a Gradle init script can print as JSON.
- **Fix:** Drop the authored helper. Inject a Gradle init script that dumps projects, source sets and task dependencies as JSON. Now: owning-target builds for 7 build systems with no new authored language. Later: the build graph feeds P3-T7 tier 3 and lane-scoped validation.
- **Evidence:** PLAN.md:106. SPEC D38 (portfolio TS + Rust + Python). Cost: M. Confidence: medium-high. Web claim (unverified): MSBuild -getProperty JSON output requires .NET 8+.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:107 — P3-T9 Repo map (personalized PageRank): KEEP TS
- **Risk:** File-level PageRank over at most about 10k nodes takes milliseconds in TS. The current repo-map is a prototype off the default query path with alphabetical sorting. Ranking quality depends on P3-T4's precise edges, not on the implementation language.
- **Fix:** Keep TS. Seed personalization from the task's mentioned files and edited set, and run it after SCIP ingestion. Later: consume the daemon's symbol graph for symbol-level maps.
- **Evidence:** PLAN.md:107. cb-code-intel 'Repo map: KEEP' (repo-map.ts:57-75, 198-241). Cost: S. Confidence: high.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:108 — P3-T10 Exact tokenizers (D41): CHANGE→consume prebuilt Rust tokenizers (HF tokenizers napi, tiktoken WASM/napi) before writing X-3b code; D41 AMENDED
- **Risk:** D41 is right that HF tokenizers and tiktoken are Rust-native and that transformers.js is a port. It overstates two things. First, 'exact' is impossible for Anthropic and Gemini models because no public local tokenizer exists, so the 1.35/1.1 fudge factors cannot be removed for those families. Second, maintained prebuilt Rust-backed JS bindings already exist, so authoring an X-3b crate first is unnecessary portfolio cost.
- **Fix:** Amend D41. (a) OpenAI families: the tiktoken package (Rust compiled to WASM) or a napi tiktoken prebuilt; linear-time BPE removes the 5MB stall and the 100k-char cap. (b) Open-weight models: HF tokenizers through its napi binding, loading the model's tokenizer.json. (c) Anthropic/Gemini: use the provider count_tokens endpoints when budgets need to be exact, otherwise a calibrated estimate labeled tier 'estimated' per D33. Write tiktoken-rs/tokenizers into the X-3b workspace only when P9-T6 or the daemon needs them in-process. Now: exact budgets for OpenAI and open-weight models, and an honest tier for the rest. Later: the same crates inside openbuff-infer.
- **Evidence:** PLAN.md:108. SPEC D12, D41. Cost: S-M to consume prebuilts, M for an X-3b crate. Confidence: medium. Web claims (unverified): the tokenizers npm napi package is maintained and Bun-compatible; no official local Claude tokenizer exists for current models; Anthropic's messages count_tokens API is available.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:109 — P3-T11 Semgrep taint: CHANGE→opengrep binary as default engine (semgrep detected if user-installed); no bundled registry rules
- **Risk:** Orchestrating a user-installed binary from TS is right. Licensing has moved since the plan was written. Semgrep CE is LGPL-2.1, but the Semgrep Registry rules moved to a restrictive 'Semgrep Rules License' in late 2024, and cross-file/interfile taint is Pro-only. The fork Opengrep (LGPL) exists to keep the engine and rules open. Bundling registry rules could violate their terms, and intra-file taint on new code catches less than the plan implies. The plan's 'semgrep (OCaml) sidecar' label is an engine detail, not an authored language.
- **Fix:** Detect opengrep first, then semgrep, both user-installed and never bundled. Run --baseline-commit with SARIF output, ingested by the P0-T8 SARIF parser. Use only rule packs whose license allows redistribution, or user-configured rules. Label results as intra-file taint per D33. Now: new-code taint findings in get_change_review_bundle with no license exposure. Later: optional CodeQL when the user supplies a license.
- **Evidence:** PLAN.md:109. P0-T8 SARIF parser already exists (PLAN.md:51). Cost: S-M. Confidence: medium. Web claims (unverified, recalled): the Semgrep rules license change in December 2024, the Opengrep fork in January 2025, and interfile taint being a Pro-only feature.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:113 — P4-T1 Structural rewrites (ast-grep): CHANGE→@ast-grep/napi + @ast-grep/lang-* dynamic grammars (or sg CLI); later ast-grep-core in the Rust index
- **Risk:** ast-grep is the best consumable structural rewrite engine. However, @ast-grep/napi ships only a few built-in languages (JS/TS/TSX/HTML/CSS). The remaining grammars need the dynamic-language packages or the sg CLI, so '@ast-grep/napi for all 13 grammars' is not true out of the box. The same code path carries the symbol-location defect from the codebase findings: extendRangeToPrecedingComment understands only // and /* */. So rewrite_symbol and move_symbol drop or duplicate Python/Rust/Java/C# decorators, attributes and doc comments, and flat name matching collides on methods of different classes.
- **Fix:** Consume @ast-grep/napi with registerDynamicLanguage and @ast-grep/lang-{python,rust,go,java,...}, or shell out to the sg CLI, which bundles about 25 languages, where napi is missing on Bun. Use it for symbol location as well: find the declaration node including preceding comment, decorator and attribute siblings, with qualified Class.method names. Later: ast-grep-core in the Rust index service shares the native tree-sitter grammars from P6-T7, so there is one grammar set. Now: correct rewrite_symbol and move_symbol in every language, and the replacement for the ~40 import regexes (see the import-edits finding). Later: symbol-identity-keyed semantic diffs.
- **Evidence:** PLAN.md:113. cb-rt-edits 'Symbol location' (extendRangeToPrecedingComment regex, s.name === symbol) and 'rewrite_symbol + structured import edits'. Cost: 1-2 weeks plus binary distribution. Confidence: medium-high. Web claims (unverified): the @ast-grep/napi built-in language list, availability of the lang-* packages, and Bun napi compatibility.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:114 — P4-T2 LSP rename/extract/organize-imports: KEEP TS (WorkspaceEdit→single broker receipt)
- **Risk:** The mechanism is right. One gap: many servers return WorkspaceEdit documentChanges with resource operations (rename/create file) and change annotations that need confirmation. Organize-imports is unavailable wherever the registry's importOrganizer is empty (gdscript) or no server is running.
- **Fix:** Keep TS. Support documentChanges including RenameFile, and verify versions against the broker's content hashes before applying. Fall back to the ast-grep/tree-sitter import edits when there is no server. Now: one-call refactors as atomic receipts. Later: lane-scoped renames in P6.
- **Evidence:** PLAN.md:114. language-capabilities.ts:553 (gdscript importOrganizer []). Cost: M. Confidence: high.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:114 — MISSING import edits: CHANGE→tree-sitter/ast-grep import-node queries replace ~40 regexes in process-structured-edit.ts
- **Risk:** No task replaces the insert_import/remove_import regexes. There are about 40 per-language regexes, with known misses: multi-line parenthesized Python from-imports, Rust use {…} blocks, matches inside comments or strings, and Go single-line import merging. P4-T2 covers only LSP organize-imports, which is unavailable without a warm server.
- **Fix:** Add an explicit task. Locate import nodes (import_statement, import_from_statement, use_declaration, import_declaration, preproc_include, using_directive) through tree-sitter queries or ast-grep rules, and keep the insertion-offset policy (shebang, coding cookie, package line) in TS. Now: correct import edits in all languages without a server. Later: dedupe and sort import blocks structurally.
- **Evidence:** cb-rt-edits 'rewrite_symbol + structured import edits' (buildImportLineRegex, getImportRanges, insertIntoGoImportBlock). No PLAN line mentions process-structured-edit. Cost: 1-2 weeks, with existing tests as the oracle. Confidence: medium, because the gaps are inferred from the regex shapes.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:115 — P4-T3 apply_compiler_fix: KEEP TS
- **Risk:** This applies P0-T8 fix-its (rustc suggested_replacement with applicability, ruff fix.edits, eslint fixes) and LSP codeActions. It is pure TS text-edit application with no language gain from porting. The one risk is applying MaybeIncorrect or unsafe fixes automatically.
- **Fix:** Keep TS. Auto-apply only MachineApplicable or safe fixes and require confirmation for the rest. Apply through the broker as a single receipt. Now: one-call compiler fixes.
- **Evidence:** PLAN.md:115; PLAN.md:51 (applicability captured). Cost: S. Confidence: high.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:116 — P4-T4 Ecosystem codemods: CONSUME (detected user-installed CLIs only); cut ts-morph/jscodeshift in favour of ast-grep + LSP
- **Risk:** Consuming each ecosystem's own tool is right: libCST, OpenRewrite, Roslyn and clang-tidy -fix. Bundling them as sidecars would pull in Python, JVM and .NET runtimes, which contradicts D38. For JS/TS, jscodeshift and ts-morph duplicate what ast-grep plus tsserver refactors already cover. rust-analyzer SSR is reachable through the LSP (P3-T1), not a separate adapter.
- **Fix:** Treat adapters as detect-and-invoke CLI recipes in the D29 registry (a 'codemod' tool role), each producing full-content output routed through the broker. Drop the JS-specific adapters and route rust-analyzer SSR through the LSP. Now: zero new toolchains. Later: user-contributed recipes as data.
- **Evidence:** PLAN.md:116. SPEC D38, D29. Cost: S per adapter. Confidence: medium-high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:117 — P4-T5 Semantic review diffs: CHANGE→tree-sitter token-stream normalization (reformat-only) in TS now + difftastic optional display; gumtree-style move detection later in Rust
- **Risk:** difftastic is a good structural display diff (MIT, Rust), but it has two problems for this task. Its JSON output is explicitly unstable (it needs DFT_UNSTABLE), and it does not detect moved code, which is half of what the task promises ('collapsing moves'). GumTree detects moves but is JVM-based.
- **Fix:** Now: detect reformat-only changes by comparing tree-sitter token streams with whitespace and comments stripped, in TS over the existing grammars. Detect moves by matching symbol-level content hashes, since chunk ids already hash path, qualifiedName and kind. Invoke difftastic only as an optional user-installed renderer. Later: a GumTree-style AST matcher in the Rust index service over native trees. Now: review bundles collapse reformat and move noise with no new binary. Later: AST-aware 3-way merges shared with P6-T4.
- **Evidence:** PLAN.md:117. cb-rt-edits 'Diffing' recommends a difftastic/gumtree-style tree diff. cb-code-intel chunks.ts:148-162 deriveChunkId. Cost: M. Confidence: medium. Web claims (unverified): difftastic JSON is unstable; difftastic has no move detection.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:118 — P4-T6 blame_context/stage_hunks/commit: KEEP TS git CLI (porcelain v2 -z); gix only for read-heavy status in the daemon
- **Risk:** The git CLI is the most correct option for blame, apply --cached and commit. The existing porcelain parsing is not -z, so it breaks on quoted paths, and git-status buffers stdout without a bound. New blame and stage tools built on the same pattern would inherit both bugs.
- **Fix:** Use git blame --porcelain -w -C, git apply --cached for hunk staging, and status --porcelain=v2 -z with bounded buffers. Move status and dirty tracking to gix in P6-T5 later, and keep the CLI for writes. Now: blame-aware context with correct paths. Later: cheap per-command attribution.
- **Evidence:** PLAN.md:118. cb-sdk-tools 'git status' (run-terminal-command.ts:185-190 non -z parsing; git-status.ts:56-63 unbounded buffer). Cost: S-M. Confidence: high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:119 — P4-T7 Word diffs: KEEP TS (diff package diffWordsWithSpace); DROP the imara-diff napi option
- **Risk:** Intra-line word diffs run over short line pairs, which takes microseconds in JS. OpenTUI already depends on diff 9. A napi imara-diff would add a native artifact for no measurable gain.
- **Fix:** Keep TS with the existing diff dependency and tree-sitter colouring from P1-T6. Remove the napi fallback from the task. Now: word-level highlights.
- **Evidence:** PLAN.md:119. cb-cli-tui diff-view finding ('Native: reject'; OpenTUI depends on diff 9.0.0). Cost: S. Confidence: high.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:120 — P4-T8 Shell AST pre-check: CHANGE→same tree-sitter-bash grammar in TS (advisory, WASM) and Rust shim (authority, D40); reject mvdan/sh WASM
- **Risk:** The TS pre-check with tree-sitter-bash where ERROR means deny is fine as an advisory layer. Running the same grammar in the Rust shim gives one parse model on both sides. The mvdan/sh WASM alternative is Go compiled to WASM, which is multi-MB and adds a Go toolchain (D38/D39), and its GopherJS JS build is deprecated. The codebase has 3-5 independent hand-rolled bash lexers, so decisions can diverge from the bash -c that actually runs. Whether tree-sitter-bash is in the shipped 15-grammar wasm set is unverified.
- **Fix:** Vendor a tree-sitter-bash wasm grammar for the TS pre-check with node-anchored 'why denied' messages, and delete the duplicate tokenizers. Pull the D40 Rust shim parse gate forward using the tree-sitter-bash crate, with brush-parser as an evaluated alternative. It refuses unknown nodes and emits an argv plan for exec without a shell. Keep the bash -n differential corpus as a shared fixture for both. Now: one lexer and explainable denials. Later: per-segment landlock profiles and exec without bash -c.
- **Evidence:** PLAN.md:120. SPEC D10, D32, D40. cb-sdk-tools 'Shell command policy' (terminal-command-policy.ts:733, 925, 1086, 1071: separate scanners; run-terminal-command.ts:571-583 bash -c). Cost: M for TS, L (3-5 weeks) for the shim port. Confidence: high on the parser choice. Web claims (unverified): brush-parser and tree-sitter-bash coverage of heredocs and arithmetic; mvdan/sh WASM size.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:80 — MISSING-in-R-C syntax highlighting: CHANGE→OpenTUI/web-tree-sitter highlight queries (P1-T6), reject shiki
- **Risk:** highlightCode is a stub that returns a single span, so all code renders monochrome. P1-T6 still offers shiki as an option, which would add about 10MB of Oniguruma WASM plus grammars when tree-sitter grammars already ship next to the binary.
- **Fix:** Remove the shiki option. Use highlights.scm through the shipped web-tree-sitter grammars or OpenTUI's tree-sitter client, highlight completed fences only, and cache by content hash. Later: native tree-sitter-highlight in the P6-T7 tier. Now: coloured code blocks and diffs.
- **Evidence:** PLAN.md:80. cb-cli-tui 'Syntax highlighting' (syntax-highlighter.tsx:9-19 stub; build-binary.ts:256-278 ships grammars). Cost: M (about 1 week). Confidence: medium; whether highlights.scm exists for each grammar is unverified.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:28 — MISSING gate file classification: CHANGE→derive gate predicates from the D29 language registry
- **Risk:** The reviewer gate's isReviewableGateFile and isNonTestSourceFile regexes omit Ruby, PHP, Swift, C/C++ and GDScript, even though the registry and agents/idioms support them. Edits in those languages silently skip review, and no R-C or X-4 task names the gap.
- **Fix:** Generate the reviewable, source, test and security-sensitive predicates from registry rows (extensions, testPatterns), shipped as a runtime-provided lib instead of inline copies. Now: closes the review gap for 5+ languages. Later: adding a language means adding one data row.
- **Evidence:** PLAN.md:28 (X-4 registry). cb-agents 'Gate file classification' (gate-paths.ts:74-83, 101-105; base2.ts:9724-9738). language-capabilities.ts extensions for ruby/php/swift/cpp/gdscript. Cost: S (2-4 days). Confidence: high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:246 — D42 LSP multiplexer behind a process boundary: CONFIRM (TS first; Rust daemon move optional, not required)
- **Risk:** D42 is correct. Warm servers only pay back their cold start if they outlive a single CLI process and are shared across lanes, and a process boundary keeps the API stable. Note that moving the multiplexer into Rust gives little on its own, because the cost sits in the ecosystem servers. The payoff of the D1 daemon move is shared lifetime and lease ownership, not speed. Document sync then has to travel as broker receipt events over the protocol.
- **Fix:** Confirm, with an amendment: specify the multiplexer API as versioned JSON-RPC (X-1 golden vectors) with broker-event subscription. Run it as a detached TS process supervised by X-5 until openbuffd exists, and move it into the daemon only if the daemon owns process supervision anyway.
- **Evidence:** SPEC D42; PLAN.md:99, P6-T5. cb-code-intel 'Index orchestration' (per-process singletons multiply memory per lane). Cost: included in P3-T1. Confidence: high.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/SPEC.md:247 — D46 Rust-native ecosystem tools (oxc, ruff, biome): CONFIRM oxc-resolver/oxc-parser; AMEND ruff (CLI/LSP only, not a resolver); DEMOTE biome to detected project tool
- **Risk:** oxc-resolver and oxc-parser are the right consumables for JS/TS resolution and Node-side preflight, both as napi. D46 implies ruff supplies Python semantics, but ruff has no library or napi API and does no import resolution or type inference. Python semantics come from pyright or basedpyright (and possibly ty later). Biome duplicates eslint and prettier and should only be invoked when the project uses it.
- **Fix:** Amend D46. oxc-resolver napi goes to P3-T5 now, and oxc-parser napi covers Node-runtime preflight (P0-T5) and import extraction. ruff is consumed as a CLI (P0-T8 JSON) and as ruff server (P3-T1/T3). Python resolution and types come from pyright or basedpyright through the LSP or scip-python. biome only when detected in the project config.
- **Evidence:** SPEC D46; PLAN.md:102-103. cb-code-intel 'Import resolution'. cb-rt-edits 'Syntax preflight' (oxc-parser for Node). language-capabilities.ts:162-171 (python tools). Cost: S. Confidence: medium-high. Web claim (unverified): ruff exposes no public library API.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:245 — D41 Exact tokenizers via Rust: AMEND (consume prebuilt Rust-backed bindings first; exactness impossible for closed tokenizers)
- **Risk:** D41's core claim holds: the reference implementations are Rust, and transformers.js is a port. Two points need amending. Authoring X-3b code first adds cost when prebuilt bindings exist. Claude and Gemini have no local tokenizer, so 'exact counts remove the fudge factors' is false for those families.
- **Fix:** See the P3-T10 finding. Consume the tiktoken WASM/napi and HF tokenizers napi bindings. Report tokenizer tier as exact or estimated per model family under D33. Move tokenization into X-3b only for openbuff-infer and daemon reuse.
- **Evidence:** SPEC D41, D12; PLAN.md:108. Cost: S-M. Confidence: medium. Web claims unverified (see P3-T10).

## Coverage receipt

### Subsystems
- .agents

### Features
- tree-sitter-preflight
- lsp-multiplexer
- navigation-tools
- diagnostic-delta-gating
- structured-diagnostics-fixits
- scip-call-graph
- import-resolution
- type-enrichment
- tia
- build-graph
- repo-map
- compiler-daemons
- semgrep-taint
- exact-tokenizers
- ast-grep-structural-rewrite
- lsp-rename
- compiler-fix-apply
- codemods
- semantic-review-diffs
- blame-stage-commit
- word-diffs
- shell-ast-precheck
- syntax-highlighting
- import-edits
- gate-file-classification
- symbol-comment-attachment
- D41
- D42
- D46

### Files
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- common/src/util/language-capabilities.ts
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-code-intel.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-rt-edits.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-common.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-tools.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-agents.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-cli-tui.md

### Domains
- correctness
- performance
- dependency-hygiene
