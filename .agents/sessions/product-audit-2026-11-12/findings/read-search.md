# Shard `read-search` — read, search and navigation tools

Audit date 2026-11-12, HEAD of the working tree (uncommitted changes by others exist in unrelated files; none in this scope). Read-only. Probes ran from `/tmp/rs-audit/` against a scratch project in `/tmp/rs-audit/proj` or by calling handlers in-process; nothing was written to the repo.

## Scope

Inspected:
- Schemas: `common/src/tools/params/tool/{read-files,read-subtree,read-outline,read-image,read-docs,read-logs,list-directory,glob,find-files,find-files-matching-content,code-search,query-index,inspect-workspace,inspect-environment}.ts`; `common/src/tools/constants.ts` (published/quarantined lists); `common/src/tools/compile-tool-definitions.ts`; `common/src/tools/results/filesystem.ts`; `common/src/constants/images.ts`.
- Runtime handlers: `packages/agent-runtime/src/tools/handlers/tool/{read-files,read-outline,glob,code-search,list-directory,query-index,oversize-artifact}.ts` (read fully or in the relevant parts); `get-file-reading-updates.ts`; `util/simplify-tool-results.ts`; `util/messages.ts` (trim path); `orchestration/discovery-coordinator.ts`; `util/base2-tool-tiers.ts`.
- SDK: `sdk/src/tools/{read-files,glob,list-directory,code-search,read-image}.ts`; `sdk/src/run.ts` tool dispatch (3420–3700) and `requestOptionalFile` (2211–2300).
- CLI: `cli/src/components/tools/registry.ts`, `read-files.tsx` (error rendering); `cli/src/utils/codebuff-client.ts:252-360` (query_index override); `cli/src/utils/create-run-config.ts:247`.
- Indexer: `packages/indexer/src/repo-map.ts`, defaults in `index-manager.ts:150`.
- Agents: `agents/base2/tool-tiers.ts`, `agents/base2/base2.ts:582,588,658`, `agents/general-agent/general-agent.ts:114`, `agents/researcher/researcher-docs.ts:30`.
- Tests run (all pass, 135 tests): `./sdk/src/__tests__/{read-files,glob,list-directory,code-search,read-image}.test.ts`, `./packages/agent-runtime/src/tools/handlers/tool/__tests__/{glob-memory,code-search-memory}.test.ts`, `./packages/agent-runtime/src/__tests__/structural-read.test.ts`. Note: running `bun test sdk/src/__tests__/read-files.test.ts` without `./` also matches 26 archived copies under `docs/execution/body-roadmap/evidence/**` that fail with "Cannot find module"; that is a test-harness hazard, not a product bug.

Skimmed only (size/entry points, no line-level review): `read-subtree.ts` (588 lines), `structural-read.ts` (975), `read-authority-ladder.ts`, `edit-read-state.ts`, `find-files.ts` + `find-files/` (quarantined), `read-docs.ts`, `read-logs.ts`, `inspect-*.ts`, SDK `find-files-matching-content.ts` (quarantined), `packages/indexer/src/*` internals (covered by prior 08-indexer findings and card B26).

Skipped: LSP navigation tools (`go_to_definition`, `find_references`, `hover_type`, `workspace_symbol`) belong to the language-intelligence shard; `recall_context` belongs to the memory shard. Edit-authority internals (cap.v4 tokens) were covered by 06-edits/B05 and are referenced only where they change what a read returns.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| `read_files` (paths, ranges, windows, around, symbol, symbols) | `common/.../read-files.ts:452-505` | runtime `handlers/tool/read-files.ts`; SDK `sdk/src/tools/read-files.ts` | `sdk/src/__tests__/read-files.test.ts`, runtime `read-files-*.test.ts`, `read-outline-slices.test.ts` | useful (no model-size cap, see RS-02) |
| `read_outline` | `read-outline.ts` | runtime `read-outline.ts` + `structural-read.ts` (tree-sitter, regex fallback, markdown headings) | `structural-read.test.ts`, `read-outline-slices.test.ts` | useful |
| `read_subtree` | `read-subtree.ts` | runtime `read-subtree.ts` (4k-token default budget) | `harness-read-tools.test.ts` | useful |
| `read_image` | `read-image.ts` | SDK `read-image.ts` | `sdk/src/__tests__/read-image.test.ts` | partial (no downscale, BMP/TIFF) |
| `read_logs` | `read-logs.ts` | runtime + SDK `read-logs.ts` (200 lines / 20k chars) | `read-logs.test.ts` (both) | useful |
| `read_docs` (Context7) | `read-docs.ts` | runtime `read-docs.ts` | — (not inspected) | partial; only `researcher-docs` gets it |
| `list_directory` | `list-directory.ts` | SDK `list-directory.ts` + `bounded-readdir.ts` | `list-directory.test.ts`, `list-directory-memory.test.ts` | useful (symlinks hidden) |
| `glob` | `glob.ts` | SDK `glob.ts` | `glob.test.ts`, `glob-memory.test.ts` | partial (unbounded, memory skip) |
| `code_search` (ripgrep) | `code-search.ts` | SDK `code-search.ts` (bundled rg) | `code-search.test.ts`, `code-search-memory.test.ts`, CLI `code-search.test.tsx` | useful (memory skip bug) |
| `query_index` | `query-index.ts` | CLI override `cli/src/utils/codebuff-client.ts:252`; `packages/indexer` | `query-index.test.ts` (runtime, CLI) | useful in CLI; unwired in bare SDK |
| `find_files` (LLM file picker) | `find-files.ts` | runtime `find-files.ts`, `find-files/` | — | unwired (quarantined, `constants.ts:173`) |
| `find_files_matching_content` | `find-files-matching-content.ts` | SDK `find-files-matching-content.ts` | `find-files-matching-content.test.ts` | unwired (quarantined, `constants.ts:174`) |
| `inspect_workspace` / `inspect_environment` | `inspect-workspace.ts`, `inspect-environment.ts` | SDK `inspect-workspace.ts`, `inspect-environment.ts` | `inspect-workspace.test.ts` | useful |
| Repo map (Aider-style ranked map) | none | `packages/indexer/src/repo-map.ts:80-96` ("prototype-only … not used by the default query_index path") | eval-only | unwired |
| Memory-first discovery short-circuit | implicit in glob/list_directory/code_search/query_index handlers | `orchestration/discovery-coordinator.ts:617-786` | `glob-memory.test.ts` etc. | broken (RS-01) |

## Findings

### read-search-01 — Memory-first short-circuit returns fabricated glob, list_directory and code_search results
- **Axis:** reliability (correctness). **Severity:** HIGH (only when memory v2 is enabled; it is opt-in, `sdk/src/services/memory-v2/coordinator.ts:1348`).
- **Evidence:** `glob.ts:96-127`, `list-directory.ts:96-131` (skip output at `:25-40` sets `directories: []` and has no "from memory" message), `code-search.ts:105-141` (skip output `:32-51` prints memory excerpts as stdout), `query-index.ts:103-128`. The cover test `discovery-coordinator.ts:743-771` only checks that a verified-memory file path lies under the `cwd`/`path` prefix. Pattern tokens that don't look like paths are dropped (`:690-705`), so the pattern is never checked against the served files.
- **Probe (in-process, memory containing only `src/auth/login.ts`):**
  - `glob({pattern:'Dockerfile', cwd:'src'})` → `{files:['src/auth/login.ts'], count:1, message:'Served from verified memory…'}`. The returned file does not match the pattern. `glob('**/*', cwd:'src')` → 1 file.
  - `list_directory({path:'src'})` → `{files:['src/auth/login.ts'], directories:[], path:'src'}`. This is a nested path presented as a direct child. The real `auth`/`db` directories are gone, and the result carries no provenance marker.
  - `code_search({pattern:'TODO|FIXME', cwd:'src'})` → stdout `src/auth/login.ts: export function login() {}`, which is not a match.
- **Impact:** the model concludes that files or matches don't exist, or exist where they don't, and then edits, plans or reports on that basis. The existing tests (`glob-memory.test.ts:96`) assert the skip happens. They never assert that the result matches the pattern.
- **Fix:** remove the skip for exhaustive-enumeration tools (glob, list_directory, code_search). They answer "all X", which a 5-excerpt memory cannot cover. If reuse stays for query_index, label results `provenance:'memory'` and still require each served path to satisfy the query. Add negative tests: a non-matching pattern must hit the filesystem.
- **Prior:** new (not in the 2026-11-05 findings; only inventoried).

### read-search-02 — `read_files` has no model-facing size cap: a single call can return 10 MB (aggregate 20 MB)
- **Axis:** usability / reliability (performance, token cost). **Severity:** HIGH.
- **Evidence:** `sdk/src/tools/read-files.ts:60-67` sets `MAX_RENDER_CHARS = MAX_FILE_BYTES` (10 MiB, `common/src/tools/results/filesystem.ts:21-22,34`). The head/tail truncation branch is documented as unreachable (`read-files.ts:714-716,797-803`). Window/around/symbol blocks share the same 10 MiB budget (`common/.../read-files.ts:22`). No per-result cap exists in `packages/agent-runtime/src/tools/` (grep for `countTokens|MAX_*CHARS|truncat` finds only argument-truncation recovery). A stale comment still claims a 100k-char cap: `sdk/src/run.ts:2219-2221`. Introduced by `ed8ed09a3` (2026-07-22).
- **Probe:** a 3.2 MB single-line minified `big.js` and a 4.3 MB 60k-line `many.txt` both returned `status:'ok'` with the full content (7.57 MB JSON in one result). There is no per-line cap, while code_search cuts lines at 1,000 chars (`sdk/src/tools/code-search.ts:38`).
- **Impact:** one careless `paths` read of a lockfile, bundle or log can exceed the context window (about 1M tokens for 4 MB). It also spends the whole turn's cost and triggers emergency history trim (see RS-03). The windows default of 400 lines is no protection for long lines.
- **Fix:** add a model-visible budget of about 25k tokens or 50–100 KB per result plus a per-line cap (about 2,000 chars). Over budget, return a `partial` result with `nextWindow`/`offset` guidance, as Claude Code (25k tokens, `PARTIAL view` notice, refuse >256 KB whole reads) and Pi/OpenCode (2,000 lines / 50 KB, 2,000 chars per line) do. Keep the 10 MB gate only for edit validation (`requestOptionalFile`). Fix the stale comment.
- **Prior:** related to B05 (accepted; it bounds *allocation*, `PLAN.md:516-524`) and 06-F11. The model-visible size is not covered.

### read-search-03 — Context trim strips read content but keeps `complete:true` and the whole-file editAnchor
- **Axis:** reliability (state). **Severity:** MEDIUM (static inference; not executed end to end).
- **Evidence:** `util/messages.ts:756-786` simplifies tool results newest-first when over budget. `simplify-tool-results.ts:39-64` removes `content` and adds `contentOmittedForLength:true`, but keeps `status`, `complete` and `editAnchor` (`const { content: _content, ...rest }`). Authority lives in `fileProcessingState` (`handlers/tool/read-files.ts:262-275`), so it survives.
- **Impact:** after an oversized read (RS-02), the model holds a whole-file `readCapability` for bytes it never saw. It can then `write_file`/`replace_range` with that authority. The omission marker gives no reason and no recovery hint.
- **Fix:** when content is omitted, drop or downgrade `editAnchor`, set `complete:false` and add `recovery:'read_smaller_range'`. Alternatively, prevent the situation with RS-02's cap.
- **Prior:** new.

### read-search-04 — `glob` is unbounded and has no `limit`/`offset`
- **Axis:** usability / reliability (performance). **Severity:** MEDIUM.
- **Evidence:** schema `common/.../glob.ts:8-27` has only `pattern`/`cwd`. SDK `glob.ts:116-131` returns every match and runs `fs.stat` for each one in an unbounded `Promise.all`. Probe on this repo: `**/*` → 2,706 paths, 128,099 chars (about 32k tokens); `**/*.ts` → 2,112 paths, 100,885 chars.
- **Impact:** a common first exploratory call costs tens of thousands of tokens. On large monorepos it costs much more, plus an fd/stat storm.
- **Fix:** default `limit` of 100–200 with `truncated`/`nextOffset` and the total count, matching `list_directory`'s paging contract. Bound stat concurrency (`mapWithConcurrency`, already used in `read-files.ts`). Claude Code caps Glob at 100 (A.md §1.1) and OpenCode defaults to 100 with a 30 s timeout (B.md §1.1).
- **Prior:** new.

### read-search-05 — PDFs, notebooks and non-UTF-8 text get misleading or no support
- **Axis:** completeness / usability. **Severity:** MEDIUM.
- **Evidence:** `sdk/src/tools/read-files.ts:290-335`. A NUL byte gives `binary`, and a UTF-16 BOM or invalid UTF-8 gives `unsupported_encoding` with `recovery:'use_supported_encoding'`. Probe: `doc.pdf` → "The file is not valid UTF-8 text."; `latin1.txt` (one `é`) → refused; `nb.ipynb` → raw JSON (80 chars), with no cell/output structure; `bin.dat` → `[FILE_BINARY]`. Image formats are redirected only by prompt text (`base2.ts:582`), not by the error.
- **Impact:** the model gets no actionable next step for PDFs (Claude Code reads pages, Gemini CLI and OpenCode pass PDFs to the model) or for notebooks (Claude Code returns cells plus outputs). Latin-1/Windows-1252 sources in legacy repos are unreadable without the shell.
- **Fix:** typed errors per kind (`pdf`, `image`, `archive`) with a recovery that names the right tool. Add a PDF page-range path (text extraction or provider-native PDF input). Render `.ipynb` cells. Optionally decode Latin-1/UTF-16 read-only and flag it so edits refuse, as Claude Code does with U+FFFD.
- **Prior:** new.

### read-search-06 — `read_image` sends raw bytes (up to 10 MB each, 25 MB total) and advertises BMP/TIFF
- **Axis:** reliability / completeness. **Severity:** MEDIUM.
- **Evidence:** `sdk/src/tools/read-image.ts:21,196-233,248-262` has no resize or re-encode, and its `Promise.all` fan-out runs before the 25 MiB budget. `common/src/constants/images.ts:8-17` maps `.bmp`/`.tiff`. The comment at `:106` says "allow larger files since we can compress", but read_image never compresses. The schema says absolute paths must be inside the project root (`read-image.ts:19,42`), yet the SDK honours external read roots (`read-image.ts:150-165`).
- **Impact:** major providers reject oversized images and BMP/TIFF media types, so the turn fails with a provider error instead of a tool error. Claude Code auto-downscales (A.md §1.1), and Pi resizes per model (B.md §3.1).
- **Fix:** downscale and re-encode to PNG/JPEG under the provider limit before attaching. Convert BMP/TIFF or drop them from the advertised list. Bound read concurrency before the byte budget. Align the schema text with external read roots.
- **Prior:** the fan-out matches C12 ("image read fan-out exceeds returned budgets", `CAPABILITIES.md:50`) and 13-perception §31. It is still present at `read-image.ts:248`. The downscaling and format issues are new.

### read-search-07 — Read/search definitions cost about 7.8k tokens. base2's read surface alone costs about 5.7k, and code_search's prose is duplicated and inaccurate.
- **Axis:** usability (model-facing token cost) / cohesion. **Severity:** MEDIUM.
- **Evidence:** measured with `compileToolJsonSchemas()` plus `description` (chars/4): code_search 1,684, read_files 1,460, find_files_matching_content 1,140, query_index 781, read_docs 516, find_files 389, list_directory 323, read_subtree 299, glob 286, read_logs 280, read_image 250, read_outline 197, inspect_workspace 106, inspect_environment 55; total about 7,764. base2's core and tier read tools (`base2-tool-tiers.ts:31-52,81-87,99`) sum to about 5.7k before the LSP tools. code_search's description (4.5 KB) repeats a tip (`code-search.ts:59` and `:61`). It claims "Searches file content and filenames" (`:67`); ripgrep matches content only. It says hidden files are ignored (`:68`) while the SDK adds "blessed" hidden dirs (`sdk/src/tools/code-search.ts:220-232`). It also carries an `end_turn` warning (`:90`). base2's system prompt restates the tiered read policy twice (`base2.ts:588`, 1,766 chars; `:658`, 1,057 chars) and calls the token `cap.v3`, while `read-files.ts:461` and the runtime use `cap.v4` (`common/src/util/content-hash.ts:289`).
- **Impact:** Pi ships its whole system prompt plus tools in under 1k tokens (B.md §3.3). Every Openbuff turn pays about 6k tokens for read/search definitions before any work starts. The inaccurate lines give the model wrong expectations.
- **Fix:** cut code_search's description to about 1.5 KB (flags table, limits, one example), delete the false and duplicated lines, and drop the `end_turn` note. Move the cap/authority narrative out of `read_files` into one short paragraph. Keep the read policy in one place in base2 and fix the token version.
- **Prior:** new.

### read-search-08 — Contradictory selection guidance between root schema descriptions and tool descriptions
- **Axis:** cohesion / usability. **Severity:** MEDIUM.
- **Evidence:** the root schema descriptions shipped to providers say: read_files "Use this tool to read as many files as would be helpful" (`common/.../read-files.ts:465`), while its description says to prefer slices (`:453`). code_search says "Use this tool only when read_files is not sufficient to find the files you need" (`code-search.ts:44`) and "Prefer to use read_files instead of code_search" (`:49`). read_files cannot search. find_files tells the model to run `find -name` via `run_terminal_command` (`find-files.ts:42`), which contradicts base2's "use dedicated tools instead of shelling out" rule (`base2.ts:588`). find_files is quarantined, but its text is maintained.
- **Impact:** mixed signals about when to search versus read, and inherited Codebuff-era guidance that pushes whole-file reads.
- **Fix:** rewrite the root `.describe()` strings to one neutral sentence each, or drop them so `description` is the single source.
- **Prior:** new.

### read-search-09 — Remaining overlap: two quarantined tools are still registered, and read_files has six selector kinds
- **Axis:** cohesion. **Severity:** LOW (quarantine already removed the worst overlap).
- **Evidence:** `find_files` and `find_files_matching_content` are in `publishedTools` (`constants.ts:104-105`) and in base2's MODE_NEUTRAL list (`agents/base2/tool-tiers.ts:51-52`), yet quarantined (`constants.ts:169-178`). `code_search -l` (`code-search.ts` flags) already covers "files containing X". In the live surface, discovery spans glob, list_directory, read_subtree, query_index and workspace_symbol, and content search spans code_search, query_index (`references`) and find_references. read_files has `ranges` and `windows` (both line spans), and `symbol` and `symbols` (one vs batch). Its schema needs four preprocess repair layers to absorb model confusion (`read-files.ts:128-420`, with a repair counter at `:226`). code_search exposes no timeout (fixed 10 s, `sdk/src/tools/code-search.ts:67`), while find_files_matching_content exposes `timeoutSeconds`.
- **Impact:** a larger decision surface for the model and more preprocess repairs. The overlap is moderate: each live tool has a distinct job (name pattern, one directory, tree with symbols, ranked graph search, regex).
- **Fix:** delete `find_files` and `find_files_matching_content` once persisted histories age out, or keep compatibility stubs out of `publishedTools`. Collapse read_files to `paths` + `ranges` (offset/limit semantics; windows become a `ranges` page hint) + `around` + `symbols` (with optional `occurrence`). Mention `code_search -l` in one line.
- **Prior:** new.

### read-search-10 — Path-listing inconsistencies in glob and list_directory
- **Axis:** usability / correctness. **Severity:** LOW.
- **Evidence:** when glob's `cwd` resolves outside the project it returns absolute paths sorted alphabetically (`sdk/src/tools/glob.ts:26-41`), which contradicts "sorted by modification time" (`common/.../glob.ts:24-26`). list_directory drops every entry that is neither a regular file nor a directory, including symlinks to directories (`list-directory.ts:75`). Its entries keep raw readdir order (probe: `node_modules` listing unsorted). It returns no sizes or types, and the default page is 5,000 entries (about 19k chars for this repo's `node_modules`).
- **Impact:** symlinked packages or workspaces are invisible. Order changes between calls. Default pages are large.
- **Fix:** follow symlinks (marking them), sort names, add an optional `size`, and default to 500 entries per page. Make external-cwd glob honour mtime ordering.
- **Prior:** new.

### read-search-11 — Retrieval is CLI-only, and the Aider-style repo map exists but is unwired
- **Axis:** completeness / cohesion. **Severity:** LOW.
- **Evidence:** `query_index` exists only as a CLI override (`cli/src/utils/codebuff-client.ts:252-360`). `sdk/src/run.ts` has no branch for it, and the MCP server answers with a disabled payload when no index is injected (`sdk/src/mcp/server.ts:461-465`). `repo-map.ts:80-96` is marked "prototype-only … not used by the default query_index path", even though PageRank already exists (`packages/indexer/src/pagerank.ts`, exported at `index.ts:55`). The CLI sends only paths as project context (`create-run-config.ts:247-249`).
- **Impact:** SDK users get base2 prompts that say "start with query_index" (AGENTS.md) and a tool that cannot answer. No compact ranked map is injected up front, which is the feature that makes Aider efficient with weak models.
- **Fix:** ship a default IndexManager-backed handler in the SDK, or remove query_index from SDK-only toolsets. Evaluate a token-budgeted ranked map (Aider's default is 1k tokens) as an optional first-turn context block.
- **Prior:** the SDK half matches C16 ("SDK needs host override", `CAPABILITIES.md:54`) and is still present. The repo map half is new.

### read-search-12 — Missing-file and outside-project errors give no candidates
- **Axis:** usability. **Severity:** LOW.
- **Evidence:** `sdk/src/tools/read-files.ts:436-444` returns `{code:'not_found', message:'[FILE_DOES_NOT_EXIST]', recovery:'discover_path'}`. Probe: `src/missng.ts` gets no "did you mean src/missing.ts". read_outline reports a missing file inside the `outline` string (`read-outline.ts:52-58,73-79`) instead of the schema's `errorMessage` field.
- **Impact:** costs an extra glob/query_index round trip per typo. The read_outline error shape is inconsistent.
- **Fix:** add up to 3 nearest paths from the project file tree (basename edit distance) to `not_found` errors. Put read_outline failures in `errorMessage`.
- **Prior:** new.

## Competitive gaps

| Capability | Best-in-class CLI and how | Openbuff state | Priority |
|---|---|---|---|
| Bounded read pages | Claude Code: 25k-token cap, `PARTIAL view` notice, whole-read refusal >256 KB, `allow_large` opt-in. Pi/OpenCode: 2,000 lines / 50 KB, 2,000 chars per line (B.md §1.1, §3.1) | 10 MB per result, no line cap (RS-02) | P0 |
| Bounded glob/grep | Claude Code Glob 100 results, Grep `head_limit`/`offset`/`count` modes. OpenCode glob/grep default 100 with 30 s timeout | code_search bounded (250 / 20k chars); glob unbounded (RS-04) | P1 |
| PDF reading | Claude Code `pages` ranges (≤20 pages per call). Gemini CLI and OpenCode pass PDF to the model | refused as "not valid UTF-8" (RS-05) | P1 |
| Notebook reading | Claude Code returns cells and outputs; `NotebookEdit` | raw JSON | P2 |
| Image downscale | Claude Code auto-downscale; Pi model-specific resize | raw bytes, BMP/TIFF pass-through (RS-06) | P1 |
| Minimal definitions | Pi: system prompt + 4 tools < 1k tokens; Codex: no read/grep tools at all (shell) | about 5.7k tokens for base2's read surface (RS-07) | P1 |
| Ranked repo map | Aider: tree-sitter + PageRank map within `--map-tokens` (1k) | prototype only (RS-11) | P2 |
| Content-hash anchored reads | oh-my-pi hashline (B.md §3.8) | cap.v4 tokens plus `around` anchors (Openbuff ahead) | — |
| Graph-aware code search | Kiro `code` tool (tree-sitter + LSP + knowledge, A.md §4.1) | query_index modes + read_outline + LSP tools (parity or ahead in CLI) | — |
| `.gitignore`-aware discovery | Gemini glob honours `.gitignore`/`.geminiignore`; Kiro `.kiroignore` | glob/code_search use project tree / rg ignore rules; list_directory lists ignored dirs | P3 |

## Strengths
- **Content-anchored and symbol-scoped reads.** `around` (literal anchor + context) and `symbol(s)` slices paired with tree-sitter `read_outline` (`common/.../read-files.ts:52-102`, `structural-read.ts`) avoid line-number drift. None of Claude Code, Codex, OpenCode or Pi ships both built in.
- **Typed, actionable error envelope.** Every read item carries `code` / `retryable` / `recovery` (`sdk/src/tools/read-files.ts:93-164,436-454`). The CLI renders the error code per row (`cli/src/components/tools/read-files.tsx:44-51`).
- **Graph retrieval with explicit status.** `query_index` reports index state, staleness, coverage and parser budgets in every result (`common/.../query-index.ts:173-271`), and it falls back to an honest "disabled" payload (`codebuff-client.ts:256-280`).
- **Hardened ripgrep wrapper.** Flags are allowlisted, `--no-config` is set, lines are truncated at 1,000 chars, output is capped at 20k chars and 250 matches, the timeout is SIGTERM then SIGKILL, and abort kills rg (`sdk/src/tools/code-search.ts:38,58-110,200-400`).
- **Paged directory listing with errno-only errors** that never leak resolved real paths (`sdk/src/tools/list-directory.ts:52-131`).
- **Read containment.** The single-dereference read resolver (`read-image.ts:141-160`; `read-files.ts:182-278`) closes symlink TOCTOU on reads. Claude Code leaves reads open by default (A.md §1.4).
- **Bounded `read_subtree` (4k tokens) and `read_logs` (200 lines / 20k chars) defaults**, with explicit truncation levels.

## Roadmap mapping

| Finding | Mapping |
|---|---|
| read-search-01 memory-first fabrication | not covered (closest: B12 memory lifecycle, which does not address discovery skips) |
| read-search-02 no model-facing read cap | not covered (B05 accepted for allocation bounds only) |
| read-search-03 trimmed read keeps authority | not covered (B03/B05 touch authority evidence, not trim) |
| read-search-04 unbounded glob | not covered |
| read-search-05 PDF/notebook/encoding | not covered |
| read-search-06 read_image raw bytes / formats | partially (fan-out under C12/B05 trace); downscale/format not covered |
| read-search-07 definition token cost / inaccurate prose | not covered |
| read-search-08 contradictory guidance | not covered |
| read-search-09 overlap / quarantined tools | not covered |
| read-search-10 glob/list_directory inconsistencies | not covered |
| read-search-11 SDK query_index, repo map | partially (C16 → B26 retrieval generations; SDK default handler and repo map not covered) |
| read-search-12 missing-file candidates | not covered |
