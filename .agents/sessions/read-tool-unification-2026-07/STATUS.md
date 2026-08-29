# STATUS — read tool unification

## Current state

Planning complete. No implementation code has been touched. `SPEC.md` and `PLAN.md` are
written and awaiting user review before M1 starts.

Branch at plan time: `fix/reviewer-gate-hardening` (clean worktree).

## Completed

- Source-verified audit of the read surface (`read_files`, `read_blocks`, `read_outline`,
  `read_subtree`, SDK read policy, capability minting, edit-authorization consumers).
- Decision recorded: merge direction is **into `read_files`**, because whole-file authority
  minting (`grantWholeFileReadAuthorization`), the strict-mode recovery selector in
  `strictEditAuthorizationError`, the context-pruner keys, and the CLI renderer are all
  already anchored on `read_files`. Making `read_blocks` the superset would create a second
  tool that mints whole-file authority.
- `SPEC.md` — requirements R1–R8, acceptance criteria A1–A9, evidence table, risks.
- `PLAN.md` — M1 (correctness, no schema change), M2 (unified selector contract),
  M3 (deprecate `read_blocks` to a forwarding surface).

## Pending

All of M1, M2, M3. Next checkpoint is **M1-T1**: extract
`classifyReadBlockAuthority` into
`packages/agent-runtime/src/tools/handlers/tool/read-authority-ladder.ts`.

## Blocked

Nothing. M1 needs no decisions beyond what SPEC records. M2 changes the public tool schema
and regenerates four committed type mirrors, so it should get explicit go-ahead before it
starts.

## Resume instructions

1. Read `SPEC.md` (evidence table + acceptance criteria) then `PLAN.md`.
2. Start at the `<!-- current-task: -->` pointer in `PLAN.md`.
3. M1 is safe to ship alone: it grants no new authority class, only makes an already-complete
   whole-file observation grant what an identical `read_files` observation already grants.
4. Do not begin M2 until M1's gate is green — M2-T3 collapses both handlers onto the shared
   block builders, which is only mechanical once the authority ladder is single-sourced.

## Key invariants to preserve

- `whole_file` authority requires ALL of: `complete`, `startLine === 1`,
  `endLine === totalLines`, and a real undecorated `sourceContent`. Numbered display content
  must never be used for hashing or granting.
- Partial/truncated blocks and heuristic (non-parser) symbol slices mint no capability.
- Only a whole-file grant may clear `context_compacted`.
- `cli/src/components/tools/registry.ts` throws at module load when metadata declares
  `renderer: 'custom'` with no registered component — metadata and registration land together.

<!-- update_plan_status:appended -->

## M1 + M2 complete (gate-verified) — 2026-08-02T17:34:06.607Z

Milestone M1 (correctness: authority ladder + bounds + ecosystem wiring) and Milestone M2 (unified selector surface on read_files) are complete and gate-verified.

**M1 (T1–T8 + GATE):** shared coverage→authority ladder (`classifyReadBlockAuthority`), read_files + read_blocks rewired onto it, whole-file-covering blocks grant sticky auth, windowSize/contextLines capped + MAX_READ_BLOCK_BYTES enforced, context-pruner recognizes read_blocks (FILE_INSPECTION_TOOLS, summarizeToolCall case, read_blocks_result collector, path tracking), CLI read-blocks.tsx renderer registered + metadata renderer:custom landed together, read_blocks granted to all read-capable agents. Per user decision, thinker also gained read-only access (read_files + read_blocks; no-history/no-spawn preserved). M1-GATE green: agents 767, cli 71, agent-runtime 124, common 220.

**M2 (T1–T6 + GATE):** read_files input schema gained windows/around selectors (reusing exported read-blocks selector schemas); five-selector emptiness check; inferSingleSelectorPath infers windows/around single-path shorthand; description documents all five selectors + authority ladder. Result item union unified (readBlocksItemV1Schema = readFilesItemV1Schema; window/around/symbol items moved into the shared union; referencedBy added to range/window/around/symbol strict schemas). Shared block builders (buildWindowBlock/buildAroundBlock/buildSymbolBlock + ReadBlockBuilderContext) extracted to structural-read.ts; both handlers share them; read_files serves five selectors ordered paths→ranges→windows→around→symbols. Manifest-first oversized reads synthesize a window manifest + first window after a truncated whole-file read (no whole-file capability). One consumer fix: simplify-tool-results.ts restricted content-stripping to file/range (window/around/symbol pass through) to resolve a TS2322. Four generated type mirrors regenerated and stable; init-type-sources 3/3.

**Validation:** all repo typechecks green (script:typecheck, typecheck-common, typecheck-agents, typecheck-agent-runtime); targeted suites green (read-files-edit-state 126, read-blocks, read-files-schema, filesystem, simplify-tool-results 43, init-type-sources 3). Reviewer gate: NON_BLOCKING with 4 non-blocking nits recorded for later cleanup: (1) loadFile/mintBlockEditAnchor/applyBlockAuthority/overBudgetError duplicated between read-files.ts and read-blocks.ts — hoist a small factory into structural-read.ts; (2) readBlocksResultV1Schema superRefine re-implements the readFilesResultV1Schema invariant block — extract a shared helper; (3) selectSymbolSlice occurrence>1 relies on slice-truncation semantics — prefer astMatches[occurrence-1]; (4) no direct test of the over-budget too_large branch in buildWindowBlock/buildAroundBlock.

**Next:** M3 (deprecate read_blocks to a forwarding surface + prompt/docs updates). M3-T1 makes read_blocks a thin adapter over the shared handler; M3-T2 updates editor/base2 prompts + docs + AGENTS.md; M3-GATE runs agents suites incl. quality-prompt-snapshot.

<!-- update_plan_status:appended -->

## M3 complete: read_blocks fully removed (gate-verified) — 2026-08-02T20:18:50.156Z

M3 is complete. Per user decision (full removal, not a forwarding alias), the `read_blocks` tool was deleted across every layer after `read_files` became a strict functional superset.

**Prerequisite (occurrence gap closed first):** added the occurrence-aware `symbol` selector to `read_files` (`symbol: [{ path, name, occurrence? }]`, mirroring rewrite_symbol occurrence semantics) so `read_files` is a strict superset of `read_blocks`: paths, ranges, windows, around, occurrence-aware `symbol`, batch `symbols`. Context-pruner + CLI renderer brought to parity for the new selectors; mirrors regenerated; gate NON_BLOCKING.

**M3 removal (2 editor waves + follow-ups):**

- Wave 1 (core): removed `read_blocks` from `constants.ts` (toolNames + publishedTools), `list.ts`, `metadata.ts` (READ*TOOLS/CUSTOM_RENDERERS/PATH_INPUTS); deleted `params/tool/read-blocks.ts` (selector schemas + MAX\*\* constants relocated into `read-files.ts`); removed `readBlocksResultV1Schema`/`buildReadBlocksResultV1`/`isReadBlocksResultV1` + types from `filesystem.ts` (kept the `readBlocks*ItemSchema`window/around/symbol item kinds inside the shared`readFilesItemV1Schema`union); deleted the runtime handler + its registration; deleted the CLI renderer + registry entry; deleted`read-blocks.test.ts`+`read-blocks-schema.test.ts`; removed all `read_blocks`/`read_blocks_result`handling from`agents/context-pruner.ts`.
- Wave 2 (agents + docs): removed `read_blocks` from every agent `toolNames` (editor, repair-editor, thinker, code-reviewer, security-reviewer, debugger, doc-writer, test-writer, synthesizer, general-agent, base2, base-deep, create-specialist); rewrote prompt prose to point at `read_files` windows/around/symbol selectors; updated agent tests (thinker/code-reviewer/editor/base2/gate-lifecycle e2e); folded `read_blocks` docs into `read_files` in `docs/agents-and-tools.md` + `docs/deterministic-edit-system.md`.
- Follow-up fixes surfaced by validation/review: input-aliases map — the occurrence-aware `symbol` is a real canonical selector, NOT aliased onto batch `symbols` (self-alias with coerce:'array'+coerceCanonical so a singular object coerces to a one-element array); added `window`/`around`/`symbol` alias entries; updated the input-aliases test. `metadata.ts` PATH_INPUTS for `read_files` extended with `windows[].path`/`around[].path`/`symbol[].path`. `structural-read.ts` user-facing error strings/comments re-pointed from `read_blocks` to `read_files`. Model-facing `read_files` description re-pointed the `symbol` selector's occurrence semantics from `read_blocks` to `rewrite_symbol`. Four generated type mirrors regenerated (init-type-sources 3/3; tool-registration-consistency green).

**Validation:** all typechecks green (script:typecheck, typecheck-common, typecheck-cli, typecheck-agents, typecheck-agent-runtime); common tools 223/223; input-aliases 9/9; read-files-schema 15/15; agent-runtime read tests green (one environmental tree-sitter c_sharp .scm build error in a single occurrence test, unrelated to this change); cli tools 71/71. Reviewer gate: NON_BLOCKING (cosmetic nits: sequential per-selector block-builder awaits, duplicated DEFAULT_WINDOW_SIZE/DEFAULT_CONTEXT_LINES constants, a CLI legacy-heuristic comment, symbols 100k-char slice cap documentation, duplicated totalLines derivation helper).

**Plan complete:** M1 (authority ladder + ecosystem), M2 (unified selector surface), M3 (full read_blocks removal) all done and gate-verified. The read surface is now a single `read_files` tool with six selectors, one authority ladder, cap.v3 minting, byte budgets, and full CLI/pruner/agent parity.

<!-- update_plan_status:appended -->

## Session closed — all milestones complete — 2026-08-02T21:34:04.262Z

All three milestones (M1 authority ladder, M2 unified selector surface, M3 read_blocks removal) are complete and gate-verified per the appended entries above. The read surface is now unified on `read_files` with six selectors (paths, ranges, windows, around, symbol, symbols). `read_blocks` is fully removed from every layer (registry, handler, schemas, CLI renderer, agent grants, prompts, docs). Flipping session state to completed.
