# Shard `language-intel`: LSP tools, code-map, indexer features, audit/review tools

HEAD: `f5aba489d`. Working tree had unrelated uncommitted changes by others; this shard changed nothing in the repo. Probes ran against a `git archive HEAD` copy in `/tmp/lang-intel-probe/` or read the live tree without writing.

## Scope

Inspected (read in full or in the relevant parts):
- Schemas: `common/src/tools/params/tool/{go-to-definition,find-references,hover-type,workspace-symbol,audit-intelligence,get-change-review-bundle}.ts`.
- Runtime forwarders: `packages/agent-runtime/src/tools/handlers/tool/{go-to-definition,find-references,hover-type,workspace-symbol,audit-intelligence,get-change-review-bundle}.ts` (all are 28–46-line pass-throughs to `requestClientToolCall`).
- SDK: `sdk/src/run.ts` (LSP service lifetime 1571–1591, 2514–2519, dispatch 3712–3736, post-commit sync 3960–3964); `sdk/src/services/language-intelligence.ts`; `sdk/src/services/lsp-multiplexer.ts`; `sdk/src/tools/{go-to-definition,hover-type,workspace-symbol,audit-intelligence,get-change-review-bundle}.ts`; `sdk/src/services/audit-intelligence.ts`.
- Registry: `common/src/util/language-capabilities.ts`, `common/src/util/language-profiles.ts`.
- Code-map: `packages/code-map/src/languages.ts` (query and WASM resolution), `parse.ts` budgets.
- Indexer: `packages/indexer/src/{index-manager,index-store,query,repo-map,scip-ingest}.ts` (feature level only).
- Packaging: `cli/scripts/build-binary.ts:655-675`, `.github/workflows/cli-release-build.yml:400-470,600-650`, `cli/release/index.js:20-90`, `sdk/scripts/build.ts:85-120,400-430`.
- Consumers: `packages/agent-runtime/src/util/base2-tool-tiers.ts`, `agents/base2/tool-tiers.ts`, `agents/base2/base2.ts` (prompt and tier resolution), `agents/specialists/create-specialist.ts`, `cli/src/components/tools/language-intelligence.tsx`, `cli/src/commands/index-command.ts`.
- Prior work: `docs/audits/read-write-indexing-2026-07-14/findings/indexing-retrieval.md`, body review `findings/07-languages.md` and `08-indexer.md`, PLAN cards B06/B23–B27, live ledger status, sibling shards `findings/read-search.md` and `findings/write-edit.md`.

Executed (read-only):
- `bun test` in `sdk/` for `lsp-real-server`, `lsp-multiplexer` and `language-intelligence`: 90 pass, 0 fail, 2.7 s. The real-server cases cover clangd only.
- `bun test` in `packages/code-map`: 170 pass, 2 fail. Both failures are GDScript `parseFileStructure` cases.
- Cold `buildMetadataIndex` on the archive copy (probe `/tmp/lang-intel-probe/probe.ts`).
- `inspectCodebaseStructure` on the live tree and on the archive copy (probe `/tmp/lang-intel-probe/audit.ts`).
- Definition-size estimate via `compileToolJsonSchemas()` plus description, chars/4 (probe `/tmp/lang-intel-probe/tok.ts`).
- Language-server availability check on this machine with `command -v`.

Skipped:
- `query_index` usage and read-path tools (owned by read-search) and edit-side LSP tools `rename_symbol`/`code_action`/`extract_symbol` application (owned by write-edit and B06). I cite them only where they affect this shard.
- The indexer test suite was not rerun. Prior receipt: 413 pass (08-indexer).
- No real TypeScript, Python, Rust or Go language server could be exercised: only `clangd` is installed (see LI-07). Claims about those servers' behaviour are marked as traced from code, not executed.

## Feature inventory

| feature | entrypoint | implementation | tests | maturity |
|---|---|---|---|---|
| `go_to_definition` / `find_references` / `hover_type` | schemas above; base2 CORE (`base2-tool-tiers.ts:40-43`) | `run.ts:3712-3729` → `language-intelligence.ts:682-740` → `lsp-multiplexer.ts` | `lsp-multiplexer.test.ts`, `language-intelligence.test.ts` (fake peers); `lsp-real-server.test.ts` (clangd only, skip-gated) | partial: works only for servers already on PATH; cold every turn (LI-01) |
| `workspace_symbol` | schema; base2 CORE | `language-intelligence.ts:743-753`, `lsp-multiplexer.ts:1262-1330,1480-1497` | fake-peer only; no test for the cold or empty case at the service level | partial: returns an empty success when cold (LI-02) |
| Post-edit LSP document sync | automatic after commits | `run.ts:3960-3964` → `language-intelligence.ts:959-1040` | unit | partial: sync works, but the version authority is split (07-F4, still present) |
| LSP diagnostics | none | server messages dropped at `lsp-multiplexer.ts:569` | none | absent (LI-04) |
| Server acquisition and status | none (PATH only) | `language-capabilities.ts:131-566` (11 stdio specs + GDScript TCP); `detect` argv never read | none | absent (LI-07) |
| Tree-sitter symbols, imports and calls (code-map) | indexer, `read_outline` | `packages/code-map/src/languages.ts:265-310,470-530` | 170/172 code-map tests pass (GDScript fails) | useful in checkout; degraded in release tarball (LI-05) |
| Local index (`/index status|rebuild|explain|scip`) | `cli/src/commands/index-command.ts:165-345` | `packages/indexer` | indexer suite | useful; persistence near its byte ceiling (LI-06) |
| SCIP precise edges | `/index scip` (manual opt-in) | `index-command.ts:288-345`, `scip-ingest.ts` | `scip-*.test.ts` | partial: edges are lost at the next rebuild (08-F5); identity truncation (07-F3) |
| PageRank ranking | none (`pageRankWeight` option) | `query.ts:250,295,684` | `pagerank.test.ts` | unwired: no caller sets the weight (LI-13) |
| Ranked repo map | none | `repo-map.ts:80-96` | eval-only | unwired (read-search-11), and unranked (LI-13) |
| `inspect_codebase_structure` / `inspect_feature_completeness` / `evaluate_audit_coverage` | base2 `audit` tier (unlocked by default) | `sdk/src/tools/audit-intelligence.ts`, `sdk/src/services/audit-intelligence.ts` | `audit-intelligence.test.ts` | partial: unbounded and synchronous (LI-11) |
| `get_change_review_bundle` | base2 `audit` tier; base2 gate calls it programmatically (`base2.ts:3671,3957`) | `sdk/src/tools/get-change-review-bundle.ts` | `get-change-review-bundle.test.ts`, gate e2e | useful for the gate; heavy as a model tool (LI-12) |

Short answers to the brief's key questions:
- **Which languages work end-to-end in an installed build?**
  - LSP navigation works for any of the 11 stdio-launchable languages whose server the user has installed on PATH. Nothing installs, detects or reports servers. On this developer machine only clangd is present, so the LSP tools fail for this TypeScript monorepo.
  - Tree-sitter symbol, call and import extraction should be absent in every language for users of the official release tarball, because the tarball omits the query files (07-F1/B24, still present). Installed-tarball behaviour was not executed; this is traced from the packaging code.
  - The local install on this machine has a hand-placed `~/.config/openbuff/tree-sitter-queries/`, which hides the problem.
- **LSP lifecycle.** Servers start lazily and live for one `run()`, meaning one user prompt. A crash restarts the server once. Orphan-on-framing-error (07-F5) and duplicate document versions (07-F4) are still present. Nothing tracks indexing readiness, so cold results can be stale or partial.
- **Diagnostics after edits.** There are none from LSP. The command-based diagnostic delta is opt-in (write-edit F05).
- **Index freshness and build time.**
  - Watchers and deltas keep the index fresh (08-F7/F9 residuals aside).
  - A cold build of this 2,652-file repo took 21.9 s and 838 MB RSS and produced 60 MB of JSON.
  - Persistence fails past an estimated 4k files (LI-06).
- **Repo-map ranking.** None. PageRank exists but is off, and the repo map sorts by path.
- **Do models use these tools?**
  - base2 exposes all 4 LSP read tools plus the audit trio on every turn, with no prompt guidance.
  - No eval has run since the tools shipped on 2026-10-03 (`68e000f13`).
  - Usage is unmeasured (LI-08).

## Findings

### language-intel-01 — Language servers live for one prompt, so every turn cold-starts and results can be partial
- **Axis:** reliability / completeness. **Severity:** HIGH
- **Evidence:**
  - The service is created lazily inside `runOnce`: `sdk/src/run.ts:1571-1591`. It is disposed at the end of the same run: `run.ts:2514-2519`, "Dispose warm language servers".
  - The CLI calls `client.run()` once per user message: `cli/src/hooks/use-send-message.ts:807`.
  - Cold start covers only `initialize`, with a 15 s startup timeout and a 10 s request timeout: `lsp-multiplexer.ts:37-38,340-371`.
  - Every server→client message is dropped (`lsp-multiplexer.ts:569`), including `$/progress` and `window/workDoneProgress/create`. The client therefore cannot tell when a server has finished loading the project.
- **Impact:**
  - On large TypeScript and Rust projects, the first `find_references` of each turn pays the full project load. Its answer can come from a half-loaded project (rust-analyzer and tsserver answer before indexing completes; behaviour traced, not executed).
  - Users pay that cost again on the next prompt.
  - Claude Code and OpenCode V1 keep servers for the whole session.
- **Fix:**
  - Scope the multiplexer to the CLI session or client, not the run, and keep per-run execution leases.
  - Add an idle timeout.
  - Track `$/progress` begin/end and report `indexing: true` (or wait a bounded time) instead of returning partial results as complete.
- **Prior:** new. B20 lists "persistent toolchain-specific LSP" as a later gate. B25 covers server life but not session scope.

### language-intel-02 — `workspace_symbol` returns an empty success when no server is warm
- **Axis:** usability / reliability. **Severity:** HIGH
- **Evidence:**
  - `workspace_symbol` never cold-starts a server. It polls for a warm one for `WARM_ANCHOR_TIMEOUT_MS = 2_000` (`lsp-multiplexer.ts:1262,1290-1302`) and returns `null`.
  - The service maps `null` to `{ symbols: [] }` (`language-intelligence.ts:744-753`, `(result ?? [])`).
  - The schema promises "a structured unavailable result when no language server is present" (`workspace-symbol.ts:16-17`).
  - Without a file context the query goes to the most-recently-warm server of any language (`lsp-multiplexer.ts:1274-1290`). After a Python hover, a TypeScript symbol search asks pyright.
  - No query-scoping parameter exists, and no service-level test covers the null case (`language-intelligence.test.ts:196-211` only checks the populated case).
- **Impact:**
  - Because of LI-01, every turn starts cold. Symbol search by name, the most natural first LSP call, returns "no results" after a 2 s stall.
  - The model concludes that the symbol does not exist. The TUI renders "no results" (`language-intelligence.tsx:166-172`).
- **Fix:**
  - Return `unavailable: { reason: 'no-warm-server' }`.
  - Accept an optional `path` or `language` and cold-start that language's server.
  - Pin the null-to-unavailable mapping with a test.
- **Prior:** new.

### language-intel-03 — Mixed position conventions make off-by-one errors likely for models and users
- **Axis:** usability / cohesion. **Severity:** HIGH
- **Evidence:**
  - Input `line` is 1-based and `character` is 0-based (`go-to-definition.ts:33-44`, same in find-references and hover-type).
  - Output `range` is passed through as raw 0-based LSP on both axes (`language-intelligence.ts:197`). The output schema does not state its base (`go-to-definition.ts:15-24`).
  - The TUI displays results as 1-based line and column (`language-intelligence.tsx:64-77`), so a user who copies the displayed column into a call is off by one.
  - `read_files` shows line numbers but not columns, so the model has to count characters to supply `character`.
  - No call accepts a symbol name, even though `read_files` already supports `symbol` slices (read-search strengths).
- **Impact:**
  - A model that reads `range.start.line: 41` and then calls `read_files` at line 41 lands one line early.
  - Chained calls (definition, then hover at the returned position) have to convert between bases by hand.
- **Fix:**
  - Emit 1-based `line`/`column` in outputs, keeping raw LSP as `lspRange`.
  - Accept `symbol` (plus an optional `line`) as an alternative to `character`, and resolve the column server-side.
  - Document the base on every field.
- **Prior:** new.

### language-intel-04 — LSP diagnostics are never collected, although servers already receive every edit
- **Axis:** completeness. **Severity:** HIGH
- **Evidence:**
  - Server notifications are discarded (`lsp-multiplexer.ts:569`).
  - The client capabilities advertise only synchronization, definition, references, hover and documentSymbol (`:350-356`). They include neither `publishDiagnostics` nor pull diagnostics.
  - No code anywhere handles `textDocument/publishDiagnostics` or `textDocument/diagnostic` (search across sdk, packages, common and cli).
  - Committed edits are already pushed to warm servers as `didChange` (`run.ts:3960-3964`), so the expensive half of the loop exists.
- **Impact:**
  - The model gets no type or lint feedback after an edit from the servers it is already running.
  - Claude Code reports LSP diagnostics after every edit (A.md §1.1). OpenCode V1 did the same, and V2 users complained when it was removed (B.md §1.1, issue #50916).
- **Fix:**
  - Advertise `publishDiagnostics` and buffer per-URI diagnostics with their versions.
  - After `syncMutatedFiles`, wait a bounded interval for diagnostics newer than the synced version.
  - Attach new errors to the `edit_transaction` result.
  - Reply to server requests (07-F9) so that servers which need `workspace/configuration` also work.
- **Prior:** write-edit F05 (post-edit diagnostics off by default; command-based) and 07-F9 (server requests ignored, still present at `:569`). Partially B25 and B27.

### language-intel-05 — Release tarball still ships no tree-sitter queries, and the failure is invisible
- **Axis:** reliability / completeness. **Severity:** HIGH
- **Evidence:**
  - `build-binary.ts:659-675` copies the queries into `cli/bin/tree-sitter-queries/`.
  - Both tar lists add only the binary, `tree-sitter*.wasm` and the manifest (`.github/workflows/cli-release-build.yml:458-468` and `642-649`). The smoke step copies only WASM (`:408-409`).
  - The npm wrapper moves only WASM, the manifest, `libopentui.dylib` and `rg` (`cli/release/index.js:52-68`).
  - `resolveQueryPath` falls through silently (`packages/code-map/src/languages.ts:265-310`). The resulting failure is logged only under `DEBUG_PARSING` (`:460-530`).
  - `/index status` reports no "symbols unavailable" state (`index-command.ts:350-385`).
  - Missing WASM grammars self-repair in binaries (`languages.ts:430-440`); queries have no such path.
  - On this machine, `~/.config/openbuff/tree-sitter-queries/` was placed by hand on 2026-11-10, which masks the bug in local testing.
- **Impact:**
  - Users of the official tarball get an index with no symbols, calls or imports in any of the 14 languages.
  - `query_index` graph modes degrade to path and content search while the index status reads ready.
- **Fix:**
  - Add `tree-sitter-queries/` to both tar lists and to the wrapper's managed siblings, or embed the `.scm` files as text in the binary.
  - Make the smoke test assert non-empty symbols.
  - Surface "query unavailable" in index status.
- **Prior:** 07-F1 / B24 (pending). Still present at HEAD.

### language-intel-06 — Index persistence is at its byte ceiling on a 2.7k-file repo
- **Axis:** reliability / performance. **Severity:** MEDIUM
- **Evidence:**
  - Live cache size: `.codebuff-index/metadata.json` is 61,080,434 bytes. The load and write cap is `MAX_METADATA_INDEX_BYTES = 64_000_000` (`index-store.ts:722`). The code comment there still says "measured 47.4MB on this repo".
  - Component sizes: files 18.6 MB, graph 28.2 MB, queryData 15.5 MB.
  - Probe on the archive copy: a cold `buildMetadataIndex` took 21.9 s and 838 MB RSS for 2,652 files. It produced 148,918 edges and 60.0 MB serialized.
  - Over the cap, the write side first drops queryData and parseData (the parse cache), then chunks (`index-store.ts:252-271,370-395`).
  - "Tier 4" skips persistence entirely ("serving in-memory only", `:263-270`).
  - The files and graph alone are about 17 KB per file. My estimate is therefore that above roughly 4k files nothing persists, and every CLI start does a full walk and parse. The default `maxFiles` is 20,000 (`index-manager.ts:150`).
  - The cache lives inside the repo. It holds 209 MB here, including 99 MB of orphaned `metadata.json.*.tmp` files from interrupted writes. No sweep removes them (`index-store.ts:1153-1180`).
- **Impact:**
  - On medium and large repos, the index is rebuilt on every launch (tens of seconds and close to 1 GB RSS, extrapolated).
  - Persistence quietly stops working.
- **Fix:**
  - Use a partitioned or binary store (SQLite is already proposed in B22), or compact the graph (it is half the bytes).
  - Measure 10k- and 20k-file fixtures.
  - Sweep stale `.tmp` files on lock acquisition.
- **Prior:** new. Related to B26 ("bounded caches"; 08-F2 covers vectors only).

### language-intel-07 — LSP tools are advertised unconditionally, with no server detection, install path or docs
- **Axis:** usability / cohesion. **Severity:** MEDIUM
- **Evidence:**
  - Every language spec carries a `detect` argv (for example `language-capabilities.ts:133`), but nothing reads it. The only `.detect` consumer in sdk and cli is unrelated (`cli/src/utils/open-file.ts:86`).
  - Servers are spawned from PATH as plain argv (`:131-566`).
  - On this machine 10 of the 11 binaries are missing. `node_modules/.bin` has `tsserver` but not `typescript-language-server`.
  - A missing binary emits a child `error`, which `handleGone('spawn error')` turns into a `crashed` LspServerError (`lsp-multiplexer.ts:333-339,596-605`). The service then returns `errorMessage`, not `unavailable` (`language-intelligence.ts:665-680`). This is traced, not executed.
  - The TUI then shows "— error" instead of "no language server" (`language-intelligence.tsx:184-189`).
  - There is no negative caching, so each call respawns the missing binary.
  - No docs page covers LSP: `docs/agents-and-tools.md` has no section, and no `/lsp` or doctor check exists.
  - Definition cost per turn: go_to_definition 180, find_references 180, hover_type 187, workspace_symbol 111 tokens (about 660), plus rename_symbol, code_action and extract_symbol (about 730).
- **Impact:**
  - Most users carry about 1.4k tokens of tools on every turn that cannot work for them.
  - They get "crashed" errors with no hint about which server to install.
  - Claude Code shows its LSP tool only after a code-intelligence plugin is installed (A.md §1.1).
- **Fix:**
  - Probe `detect` once per session.
  - Expose the LSP tools only when a server for a workspace language is present, or defer them through `tool_search`.
  - Map ENOENT to `unavailable: { reason: 'not-installed', install: '<hint>' }`.
  - Add `/lsp status` and a docs page.
- **Prior:** new.

### language-intel-08 — base2 gives no guidance on LSP tools, and their use has never been measured
- **Axis:** usability. **Severity:** MEDIUM
- **Evidence:**
  - base2 prompts discuss `code_search`, `query_index` and read tiers (`agents/base2/base2.ts:588,598,728-732`). No agent prompt mentions definition, references, hover or symbol tools (search across `agents/{base2,editor,specialists,…}`).
  - The tools were added on 2026-10-03 (`68e000f13`).
  - All 87 eval trajectory JSONs under `evals/` that contain tool calls date from 2026-07-10. They hold 942 `code_search`, 430 `query_index` and 4,352 `read_files` calls, and naturally 0 LSP calls.
  - No eval since then exercises LSP tools.
  - The one local chat on record (2026-11-12) has 28 `read_files` calls and 0 LSP calls. That is anecdotal.
- **Impact:**
  - Nothing shows whether the LSP tools pay for their definition tokens, or when the model should prefer them to `code_search`/`query_index`.
  - `find_references` overlaps with `query_index references` and `code_search` (read-search-08 lists the overlap).
- **Fix:**
  - Add a buffbench slice with a TS repo and an installed server, and record LSP call rate and success.
  - Add one routing line to base2: precise cross-file navigation goes to LSP when available; otherwise `code_search`.
- **Prior:** new. Overlap noted in read-search-08.

### language-intel-09 — Monorepo roots exceed the server pool, and references may be scoped to one package
- **Axis:** reliability. **Severity:** MEDIUM
- **Evidence:**
  - TypeScript root markers are `tsconfig.json`, `jsconfig.json`, `package.json`, in that order (`language-capabilities.ts:134`).
  - This repo has 17 `tsconfig.json` files. `DEFAULT_MAX_SERVERS = 4` (`lsp-multiplexer.ts:36`), so moving between packages evicts and restarts servers (`:898-930`).
  - Each server's `rootUri` is the nearest package, so references to a `common/` symbol used in `sdk/` or `cli/` depend on that one tsserver project's view. This is inferred and was not executed.
  - The nearest-marker bug is still present: the loop breaks only when `root !== parentDir` (`:687-697`).
  - The document `languageId` is the profile ID, for example `typescript` for `.js` (07-F8, `:1109,1508`).
- **Impact:** In multi-package repos `find_references` can be silently incomplete, and server churn adds latency.
- **Fix:**
  - Prefer the workspace root (the nearest `package.json` with `workspaces`, or the git root) for tsserver.
  - Send `workspaceFolders`.
  - Raise the pool size or make it configurable.
  - Fix 07-F6 and 07-F8.
- **Prior:** 07-F6 and 07-F8 (still present). B25 partially; pool and monorepo root policy are new.

### language-intel-10 — LSP results are unbounded and verbose
- **Axis:** usability / performance. **Severity:** MEDIUM
- **Evidence:**
  - There is no count cap on references, definitions or symbols. The only limit is the 8 MB frame cap (`lsp-multiplexer.ts:40`).
  - `includeDeclaration: true` is always sent (`:1339`).
  - Each location carries both an absolute `uri` and an absolute `path` (`language-intelligence.ts:180-197`). The TUI's `shortenPath` relative to a project-relative `basePath` cannot shorten absolute paths (`language-intelligence.tsx:62-64,160-163`).
  - Results carry no source-line snippet, so every hit needs a follow-up read.
  - `workspace_symbol.kind` is a raw LSP enum number (`workspace-symbol.ts:28`).
- **Impact:** References to a common symbol (a logger, for example) can return thousands of duplicated absolute paths, and the model still has to read each file.
- **Fix:**
  - Add `limit` (default about 100) with `truncated` and `total` fields.
  - Return project-relative paths only.
  - Include a one-line preview.
  - Name the symbol kind.
- **Prior:** new.

### language-intel-11 — `inspect_codebase_structure` ignores `.gitignore`, blocks the event loop and returns megabytes
- **Axis:** reliability / performance / usability. **Severity:** HIGH
- **Evidence:**
  - The walk uses `readdirSync` with a hard-coded ignore set and `.agents/sessions/` only (`sdk/src/services/audit-intelligence.ts:35-44,120-142`). `.gitignore` is not consulted.
  - It hashes every file synchronously (`:160-200`).
  - The tool calls it synchronously (`sdk/src/tools/audit-intelligence.ts:63-70`).
  - `inspect_feature_completeness` and `evaluate_audit_coverage` re-walk and re-hash the whole tree on every call (`attestInventory`, `:34-61`).
  - Probe on the live tree: 38.1 s blocking, 84,290 files (80,917 of them in the gitignored `docs/execution/body-roadmap/evidence/`), and 20.5 MB of JSON, about 5.1M tokens. `files` alone is 14.3 MB, `tests` 3.2 MB and `commands` 2.3 MB.
  - The same probe on a clean archive copy: 0.58 s, 2,716 files, 193 KB (about 48k tokens).
  - No result-side cap was found between SDK dispatch and history. `trimMessagesToFitTokenLimit` (`packages/agent-runtime/src/util/messages.ts:554`) may cut the result later; that was not verified.
- **Impact:**
  - The tool meant to make audits measurable can freeze the SDK for tens of seconds per call and overflow any context window on repos with ignored build output.
  - Even on a clean repo, one call costs about 48k tokens.
- **Fix:**
  - Walk with git (`git ls-files -co --exclude-standard`) and make the walk asynchronous.
  - Return counts and per-subsystem summaries with paging instead of full file lists.
  - Cache the snapshot by git tree plus a dirty-file hash.
- **Prior:** new.

### language-intel-12 — `get_change_review_bundle` and the audit trio are heavy as always-on model tools
- **Axis:** usability / cohesion. **Severity:** MEDIUM
- **Evidence:**
  - Model calls default to `max_chars: 200_000`, about 50k tokens (`get-change-review-bundle.ts:745-751`).
  - The 1,050-character description is mostly snapshot-token rules ("bare hex evidence-only … never pass as params.snapshot_id", `get-change-review-bundle.ts:14-15`).
  - base2 unlocks every non-core tier by default (`base2.ts:422-428`; `base2-tool-tiers.ts:83-89`), so the audit trio (about 900 tokens; `evaluate_audit_coverage` alone 674) and the bundle (265) sit on every turn.
  - The gate already calls the bundle programmatically with `includeToolCall: false` (`base2.ts:3671-3674,3957-3960`).
- **Impact:**
  - About 1.2k definition tokens per turn for tools that matter only in audit or review flows.
  - A single unbounded call can flood the context.
- **Fix:**
  - Lower the model-call default to about 20k with paging.
  - Keep the audit tier locked until the broad-audit guide triggers.
  - Move the snapshot-token rules into the result's `snapshotIdUsage` only.
- **Prior:** new. Definition-cost theme as read-search-07.

### language-intel-13 — PageRank and the repo map exist but rank nothing
- **Axis:** completeness / cohesion. **Severity:** LOW
- **Evidence:**
  - `pageRankWeight` defaults to 0 (`packages/indexer/src/query.ts:250`), and no caller in cli, sdk, packages or evals sets it.
  - `buildRepoMap` sorts files by path and slices `maxFiles` (`repo-map.ts:85-95`), so there is no ranking at all.
- **Impact:** The Aider-style "most referenced symbols within a token budget" primer (B.md §2.1) is two small steps away but unused.
- **Fix:**
  - Rank repo-map entries with the existing `personalizedPageRank` (seeded by chat files), under a token budget.
  - Measure with `evaluateRetrievalQuality` before turning on `pageRankWeight`.
- **Prior:** read-search-11 (repo map unwired). The unranked sort and the dead PageRank weight are new detail.

### language-intel-14 — Prior language and LSP findings re-checked at HEAD: all still present
- **Axis:** reliability. **Severity:** MEDIUM (aggregate; individual severities are in the prior IDs)
- **Evidence:**

  | Prior finding | Location at HEAD | What is still there |
  |---|---|---|
  | 07-F2 | `common/src/util/language-profiles.ts:150-163` | `return extnameResult` drops bare `.py`/`.rs`/`.go`/`.java`/`.rb`. |
  | 07-F3 | `packages/indexer/src/scip-ingest.ts:34-40` | `capScipSymbol` slices identity to 160 chars. |
  | 07-F4 | `language-intelligence.ts:613` vs `lsp-multiplexer.ts:1109` | Separate version counters; query didOpen uses version 1. |
  | 07-F5 | `lsp-multiplexer.ts:596-605,1514-1521` | `handleGone` nulls the child without killing it; dispose does not join restarts. |
  | 07-F6 | `:687-697` | Nearest-marker bug. |
  | 07-F8 | `:1109,1508` | Profile ID sent as the document languageId. |
  | 07-F9 | `:569` | Server requests ignored. |

  GDScript structure extraction still fails 2 code-map tests.
- **Impact:** The existing LSP tools still return results after an edit that may be stale, and can orphan servers.
- **Fix:** Per B23/B24/B25.
- **Prior:** 07-F2–F9; B23, B24, B25 (all `pending` in `docs/execution/body-roadmap/ledger.json`).

## Competitive gaps

| capability | best-in-class CLI and how it does it | Openbuff state | priority |
|---|---|---|---|
| Diagnostics after each edit | Claude Code: LSP diagnostics reported automatically after edits (A.md §1.1). Aider: `--auto-lint`/`--auto-test` (B.md §2.1). OpenCode V1: about 30 servers fed diagnostics back. | None from LSP (LI-04); command delta is opt-in (write-edit F05) | P1 |
| Server acquisition | Claude Code: per-language code-intelligence plugins. OpenCode V1: auto-installed servers. | PATH only; `detect` unused; ENOENT reads as "crashed" (LI-07) | P1 |
| Session-lifetime warm servers | Claude Code and OpenCode V1 keep servers for the session | Per-prompt lifetime (LI-01) | P1 |
| Symbol search by name | Kiro `code` tool: tree-sitter symbol search over 18 languages without LSP (A.md §4.1) | `workspace_symbol` needs a warm server and returns empty when cold (LI-02); `query_index` symbol search is a partial substitute | P1 |
| Implementations, call hierarchy, document symbols | Claude Code LSP tool covers all three | `documentSymbol` exists in the multiplexer (`lsp-multiplexer.ts:1462`) but no tool exposes it; no call hierarchy (only heuristic `query_index neighbors`) | P2 |
| Name-addressed positions | Kiro `code` takes symbol names | Requires a 0-based column (LI-03) | P2 |
| Ranked repo map | Aider: tree-sitter + PageRank under `--map-tokens` (1k default) | Unranked prototype; PageRank off (LI-13, RS-11) | P2 |
| AST pattern search/rewrite | Kiro `code` pattern_search/pattern_rewrite | Absent | P3 |
| Minimal surface | Pi: 4 tools, no LSP, under 1k tokens of prompt and tools (B.md §3.1, §7) | About 1.4k tokens of LSP tools plus about 1.2k of audit/review tools on every turn (LI-07, LI-12) | P2: expose conditionally or deferred |

Cost/benefit against Pi's no-LSP approach:
- Today Pi's approach wins for most Openbuff users. With no server installed, the LSP tools cost about 660–1,400 tokens per turn and fail. With a server installed, they cold-start each prompt and answer `workspace_symbol` with an empty list.
- The value case is real but needs three things that already have most of the plumbing:
  - session-scoped servers (LI-01);
  - post-edit diagnostics, because the servers already receive `didChange` (LI-04);
  - conditional exposure (LI-07).
- With those in place, Openbuff would beat Pi (bash + `tsc`) on feedback latency and precision. It would also beat OpenCode V2, which removed LSP. Until then, deferring the tools behind detection costs nothing and removes the downside.

## Strengths

- **LSP works in the bare SDK.** Dispatch lives in `sdk/src/run.ts:3712-3736`, not in a CLI override, so unlike `query_index` (read-search-11), headless SDK users get navigation when a server exists.
- **Honest, contained plumbing.**
  - Results are typed `unavailable`/`errorMessage` (`language-intelligence.ts:158-176,665-680`).
  - Every server-supplied path is checked for containment before it is read (`resolveSplicePath` at `:319`, used by `openFile` at `:643-652`).
  - Cold starts are single-flight (`lsp-multiplexer.ts:966-990`), pending requests are bounded (`:39`) and frames are capped (`:40`).
  - 90/90 LSP tests pass, including real clangd definition and rename fixtures.
- **Post-edit document sync.** Committed edits are pushed to warm servers as `didChange`/`didClose`, bounded and fail-open (`language-intelligence.ts:959-1040`). OpenCode V2 has no LSP runtime at all (B.md §1.1).
- **Semantic edits beyond read-only LSP.** `rename_symbol`, `code_action` (organize imports) and `extract_symbol` go through the transactional edit path (`run.ts:3737+`). Claude Code's LSP tool is navigation-only in A.md §1.1.
- **Index transparency nobody else ships.** `/index explain <query>` shows ranking provenance (`index-command.ts:260-288`). Status reports coverage, parser budgets and diagnostics (`:350-385`). Opt-in `/index scip` merges precise SCIP edges under a snapshot guard (`:288-345`). Aider's map, Pi and OpenCode V2 have nothing comparable (B.md §5 table).
- **Fixed since the July audit.** Parser-budget truncation is now reported in coverage (`packages/code-map/src/parse.ts:269-272,374-403`; this repo's cache shows `parser.truncated` fields). Global call resolution is now family-scoped (`parse.ts:878-890`).

## Roadmap mapping

| finding | roadmap coverage |
|---|---|
| language-intel-01 per-prompt server lifetime, no readiness | partially: B25 (server life) and B20 (persistent LSP gate deferred); session scope and `$/progress` not covered |
| language-intel-02 cold `workspace_symbol` returns empty | not covered |
| language-intel-03 position conventions | not covered |
| language-intel-04 no LSP diagnostics | partially: B25 (client requests, 07-F9) and B27 (validation); diagnostics capture not covered |
| language-intel-05 queries missing from release | covered by B24 (pending) |
| language-intel-06 metadata cap and build cost | partially: B26 (bounded caches); metadata/graph size, tmp sweep and large-repo measurements not covered |
| language-intel-07 unconditional exposure, no detection | not covered |
| language-intel-08 no prompt guidance, no evals | not covered |
| language-intel-09 monorepo roots and pool | partially: B25 (07-F6, 07-F8); pool size and workspace-root policy not covered |
| language-intel-10 unbounded LSP results | not covered |
| language-intel-11 `inspect_codebase_structure` unbounded and synchronous | not covered |
| language-intel-12 bundle/audit tool weight | not covered |
| language-intel-13 PageRank and repo map unranked | partially: read-search-11 (not on roadmap); not covered by any B-card |
| language-intel-14 prior 07-F2–F9 still present | covered by B23, B24, B25 (all pending) |
