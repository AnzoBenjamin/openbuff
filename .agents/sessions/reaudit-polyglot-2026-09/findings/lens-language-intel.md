# Audit findings: lens-language-intel

- Subsystems: code-map, indexer, sdk-tools, sdk-harness-intelligence, common-language-registry, agent-runtime-preflight, scripts-harness
- Features: lsp-client, compiler-backed-validation, scip-call-graph, semantic-transforms, structured-diagnostics, test-impact-analysis, build-graph, import-resolution, type-enrichment, taint-analysis, repo-map
- Files covered: 18
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] correctness — common/src/util/language-capabilities.ts:102 — LI-01 No LSP client: languageServer metadata is inert; build a TS LSP multiplexer that drives each language's own server
- **Risk:** Every semantic question (definition, references, types, rename safety) is answered by tree-sitter name matching. The registry already names the best analyzer per language (tsserver, pyright, rust-analyzer, gopls, jdtls, Roslyn/csharp-ls, clangd, sourcekit-lsp, ruby-lsp, intelephense, kotlin-language-server, Godot LS), but nothing speaks JSON-RPC to them. The prior audit's 'embedded LSP SERVER in Rust' is the wrong direction for agent quality: Openbuff needs to CONSUME LSP, not produce it.
- **Fix:** Add an LspManager in sdk (TS; vscode-jsonrpc + vscode-languageserver-protocol) that lazily spawns one server per (language, workspace root), keeps them warm, syncs didOpen/didChange from the mutation broker, and exposes definition/references/hover/documentSymbol/rename/codeAction/pullDiagnostics as agent tools. Extend the registry with launch argv (e.g. 'pyright-langserver --stdio', 'typescript-language-server --stdio', 'rust-analyzer'), transport (Godot LS is TCP 6005, not stdio), install probe, and initializationOptions. Candidate language: TS for the client (I/O-bound JSON-RPC, like VS Code itself); the analyzers stay in Rust/Go/Java/C#/C++/Python/TS as shipped by their ecosystems. Cost: medium (process supervision, per-server quirks, cold-start of jdtls/rust-analyzer 10-60s, memory 0.5-2GB for big servers). TS can do it: yes, fully; no host rewrite required.
- **Evidence:** language-capabilities.ts:102/137/166 list languageServer entries consumed only as prompt metadata; code_search for 'textDocument/'|'vscode-languageserver'|'lsp' across *.ts found no client. scripts/harness-language-server.ts:14 is spawn(command, files, {stdio:'inherit'}) then exit — a passthrough, not a protocol adapter.

## [HIGH] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts:76 — LI-02 Edit preflight is heuristic for Python/Go and a no-op for 10 of 13 parsed languages; upgrade to tree-sitter hasError now, compiler/LSP diagnostic delta next
- **Risk:** preflightValidateSyntax returns valid:true for Rust, Java, C#, C/C++, Ruby, PHP, Swift, Kotlin, GDScript (line ~89). Python validation is indentation/colon heuristics; Go is brace/package regex. False negatives let broken edits stack (the exact cascade the module header says it prevents); false positives (e.g. Python line continuations with backslash, match/case soft keywords, Go multi-line func signatures) reject valid edits. Syntax-only also misses the common agent failure: type errors and unresolved names.
- **Fix:** Tier 0 (TS, cheap): parse candidate content with the already-loaded web-tree-sitter grammar and reject when rootNode.hasError, reporting the first ERROR/MISSING node position — gives uniform syntax preflight for all 13 languages. Tier 1: ask the warm LSP server (LI-01) for pull diagnostics on the in-memory buffer and reject/flag only NEW errors vs the pre-edit baseline (diagnostic delta). Tier 2: incremental compiler daemons where no LSP is present (tsc --watch/tsbuildinfo, cargo check with --message-format=json, ruff server, dmypy). Language: analyzers native; orchestration TS. TS can do: yes.
- **Evidence:** preflight-syntax-validation.ts:76-90 dispatch covers only .ts/.tsx/.js/.jsx (Bun.Transpiler), .py, .go; validatePythonSyntax and validateGoSyntax are line/delimiter heuristics (countDelimitersOutsideStringsAndComments). structure.ts already uses node.hasError when walking trees, proving the grammar path is available.

## [HIGH] correctness — packages/code-map/src/parse.ts:513 — LI-03 Call graph is unique-name matching; ingest SCIP indexes for precise cross-file/cross-language references
- **Risk:** buildTokenCallers links a call to a definition only when exactly one same-language file defines that raw name; overloaded/common names (get, run, handle, new) produce no edge, methods on different receivers collide, and cross-language edges (TS->Python via RPC, Kotlin<->Java, Swift<->ObjC) are forbidden by design. buildModuleAwareCallEdges improves with import filtering but still resolves by name. Blast-radius, repo-map ranking, and affected-test selection all inherit these gaps. A faster native tree-sitter (prior audit) produces the same wrong graph faster.
- **Fix:** Add a SCIP ingestion tier: run the ecosystem indexer when present (scip-typescript, scip-python, rust-analyzer scip, scip-java (also Kotlin/Scala), scip-go, scip-clang (needs compile_commands.json), scip-dotnet, scip-ruby) and load the protobuf in TS into symbol->occurrence tables keyed by SCIP symbol strings (which encode package+version, so edges survive cross-package and dependency boundaries). Keep tree-sitter edges as fallback with confidence:'heuristic' vs 'precise'. Language: indexers are native to each ecosystem; the reader is TS (@sourcegraph/scip bindings or protobufjs). Cost: medium; indexing is minutes on large repos, so run in background and refresh per-package. TS can do the consumption: yes.
- **Evidence:** parse.ts buildTokenCallers: 'Caller edges resolve only when exactly one same-language definition exists'; eligible.length === 1 gate; MAX_CALLERS=25. metadata-indexer.ts buildModuleAwareCallEdges resolves importedCandidates.length===1 else languageCandidates.length===1 by raw identifier.

## [HIGH] api-contract — packages/code-map/src/structure.ts:71 — LI-04 No semantic refactor/transform capability: add LSP rename + ast-grep structural rewrites (+ per-language codemod engines)
- **Risk:** All code changes go through text edit tools (str_replace/replace_range/edit_transaction). A rename across 40 files is 40 model-generated edits with no guarantee of completeness (string matches in comments, shadowed locals, re-exports). Structural migrations (API signature change, import rewrite) cost tokens linearly in call sites and are error-prone.
- **Fix:** Expose (a) rename_symbol / apply_code_action via LSP (LI-01) returning a WorkspaceEdit that the mutation broker applies atomically with receipts; (b) a structural_rewrite tool on ast-grep (Rust core, official @ast-grep/napi binding, tree-sitter-based, supports all 13 current languages) with pattern+rewrite+constraints and dry-run diff; (c) optional ecosystem codemod engines when present: OpenRewrite (Java/Kotlin, type-attributed LST), libCST/Bowler (Python, comment-preserving), jscodeshift/ts-morph (TS/JS, type-aware via TS compiler API), Roslyn fixers via dotnet format, clang-tidy fix-its, rust-analyzer SSR. This is the one place a Rust native module (ast-grep) earns its keep for FEATURES, and it already ships as a napi prebuilt — no in-house Rust needed. Cost: low-medium for ast-grep; medium for LSP WorkspaceEdit application. TS alone: partially (ts-morph for TS only); cross-language structural rewrite needs ast-grep or comby (OCaml).
- **Evidence:** structure.ts DEFINITION_NODE_KINDS/extractDefName produce outlines only; no rewrite API exists in code-map. process-edit-transaction.ts/str-replace handlers operate on text spans.

## [MEDIUM] correctness — sdk/src/tools/language-diagnostics.ts:71 — LI-05 Diagnostics are regex-scraped from human-readable output; switch to machine formats (JSON/SARIF/LSP) to gain ranges, related info, and fix-its
- **Risk:** Eight regex parsers run over every hook output; ranges are always zero-width (start===end, toDiagnostic ~line 76); cargo multi-span errors keep only the first '-->' within 4 lines; tsc output (file(l,c): error TSxxxx) works but loses related-information chains; ruff lines are all 'warning'; phpstan/go parsers are gated on command-string regexes; output is capped at 200. Critically, compiler-suggested fixes (rustc suggestions, clang fix-its, ruff --fix edits, Roslyn code fixes, eslint fix ranges) are discarded, so the agent re-derives fixes the compiler already computed.
- **Fix:** Per-tool structured modes selected from the registry: cargo check --message-format=json (spans + suggested_replacement), ruff check --output-format=json (fix.edits), pyright --outputjson, go vet -json / golangci-lint --out-format=json, eslint -f json, clang/gcc -fdiagnostics-format=sarif|json, dotnet build -p:ErrorLog=out.sarif, phpstan --error-format=json, rubocop --format json, swiftc -serialize-diagnostics or SourceKit LSP. Normalize into LanguageDiagnostic plus optional fixes: TextEdit[] and relatedInformation; keep regex parsers as fallback. Add a 'apply_compiler_fix' path through the mutation broker. Language: TS (pure parsing). Cost: low; language-diagnostics.test.ts fixtures extend naturally.
- **Evidence:** language-diagnostics.ts toDiagnostic sets range {start: position, end: position}; MAX_DIAGNOSTICS=200; cargoParser scans offset<=4 for '-->'; lintParser ruff severity hard-coded 'warning'. file-change-hooks.ts:791 feeds stdout/stderr into parseLanguageDiagnostics.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:356 — LI-06 Affected-test selection is filename-convention only and wrong for most non-JS ecosystems; use build-graph queries and coverage maps
- **Risk:** getAffectedTestTargets checks exactly four sibling names with the SOURCE extension: stem.test.ext, stem.spec.ext, __tests__/…  This misses Go (foo_test.go), Python (tests/test_foo.py, test_foo.py), Rust (inline #[cfg(test)] mod and tests/*.rs), Java/Kotlin (src/test/java mirror + FooTest.java), C# (separate *.Tests project), Ruby (spec/foo_spec.rb), PHP (tests/FooTest.php), Swift (Tests/<Target>Tests). It also ignores transitive dependents: editing a util used by 30 modules selects zero tests.
- **Fix:** Tiered TIA: (1) per-language naming conventions from the registry (cheap TS); (2) reverse-dependency tests from the index graph / SCIP (LI-03); (3) build-tool native queries: go list -deps -test -json, cargo metadata + test targets, bazel query 'rdeps(//..., file)' / buck2 uquery, nx affected / turbo --filter=...[HEAD], jest/vitest --findRelatedTests, dotnet project references; (4) coverage maps when available: pytest-testmon / coverage.py dynamic contexts, istanbul per-test coverage, go test -coverprofile per package, JaCoCo per test, llvm-cov — mapping changed lines to the tests that executed them. Language: the native build tools; orchestration TS. Cost: medium; confidence field should distinguish 'coverage', 'graph', 'convention'. TS can do: yes.
- **Evidence:** harness-intelligence.ts:366-371 candidates array of 4 patterns filtered by fs.existsSync; returns {source, candidates, packageRoot} with no graph input. get-affected-tests.ts:8 wraps it verbatim.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:395 — LI-07 Build targets are a hard-coded command table per package manager; no target-level build graph
- **Risk:** getBuildTargets maps a manager to fixed commands ('cargo check','go build ./...','mvn package'…) at workspace-root granularity, so a one-file change in a 200-crate workspace or Gradle multi-project runs the whole build. No Bazel/Buck2/Pants/CMake/Nx target awareness; confidence is 'inferred' for all non-JS.
- **Fix:** Resolve the owning TARGET, not the workspace: cargo metadata --format-version 1 (package+target owning the file → cargo check -p <pkg>), go list -json ./... (package dir → go build ./pkg/...), Gradle Tooling API or 'gradle :sub:compileKotlin' via settings parsing, CMake File API (also emits compile_commands.json, which clangd/scip-clang need), MSBuild project graph, bazel query 'attr(srcs, file, //...)', nx show projects --affected. Language: each tool's native CLI/API; TS orchestration. Cost: low-medium per ecosystem; big win for monorepos. TS can do: yes.
- **Evidence:** harness-intelligence.ts:427-454 if/else chain of literal command arrays keyed by workspace.manager; targets carry packageRoot + commands only.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:106 — LI-08 Import extraction/resolution is regex + hand-rolled resolvers; delegate to each ecosystem's real resolver (for TS/JS that resolver is itself TypeScript)
- **Risk:** IMPORT_REGEX and per-language line regexes miss multi-line Python 'from x import (\n a,\n b)', Rust 'use a::{b, c::d}' groups, Go aliased blocks partially, C# global usings via Directory.Build.props, PHP grouped use. resolveImportToFile ignores package.json 'exports'/'imports', tsconfig baseUrl/project references/moduleResolution bundler, Python src-layout/namespace packages/sys.path, Java resolution via regex over a 4KB contentSample, Go suffix matching. chunks.ts extractImportSites duplicates the same regex logic line-by-line. Wrong/missing references edges degrade ranking and blast radius.
- **Fix:** (a) Extract imports from the tree-sitter tree (import_statement/use_declaration nodes) instead of regex — TS, cheap, uniform. (b) Resolve with in-ecosystem resolvers: typescript's ts.resolveModuleName with the project's parsed tsconfig (pure TS, zero language move — this is the key counterexample to 'move to Rust'), enhanced-resolve for bundler semantics; Python via pyright LSP definition on import sites or a tiny sidecar using importlib.util.find_spec in the project venv; Go via go list -json; Rust via cargo metadata + rust-analyzer; JVM via jdtls/Gradle classpath. Cost: low for (a); medium for (b). TS can do: yes.
- **Evidence:** metadata-indexer.ts IMPORT_REGEX (~106), extractImports per-extension regexes (Python '^\s*from\s+([.\w]+)\s+import\b', Rust '(?:use|mod)\s+([\w:]+)'), resolveDeclaredPackageImport regex over candidate.contentSample, Go suffixMatches heuristic; loadTsAliases reads only compilerOptions.paths following extends. chunks.ts:340-420 extractImportSites repeats line regexes.

## [MEDIUM] correctness — packages/code-map/src/structure.ts:560 — LI-09 Symbol type info is syntactic header text; inferred types, resolved signatures and real docs require the language server
- **Risk:** extractTypeInfo copies annotation text only (first line, 256 chars); unannotated Python/JS/Ruby/PHP yield no types, TS inferred returns and Rust 'impl Trait'/generics are unresolved, overload sets and C++ templates are opaque. extractDocForLine scans 5 lines above using comment-prefix heuristics (misses Python docstrings inside bodies, which are the dominant convention). Context packets and outlines therefore under-describe APIs, which drives hallucinated call signatures.
- **Fix:** Enrich SymbolRange lazily from LSP: textDocument/hover (resolved signature + rendered docs), documentSymbol (authoritative outline incl. detail), inlayHint (inferred types), signatureHelp at call sites; cache by content hash. Keep tree-sitter as zero-dependency fallback. Language: LSP servers; TS client. Cost: low once LI-01 exists. TS alone: no (type inference for other languages cannot be reimplemented in TS sensibly).
- **Evidence:** structure.ts extractTypeInfo reads fields parameters/return_type/type_annotation as text; extractDocForLine window=5 lines above startLine; isCommentLine treats triple-quote only as leading line.

## [MEDIUM] security — sdk/src/tools/file-change-hooks.ts:700 — LI-10 No dataflow/taint analysis of agent-authored changes
- **Risk:** Validation hooks run formatters/linters/typecheckers; nothing checks whether an agent edit introduces source->sink flows (SQL injection, command injection, path traversal, SSRF, XSS). Agents are exactly the authors most likely to wire untrusted input into a sink without noticing.
- **Fix:** Optional security hook: semgrep (OCaml core; 'semgrep scan --baseline-commit HEAD --sarif' reports only new findings; taint mode supports ~30 languages) and CodeQL (QL/Java; needs a build for compiled languages, heavier, best as on-demand /review). Feed SARIF through LI-05's structured path into get-change-review-bundle. Language: OCaml/QL engines, invoked as subprocesses; TS orchestration. Cost: low for semgrep, high for CodeQL; licensing: CodeQL CLI is free only for OSS/research — flag to users. TS can do: no equivalent engine.
- **Evidence:** file-change-hooks.ts runFileChangeHooks executes inferred/configured commands and parses diagnostics; inferPythonHooks/inferJvmHooks/etc. choose lint/type/test commands only; no security analyzer in the inference tables.

## [LOW] test-coverage — packages/code-map/src/languages.ts:59 — LI-11 Language family mapping is duplicated in three places and C is parsed with the C++ grammar
- **Risk:** getLanguageFamily (parse.ts), getLanguageTag (structure.ts) and getLanguageFamily (metadata-indexer.ts) are separate copies of the extension->family map, while common/src/util/language-capabilities.ts claims to be the canonical registry ('Consumers should derive lookup maps from this registry'). Drift will silently change caller-edge eligibility. .c/.h are mapped to tree-sitter-cpp even though families distinguish 'c' vs 'cpp' and the registry lists tree-sitter-c; C-specific constructs (K&R, some macros) mis-parse, and .h C/C++ ambiguity is unresolved (clangd resolves it via compile_commands.json).
- **Fix:** Derive all three from LANGUAGE_CAPABILITY_REGISTRY plus one exported extension->family function; add the tree-sitter-c grammar for .c; defer .h classification to compile_commands.json when present. Language: TS. Cost: low. A shared conformance fixture also de-risks any future native parse tier (prior audit's condition).
- **Evidence:** parse.ts getLanguageFamily, structure.ts getLanguageTag, metadata-indexer.ts getLanguageFamily contain identical literal extension arrays; languages.ts languageTable maps ['.c', '.cc', ... '.h'] to tree-sitter-cpp.wasm; language-capabilities.ts cpp.tools.parser lists 'tree-sitter-c'.

## [LOW] api-contract — packages/indexer/src/repo-map.ts:58 — LI-12 Repo map is a prototype alphabetical dump, not a ranked definition/reference graph
- **Risk:** buildRepoMap sorts files by path and slices 40; it is not used by query_index. Aider-style repo maps (PageRank over def/ref graph, personalized to the files in chat) are the proven high-value context primitive; without precise references (LI-03) any ranking is noisy.
- **Fix:** Rank with personalized PageRank over the (SCIP-precise when available) reference graph seeded by target paths and mentioned identifiers, render signatures from LI-09 enrichment, budget by exact tokens. Language: TS (graph size is small). Cost: low-medium. TS can do: yes.
- **Evidence:** repo-map.ts header: 'Prototype-only repo-map renderer for retrieval evals ... not used by the default query_index path'; entries .sort((a,b)=>a.path.localeCompare(b.path)).slice(0, opts.maxFiles).

## [LOW] correctness — common/src/util/language-capabilities.ts:380 — LI-13 Registry tool names are not launchable specs and some are stale
- **Risk:** Entries like 'Godot language server' (TCP 6005 in-editor, not a CLI), 'Roslyn' (no standalone stdio binary name; Microsoft.CodeAnalysis.LanguageServer or csharp-ls), 'kotlin-language-server' (community fwcd server; JetBrains released an official kotlin-lsp in 2025 — verify current status), 'typeChecker: go test' (go vet / gopls check is the type-check step) cannot drive a client. Kotlin has no manifestNames (build.gradle.kts is explicitly excluded in detectLanguageIdForPath), so Kotlin-only repos are detected only by source extension.
- **Fix:** Split display metadata from an executable ToolSpec {argv, transport: stdio|tcp, detect: argv, minVersion, rootMarkers}. Add Gradle/settings.gradle.kts as Kotlin/Java root markers for server launch even if not a language signal. Language: TS. Cost: low.
- **Evidence:** language-capabilities.ts gdscript tools.languageServer ['Godot language server'], csharp ['Roslyn','csharp-ls'], kotlin manifestNames: [], go typeChecker ['go test']; language-profiles.ts detectLanguageIdForPath returns undefined for build.gradle(.kts)/settings.gradle(.kts).

## Coverage receipt

### Subsystems
- code-map
- indexer
- sdk-tools
- sdk-harness-intelligence
- common-language-registry
- agent-runtime-preflight
- scripts-harness

### Features
- lsp-client
- compiler-backed-validation
- scip-call-graph
- semantic-transforms
- structured-diagnostics
- test-impact-analysis
- build-graph
- import-resolution
- type-enrichment
- taint-analysis
- repo-map

### Files
- packages/code-map/src/languages.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/chunks.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/semantic.ts
- sdk/src/tools/language-diagnostics.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/tools/get-build-targets.ts
- sdk/src/services/harness-intelligence.ts
- scripts/harness-language-server.ts
- common/src/util/language-capabilities.ts
- common/src/util/language-profiles.ts
- common/src/util/engine-profiles.ts
- packages/agent-runtime/src/util/preflight-syntax-validation.ts
- .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md

### Domains
- correctness
- api-contract
- security
- test-coverage
