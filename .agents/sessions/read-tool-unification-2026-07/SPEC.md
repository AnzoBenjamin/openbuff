# SPEC — Unify the read tool surface onto `read_files`

## Goal

Make the read surface as mature as `edit_transaction`: one tool, one result kind, one
authority ladder, byte-bounded, fully wired into the CLI/pruner/agent ecosystem — without
weakening strict read-before-edit.

## Non-goals

- Changing `edit_transaction`, `replace_range`, `rewrite_symbol`, `str_replace`, or
  `write_file` authorization semantics. The read side must keep feeding them exactly the
  authority classes they accept today.
- Changing `read_outline`, `read_subtree`, `read_image`, `read_logs`, `read_docs`.
- Deleting `read_blocks`. It is retained as a forwarding surface (M3), not removed.
- Loosening `sdk/src/tools/read-policy.ts` / `sensitive-paths` behavior.

## Current behavior (verified against source)

| Fact | Evidence |
| --- | --- |
| `read_blocks` DOES mint `editAnchor` (`startLine`/`endLine`/`contentHash`/cap.v3) | `packages/agent-runtime/src/tools/handlers/tool/read-blocks.ts` `mintBlockEditAnchor` |
| `read_blocks` NEVER grants sticky whole-file auth | no `grantWholeFileReadAuthorization` import in `read-blocks.ts`; callers are `read-files.ts`, `replace-range.ts`, `edit-transaction.ts`, `write-file.ts` |
| `read_files` grants whole-file auth for a complete `paths` read AND a complete `ranges` read covering `1..totalLines` (hashing `sourceContent`) | `read-files.ts` ~lines 215–290, `wholeFileGrantPaths` |
| Only a whole-file grant may clear `context_compacted` | `read-files.ts` post-loop; `read-blocks.ts` unconditionally `continue`s on that reason |
| `windowSize` / `contextLines` have NO upper bound | `common/src/tools/params/tool/read-blocks.ts` (`.min(1)` / `.min(0)` only) |
| `read_files` bounds range reads at 4 MiB | `MAX_RANGE_READ_BYTES = 4_194_304`, `sdk/src/tools/read-files.ts:41` |
| `read_blocks` reads the FULL untruncated file then slices in memory | `requestOptionalFile` → `getFileForEditResult` (`sdk/src/run.ts` ~857, comment says "MUST be the full, untruncated file") |
| Read policy is intact for both tools | `getFileForEditResult` applies `fileFilter`; `sdk/src/__tests__/run-file-filter.test.ts` `[SEC-H02]` |
| No CLI renderer for `read_blocks` | `cli/src/components/tools/registry.ts` has `ReadFilesComponent`/`ReadSubtreeComponent`, no read-blocks entry |
| Context-pruner does not know `read_blocks_result` | `agents/context-pruner.ts` keys on `read_files` / `read_files_result` at lines 161, 229, 962, 1062, 1105, 2302 |
| Only 4 agents may call `read_blocks` | `agents/editor/editor.ts`, `agents/editor/repair-editor.ts`, `agents/base2/base2.ts`, `agents/base2/base-deep.ts` |
| `referencedBy` exists only on the whole-file item | `readFilesFileItemSchema` in `common/src/tools/results/filesystem.ts` |
| The result schema already anticipates the merge | `readFilesErrorItemSchema.selector` enum is already `['file','range','symbols','window','around','symbol']` |

## Requirements

- **R1 — Whole-file-covering block grants whole-file authority.** A complete `window` or
  `around` block whose `[startLine,endLine] === [1,totalLines]` must call
  `grantWholeFileReadAuthorization` with its `sourceContent` and may clear
  `context_compacted`. Sub-file blocks must not.
- **R2 — One authority ladder.** The coverage→authority decision exists in exactly one
  helper, consumed by both handlers. No third copy.
- **R3 — Bounded blocks.** `windowSize` and `contextLines` are schema-capped, and an
  oversized resolved block fails with `too_large` or returns `status:'partial'` +
  `truncation`, never unbounded content. `partial` blocks still mint no capability.
- **R4 — Unified selector surface.** `read_files` accepts `paths | ranges | windows |
  around | symbols` in one call, returning one `read_files_result` with contiguous
  `requestIndex`.
- **R5 — Uniform metadata.** `referencedBy` is available on every non-error selector, not
  just whole-file reads.
- **R6 — Manifest-first oversized reads.** A `paths` read that would exceed limits returns
  the window manifest (`totalLines`/`windowSize`/`windowCount`) plus the first window
  instead of a bare failure.
- **R7 — Ecosystem parity.** CLI renderer, context-pruner recognition, and agent grants
  cover the new selectors; generated tool-definition mirrors stay current.
- **R8 — No authorization regression.** Legacy/absent state still fails closed; partial,
  truncated, and heuristic-regex slices still mint nothing.

## Acceptance criteria

| ID | Behavior | Verification |
| --- | --- | --- |
| A1 | `read_blocks`/`read_files` window covering the whole file authorizes a following `write_file` under strict mode | new case in `packages/agent-runtime/src/__tests__/read-blocks.test.ts` + `read-files-edit-state.test.ts` |
| A2 | Sub-file window does NOT authorize `write_file`, still authorizes `replace_range` via its capability | same suites |
| A3 | Whole-file-covering block clears `context_compacted`; sub-file block does not | `read-blocks.test.ts` |
| A4 | `windowSize`/`contextLines` above the cap are rejected by the schema | `common/src/tools/__tests__/read-files-schema.test.ts` |
| A5 | A resolved block over the byte budget yields `too_large`/`partial` with no `editAnchor` | `read-blocks.test.ts` |
| A6 | One `read_files` call with all five selector kinds returns one result, contiguous indexes | `read-files-edit-state.test.ts` + `filesystem.test.ts` |
| A7 | `read_blocks` still works and returns the unified shape | `read-blocks.test.ts` |
| A8 | Generated type mirrors are current | `bun scripts/generate-tool-definitions.ts` produces no diff; `cli/src/__tests__/init-type-sources.test.ts` |
| A9 | Every read-capable agent that has `read_files` also has the new selectors reachable | `agents/tool-reachability.test.ts`, `scripts/check-tool-registration.ts` |

## Relevant systems

- `common/src/tools/params/tool/read-files.ts`, `.../read-blocks.ts` — input schemas + descriptions
- `common/src/tools/results/filesystem.ts` — result item unions, builders, guards
- `common/src/tools/metadata.ts` — READ_TOOLS set, renderer intent
- `packages/agent-runtime/src/tools/handlers/tool/read-files.ts`, `read-blocks.ts`, `write-file.ts` (grant fns), `edit-read-state.ts`
- `packages/agent-runtime/src/structural-read.ts`, `get-file-reading-updates.ts`
- `sdk/src/tools/read-files.ts` (`MAX_RANGE_READ_BYTES`, `authorizeReadTarget`), `sdk/src/run.ts` (`requestFiles`/`requestOptionalFile`)
- `cli/src/components/tools/registry.ts` + new renderer; `agents/context-pruner.ts`
- Generated: `agents/types/tools.ts`, `.agents/types/tools.ts`, `common/src/templates/initial-agents-dir/types/tools.ts`, `cli/src/data/initial-agent-type-sources.generated.ts`

## Risks

- **Silent authority widening.** A coverage predicate that is too loose grants whole-file
  auth from a partial read. Mitigation: the shared helper takes `{complete, startLine,
  endLine, totalLines, sourceContent}` and returns `'whole_file' | 'scoped' | 'none'`;
  `'whole_file'` requires all of complete + 1 + totalLines + a real `sourceContent`.
- **Preprocessor gap.** `inferSingleSelectorPath` currently infers a missing `path` only
  for `ranges`/`symbols`. Omitting `windows`/`around` breaks single-path shorthand silently.
- **CI-verified generated drift.** `cli/knowledge.md:868` states CI verifies the generated
  tool sources; forgetting the regen chain fails CI, not local typecheck.
- **Registry invariant.** `cli/src/components/tools/registry.ts` throws at module load when
  metadata declares `renderer: 'custom'` without a registered component. Metadata and
  registration must land in the same change.
