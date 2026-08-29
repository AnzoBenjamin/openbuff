/**
 * Pure reviewer gate parsing helpers extracted from `base2.ts`.
 *
 * NOTE: `base2.ts` carries inline copies of these helpers inside its
 * `<gate-helpers-generated>` region. `createBase2`'s `handleSteps` generator is
 * serialized via `handleSteps.toString()` and reconstructed with
 * `new Function(...)`; a reconstructed function loses its module closure, so it
 * cannot reference imports from this file — every helper it uses has to be
 * inlined into that region.
 *
 * That region is generator-owned, so do NOT hand-patch it. After changing this
 * file, regenerate it with
 *   bun run scripts/generate-gate-helpers.ts --write agents/base2/base2.ts
 * and verify freshness with the same script's `--check` mode.
 */

import { isAttestableSnapshotFingerprint } from './gate-fingerprint'
import { normalizeGateFilePath } from './gate-paths'

type ReviewerStructuredVerdict = 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING'
/** Only LOOKS_GOOD unlocks finalization; empty string is fail-closed. */
export type ReviewerFinalizationVerdict = 'LOOKS_GOOD' | ''

type ReviewerCoverage = 'covered' | 'missing' | 'n/a'

type StructuredReviewerOutput = {
  verdict: ReviewerStructuredVerdict
  findings: string[]
  advisories?: string[]
  coverage?: ReviewerCoverage
  dimensions?: Record<string, string>
  requirementCoverage?: Array<{
    requirement: string
    status: string
    evidence: string[]
  }>
  snapshotFingerprint?: string
  reviewedFiles?: string[]
  schemaVersion?: number
  findingRecords?: ReviewerFindingRecord[]
}

export type ReviewerFindingRecord = {
  id: string
  text: string
  severity?: string
  dimension?: string
  evidence: string[]
  correction?: string
}

export function collectReviewerFindingRecords(
  toolResult: unknown,
): ReviewerFindingRecord[] {
  // Nested spawn/set_output wrappers can surface the same receipt twice; keep
  // the FIRST record per id so `correlateReviewerFindingRecord` never sees
  // duplicates (`collectReviewerBlockers` de-dupes its strings the same way).
  const seen = new Set<string>()
  const records: ReviewerFindingRecord[] = []
  for (const entry of collectStructuredReviewerOutputs(toolResult)) {
    for (const record of entry.findingRecords ?? []) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      records.push(record)
    }
  }
  return records
}

/**
 * Advisory observations from the LAST `schemaVersion`-shaped structured reviewer
 * entry (the receipt the gate records). Recorded and displayed only: no blocker
 * collector reads them, so an advisory never blocks and never re-enters the
 * repair loop.
 *
 * Entry selection matches `resolveReviewerAttestation`'s shaped narrowing for
 * the same reason: a reviewer that QUOTES the documented example receipt AFTER
 * its real one must not have the example's advisories persisted and displayed as
 * this review's. With no shaped entry at all the LAST entry is read verbatim,
 * matching that helper's fallback.
 *
 * Non-test consumer: base2's `recordSuccessfulReviewReceipt` builds the durable
 * receipt's `advisories` with this collector at runtime through the
 * `<gate-helpers-generated>` copy emitted from this module, so the PERSISTED
 * advisory semantics (last shaped entry, trimmed, exact-duplicate-free) are the
 * tested ones instead of a second inline read of `result.advisories`.
 *
 * Reviewer-family symmetry: `advisories` is an OPTIONAL additive output field.
 * Only code-reviewer declares it today; a family that omits it (security
 * reviewer, routed specialists) reads back here as no advisories, so no other
 * reviewer schema has to migrate and an older receipt keeps round-tripping.
 *
 * Advisory text is returned verbatim (trimmed only). Delimiter safety lives at
 * the emitter: base2's `formatGateStateBlock` escapes `</` as `<\/` (a legal
 * JSON string escape) before writing the tag-delimited `<gate-state>` block, so
 * an advisory quoting the literal `</gate-state>` cannot truncate that block for
 * the CLI renderer or base2's own conversation-gate-reuse reader.
 */
export function collectReviewerAdvisories(toolResult: unknown): string[] {
  const structured = collectStructuredReviewerOutputs(toolResult)
  const shaped = structured.filter((entry) => entry.schemaVersion !== undefined)
  const candidates = shaped.length > 0 ? shaped : structured
  const last = candidates[candidates.length - 1]
  return dedupeExactStringsPreserveOrder(last?.advisories ?? [])
}

/** True when `value` is a canonical attestable `v3:<64 hex>` snapshot fingerprint. */
function isAttestableV3Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && isAttestableSnapshotFingerprint(value)
}

/** The attestation fields `collectReviewerAttestationIssues` reads. */
type ResolvedReviewerAttestation = {
  schemaVersion?: number
  snapshotFingerprint?: string
  reviewedFiles: string[]
}

/**
 * The attestation a receipt is read from, resolved ORDER-INDEPENDENTLY across
 * its `schemaVersion`-carrying (`shaped`) entries, so a quoted example on
 * EITHER side of the real receipt cannot steal the attestation and turn a
 * well-behaved review into spurious fingerprint/coverage blockers (a terminal
 * gate failure after base2's single `reviewer-protocol-attestation-failed`
 * retry). `collectReviewerAttestationIssues` already requires the shaped
 * verdicts to agree, so they describe ONE review.
 *
 * CANONICAL WHY for the entry selection; call sites carry pointers only.
 *
 * Resolution is PER FIELD, so the result is a COMPOSITE rather than one entry:
 * `reviewedFiles` is the UNION of the shaped entries, `snapshotFingerprint` is
 * the entry reporting `expectedFingerprint` else the first reporting an
 * attestable v3 fingerprint else undefined, and `schemaVersion` is 1 only when
 * EVERY shaped entry reports 1 (otherwise the first non-conforming version, so
 * the caller's `!== 1` check rejects the whole receipt).
 *
 * ACCEPTED LOOSENING (pinned in agents/__tests__/gate-reviewer.test.ts): the
 * spliced fields let a quoted example entry supply the fingerprint for a real
 * entry that reported none, and — because the union is NOT restricted to the
 * entry that contributed the credited fingerprint — a quoted example whose
 * `reviewedFiles` path COLLIDES with a real pending path (the documented
 * example literally shows `reviewedFiles: ["src/a.ts"]`) credits coverage the
 * real entry never attested. Narrowing the union would not close the
 * fingerprint half and WOULD reject the deletions-only receipt, which
 * legitimately attests with an empty `reviewedFiles`. So the guarantee is the
 * weaker one: a pending file NO entry reported at all still blocks.
 *
 * With no shaped entry at all the LAST entry is read verbatim, so a receipt that
 * never attested still fails closed on the caller's schemaVersion check.
 *
 * CALLER PRECONDITION: `structured` is non-empty.
 */
function resolveReviewerAttestation(
  structured: StructuredReviewerOutput[],
  expectedFingerprint: string,
): ResolvedReviewerAttestation {
  const shaped = structured.filter((entry) => entry.schemaVersion !== undefined)
  if (shaped.length === 0) {
    const last = structured[structured.length - 1]
    return {
      schemaVersion: last.schemaVersion,
      snapshotFingerprint: last.snapshotFingerprint,
      reviewedFiles: last.reviewedFiles ?? [],
    }
  }
  let matching: StructuredReviewerOutput | undefined
  let attestable: StructuredReviewerOutput | undefined
  for (const entry of shaped) {
    const fingerprint = entry.snapshotFingerprint ?? ''
    if (fingerprint.length === 0) continue
    if (fingerprint === expectedFingerprint) {
      matching = entry
      break
    }
    if (attestable === undefined && isAttestableV3Fingerprint(fingerprint)) {
      attestable = entry
    }
  }
  const attesting = matching ?? attestable
  const reviewedFiles: string[] = []
  for (const entry of shaped) {
    for (const file of entry.reviewedFiles ?? []) reviewedFiles.push(file)
  }
  // Surfacing the FIRST non-conforming version (instead of the attesting
  // entry's) is what makes the caller's `!== 1` check reject a receipt whose
  // sibling entry claims another schema version.
  const nonConforming = shaped.find((entry) => entry.schemaVersion !== 1)
  return {
    schemaVersion: nonConforming?.schemaVersion ?? 1,
    snapshotFingerprint: attesting?.snapshotFingerprint,
    reviewedFiles,
  }
}

export function collectReviewerAttestationIssues(
  toolResult: unknown,
  expectedFingerprint: string,
  pendingFiles: string[],
  deletedFiles?: string[],
): string[] {
  // The caller passes the reviewable subset; when it is empty there is
  // nothing to attest, so surface no attestation issues.
  if (pendingFiles.length === 0) {
    return []
  }
  const structured = collectStructuredReviewerOutputs(toolResult)
  if (structured.length === 0) {
    return [
      'BLOCKING: reviewer did not return the required structured snapshot attestation',
    ]
  }
  // CONFLICT CHECK (fail closed): a result carrying several receipts (e.g. a
  // nested spawn plus set_output) could otherwise be attested from one entry
  // while finalization credit came from another, so shaped entries that
  // disagree on the verdict are rejected outright. Unshaped entries stay out:
  // a QUOTED verdict-shaped example would otherwise park the gate in `blocked`
  // (the UNNARROWED blocker collectors still elevate one into a repair round).
  // Entry selection: see `resolveReviewerAttestation`.
  const verdicts = new Set(
    structured
      .filter((entry) => entry.schemaVersion !== undefined)
      .map((entry) => entry.verdict),
  )
  if (verdicts.size > 1) {
    return [
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ]
  }
  const result = resolveReviewerAttestation(structured, expectedFingerprint)
  // 1 only when EVERY shaped entry conforms (see `resolveReviewerAttestation`).
  if (result.schemaVersion !== 1) {
    return ['BLOCKING: reviewer returned an invalid attestation schemaVersion']
  }
  const reviewed = new Set(
    result.reviewedFiles
      .map((file) => normalizeGateFilePath(file))
      .filter((file) => file.length > 0),
  )
  // Files deleted in the changeset carry a `missing` content marker and cannot
  // be read by the reviewer, so they are attested-by-absence and excluded from
  // the missing computation. Genuinely-modified pending files still must be
  // attested, and a changeset of ONLY deletions still requires an attestable
  // fingerprint via the fail-closed check below.
  const deleted = new Set(
    (deletedFiles ?? [])
      .map((file) => normalizeGateFilePath(file))
      .filter((file) => file.length > 0),
  )
  const missing = pendingFiles
    .map((file) => normalizeGateFilePath(file))
    .filter(
      (file) => file.length > 0 && !reviewed.has(file) && !deleted.has(file),
    )
  const issues: string[] = []
  // Fingerprint tolerance: a coverage-complete review reporting a well-formed
  // v3 fingerprint is trusted even when the exact snapshot id advanced between
  // its spawn and attestation; only a FILE-COVERAGE gap or a missing /
  // non-attestable fingerprint stays a hard blocker. The tolerance is not
  // silent — every base2 caller records the drift via
  // `collectReviewerFingerprintDrift`, whose docblock carries the rationale.
  const reportedFingerprint = result.snapshotFingerprint
  const fingerprintIsAttestable = isAttestableV3Fingerprint(reportedFingerprint)
  if (!fingerprintIsAttestable) {
    // A missing / non-attestable fingerprint is never creditable, so report
    // THAT instead of mislabelling an absent fingerprint as a mismatch. Both
    // branches stay fail-closed; only the operator message differs.
    issues.push(
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    )
  } else if (
    reportedFingerprint !== expectedFingerprint &&
    missing.length > 0
  ) {
    issues.push(
      'BLOCKING: reviewer snapshot fingerprint did not match the reviewed working tree',
    )
  }
  if (missing.length > 0) {
    issues.push(
      `BLOCKING: reviewer did not attest to every pending file: ${missing.join(', ')}`,
    )
  }
  return issues
}

/**
 * The reported v3 snapshot fingerprint when a review echoed a well-formed
 * fingerprint that does NOT match the expected snapshot, else ''.
 *
 * CALLER PRECONDITION: only call this for a review whose
 * `collectReviewerAttestationIssues` came back clean. That check — not this
 * function — is what establishes coverage-completeness (every pending file
 * attested) and verdict agreement across the structured entries. This function
 * inspects only the resolved attestation (the same one
 * `collectReviewerAttestationIssues` reads, via `resolveReviewerAttestation`)
 * and reports any well-formed non-matching v3 value, including one from a
 * receipt with a file-coverage gap, so a caller that skips the attestation
 * guard would report drift for a review that is already hard-blocked. Both
 * base2 gate families guard correctly for reviews that reached attestation:
 * the final code-reviewer gate and the routed specialist gates.
 *
 * CRASH-PATH EXEMPTION: a caller that forces `attestationIssues` to `[]`
 * because `detectReviewerCrash` fired never ran attestation at all, and is
 * exempt from the precondition. A crashed result normally carries no structured
 * entry, so this function returns ''; if one does carry a drifted fingerprint,
 * the resulting record is telemetry-only and credits the review with nothing —
 * the gate still treats it as a crash.
 *
 * `collectReviewerAttestationIssues` deliberately tolerates that drift so an
 * unrelated bundle bump cannot fail the gate; callers use this to RECORD the
 * drift instead of accepting it silently, because a review of stale file
 * content would otherwise pass the gate with no trace. '' means there is
 * nothing to record: an exact match, or a missing/non-attestable fingerprint
 * (both already hard blockers in the attestation issues).
 */
export function collectReviewerFingerprintDrift(
  toolResult: unknown,
  expectedFingerprint: string,
): string {
  const structured = collectStructuredReviewerOutputs(toolResult)
  if (structured.length === 0) return ''
  const reported = resolveReviewerAttestation(
    structured,
    expectedFingerprint,
  ).snapshotFingerprint
  if (!isAttestableV3Fingerprint(reported)) return ''
  return reported === expectedFingerprint ? '' : reported
}

export function stripReviewerPreamble(text: string): string {
  let remaining = text.trim()
  // Tolerate reviewers that still emit a closed leading <think>...</think>
  // block (or several) plus surrounding whitespace before the verdict label.
  while (true) {
    const match = remaining.match(/^<think\b[^>]*>[\s\S]*?<\/think>\s*/i)
    if (!match) break
    remaining = remaining.slice(match[0].length).trim()
  }
  return remaining
}

/** True when a blocker is a pure test-coverage gap (all-coverage sets route to test-writer). */
export function isTestCoverageReviewerFinding(text: string): boolean {
  if (typeof text !== 'string') return false
  const t = text.toLowerCase()
  if (t.includes('test coverage')) return true
  if (t.includes('coverage') && /\.test\.[a-z0-9]+/.test(t)) return true
  return false
}

/**
 * Process/orchestrator work a source specialist or code reviewer cannot satisfy
 * from diff/source evidence. Keep patterns specific so real source requirements
 * that merely mention "commit" or "validation" are not suppressed.
 *
 * Evidence is consulted ONLY for explicit ownership assertions (`parent must
 * <process verb>`, `parent/operator`, ...). Every process cue must appear in
 * the REQUIREMENT text: a reviewer that merely QUOTES process prose as
 * evidence (e.g. `evidence: ['spec section: commit and push']` for "preserve
 * CLI compatibility") would otherwise convert a genuine in-scope requirement
 * gap into a credited LOOKS_GOOD with no surviving repair target.
 */
export function isParentOwnedOrOutOfScopeRequirement(
  requirement: string,
  evidence?: string[],
): boolean {
  if (typeof requirement !== 'string') return false
  // Process cues are read from the requirement text only (see above).
  const requirementText = requirement.toLowerCase()
  // Ownership assertions are honored from the requirement text or evidence.
  const ownershipText = [requirement, ...(evidence ?? [])]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase()
  if (!ownershipText.trim()) return false
  if (
    /\brewrite\b[^.\n]{0,40}\bgit\b[^.\n]{0,40}\bcommit(?:\s+messages?)?\b/.test(
      requirementText,
    ) ||
    /\bamend\b[^.\n]{0,40}\bgit\b[^.\n]{0,40}\bcommit(?:\s+messages?|\s+history)?\b/.test(
      requirementText,
    ) ||
    /\brewrite\b[^.\n]{0,40}\bcommit\s+messages?\b/.test(requirementText) ||
    /\bamend\b[^.\n]{0,40}\bcommit\s+(?:messages?|history)\b/.test(
      requirementText,
    )
  ) {
    return true
  }
  // Only the full validation gate / CI process step is parent-owned.
  // Source requirements like "run validation of the new API" stay in-scope.
  if (
    /\brun\b[^.\n]{0,24}\bfull\s+validation(?:\s+gate)?\b/.test(requirementText)
  ) {
    return true
  }
  // Repository push only: domain text like "push changes to subscribers" is
  // in-scope work, so a process push must name a repository target.
  if (
    /\bcommit\s+and\s+push\b/.test(requirementText) ||
    /\bpush\s+(?:the\s+)?changes\s+(?:upstream|to\s+(?:origin|remote|the\s+remote|the\s+upstream|the\s+branch))\b/.test(
      requirementText,
    )
  ) {
    return true
  }
  if (
    /\bconfirm\b[^.\n]{0,24}\bci\/?cd\b[^.\n]{0,24}\bgreen\b/.test(
      requirementText,
    ) ||
    /\bcheck\b[^.\n]{0,24}\bci(?:\/?cd)?\b[^.\n]{0,24}\bgreen\b/.test(
      requirementText,
    )
  ) {
    return true
  }
  // `parent must <process verb>` only: "the parent must be validated before
  // insert" is domain text, not a handoff of process work. These are ownership
  // assertions, so reviewer evidence may establish them.
  if (
    /\bparent\s+must\s+(?:also\s+|then\s+)?(?:run|commit|push|amend|rewrite|confirm|merge|deploy|release|revalidate)\b/.test(
      ownershipText,
    ) ||
    /\bparent\/?operator\b/.test(ownershipText) ||
    /\bnot\s+performed\s+by\s+this\s+specialist\b/.test(ownershipText) ||
    /\bspecialist\s+contract\s+forbids\s+basher\b/.test(ownershipText)
  ) {
    return true
  }
  return false
}

/**
 * The subset of `blockers` that are only parent-owned requirementCoverage gaps.
 *
 * Classification: the structured `requirementCoverage` row whose
 * `${status}\n${requirement}` matches the blocker decides via
 * `isParentOwnedOrOutOfScopeRequirement` (requirement text + evidence), with
 * the requirement text alone as the fallback when no row matches. The
 * structured reviewer outputs are collected once per CALL, covering the whole
 * blocker list; that is a readability convenience rather than a material
 * saving, because every other gate collector (blockers, hard blockers,
 * finalization verdict, finding records, attestation issues, fingerprint drift)
 * re-walks the same reviewer result, and `visitForStructuredVerdict`'s depth-8
 * cap is what bounds the cost.
 */
export function collectParentOwnedRequirementBlockers(
  blockers: string[],
  toolResult?: unknown,
): Set<string> {
  // Structured requirement rows keyed by `${status}\n${requirement.trim()}`;
  // the value is true only when EVERY row with that key is parent-owned once
  // its evidence is taken into account. The key is trimmed because the blocker
  // string carries the RAW requirement text and the lookup below trims it.
  const structuredRows = new Map<string, boolean>()
  if (toolResult !== undefined) {
    for (const entry of collectStructuredReviewerOutputs(toolResult)) {
      for (const requirement of entry.requirementCoverage ?? []) {
        const key = `${requirement.status}\n${requirement.requirement.trim()}`
        const parentOwnedRow = isParentOwnedOrOutOfScopeRequirement(
          requirement.requirement,
          requirement.evidence,
        )
        // In-scope precedence: getReviewerFinalizationVerdict blocks when ANY
        // matching row is in-scope, so an in-scope row must overwrite a
        // parent-owned row with the same status+text key. Otherwise the blocker
        // would be filtered out while the verdict stayed '', closing the gate
        // with no surviving repair target.
        if (!parentOwnedRow || !structuredRows.has(key)) {
          structuredRows.set(key, parentOwnedRow)
        }
      }
    }
  }
  const parentOwnedBlockers = new Set<string>()
  for (const blocker of blockers) {
    if (typeof blocker !== 'string') continue
    // `[\s\S]` (not `.`) so a multi-line requirement text is still parsed
    // instead of skipped into text-only classification.
    const match = blocker.match(
      /^BLOCKING:\s*requirement\s+(missing|uncertain):\s*([\s\S]+)$/i,
    )
    if (!match) continue
    // `status` comes from the regex above, so it is already 'missing' or
    // 'uncertain'; the row status is part of the key, so a row for the same
    // requirement with a different status never matches.
    const status = match[1].toLowerCase()
    const requirementText = match[2].trim()
    const structuredRow = structuredRows.get(`${status}\n${requirementText}`)
    if (structuredRow === undefined) {
      // No structured row matched: classify from the requirement text alone.
      if (isParentOwnedOrOutOfScopeRequirement(requirementText)) {
        parentOwnedBlockers.add(blocker)
      }
      continue
    }
    // Structured row(s) matched: trust evidence-aware classification only.
    if (structuredRow) parentOwnedBlockers.add(blocker)
  }
  return parentOwnedBlockers
}

function dedupeExactStringsPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Every blocker string a reviewer result implies: BLOCKING prose findings,
 * gate-derived hard rules (coverage missing, failed dimension, in-scope
 * requirement missing/uncertain), NON_BLOCKING prose findings, and the
 * synthetic empty-findings NON_BLOCKING placeholder.
 *
 * SYNC CONTRACT: the gate-derived hard-rule strings emitted here must stay
 * byte-identical to the ones `collectReviewerHardBlockers` emits — base2's
 * condone filter exempts hard rules via exact `Set.has` membership across the
 * two collectors. The two functions are deliberately independent (so this
 * function's byte output cannot shift); `agents/__tests__/gate-reviewer.test.ts`
 * asserts the parity.
 */
export function collectReviewerBlockers(toolResult: unknown): string[] {
  // First check for structured reviewer outputs (e.g. JSON with a
  // verdict field). BLOCKING and NON_BLOCKING both surface repair targets;
  // only LOOKS_GOOD finalizes (via getReviewerFinalizationVerdict).
  const structured = collectStructuredReviewerOutputs(toolResult)
  const structuredBlockers: string[] = []
  for (const entry of structured) {
    if (entry.verdict === 'BLOCKING') {
      const findings =
        entry.findings.length > 0 ? entry.findings : ['(no findings provided)']
      for (const finding of findings) {
        structuredBlockers.push(`BLOCKING: ${finding}`)
      }
    }
    // Coverage-adequacy / dimension / requirement hard blockers first so we
    // know whether an empty NON_BLOCKING receipt already has repair fuel.
    // Parent-owned requirement rows are deliberately NOT counted as repair
    // fuel: every gate call site filters them away again, so counting them
    // would suppress the synthetic placeholder below and leave the consumer
    // with an empty blocker list — no repair target, no condoned pass, and a
    // misdiagnosed "reviewer ran but returned no structured output" loop.
    let entryHasHardBlocker = false
    // Coverage-adequacy contract (M6.3): missing test coverage for a
    // behavior-changing edit is BLOCKING regardless of the text verdict.
    if (entry.coverage === 'missing') {
      structuredBlockers.push(
        'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      )
      entryHasHardBlocker = true
    }
    // Reviewer dimensions follow the contract's "<word>: <clause>" style, so a
    // blocking dimension arrives as `block: <clause>` (or `blocks:` /
    // `blocking:` / `blocker(s):`). Match the leading word only: `blocked` is a
    // different word (a state, not a verdict) and must NOT count as failing.
    for (const [dimension, status] of Object.entries(entry.dimensions ?? {})) {
      if (/^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase())) {
        structuredBlockers.push(
          `BLOCKING: ${dimension} review dimension failed`,
        )
        entryHasHardBlocker = true
      }
    }
    // Keep parent-owned process requirement gaps in the raw blocker list so
    // consumers can credit LOOKS_GOOD via parentOwnedOnlyBlockers (filter at
    // the call site; do not filter or elevate them here).
    for (const requirement of entry.requirementCoverage ?? []) {
      if (
        requirement.status === 'missing' ||
        requirement.status === 'uncertain'
      ) {
        // Requirement text only in the string; call-site parent-owned filters
        // re-check structured requirementCoverage (+ evidence) via
        // collectParentOwnedRequirementBlockers(blockers, toolResult).
        structuredBlockers.push(
          `BLOCKING: requirement ${requirement.status}: ${requirement.requirement}`,
        )
        // Only an IN-SCOPE gap is repair fuel, decided with the same predicate
        // the call-site filter uses (requirement text + evidence).
        if (
          !isParentOwnedOrOutOfScopeRequirement(
            requirement.requirement,
            requirement.evidence,
          )
        ) {
          entryHasHardBlocker = true
        }
      }
    }

    // NON_BLOCKING is repair fuel, not a pass: elevate findings into the
    // same repair path used for BLOCKING until the reviewer returns LOOKS_GOOD.
    // Empty-findings synthetic is only needed when no hard blocker already
    // forces re-review — otherwise pure coverage-missing sets would mix a
    // non-coverage string and break all-coverage → test-writer routing.
    if (entry.verdict === 'NON_BLOCKING') {
      if (entry.findings.length > 0) {
        for (const finding of entry.findings) {
          structuredBlockers.push(`NON_BLOCKING: ${finding}`)
        }
      } else if (!entryHasHardBlocker) {
        structuredBlockers.push(
          'NON_BLOCKING: reviewer returned non-blocking nits without findings; re-address and re-review until LOOKS_GOOD',
        )
      }
    }
  }
  // Nested spawn/set_output wrappers can surface the same structured receipt
  // twice; exact-string de-dupe keeps first-seen order without dropping
  // legitimately distinct blockers.
  if (structuredBlockers.length > 0) {
    return dedupeExactStringsPreserveOrder(structuredBlockers)
  }

  const texts: string[] = []
  collectStrings(toolResult, texts)
  return dedupeExactStringsPreserveOrder(
    texts
      .map((text) => stripReviewerPreamble(text))
      .filter((text) => hasReviewerLineVerdict(text, 'BLOCKING')),
  )
}

/**
 * ONLY the gate-derived hard rules the gate itself derives from the reviewer's
 * structured fields: the coverage-missing string, one string per `block`
 * dimension, and one string per in-scope requirement whose status is
 * `missing`/`uncertain`. Reviewer prose findings (BLOCKING or NON_BLOCKING) and
 * the synthetic empty-findings placeholder are deliberately excluded: they are
 * the only blockers a repair round can legitimately "address", so only they are
 * condonable.
 *
 * SYNC CONTRACT: these strings must stay byte-identical to the corresponding
 * ones produced by `collectReviewerBlockers` — base2's condone filter compares
 * them with exact `Set.has` membership, so a single-character divergence would
 * silently stop exempting hard rules. The two functions are kept independent so
 * `collectReviewerBlockers`' byte output cannot shift; the parity is asserted by
 * `agents/__tests__/gate-reviewer.test.ts`.
 */
export function collectReviewerHardBlockers(toolResult: unknown): string[] {
  const structured = collectStructuredReviewerOutputs(toolResult)
  const hardBlockers: string[] = []
  for (const entry of structured) {
    if (entry.coverage === 'missing') {
      hardBlockers.push(
        'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      )
    }
    // Same prefix rule as collectReviewerBlockers (kept independently): the
    // trimmed, lowercased value starting with the word `block` (or
    // `blocks`/`blocking`/`blocker`/`blockers`) fails, so `block: <clause>`,
    // `blocks: <clause>` and `blocking: <clause>` count while `blocked` does
    // not.
    for (const [dimension, status] of Object.entries(entry.dimensions ?? {})) {
      if (/^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase())) {
        hardBlockers.push(`BLOCKING: ${dimension} review dimension failed`)
      }
    }
    for (const requirement of entry.requirementCoverage ?? []) {
      if (
        requirement.status === 'missing' ||
        requirement.status === 'uncertain'
      ) {
        hardBlockers.push(
          `BLOCKING: requirement ${requirement.status}: ${requirement.requirement}`,
        )
      }
    }
  }
  return dedupeExactStringsPreserveOrder(hardBlockers)
}

/**
 * Detects whether the reviewer agent itself crashed (returned an `errorMessage`
 * field, threw, or otherwise produced no usable output) as opposed to running
 * successfully but failing to populate its required structured verdict. The
 * two cases warrant very different operator messages:
 *   - crash    → "reviewer agent crashed; verdict cannot be trusted" (retry or escalate)
 *   - no-verdict → "reviewer returned no structured output" (automated retry)
 *
 * Heuristic: walks the tool-result tree looking for any object that carries an
 * `errorMessage` string or whose `type === 'error'`. Returns the first such
 * message so callers can surface it verbatim. Returns `null` when the result
 * looks like a normal (possibly malformed) reviewer reply.
 */
export function detectReviewerCrash(toolResult: unknown): string | null {
  return findReviewerCrash(toolResult)
}

function findReviewerCrash(value: unknown, depth: number = 0): string | null {
  // Depth cap: reviewer tool results can carry deeply nested tool-call trees
  // (the reviewer itself may have invoked other tools). 8 is well past any
  // realistic agent-result envelope but stops pathological recursion.
  if (depth > 8) return null
  if (!value) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findReviewerCrash(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  // NOTE: an unrelated nested `errorMessage` (e.g. a failed inner tool call
  // the reviewer made) will also be classified as a reviewer-agent crash.
  // This is acceptable because the caller only consults detectReviewerCrash
  // when the reviewer also failed to emit a recognizable verdict — a
  // reviewer whose inner tool call errored AND who produced no verdict is
  // effectively crashed from the operator's perspective.
  if (typeof record.errorMessage === 'string' && record.errorMessage.trim()) {
    return record.errorMessage.trim()
  }
  if (record.type === 'error' && typeof record.message === 'string') {
    return (
      record.message.trim() || 'reviewer agent reported an unspecified error'
    )
  }
  const jsonNode = record.type === 'json' && 'value' in record
  if (jsonNode) {
    const nested = findReviewerCrash(record.value, depth + 1)
    if (nested) return nested
  }
  for (const [key, nested] of Object.entries(record)) {
    // The json recursion above already walked `value`; walking it again would
    // double the work at every nesting level up to the depth cap.
    if (jsonNode && key === 'value') continue
    const found = findReviewerCrash(nested, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * True when a reviewer crash message is a transient provider/rate-limit style
 * failure rather than a content or hard protocol crash. Used so the gate can
 * fail closed for the turn without thrashing repair-editor or bare-hex retries.
 *
 * Patterns are inlined (not a module-level const) so generate-gate-helpers can
 * emit a self-contained function into base2's handleSteps region.
 */
export function isTransientReviewerCrash(message: string): boolean {
  if (typeof message !== 'string' || !message.trim()) return false
  const lower = message.toLowerCase()
  // Provider / rate-limit / concurrency crash strings (case-insensitive).
  const patterns = [
    'rate_limit',
    'rate limit',
    'concurrency limit',
    'concurrency limit exceeded',
    'please retry later',
    'overloaded',
    '429',
    'resource_exhausted',
    'too many requests',
  ]
  return patterns.some((pattern) => lower.includes(pattern))
}

/**
 * Coarse crash taxonomy for specialist/reviewer failures.
 * null/empty → none; rate-limit patterns → transient; optional protocol-ish
 * bare-hex / non-attestable / snapshot-attestation wording → protocol; else fatal.
 *
 * Non-test consumer: base2's specialist review gate branches on
 * `classifyReviewerCrash(crash) === 'protocol'` / `'transient'` at runtime via
 * the `<gate-helpers-generated>` copy emitted from this module, so this is the
 * canonical source of that taxonomy rather than a dead public helper.
 */
export function classifyReviewerCrash(
  message: string | null,
): 'none' | 'transient' | 'protocol' | 'fatal' {
  if (typeof message !== 'string' || !message.trim()) return 'none'
  if (isTransientReviewerCrash(message)) return 'transient'
  const lower = message.toLowerCase()
  // The `(?:^|[^:])` prefix already excludes a `v3:<64hex>` token's own hex (the
  // character before the run may not be ':'), so a message that ALSO carries a
  // well-formed v3 token still classifies as 'protocol' when it contains a
  // separate bare 64-hex run. No extra v3 guard: it only suppressed genuine
  // bare-hex detection.
  const hasBareHex = /(?:^|[^:])\b[a-f0-9]{64}\b/i.test(message)
  if (
    hasBareHex ||
    lower.includes('non-attestable') ||
    lower.includes('snapshot attestation') ||
    (lower.includes('fingerprint') &&
      (lower.includes('attest') ||
        lower.includes('bare') ||
        lower.includes('did not match')))
  ) {
    return 'protocol'
  }
  return 'fatal'
}

export function getReviewerFinalizationVerdict(
  toolResult: unknown,
): ReviewerFinalizationVerdict {
  // Automated gates accept only schema-backed structured reviewer output.
  const structured = collectStructuredReviewerOutputs(toolResult)
  // Coverage-adequacy contract (M6.3): missing coverage blocks finalization
  // even if the text verdict is LOOKS_GOOD / NON_BLOCKING.
  if (structured.some((entry) => entry.coverage === 'missing')) {
    return ''
  }
  // Incomplete in-scope requirements (missing/uncertain) also block
  // finalization even when the reviewer emits a soft top-level verdict.
  // Parent-owned process tasks are not RF blockers for source reviewers.
  if (
    structured.some((entry) =>
      (entry.requirementCoverage ?? []).some(
        (requirement) =>
          (requirement.status === 'missing' ||
            requirement.status === 'uncertain') &&
          !isParentOwnedOrOutOfScopeRequirement(
            requirement.requirement,
            requirement.evidence,
          ),
      ),
    )
  ) {
    return ''
  }
  // A failing review dimension (`block` / `block: <clause>` / `blocks:` /
  // `blocking:` / `blocker(s): <clause>`) is a gate-derived hard blocker as
  // well, so it blocks finalization alongside coverage-missing and in-scope
  // requirement gaps instead of riding along with LOOKS_GOOD.
  if (
    structured.some((entry) =>
      Object.values(entry.dimensions ?? {}).some((status) =>
        /^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase()),
      ),
    )
  ) {
    return ''
  }
  // Finalization credit is LOOKS_GOOD only. NON_BLOCKING findings are
  // elevated by collectReviewerBlockers into the repair loop.
  // The scan is restricted to the `schemaVersion`-carrying entries whenever the
  // receipt carries any, so credit and collectReviewerAttestationIssues read
  // the SAME entry set and an unshaped quoted LOOKS_GOOD example cannot credit
  // a receipt whose real entry is BLOCKING. With no shaped entry the whole set
  // is read, matching `resolveReviewerAttestation`'s verbatim fallback.
  const creditable = structured.some(
    (entry) => entry.schemaVersion !== undefined,
  )
    ? structured.filter((entry) => entry.schemaVersion !== undefined)
    : structured
  for (const entry of creditable) {
    if (entry.verdict === 'LOOKS_GOOD') return 'LOOKS_GOOD'
  }

  return ''
}

/**
 * Walk the reviewer tool result for objects that look like a structured
 * reviewer verdict: `{ verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING', findings?: string | string[], coverage?: 'covered' | 'missing' | 'n/a' }`.
 * Returns an ordered list of normalized entries. Plain text reviewer
 * outputs return an empty list so the existing text-mode logic stays in
 * charge.
 */
function collectStructuredReviewerOutputs(
  value: unknown,
): StructuredReviewerOutput[] {
  const out: StructuredReviewerOutput[] = []
  visitForStructuredVerdict(value, out)
  return out
}

function visitForStructuredVerdict(
  value: unknown,
  out: StructuredReviewerOutput[],
  depth: number = 0,
): void {
  // Depth cap (same value findReviewerCrash uses on the same envelopes): 8 is
  // well past any realistic agent-result envelope but stops pathological or
  // self-referential recursion from blowing the stack.
  if (depth > 8) return
  if (!value) return
  if (Array.isArray(value)) {
    for (const item of value) visitForStructuredVerdict(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (record.type === 'json' && 'value' in record) {
    visitForStructuredVerdict(record.value, out, depth + 1)
    return
  }
  const rawVerdict = record.verdict
  if (typeof rawVerdict === 'string') {
    const upper = rawVerdict.trim().toUpperCase()
    if (
      upper === 'LOOKS_GOOD' ||
      upper === 'NON_BLOCKING' ||
      upper === 'BLOCKING'
    ) {
      // ONE normalizer for object findings so the human-readable `findings`
      // strings and the structured `findingRecords` below cannot drift.
      const normalizeObjectFinding = (finding: object) => {
        const item = finding as Record<string, unknown>
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const text =
          typeof item.summary === 'string'
            ? item.summary.trim()
            : typeof item.text === 'string'
              ? item.text.trim()
              : ''
        return { id, text }
      }
      const findings: string[] = []
      const rawFindings = record.findings
      if (typeof rawFindings === 'string') {
        const trimmed = rawFindings.trim()
        if (trimmed) findings.push(trimmed)
      } else if (Array.isArray(rawFindings)) {
        for (const finding of rawFindings) {
          if (typeof finding === 'string' && finding.trim()) {
            findings.push(finding.trim())
          } else if (finding && typeof finding === 'object') {
            const { id, text } = normalizeObjectFinding(finding)
            if (text) findings.push(id ? `[${id}] ${text}` : text)
          }
        }
      }
      const advisories: string[] = []
      const rawAdvisories = record.advisories
      if (typeof rawAdvisories === 'string') {
        const trimmed = rawAdvisories.trim()
        if (trimmed) advisories.push(trimmed)
      } else if (Array.isArray(rawAdvisories)) {
        for (const advisory of rawAdvisories) {
          if (typeof advisory === 'string' && advisory.trim()) {
            advisories.push(advisory.trim())
          }
        }
      }
      let coverage: ReviewerCoverage | undefined
      const rawCoverage = record.coverage
      if (typeof rawCoverage === 'string') {
        const lower = rawCoverage.trim().toLowerCase()
        if (lower === 'covered' || lower === 'missing' || lower === 'n/a') {
          coverage = lower
        }
      }
      out.push({
        verdict: upper as ReviewerStructuredVerdict,
        findings,
        ...(advisories.length > 0 ? { advisories } : {}),
        coverage,
        dimensions:
          record.dimensions && typeof record.dimensions === 'object'
            ? Object.fromEntries(
                Object.entries(
                  record.dimensions as Record<string, unknown>,
                ).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === 'string',
                ),
              )
            : undefined,
        requirementCoverage: Array.isArray(record.requirementCoverage)
          ? record.requirementCoverage.flatMap((item) => {
              if (!item || typeof item !== 'object') return []
              const requirement = (item as Record<string, unknown>).requirement
              const status = (item as Record<string, unknown>).status
              const evidence = (item as Record<string, unknown>).evidence
              return typeof requirement === 'string' &&
                typeof status === 'string'
                ? [
                    {
                      requirement,
                      status: status.toLowerCase(),
                      evidence: Array.isArray(evidence)
                        ? evidence.filter(
                            (value): value is string =>
                              typeof value === 'string',
                          )
                        : [],
                    },
                  ]
                : []
            })
          : undefined,
        snapshotFingerprint:
          typeof record.snapshotFingerprint === 'string'
            ? record.snapshotFingerprint
            : undefined,
        reviewedFiles: Array.isArray(record.reviewedFiles)
          ? record.reviewedFiles.filter(
              (file): file is string => typeof file === 'string',
            )
          : undefined,
        schemaVersion:
          typeof record.schemaVersion === 'number'
            ? record.schemaVersion
            : undefined,
        findingRecords: Array.isArray(rawFindings)
          ? rawFindings.flatMap((finding) => {
              if (!finding || typeof finding !== 'object') return []
              const item = finding as Record<string, unknown>
              const { id, text } = normalizeObjectFinding(finding)
              if (!id || !text) return []
              return [
                {
                  id,
                  text,
                  ...(typeof item.severity === 'string'
                    ? { severity: item.severity }
                    : {}),
                  ...(typeof item.dimension === 'string'
                    ? { dimension: item.dimension }
                    : {}),
                  evidence: Array.isArray(item.evidence)
                    ? item.evidence.filter(
                        (value): value is string => typeof value === 'string',
                      )
                    : [],
                  ...(typeof item.correction === 'string'
                    ? { correction: item.correction }
                    : {}),
                },
              ]
            })
          : undefined,
      })
      return
    }
  }
  for (const nested of Object.values(record)) {
    visitForStructuredVerdict(nested, out, depth + 1)
  }
}

function hasReviewerLineVerdict(
  text: string,
  verdict: ReviewerStructuredVerdict,
): boolean {
  // Compiled once per call: built inside the per-line `.some` callback it was
  // recompiled for every line of every string collected from the tool result.
  const linePattern = new RegExp(`^${verdict}\\b`, 'i')
  return text.split(/\r?\n/).some((line) => linePattern.test(line.trim()))
}

function collectStrings(
  value: unknown,
  out: string[],
  depth: number = 0,
): void {
  // Depth cap (same value findReviewerCrash uses on the same envelopes): 8 is
  // well past any realistic agent-result envelope but stops pathological or
  // self-referential recursion from blowing the stack.
  if (depth > 8) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (!value) return
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStrings(nested, out, depth + 1)
  }
}
