import { describe, expect, test } from 'bun:test'

import { createReviewer } from '../reviewer/code-reviewer'

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
    expect(reviewer.instructionsPrompt).toContain(
      'Parent-owned process tasks',
    )
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
      'Use `NON_BLOCKING` when nits exist',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'repair/re-review loop until a later review returns `LOOKS_GOOD`',
    )
  })
})
