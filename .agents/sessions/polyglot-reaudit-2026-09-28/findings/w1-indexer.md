# Audit findings: w1-indexer

- Subsystems: packages
- Features: query-index, import-resolution, semantic-search, repo-map, index-store, file-walker, command-discovery, retrieval-quality
- Files covered: 11
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] performance — packages/indexer/src/metadata-indexer.ts:1626 — [BEST] JVM/PHP/Go import resolution scans every indexed file per import (O(imports x files)), and runs twice per build
- **Risk:** resolveDeclaredPackageImport runs Object.values(files).filter(...) for each import, calling path.posix.basename per candidate and compiling a new RegExp on each basename hit. The Go suffix path (1611) does Object.keys(files).filter per import. resolveImportToFile is called from both buildGraph (815) and buildModuleAwareCallEdges (960), so the cost doubles. On a 10k-file Java/Kotlin monorepo with ~20 imports per file this comes to billions of basename operations per full rebuild, and the graph is rebuilt from the full file set on every update. The X-2a rows do not cover this, so the D13 baseline mis-attributes it.
- **Fix:** Build lookup maps once per buildGraph: (a) for Java/Kotlin/PHP, map from package or namespace plus basename to paths, filled from a single `package`/`namespace` extraction per file; (b) for Go, map from directory to files, keyed by module-relative dir; (c) memoize resolveImportToFile per (fromDir, ext, importPath) and pass the resolved set to buildModuleAwareCallEdges instead of resolving again. Add an X-2 row for a synthetic 5k-file Java repo.
- **Evidence:** metadata-indexer.ts:1639-1655 `Object.values(files).filter(candidate => ... path.posix.basename ... new RegExp(...package...))`; :1611 `Object.keys(files).filter(...)`; call sites :815 and :960.

## [HIGH] correctness — packages/indexer/src/metadata-indexer.ts:1558 — [POLY] Rust module resolution is wrong for Cargo workspaces, nested modules, `use a::{b,c}` and repeated `super::`
- **Risk:** `crate::x` is joined to the importing file's directory and then to the repo-root `src/`. In a Cargo workspace (crates/foo/src/lib.rs) the crate root is crates/foo/src, so both guesses miss, or they resolve to the wrong crate's src/. `.replace(/^super::/,'../')` is not global, so `super::super::x` breaks. `mod b;` inside src/a.rs should resolve to src/a/b.rs, but it is joined to the directory of a.rs. The import regex `[\w:]+` (1051) stops at `{`, which yields `foo::` for grouped uses. Result: Rust repos, which are a primary target language, get few or wrong reference edges.
- **Fix:** Find the owning crate root by walking up to the nearest Cargo.toml with [package]; map `crate::` to that crate's lib.rs or main.rs dir; replace every leading `super::` segment; resolve `mod` declarations using the rust 2018 rule (non-mod.rs file -> sibling dir named after the file); expand `{...}` groups. Longer term, prefer P3-T4 rust-analyzer SCIP. Add a Cargo-workspace fixture to import-resolution.test.ts.
- **Evidence:** metadata-indexer.ts:1560-1571 (`.replace(/^super::/, '../')`, `path.posix.join(fromDir, rustPath)`, `src/${rustPath}`); :1051 `/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm`.

## [HIGH] correctness — packages/indexer/src/metadata-indexer.ts:1038 — [POLY] Import extraction covers ~12 languages; Scala, Lua, Zig, Elixir, Haskell, Dart, Bash, Vue/Svelte, Terraform and notebooks produce zero import/reference edges
- **Risk:** extractImports has no branch for .scala, .lua, .zig, .ex/.exs, .hs, .dart, .sh, .vue, .svelte, .tf or .ipynb. Vue/Svelte SFC `<script>` imports are ignored even though they are JS. The Kotlin regex requires end-of-line after the path, so `import a.b.C as D` is dropped. Swift imports are extracted, but resolveImportToFile has no Swift branch, so they never resolve. Graph ranking and related-files silently degrade to lexical-only for these repos.
- **Fix:** Short term: add regex branches for Scala (`import a.b.{X,Y}`), Dart (`import 'package:x/y.dart'` via pubspec name), Lua (`require"a.b"`), Zig (`@import("x.zig")`), Elixir (alias/import/use -> module-to-file via lib/ convention), Haskell (`import qualified A.B` -> A/B.hs under hs-source-dirs), Bash (`source`/`.`), Terraform (`module { source = "./x" }`), and Vue/Svelte script-block extraction reusing IMPORT_REGEX; accept `as` aliases for Kotlin. Proper fix: P3-T5 should take imports from tree-sitter `.scm` import queries per registered grammar instead of per-extension regex.
- **Evidence:** metadata-indexer.ts:1038-1102 branch list (.ts/.js family, .py, .rs, .go, .java/.kt, C/C++, .cs, .rb, .php, .swift, .gd only); Kotlin regex :1068 `([\w.]+)(?:\.\*)?\s*;?\s*$`; resolveImportToFile :1516-1624 has no .swift branch.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:1606 — [POLY] Go, Python, TS and C/C++ resolution assume a single root manifest (no go.work, src-layout, per-package tsconfig or include dirs)
- **Risk:** Go reads only files['go.mod'] at the root, so nested modules and go.work monorepos resolve nothing. Python absolute imports resolve only from the repo root, so src/ layouts and pyproject package-dir/poetry packages miss. loadTsAliases reads only <root>/tsconfig.json, ignores baseUrl (the comment assumes baseUrl='.') and ignores package.json workspaces/exports, which breaks pnpm/yarn monorepos. C/C++ includes resolve only relative to the including file, with no compile_commands.json or CMake include dirs.
- **Fix:** Add a manifest-discovery pass that records module roots: every go.mod plus go.work `use` entries; pyproject [tool.setuptools.packages.find]/poetry `packages` and src/ heuristics; every tsconfig.json with baseUrl honoured, plus package.json `name` -> dir for workspace packages; compile_commands.json `-I` flags. Resolve each import against its owning root. This is the concrete scope P3-T5 should state.
- **Evidence:** metadata-indexer.ts:1606 `files['go.mod']`; :1586 `resolveModuleCandidates(modulePath, files)` (root-relative); :1391 `path.join(projectRoot, 'tsconfig.json')`; :1479 docblock 'baseUrl="." in this repo'; :1531-1542 C/C++ local-only.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:1164 — [POLY] Command/manifest discovery misses monorepo and non-JS manifests and all non-GitHub CI
- **Risk:** conceptsByManifest has no entry for go.work, pnpm-workspace.yaml, settings.gradle(.kts), setup.py/setup.cfg/tox.ini/noxfile.py, mix.exs, pubspec.yaml, build.sbt, *.cabal/stack.yaml, build.zig, *.rockspec, Taskfile.yml or Rakefile. Scripts are parsed only from package.json. isCiWorkflowPath matches only .github/workflows (not .gitlab-ci.yml, Jenkinsfile, .circleci, azure-pipelines.yml). isTaskRunnerPath is duplicated in query.ts:1194 and is JS-leaning (gulp/grunt/turbo/nx). CONFIG_EXTENSIONS (:41) omits .xml/.gradle/.exs/.cabal, so pom.xml and similar manifests may never be classified as config (not traced to the call site; unverified). query_index mode:'commands' therefore under-serves non-JS repos.
- **Fix:** Move manifest/CI/task-runner detection into one shared table in common/util/language-profiles, keyed per language family (manifest, test command, lint command, workspace file). Parse real targets where cheap: Makefile/justfile targets, Cargo [workspace].members, go.work use, pyproject [project.scripts]/[tool.poetry.scripts]/[tool.pytest]. Delete the query.ts duplicate. Add GitLab, Jenkins, CircleCI and Azure CI paths.
- **Evidence:** metadata-indexer.ts:1167-1207 manifest table; :1268-1285 isCiWorkflowPath/isTaskRunnerPath; :1215-1242 scripts parsed only for package.json; query.ts:1187-1204 duplicate helpers; :41 CONFIG_EXTENSIONS.

## [MEDIUM] performance — packages/indexer/src/file-walker.ts:8 — [POLY] Default excludes and noisy-path penalties are JS-centric; Rust target/, Python venvs, vendor/ and similar dirs consume the 20k-file budget
- **Risk:** DEFAULT_EXCLUDE_DIRS and NOISY_PATH_SEGMENTS (query.ts:63) cover node_modules/.next/.turbo/dist, but not target (Cargo/Maven), .venv/venv/__pycache__/.tox/.mypy_cache, vendor (Go/PHP), .gradle, Pods, .dart_tool, _build/deps (Elixir), .stack-work, zig-cache/zig-out, .terraform, bin/obj (.NET). Repos without a thorough .gitignore, or with committed vendor/, get truncated at DEFAULT_MAX_FILES=20000 before source files are reached, and ranking does not penalize generated trees.
- **Fix:** Derive per-ecosystem build/vendor dirs from the language-profile table (only when the matching manifest exists, e.g. `target` only next to Cargo.toml or pom.xml, to avoid excluding real source). Share the list between file-walker and query.ts.
- **Evidence:** file-walker.ts:8-25 DEFAULT_EXCLUDE_DIRS; :28 DEFAULT_MAX_FILES = 20_000; query.ts:63-74 NOISY_PATH_SEGMENTS.

## [MEDIUM] test-coverage — packages/indexer/src/retrieval-quality.test.ts:20 — [POLY] The retrieval-quality golden corpus measures only this TS repository; no per-language quality or import-resolution goldens
- **Risk:** The versioned corpus (fixtures/retrieval-quality-openbuff-v2.json) asserts that every document exists in the Openbuff repo, which is TS. query-quality.test.ts has only three synthetic py/rs/go paths. Recall@K/MRR/nDCG regressions for Rust, Java/Kotlin, Python src-layout, Go multi-module, C++ or Vue repos are invisible, so any P3-T4/T5/T9 ranking change can pass while regressing non-TS users.
- **Fix:** Add small committed polyglot fixture repos (Cargo workspace, go.work, pnpm monorepo, Gradle multi-project, Python src-layout, CMake plus include/, Elixir mix, Vue SFC). Each gets 5-10 queries with expected paths and expected reference edges, gated in the same retrieval-quality suite with a per-language metric floor.
- **Evidence:** retrieval-quality.test.ts:20-35 (`repositoryRoot`, `existsSync(resolve(repositoryRoot, document.path))`); query-quality.test.ts:102,113,124 are the only non-TS docs.

## [MEDIUM] performance — packages/indexer/src/query.ts:444 — [BEST]/[LANG] Lexical scoring is ad-hoc substring+IDF, not BM25/BM25F; the P6-T6 store should use tantivy with a code-aware tokenizer, not FTS5 defaults
- **Risk:** scoreFile uses String.includes over every symbol, heading, concept, import and chunk per token. There is no term-frequency saturation or length normalization, so files with many symbols or concepts win. Cost is O(tokens x fields) per candidate, and IDF misses fall back to a full-corpus scan (590-601). D28 already assigns tantivy to archives. For the code index, sqlite FTS5's unicode61 tokenizer does not split camelCase/snake_case and would regress recall if P6-T6a exposed FTS5 search.
- **Fix:** LANG: at P6-T6 use tantivy with per-field BM25F (path, symbols, headings, concepts, chunk names) and a custom tokenizer that emits camel/snake/acronym splits plus edge n-grams, which replaces the substring scan. Keep P6-T6a sqlite as storage only (no FTS5 ranking), or use FTS5 with the trigram tokenizer if an interim search is needed. BEST (TS now): compute BM25F from the existing postings/documentFrequencies instead of includes().
- **Evidence:** query.ts:444-516 includes-based loops; :595-601 whole-corpus df fallback; query-data.ts:139-147 tokenizer already produces camel splits suitable for a real inverted index.

## [MEDIUM] performance — packages/indexer/src/query-data.ts:44 — [BEST] Postings persist full path strings per token and query-time substring expansion scans the whole vocabulary
- **Risk:** persistedPostings is Record<token, string[]> of full relative paths. In a 20k-file repo each path is repeated across hundreds of tokens, which inflates the whole-document JSON written by atomicWriteJson (index-store.ts:1074-1094) and its parse time. getPostingCandidates still does a linear Object.keys(postings) scan for every token shorter than 8 chars or without an exact posting (70, 87-98).
- **Fix:** Persist a paths[] table and store postings as sorted delta-encoded integer doc ids (or roaring bitmaps). Replace the vocabulary substring scan with an n-gram (trigram) side index or a sorted vocabulary plus prefix binary search. Fold this into the P6-T6a sqlite schema (postings table keyed by token -> blob of ids).
- **Evidence:** query-data.ts:44-50 `persistedPostings[token] = paths`; :70 `Object.keys(postings)`; :87-98 linear scan; index-store.ts:1079-1081 JSON.stringify of the whole index.

## [MEDIUM] performance — packages/indexer/src/semantic.ts:63 — [BEST]/[LANG] Semantic search recomputes stored-vector norms on every query over number[]; normalize once in Float32Array before any D12 napi kernel
- **Risk:** cosineSimilarity recomputes normB for every stored vector on every query, and vectors are boxed number[]. That is about 3x the necessary FLOPs plus poor cache locality for the ~20k x 1536 scan D12 cites as kernel evidence, so the X-2 row overstates the need for a native kernel. It is one vector per file with a 4000-char contentSample, so large files lose recall.
- **Fix:** Pre-normalize vectors at build/persist time into one contiguous Float32Array (N x dim) and score with a single dot loop plus a top-k heap. Re-measure before committing the D12 napi dot-product kernel. At P6-T6, use an ANN index (usearch/HNSW or sqlite-vec) in the daemon rather than a hand-written SIMD kernel. Consider chunk-level vectors keyed by stableChunkId.
- **Evidence:** semantic.ts:63-75 per-call normA/normB; :207-214 map/filter/sort over all vectors; :86-99 file-level embedding text capped to 4000 chars.

## [MEDIUM] api-contract — packages/indexer/src/repo-map.ts:62 — [LANG] P3-T9: personalized PageRank is the right choice, but the current repo map is alphabetical truncation, and the graph needs hub-node pruning first
- **Risk:** buildRepoMap sorts files alphabetically and slices to maxFiles=40, so on any real repo the map is the first 40 paths (often .github/ or docs). queryRepoMap re-scores with a separate tokenizer (repo-map.ts:258) that differs from tokenizeQuery (no acronym split). Running PageRank over the current graph would be dominated by shared `concept:`/`import:` hub nodes (buildGraph:805-860), because only file->file references/calls edges carry structural signal.
- **Fix:** Implement P3-T9 as personalized PageRank over a file-level CSR (Float64Array) built only from references/calls edges (plus SCIP edges from P3-T4). Personalize on the query's lexical top-k and the files in the chat. Rank symbols per file by definition in-degree (the aider approach) and render within a token budget. Share one tokenizer with query.ts. PageRank in TS is sufficient (sub-ms for 20k nodes); no Rust needed.
- **Evidence:** repo-map.ts:57-75 'Prototype-only', `.sort((a,b)=>a.path.localeCompare(b.path)).slice(0, opts.maxFiles)`; :258-264 tokenizer; metadata-indexer.ts:805-860 import/concept nodes shared across files.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md:103 — [LANG] P3-T4/P3-T5 mechanism: prefer oxc_resolver plus ecosystem tools over ts.resolveModuleName, and name scip-java (Kotlin/Scala) and the SCIP reader location
- **Risk:** P3-T5 names `ts.resolveModuleName`, which pulls the whole TypeScript compiler into the harness and covers only JS/TS. P3-T4's indexer list omits scip-java's Kotlin/Scala coverage and scip-php, and it says 'TS reader' although P6-T6 moves the index into the Rust daemon, where the `scip` crate reads protobuf natively. stack-graphs is archived upstream and should not be adopted.
- **Fix:** P3-T5: use oxc_resolver (enhanced-resolve compatible: exports/imports maps, tsconfig paths and references, pnpm symlinks) via its napi package now and natively in the daemon later. For other ecosystems, shell out to authoritative tools when present (`go list -json ./...`, `cargo metadata`, Gradle/Maven source sets, python sys.path from the active venv), with the manifest-root heuristics as fallback. P3-T4: list scip-java (Java/Kotlin/Scala), keep the TS protobuf reader as a thin interim, and put the canonical reader in the P6-T6 daemon using the `scip` crate. Label edges confidence precise/heuristic.
- **Evidence:** PLAN.md:102 P3-T4 'lang TS reader'; :103 P3-T5 '`ts.resolveModuleName`, etc.'; metadata-indexer.ts:1385-1514 hand-rolled tsconfig alias resolution (no exports maps, no project references).

## [LOW] correctness — packages/indexer/src/query-data.ts:139 — [POLY] Posting tokenizer drops non-ASCII and non-[a-z0-9_] identifier chars; query and posting tokenizers disagree
- **Risk:** normalizePostingToken strips everything outside [a-z0-9_], so Unicode identifiers (Swift/Kotlin/Haskell/Julia), Haskell primes, Ruby/Elixir `valid?`/`save!`, and Lisp/Clojure/CSS kebab names collapse or vanish from postings, while tokenizeQuery keeps Unicode. The posting camel split `([a-z0-9])([A-Z])` has no acronym rule, but tokenizeQuery (query.ts:1227-1229) has one, so exact postings miss and recall depends on the bounded substring expansion.
- **Fix:** Use one shared tokenizer with Unicode-aware classes (\p{L}\p{N}), NFKC folding, the acronym split rule, and preservation of trailing ?/! as a separate variant. Unit-test it across language identifier styles.
- **Evidence:** query-data.ts:140-155 `/([a-z0-9])([A-Z])/g`, `.replace(/[^a-z0-9_]/g, '')`; query.ts:1227-1236 acronym split plus a different delimiter set.

## [LOW] correctness — packages/indexer/src/query.ts:535 — [POLY] No per-language test-file detection in ranking
- **Risk:** There is no test-path classifier anywhere in the indexer (no matches for *_test.go, test_*.py, *Spec.scala, *_spec.rb, src/test/java, __tests__). Tests are neither down-ranked for implementation queries nor boosted for 'test for X' queries, and the depth penalty (535-536) disproportionately hits Maven/Gradle src/main/java/... layouts that are always deep.
- **Fix:** Add an isTestPath(language) predicate to the language-profile table and use it for a query-intent-aware adjustment. Replace the absolute depth penalty with a depth relative to the owning module root (e.g. src/main/java).
- **Evidence:** code_search for isTestFile|isTestPath|_test\.|spec\. in query.ts, metadata-indexer.ts, repo-map.ts, file-walker.ts returned 0 matches; query.ts:535-536 `if (depth > 4) score *= Math.pow(0.95, depth - 4)`.

## [LOW] state-mutation — packages/indexer/src/index-store.ts:1074 — [LANG] Confirmation: P6-T6a bun:sqlite WAL is the right interim store; whole-document JSON rewrite remains
- **Risk:** atomicWriteJson still serializes the entire index (files, graph, postings) per save, with tmp+fsync+rename. This is correct for crash atomicity but O(index size) per incremental update and needs the advisory lock for concurrent writers. The D14 choice of bun:sqlite WAL (zero deps, concurrent readers) is the best TS option. The daemon's redb/rusqlite store supersedes it.
- **Fix:** Proceed with P6-T6a as planned. Normalize the schema (files, edges, postings-as-id-blobs, vectors) so incremental updates are row-level upserts, and keep computeIndexSnapshotId golden vectors.
- **Evidence:** index-store.ts:1074-1094 atomicWriteJson; :757 withCacheLock; SPEC.md D14; PLAN.md:146 P6-T6a.

## Coverage receipt

### Subsystems
- packages

### Features
- query-index
- import-resolution
- semantic-search
- repo-map
- index-store
- file-walker
- command-discovery
- retrieval-quality

### Files
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/query.ts
- packages/indexer/src/query-data.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/retrieval-quality.test.ts
- packages/indexer/src/query-quality.test.ts
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
