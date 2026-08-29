import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { createReviewer } from '../reviewer/code-reviewer'

import type { JsonSchema } from '../types/util-types'

/**
 * Typed schema accessors, matching the walker in review-rubric-parity.test.ts:
 * resolving the reviewer schema through `JsonSchema` instead of `any` casts
 * makes a renamed or retyped field a lookup miss (or a type error) rather than
 * a silently-undefined property read.
 */
function asSchema(value: unknown): JsonSchema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined
}

function propertySchema(
  schema: JsonSchema | undefined,
  key: string,
): JsonSchema | undefined {
  return asSchema(schema?.properties?.[key])
}

function anyOfVariants(schema: JsonSchema | undefined): JsonSchema[] {
  const variants = schema?.anyOf
  return Array.isArray(variants)
    ? variants.flatMap((variant) => {
        const resolved = asSchema(variant)
        return resolved ? [resolved] : []
      })
    : []
}

describe('code-reviewer prompt isolation', () => {
  test('uses structured output when an output schema is declared', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')
    expect(reviewer.outputMode).toBe('structured_output')
    expect(reviewer.outputSchema).toBeDefined()
  })

  test('does not inherit parent orchestration instructions', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.inheritParentSystemPrompt).toBe(false)
    // Reviewers may read files (only) so they can always gather full final-file
    // context instead of reviewing from partial diff fragments. No mutating or
    // control tools are granted.
    expect(reviewer.toolNames).toEqual(['read_files', 'set_output'])
    expect(reviewer.spawnableAgents).toEqual([])
    expect(reviewer.handleSteps).toBeUndefined()
  })

  test('instructs reviewer to read exact final files instead of diff fragments', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'Always gather complete context',
    )
    expect(reviewer.instructionsPrompt).toContain('diff fragments')
    // Reviewers page large files via read_files windows (bounded cap.v3
    // block windows); read_blocks was removed in the read-tool unification.
    expect(reviewer.instructionsPrompt).toContain('read_files windows')
  })

  test('includes anti-loop attestation and single-pass instructions', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'read every file in the pending list',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'reviewedFiles must list every pending file',
    )
    // Assert on backtick-free substrings around the escaped `uncertain`.
    expect(reviewer.instructionsPrompt).toContain('Never return')
    expect(reviewer.instructionsPrompt).toContain(
      'for a requirement you have not verified',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'Report every blocker and coverage gap in a single pass',
    )
  })

  // T1.2(b): the finding generator must be a bounded, terminating enumeration.
  test('bounds the finding generator with a finite completeness criterion', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'that REQUIRES A CHANGE, in a single pass, and then stop',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'finite completeness criterion',
    )
    // An empty finding set must be reachable and legitimate.
    expect(reviewer.instructionsPrompt).toContain('Satisfiable empty set')
    expect(reviewer.instructionsPrompt).toContain(
      '"nothing requires a change" is a legitimate, reachable outcome',
    )
    // Findings must be over properties a repair can clear.
    expect(reviewer.instructionsPrompt).toContain('Monotonicity under repair')
    expect(reviewer.instructionsPrompt).toContain(
      'taste-based or preference-based observations are not monotone',
    )
    // Finding count tracks violations, not how much code is in view.
    expect(reviewer.instructionsPrompt).toContain('Low churn sensitivity')
    expect(reviewer.instructionsPrompt).toContain(
      're-reading the same unchanged code must not manufacture new findings',
    )
    // The unbounded instruction must not come back.
    expect(reviewer.instructionsPrompt).not.toContain('find ways to improve')
  })

  // T1.3: findings accept OPTIONAL id/severity/dimension metadata objects.
  test('accepts optional finding metadata objects alongside plain strings', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')
    const schema: JsonSchema | undefined = reviewer.outputSchema
    const findings = propertySchema(schema, 'findings')

    expect(findings?.type).toBe('array')
    const variants = anyOfVariants(asSchema(findings?.items))
    expect(variants).toHaveLength(2)
    // The plain-string form must stay valid: existing reviewers emit strings
    // and must not be invalidated by the metadata addition.
    expect(variants[0]).toEqual({ type: 'string' })

    const objectForm = variants[1]
    expect(objectForm?.type).toBe('object')
    expect(Object.keys(objectForm?.properties ?? {}).sort()).toEqual([
      'correction',
      'dimension',
      'evidence',
      'id',
      'severity',
      'text',
    ])
    // RF-5: base2's recordSuccessfulReviewReceipt compacts finding.evidence and
    // finding.correction into the durable receipt, so the schema must let a
    // conforming reviewer actually supply them.
    expect(propertySchema(objectForm, 'evidence')).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
    expect(propertySchema(objectForm, 'correction')).toEqual({ type: 'string' })
    // Only `text` is required — the rest is optional metadata, so requiring any
    // of it here would reject a conforming reviewer.
    expect(objectForm?.required).toEqual(['text'])
    expect(propertySchema(objectForm, 'severity')?.enum).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ])
    // The dimension enum is derived-by-assertion from this schema's own
    // dimensions object, so adding a review dimension without extending the
    // finding label fails here instead of silently diverging.
    expect(propertySchema(objectForm, 'dimension')?.enum).toEqual(
      propertySchema(schema, 'dimensions')?.required,
    )
  })

  test('documents id-stable finding correlation across repair rounds', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'the gate correlates findings across repair rounds by',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'Keep the id stable across rounds for the same underlying violation',
    )
    // Severity/dimension are telemetry-only today; the prompt must not imply
    // the gate thresholds on them (that is evidence-gated Tier 2 work).
    expect(reviewer.instructionsPrompt).toContain(
      'the gate records as telemetry and does not currently act on',
    )
    // RF-5: evidence/correction are schema-declared, so the prompt must tell
    // the reviewer they exist and that the gate stores them.
    expect(reviewer.instructionsPrompt).toContain(
      'the gate compacts both into its durable review receipt',
    )
    // RF-2: gate-reviewer's `findingRecords` drops object findings without an
    // `id`, and base2 builds receipt.findings only from those records, so the
    // prompt must not promise persistence for an id-less finding.
    expect(reviewer.instructionsPrompt).toContain(
      'only for findings that carry a stable `id`',
    )
    expect(reviewer.instructionsPrompt).toContain(
      "an id-less finding's evidence and correction are dropped",
    )
  })

  test('requires set_output instead of an ambiguous textual verdict', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'You must call `set_output` with one object that satisfies the declared output schema',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'the parent will receive `null`',
    )
    expect(reviewer.instructionsPrompt).not.toContain(
      'The first visible token of your final answer',
    )
  })

  test('forbids stringified or oversized reviewer receipts', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain('Never call `JSON.stringify`')
    expect(reviewer.instructionsPrompt).toContain('at most 12 findings')
    expect(reviewer.instructionsPrompt).toContain(
      'at most 2 concise evidence strings per requirement',
    )
  })

  // RF-1: the gate turns a `dimensions.*` value into a hard blocker only when
  // its first word matches /^block(s|ing|er|ers)?\b/ (gate-reviewer's
  // `collectReviewerBlockers` / `getReviewerFinalizationVerdict`), so the
  // prompt must name that prefix instead of only showing the passing form.
  test('names the block prefix a failing dimension must use', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'A FAILING dimension must start with `block`, `blocks`, `blocking`, or `blocker(s)`',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'the gate only turns a dimension into a hard blocker when its first word matches that prefix',
    )
    // The two spellings that are silently non-blocking must be named.
    expect(reviewer.instructionsPrompt).toContain(
      '`fail: ...` or `blocked: ...` is silently non-blocking',
    )
    // The passing example must survive alongside the failing one.
    expect(reviewer.instructionsPrompt).toContain(
      '"pass: guards close cleanly"',
    )
  })

  test('treats missing parallel validation output as unavailable', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'Validation and other subagent work may be running in parallel',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'You cannot observe results from parallel agents unless the prompt explicitly includes those completed results',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'treat your review as static code review only',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'do not say validation passed or failed',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'Do not infer test, typecheck, lint, build, or basher status from silence',
    )
  })

  // M2.4: 3-item security checklist + coverage-adequacy line.
  test('includes a 3-item security checklist', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain('Security checklist')
    expect(reviewer.instructionsPrompt).toContain('Input boundary')
    expect(reviewer.instructionsPrompt).toContain('Secret handling')
    expect(reviewer.instructionsPrompt).toContain('Failure mode')
    // All three numbered items present.
    expect(reviewer.instructionsPrompt).toMatch(/1\. Input boundary/)
    expect(reviewer.instructionsPrompt).toMatch(/2\. Secret handling/)
    expect(reviewer.instructionsPrompt).toMatch(/3\. Failure mode/)
  })

  test('includes a coverage-adequacy guideline', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain('Coverage adequacy')
    // Must name a specific test file rather than a vague suggestion.
    expect(reviewer.instructionsPrompt).toContain('name the specific test file')
    // Must not assert pass/fail — only coverage existence.
    expect(reviewer.instructionsPrompt).toContain(
      'Do not assert that tests pass or fail',
    )
  })

  // M6.3: coverage-adequacy promoted to the verdict contract (BLOCKING-eligible).
  test('promotes coverage-adequacy into the verdict contract', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'Missing test coverage for a behavior-changing edit requires',
    )
    expect(reviewer.instructionsPrompt).toContain(
      '`verdict: "BLOCKING"` and `coverage: "missing"`',
    )
    // Coverage adequacy guideline is explicitly marked as verdict-contract.
    expect(reviewer.instructionsPrompt).toContain('verdict-contract, M6.3')
    expect(reviewer.instructionsPrompt).toContain('coverage: "missing"')
  })

  test('forces BLOCKING when any in-scope requirementCoverage status is missing or uncertain', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    // Parent-owned process tasks are out of scope; only in-scope gaps force BLOCKING.
    expect(reviewer.instructionsPrompt).toContain('Parent-owned process tasks')
    expect(reviewer.instructionsPrompt).toContain(
      'if ANY in-scope `requirementCoverage[].status` is `missing` or `uncertain`',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'the top-level `verdict` MUST be `"BLOCKING"`',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'put each incomplete in-scope requirement into `findings` as a concrete next action',
    )
  })

  test('documents LOOKS_GOOD-only finalization and NON_BLOCKING re-review loop', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    expect(reviewer.instructionsPrompt).toContain(
      'the parent gate finalizes only on `LOOKS_GOOD`',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'Use `NON_BLOCKING` when findings exist that require a change but do not block',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'repair/re-review loop until a later review returns `LOOKS_GOOD`',
    )
  })

  // Advisory channel: cosmetic observations are recorded and displayed instead
  // of blocking, so they never re-enter the repair loop as findings.
  test('declares an optional advisories channel alongside findings', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')
    const schema: JsonSchema | undefined = reviewer.outputSchema

    expect(propertySchema(schema, 'advisories')).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
    // Vacuity guard: `required` must be the real non-empty list, and
    // `advisories` must stay out of it so existing receipts stay conforming.
    expect(schema?.required).toContain('findings')
    expect(schema?.required).not.toContain('advisories')
  })

  // Reviewer-family symmetry (RF-6): only code-reviewer declares `advisories`,
  // and that asymmetry is intentional rather than a pending migration. The
  // rationale is pinned here so a later reviewer-family audit does not read the
  // single declaration as an incomplete rollout.
  test('documents advisories as additive and family-optional', () => {
    const source = readFileSync(
      new URL('../reviewer/code-reviewer.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('Reviewer-family symmetry')
    expect(source).toContain('ADDITIVE and stays out of')
    expect(source).toContain(
      'collectReviewerAdvisories` reads a missing/unusable',
    )
  })

  test('routes cosmetic observations to advisories instead of blocking on them', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')

    // The contradiction being removed: LOOKS_GOOD is no longer conditioned on
    // having zero observations of any kind.
    expect(reviewer.instructionsPrompt).not.toContain(
      'Do not emit `LOOKS_GOOD` while any findings remain',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'Use `LOOKS_GOOD` when nothing REQUIRES A CHANGE, even if you still have cosmetic observations',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'put those in `advisories` and leave `findings` empty',
    )
    // The empty-findings invariant for LOOKS_GOOD must survive the rewrite.
    expect(reviewer.instructionsPrompt).toContain(
      'a `LOOKS_GOOD` verdict must still carry an EMPTY `findings` array',
    )
    // Advisories are not discarded, and the class of observation is named.
    expect(reviewer.instructionsPrompt).toContain(
      'recorded in the durable review receipt and shown to the user, so nothing is lost',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'comment density, naming taste, optional refactors, speculative future-proofing',
    )
    expect(reviewer.instructionsPrompt).toContain('at most 8 advisories')
  })
})
