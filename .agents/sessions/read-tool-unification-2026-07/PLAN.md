# PLAN — Unify the read tool surface onto `read_files`

<!-- current-task: none -->

Three milestones. M1 is correctness-only with no public schema change. M2 is the contract
change. M3 is deprecation/cleanup. Each milestone is independently shippable and gated.

Validation commands used throughout:
- `cd packages/agent-runtime && bun run typecheck && bun test src/__tests__/read-blocks.test.ts src/__tests__/read-files-edit-state.test.ts`
- `cd common && bun run typecheck && bun test src/tools`
- `cd sdk && bun run typecheck && bun test src/__tests__/read-files.test.ts`
- `cd cli && bun run typecheck && bun test src/components/tools`
- `cd agents && bun run typecheck && bun test __tests__`
- repo-wide: `bun run typecheck`

---

## M1 — Correctness: authority ladder + bounds + ecosystem wiring (no schema change)

### M1-T1 — Extract the shared coverage→authority ladder

New file `packages/agent-runtime/src/tools/handlers/tool/read-authority-ladder.ts`.

```ts
export type ReadBlockAuthority = 'whole_file' | 'scoped' | 'none'

export type ReadBlockCoverage = {
  complete: boolean
  startLine: number
  endLine: number
  totalLines: number
  /** Exact undecorated normalized text. Numbered display content is NOT accepted. */
  sourceContent: string | undefined
  /** False for heuristic regex symbol slices (no parser proof). */
  capabilityEligible?: boolean
}

/**
 * Single source of truth for "what does this observed block authorize".
 * whole_file requires ALL of: complete, startLine === 1, endLine === totalLines,
 * a real sourceContent string. Anything else is scoped at best. Fails closed.
 */
export function classifyReadBlockAuthority(c: ReadBlockCoverage): ReadBlockAuthority {
  if (!c.complete) return 'none'
  if (c.capabilityEligible === false) return 'none'
  if (c.sourceContent === undefined) return 'none'
  if (c.startLine === 1 && c.endLine === c.totalLines && c.totalLines > 0) return 'whole_file'
  return 'scoped'
}
```

Do NOT move `grantWholeFileReadAuthorization` — it stays in `write-file.ts`; the ladder only
decides, callers act.

### M1-T2 — Rewire `read_files` onto the ladder

In `packages/agent-runtime/src/tools/handlers/tool/read-files.ts` (~lines 215–290) replace
the two hand-rolled branches (`selector === 'file'` and the `selector === 'range'` +
`startLine === 1 && endLine === totalLines` check) with one loop calling
`classifyReadBlockAuthority`. Behavior must be byte-identical to today:

- `'whole_file'` → `wholeFileGrantPaths.add(path)`, delete
  `confirmedPostEditAnchorsByPath[path]`, and when `strictReadBeforeEdit` call
  `grantWholeFileReadAuthorization(fileProcessingState, path, sourceContent)`.
- `'scoped'` / `'none'` → no grant.
- The existing `context_compacted` post-loop rule (preserve unless in `wholeFileGrantPaths`)
  is unchanged.

For the `file` selector, pass `sourceContent: result.content` and
`{startLine: 1, endLine: <line count of content>, totalLines: <same>}` so a complete
whole-file read classifies as `whole_file` exactly as before.

### M1-T3 — `read_blocks` grants whole-file authority on full coverage (R1)

In `read-blocks.ts`:
- import `classifyReadBlockAuthority`, `grantWholeFileReadAuthorization`.
- Track `const wholeFileGrantPaths = new Set<string>()` alongside `successfulReadPaths`.
- After building each `window` / `around` item, classify with the block's real
  `sourceContent` and `totalLines`; on `'whole_file'` add to `wholeFileGrantPaths`, delete
  `confirmedPostEditAnchorsByPath[path]`, and grant when `strictReadBeforeEdit`.
- Symbol slices pass `capabilityEligible: Boolean(slice.readCapability)` and never classify
  as whole_file unless they genuinely span 1..totalLines.
- Replace the unconditional `context_compacted` `continue` with the same
  `!wholeFileGrantPaths.has(path)` guard `read_files` uses.

### M1-T4 — Bound `windowSize` / `contextLines` (R3)

In `common/src/tools/params/tool/read-blocks.ts` add shared caps next to the existing
defaults and export them for reuse in M2:

```ts
export const MAX_WINDOW_SIZE = 5_000       // lines
export const MAX_CONTEXT_LINES = 2_000     // lines per side
```

Apply `.max(MAX_WINDOW_SIZE)` / `.max(MAX_CONTEXT_LINES)` and mention the cap in each
`.describe()`.

In `read-blocks.ts`, after slicing a block, check its byte length against
`MAX_RANGE_READ_BYTES` (re-export it from `common` or mirror the constant — do NOT import
`sdk` into `agent-runtime`; the value already lives in `sdk/src/tools/read-files.ts:41`, so
introduce `MAX_READ_BLOCK_BYTES = 4_194_304` in the `common` read-blocks params module and
have the SDK constant reference it in M2). Over budget → emit
`status:'error'`, `code:'too_large'`, `recovery:'read_smaller_range'`, no `editAnchor`.

### M1-T5 — Context-pruner recognizes `read_blocks` (R7)

In `agents/context-pruner.ts`:
- add `'read_blocks'` to the tool list at ~line 161;
- add a `case 'read_blocks':` next to `case 'read_files':` (~line 229) summarizing
  `windows: path:win`, `around: path@match#occ`, `symbols: path#name`, and ending with the
  same "(re-fetch with … if needed)" pointer, naming `read_blocks`;
- extend the `kind === 'read_files_result'` failure-text collector (~line 962) to also match
  `'read_blocks_result'`;
- extend the inspection-path tracking at ~1062/~1105 to accept `read_blocks` inputs and
  `read_blocks_result` values.

### M1-T6 — CLI renderer for `read_blocks` (R7)

New `cli/src/components/tools/read-blocks.tsx`, modeled directly on `read-files.tsx`:
reuse the `ReadDiagnostics` shape (`findToolResultByKind(outputRaw, 'read_blocks_result')`),
`recoveryLabel`, and `getReadStatus` logic; selector labels are
`path:win N`, `path@"match"#occ`, `path#symbol`. Register it in
`cli/src/components/tools/registry.ts`.

Note the load-time invariant in `registry.ts`: it throws when
`toolMetadata[tool].renderer === 'custom'` and no component is registered. If you also set
`read_blocks` to `renderer: 'custom'` in `common/src/tools/metadata.ts`, both edits must land
together. Prefer registering the component first and updating metadata in the same
transaction.

### M1-T7 — Grant `read_blocks` to the remaining read-capable agents (R7)

Add `'read_blocks'` to `toolNames` for the agents that already have `read_files` but not
`read_blocks`: `agents/test-writer/test-writer.ts`, `agents/doc-writer/doc-writer.ts`,
`agents/reviewer/code-reviewer.ts`, `agents/security-reviewer/security-reviewer.ts`,
`agents/general-agent/general-agent.ts`, `agents/thinker/thinker.ts`,
`agents/debugger/debugger.ts`, `agents/synthesizer/synthesizer.ts`, and the specialists via
`agents/specialists/create-specialist.ts`. Confirm each file's current list by reading it
first — do not add the tool to an agent that deliberately has no file-read access
(`file-picker`, `code-searcher`, `basher`, `git-committer` are read-discovery/exec agents;
check before touching).

### M1 validation gate

- `packages/agent-runtime` typecheck + `read-blocks.test.ts` + `read-files-edit-state.test.ts`
- `common` typecheck + `bun test src/tools`
- `agents` typecheck + `bun test __tests__` (context-pruner, tool-reachability, roster-drift)
- `cli` typecheck + `bun test src/components/tools`
- New tests: A1, A2, A3, A4, A5 from SPEC.

### M1 tests to author

In `packages/agent-runtime/src/__tests__/read-blocks.test.ts`:
1. window covering `1..totalLines` on a strict-mode state → `readAuthorizationsByPath[path]`
   is `true` and `readAuthorizationHashesByPath[path]` equals the content hash.
2. window covering a sub-range → neither map is set, but `editAnchor.readCapability` decodes
   to the block bounds.
3. `around` block that happens to span the whole file → whole-file grant.
4. seeded `editRereadRequirementsByPath[path] = {reason:'context_compacted'}` → cleared by (1),
   preserved by (2).
5. `windowSize` at the cap succeeds; a resolved block over `MAX_READ_BLOCK_BYTES` returns
   `too_large` with no `editAnchor`.
6. heuristic (non-parser) symbol slice still exposes no `editAnchor` and no grant.

In `common/src/tools/__tests__/read-files-schema.test.ts`: `windowSize`/`contextLines` above
the caps are rejected.

---

## M2 — Contract: unified selector surface on `read_files`

### M2-T1 — Extend the `read_files` input schema (R4)

In `common/src/tools/params/tool/read-files.ts`, add `windows` and `around` arrays with the
exact shapes already defined in `read-blocks.ts` (reuse by importing the per-selector object
schemas — export them from the read-blocks params module rather than duplicating). Update:

- the `superRefine` emptiness check to include the two new arrays;
- `inferSingleSelectorPath` so `windows` and `around` also inherit a single `paths[0]`
  shorthand (this is the silent-break risk in SPEC);
- the tool `description` to document the five selectors and the authority ladder;
- the example call to include one `windows` and one `around` entry.

### M2-T2 — Unify the result item union (R4, R5)

In `common/src/tools/results/filesystem.ts`:
- move `readBlocksWindowItemSchema` / `readBlocksAroundItemSchema` /
  `readBlocksSymbolItemSchema` into `readFilesItemV1Schema`'s union (the error item's
  `selector` enum already lists `window`/`around`/`symbol`);
- add optional `referencedBy: z.record(z.string(), z.string().array()).optional()` to the
  range/window/around/symbol item schemas (R5), and keep the existing `.strict()` calls valid;
- keep `readBlocksResultV1Schema` / `buildReadBlocksResultV1` / `isReadBlocksResultV1`
  exported for M3's forwarding surface, but define them in terms of the shared item union;
- preserve every existing `superRefine` invariant, notably "partial results cannot expose
  exact source content or edit capabilities".

### M2-T3 — One handler serves both tools

Refactor `read-files.ts` to accept the five selector groups and produce one ordered result
array. Extract the per-selector block builders currently in `read-blocks.ts`
(window/around/symbol) into a shared module — natural home:
`packages/agent-runtime/src/structural-read.ts` already owns `findLiteralOccurrences` and
`selectSymbolSlice`, so add `buildWindowBlock` / `buildAroundBlock` there and have both
handlers call them. `requestIndex` ordering is
`paths → ranges → windows → around → symbols`.

### M2-T4 — Manifest-first oversized reads (R6)

In `read-files.ts`, when a `paths` read is rejected/truncated for size, instead of returning
only the failure, emit the window manifest for that path plus its first window (a `window`
selector item with `windowSize`/`windowCount`/`totalLines`) so the agent can page
immediately. Keep the failure information in the same result (`status:'partial'` +
`truncation`), and mint no whole-file capability for it.

### M2-T5 — Regenerate the public type surface (R7, A8)

Run `bun scripts/generate-tool-definitions.ts` — it writes
`common/src/templates/initial-agents-dir/types/tools.ts`, `agents/types/tools.ts`,
`.agents/types/tools.ts`, then chains `cli/scripts/generate-init-type-sources.ts` for
`cli/src/data/initial-agent-type-sources.generated.ts`. All four must be committed;
`cli/knowledge.md:868` documents that CI verifies they are current.

### M2 validation gate

Repo-wide `bun run typecheck`, plus `common`/`agent-runtime`/`sdk`/`cli`/`agents` test
suites, plus `cli/src/__tests__/init-type-sources.test.ts` and
`common/src/tools/__tests__/tool-registration-consistency.test.ts`.

New tests: A6, A8 from SPEC.

---

## M3 — Deprecate `read_blocks` to a forwarding surface

### M3-T1 — Forward and mark deprecated

`read-blocks.ts` becomes a thin adapter: map its input to the unified selector groups, call
the shared handler, wrap the result with `buildReadBlocksResultV1`. Prefix its
`description` with a deprecation note pointing at `read_files`. Keep the tool registered so
`agents/tool-reachability.test.ts` and `scripts/check-tool-registration.ts` stay green and no
agent's `toolNames` breaks.

### M3-T2 — Update prompts and docs

- `agents/editor/editor.ts` (~lines 96, 108), `agents/editor/repair-editor.ts` (~line 28),
  `agents/base2/base2.ts` (~lines 214, 265): change "prefer read_blocks for large files" to
  "prefer `read_files` windows/around for large files".
- `docs/agents-and-tools.md` and `packages/agent-runtime/docs/deterministic-edit-system.md`:
  document the five selectors and the three-tier authority ladder.
- `AGENTS.md` retrieval-conventions bullet.

### M3 validation gate

`agents` typecheck + `bun test __tests__` (includes `quality-prompt-snapshot.test.ts` — the
snapshot will need updating), plus A7 and A9 from SPEC.

---

## Dependencies

- M1-T2 and M1-T3 both depend on M1-T1.
- M1-T6 depends on M1-T3 only for the result fields it renders; it may be done in parallel.
- M2-T3 depends on M2-T1 + M2-T2.
- M2-T5 depends on all other M2 tasks.
- M3 depends on M2 completing.

## Task status

- [ ] M1-T1 extract shared coverage→authority ladder
- [ ] M1-T2 rewire read_files onto the ladder
- [ ] M1-T3 read_blocks whole-file grant + context_compacted parity
- [ ] M1-T4 bound windowSize/contextLines + block byte budget
- [ ] M1-T5 context-pruner read_blocks recognition
- [ ] M1-T6 CLI read-blocks renderer + registry
- [ ] M1-T7 grant read_blocks to remaining read-capable agents
- [ ] M1-T8 author M1 regression tests (A1–A5)
- [ ] M1-GATE run M1 validation suites
- [ ] M2-T1 read_files accepts windows + around
- [ ] M2-T2 unified result item union + referencedBy everywhere
- [ ] M2-T3 one shared handler for both tools
- [ ] M2-T4 manifest-first oversized reads
- [ ] M2-T5 regenerate the four generated type mirrors
- [ ] M2-T6 author M2 tests (A6, A8)
- [ ] M2-GATE repo-wide typecheck + all package suites
- [ ] M3-T1 read_blocks forwards + deprecation note
- [ ] M3-T2 prompt and docs updates
- [ ] M3-GATE agents suites incl. prompt snapshot (A7, A9)

<!-- update_plan_status:appended -->
## M1-T1 through M1-T4 + M1-T8 complete — 2026-07-30 — 2026-07-30T18:25:38.435Z

All four implementation tasks done and verified:
- M1-T1: read-authority-ladder.ts created (classifyReadBlockAuthority, 9 unit tests)
- M1-T2: read_files rewired onto the ladder (both file/range branches unified)
- M1-T3: read_blocks gains whole-file grant + context_compacted parity (6 regression tests)
- M1-T4: windowSize/contextLines capped, MAX_READ_BLOCK_BYTES enforced (8 schema tests)
- M1-T8: 37 tests pass total, typecheck clean for agent-runtime + common

Next: M1-T5 (context-pruner), M1-T6 (CLI renderer), M1-T7 (agent grants).
