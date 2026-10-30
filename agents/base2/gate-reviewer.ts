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

import {
  hashGateSnapshotDetails,
  isAttestableSnapshotFingerprint,
} from './gate-fingerprint'
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
 * Resolution is ENTRY-SCOPED when an attestation exists (fail closed, M1-T4a):
 * the attesting entry — the one reporting `expectedFingerprint`, else the
 * first reporting an attestable v3 fingerprint — supplies BOTH
 * `snapshotFingerprint` AND `reviewedFiles`. A prompt-injected quoted example
 * can no longer splice its fingerprint onto a real entry's coverage, nor its
 * coverage onto a real entry's fingerprint. When NO entry reports an
 * attestable fingerprint the receipt already fails closed on the
 * missing-fingerprint blocker, so the coverage union is preserved purely so
 * the diagnostic stays informative. `schemaVersion` is 1 only when EVERY
 * shaped entry reports 1 (otherwise the first non-conforming version, so the
 * caller's `!== 1` check rejects the whole receipt);
 * `collectReviewerAttestationIssues` additionally rejects a result whose
 * shaped entries report distinct attestable fingerprints while NO entry
 * reports the expected one (ambiguous multi-receipt attestation — when the
 * expected fingerprint IS reported, entry-scoping resolves unambiguously and
 * sibling foreign fingerprints are tolerated order-independently).
 *
 * The deletions-only receipt (a single shaped entry with an attestable
 * fingerprint and empty `reviewedFiles`) still attests.
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
  // M1-T4a (fail closed): when an ATTESTING entry exists, BOTH attestation
  // fields come from it — not a per-field composite. A quoted example entry
  // (prompt injection inside the reviewer result) can no longer lend its
  // fingerprint to a real entry's coverage, nor its coverage to a real
  // entry's fingerprint: the splice was the forged-receipt vector and is
  // closed. When NO entry reports an attestable fingerprint there is nothing
  // to splice — the receipt already fails closed on the missing-fingerprint
  // blocker — so the union keeps the coverage diagnostic informative instead
  // of manufacturing a spurious missing-file blocker.
  const attesting = matching ?? attestable
  const reviewedFiles = attesting
    ? (attesting.reviewedFiles ?? [])
    : shaped.flatMap((entry) => entry.reviewedFiles ?? [])
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
  // M1-T4a (fail closed, order-independent): when NO shaped entry reports the
  // EXPECTED fingerprint, two or more DISTINCT attestable v3 fingerprints make
  // the result ambiguous — more than one receipt's worth of attestation with no
  // way to tell which is real — so the whole result is rejected. When the
  // expected fingerprint IS reported, resolution is unambiguous (that entry
  // wins outright) and sibling foreign fingerprints are tolerated
  // order-independently (RF-2): entry-scoping already binds coverage to the
  // attesting entry, so a sibling can neither lend nor steal either field.
  const reportedFingerprints = new Set(
    structured
      .filter((entry) => entry.schemaVersion !== undefined)
      .map((entry) => entry.snapshotFingerprint)
      .filter((value): value is string => isAttestableV3Fingerprint(value)),
  )
  const reportsExpectedFingerprint = structured.some(
    (entry) =>
      entry.schemaVersion !== undefined &&
      entry.snapshotFingerprint === expectedFingerprint,
  )
  if (reportedFingerprints.size > 1 && !reportsExpectedFingerprint) {
    return [
      'BLOCKING: reviewer returned conflicting snapshot fingerprints in one result',
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
  // Scope: an inner tool-result envelope (a tool call the reviewer itself
  // made) carries the inner tool's own failure data. Its `errorMessage` (or
  // `type: 'error'` payload) describes that inner tool call, not a
  // reviewer-agent crash, so the entire envelope subtree is skipped instead
  // of being walked for crash markers.
  if (
    typeof record.toolCallId === 'string' ||
    record.type === 'tool_result'
  ) {
    return null
  }
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
  // allowNonBlocking=false makes the resolver's NON_BLOCKING branch statically
  // unreachable, so narrowing it back to '' here is sound (and keeps the
  // exported contract unchanged for every existing caller).
  const verdict = resolveReviewerFinalizationVerdict(toolResult, false)
  return verdict === 'NON_BLOCKING' ? '' : verdict
}

/**
 * NON_BLOCKING is the security-reviewer family's clean verdict; its findings
 * are elevated by the caller's blocker branch before the protocol check, so a
 * clean security review may credit finalization instead of being misclassified
 * as a protocol failure. All pre-credit gates (coverage missing, incomplete
 * in-scope requirements, blocking dimensions) still apply; the default
 * `getReviewerFinalizationVerdict` keeps crediting LOOKS_GOOD only.
 */
export function getSecurityReviewerFinalizationVerdict(
  toolResult: unknown,
): 'LOOKS_GOOD' | 'NON_BLOCKING' | '' {
  return resolveReviewerFinalizationVerdict(toolResult, true)
}

function resolveReviewerFinalizationVerdict(
  toolResult: unknown,
  allowNonBlocking: boolean,
): 'LOOKS_GOOD' | 'NON_BLOCKING' | '' {
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
  // Finalization credit is LOOKS_GOOD only for the default variant;
  // NON_BLOCKING findings are elevated by collectReviewerBlockers into the
  // repair loop (the security-reviewer variant may credit NON_BLOCKING — see
  // getSecurityReviewerFinalizationVerdict).
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
    // Security-reviewer family: NON_BLOCKING is its clean verdict (see the
    // docblock on getSecurityReviewerFinalizationVerdict).
    if (allowNonBlocking && entry.verdict === 'NON_BLOCKING') {
      return 'NON_BLOCKING'
    }
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
  // Gate-crash fix: schemaVersion inherited from the nearest enclosing
  // ENVELOPE record (agentReceipt / review / output / result slots and the
  // json/structuredOutput wrappers). The runtime receipt carries
  // `schemaVersion: 1` while the compact review inside it omits it, so the
  // review entry used to resolve UNSHAPED and the attestation check failed
  // closed ("invalid attestation schemaVersion" / no structured snapshot
  // attestation) — parking the gate after its single retry despite a valid
  // review. Inheritance NEVER crosses arrays or arbitrary keys, so a
  // verdict-shaped quoted example nested in findings/evidence stays unshaped
  // exactly as before.
  envelopeSchemaVersion?: number,
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
  const recordSchemaVersion =
    typeof record.schemaVersion === 'number' ? record.schemaVersion : undefined
  const inheritedSchemaVersion = recordSchemaVersion ?? envelopeSchemaVersion
  if (
    (record.type === 'json' || record.type === 'structuredOutput') &&
    'value' in record
  ) {
    visitForStructuredVerdict(record.value, out, depth + 1, inheritedSchemaVersion)
    // spawn_agent_inline can surface the agent receipt as a SIBLING of
    // `value` on the json record; the receipt carries the compact review
    // when the bulky payload was truncated in transit. Visit it too —
    // recognition only; an absent receipt is a no-op.
    if (record.type === 'json' && record.agentReceipt !== undefined) {
      visitForStructuredVerdict(
        record.agentReceipt,
        out,
        depth + 1,
        inheritedSchemaVersion,
      )
    }
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
            : envelopeSchemaVersion,
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
  for (const [key, nested] of Object.entries(record)) {
    // Dedicated envelope slots inherit this record's schemaVersion (the
    // receipt carries it, the verdict object inside omits it). Every other
    // key — evidence, findings, quoted examples — never inherits, so a
    // verdict-shaped quote stays unshaped and outside the conflict checks.
    const slotSchemaVersion =
      key === 'agentReceipt' ||
      key === 'review' ||
      key === 'output' ||
      key === 'result'
        ? inheritedSchemaVersion
        : undefined
    visitForStructuredVerdict(nested, out, depth + 1, slotSchemaVersion)
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

/**
 * Wave 3 (A6) DETERMINISTIC VERDICT RECOVERY.
 *
 * Reviewer-family agents occasionally emit a schema-valid verdict inside a
 * prose reply, a fenced code block, or a JSON object whose verdict lives under
 * a NON-slot key (`reviewVerdict` / `finalVerdict` / `decision` / `status`)
 * instead of the `verdict` slot the gate recognizes. Today the EXISTING
 * recognizer (`collectStructuredReviewerOutputs` / `visitForStructuredVerdict`)
 * drops every one of those, and the gate parks in the no-verdict retry loop
 * even though a valid review was returned. This helper is a SEPARATE pre-pass
 * that text-repairs the leaf STRINGS of a tool result so the UNMODIFIED
 * recognizer can shape the verdict on the next pass.
 *
 * INV-A.2 (recovery never mints attestation): the recovered node carries ONLY
 * the normalized `verdict` (+ `schemaVersion: 1`); it NEVER synthesizes
 * `findings`, `findingRecords`, `advisories`, `requirementCoverage`,
 * `dimensions`, `snapshotFingerprint`, or `reviewedFiles`. A recovered object
 * therefore still fails closed on the unmodified attestation check — the gate
 * cannot be talked into a forged snapshot by prompt-injected text.
 *
 * R0 short-circuit: when the result ALREADY carries a shaped entry (any
 * `schemaVersion !== undefined`), the input is returned VERBATIM
 * (byte-identical) so recovery can never perturb an already-recognizable
 * receipt. Only a result the recognizer would otherwise DROP is repaired.
 *
 * Recovery NEVER widens `stripReviewerPreamble` / `visitForStructuredVerdict`:
 * those stay the global verdict surface. This is a bounded pre-pass over leaf
 * strings only.
 *
 * Hoisted top-level `function` (NOT a module-scope const) because
 * `scripts/generate-gate-helpers.ts` splices ONLY top-level function/type/
 * interface declarations into base2's `<gate-helpers-generated>` region and
 * emits NO imports and NO module-scope `const`/`let`. Every regex and lookup
 * table is therefore inlined in the body, exactly as `isTransientReviewerCrash`
 * already inlines its `patterns` array. It CALLS the existing module-private
 * recognizer (`collectStructuredReviewerOutputs`), which the generator also
 * emits, so the spliced copy resolves it in-region.
 */
export function recoverStructuredReviewerOutputs(toolResult: unknown): unknown {
  // R0: an already-shaped receipt is returned byte-identical. `some` (not
  // `every`) matches the recognizer's own "any shaped entry exists" narrowing,
  // so a result the gate already credits is never rewritten.
  const existing = collectStructuredReviewerOutputs(toolResult)
  if (existing.length > 0 && existing.some((e) => e.schemaVersion !== undefined)) {
    return toolResult
  }
  // Walk the SAME envelope shapes `visitForStructuredVerdict` walks (depth 8,
  // `json`/`structuredOutput` recursed into `value`, `json` also into
  // `agentReceipt`). Record the LAST qualifying candidate: a real receipt tends
  // to FOLLOW a quoted example in the reviewer's prose, so the last hit is the
  // one that describes this review.
  let recovered: Record<string, unknown> | undefined
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return
    if (!value) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === 'string') {
      const candidate = extractVerdictObjectFromText(value)
      if (candidate) recovered = candidate
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (
      (record.type === 'json' || record.type === 'structuredOutput') &&
      'value' in record
    ) {
      visit(record.value, depth + 1)
      if (record.type === 'json' && record.agentReceipt !== undefined) {
        visit(record.agentReceipt, depth + 1)
      }
      return
    }
    for (const nested of Object.values(record)) {
      visit(nested, depth + 1)
    }
  }
  visit(toolResult, 0)
  if (!recovered) return toolResult
  // Synthetic node shaped so the EXISTING recognizer credits it: the recognizer
  // reads `json.value` and inherits `schemaVersion` from the wrapper. NO extra
  // sentinel keys (a collector might enumerate them into operator output).
  return { type: 'json', value: recovered, schemaVersion: 1 }
}

/**
 * Fix 1 — FINGERPRINT-GATED PROSE-VERDICT RECOVERY.
 *
 * Why this exists: R5 in `extractVerdictObjectFromText` returns null for a
 * prose-only verdict line (LOOKS_GOOD / NON_BLOCKING / BLOCKING on its own
 * line) on purpose — synthesizing a verdict from prose ALONE would let
 * prompt-injected file content (e.g. `// BLOCKING: ...` in a reviewed file)
 * forge a review. This SEPARATE pre-pass promotes a prose verdict ONLY when
 * the reviewer's own output ALSO evidences the attestation it was asked to
 * echo: the exact expected fingerprint AND at least one reviewed file path
 * appear in the same tool result. That double signal is the recovery's gate;
 * without BOTH signals this function is a byte-identical no-op.
 *
 * INV-A.2 (recovery never mints attestation): the synthetic node carries ONLY
 * the normalized `verdict` (+ `schemaVersion: 1`). It NEVER synthesizes
 * `snapshotFingerprint`, `reviewedFiles`, `findings`, `dimensions`, or
 * `requirementCoverage` — the attestation must still flow from the reviewer's
 * own echoed text through the separate existing attestation path, so a forged
 * prose verdict can never satisfy `collectReviewerAttestationIssues`.
 *
 * Hoisted top-level `function` (NOT a module-scope const) for the same reason
 * as `recoverStructuredReviewerOutputs`: `scripts/generate-gate-helpers.ts`
 * splices ONLY top-level function/type/interface declarations into base2's
 * `<gate-helpers-generated>` region and emits NO imports and NO module-scope
 * `const`/`let`. Every regex and lookup is therefore inlined in the body. It
 * reuses the existing module-private helpers (`collectStructuredReviewerOutputs`,
 * `collectStrings`, `stripReviewerPreamble`, `hasReviewerLineVerdict`), which
 * the generator also emits, so the spliced copy resolves them in-region.
 */
export function recoverProseVerdictWithAttestation(
  toolResult: unknown,
  expectedFingerprint: string,
  pendingFiles: string[],
): unknown {
  // 1. R0 short-circuit: an already-shaped receipt is returned byte-identical.
  //    `some` (not `every`) matches the recognizer's own "any shaped entry"
  //    narrowing, so a result the gate already credits is never rewritten.
  const existing = collectStructuredReviewerOutputs(toolResult)
  if (existing.some((entry) => entry.schemaVersion !== undefined)) {
    return toolResult
  }
  // 2. Collect every leaf string and look for prose verdict lines through the
  //    SAME helpers `diagnoseReviewerVerdictRejection` and
  //    `collectProseVerdictLines` use, so this recovery and the diagnostic
  //    agree on what "a prose verdict" is. Record the LAST qualifying line's
  //    normalized literal (a real receipt tends to follow a quoted example).
  const texts: string[] = []
  collectStrings(toolResult, texts)
  let lastProseVerdict = ''
  for (const text of texts) {
    const cleaned = stripReviewerPreamble(text)
    for (const rawLine of cleaned.split(/\r?\n/)) {
      const line = rawLine.trim()
      const match = /^(LOOKS_GOOD|NON_BLOCKING|BLOCKING)\b/i.exec(line)
      if (match)
        lastProseVerdict = match[1].trim().toUpperCase()
    }
  }
  if (!lastProseVerdict) return toolResult
  // 3. FAIL CLOSED unless BOTH attestation signals are present in the collected
  //    text: the exact expected fingerprint string and at least one pending
  //    file path verbatim as a substring. This is what keeps prompt-injected
  //    prose from forging a review: a forged line cannot also echo the opaque
  //    runtime fingerprint AND a real reviewed path unless the reviewer
  //    itself supplied them.
  if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length === 0) {
    return toolResult
  }
  const hasFingerprint = texts.some((text) => text.includes(expectedFingerprint))
  if (!hasFingerprint) return toolResult
  const hasReviewedFile = pendingFiles.some(
    (file) => typeof file === 'string' && file.length > 0 && texts.some((text) => text.includes(file)),
  )
  if (!hasReviewedFile) return toolResult
  // 4. Both signals present: synthesize ONLY the verdict (+ schemaVersion).
  return {
    type: 'json',
    value: { verdict: lastProseVerdict, schemaVersion: 1 },
    schemaVersion: 1,
  }
}

/**
 * Wave 3 (A6) ordered, first-wins verdict-object extraction from ONE leaf
 * string. Returns the normalized verdict object (a plain record carrying at
 * least a canonical `verdict` literal) or null. Recovery NEVER synthesizes
 * fields beyond `verdict` / `schemaVersion` (see
 * `recoverStructuredReviewerOutputs` for the INV-A.2 rationale).
 *
 * Order (first hit wins):
 *   R1a whole string is a JSON object (`{` after trim) that parses + is
 *       verdict-shaped.
 *   R1b a fenced code block (```json or ```) whose body parses to a
 *       verdict-shaped object.
 *   R2  the first balanced `{...}` span in prose that parses to a
 *       verdict-shaped object.
 *   R3  a balanced `{...}` span that parses to an object whose verdict literal
 *       sits under a NON-slot key among reviewVerdict/finalVerdict/decision/
 *       status — normalize that key to `verdict`.
 *   R4  a `coverage` value outside the three literals but mappable, applied in
 *       `normalizeVerdictKeyAndCoverage`, FAIL-CLOSED and TOTAL.
 *   R5  verdict present ONLY as a prose line (LOOKS_GOOD / NON_BLOCKING /
 *       BLOCKING on its own line) with no JSON object -> null. DO NOT
 *       synthesize from prose: prompt-injection — a reviewed file's content
 *       could contain `// BLOCKING:` and a prose-derived verdict would let it
 *       forge a review.
 *       ESCAPE HATCH (separate pre-pass, NOT part of this ladder):
 *       `recoverProseVerdictWithAttestation` is the fingerprint-gated route
 *       around R5. It only promotes a prose verdict when the SAME tool result
 *       also echoes the exact expected snapshot fingerprint AND at least one
 *       pending file path, which a forged in-file line cannot produce. R5
 *       stays unconditional here so this ladder's fail-closed contract remains
 *       readable and prose alone can never shape a verdict.
 *
 * Hoisted top-level `function`; every regex is inlined (no module-scope const)
 * so the spliced copy is self-contained.
 */
function extractVerdictObjectFromText(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null
  const cleaned = stripReviewerPreamble(text)
  if (!cleaned) return null

  // R1a: the whole string IS a JSON object.
  if (cleaned.startsWith('{')) {
    const parsed = tryParseJsonObject(cleaned)
    if (parsed && isVerdictShaped(parsed)) {
      return normalizeVerdictKeyAndCoverage(parsed)
    }
  }

  // R1b: a fenced code block (```json or ```) whose body is a verdict object.
  {
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)
    if (fence) {
      const parsed = tryParseJsonObject(fence[1].trim())
      if (parsed && isVerdictShaped(parsed)) {
        return normalizeVerdictKeyAndCoverage(parsed)
      }
    }
  }

  // R2 / R3: balanced `{...}` spans in prose. First verdict-shaped span wins;
  // otherwise the first span whose verdict literal sits under a NON-slot key is
  // normalized to `verdict` (R3).
  const spans = balancedObjectSpans(cleaned)
  let r3Candidate: Record<string, unknown> | null = null
  for (const span of spans) {
    const parsed = tryParseJsonObject(span)
    if (!parsed) continue
    if (isVerdictShaped(parsed)) {
      return normalizeVerdictKeyAndCoverage(parsed)
    }
    if (r3Candidate === null && hasNonSlotVerdictKey(parsed)) {
      r3Candidate = parsed
    }
  }
  if (r3Candidate) return normalizeVerdictKeyAndCoverage(r3Candidate)

  // R5: prose-only verdict line -> null (never synthesize). The gated prose
  // route lives in `recoverProseVerdictWithAttestation`, which requires the
  // expected fingerprint AND a pending file path in the same result; nothing in
  // this ladder may synthesize a verdict from prose alone.
  return null
}

/**
 * The set of keys a verdict literal may legally appear under, in priority
 * order. `verdict` is the canonical slot the recognizer reads; the rest are the
 * NON-slot aliases R3 normalizes into it. Inlined inside the consuming
 * functions (no module-scope const) so the spliced region stays self-contained.
 */
function verdictKeyPriority(): string[] {
  return ['verdict', 'reviewVerdict', 'finalVerdict', 'decision', 'status']
}

/**
 * True iff a string value among the recognized verdict keys trims+uppercases to
 * one of the three canonical literals. A verdict literal under a NON-slot key
 * is still verdict-shaped (R3 later normalizes the key); the recognizer's own
 * `visitForStructuredVerdict` only reads `verdict`, which is why recovery must
 * normalize the key before handing the object back.
 */
function isVerdictShaped(obj: Record<string, unknown>): boolean {
  for (const key of verdictKeyPriority()) {
    const value = obj[key]
    if (typeof value !== 'string') continue
    const upper = value.trim().toUpperCase()
    if (
      upper === 'LOOKS_GOOD' ||
      upper === 'NON_BLOCKING' ||
      upper === 'BLOCKING'
    ) {
      return true
    }
  }
  return false
}

/**
 * True iff a verdict literal sits under a NON-slot key (reviewVerdict /
 * finalVerdict / decision / status) and `verdict` is not already canonical —
 * i.e. the object R3 should normalize.
 */
function hasNonSlotVerdictKey(obj: Record<string, unknown>): boolean {
  if (typeof obj.verdict === 'string') return false
  for (const key of ['reviewVerdict', 'finalVerdict', 'decision', 'status']) {
    const value = obj[key]
    if (typeof value !== 'string') continue
    const upper = value.trim().toUpperCase()
    if (
      upper === 'LOOKS_GOOD' ||
      upper === 'NON_BLOCKING' ||
      upper === 'BLOCKING'
    ) {
      return true
    }
  }
  return false
}

/**
 * Normalize a recovered verdict object to the EXACT shape the recognizer reads:
 * the verdict literal moved to the canonical `verdict` key (uppercased/trimmed)
 * and a `schemaVersion: 1`. R4 coverage mapping is applied here, FAIL-CLOSED and
 * TOTAL: any `coverage` value outside the three literals is mapped to the
 * closest literal, and EVERYTHING unrecognized maps to `missing` — never to
 * `covered`, because `covered` must only ever mean "lexically full/complete/ok/
 * yes". Returns a NEW object (never mutates the parsed input).
 *
 * NO field is synthesized beyond `verdict` (+ `coverage` normalization and
 * `schemaVersion`): see the INV-A.2 rationale on
 * `recoverStructuredReviewerOutputs`. The caller (`visitForStructuredVerdict`)
 * still applies its own coverage/verdict parsing, so a `covered` here is only a
 * hint the recognizer re-validates.
 */
function normalizeVerdictKeyAndCoverage(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // Verdict: canonical `verdict` wins; otherwise the first NON-slot alias with
  // a canonical literal (the same priority order R3 uses).
  let verdictLiteral = ''
  if (typeof obj.verdict === 'string') {
    verdictLiteral = obj.verdict.trim().toUpperCase()
  } else {
    for (const key of ['reviewVerdict', 'finalVerdict', 'decision', 'status']) {
      const value = obj[key]
      if (typeof value !== 'string') continue
      const upper = value.trim().toUpperCase()
      if (
        upper === 'LOOKS_GOOD' ||
        upper === 'NON_BLOCKING' ||
        upper === 'BLOCKING'
      ) {
        verdictLiteral = upper
        break
      }
    }
  }
  out.verdict = verdictLiteral
  // R4 (fail-closed, total): map a coverage value to one of the three literals.
  // Only full/complete/ok/yes may become `covered`; n/a aliases become `n/a`;
  // EVERYTHING else (including absent) is `missing`.
  const rawCoverage = typeof obj.coverage === 'string' ? obj.coverage.trim().toLowerCase() : ''
  out.coverage = mapCoverageValue(rawCoverage)
  // Recovery's own marker so the recognizer shapes the entry. Deliberately the
  // ONLY added key: no findings/advisories/fingerprint/reviewedFiles (INV-A.2).
  out.schemaVersion = 1
  return out
}

/**
 * R4 total, fail-closed coverage mapping. Returns one of `covered` / `missing` /
 * `n/a`. `full|complete|ok|yes` -> `covered`; `n/a|na|not-applicable` -> `n/a`;
 * EVERYTHING else -> `missing`. Never maps anything to `covered` unless it
 * lexically means full/complete/ok/yes. Inlined literals (no module-scope
 * const) so the spliced copy is self-contained.
 */
function mapCoverageValue(value: string): 'covered' | 'missing' | 'n/a' {
  if (value === 'covered') return 'covered'
  if (value === 'missing') return 'missing'
  if (value === 'n/a') return 'n/a'
  if (value === 'full' || value === 'complete' || value === 'ok' || value === 'yes') {
    return 'covered'
  }
  if (value === 'na' || value === 'not-applicable' || value === 'not applicable') {
    return 'n/a'
  }
  return 'missing'
}

/**
 * A brace matcher that respects JSON string/escape state. Returns the inner
 * text of every top-level balanced `{...}` span in `text`, in source order.
 * Unbalanced trailing spans are dropped (fail closed — a partial object is not
 * parseable and must not be recovered from). Hoisted top-level `function`; no
 * module-scope state, so the spliced copy is self-contained.
 */
function balancedObjectSpans(text: string): string[] {
  const spans: string[] = []
  if (typeof text !== 'string') return spans
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return spans
}

/**
 * Parse `text` as a JSON object (an object literal only), returning the record
 * or null. Arrays, primitives, and malformed JSON all return null so recovery
 * stays fail-closed. Hoisted top-level `function`; no module-scope state.
 */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Wave 3 (A7) RETRY FEEDBACK.
 *
 * The machine-readable reason a reviewer verdict was rejected. `code` is a
 * closed union so a caller can branch on it; `summary` is a human-readable
 * one-liner; `observed` holds the EXACT rejected literals (truncated);
 * `expected` holds the accepted set; `recoveryStep` echoes the caller's step
 * label; `attempt` is the 1-based retry attempt number.
 */
export type ReviewerVerdictRejectionDiagnostic = {
  code:
    | 'no_structured_output'
    | 'unshaped_only'
    | 'unrecognized_verdict_literal'
    | 'invalid_coverage_value'
    | 'invalid_schema_version'
    | 'verdict_key_not_found'
    | 'prose_only'
    | 'attestation_incomplete'
    | 'recovered'
  summary: string
  observed: string[]
  expected: string[]
  recoveryStep: string
  attempt: number
}

/**
 * Wave 3 (A7) diagnostic for a rejected reviewer verdict. Computes the
 * diagnostic from the SAME (possibly recovered) result the recognizer read, so
 * the operator message describes the exact rejection the gate saw. Hoisted
 * top-level `function`; every literal set is inlined (no module-scope const) so
 * the spliced copy is self-contained.
 *
 * Classification:
 *   - no structured entry at all -> `no_structured_output`;
 *   - structured entries but none shaped -> `unshaped_only`;
 *   - a prose-only verdict line (LOOKS_GOOD / NON_BLOCKING / BLOCKING on its
 *     own line) with no structured entry -> `prose_only`;
 *   - a shaped entry whose verdict / schemaVersion / coverage is invalid -> the
 *     matching code.
 *
 * `observed` holds the exact rejected literals (truncated); `expected` holds
 * the accepted sets.
 */
export function diagnoseReviewerVerdictRejection(
  toolResult: unknown,
  recoveryStep: string,
): ReviewerVerdictRejectionDiagnostic {
  const acceptedVerdicts = ['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING']
  const acceptedCoverage = ['covered', 'missing', 'n/a']
  const structured = collectStructuredReviewerOutputs(toolResult)
  const shaped = structured.filter((entry) => entry.schemaVersion !== undefined)
  const base = {
    recoveryStep,
    attempt: 1,
  }

  if (structured.length === 0) {
    // No structured entry at all. Distinguish a prose-only verdict line, which
    // is a recognizable-but-unshapeable label, from a totally unstructured
    // reply. `collectStrings` + `hasReviewerLineVerdict` mirror the existing
    // text-mode path exactly.
    const texts: string[] = []
    collectStrings(toolResult, texts)
    const hasProseVerdict = texts
      .map((text) => stripReviewerPreamble(text))
      .some(
        (text) =>
          hasReviewerLineVerdict(text, 'LOOKS_GOOD') ||
          hasReviewerLineVerdict(text, 'NON_BLOCKING') ||
          hasReviewerLineVerdict(text, 'BLOCKING'),
      )
    if (hasProseVerdict) {
      return {
        ...base,
        code: 'prose_only',
        summary:
          'Reviewer emitted a verdict line as prose with no structured object; the gate cannot shape a verdict from prose.',
        observed: truncateObserved(collectProseVerdictLines(texts)),
        expected: acceptedVerdicts,
      }
    }
    return {
      ...base,
      code: 'no_structured_output',
      summary:
        'Reviewer returned no structured output; the gate cannot shape a verdict.',
      observed: [],
      expected: acceptedVerdicts,
    }
  }

  if (shaped.length === 0) {
    // Structured entries exist but none carry a schemaVersion, so the gate
    // treats the whole result as unshaped.
    return {
      ...base,
      code: 'unshaped_only',
      summary:
        'Reviewer returned structured output but no entry was schema-shaped; the gate cannot credit a verdict.',
      observed: truncateObserved(
        structured.map((entry) => entry.verdict).filter(Boolean),
      ),
      expected: acceptedVerdicts,
    }
  }

  // Shaped entries exist. Surface the FIRST concrete invalidity so the operator
  // knows exactly what to fix.
  for (const entry of shaped) {
    if (entry.schemaVersion !== 1) {
      return {
        ...base,
        code: 'invalid_schema_version',
        summary: `Reviewer reported an invalid schemaVersion (${String(entry.schemaVersion)}); only 1 is accepted.`,
        observed: truncateObserved([String(entry.schemaVersion)]),
        expected: ['1'],
      }
    }
  }
  // A verdict literal under a NON-slot key was normalized to `verdict` by the
  // recovery pre-pass; the recognizer only reads `verdict`, so a shaped entry
  // with an empty verdict means the key was not found. Report it explicitly.
  const verdictless = shaped.find((entry) => !entry.verdict)
  if (verdictless) {
    return {
      ...base,
      code: 'verdict_key_not_found',
      summary:
        'Reviewer structured output carried no recognized verdict key; the gate cannot read a verdict.',
      observed: [],
      expected: acceptedVerdicts,
    }
  }
  const coverageInvalid = shaped.find(
    (entry) => entry.coverage === undefined,
  )
  if (coverageInvalid) {
    return {
      ...base,
      code: 'invalid_coverage_value',
      summary:
        'Reviewer coverage value was outside the accepted set (covered | missing | n/a).',
      observed: [],
      expected: acceptedCoverage,
    }
  }
  // A shaped entry that reached here is creditable; recovery already ran, so
  // report `recovered` to signal the pre-pass is what made it shapeable.
  return {
    ...base,
    code: 'recovered',
    summary:
      'Reviewer structured output was recovered into a creditable verdict by the recovery pre-pass.',
    observed: truncateObserved(shaped.map((entry) => entry.verdict).filter(Boolean)),
    expected: acceptedVerdicts,
  }
}

/**
 * Extract the raw prose verdict lines (LOOKS_GOOD / NON_BLOCKING / BLOCKING on
 * their own line) from a list of texts, for diagnostic `observed` output. The
 * literal is returned verbatim so the operator sees exactly what was rejected.
 */
function collectProseVerdictLines(texts: string[]): string[] {
  const lines: string[] = []
  for (const text of texts) {
    const cleaned = stripReviewerPreamble(text)
    for (const rawLine of cleaned.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (/^(?:LOOKS_GOOD|NON_BLOCKING|BLOCKING)\b/i.test(line)) {
        lines.push(line)
      }
    }
  }
  return lines
}

/** Bound a diagnostic's `observed` list: at most 5 literals, each <= 80 chars. */
function truncateObserved(values: string[]): string[] {
  return values.slice(0, 5).map((value) => {
    const text = String(value ?? '')
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  })
}

/**
 * Fix 3 — Wave 3 (A7) value-showing retry notice. Lists the rejected literal
 * verbatim and the accepted set, gives a concrete `Replace <observed> with one
 * of: <accepted>` correction for each observed literal, and instructs the
 * reviewer to call `set_output` with the required shape. It MUST NOT include
 * the expected `snapshotFingerprint` (that would leak a forgeable attestation
 * target), so it references 'the snapshot id given in your spawn contract'
 * instead. Hoisted top-level `function`; no module-scope state.
 */
export function buildReviewerVerdictRetryNotice(
  diag: ReviewerVerdictRejectionDiagnostic,
  reviewerAgentType: string,
): string {
  const lines: string[] = [
    `Your previous ${reviewerAgentType} response was rejected by the automated reviewer gate.`,
    `Reason (${diag.code}): ${diag.summary}`,
    `Recovery step: ${diag.recoveryStep} (attempt ${diag.attempt}).`,
  ]
  // Code-specific instruction lines. Each names the exact recovery action so a
  // weaker model has a single unambiguous next step instead of a generic shape
  // line it can misread as "prose is fine".
  if (diag.code === 'no_structured_output') {
    lines.push(
      '',
      'You returned NO structured object at all. You MUST call the `set_output` tool exactly once with the native JSON object described below; prose-only replies are not accepted.',
    )
  } else if (diag.code === 'prose_only') {
    lines.push(
      '',
      'A prose verdict line is not accepted. You must re-emit the review by calling the `set_output` tool with the native JSON object described below.',
    )
  }
  if (diag.observed.length > 0) {
    lines.push('', 'Rejected value(s):')
    for (const observed of diag.observed) {
      lines.push(`  - ${observed}`)
    }
    // Concrete correction per observed literal: the code that carries observed
    // literals is only useful if the model is told exactly what to replace them
    // with. Observed literals keep the truncation `truncateObserved` applied.
    if (diag.expected.length > 0) {
      lines.push('', 'Corrections:')
      const acceptedList = diag.expected.join(' | ')
      for (const observed of diag.observed) {
        lines.push(`  - Replace ${observed} with one of: ${acceptedList}`)
      }
    }
  }
  if (diag.expected.length > 0) {
    lines.push('', 'Accepted value(s):')
    for (const expected of diag.expected) {
      lines.push(`  - ${expected}`)
    }
  }
  lines.push(
    '',
    'Re-emit your review by calling `set_output` with the required structured object shape:',
    "  { verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING', findings: [...], coverage: 'covered' | 'missing' | 'n/a', dimensions: {...}, requirementCoverage: [...], snapshotFingerprint: <the snapshot id given in your spawn contract>, reviewedFiles: [...] }",
    'Echo the snapshot id given in your spawn contract exactly (do not invent or re-hash one), list every reviewed file, and use only the accepted verdict/coverage literals above. Do not answer in prose.',
  )
  return lines.join('\n')
}

/**
 * Fix 4 — LIGHTWEIGHT REVIEWER RECEIPT TIER.
 *
 * Small, additive diffs over a handful of files do not need the full review
 * contract, so this tier lets a caller opt into a reduced receipt shape that a
 * much weaker (non-SOTA) model can reliably satisfy. Calling it is OPT-IN from
 * the caller: nothing here changes the default contract, and no gate path
 * reads it automatically.
 *
 * DETERMINISTIC ELIGIBILITY (never model-decided): every input is a runtime
 * fact — the pending file list and an optional count cap. A model claim or
 * self-assessment NEVER participates, so a reviewer cannot talk its way into
 * LESS scrutiny. The model's only influence is ESCALATION via
 * `shouldEscalateToFullContract`, which can only ever add scrutiny back.
 *
 * CONTRACT-BEARING EXCLUSION: a path that defines a manifest, a lockfile, a
 * schema, a shared type surface, a named contract directory, or contract docs
 * can break consumers far outside this changeset. Such a change always needs
 * the FULL review contract — dimensions, requirementCoverage, and findings are
 * exactly what catches a consumer break — no matter how few files it touches,
 * so it is excluded here. The predicate deliberately errs toward MORE
 * exclusion: a false negative would silently downgrade a genuine contract
 * change to the reduced tier.
 *
 * An empty pending set is also ineligible: there is nothing to review, so no
 * reduced contract is ever needed.
 *
 * Pure predicate, no I/O, no module-scope const, so the spliced copy stays
 * self-contained.
 */
export function isLightweightReceiptEligible(
  pendingFiles: string[],
  opts?: { maxFiles?: number },
): boolean {
  const maxFiles = opts?.maxFiles ?? 5
  if (!Array.isArray(pendingFiles)) return false
  if (pendingFiles.length === 0) return false
  if (pendingFiles.length > maxFiles) return false
  for (const file of pendingFiles) {
    if (typeof file !== 'string' || file.length === 0) return false
    const lower = file.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    // Manifests, config, and lockfiles: a dependency/version move changes the
    // installed graph for every consumer.
    if (lower.endsWith('.json')) return false
    if (lower.endsWith('.lock')) return false
    if (lower.endsWith('.toml')) return false
    if (base === 'package.json' || base === 'tsconfig.json') return false
    if (base === 'bunfig.toml') return false
    // Schema surfaces: the wire/shape contract other code is validated against.
    if (lower.includes('/schema')) return false
    if (lower.endsWith('-schema.ts') || lower.endsWith('schema.ts')) {
      return false
    }
    // Explicit contract directories.
    if (lower.includes('/contracts/')) return false
    // Shared type surface: exported types are consumed outside this changeset.
    if (lower.endsWith('types.ts') || lower.includes('/types/')) return false
    // Contract docs under docs/.
    if (
      lower.endsWith('.md') &&
      (lower.startsWith('docs/') || lower.includes('/docs/'))
    ) {
      return false
    }
  }
  return true
}

/**
 * Fix 4 — the four-to-five field receipt shape a reduced contract would
 * require: the verdict, the snapshot attestation, the reviewed file list, and
 * the coverage verdict. `findings`, `dimensions`, and `requirementCoverage`
 * are intentionally absent because the gate reads each of them as optional
 * (`?? []` / `?? {}`), so a small additive diff can be satisfied without them.
 * Paired with `isLightweightReceiptEligible`; calling either is opt-in from the
 * caller. Hoisted top-level `function`; no module-scope state.
 */
export function buildLightweightReceiptShape(): { required: string[] } {
  return {
    required: [
      'schemaVersion',
      'verdict',
      'snapshotFingerprint',
      'reviewedFiles',
      'coverage',
    ],
  }
}

/**
 * Fix 4 — the COMPLETE reduced review contract handed to a caller that opted
 * into the lightweight tier.
 *
 * SINGLE COMPOSITION POINT: the reduced `required` list is read from
 * `buildLightweightReceiptShape()` instead of being re-listed here, so a future
 * caller cannot hand-roll a divergent five-field shape. When
 * `isLightweightReceiptEligible` says no, the FULL contract is returned with an
 * empty `instruction`, which keeps the caller's default behaviour untouched.
 *
 * The `instruction` text is the ESCALATION CHANNEL: the reduced shape lets the
 * reviewer omit the evidence fields, but ANY substantive observation must still
 * arrive as `verdict: 'BLOCKING'` with a `findings` entry, and
 * `shouldEscalateToFullContract` then forces a re-review under the full
 * contract. The model can therefore only ever INCREASE scrutiny, never reduce
 * it.
 *
 * Hoisted top-level `function`; no module-scope state and no imports, so the
 * spliced copy is self-contained.
 */
export function buildLightweightReviewContract(pendingFiles: string[]): {
  lightweight: boolean
  required: string[]
  instruction: string
} {
  if (!isLightweightReceiptEligible(pendingFiles)) {
    return {
      lightweight: false,
      required: [
        'schemaVersion',
        'verdict',
        'snapshotFingerprint',
        'reviewedFiles',
        'coverage',
        'dimensions',
        'family',
      ],
      instruction: '',
    }
  }
  return {
    lightweight: true,
    required: buildLightweightReceiptShape().required,
    instruction:
      'This is a small additive change, so you may omit findings, dimensions, and requirementCoverage. You MUST still echo the snapshot fingerprint exactly as given in your spawn contract and list every pending file in reviewedFiles. If you observe anything substantive, raise it as verdict: BLOCKING with a findings entry instead of omitting it.',
  }
}

/**
 * ESCALATION-ONLY guard for the lightweight tier.
 *
 * A lightweight review that surfaced ANYTHING must be re-reviewed under the
 * full contract, so the model can only ever increase scrutiny: a clean
 * `LOOKS_GOOD` with zero findings stays lightweight, while any other verdict —
 * or any finding, even one reported beside `LOOKS_GOOD` — sends the review back
 * through the full contract. An absent (`undefined`) verdict with findings also
 * escalates, and an absent verdict with zero findings is treated fail-closed
 * (it is not the clean LOOKS_GOOD case), so an unreadable receipt never keeps
 * the reduced tier.
 *
 * `lightweightUsed: false` always returns false: a full-contract review needs
 * no escalation. Hoisted top-level `function`; no module-scope state.
 */
export function shouldEscalateToFullContract(params: {
  lightweightUsed: boolean
  verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING' | undefined
  findingCount: number
}): boolean {
  if (!params.lightweightUsed) return false
  if (params.verdict !== 'LOOKS_GOOD') return true
  return params.findingCount > 0
}

/**
 * Wave 3 (A8) WINDOWED REVIEW PLANNING.
 *
 * Partition the CREDITABLE, uncredited files into deterministic waves capped at
 * 40 files (the `MAX_COMMITTED_SURFACE_FILES` literal, kept in-body — NO
 * module-scope const). A file is 'uncredited' when `priorWaveCredit[file]`
 * differs from `markerFor(file)`: a file whose content marker still matches its
 * prior-wave credit needs no re-review. The caller supplies `isReviewable` (do
 * NOT import `selectReviewableGateFiles`; the caller owns that predicate).
 * Deleted files are returned separately (attested-by-absence) and excluded from
 * the waves.
 *
 * CREDIT-UNIVERSE INVARIANT (universe-mismatch fix): `pendingFiles` here is the
 * set of files that a specialist pass CAN actually credit — the UNION of every
 * routed specialist's scoped spawn file set — NOT the full reviewable pending
 * set. Planning over the wider pending set was the defect: a planned wave could
 * contain a reviewable file that no specialist is ever spawned against (e.g. a
 * `__tests__/` file or any file excluded from the aux-relevant scoped subset),
 * so `recordWaveCompletionsForFiles` could never fully credit that wave and the
 * finalization check reported it missing forever. Planning and crediting now
 * describe the SAME universe, so every planned wave is creditable by at least
 * one spawned specialist. The caller (base2.ts) passes the union; this helper
 * stays a pure partitioner and does not recompute it.
 *
 * Hoisted top-level `function`; the 40 cap and every literal are in-body so the
 * spliced copy is self-contained.
 */
export function planGateReviewWaves(
  pendingFiles: string[],
  deletedFiles: string[],
  priorWaveCredit: Record<string, string>,
  isReviewable: (file: string) => boolean,
  markerFor: (file: string) => string,
): { waves: string[][]; deleted: string[]; uncredited: string[] } {
  const waveCap = 40
  // NORMALIZATION INVARIANT: every path that leaves this planner (the wave
  // lists, the deleted list, and the uncredited list) is in the SAME normalized
  // form `recordWaveCompletionsForFiles` and the finalization live-marker check
  // compare against. `pendingFiles` arrives as the union of the routed
  // specialists' scoped spawn file sets, which are collected from raw
  // reviewer/change sources and may carry a leading `./` or backslashes; a
  // path that differs only by normalization could never match the credited set
  // and the post-spawn finalization re-opened the wave as missing. Normalizing
  // here keeps planning, crediting, and the completion check on one universe.
  const deleted: string[] = []
  const deletedSeen = new Set<string>()
  for (const rawFile of deletedFiles) {
    const file = normalizeGateFilePath(rawFile)
    if (!file) continue
    if (deletedSeen.has(file)) continue
    deletedSeen.add(file)
    deleted.push(file)
  }
  const uncredited: string[] = []
  const seen = new Set<string>()
  for (const rawFile of pendingFiles) {
    const file = normalizeGateFilePath(rawFile)
    if (!file) continue
    if (seen.has(file)) continue
    seen.add(file)
    if (!isReviewable(file)) continue
    if (deletedSeen.has(file)) continue
    const marker = markerFor(file)
    // Uncredited when there is no prior credit for this file, or the recorded
    // credit differs from the live marker (fail closed: a changed or missing
    // credit re-reviews).
    if (priorWaveCredit[file] === marker && marker !== undefined) continue
    uncredited.push(file)
  }
  // Deterministic: sort the uncredited creditable files, then chunk by 40.
  const sorted = [...uncredited].sort()
  const waves: string[][] = []
  for (let i = 0; i < sorted.length; i += waveCap) {
    waves.push(sorted.slice(i, i + waveCap))
  }
  return { waves, deleted, uncredited: sorted }
}

/**
 * Wave 3 (A8) deterministic wave identity.
 *
 * Returns `${fingerprint}#w${waveIndex}#${sha256(sorted(waveFiles).join('\n'))}`.
 * The hash is taken through the ALREADY-AVAILABLE in-region primitive
 * `hashGateSnapshotDetails` (spliced from `gate-fingerprint.ts`, which the
 * generator emits AFTER `gate-reviewer.ts` into the SAME `handleSteps` scope).
 * Choosing the in-region primitive over a `hash: (s) => string` parameter keeps
 * `waveKey` IMPORT-FREE — a spliced function cannot `import` a hash lib — and
 * keeps the caller's signature simple. `hashGateSnapshotDetails` is a hoisted
 * top-level `function` in the generated region, so calling it here resolves in
 * both the module (where it is an imported binding) and the spliced copy. The
 * helper returns `v3:<64 hex>` for a stable string; sorting the wave files makes
 * the key independent of the order the caller collected them in.
 */
export function waveKey(
  fingerprint: string,
  waveIndex: number,
  waveFiles: string[],
): string {
  const sorted = [...waveFiles].sort()
  return `${fingerprint}#w${waveIndex}#${hashGateSnapshotDetails(sorted.join('\n'))}`
}
