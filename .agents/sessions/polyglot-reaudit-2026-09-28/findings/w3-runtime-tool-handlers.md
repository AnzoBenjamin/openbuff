# Audit findings: w3-runtime-tool-handlers

- Subsystems: packages
- Features: read-tools, search-tools, validation-tools, git-tools, docs-tools, plan-tools
- Files covered: 28
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:42 — [BEST] run_terminal_command hardcodes permission_profile full-access for every agent; agentTemplate is destructured but unused
- **Risk:** Read-only roles (reviewers, audit shards, researchers) that are granted run_terminal_command get the same unrestricted terminal profile as editors, so 'read-only' is only a prompt convention. allowed_paths (owned_paths) is forwarded but paired with full-access, making the scoping advisory. Any language repo is affected (cargo/gradle/pip scripts can mutate the tree).
- **Fix:** Derive permission_profile from agentTemplate (e.g. read-only / workspace-write / full-access) and the handoff permissions; default to the least-privileged profile and require an explicit template opt-in for full-access. Add a test per profile.
- **Evidence:** Line ~37-42: comment 'All agents run with the full-access terminal profile: the terminal command policy is intentionally not enforced per-agent'; `permission_profile: 'full-access',      allowed_paths: ...` (two props on one line, formatting glitch). agentTemplate is in the destructure at line 16 but never referenced.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/list-directory.ts:25 — [BEST] list_directory memory-skip fabricates a directory listing from verified-memory file paths
- **Risk:** On a 'skip' decision the handler returns up to 5 memory paths as `files` with `directories: []` for the requested path. Those paths may be nested at arbitrary depth (not direct children), subdirectories are always reported empty, and the listing is truncated to 5 entries with no truncation flag. The model receives a confidently wrong directory listing, e.g. a Rust crate root reported as having no src/ or tests/ dirs.
- **Fix:** Never skip list_directory from memory (listing cannot be derived from file excerpts), or only serve when memory holds a verified prior list_directory result for exactly that path at the same workspace revision; mark served output with provenance:'memory' and truncated:true.
- **Evidence:** buildSkipOutput (lines 25-41) maps covering excerpts to `files`, hardcodes `directories: []`; used at lines ~110-117 when cover.decision === 'skip'.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/code-search.ts:34 — [BEST] code_search/glob/find_files_matching_content memory-skip returns paths/excerpts that were never matched against the regex or glob
- **Risk:** Skip output returns verified-memory excerpts (code_search) or paths (glob, find_files_matching_content) chosen by fuzzy query overlap in evaluateMemoryCover, not by applying the ripgrep regex or glob. A glob like '**/*.py' or a regex like 'fn\s+main' can be answered with non-matching files, and absence of other matches is implied. code_search 'narrow' also rewrites `paths` to remainingGaps (project-relative) while leaving `cwd` intact, which may resolve paths relative to the wrong directory.
- **Fix:** Post-filter memory candidates with the real matcher (picomatch for glob, RegExp on cached content for code_search with flag translation) before serving, and fall through to the full call on any mismatch; when narrowing, drop cwd or rebase gaps relative to cwd. Add tests with a non-matching verified path.
- **Evidence:** code-search.ts buildSkipOutput lines 34-54 and narrow at ~136-143 (`input: { ...input, paths: narrowedPaths }`); glob.ts buildSkipOutput lines 29-49; find-files-matching-content.ts buildSkipOutput lines 31-51. None apply input.pattern to the candidates.

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/handlers/tool/query-index.ts:55 — [BEST] Memory-first discovery wrapper duplicated five times with divergent semantics
- **Risk:** code-search, glob, list-directory, find-files-matching-content and query-index each copy ~80 lines of the same buildDiscoveryQuestion/recordCoverage/evaluateMemoryCover/recordMemoryReuse flow. They already diverge: code_search and query_index record the raw cover.decision (incl. 'narrow') and narrow the call; the other three coerce to 'skip'|'full'. agentState is optional in four and required in query-index. Fixes (like the ones above) must be applied five times, and future P3-T2 LSP nav tools will copy it again.
- **Fix:** Extract a single `withDiscoveryMemory({toolName, buildQuestion, scopeOf, queryOf, skipOutput, narrow?})` helper in orchestration/discovery-coordinator and make each handler a ~10-line declaration; cover it with one parameterized test suite.
- **Evidence:** Near-identical bodies: code-search.ts 56-157, glob.ts 51-137, list-directory.ts 43-130, find-files-matching-content.ts 53-141, query-index.ts 55-142.

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/handlers/tool/get-affected-tests.ts:21 — [LANG] ~13 pass-through client handlers hand-copy input fields; should be generated from D17 JSON Schemas (also the basis for P1-T4 MCP exposure)
- **Risk:** git-status, git-branch, get-affected-tests, get-build-targets, get-change-review-bundle, run-targeted-validation, inspect-environment, inspect-workspace, write-audit-findings, read-logs, read-image, run-file-change-hooks are pure forwarders. Field-by-field copies silently drop any new schema field (e.g. a future `language`/`ecosystem` or `targets` param on get_affected_tests/get_build_targets, which is exactly where polyglot parameters will land). Style is inconsistent: some pass the CodebuffToolCall object directly (read-image, run-file-change-hooks), others rebuild input; inspect_environment forcibly sends `{}`. P1-T4 (openbuff mcp, still [ ]) would otherwise re-implement a third copy of the tool surface.
- **Fix:** Add a generic `forwardClientTool(toolName, {inject?})` that forwards schema-validated input verbatim (injecting trusted fields like owner) and register forwarders from the X-1/D17 compiled JSON Schemas; have P1-T4 MCP server enumerate tools from the same descriptor + codebuffToolHandlers table rather than hand-written MCP tool definitions. Add a golden test that every client tool schema field reaches the client call.
- **Evidence:** get-affected-tests.ts:24 `input: { files: toolCall.input.files }`; get-build-targets.ts:24 same; git-status.ts:23-28; get-change-review-bundle.ts:24 `{ max_chars }`; inspect-environment.ts:24 `input: {}`; read-image.ts:20 and run-file-change-hooks.ts:19 pass toolCall directly. PLAN.md:78 P1-T4 [ ] and :23 X-1 JSON-schema export already exists.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/read-docs.ts:68 — [POLY] read_docs is Context7-only with no ecosystem routing (docs.rs, pkg.go.dev, PyPI/readthedocs, javadoc, NuGet, hexdocs, rubydoc, cppreference)
- **Risk:** For non-JS repos the only docs path is a fuzzy Context7 title match; there is no ecosystem/version parameter, so 'serde' or 'requests' may resolve to the wrong library or none, and there is no fallback to canonical registry docs for the version pinned in Cargo.lock/go.sum/poetry.lock. The agent then falls back to generic web_search, whose only special-casing is GitHub README resolution (web-search.ts:76). The abort signal is not threaded into fetchContext7LibraryDocumentation.
- **Fix:** Add optional `ecosystem` and `version` inputs; route to per-registry adapters (docs.rs/crate/<n>/<v>, pkg.go.dev, readthedocs/PyPI project_urls, javadoc.io, learn.microsoft NuGet API, hexdocs.pm, rubydoc.info, cppreference) with Context7 as one backend; auto-infer ecosystem/version from inspect_workspace lockfiles. Thread `signal`. Add handler tests (none exist).
- **Evidence:** read-docs.ts:68-74 single call to fetchContext7LibraryDocumentation({query: libraryTitle, topic, tokens}); no signal param in destructure (lines 33-46). web-search.ts:76 resolveGitHubUrl is the only host-specific resolver.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/read-subtree.ts:340 — [POLY] read_subtree live scan is fully sequential and relies only on gitignore; build/vendor dirs exhaust the 5000-node cap
- **Risk:** buildLiveNode awaits isFileIgnored + realpath + stat per node serially (up to 5000 round trips). Exclusion depends solely on the repo's ignore files; repos without gitignore entries for target/, .venv/, __pycache__/, build/, .gradle/, bin/obj/, vendor/, Pods/, _build/, zig-cache/ spend the depth-first, alphabetically ordered budget inside them (e.g. '.gradle', '.venv', 'build' sort before 'src'), yielding truncated trees missing source dirs.
- **Fix:** Apply a shared polyglot default-exclude list (from common/project-file-tree, same list used by glob/code_search) in addition to gitignore, use breadth-first admission so top-level dirs are always represented, and bound concurrency (e.g. 16) for stat/realpath. Add a fixture test with a Rust target/ and Python .venv without gitignore.
- **Evidence:** read-subtree.ts ~lines 250-360: sequential `for (const entry of entries) { ... await buildLiveNode(...) }`, ignore check only via isFileIgnored; LIVE_SUBTREE_MAX_NODES = 5000 (line 29), entries `.sort()` depth-first.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/skill.ts:61 — [POLY] skill disk fallback returns the first match (global) though comment says project dirs take precedence
- **Risk:** loadSkillFromDisk iterates global ~/.agents and ~/.claude before project dirs and returns on first hit, so a user-global skill shadows the project's language-specific skill of the same name (e.g. a repo's own 'test' skill for pytest vs a global jest one). Not-found is reported as `content: 'Error: ...'` instead of an errorMessage field, inconsistent with other handlers. Uses sync fs in an async handler.
- **Fix:** Iterate project dirs first (or collect all and take the last), return a structured errorMessage on miss, and use fs/promises. Add unit tests (no skill handler test exists).
- **Evidence:** skill.ts:61-68 order: home .agents, home .claude, project .agents, project .claude with comment 'later takes precedence for overwriting'; loop returns at line ~102 on first valid match; miss path lines ~154-163 returns content 'Error: Skill ... not found.'

## [MEDIUM] state-mutation — packages/agent-runtime/src/tools/handlers/tool/write-todos.ts:76 — [BEST] write_todos persists to process.cwd()/.omx/state/todos-session.json shared across sessions and agents
- **Risk:** State path uses process.cwd() rather than fileContext.projectRoot, writes an untracked .omx/ directory into the user's repo (not in any ignore list, so it can show up in git_status/change-review bundles), and the fixed filename merges todos across sessions, parallel subagents and unrelated tasks via 0.85 fuzzy matching (O(n*m*L^2) Levenshtein, unbounded growth). Sync fs blocks the event loop.
- **Fix:** Keep todos in agentState (or the run journal keyed by runId/session) instead of the repo; if disk persistence is required, place it under the session artifact dir (.agents/sessions/<slug>) or OS state dir, use fs/promises with atomic write, cap list size. Add a direct handler test.
- **Evidence:** write-todos.ts:76-77 `path.join(process.cwd(), '.omx/state')`, 'todos-session.json'; lines 115-141 fuzzy merge; writeFileSync at ~146.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/find-files.ts:152 — [BEST] find_files still fires a training-context LLM call whose upload is unimplemented; config lookup uses process.cwd()
- **Risk:** When enabled, prepareExpandedFileContextForTraining runs requestRelevantFilesForTraining (a model call) and loads files, then discards them (TODO upload). isFullFileContextEnabled walks from process.cwd() instead of fileContext.projectRoot and does sync fs on every call.
- **Fix:** Remove or hard-disable the training path until an upload target exists; resolve openbuff.json from fileContext.projectRoot and memoize.
- **Evidence:** find-files.ts:152-163 prepareExpandedFileContextForTraining(...).catch; lines 226-231 TODO 'Upload mechanism not yet implemented'; line 52 `path.resolve(process.cwd())`.

## [LOW] error-handling — packages/agent-runtime/src/tools/handlers/tool/web-search.ts:93 — [BEST] Error-shape inconsistency across handlers
- **Risk:** Errors are expressed as `{errorMessage}` (web-search), `{documentation, errorMessage}` (read-docs), `content: 'Error: ...'` (skill), structured FilesystemError with code/retryable/recovery (read-subtree), or thrown/forwarded client errors (pass-throughs). Models and the P1-T4 MCP/ACP surfaces cannot uniformly detect retryable vs terminal failures.
- **Fix:** Define one ToolErrorV1 {code, message, retryable, recovery?} in common (generated into the D17 schemas) and a helper `toolError()`; migrate handlers and assert shape in a table-driven test.
- **Evidence:** web-search.ts:93-98, read-docs.ts:77-83 and 152-155, skill.ts ~158-162, read-subtree.ts subtreeError lines 43-50.

## [LOW] test-coverage — packages/agent-runtime/src/tools/handlers/tool/__tests__ — [BEST] Several in-scope handlers have no direct tests
- **Risk:** read-docs, web-search handler logic (only web-search-utils security is tested), skill, write-todos (only indirect via run-agent-step), find-files, git-status, read-image, run-file-change-hooks and write-audit-findings have no handler-level tests, so regressions in forwarding, error shape or precedence go unnoticed.
- **Fix:** Add a parameterized forwarding test for all pass-through client tools (asserting every schema field is forwarded) plus targeted tests for read-docs, skill precedence, write-todos persistence location and web-search truncation/link extraction.
- **Evidence:** __tests__ listing contains harness-read-tools, git-branch, inspect-workspace, read-logs, run-targeted-validation, get-change-review-bundle, web-search-security but no read-docs/skill/write-todos/find-files/git-status/read-image tests.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/handler-function-type.ts:27 — [LANG] P3-T2 LSP nav tools have no handler scaffolding; plan should reuse the generic forwarder and discovery-memory helper
- **Risk:** P3-T2 (go_to_definition, find_references, hover_type, workspace_symbol) is [ ] and no handlers exist in list.ts. Without the shared helpers above they will add four more hand-copied forwarders and possibly four more memory-wrapper copies; results (locations) should also feed discoveryCoverage so later reads are served from verified memory.
- **Fix:** Implement P3-T2 tools as schema-generated client forwarders with a common LSP result type (uri, range, language, server), record results via the shared discovery helper, and expose them through P1-T4 from the same registry.
- **Evidence:** list.ts:79-143 codebuffToolHandlers contains no LSP navigation tools; PLAN.md:100 P3-T2 [ ].

## Coverage receipt

### Subsystems
- packages

### Features
- read-tools
- search-tools
- validation-tools
- git-tools
- docs-tools
- plan-tools

### Files
- packages/agent-runtime/src/tools/handlers/list.ts
- packages/agent-runtime/src/tools/handlers/handler-function-type.ts
- packages/agent-runtime/src/tools/handlers/tool/code-search.ts
- packages/agent-runtime/src/tools/handlers/tool/glob.ts
- packages/agent-runtime/src/tools/handlers/tool/list-directory.ts
- packages/agent-runtime/src/tools/handlers/tool/find-files-matching-content.ts
- packages/agent-runtime/src/tools/handlers/tool/query-index.ts
- packages/agent-runtime/src/tools/handlers/tool/find-files.ts
- packages/agent-runtime/src/tools/handlers/tool/read-subtree.ts
- packages/agent-runtime/src/tools/handlers/tool/read-files.ts
- packages/agent-runtime/src/tools/handlers/tool/read-docs.ts
- packages/agent-runtime/src/tools/handlers/tool/read-image.ts
- packages/agent-runtime/src/tools/handlers/tool/read-logs.ts
- packages/agent-runtime/src/tools/handlers/tool/web-search.ts
- packages/agent-runtime/src/tools/handlers/tool/skill.ts
- packages/agent-runtime/src/tools/handlers/tool/write-todos.ts
- packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts
- packages/agent-runtime/src/tools/handlers/tool/run-file-change-hooks.ts
- packages/agent-runtime/src/tools/handlers/tool/run-targeted-validation.ts
- packages/agent-runtime/src/tools/handlers/tool/get-affected-tests.ts
- packages/agent-runtime/src/tools/handlers/tool/get-build-targets.ts
- packages/agent-runtime/src/tools/handlers/tool/get-change-review-bundle.ts
- packages/agent-runtime/src/tools/handlers/tool/git-status.ts
- packages/agent-runtime/src/tools/handlers/tool/git-branch.ts
- packages/agent-runtime/src/tools/handlers/tool/inspect-environment.ts
- packages/agent-runtime/src/tools/handlers/tool/inspect-workspace.ts
- packages/agent-runtime/src/tools/handlers/tool/write-audit-findings.ts
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
