# Reviewer subsystem — design proposals

Status: Proposal A IMPLEMENTED (via `scripts/generate-gate-helpers.ts` +
freshness test); Proposal B IMPLEMENTED (merge ledger via
`mergeReviewerFindings` on security + final code-reviewer blocking paths,
keeping the existing arrays rather than a second keyed field); Proposal C
already IMPLEMENTED (aux-ownership variant — see below). Three safe fixes were
shipped earlier (see "Already shipped" below).

Source of truth at time of writing: `agents/base2/base2.ts` (the serialized
`createBase2` `handleSteps` generator), `agents/base2/gate-state.ts`,
`agents/base2/gate-reviewer.ts`, `agents/base2/gate-paths.ts`,
`agents/base2/gate-repair.ts`, and their parity tests under
`agents/__tests__/`.

## Already shipped (context)

- **Removed dead `staticReviewOnly` scaffolding.** The flag, `staticReviewerJobId`,
  the guarded `check_background_agent { cancel: true }` blocks, the
  `= undefined` resets, and the field-only round-trip tests were deleted. The
  reviewer was never actually spawned with `background: true`, so no reviewer
  ever ran concurrently with validation; enabling the flag did nothing. This
  was pure cleanup.
- **Recorded specialist reviewer provenance.** `openReviewerFindings[].reviewer`
  was widened to `'code-reviewer' | 'security-reviewer' | SpecialistReviewerAgent`
  and the specialist blocking path now stamps `reviewer: agentType`. This
  provenance is now what drives Proposal C's aux-ownership routing.
- **Implemented Proposal C (aux-ownership variant).** `requiredReviewerRevalidation`
  was widened to hold a `SpecialistReviewerAgent`, and an inline
  `revalidationFamily` classifier routes each family's revalidation back to the
  aux block that already owns its correct attestation contract: security ->
  security aux block (params `changed_files`+`snapshot_fingerprint`), specialist
  -> specialist aux block (fresh `get_change_review_bundle` `snapshot_id` +
  one-refresh retry), code -> final block. Fire-guards are family-scoped and
  marker clears never clobber another family's marker. This also FIXED a latent
  bug: security-reviewer revalidation previously flowed into the paramless final
  spawn, which could never satisfy security-reviewer's required params. See the
  aux-ownership note appended to Proposal C below.

---

## Proposal A — Reduce `gate-reviewer.ts` / inline parity duplication

### Problem

The reviewer-gate helpers exist twice:

1. As clean, testable module exports in `agents/base2/gate-reviewer.ts`
   (`collectReviewerBlockers`, `getReviewerFinalizationVerdict`,
   `detectReviewerCrash`, `collectStructuredReviewerOutputs`,
   `collectReviewerAttestationIssues`, `stripReviewerPreamble`,
   `isTestCoverageReviewerFinding`, ...).
2. As inline copies inside the `createBase2` `handleSteps` generator body
   (`collectReviewerFindingRecordsInline`, `selectSpecialistReviewersInline`,
   and the inline verdict/blocker/attestation helpers).

Root cause (documented in `gate-reviewer.ts`'s header comment): `handleSteps`
is serialized with `handleSteps.toString()` and reconstructed via
`new Function(...)`. Reconstructed functions lose their module closure, so the
generator cannot reference imports from `gate-reviewer.ts` at runtime.
Everything the generator calls must be defined inline in the body.

Current mitigation: parity tests (`gate-reviewer-parity.test.ts`,
`gate-paths-parity.test.ts`, `gate-repair-parity.test.ts`) use
`extractInlineFunctionSource` / `loadInline*Helpers` to pull each inline copy
out of the serialized generator and assert byte/behavior equivalence with the
exported version. Drift is *detected*, not *prevented*, and the extraction is
fragile (it string-parses the generator body).

### Options

- **A1 — Build-step inlining (single source of truth).** Keep only the
  `gate-reviewer.ts` module. Add a prebuild step that mechanically injects the
  helper sources into the generator body (or emits a generated file that the
  generator references) before `handleSteps.toString()` serialization runs.
  The parity tests are replaced by a "generated block is fresh" check
  (same pattern as `cli/src/agents/bundled-agents.generated.ts` freshness).
  - Pros: one source of truth; drift becomes impossible rather than detected.
  - Cons: adds generator complexity; must run before the existing
    `cli/scripts/prebuild-agents.ts` bundling; another generated artifact to
    keep fresh in CI.
- **A2 — Serializable helper injection.** Pass the helpers into the generator
  through a mechanism that survives `new Function` (e.g. stringify named helper
  sources into a preamble the generator evals once). Fights the execution
  model; high risk. Not recommended.
- **A3 — Keep parity tests, harden extraction.** Lowest effort: leave the two
  copies, but make `extractInlineFunctionSource` more robust and add a lint that
  fails when a `gate-reviewer.ts` export lacks a matching parity test.
  - Pros: minimal, no execution-model risk.
  - Cons: still two sources of truth; still a maintenance tax.

### Recommendation

A1 if we are willing to invest in the prebuild step (it is the only option that
actually eliminates the duplication the user flagged). A3 as the low-risk
fallback if we want to keep the change small. A2 is not recommended.

### Risk / blast radius

High. `base2.ts` is the gate. Any inlining bug changes review verdict parsing
for every edit turn. Must land behind the full gate + parity/`base2.test.ts` /
e2e suites, and the generated bundle must be regenerated.

---

## Proposal B — Merged multi-reviewer finding ledger (single-slot -> keyed)

### Problem

`activeWorkState.openReviewerBlockers` / `openReviewerFindings` are a single
slot. Whichever tier blocks last wins: the security gate sets them, a specialist
gate can overwrite them, and the final code-reviewer overwrites them again.
Today this is safe ONLY because the tiers are strictly sequential and each
blocking tier `continue`s or `break`s the loop before the next tier runs — so
exactly one tier's findings are ever "live" at once. There is no place that
merges findings from multiple reviewers.

### Why it is worth changing

- If tiers ever run concurrently (e.g. a future real static-review path), the
  single slot becomes a lost-update race.
- Operators only ever see one tier's findings at a time; a change that is both a
  security risk and a reliability risk surfaces only the last-writing tier.
- Repair routing has to reconstruct provenance (partially addressed by the
  shipped provenance metadata).

### Proposed shape

Replace the single slot with a keyed ledger on the gate state:

```ts
openReviewerFindingsByGate?: Record<string /* gateId */, {
  reviewer: 'code-reviewer' | 'security-reviewer' | SpecialistReviewerAgent
  snapshotFingerprint: string
  findings: OpenReviewerFinding[]
  status: 'open' | 'resolved'
}>
```

- Derive the flat `openReviewerBlockers` (still consumed by pinning/messaging
  and `buildPinnedActiveWorkMessage`) as a computed projection over all `open`
  ledger entries, so the user-visible contract is unchanged.
- Each tier writes/updates only its own keyed entry; clearing a finding marks
  that entry `resolved` instead of blowing away the whole slot.
- The gate passes only when every ledger entry is `resolved`.

### Migration / compatibility

- Backward-compatible: older serialized state lacks the field -> treat as the
  legacy single-slot behavior (fail closed).
- `context-pruner.ts` reads `openReviewerBlockers`; keep that field as the
  derived projection so the pruner and gate-state block are unaffected.
- Parity: the ledger logic lives inline in the generator, so it needs the same
  parity-test treatment as Proposal A (another argument for doing A first).

### Risk

Medium-high. Changes the core block/clear bookkeeping. Must preserve exact
finalization semantics (gate passes iff no open findings) and the pinned
`<gate-state>` contract.

---

## Proposal C — Specialist / security revalidation routing (the Q2 behavior change)

### Why this is NOT a small fix

The Q2 request was "route revalidation back to that specialist." Verification
shows the final-reviewer block cannot do this as-is:

- `base2.ts:2307`: `requiredReviewerAgentType = requiredReviewerRevalidation ?? 'code-reviewer'`.
- The final reviewer spawn (`base2.ts:3038`) passes **only a `prompt`** — no
  `params`.
- But `security-reviewer` requires `params.changed_files` + `snapshot_fingerprint`,
  and specialists require `params.snapshot_id`.
- Specialists attest against the `get_change_review_bundle` `snapshotId`, which
  is a DIFFERENT fingerprint than the `reviewSnapshotFingerprint` the final
  block builds/validates against.

So routing a specialist through `requiredReviewerRevalidation` would fail spawn
params AND snapshot attestation. Today specialists effectively "self-revalidate"
by re-running their own gate block on loop re-entry (they `continue` on block
and never set `requiredReviewerRevalidation`). `requiredReviewerRevalidation` is
currently only ever `'security-reviewer'` or `'code-reviewer'`.

### Options

- **C1 — Keep current self-revalidation, do nothing to routing.** The shipped
  provenance metadata already records which specialist found the issue.
  Specialists re-run their own block after repair. Lowest risk; the flagged
  `reviewerOriginFromGateId` reconstruction stays but is now backed by real
  metadata.
- **C2 — Generalize the revalidation dispatcher.** Make the final block
  parameterize the reviewer spawn by agent family: build the correct `params`
  (`snapshot_id` for specialists via a fresh `get_change_review_bundle`,
  `changed_files`+`snapshot_fingerprint` for security, none for code-reviewer)
  and attest against the matching fingerprint per family. Then
  `requiredReviewerRevalidation` can legitimately hold a specialist type.
  - Pros: unified revalidation path; provenance drives routing.
  - Cons: the final block must branch attestation by reviewer family; the
    snapshot-fingerprint mismatch between the specialist bundle id and the
    reviewable-scope fingerprint has to be reconciled. This is the single most
    fragile part of the gate.

### Recommendation

C1 now (already effectively in place; the provenance ship makes it coherent).
Pursue C2 only alongside Proposal A/B, because it touches the same inline gate
logic and needs the same parity + e2e coverage. Do not attempt C2 as a
standalone quick edit.

### Risk

High (C2). Attestation is the anti-clash core of the whole subsystem; a wrong
fingerprint branch would let a review of stale bytes pass.

### IMPLEMENTED (aux-ownership, chosen over C2 dispatch)

Rather than turning the fragile final block into a family-aware dispatcher
(C2), the implemented design keeps each family's attestation in the aux block
that already encodes it correctly:

- `requiredReviewerRevalidation` is now a persisted "revalidation-owed" family
  marker that CAN hold a `SpecialistReviewerAgent`, but it does not drive the
  final-block spawn. An inline `revalidationFamily(marker)` classifier maps the
  marker to `'none' | 'code' | 'security' | 'specialist'`.
- Fire-guards: the security aux block fires when the family is `none` or
  `security`; the specialist aux block fires when the family is `none` or
  `specialist` (re-including the owed specialist and dropping it from
  `specialistReviewGatesDone` so its spawn+attestation re-runs); the final
  block spawns a reviewer only when the family is `none` or `code`.
- Each owner block clears the marker only when it owns that family, so one
  block never clobbers another family's marker. The initial marker inference
  now prefers `openReviewerFindings[0].reviewer` (the shipped provenance) with
  a gateId-prefix fallback, which is how a specialist blocking finding from one
  turn re-fires the specialist aux block on the next.
- This fixed the latent security-reviewer revalidation bug (paramless final
  spawn) as a side effect, since security now always revalidates through its
  params-bearing aux block.

Note: on a blocking specialist finding the specialist aux block parks
`blocked` with the provenance-stamped finding and `continue`s (it does not
spawn repair-editor inline the way the security block does); the marker is
rehydrated to the specialist family at the next turn's setup from that
persisted finding, which is what drives the aux re-fire.

Remaining open: C2's full unified dispatcher is intentionally NOT implemented;
aux-ownership was chosen for lower blast radius on the attestation core.

---

## Suggested sequencing

1. Proposal A (single source of truth) first — it unblocks safe iteration on the
   inline gate logic that B and C both need.
2. Proposal B (keyed ledger) second — depends on A's parity approach.
3. Proposal C2 (revalidation dispatcher) last — highest risk, reuses A+B
   infrastructure. C1 is the no-op-now default.

Each must land behind: `cd agents && bun run typecheck`, `bun test base2.test.ts`,
the `gate-reviewer` / `gate-*-parity` suites, the `agents/e2e` gate lifecycle +
reviewer-spawn-conditions e2e tests, and a regenerated
`cli/src/agents/bundled-agents.generated.ts`.
