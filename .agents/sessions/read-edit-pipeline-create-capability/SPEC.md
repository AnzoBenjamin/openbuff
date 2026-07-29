# SPEC: Create→Edit/Delete Capability & Read/Edit Pipeline Improvements

Status: design only. No code changes are authorized by this document. Implementation is split into future milestones (M2–M4) and requires explicit user sign-off per tier.

## 1. Background & problem statement

The deterministic edit system enforces staged read-before-edit: under strict mode, an edit to an existing path requires either a fresh whole-file read authorization or an explicit scoped capability (`basedOnRead` / `readCapability`). This is correct and fail-closed.

The friction: an agent that **creates** a file knows its exact bytes (it supplied them), yet the runtime does not reliably convert that known content into reusable edit authorization or hand the model a capability token. A subsequent `delete` / `str_replace` / `write_file` on that same file is then blocked, and the model is forced into a redundant `read_files` round-trip. Observed in a real session: an agent created a throwaway smoke-test file, then had to `read_files` it before `edit_transaction` `delete` would apply.

The system is choosing correctness over convenience. The goal of this work is to recover the convenience **without** weakening the fail-closed guarantee for genuinely-unknown files.

## 2. Verified mechanism (source of truth)

File: `packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts`
- Strict gate exempts create: `if (edit.type === 'create' && initialContentByPath.get(edit.path) === null) return`. So no `freshWholeFileAuthorizationPaths` entry is established for a create at preflight.
- `delete`/`move` are validated only for existence in lifecycle preflight (`Delete source does not exist`), but are **not** exempted from the strict gate — they fall through to the generic authorization check.
- `wholeFileContentByPath` is populated for `create` (`set(edit.path, edit.content)`) and `move` (`set(destinationPath, sourceContent)`).

File: `packages/agent-runtime/src/tools/handlers/tool/edit-application-coordinator.ts`
- `commitAppliedEditPaths` grants sticky auth only when `typeof wholeFileContent === 'string' && confirmedAnchor && strictReadBeforeEdit`.
- `getPositiveApplicationEvidence` builds `confirmedAnchor` only when the applied action's `editAnchor` passes a 7-point check: content string present, `readCapability` string, `startLine===1`, `endLine===normalizeLineEndings(content).split('\n').length`, `contentHash === getContentHash(content)`, `cap.v3` decodes, `readCapabilityMatchesScope({projectId, path, runId})`, and decoded `startLine/endLine/hash` equal the record. It also cross-checks `matchingAction.afterHash === getExactContentHash(content)` for every `wholeFileContentByPath` entry.

File: `packages/agent-runtime/src/tools/handlers/tool/write-file.ts`
- `FileProcessingState` holds `readAuthorizationsByPath`, `readAuthorizationHashesByPath`, `confirmedPostEditAnchorsByPath`, `modelVisibleReadAuthorizationHashesByPath`, `editRereadRequirementsByPath`.
- `grantWholeFileReadAuthorization` writes the sticky hash from known content.

### Why the gap happens (three distinct causes)

1. **Anchor dependence.** The post-edit grant requires the client to echo a whole-file-covering `cap.v3` anchor. Post-edit anchors are optional ("may return"), and create/delete actions are the least likely to carry one. No anchor → no grant, even though the create content is known exactly.
2. **Invisibility.** Even when the grant succeeds, it is written to in-memory maps only. The tool output (`1. path • create • applied`) never surfaces the `readCapability`, so the model has no token to pass and no signal that a re-read is unnecessary.
3. **Asymmetric lifecycle handling.** `create` is exempt from the strict gate; `delete` is not. So the very next lifecycle op on a just-created file is the one that blocks.

## 3. Goals / non-goals

### Goals
- Eliminate the redundant read-before-delete/edit round-trip for files whose content is already known to the runtime (creates, whole-file writes, confirmed edits).
- Make granted authorization explicit and compaction-resilient by surfacing capability tokens to the model.
- Preserve fail-closed behavior for any file whose current bytes are not positively known.

### Non-goals
- Weakening the 7-point `confirmedAnchor` evidence check for *confirming an apply happened*.
- Allowing `write_file` whole-file overwrite on scoped/partial capabilities (the current floor stays).
- Changing the `context_compacted` semantics for `write_file` (sticky hash alone still must not authorize a blind overwrite).
- Auto-reread behavior changes for `str_replace` (out of scope).

## 4. Improvement backlog

### HIGH tier

#### #1 — Server-side mint + surface a capability on create / whole-file write
- **What.** When a `create` (or a confirmed whole-file `write_file`) is applied, the runtime already has the exact post-edit bytes. Mint a `cap.v3` read capability from that known content server-side instead of depending on the client to echo an anchor, and return it in the tool output (structured `editAnchor.readCapability`, plus a short non-secret indicator in the human-readable line).
- **Where.** `edit-application-coordinator.ts` (`commitAppliedEditPaths` / `getPositiveApplicationEvidence` fallback) and the output shaping in `edit-transaction.ts` / `write-file.ts`.
- **Why high.** Directly removes the reported round-trip; the content needed is already in `wholeFileContentByPath` for creates.
- **Security note.** The minted token must be scope-bound to `{projectId, path, runId}` exactly like read-minted tokens, and must only be minted when the apply is positively confirmed. Server-side minting from known content is *stronger* than trusting a client anchor, so this does not lower the security bar.
- **Compaction note.** A token visible in the transcript survives compaction; invisible in-memory maps accrue `context_compacted` markers. Surfacing the token therefore improves robustness under compaction.

#### #2 — Create grants sticky authorization directly from known content
- **What.** After a confirmed `create`, call `grantWholeFileReadAuthorization(fileProcessingState, path, edit.content)` unconditionally. The runtime supplied the bytes; it does not need client evidence to trust them.
- **Where.** `edit-transaction.ts` post-apply path (or `commitAppliedEditPaths` with a create-aware branch).
- **Why high.** Removes the dependence on the 7-point anchor check specifically for the create case, closing cause #1.
- **Interaction with #1.** #2 establishes the internal grant; #1 surfaces the token. They are independent but complementary; together they fully close the create gap.

#### #3 — Relax delete authorization on a fresh confirmed post-edit anchor
- **What.** A delete's safety bound is "the file is in the state I believe it is." If the path has a fresh confirmed post-edit anchor (e.g. from #2) whose `contentHash` matches current content, allow `delete` to proceed on that anchor without an additional whole-file read.
- **Where.** `edit-transaction.ts` strict gate: add `delete` (and evaluate `move`) to the set of edits that can be authorized by a matching `confirmedPostEditAnchorsByPath[path]` fresh against the snapshotted content.
- **Why high.** This is the exact operation that blocked in the observed session.
- **Risk / care.** Must still verify hash freshness against the transaction snapshot (`initialContentByPath`), and must still fail closed when there is no confirmed anchor or the hash is stale. `move` should be treated cautiously because it also touches a destination path.

### MEDIUM tier

#### #4 — Echo the granted capability in every successful mutating tool result
- **What.** Generalize #1: whenever a mutation results in a granted whole-file authorization, include the capability (or a reference to it) in the structured tool output so the model can reuse it explicitly.
- **Why medium.** Turns implicit state into an explicit, transcript-resident token; reduces a whole class of "I edited it, why am I blocked" cases beyond create.
- **Care.** Keep user-facing CLI rows free of raw tokens (docs already require: show a short hash + whether a capability exists, never the token in CLI rows). The token belongs in the model-facing structured output only.

#### #5 — Differentiate recovery messages by actual cause
- **What.** The generic `Edit blocked: strict read-before-edit is enabled and no fresh read authorization exists` should distinguish: never-read vs. created-this-session vs. compacted vs. stale. After a create, the message should say "pass the capability from the create result" rather than "read the file first."
- **Why medium.** The current message actively misleads the model into an unnecessary full re-read.
- **Where.** `strictEditAuthorizationError` in `edit-read-state.ts` and the inline failure strings in `edit-transaction.ts`.

#### #6 — Decouple reread-marker clearing from the strict anchor check for known-content creates
- **What.** `commitAppliedEditPaths` already calls `clearEditRereadRequirement` per path, but the sticky grant is gated on the anchor check. For known-content creates, clear `failedEditRequiresReadByPath` / `editRereadRequirementsByPath` markers even when the client anchor is absent.
- **Why medium.** Removes a class of spurious blocks where the marker outlives a known-good create.

### LOWER tier

#### #7 — Narrow the whole-file-anchor requirement for the *grant* (not the *edit*)
- **What.** The 7-point check currently does two jobs: (a) prove the apply succeeded, (b) prove the anchor is whole-file. For granting *sticky read authorization*, arguably only (a) plus a trusted content hash is needed; a confirmed-but-scoped anchor could still authorize reads of that region.
- **Why lower.** Broader semantic change; needs a design decision and careful reasoning about what "scoped sticky" means for later whole-file overwrites.
- **Decision required.** Architect/owner sign-off before implementation.

#### #8 — First-class "created this session" state
- **What.** Distinguish "content known because I wrote it" from "content known because I read it" in `FileProcessingState`. The former can authorize more aggressively within the mutation broker's authority and gives the gate a principled reason to relax delete/overwrite for agent-created files.
- **Why lower.** Largest design surface; touches state shape, compaction semantics, and the reviewer gate's working-tree markers. Should follow, not precede, #1–#3.

## 5. Cross-cutting concerns

- **Fail-closed invariant.** Every relaxation must keep failing closed when current bytes are not positively known. Hash freshness against the live snapshot is always required.
- **Compaction.** Surfacing tokens (#1/#4) is the primary compaction-resilience lever. `context_compacted` blocking of blind `write_file` overwrites is intentionally preserved.
- **Security.** Server-side minting must reuse the existing `cap.v3` issuer and scope binding. No new trust in client-supplied anchors is introduced; #1 actually *reduces* reliance on client anchors.
- **Reviewer/validation gate.** #8 interacts with the gate's `sha256:<hash>:<byteLength>` working-tree markers; defer until the gate implications are designed.
- **Backwards compatibility.** Surfacing an extra structured field in tool output is additive and safe. Changing grant semantics is internal and must be covered by tests.

## 6. Acceptance criteria (per tier, for future implementation)

- **High (#1–#3).** An agent can `create` a file and then `delete`, `str_replace`, or `write_file` it in a later step **without** an intervening `read_files`, in strict mode, provided no external modification occurred. A new regression test reproduces the originally-observed create→delete flow and asserts no spurious block. External modification still blocks.
- **Medium (#4–#6).** Mutating tool results expose a reusable capability to the model; recovery messages name the actual cause; known-content creates clear stale reread markers. Covered by targeted tests.
- **Lower (#7–#8).** Documented design decision; implementation only after explicit approval, with full state-shape and gate review.

## 7. Testing & docs (for future implementation)

- Tests under `packages/agent-runtime/src/**/__tests__` (see existing `read-files-edit-state.test.ts`, `edit-application-coordinator.test.ts`, `write-file.test.ts`).
- Add a regression test that mirrors the observed session: create → delete with no read, assert success in strict mode; and create → external-change → delete, assert block.
- Update `docs/deterministic-edit-system.md` to document the new create/delete authorization behavior and the surfaced capability field.
