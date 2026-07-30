# LESSONS / DECISIONS

## Medium tier (M3) — implemented and validated
- #4: `coordinateEditApplication` applied branch appends one additive `postEditCapabilities` json part (path + contentHash + cap.v3 readCapability) only when anchors are granted. This output reaches the model via message history but not the user-facing CLI rows (which render separately), so the token is model-visible only. Immutably appended; error/rejected/threw paths untouched.
- #5: `strictEditAuthorizationError` gained a created/edited-this-session cause branch (fires when a `confirmedPostEditAnchorsByPath[path]` anchor exists and no higher-precedence cause applies) plus an `effectiveFreshReadCapability` fallback echoing that anchor's token for recovery/basedOnRead.
- #6 was delivered by the High tier: `commitAppliedEditPaths` grants sticky auth + clears reread markers from runtime-known content even without a client-echoed anchor, while preserving the marker for blind allowMultiple replace-alls via `preserveRereadRequirementsForPaths`.
- Gotcha: improving recovery-message wording (#5) broke a pre-existing test that asserted brittle message text (`/context compaction|read_files/i`). The test's intent (write_file stays blocked + marker preserved) still held; updated the assertion to match the new, more accurate wording. Lesson: prefer asserting behavior/intent over exact message strings for user-facing recovery text.
- Tests: 117/117 pass across edit-application-coordinator + read-files-edit-state; monorepo typecheck clean.

## M4 Lower tier (#7–#8) — DESIGN DECISION: DEFER BOTH (design-doc only, per user)
Decision recorded 2026-07-28. No implementation authorized. Rationale below.

### #7 — Narrow the whole-file-anchor requirement for the *grant* (not the *edit*)
- Idea: a confirmed-but-scoped anchor (post-edit bytes known but anchor covers a region) grants read authorization for that region only, recorded distinctly from a whole-file grant.
- Risks/open questions: a scoped grant must never be promoted to whole-file authorization by a later blind apply; must not clear `context_compacted` for whole-file-overwrite purposes; must not authorize delete/move of the whole file (which #3 keys off a whole-file anchor hash match). `confirmedPostEditAnchorsByPath` currently implies whole-file, so a scoped grant needs a separate/tagged representation.
- Recommendation: DEFER. Marginal benefit over current High/Medium behavior (which already grants sticky from runtime-known whole-file content on confirmed applies) is small; fail-closed risk surface is meaningful. Revisit only if a concrete workflow is blocked by scoped-anchor-only grants.

### #8 — First-class "created this session" state
- Idea: a `createdThisSessionByPath` (or `knownContentOrigin: 'agent-written' | 'read' | 'confirmed-apply'`) marker so the gate can relax delete/move/overwrite for agent-created files on principle rather than via the anchor-hash heuristic.
- Risks/open questions: external modification (another process can still change an agent-created file on disk) — the marker MUST be invalidated on any hash mismatch against the live snapshot, else it fails open; reviewer-gate working-tree markers (`sha256:<hash>:<byteLength>`) must not desynchronize; must not become a blank check for whole-file overwrite after compaction (intentionally blocked today); needs a per-turn hydration lifecycle like readAuthorizationsByPath.
- Recommendation: DEFER. Largest design surface in the backlog (state shape, compaction, gate markers). The Medium tier's created/edited-this-session recovery message already captures most of the user-facing benefit without new state. Observe whether High/Medium removes the practical friction first.

### If either is later approved
Specify which item and the safety constraints: for #7, no whole-file-overwrite promotion and a distinct scoped-grant representation; for #8, external-modification invalidation and gate-marker synchronization. Then produce a full implementation plan with state-shape and gate review before any code change.
