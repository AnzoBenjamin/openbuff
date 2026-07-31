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
