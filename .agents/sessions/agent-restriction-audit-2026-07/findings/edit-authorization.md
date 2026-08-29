# Audit findings: edit-authorization

- Subsystems: agent-runtime-edit-authorization
- Features: read-before-edit-gating, cap-v3-capability-binding, str-replace-circuit-breaker, replace-range-authority, compaction-authorization-revocation
- Files covered: 8

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts:6 — [B] SOFTEN — markEditRequiresFreshRead revokes read authorization and forces a full re-read on ALL str_replace hard failures, including non-staleness ones

- **Risk:** What it blocks: after any hard str_replace failure that is not a preflight-syntax error, str-replace.ts calls markEditRequiresFreshRead(reason:'preflight_failed') (str-replace.ts:~300-320), which sets failedEditRequiresReadByPath[path]=true AND (revokeReadAuthorization defaults true, edit-read-state.ts:17,25-29) deletes readAuthorizationsByPath/HashesByPath. The very next str_replace with no basedOnRead is then blocked by the recoveringFromFailedEdit gate (str-replace.ts:~123) even though the file never changed. Friction-vs-value: real staleness (reason stale_snapshot / stale_capability) genuinely warrants a re-read, but the common failures here are content-mismatch, not staleness — an ambiguous oldString (multiple occurrences), a tiny-anchor refusal, or a simple typo. The file on disk is unchanged, so a full re-read teaches the model nothing new; it could retry immediately with occurrenceIndex or a longer oldString drawn from content it already has. Forcing a re-read + authorization revocation here is pure friction that also nudges the agent toward the circuit breaker.
- **Fix:** Minimal relaxation: distinguish staleness failures from content-mismatch failures. Only revoke whole-file authorization + require a fresh read when staleness is actually observed (stale_snapshot/stale_capability, i.e. hadFreshWholeFileAuthorization was true then went stale, or a supplied capability failed its hash). For plain no-match/ambiguous/tiny-anchor failures, keep failedEditRequiresReadByPath set for the guidance but pass revokeReadAuthorization:false so a still-valid whole-file authorization survives and the agent can retry with occurrenceIndex/longer oldString without a redundant re-read.
- **Evidence:** edit-read-state.ts:17 revokeReadAuthorization=true default; :25-29 deletes all stored authorizations; str-replace.ts:~300-320 marks reason:'preflight_failed' on every non-syntax error; str-replace.ts:~123 recoveringFromFailedEdit && !hasAnyReadCapability -> hard block.

## [MEDIUM] correctness — packages/agent-runtime/src/process-str-replace.ts:470 — [B] SOFTEN — a STALE supplied basedOnRead on a small file hard-fails instead of falling back to a unique-literal match

- **Risk:** What it blocks: when a basedOnRead capability is supplied but its range hash no longer matches (hasStaleBasedOnRead) and requireFreshReadCapability is false, the code emits staleScopedFailure and refuses the edit rather than falling back to an unscoped unique-literal match ('the runtime did not fall back to an unscoped whole-file match'). Friction-vs-value: the stale-anchor guard is correct for large/ambiguous edits (never silently expand scope), but on a small file whose oldString is still unique in current content, the edit is unambiguous and safe. This is exactly the situation right after the agent's own earlier edit staled a pre-edit anchor — the model is blocked and told to re-read even though a naked unique-oldString edit would land correctly. Note the sibling bogus-anchor path already has a loop-breaker that auto-strips an invalid anchor when oldString is uniquely matchable (process-str-replace.ts:~205-225); the stale-anchor path lacks the same escape hatch.
- **Fix:** Minimal relaxation: mirror the bogus-anchor auto-strip. When !requireFreshReadCapability and normalizedOldStr occurs exactly once in current content, drop the stale anchor and apply as a naked unique-literal edit with a warning note (same wording as autoStrippedBogusAnchor), instead of recording a hard failure. Keep the hard-fail only when oldString is non-unique or requireFreshReadCapability is set.
- **Evidence:** process-str-replace.ts hasStaleBasedOnRead branch (staleScopedFailure, '...did not fall back to an unscoped whole-file match'); contrast auto-strip loop-breaker at ~205-225 (uniquelyMatchable && !requireFreshReadCapability -> basedOnRead=undefined).

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/str-replace.ts:36 — [B] SOFTEN — str_replace circuit breaker (limit 3) counts successful auto-corrects and partial successes and never decrements on clean success

- **Risk:** What it blocks: STR_REPLACE_MAX_CONSECUTIVE_FAILURES=3 hard-blocks all raw str_replace on a path for the rest of the turn. The budget is charged not only by hard failures but also by auto-corrected near-matches (a SUCCESS, str-replace.ts:~330-338) and by non-atomic partial successes, and a clean exact-match success deliberately does NOT decrement it (test 'does not erase prior failures after an exact-match success'). Friction-vs-value: the anti-loop intent is sound and genuinely prevents corruption spirals, and it still leaves rewrite_symbol/replace_range/write_file open. But on a large legitimate refactor with many small edits, a couple of gated-but-correct auto-corrects plus one partial success can reach 3 and lock out str_replace even while the agent is making real progress. Counting a fully-gated auto-correct (which already passed similarity + uniqueness + delimiter-balance gates) as equivalent to a failure is the most aggressive part.
- **Fix:** Minimal relaxation (keep the breaker): (a) let a clean exact-match success decrement the counter by 1 (floor 0) so steady progress drains the budget, instead of freezing it; and/or (b) exclude auto-corrects that passed all deterministic gates from the budget, counting only hard failures + suspect auto-corrects; and/or (c) raise the limit to ~5. Preserve the no-reset-on-success stance for the alternating failure/success case by decrementing (not resetting).
- **Evidence:** str-replace.ts:36 const STR_REPLACE_MAX_CONSECUTIVE_FAILURES=3; :~104-124 breaker returns before processing; :~330-338 hadAutoCorrect || failedReplacementCount>0 increments counter; test file lines confirm no decrement on success and partial-success charge.

## [LOW] state-mutation — packages/agent-runtime/src/util/read-authorization.ts:4 — [C] KEEP — compaction revokes implicit whole-file edit authority

- **Risk:** What it blocks: after context compaction removes the exact read bodies, revokeImplicitReadAuthorizationsAfterCompaction clears readAuthorizationsByPath/HashesByPath and sets editRereadRequirementsByPath[path]={reason:'context_compacted'}, forcing a fresh read before a whole-file-authorized edit. Friction-vs-value: strongly value. Once the exact bytes leave the model context, the agent no longer demonstrably observed current content, so a whole-file overwrite could be stale. Importantly this does NOT dead-end scoped edits: strictEditAuthorizationError allows a scoped cap.v3 capability (allowScopedCapability default true), so an agent still holding a valid basedOnRead token can proceed without a re-read. The friction is scoped to the exact case where authority genuinely evaporated.
- **Fix:** No change. Genuine stale-write protection; scoped cap.v3 path already avoids redundant re-reads.
- **Evidence:** read-authorization.ts:14-20 sets reason 'context_compacted' and empties authorization maps; edit-read-state.ts:79-80 allowScopedCapability && hasScopedCapability -> undefined (no block).

## [LOW] security — common/src/util/content-hash.ts:66 — [C] KEEP — cap.v3 per-process HMAC signing key + project/path/run scope binding

- **Risk:** What it blocks: READ_CAPABILITY_SIGNING_KEY=randomBytes(32) is generated per process, so all outstanding capabilities are invalidated on runtime restart; readCapabilityMatchesScope binds every token to projectId+path+runId, so cross-path/cross-run replay is rejected (validateReadCapabilityAuthority in process-str-replace.ts, and the replace_range scope check in process-edit-transaction.ts). Friction-vs-value: strongly value. This is the core anti-forgery/anti-replay guarantee that makes an echoed post-edit anchor trustworthy. The only friction — a mandatory re-read after a runtime restart or when no runtime scope exists — is inherent to an in-process capability and cannot be relaxed without weakening the authenticity guarantee.
- **Fix:** No change. Do not persist or share the signing key across runs; the re-read-after-restart cost is acceptable versus replay risk.
- **Evidence:** content-hash.ts:66 randomBytes(32) signing key with 'in-process runtime capability' comment; :86-93 readCapabilityMatchesScope; process-str-replace.ts validateReadCapabilityAuthority (scope-mismatch rejection).

## [LOW] security — packages/agent-runtime/src/process-edit-transaction.ts:300 — [C] KEEP — replace_range authority chain (scope + capability metadata + content re-hash + target-within-range + bounds)

- **Risk:** What it blocks: a replace_range edit is rejected unless the decoded token matches scope, its (startLine,endLine,hash) equal the declared capability metadata, the ORIGINAL-snapshot content re-hashes to the token hash, the authorization target lies within the covered capability range, and the requested lines are in-bounds. Friction-vs-value: strongly value. This is the whole-file-overwrite floor and the primary stale-overwrite defense for block edits; each check catches a distinct forgery/staleness class. It authenticates against the original snapshot (not shifted working lines), which correctly lets prior in-transaction edits shift the target without re-reading. No redundant re-read is imposed on a fresh, in-range capability.
- **Fix:** No change.
- **Evidence:** process-edit-transaction.ts replace_range case: decode+scope check, capability-metadata equality, getContentHash(observedContent)!==decoded.hash stale check, authorizationTarget within capabilityStart/End, visibleLineCount bounds.

## [LOW] correctness — packages/agent-runtime/src/process-edit-transaction.ts:265 — [C] KEEP (noted) — overlapping replace_range edits in one transaction are rejected

- **Risk:** What it blocks: getEffectiveReplaceRangeEdit hard-errors when a replace_range overlaps a prior replace_range in the same transaction ('cannot be applied from the original snapshot'). Friction-vs-value: mostly value. Two edits to the same lines from a single original snapshot have ambiguous line math; refusing avoids silent corruption. Non-overlapping later edits are correctly line-shifted rather than blocked, so the friction is narrow. Relaxing to re-base overlapping edits would reintroduce the exact ordering ambiguity the design removes.
- **Fix:** No change; the safe alternative (coalesce/reorder into one edit) is already available to the agent.
- **Evidence:** process-edit-transaction.ts getEffectiveReplaceRangeEdit: priorRange.startLine<=edit.endLine -> error; else lineShift applied.

## [LOW] correctness — packages/agent-runtime/src/process-str-replace.ts:84 — [C] KEEP — large-file read-capability enforcement, already softened by deterministic fallback and post-edit anchor echo

- **Risk:** What it blocks: files over LARGE_FILE_LINE_THRESHOLD (1000) or LARGE_FILE_CHAR_THRESHOLD (100000) require a fresh basedOnRead anchor (enforceReadCapability). Friction-vs-value: value, and already well-tuned against friction. It permits a naked edit when oldString is uniquely identifiable (getDeterministicLargeFileFallbackRange), echoes fresh post-edit anchors on every successful edit (mintAnchorForRange/regionAnchor) so the next edit to the region needs no re-read, and findFreshCapabilityForPath reuses an earlier in-call validated range so a self-staled anchor can be retried without re-reading. These are exactly the 'reuse an echoed post-edit capability' friction reducers the audit asks to preserve. occurrenceIndex also bypasses the anchor requirement.
- **Fix:** No change. This control already distinguishes real stale-write protection from friction correctly.
- **Evidence:** process-str-replace.ts:84-86 thresholds; getDeterministicLargeFileFallbackRange unique-match fallback; mintAnchorForRange/regionAnchor post-edit echo; findFreshCapabilityForPath (improvement #3) reuse path.

## Coverage receipt

### Subsystems

- agent-runtime-edit-authorization

### Features

- read-before-edit-gating
- cap-v3-capability-binding
- str-replace-circuit-breaker
- replace-range-authority
- compaction-authorization-revocation

### Files

- packages/agent-runtime/src/util/read-authorization.ts
- packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts
- packages/agent-runtime/src/tools/handlers/tool/str-replace.ts
- packages/agent-runtime/src/tools/handlers/tool/**tests**/str-replace-circuit-breaker.test.ts
- packages/agent-runtime/src/process-str-replace.ts
- packages/agent-runtime/src/process-edit-transaction.ts
- common/src/util/content-hash.ts
- common/src/tools/params/based-on-read.ts
