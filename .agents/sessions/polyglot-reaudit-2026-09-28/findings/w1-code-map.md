# Audit findings: w1-code-map

- Subsystems: packages
- Features: code-map-parsing, tree-sitter-queries, code-map-structure, code-map-chunks, grammar-wasm-repair, language-registry-parity
- Files covered: 18
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] performance — packages/code-map/src/languages.ts:324 — [BEST] Grammar-load failures are never cached: every file of a broken language re-runs Language.load and (in the binary) the 3x30s network repair
- **Risk:** createLanguageConfig only caches on success (`if (!cfg.parser)` guard, lines 324-349). When a grammar fails to load, every later file with that extension re-enters loadLanguage (lines 277-305), which in CODEBUFF_IS_BINARY mode calls repairGrammarWasm with up to 3 attempts x 30s timeout plus backoff. getFileTokenScores awaits files sequentially (parse.ts:146-193), so a repo with 1,000 .kt files and an unreachable CDN can stall indexing for hours. There is also no in-flight promise, so concurrent callers (structure/chunks/preflight) for the same extension race and build duplicate Parser/Language/Query objects, leaking WASM memory.
- **Fix:** Memoize a per-LanguageConfig `loading: Promise<LanguageConfig|undefined>` (dedupes concurrent loads) plus a negative-cache entry `{failedAt, error}` with a TTL (e.g. 5 min) so each grammar is attempted/repaired at most once per window; surface the cached error in the ParseDiagnostic.
- **Evidence:** languages.ts:320-352 `if (!cfg.parser) { try { await runtimeLoader.initParser(); const lang = await runtimeLoader.loadLanguage(cfg.wasmFile) ... } catch (err) { throw err } }` - no failure memo; languages.ts:292-302 repair path; grammar-wasm-repair.ts:107-108 MAX_REPAIR_ATTEMPTS=3, ATTEMPT_TIMEOUT_MS=30_000; parse.ts:180 `await getLanguageConfig(fullPath)` inside the per-file loop.

## [HIGH] correctness — packages/code-map/src/languages.ts:60 — [POLY] Only 15 grammars; Bash, Lua, Scala, Zig, Elixir, Dart, HTML/CSS, JSON/YAML/TOML, Vue/Svelte, Haskell, Terraform produce zero symbols
- **Risk:** languageTable/WASM_FILES cover only TS/TSX/JS/Py/Java/C#/C/C++/Rust/Ruby/Go/PHP/Swift/Kotlin/GDScript. Any other file gets no outline, no chunks, no token scores and no syntax preflight (detectSyntaxErrorViaTreeSitter returns available:false). For a harness meant for ANY repo, a Scala/Elixir/Lua/Dart/Terraform project gets an empty code map and the agent navigates blind, with no signal beyond a per-file diagnostic.
- **Fix:** The already-pinned tree-sitter-wasms@0.1.13 package ships bash, lua, scala, zig, elixir, dart, elm, ocaml, objc, html, css, json, yaml, toml, vue, solidity, embedded_template WASMs. Add them to WASM_FILES + PINNED_GRAMMAR_ASSETS (sha256 pins), write tags.scm per language (upstream tags.scm from each grammar repo or nvim-treesitter/aider queries), and add Haskell/Svelte/HCL(Terraform)/Markdown via vendored pinned builds like the GDScript entry. For data formats (JSON/YAML/TOML) expose structure-only (keys) or explicitly mark them `parser:none` in capability reporting.
- **Evidence:** wasm-files.ts:1-17 lists 15 grammars; languages.ts:60-137 languageTable has 15 entries; grammar-wasm-repair.ts:16-21 already uses tree-sitter-wasms 0.1.13 as the pinned source; languages.ts:377-379 returns available:false for unregistered extensions.

## [HIGH] correctness — packages/code-map/src/chunks.ts:340 — [LANG] P3-T5 open: per-line regex import extraction misses multi-line TS imports, Go import blocks, Rust use-trees and Python parenthesized imports - replace with tree-sitter @import captures + oxc-resolver
- **Risk:** extractImportSites matches one line at a time. `import {\n a,\n b\n} from 'x'` fails (the `} from 'x'` line has no import/export keyword); Go's standard `import (\n "fmt"\n)` block is never matched (regex requires `import` on the same line as the path); Rust `use a::{b, c}` yields only `a::`; Python `from x import (\n a, b)` loses names. Strings/comments containing `import` produce false sites. Chunk.imports and downstream import graphs are therefore wrong for the most common formatting in TS, Go and Rust.
- **Fix:** Keep P3-T5 as TS in-process but base it on AST: add `@import.source`/`@import.name` captures to each tags.scm (import_statement/import_clause, import_spec, use_declaration/use_list, import_from_statement, preproc_include, using_directive, namespace_use_declaration, import_header, import_declaration) and consume them in the existing single parse in parseStructureOnce. For resolution use `oxc-resolver` (Rust, prebuilt napi, implements enhanced-resolve + tsconfig paths, far faster than loading `typescript` for ts.resolveModuleName); Go via go.mod module path mapping; Python via src-root/sys.path heuristics; delegate precise edges to SCIP (P3-T4).
- **Evidence:** chunks.ts:370-372 `line.match(/\b(?:import|export)\b[^'\"]*\bfrom\s+['\"]([^'\"]+)['\"]/)`; chunks.ts:424 Go `/^\s*import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/`; chunks.ts:418 Rust `/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/`; PLAN.md:103 P3-T5 still [ ].

## [MEDIUM] correctness — packages/code-map/src/structure.ts:72 — [POLY] Single cross-grammar DEFINITION_NODE_KINDS map: GDScript locals outlined, JS class expressions misnamed, Go const/var, Kotlin/Swift properties, PHP traits, Swift extensions missing
- **Risk:** Node types are mapped globally, not per language. `variable_statement` (GDScript) is emitted for every local var inside function bodies (no top-level check, unlike JS variableDeclaratorKind). Ruby `class`/`module`/`method` keys also match JS `class` expression nodes (named via findIdentifier, possibly picking the heritage identifier). Missing kinds: Go const_spec/var_spec, PHP trait_declaration, Kotlin property_declaration/type_alias, Swift property_declaration/typealias_declaration/extension (only through class_declaration keyword sniffing), C preproc_function_def/preproc_def, C# property_declaration. Outlines are thus noisy for GDScript and incomplete for Go/Kotlin/Swift/PHP/C.
- **Fix:** Move definition detection into per-language .scm files using the upstream tags convention (`@definition.function`, `@definition.class`, `@name`), run it once per parse, and derive kind from the capture name. This removes the global node-type collision table and makes adding a language a query-only change. Until then, key DEFINITION_NODE_KINDS by language tag and add a top-level guard for GDScript variable_statement.
- **Evidence:** structure.ts:115-121 `method`, `class`, `module`, `variable_statement: 'variable'` in the shared map; structure.ts:855-856 `const kind = definitionKind(node); if (kind && !node.hasError)` with no language dispatch; structure.ts:252-262 top-level check applies only to variable_declarator.

## [MEDIUM] correctness — packages/code-map/src/tree-sitter-queries/tree-sitter-kotlin-tags.scm:6 — [POLY] Kotlin and Swift tag queries capture only simple calls and 3 definition kinds; method calls `obj.foo()` are never recorded
- **Risk:** Kotlin/Swift `call.identifier` only matches `(call_expression (simple_identifier))`, so the dominant OO call form (navigation_expression/navigation_suffix) yields no call edges, starving tokenCallers, chunk calls/calledBy and blast-radius for Kotlin/Swift. Properties, typealiases, companion objects, Swift extensions/inits are not captured as identifiers, so token scoring misses them.
- **Fix:** Add `(call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.identifier)))` for both grammars, plus property_declaration, type_alias/typealias_declaration, Swift init_declaration and extension captures; add fixture files test.kt/test.swift/test.gd asserting defs+calls.
- **Evidence:** tree-sitter-kotlin-tags.scm:6-10 (3 def patterns + 1 simple call pattern); tree-sitter-swift-tags.scm:6-10 same shape; __tests__/test-langs contains no .kt/.swift/.gd/.tsx fixture.

## [MEDIUM] api-contract — packages/code-map/src/parse.ts:290 — [POLY] Coverage conflates 'unsupported language' with budget truncation: truncated=true for any skipped non-code file
- **Risk:** Unsupported extensions are pushed to skippedPaths and get a 'language' diagnostic, and `truncated: skippedPaths.length > 0`. Unless every caller pre-filters by SUPPORTED_CODE_EXTENSIONS (not verified in this shard), a repo with one README or YAML reports a truncated index, and genuine budget truncation is indistinguishable from 'no grammar'. Violates SPEC principle 6 (honest reporting of actual capability).
- **Fix:** Split coverage into `unsupportedFiles`/`unsupportedLanguages` (no grammar), `grammarLoadFailures`, and budget skips; set truncated only for budget/oversize/read/parse skips. Report per-language capability tier (full tags / structure-only / none).
- **Evidence:** parse.ts:180-195 unsupported path pushes skippedPaths + diagnostic; parse.ts:290 `truncated: skippedPaths.length > 0`.

## [MEDIUM] api-contract — packages/code-map/src/structure.ts:299 — [POLY] code-map maintains its own extension/language tables that drift from LANGUAGE_CAPABILITY_REGISTRY
- **Risk:** The registry says consumers must derive lookup maps from it, yet languageTable (15 entries), getLanguageTag (hard-coded ext chains), and extractImportSites (hard-coded ext lists) each keep parallel tables. The registry has 12 ids (c/cpp, ts/js merged) while code-map distinguishes 15 grammars; nothing checks that registry extensions all have a grammar or vice versa. Adding a language requires editing 4+ places, and silent gaps appear (e.g. registry parser metadata lists tree-sitter-c/cpp but a new registry extension would not reach code-map).
- **Fix:** Add a `grammar` field (wasmFile + query id) per extension in the registry or a code-map table keyed by SupportedLanguageId, derive getLanguageTag/import dispatch from it, and add a parity test: every registry extension maps to a languageTable entry and every languageTable extension belongs to a registry language.
- **Evidence:** language-capabilities.ts:101-103 comment 'Consumers should derive lookup maps from this registry'; structure.ts:299-319 hard-coded ext chain; chunks.ts:366,398,428,435 hard-coded ext lists; languages.ts:60-137.

## [MEDIUM] performance — packages/code-map/src/structure.ts:850 — [BEST] Structure walk uses namedChildren arrays across the WASM boundary plus a second full query pass; use TreeCursor or a single definitions+calls query
- **Risk:** Every node visit materializes `node.namedChildren` (allocates a JS array of wrapped Nodes via WASM calls), and definitionKind iterates `node.children` again for class_declaration; then query.captures runs a second full traversal. For large files this is several-fold slower than a TreeCursor walk or a single Query.matches pass; findIdentifier uses `stack.shift()` (O(n) per pop).
- **Fix:** Replace the DFS with a single tags query (definitions + calls + imports) executed once, or walk with `tree.walk()` TreeCursor (gotoFirstChild/gotoNextSibling) which avoids per-node array allocation; use an index pointer instead of shift() in findIdentifier.
- **Evidence:** structure.ts:850-957 `stack.pop()` / `for (const child of node.namedChildren)`; structure.ts:966 `cfg.query.captures(tree.rootNode)` second pass; structure.ts:154 `stack.shift()`.

## [MEDIUM] performance — packages/code-map/src/parse.ts:146 — [BEST] Parsing is synchronous on the main thread and 'incremental parse' is file-level cache reuse only (no tree.edit / oldTree)
- **Risk:** getFileTokenScores parses up to 10,000 files / 500 MB sequentially on the event loop (parser.parse is synchronous in web-tree-sitter), blocking the TUI/agent loop during indexing. The agent's edit->re-outline loop reparses whole files because no old tree is kept (parser.parse(content) without oldTree), so changedRanges-based chunk invalidation is impossible.
- **Fix:** Interim (before P6-T7): run parsing in a Bun Worker pool (one Parser per worker, grammars loaded per worker) and yield between files. For edited files keep a small LRU of Trees keyed by path+hash, apply tree.edit() from the mutation broker's edit ranges and call parser.parse(newText, oldTree); use getChangedRanges to invalidate only affected chunks. Free evicted trees with tree.delete().
- **Evidence:** parse.ts:146 `for (const filePath of fairParseOrder(filePaths))` with awaits but synchronous parseFile; parse.ts:633 `const tree = parser.parse(sourceCode)`; structure.ts:824 `cfg.parser.parse(content)`; incremental-parse.test.ts:8 tests only 'reuses cached parse output'.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:113 — [LANG] P4-T1 @ast-grep/napi 'for all 13 grammars' cannot reuse code-map's WASM grammars; needs native dynamic-language libs
- **Risk:** @ast-grep/napi bundles only a few built-in languages (JS/TS/TSX/HTML/CSS); other languages require registerDynamicLanguage with native tree-sitter shared libraries (@ast-grep/lang-* packages or self-built .so/.dylib/.dll). code-map ships WASM grammars only, so P4-T1 silently doubles grammar distribution (and version skew between WASM and native grammars can make ast-grep and code-map disagree on node types).
- **Fix:** Keep ast-grep napi (principle 3d, prebuilt addon) but plan explicitly: pin @ast-grep/lang-* per language, add a parity check that WASM and native grammar versions match, and consolidate with P6-T7 so the Rust index service and ast-grep share the same native grammar crates (ast-grep-core can be embedded in the Rust index sidecar instead of napi).
- **Evidence:** PLAN.md:113 '@ast-grep/napi structural_replace ... for all 13 grammars ... lang Rust prebuilt via napi'; wasm-files.ts:1-17 only WASM assets are shipped.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:80 — [LANG] P1-T6 highlighting via web-tree-sitter covers 15 languages and there are no highlights.scm files; Shiki gives polyglot coverage
- **Risk:** code-map ships only tags queries; tree-sitter highlighting needs per-language highlights.scm (and injections for markdown fences, Vue, HTML). Coverage would be 15 languages, so fenced blocks in Lua/YAML/Bash/SQL/diff render unhighlighted - the most common fence languages in agent output.
- **Fix:** Use Shiki (@shikijs/core with the JavaScript regex engine to avoid Oniguruma WASM, fine-grained bundled grammars loaded lazily) for markdown/code highlighting: 200+ TextMate grammars including diff/shell/sql/yaml. Reserve tree-sitter for semantic features.
- **Evidence:** PLAN.md:80 P1-T6 [ ]; tree-sitter-queries/ contains only *-tags.scm (read_subtree listing).

## [LOW] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md:120 — [LANG] P4-T8 tree-sitter-bash is not shipped and is error-tolerant; must treat hasError as deny/fallback
- **Risk:** No bash grammar exists in WASM_FILES/PINNED_GRAMMAR_ASSETS. tree-sitter-bash always produces a tree (ERROR nodes) for malformed or adversarial input, so an advisory AST check that ignores hasError can explain a command differently from how bash executes it.
- **Fix:** Add tree-sitter-bash.wasm from pinned tree-sitter-wasms@0.1.13 with a sha256 pin; when rootNode.hasError, fall back to the lexical policy verdict. mvdan/sh (the shfmt parser) is more faithful to bash semantics; if a strict parser is wanted, host it in the P5-T1 Rust/Go shim rather than as WASM in-process.
- **Evidence:** PLAN.md:120; wasm-files.ts has no bash entry; grammar-wasm-repair.ts:24-94 no bash pin.

## [LOW] dependency-hygiene — packages/code-map/src/grammar-wasm-repair.ts:90 — [BEST] GDScript grammar repaired from a third-party personal GitHub repo; runtime loads from CODEBUFF_WASM_DIR are not hash-verified
- **Risk:** Integrity is sha256-pinned, but availability and provenance depend on lusiem/code-atlas staying up. Separately, UnifiedLanguageLoader.loadLanguage loads whatever is at resolveWasmPath without hash check; only build-time resolveGrammarWasmSource verifies pins, so a tampered WASM in the wasm dir executes in-process.
- **Fix:** Build tree-sitter-gdscript.wasm in the project's own CI (tree-sitter build --wasm) and host it under project releases; optionally verify PINNED_GRAMMAR_ASSETS sha256 at first load (one-time cost per grammar).
- **Evidence:** grammar-wasm-repair.ts:88-91 sourceUrl raw.githubusercontent.com/lusiem/code-atlas/...; languages.ts:280-283 `lang = await Language.load(wasmPath)` with no checksum.

## [LOW] test-coverage — packages/code-map/__tests__/languages-m7.test.ts:24 — [POLY] Kotlin/Swift/PHP tests check registration only; no fixture-level def/call/import assertions for Kotlin, Swift, GDScript, TSX
- **Risk:** Query regressions (e.g. grammar upgrade renaming nodes, which throws on Query construction or silently matches nothing) go undetected for 4 of 15 grammars; test-langs has fixtures for only 11 languages.
- **Fix:** Add test.kt/test.swift/test.gd/test.tsx fixtures and a table-driven test asserting expected identifiers, calls, imports and outline kinds per language (golden snapshots), and run it for every newly added grammar.
- **Evidence:** languages-m7.test.ts:25-76 tests 'is registered for', 'present in the manifest', 'graceful no-op on missing WASM grammar'; __tests__/test-langs lists .java,.cpp,.ts,.go,.js,.rs,.c,.cs,.py,.php,.rb only.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:147 — [LANG] Confirm P6-T7 native tree-sitter + rayon in the Rust index service; ride it with grammar-crate consolidation
- **Risk:** None if executed as planned; noted because it resolves the WASM parse throughput, main-thread blocking and runtime grammar fetch findings above.
- **Fix:** Keep Rust (principle 4). Use per-grammar crates (tree-sitter-<lang>) or tree-sitter-language-pack to cover the extended language set in one dependency, reuse the same .scm files, share grammars with ast-grep-core, and gate on the buildTokenCallers conformance fixture as planned.
- **Evidence:** PLAN.md:147 P6-T7 [ ]; parse.ts:146 sequential loop; languages.ts:292-302 runtime repair fetch.

## Coverage receipt

### Subsystems
- packages

### Features
- code-map-parsing
- tree-sitter-queries
- code-map-structure
- code-map-chunks
- grammar-wasm-repair
- language-registry-parity

### Files
- packages/code-map/src/languages.ts
- packages/code-map/src/wasm-files.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/code-map/src/init-node.ts
- packages/code-map/src/tree-sitter-queries/tree-sitter-kotlin-tags.scm
- packages/code-map/src/tree-sitter-queries/tree-sitter-swift-tags.scm
- packages/code-map/src/tree-sitter-queries/tree-sitter-gdscript-tags.scm
- packages/code-map/src/tree-sitter-queries/tree-sitter-c-tags.scm
- packages/code-map/__tests__/all-language-wasm.test.ts
- packages/code-map/__tests__/languages-m7.test.ts
- packages/code-map/src/__tests__/incremental-parse.test.ts
- common/src/util/language-capabilities.ts
- common/src/util/language-profiles.ts
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
