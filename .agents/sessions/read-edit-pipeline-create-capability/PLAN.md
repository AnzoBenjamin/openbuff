<!-- current-task: design-read-edit-pipeline-create-capability -->

# Plan: Create→Edit/Delete Capability & Read/Edit Pipeline Improvements

## Problem

`edit_transaction` `create` (and `write_file`) do not reliably mint or surface a reusable read capability, so a follow-up `delete` / `str_replace` / `write_file` on a session-created file is blocked by strict read-before-edit and forces a redundant `read_files` round-trip. This is the exact friction seen in the wild (agent had to `read_files` a throwaway file it had just created before it could `delete` it).

## Root cause (verified against source)

- `edit-transaction.ts` strict gate exempts `create` (`if (edit.type === 'create' && initialContentByPath.get(edit.path) === null) return`), so no `freshWholeFileAuthorizationPaths` entry is established at preflight.
- Post-edit sticky authorization is only granted by `commitAppliedEditPaths` (`edit-application-coordinator.ts`), and only when **all** of: `wholeFileContentByPath.get(path)` is a string, a `confirmedAnchor` exists, and `strictReadBeforeEdit` is on.
- `confirmedAnchor` is only produced by `getPositiveApplicationEvidence` when the client echoes a post-edit `editAnchor` that passes a 7-point check: whole-file covering (`startLine===1`, `endLine===totalLines`), `contentHash === getContentHash(content)`, valid `cap.v3` decode, scope match on `{projectId, path, runId}`, and decoded bounds/hash equal to the record.
- The granted authorization lives in invisible in-memory maps (`readAuthorizationsByPath` / `confirmedPostEditAnchorsByPath`); the tool output (`1. path • create • applied`) never surfaces the minted `readCapability` to the model.
- `delete` is **not** exempted the way `create` is; it falls through the strict gate and hits the generic `Edit blocked: strict read-before-edit is enabled and no fresh read authorization exists`.

## Key files

- `packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts` — strict gate, lifecycle preflight, `wholeFileContentByPath` population, `coordinateEditApplication` wiring.
- `packages/agent-runtime/src/tools/handlers/tool/edit-application-coordinator.ts` — `getPositiveApplicationEvidence`, `commitAppliedEditPaths`, `coordinateEditApplication`, `invalidatePreparedEditPaths`.
- `packages/agent-runtime/src/tools/handlers/tool/write-file.ts` — `FileProcessingState`, `grantWholeFileReadAuthorization`, `hasWholeFileReadAuthorization`, `isWholeFileReadAuthorizationFresh`, `revokeWholeFileReadAuthorization`, `normalizeToolPath`.
- `packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts` — `markEditRequiresFreshRead`, `clearEditRereadRequirement`, `strictEditAuthorizationError`.
- `docs/deterministic-edit-system.md` — policy documentation to keep in sync.

## Improvement backlog (see SPEC.md for full detail)

- High: #1 server-side mint + surface capability on create/write_file; #2 create grants sticky auth directly; #3 relax delete auth on fresh confirmed anchor.
- Medium: #4 echo capability in every mutating tool result; #5 differentiate recovery messages; #6 decouple marker-clearing from anchor check for known-content creates.
- Lower: #7 narrow whole-file-anchor requirement for the grant (not the edit); #8 first-class "created this session" state.

## Milestones

- [ ] M1 — Spec & design (SPEC.md) capturing all 8 improvements, security/compaction interplay, and acceptance criteria.
- [ ] M2 — (future, gated on user approval) Implement High tier (#1–#3) with tests.
- [ ] M3 — (future) Medium tier (#4–#6).
- [ ] M4 — (future) Lower tier (#7–#8) design decision + optional implementation.

## Validation gates

- Spec reviewed for correctness against the four source files above.
- Implementation milestones (future) must add/adjust tests under `packages/agent-runtime/src/**/__tests__` and pass `packages/agent-runtime` typecheck + targeted tests, and keep `docs/deterministic-edit-system.md` in sync.
