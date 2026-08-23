# Changelog

All notable changes to the @openbuff/sdk package will be documented in this file.

## [Unreleased]

### Added

- New published task-memory API for durable cross-session task state: `loadPersistedTaskMemory`, `reconcileTaskMemoryEvidence`, `saveMergedTaskMemory`, `pruneStaleTaskMemoryEvidence`, and `codebuffFsToNodePromises`, backed by `.openbuff/memory/task-memory.json` under the project root. The complete type closure those signatures name is published alongside them so consumers can name every parameter and return type: `TaskMemoryV1`, `TaskMemoryDraftV1`, and `TaskMemoryEvidenceV1` (re-exported from `@codebuff/common/types/task-memory`), plus `TaskMemoryStoreFs`, `WorkspaceMoveRecord`, and `TaskMemoryPruneOutcome`.
  - `pruneStaleTaskMemoryEvidence` returns a discriminated `TaskMemoryPruneOutcome` rather than a nullable count pair, so "there is no record" (`status: 'no-record'`) is distinguishable from "the prune could not be committed" (`status: 'failed'`, with `reason: 'invalid-record' | 'concurrent-write' | 'write-failed'` and the `removed`/`remaining` counts the prune would have written). A successful prune is `status: 'pruned'`, including the no-op `removed: 0` case for a fully fresh record.
  - `task-memory.json` has two writers, so `revision` stays monotonic and unique across both. `saveMergedTaskMemory` re-reads the on-disk record and merges against whichever of it and the caller's `priorMemory` is newer, emitting one revision past both; pruning refuses to write when the record advanced while it was reconciling. A session that hydrated a pre-prune record therefore cannot resurrect pruned evidence under an already-published revision.
  - Persistence requires the optional `renameFile` capability on a supplied `CodebuffFileSystem`: without it a save degrades to a skipped write (`undefined`) and a prune reports `reason: 'write-failed'`, rather than writing non-atomically.
- New optional `CodebuffFileSystem` capability `streamDirectory` for lazy (bounded-memory) directory iteration, exported alongside its `CodebuffStreamDirectory` type. `list_directory` uses it to stop one entry past the entry cap instead of materializing whole directories. Implementers must (a) release the directory handle from the iterator's `return()`, which breaking out of `for await` invokes, and (b) set `streamDirectory.readdirView` to the adapter's own `readdir`. Callers ignore the capability when `readdirView` is not the adapter's current `readdir`, so an adapter that decorates `createNodeFileSystem()` (spread or `Object.create()`) and overrides `readdir` keeps serving its own view instead of the host filesystem. The capability is deliberately not named `opendir` so adapters inheriting from `fs.promises` are never auto-detected.
- New exported predicate `supportsStreamDirectory(fs)` for detecting the `streamDirectory` capability. It is the supported way to observe whether an adapter provides streaming directory iteration, because presence of the member is only half the contract: the predicate also applies the `readdirView` pairing, so it always agrees with the path `list_directory` takes. `detectFilesystemCapabilities()` is unchanged and still reports member-presence capabilities only.
- New exported constant `MAX_LIST_DIRECTORY_ENTRIES`, the `list_directory` entry cap. It is the supported way to obtain the cap now that the over-cap `errorMessage` no longer reports an observed entry count, so consumers that parsed the count no longer need to parse the message at all.
- The full `CodebuffFileSystem` type closure is now exported from the SDK (`CodebuffFileContent`, `CodebuffFileSystemBase`, `CodebuffRangeReadResult`, `CodebuffConditionalMoveOptions`, `CodebuffConditionalMoveResult` in addition to the previously published aliases), so a consumer's generated `.d.ts` resolves an adapter implementation without reaching into unpublished internals.

### Changed

- **Consumer-visible tool output:** both `list_directory` `errorMessage` texts changed. Match on the prefixes, not the tails.
  - Over the entry cap: `Directory listing too large: more than 5000 entries. List a specific subdirectory instead.`. The observed entry count and the previous `exceeds limit of 5000` phrasing are gone: the bounded read stops one entry past the cap, so the true total is never known. Consumers that parsed a count or matched `exceeds limit of` must match `Directory listing too large:` instead, and read the cap from the exported `MAX_LIST_DIRECTORY_ENTRIES` constant.
  - Any other failure: `Failed to list directory '<path>'`, with an optional ` (ERRNO)` suffix, replacing the previous `Failed to list directory: <fs message>` shape. The raw filesystem message is no longer echoed because it can name absolute paths the call never resolved; only the caller-supplied logical path and a canonical errno token are reported. Consumers that read the filesystem message out of the tail must use the errno suffix.

### Removed

- **BREAKING:** the `apply_patch` built-in tool has been removed from the published tool set (`publishedTools`/`PublishedToolName`), the client tool-call schema, the runtime tool handlers, and the SDK applicator.
- **BREAKING:** `apply_patch` is also gone from the generated agent type definitions (`agents/types/tools.ts` and the fresh-install template): the `'apply_patch'` member of the `ToolName` union, the `apply_patch` key of `ToolParamsMap`, and the `ApplyPatchParams` interface no longer exist.

### Migration guide: `apply_patch` → `edit_transaction`

- Use `edit_transaction` for all partial edits. Its `{ type: 'patch', diff }` edit type replaces `apply_patch` unified-diff patches, and it also supports `delete` and `move` edit types for removing or relocating files.
- Consumers that declare `toolNames: ['apply_patch']` must remove it from the list: unknown tool names are filtered out at runtime, so the entry no longer resolves to any tool.
- Consumers that supply `overrideTools` keyed by `PublishedToolName` must drop the `apply_patch` key; it is no longer a valid published tool name. Override `edit_transaction` instead if custom behavior is needed.
- Custom-agent authors hit this at compile time first. Update generated-type usages:
  - `ToolName` no longer includes `'apply_patch'`, so `const t: ToolName = 'apply_patch'` and any `toolNames: ToolName[]` literal containing it now fail to type-check. Use `'edit_transaction'`.
  - `ToolParamsMap['apply_patch']` no longer resolves; use `ToolParamsMap['edit_transaction']` (`EditTransactionParams`).
  - The exported `ApplyPatchParams` interface is deleted; typed `handleSteps` code that imported or referenced it should use `EditTransactionParams` instead.

## [0.11.0] - 2026-06-29

First public release of `@openbuff/sdk` (forked lineage from Codebuff SDK; see `docs/codebuff-to-openbuff-migration.md`).

### Added — Provider layer

- Multi-provider router with per-model failover chains and retry config (`ProviderConfig`, `RetryConfig`). Honors provider-declared `context.windowTokens` with a safe fallback when absent.
- New built-in tools: `git_branch`, `git_status`, `str_replace` (with `edit_transaction` atomic batch), `read_subtree`, `read_outline`, `read_image`, `query_index`, `code_search`, `run_terminal_command`, `list_directory`, `glob`, `file_picker`.
- Cost accounting + token usage tracking per run, surfaced in `RunResult.output`.
- `skillsDir` SDK option to load custom skills from a directory.
- `code_map` indexer: tree-sitter-powered symbol extraction with `query_index` graph edges, reference/blast-radius mode, and deterministic `.openbuff.d/indexing.json` schema.

### Added — Agent runtime

- `base2` orchestrator with a validation/reviewer gate, gate-repair loop, coverage verdicts, craftsmanship prompt sections, and session-state `AgentOutput` schema.
- Bundled agents: `debugger`, `doc-writer`, `git-committer`, `security-reviewer`, `test-writer`, `librarian`, `context-pruner`, `researcher`, `thinker`, `synthesizer`.
- Subagent timeouts, background agents, budget enforcement, and parallel I/O for `read_files` / `read_image`.
- `handleSteps` generators now receive `hitStepCap` in `TNext` so orchestrators can break out on the step cap instead of falling through to the gate.

### Fixed

- `suggest_followups` is now retracted mid-step the moment a file-changing tool executes (both in `base2`'s edits-detected blocks and in `tool-executor.ts`), preventing same-step follow-up suggestions after edits.
- Step-cap early-return no longer causes an infinite validation/reviewer gate loop: `runAgentStep` returns `hitStepCap`, threaded through `loopAgentSteps` → `runProgrammaticStep` → `generator.next({ hitStepCap })`, and `base2` breaks out of its `while(true)` when it fires.
- `runAgentStep` resolves the agent's model from `agentId` before failover, fixing the "Agent run error: undefined" regression.
- `prebuild-agents.ts` requires only `definition.id` (not `definition.model`), so all 30 valid agents bundle into the CLI binary instead of just the two with hardcoded models.
- `write_file` is deterministic — no longer expands `// ... rest of the function ...` snippets. Use `str_replace` or `edit_transaction` for partial edits.
- Provider config honors `context.windowTokens`; missing values fall back to a safe default.

### Changed

- Agent runs no longer have a fixed step cap by default. Unset or `-1` `maxAgentSteps` means unlimited productive steps; a repeated-step watchdog stops six identical no-progress patterns while cancellation, subagent timeouts, budgets, spawn-depth limits, and context compaction remain active.
- Removed `isLocalMode` / `localMode` flag and the `LOCAL_MODE_API_KEY` sentinel; local-mode plumbing and hosted-backend DB/auth/email surfaces purged.
- Debug-log message history capped to the last 50 messages to bound memory.
- Removed dead `_sendSubagentChunk` and per-iteration `cloneDeep`.

## [0.10.7]

- New code editing tool `apply_patch` which works well with Codex models (e.g. openai/gpt-5.3-codex). (Removed in a later release; see the `[Unreleased]` migration guide — use `edit_transaction` instead.)
- `write_file` is now a deterministic tool that creates or replaces the file. Previously, it also accepted edit snippet comments which could expand to keep a portion of the previous file, e.g. "// ... rest of the function ...". That behavior is removed to keep things simple. `str_replace` or `apply_patch` should be used if not overwriting the whole file. (`apply_patch` has since been removed; use `edit_transaction` — see the `[Unreleased]` migration guide.)

## [0.10.6]

Added `skillsDir` parameter to specify a directory to load skills from.

## [0.10.5]

Fixed a bug with missing tool calls/results.

## [0.10.4]

Updated with various agent runtime improvements.

## [0.10.1]

More reliable tool calls!

## [0.10.0]

Lots of changes in the implementation, including native tool calls under the hood. Minimal changes in the public API.

## [0.4.3]

### Added

- Exported `processToolCallBuffer` and state helpers so SDK consumers can strip `<codebuff_tool_call>` segments mid-stream.
- CLI now consumes the shared helper to avoid leaking XML when responses arrive without token streaming.
- Extra regression tests covering multi-chunk tool-call payloads based on the CLI log case ("I'll help you commit").

## [0.4.2]

### Added

- XML tool call filtering in stream chunks - filters out `<codebuff_tool_call>` tags while preserving response text
- Stateful parser handles tags split across chunk boundaries
- 50-character safety buffer for split tag detection
- Comprehensive unit tests (17 test cases)

## [0.3.1]

- `CodebuffClient.run` now does not return `null`. Instead, the `CodebuffClient.run(...).output.type` will be `'error'`.

## [0.3.0]

- New more intuitive interface for `CodebuffClient` and `CodebuffClient.run`.

## [0.1.30]

Types updates.

## [0.1.20]

- You can now retrieve the output of an agent in `result.output` if result is the output of an awaited `client.run(...)` call.
- cwd is optional in the CodebuffClient constructor.
- You can pass in `extraToolResults` into a run() call to include more info to the agent.

## [0.1.17]

### Added

- You can now get an API key from the [Codebuff website](https://www.codebuff.com/profile?tab=api-keys)!
- You can provide your own custom tools!

### Updated

- Updated types and docs

## [0.1.9] - 2025-08-13

### Added

- `closeConnection` method in `CodebuffClient`

### Changed

- Automatic parsing of `knowledgeFiles` if not provided

### Fixed

- `maxAgentSteps` resets every run
- `CodebuffClient` no longer requires binary to be installed

## [0.1.8] - 2025-08-13

### Added

- `withAdditionalMessage` and `withMessageHistory` functions
  - Add images, files, or other messages to a previous run
  - Modify the history of any run
- `initialSessionState` and `generateInitialRunState` functions
  - Create a SessionState or RunState object from scratch

### Removed

- `getInitialSessionState` function

## [0.1.7] - 2025-08-12

### Updated types! AgentConfig has been renamed to AgentDefinition.

## [0.1.5] - 2025-08-09

### Added

- Complete `CodebuffClient`
- Better docs
- New `run()` api

## [0.0.1] - 2025-08-05

### Added

- Initial release of the Codebuff SDK
- `CodebuffClient` class for interacting with Codebuff agents
- `runNewChat` method for starting new chat sessions
- TypeScript support with full type definitions
- Support for all Codebuff agent types
- Event streaming for real-time responses
