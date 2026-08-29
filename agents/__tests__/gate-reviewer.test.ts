import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  classifyReviewerCrash,
  collectParentOwnedRequirementBlockers,
  collectReviewerAdvisories,
  collectReviewerBlockers,
  collectReviewerAttestationIssues,
  collectReviewerFindingRecords,
  collectReviewerFingerprintDrift,
  collectReviewerHardBlockers,
  detectReviewerCrash,
  getReviewerFinalizationVerdict,
  isParentOwnedOrOutOfScopeRequirement,
  isTestCoverageReviewerFinding,
  isTransientReviewerCrash,
  stripReviewerPreamble,
} from '../base2/gate-reviewer'

type ReviewerFinalizationVerdict = 'LOOKS_GOOD' | ''

type GateReviewerHelpers = {
  stripReviewerPreamble: (text: string) => string
  collectReviewerBlockers: (toolResult: unknown) => string[]
  // base2 keeps its own copy; the condone filter consults THAT one at runtime.
  collectReviewerHardBlockers: (toolResult: unknown) => string[]
  // base2's OWN copy is the gate's fail-closed attestation authority (every
  // review call site runs it), so the mirror needs the same parity coverage as
  // the hard-blocker one: an over-tolerant mirror would credit a review that
  // never attested to the pending files.
  collectReviewerAttestationIssues: (
    toolResult: unknown,
    expectedFingerprint: string,
    pendingFiles: string[],
    deletedFiles?: string[],
  ) => string[]
  // The gate correlates structured findings with THIS copy, so the
  // first-record-per-id de-dupe needs parity coverage too.
  collectReviewerFindingRecords: (toolResult: unknown) => Array<{
    id: string
    text: string
    severity?: string
    dimension?: string
    evidence: string[]
    correction?: string
  }>
  // The gate's durable review receipt is built from THIS collector (base2's
  // generated copy), so the persisted advisory semantics need parity coverage.
  collectReviewerAdvisories: (toolResult: unknown) => string[]
  collectReviewerFingerprintDrift: (
    toolResult: unknown,
    expectedFingerprint: string,
  ) => string
  // base2's gate call sites filter parent-owned requirement gaps with THIS
  // copy, so it needs the same parity coverage as the hard-blocker mirror.
  collectParentOwnedRequirementBlockers: (
    blockers: string[],
    toolResult?: unknown,
  ) => Set<string>
  getReviewerFinalizationVerdict: (
    toolResult: unknown,
  ) => ReviewerFinalizationVerdict
  detectReviewerCrash: (toolResult: unknown) => string | null
}

type GateReviewerFunctionName = keyof GateReviewerHelpers
type InlineHelperFactory = () => GateReviewerHelpers

const INLINE_HELPER_NAMES: GateReviewerFunctionName[] = [
  'stripReviewerPreamble',
  'collectReviewerBlockers',
  'collectReviewerHardBlockers',
  'collectReviewerAttestationIssues',
  'collectReviewerFindingRecords',
  'collectReviewerAdvisories',
  'collectReviewerFingerprintDrift',
  'collectParentOwnedRequirementBlockers',
  'getReviewerFinalizationVerdict',
  'detectReviewerCrash',
]

// Extraction constraint: every helper named here (and in INLINE_HELPER_NAMES)
// must have raw-text balanced braces, because extractInlineFunctionSource counts
// `{`/`}` without tokenizing — a brace inside a string, regex, or comment would
// mis-slice the helper. assertInlineFunctionSourceParses turns such a
// regression into a named error instead of a confusing parity mismatch.
// Why the count still lands correctly today: the only brace-bearing regexes in
// the mirrored set are QUANTIFIERS such as `[^.\n]{0,40}` in
// isParentOwnedOrOutOfScopeRequirement, and a quantifier's braces pair, so they
// cancel out. A regex or string literal carrying a LONE `{` or `}` is the hazard
// to watch for on future edits; assertInlineFunctionSourceParses only catches it
// when the resulting mis-slice happens not to parse.
const INLINE_DEPENDENCY_NAMES = [
  'dedupeExactStringsPreserveOrder',
  'collectStructuredReviewerOutputs',
  'visitForStructuredVerdict',
  'hasReviewerLineVerdict',
  'collectStrings',
  // Crash taxonomy helpers are generated into base2; parity for
  // detectReviewerCrash only needs findReviewerCrash. Unit tests cover
  // isTransientReviewerCrash / classifyReviewerCrash against the export.
  'findReviewerCrash',
  // collectReviewerFingerprintDrift routes the v3 shape check through the
  // shared predicate, which delegates to the gate-fingerprint helper; both are
  // generated into base2, so the reconstructed set needs them in scope.
  'isAttestableV3Fingerprint',
  'isAttestableSnapshotFingerprint',
  // collectParentOwnedRequirementBlockers (exposed from the factory above)
  // classifies each requirement row through this predicate.
  'isParentOwnedOrOutOfScopeRequirement',
  // collectReviewerAttestationIssues normalizes reviewed/pending/deleted paths
  // through the gate-path helper and resolves the receipt's attestation through
  // the shared order-independent resolver; both are generated into base2.
  'normalizeGateFilePath',
  'resolveReviewerAttestation',
] as const

/**
 * Fail fast when the raw-brace slice below cut a helper in the wrong place.
 *
 * The extracted declaration is parsed on its own (parse only, never called), so
 * a helper that gains an unbalanced brace inside a string, regex, or comment
 * reports the offending helper by name instead of surfacing as a confusing
 * parity mismatch or a SyntaxError blaming the whole concatenated factory.
 */
function assertInlineFunctionSourceParses(
  extracted: string,
  functionName: string,
): void {
  try {
    new Function(`"use strict";\n${extracted}`)
  } catch (error) {
    throw new Error(
      `Extracted inline ${functionName} source does not parse; extractInlineFunctionSource counts raw braces, so a brace inside a string/regex/comment mis-sliced it: ${String(error)}`,
    )
  }
}

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  const bodyStart = source.indexOf('{', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      const extracted = source.slice(declarationStart, index + 1)
      assertInlineFunctionSourceParses(extracted, functionName)
      return extracted
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

function loadInlineGateReviewerHelpers(): GateReviewerHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = [...INLINE_HELPER_NAMES, ...INLINE_DEPENDENCY_NAMES]
    .map((functionName) =>
      extractInlineFunctionSource(base2JavaScript, functionName),
    )
    .join('\n\n')
  const buildHelpers = new Function(
    // Derived from INLINE_HELPER_NAMES so adding a mirrored helper cannot
    // silently skip parity coverage by being missing from a hand-written list.
    `"use strict";\n${helperSource}\nreturn { ${INLINE_HELPER_NAMES.join(', ')} }`,
  ) as InlineHelperFactory

  return buildHelpers()
}

/**
 * Readable per-blocker reference for `collectParentOwnedRequirementBlockers`.
 *
 * RF-3 deleted the production `isParentOwnedRequirementBlocker` wrapper (it had
 * no live gate call site yet was still emitted into base2's serialized
 * `<gate-helpers-generated>` payload), so the reference implementation the batch
 * collector is compared against lives here and is expressed directly in terms
 * of `isParentOwnedOrOutOfScopeRequirement`.
 *
 * Precedence matches the collector and `getReviewerFinalizationVerdict`: with no
 * matching structured row the requirement text alone decides, and when several
 * rows share the `${status}\n${requirement}` key a single in-scope row keeps the
 * blocker open.
 */
function referenceParentOwnedBlocker(
  blocker: string,
  rows?: Array<{ requirement: string; status: string; evidence?: string[] }>,
): boolean {
  const match = blocker.match(
    /^BLOCKING:\s*requirement\s+(missing|uncertain):\s*([\s\S]+)$/i,
  )
  if (!match) return false
  const status = match[1]!.toLowerCase()
  const requirementText = match[2]!.trim()
  const matchingRows = (rows ?? []).filter(
    (row) =>
      row.status.toLowerCase() === status &&
      row.requirement.trim() === requirementText,
  )
  if (matchingRows.length === 0) {
    return isParentOwnedOrOutOfScopeRequirement(requirementText)
  }
  return matchingRows.every((row) =>
    isParentOwnedOrOutOfScopeRequirement(row.requirement, row.evidence),
  )
}

describe('gate-reviewer helpers', () => {
  test('stripReviewerPreamble removes closed leading think blocks only', () => {
    expect(
      stripReviewerPreamble(
        '  <think>first</think>\n<think data-x="1">second</think>\nLOOKS_GOOD: ok  ',
      ),
    ).toBe('LOOKS_GOOD: ok')
    expect(stripReviewerPreamble('BLOCKING: keep this')).toBe(
      'BLOCKING: keep this',
    )
    expect(stripReviewerPreamble('<think>unterminated\nLOOKS_GOOD')).toBe(
      '<think>unterminated\nLOOKS_GOOD',
    )
  })

  test('collectReviewerBlockers returns structured blocking findings first', () => {
    expect(
      collectReviewerBlockers([
        'BLOCKING: fallback text',
        {
          type: 'json',
          value: [
            { verdict: 'BLOCKING', findings: ['Fix A', '  Fix B  ', 42] },
            { verdict: 'LOOKS_GOOD' },
            { verdict: 'BLOCKING', findings: [] },
          ],
        },
      ]),
    ).toEqual([
      'BLOCKING: Fix A',
      'BLOCKING: Fix B',
      'BLOCKING: (no findings provided)',
    ])
  })

  test('preserves stable structured finding metadata', () => {
    const result = {
      verdict: 'BLOCKING',
      findings: [
        {
          id: 'dependency-reviewer:manifest_and_lockfile_correctness:stale-lock',
          severity: 'high',
          dimension: 'manifest_and_lockfile_correctness',
          summary: 'The lockfile does not match the manifest.',
          evidence: ['package.json adds x', 'bun.lock omits x'],
          correction: 'Regenerate the lockfile with the repository manager.',
        },
      ],
      coverage: 'n/a',
    }
    expect(collectReviewerBlockers(result)).toEqual([
      'BLOCKING: [dependency-reviewer:manifest_and_lockfile_correctness:stale-lock] The lockfile does not match the manifest.',
    ])
    expect(collectReviewerFindingRecords(result)).toEqual([
      {
        id: 'dependency-reviewer:manifest_and_lockfile_correctness:stale-lock',
        text: 'The lockfile does not match the manifest.',
        severity: 'high',
        dimension: 'manifest_and_lockfile_correctness',
        evidence: ['package.json adds x', 'bun.lock omits x'],
        correction: 'Regenerate the lockfile with the repository manager.',
      },
    ])
    // A nested spawn + set_output can surface the same receipt twice; records
    // are de-duped by id so correlateReviewerFindingRecord sees each once.
    expect(
      collectReviewerFindingRecords({
        type: 'json',
        value: [result, { type: 'json', value: result }],
      }),
    ).toEqual(collectReviewerFindingRecords(result))
  })

  // Advisory channel: recorded and displayed, never a repair target. The
  // zero-blocker / still-LOOKS_GOOD assertions are the guard against an
  // advisory reaching collectReviewerBlockers and re-entering the loop.
  test('collectReviewerAdvisories extracts and de-dupes advisories without blocking', () => {
    const looksGoodWithAdvisories = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      dimensions: { correctness: 'pass: guards close cleanly' },
      advisories: [
        'comment density is high in gate-reviewer.ts',
        '  optional refactor: extract the walker  ',
        'comment density is high in gate-reviewer.ts',
        '',
        42,
      ],
    }
    const advisories = collectReviewerAdvisories(looksGoodWithAdvisories)
    // Vacuity guard: the extraction must actually produce entries.
    expect(advisories).toEqual([
      'comment density is high in gate-reviewer.ts',
      'optional refactor: extract the walker',
    ])
    // A single bare string is accepted the same way `findings` accepts one.
    expect(
      collectReviewerAdvisories({
        ...looksGoodWithAdvisories,
        advisories: 'naming taste only',
      }),
    ).toEqual(['naming taste only'])
    // Absent / unusable advisories yield nothing rather than a placeholder.
    expect(
      collectReviewerAdvisories({
        ...looksGoodWithAdvisories,
        advisories: undefined,
      }),
    ).toEqual([])
    expect(
      collectReviewerAdvisories({
        ...looksGoodWithAdvisories,
        advisories: [42],
      }),
    ).toEqual([])
    expect(collectReviewerAdvisories(null)).toEqual([])
    // The LAST structured entry is the receipt the gate records.
    expect(
      collectReviewerAdvisories({
        type: 'json',
        value: [
          { ...looksGoodWithAdvisories, advisories: ['stale advisory'] },
          { ...looksGoodWithAdvisories, advisories: ['final advisory'] },
        ],
      }),
    ).toEqual(['final advisory'])
    // CRITICAL: an advisory must never become a blocker or cost finalization.
    expect(collectReviewerBlockers(looksGoodWithAdvisories)).toEqual([])
    expect(collectReviewerHardBlockers(looksGoodWithAdvisories)).toEqual([])
    expect(getReviewerFinalizationVerdict(looksGoodWithAdvisories)).toBe(
      'LOOKS_GOOD',
    )
  })

  // base2's recordSuccessfulReviewReceipt persists the receipt's `advisories`
  // through its OWN generated copy of this collector, so the mirror must agree
  // with the export over every advisory shape: a drifted mirror would persist
  // (and surface) different advisories than the tested contract.
  test('the inline base2 collectReviewerAdvisories mirror matches the export', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const receipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      advisories: ['dup advisory', '  spaced advisory  ', 'dup advisory'],
    }
    const inputs: unknown[] = [
      receipt,
      { ...receipt, advisories: 'single bare advisory' },
      { ...receipt, advisories: [] },
      { ...receipt, advisories: [42, ''] },
      { ...receipt, advisories: undefined },
      // The LAST structured entry wins, including through nested wrappers.
      {
        type: 'json',
        value: [
          { ...receipt, advisories: ['stale advisory'] },
          { type: 'json', value: { ...receipt, advisories: ['final'] } },
        ],
      },
      'BLOCKING: plain text',
      null,
    ]
    // Vacuity guard: the first input must actually produce advisories.
    expect(inlineHelpers.collectReviewerAdvisories(receipt)).toEqual([
      'dup advisory',
      'spaced advisory',
    ])
    for (const input of inputs) {
      expect(inlineHelpers.collectReviewerAdvisories(input)).toEqual(
        collectReviewerAdvisories(input),
      )
    }
  })

  // RF-2-0b9cbf03: advisory selection narrows to `schemaVersion`-SHAPED entries
  // the same way resolveReviewerAttestation does, so a reviewer that QUOTES the
  // documented example receipt AFTER its real one cannot have the example's
  // advisories persisted and displayed as this review's.
  test('collectReviewerAdvisories ignores a trailing quoted example receipt', () => {
    const realReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      advisories: ['real advisory'],
    }
    // Quote of the documented example receipt: it parses as a structured
    // verdict but carries no schemaVersion, so it is not a shaped entry.
    const quotedExample = {
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      advisories: ['example advisory'],
    }
    const withTrailingQuote = {
      type: 'json',
      value: [realReceipt, quotedExample],
    }
    const unshapedOnly = { type: 'json', value: [quotedExample] }
    expect(collectReviewerAdvisories(withTrailingQuote)).toEqual([
      'real advisory',
    ])
    // With no shaped entry anywhere the last-entry fallback still applies.
    expect(collectReviewerAdvisories(unshapedOnly)).toEqual([
      'example advisory',
    ])
    // The LAST shaped entry still wins over an earlier shaped one.
    const twoShaped = {
      type: 'json',
      value: [
        { ...realReceipt, advisories: ['stale advisory'] },
        realReceipt,
        quotedExample,
      ],
    }
    expect(collectReviewerAdvisories(twoShaped)).toEqual(['real advisory'])
    // base2's generated copy is the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const input of [withTrailingQuote, unshapedOnly, twoShaped]) {
      expect(inlineHelpers.collectReviewerAdvisories(input)).toEqual(
        collectReviewerAdvisories(input),
      )
    }
  })

  // Serialization guard for the gate-pass advisory lookup. reviewReceipts is
  // durable and holds up to 24 entries across turns and reviewer families, so
  // the pass path must select THIS gate's receipt by gateId instead of reading
  // the last stored receipt (which could surface another family's or an earlier
  // turn's advisories and count them in advisoryCount telemetry). Asserted at
  // the source level because the pass block lives inside base2's serialized
  // handleSteps generator and cannot be reconstructed standalone.
  test('the base2 gate-pass advisory lookup is bound to this gate receipt', () => {
    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )
    expect(base2Source).toContain(
      'const passReceiptGateId = `${requiredReviewerAgentType}:${reviewSnapshotFingerprint}`',
    )
    expect(base2Source).toContain(
      '(receipt) => receipt.gateId === passReceiptGateId,',
    )
    // The unbound "latest receipt" read must be gone.
    expect(base2Source).not.toContain(
      '(activeWorkState.reviewReceipts ?? []).slice(-1)[0]?.advisories',
    )
    // The persisted advisories must come from the shared collector, not a
    // second inline read of the structured entry with different semantics.
    expect(base2Source).toContain(
      'const advisories = collectReviewerAdvisories(toolResult)',
    )
    expect(base2Source).not.toContain(
      'const advisories = (result.advisories ??',
    )
  })

  test('collectReviewerBlockers falls back to text line verdicts', () => {
    expect(
      collectReviewerBlockers({
        nested: [
          '<think>analysis</think>\nBLOCKING: fix the bug',
          'This sentence mentions BLOCKING but is not a line verdict.',
          '  blocking details are case-insensitive',
        ],
      }),
    ).toEqual([
      'BLOCKING: fix the bug',
      'blocking details are case-insensitive',
    ])
  })

  test('getReviewerFinalizationVerdict accepts only structured LOOKS_GOOD finalization', () => {
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'looks_good' }],
      }),
    ).toBe('LOOKS_GOOD')
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'NON_BLOCKING', findings: 'minor suggestion' }],
      }),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict([
        '<think>analysis</think>\nLOOKS_GOOD: no issues',
      ]),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict('Reviewer gate passed ( NON_BLOCKING )'),
    ).toBe('')
    expect(getReviewerFinalizationVerdict('BLOCKING: fix first')).toBe('')
  })

  // RF-2-0aa9f731: finalization credit and attestation must read the SAME
  // entry set. An unshaped QUOTED LOOKS_GOOD example beside a real shaped
  // BLOCKING receipt must not credit the gate; with no shaped entry at all the
  // whole set is still read, matching resolveReviewerAttestation's fallback.
  test('finalization credit ignores unshaped entries when the receipt carries shaped ones', () => {
    const realBlocking = {
      schemaVersion: 1,
      verdict: 'BLOCKING' as const,
      findings: ['real blocker'],
      coverage: 'covered' as const,
    }
    const quotedLooksGood = {
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
    }
    const mixed = { type: 'json', value: [realBlocking, quotedLooksGood] }
    expect(getReviewerFinalizationVerdict(mixed)).toBe('')
    // The real receipt's blocker is still the surviving repair target.
    expect(collectReviewerBlockers(mixed)).toEqual(['BLOCKING: real blocker'])
    // A shaped LOOKS_GOOD receipt still finalizes.
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ ...quotedLooksGood, schemaVersion: 1 }],
      }),
    ).toBe('LOOKS_GOOD')
    // No shaped entry anywhere: the unnarrowed scan still credits LOOKS_GOOD.
    const unshapedOnly = { type: 'json', value: [quotedLooksGood] }
    expect(getReviewerFinalizationVerdict(unshapedOnly)).toBe('LOOKS_GOOD')
    // base2's inline mirror is the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    expect(inlineHelpers.getReviewerFinalizationVerdict(mixed)).toBe('')
    expect(inlineHelpers.getReviewerFinalizationVerdict(unshapedOnly)).toBe(
      'LOOKS_GOOD',
    )
  })

  // RF-1-17fea4a5: the documented loosening. The reviewedFiles UNION is not
  // restricted to the entry that contributed the credited fingerprint, so a
  // quoted example whose example path COLLIDES with a real pending path credits
  // coverage the real entry never attested. Pinned so resolveReviewerAttestation's
  // docblock caveat stays honest; a pending path NO entry reported still blocks.
  test('the reviewedFiles union credits a colliding quoted example path', () => {
    const expected = 'v3:' + 'd'.repeat(64)
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: expected,
      reviewedFiles: ['src/b.ts'],
    }
    // Quote of the documented receipt example, whose example path happens to be
    // a real pending file the attesting entry never reviewed.
    const quotedExample = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['example: a nit'],
      coverage: 'covered' as const,
      reviewedFiles: ['src/a.ts'],
    }
    const collidingQuote = { type: 'json', value: [attesting, quotedExample] }
    expect(
      collectReviewerAttestationIssues(collidingQuote, expected, [
        'src/a.ts',
        'src/b.ts',
      ]),
    ).toEqual([])
    // A pending path neither entry reported still fails closed.
    expect(
      collectReviewerAttestationIssues(collidingQuote, expected, [
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
      ]),
    ).toEqual([
      'BLOCKING: reviewer did not attest to every pending file: src/c.ts',
    ])
    // base2's inline mirror is the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const pendingFiles of [
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    ]) {
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          collidingQuote,
          expected,
          pendingFiles,
        ),
      ).toEqual(
        collectReviewerAttestationIssues(
          collidingQuote,
          expected,
          pendingFiles,
        ),
      )
    }
  })

  test('collectReviewerBlockers elevates NON_BLOCKING findings to repair strings', () => {
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: [
          {
            verdict: 'NON_BLOCKING',
            findings: ['minor naming nit', '  style tweak  '],
            coverage: 'covered',
          },
        ],
      }),
    ).toEqual(['NON_BLOCKING: minor naming nit', 'NON_BLOCKING: style tweak'])
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: [{ verdict: 'NON_BLOCKING', findings: [], coverage: 'covered' }],
      }),
    ).toEqual([
      'NON_BLOCKING: reviewer returned non-blocking nits without findings; re-address and re-review until LOOKS_GOOD',
    ])
  })

  // M6.3: coverage-adequacy in the reviewer verdict contract.
  test('collectReviewerBlockers surfaces missing coverage as BLOCKING', () => {
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: [
          {
            verdict: 'NON_BLOCKING',
            findings: ['minor nit'],
            coverage: 'missing',
          },
        ],
      }),
    ).toEqual([
      // Hard blockers are collected before NON_BLOCKING findings so pure
      // coverage sets stay all-coverage for test-writer routing.
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      'NON_BLOCKING: minor nit',
    ])
    // Empty NON_BLOCKING findings + coverage missing: skip synthetic empty
    // NON_BLOCKING string so all-coverage routing to test-writer still works.
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: [
          {
            verdict: 'NON_BLOCKING',
            findings: [],
            coverage: 'missing',
          },
        ],
      }),
    ).toEqual([
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
    ])
  })

  test('collectReviewerBlockers surfaces both BLOCKING findings and missing coverage', () => {
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: [
          { verdict: 'BLOCKING', findings: ['Fix A'], coverage: 'missing' },
        ],
      }),
    ).toEqual([
      'BLOCKING: Fix A',
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
    ])
  })

  test('collectReviewerBlockers blocks failed dimensions and incomplete requirements', () => {
    expect(
      collectReviewerBlockers({
        verdict: 'LOOKS_GOOD',
        findings: [],
        coverage: 'covered',
        dimensions: {
          correctness: 'pass',
          security: 'block',
        },
        requirementCoverage: [
          { requirement: 'preserve CLI compatibility', status: 'uncertain' },
          { requirement: 'add tests', status: 'satisfied' },
        ],
      }),
    ).toEqual([
      'BLOCKING: security review dimension failed',
      'BLOCKING: requirement uncertain: preserve CLI compatibility',
    ])
  })

  test('collectReviewerBlockers de-dupes identical blockers from nested structured receipts', () => {
    // Hard requirement gap already forces re-review, so empty NON_BLOCKING
    // findings do not add a synthetic NON_BLOCKING string.
    const receipt = {
      verdict: 'NON_BLOCKING',
      findings: [],
      coverage: 'covered',
      requirementCoverage: [
        { requirement: 'wire selfMutatedPaths', status: 'missing' },
      ],
    }
    expect(
      collectReviewerBlockers({
        type: 'json',
        value: { type: 'json', value: receipt },
      }),
    ).toEqual(['BLOCKING: requirement missing: wire selfMutatedPaths'])
    expect(collectReviewerBlockers([receipt, receipt])).toEqual([
      'BLOCKING: requirement missing: wire selfMutatedPaths',
    ])
  })

  // RF-1-dd326e16: a parent-owned requirement gap is filtered away by every
  // gate call site, so it is not repair fuel. An empty-findings NON_BLOCKING
  // receipt whose ONLY gaps are parent-owned must still emit the synthetic
  // placeholder; otherwise the call-site filter empties the blocker list, the
  // condoned-pass branch cannot fire (it needs a collected blocker), and the
  // gate misdiagnoses the receipt as "no structured output" with no target.
  test('keeps the synthetic placeholder when the only requirement gap is parent-owned', () => {
    const placeholder =
      'NON_BLOCKING: reviewer returned non-blocking nits without findings; re-address and re-review until LOOKS_GOOD'
    const parentOwnedOnlyReceipt = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'commit and push',
          status: 'missing' as const,
          evidence: [] as string[],
        },
      ],
    }
    const rawBlockers = collectReviewerBlockers(parentOwnedOnlyReceipt)
    expect(rawBlockers).toEqual([
      'BLOCKING: requirement missing: commit and push',
      placeholder,
    ])
    const parentOwned = collectParentOwnedRequirementBlockers(
      rawBlockers,
      parentOwnedOnlyReceipt,
    )
    // The call-site filter drops the process gap, and a repair/re-review target
    // survives instead of an empty list.
    expect(rawBlockers.filter((blocker) => !parentOwned.has(blocker))).toEqual([
      placeholder,
    ])
    // Evidence-only parent ownership follows the same rule as the filter.
    expect(
      collectReviewerBlockers({
        ...parentOwnedOnlyReceipt,
        requirementCoverage: [
          {
            requirement: 'Ship remaining workflow steps',
            status: 'missing' as const,
            evidence: [
              'parent must run full validation gate after this specialist',
            ],
          },
        ],
      }),
    ).toEqual([
      'BLOCKING: requirement missing: Ship remaining workflow steps',
      placeholder,
    ])
    // An in-scope gap is repair fuel on its own, so no placeholder is mixed in
    // (all-coverage / single-target routing is unchanged).
    expect(
      collectReviewerBlockers({
        ...parentOwnedOnlyReceipt,
        requirementCoverage: [
          {
            requirement: 'wire selfMutatedPaths',
            status: 'missing' as const,
            evidence: [] as string[],
          },
        ],
      }),
    ).toEqual(['BLOCKING: requirement missing: wire selfMutatedPaths'])
  })

  test('parent-owned process requirements stay in raw blockers but do not block LOOKS_GOOD finalization', () => {
    const parentOwnedReceipt = {
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      dimensions: {
        correctness: 'pass',
        security: 'pass',
        tests: 'pass',
        apiCompatibility: 'pass',
        performance: 'pass',
      },
      requirementCoverage: [
        { requirement: 'Rewrite git commit messages', status: 'missing' },
        { requirement: 'Run full validation gate', status: 'uncertain' },
        { requirement: 'Commit and push', status: 'missing' },
        { requirement: 'Confirm CI/CD is green', status: 'uncertain' },
      ],
    }
    // collectReviewerBlockers retains parent-owned rows so consumers can
    // detect parentOwnedOnlyBlockers; filter only at the call site.
    expect(collectReviewerBlockers(parentOwnedReceipt)).toEqual([
      'BLOCKING: requirement missing: Rewrite git commit messages',
      'BLOCKING: requirement uncertain: Run full validation gate',
      'BLOCKING: requirement missing: Commit and push',
      'BLOCKING: requirement uncertain: Confirm CI/CD is green',
    ])
    expect(getReviewerFinalizationVerdict(parentOwnedReceipt)).toBe(
      'LOOKS_GOOD',
    )
    expect(
      isParentOwnedOrOutOfScopeRequirement('Rewrite git commit messages'),
    ).toBe(true)
    expect(
      isParentOwnedOrOutOfScopeRequirement('Run full validation gate'),
    ).toBe(true)
    // Source-owned validation work must not be suppressed as parent process.
    expect(
      isParentOwnedOrOutOfScopeRequirement('run validation of the new API'),
    ).toBe(false)
    expect(isParentOwnedOrOutOfScopeRequirement('wire selfMutatedPaths')).toBe(
      false,
    )
    // RF-3: bare `parent must` / `push changes` also occur in ordinary domain
    // text. Such a row would be filtered from blockers AND ignored by
    // getReviewerFinalizationVerdict, so a genuine gap would finalize
    // silently; only a process verb/object counts as parent-owned.
    expect(
      isParentOwnedOrOutOfScopeRequirement(
        'Reject the insert when the parent must be validated first',
        ['the parent must be validated before insert'],
      ),
    ).toBe(false)
    expect(
      isParentOwnedOrOutOfScopeRequirement(
        'the API should push changes to subscribers',
      ),
    ).toBe(false)
    expect(
      isParentOwnedOrOutOfScopeRequirement('push changes into the cache layer'),
    ).toBe(false)
    // The process wordings stay parent-owned.
    expect(
      isParentOwnedOrOutOfScopeRequirement(
        'parent must run the full validation gate',
      ),
    ).toBe(true)
    expect(
      isParentOwnedOrOutOfScopeRequirement(
        'parent must confirm CI/CD is green',
      ),
    ).toBe(true)
    expect(
      isParentOwnedOrOutOfScopeRequirement('push the changes to origin'),
    ).toBe(true)
    expect(isParentOwnedOrOutOfScopeRequirement('push changes upstream')).toBe(
      true,
    )
    // Real in-scope gaps still appear alongside parent-owned rows in raw blockers.
    expect(
      collectReviewerBlockers({
        ...parentOwnedReceipt,
        requirementCoverage: [
          ...parentOwnedReceipt.requirementCoverage,
          { requirement: 'preserve CLI compatibility', status: 'missing' },
        ],
      }),
    ).toEqual([
      'BLOCKING: requirement missing: Rewrite git commit messages',
      'BLOCKING: requirement uncertain: Run full validation gate',
      'BLOCKING: requirement missing: Commit and push',
      'BLOCKING: requirement uncertain: Confirm CI/CD is green',
      'BLOCKING: requirement missing: preserve CLI compatibility',
    ])
    expect(
      getReviewerFinalizationVerdict({
        ...parentOwnedReceipt,
        requirementCoverage: [
          ...parentOwnedReceipt.requirementCoverage,
          { requirement: 'wire selfMutatedPaths', status: 'uncertain' },
        ],
      }),
    ).toBe('')
  })

  test('collectParentOwnedRequirementBlockers re-checks structured evidence at call sites', () => {
    // Requirement text alone is not parent-owned; evidence carries the process cue.
    // Finalization and call-site filters must both consult evidence so LOOKS_GOOD
    // does not finalize while still spawning repair-editor.
    const evidenceOnlyReceipt = {
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
      ],
    }
    const rawBlockers = collectReviewerBlockers(evidenceOnlyReceipt)
    expect(rawBlockers).toEqual([
      'BLOCKING: requirement missing: Ship remaining workflow steps',
    ])
    // Without toolResult, only the requirement text is visible → not parent-owned.
    expect(
      collectParentOwnedRequirementBlockers(rawBlockers).has(rawBlockers[0]!),
    ).toBe(false)
    // With toolResult, structured evidence matches getReviewerFinalizationVerdict.
    expect(
      collectParentOwnedRequirementBlockers(
        rawBlockers,
        evidenceOnlyReceipt,
      ).has(rawBlockers[0]!),
    ).toBe(true)
    expect(
      referenceParentOwnedBlocker(
        rawBlockers[0]!,
        evidenceOnlyReceipt.requirementCoverage,
      ),
    ).toBe(true)
    expect(getReviewerFinalizationVerdict(evidenceOnlyReceipt)).toBe(
      'LOOKS_GOOD',
    )
    // Call-site filter shape used by specialist/security/code-reviewer.
    const parentOwned = collectParentOwnedRequirementBlockers(
      rawBlockers,
      evidenceOnlyReceipt,
    )
    const filtered = rawBlockers.filter((blocker) => !parentOwned.has(blocker))
    expect(filtered).toEqual([])

    // Evidence that does not establish parent ownership must keep the gap in-scope.
    const inScopeEvidenceReceipt = {
      ...evidenceOnlyReceipt,
      requirementCoverage: [
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: ['unit tests still fail on the new path'],
        },
      ],
    }
    const inScopeBlockers = collectReviewerBlockers(inScopeEvidenceReceipt)
    expect(
      collectParentOwnedRequirementBlockers(
        inScopeBlockers,
        inScopeEvidenceReceipt,
      ).has(inScopeBlockers[0]!),
    ).toBe(false)
    expect(getReviewerFinalizationVerdict(inScopeEvidenceReceipt)).toBe('')
  })

  // Hot-path shape used by the gate: both blocker lists are classified from ONE
  // structured walk instead of one walk per blocker, so the batch helper must
  // agree with the readable per-blocker reference on every blocker (including
  // hard-rule strings and non-requirement blockers).
  test('collectParentOwnedRequirementBlockers matches the per-blocker reference for a whole list', () => {
    const receipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'Commit and push',
          status: 'missing' as const,
          evidence: [] as string[],
        },
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
        {
          requirement: 'preserve CLI compatibility',
          status: 'uncertain' as const,
          evidence: ['flag parsing changed'],
        },
      ],
    }
    const rawBlockers = collectReviewerBlockers(receipt)
    const rawHardBlockers = collectReviewerHardBlockers(receipt)
    const blockers = [
      ...rawBlockers,
      ...rawHardBlockers,
      // Non-requirement blockers must never be classified as parent-owned.
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      'NON_BLOCKING: tighten the docstring',
      // Same requirement text, different status → no structured row matches, so
      // the text-only fallback decides.
      'BLOCKING: requirement uncertain: Commit and push',
    ]
    const parentOwned = collectParentOwnedRequirementBlockers(blockers, receipt)
    expect(Array.from(parentOwned).sort()).toEqual(
      [
        'BLOCKING: requirement missing: Commit and push',
        'BLOCKING: requirement missing: Ship remaining workflow steps',
        'BLOCKING: requirement uncertain: Commit and push',
      ].sort(),
    )
    for (const blocker of blockers) {
      expect(parentOwned.has(blocker)).toBe(
        referenceParentOwnedBlocker(blocker, receipt.requirementCoverage),
      )
    }
    // Without a toolResult the classification falls back to requirement text.
    const textOnly = collectParentOwnedRequirementBlockers(blockers)
    for (const blocker of blockers) {
      expect(textOnly.has(blocker)).toBe(referenceParentOwnedBlocker(blocker))
    }
    expect(textOnly.has('BLOCKING: requirement missing: Commit and push')).toBe(
      true,
    )
    expect(
      textOnly.has(
        'BLOCKING: requirement missing: Ship remaining workflow steps',
      ),
    ).toBe(false)
  })

  // RF-2: the blocker string carries the RAW requirement text, so padded and
  // multi-line requirements must still resolve to their structured,
  // evidence-aware row instead of degrading to text-only classification.
  test('classifies padded and multi-line requirement text from structured evidence', () => {
    for (const requirement of [
      '  Ship remaining workflow steps  ',
      'Ship remaining workflow steps\nacross both entrypoints',
    ]) {
      const receipt = {
        schemaVersion: 1,
        verdict: 'LOOKS_GOOD' as const,
        findings: [] as string[],
        coverage: 'covered' as const,
        requirementCoverage: [
          {
            requirement,
            status: 'missing' as const,
            evidence: [
              'parent must run full validation gate after this specialist',
            ],
          },
        ],
      }
      const rawBlockers = collectReviewerBlockers(receipt)
      expect(rawBlockers).toEqual([
        `BLOCKING: requirement missing: ${requirement}`,
      ])
      expect(
        collectParentOwnedRequirementBlockers(rawBlockers, receipt).has(
          rawBlockers[0]!,
        ),
      ).toBe(true)
      expect(
        referenceParentOwnedBlocker(
          rawBlockers[0]!,
          receipt.requirementCoverage,
        ),
      ).toBe(true)
      // Parent-owned only via evidence, so finalization still credits
      // LOOKS_GOOD and the call-site filter must agree (no repair spawn).
      expect(getReviewerFinalizationVerdict(receipt)).toBe('LOOKS_GOOD')

      // In-scope evidence keeps the same padded/multi-line row a repair target.
      const inScopeReceipt = {
        ...receipt,
        requirementCoverage: [
          {
            requirement,
            status: 'missing' as const,
            evidence: ['unit tests still fail on the new path'],
          },
        ],
      }
      const inScopeBlockers = collectReviewerBlockers(inScopeReceipt)
      expect(
        collectParentOwnedRequirementBlockers(
          inScopeBlockers,
          inScopeReceipt,
        ).has(inScopeBlockers[0]!),
      ).toBe(false)
      expect(
        referenceParentOwnedBlocker(
          inScopeBlockers[0]!,
          inScopeReceipt.requirementCoverage,
        ),
      ).toBe(false)
      expect(getReviewerFinalizationVerdict(inScopeReceipt)).toBe('')
    }
  })

  // RF-1: structured rows are keyed by `${status}\n${requirement}`, so one
  // receipt can carry two same-status/same-text rows whose evidence disagrees
  // (one process, one in-scope). getReviewerFinalizationVerdict blocks when ANY
  // matching row is in-scope, so the batch classifier must NOT filter the
  // blocker out — otherwise the gate stays closed with an empty surviving
  // blocker list and no repair target.
  test('an in-scope duplicate row wins over a parent-owned row with the same status and text', () => {
    const duplicateRowReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: ['unit tests still fail on the new path'],
        },
      ],
    }
    // Both rows emit the same blocker string, de-duped to one.
    const rawBlockers = collectReviewerBlockers(duplicateRowReceipt)
    expect(rawBlockers).toEqual([
      'BLOCKING: requirement missing: Ship remaining workflow steps',
    ])
    const parentOwned = collectParentOwnedRequirementBlockers(
      rawBlockers,
      duplicateRowReceipt,
    )
    expect(parentOwned.has(rawBlockers[0]!)).toBe(false)
    // The blocker survives the call-site filter, so the closed gate has a target.
    expect(rawBlockers.filter((blocker) => !parentOwned.has(blocker))).toEqual([
      'BLOCKING: requirement missing: Ship remaining workflow steps',
    ])
    expect(getReviewerFinalizationVerdict(duplicateRowReceipt)).toBe('')
    expect(
      referenceParentOwnedBlocker(
        rawBlockers[0]!,
        duplicateRowReceipt.requirementCoverage,
      ),
    ).toBe(false)
    // Row order must not change the outcome.
    const reversedReceipt = {
      ...duplicateRowReceipt,
      requirementCoverage: [
        ...duplicateRowReceipt.requirementCoverage,
      ].reverse(),
    }
    const reversedBlockers = collectReviewerBlockers(reversedReceipt)
    expect(
      collectParentOwnedRequirementBlockers(
        reversedBlockers,
        reversedReceipt,
      ).has(reversedBlockers[0]!),
    ).toBe(false)
    expect(getReviewerFinalizationVerdict(reversedReceipt)).toBe('')
    // Two parent-owned rows with the same key stay parent-owned (no regression
    // in the credited path).
    const bothParentOwnedReceipt = {
      ...duplicateRowReceipt,
      requirementCoverage: [
        duplicateRowReceipt.requirementCoverage[0]!,
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: ['parent/operator owns the push'],
        },
      ],
    }
    const bothParentOwnedBlockers = collectReviewerBlockers(
      bothParentOwnedReceipt,
    )
    expect(
      collectParentOwnedRequirementBlockers(
        bothParentOwnedBlockers,
        bothParentOwnedReceipt,
      ).has(bothParentOwnedBlockers[0]!),
    ).toBe(true)
    expect(getReviewerFinalizationVerdict(bothParentOwnedReceipt)).toBe(
      'LOOKS_GOOD',
    )
  })

  // RF-2: evidence is consulted ONLY for explicit ownership assertions. A
  // reviewer that merely QUOTES process prose as evidence ("the docs say commit
  // and push") must not convert a genuine in-scope requirement gap into a
  // credited LOOKS_GOOD with no surviving repair target.
  test('quoted process prose in evidence keeps an in-scope requirement gap open', () => {
    const quotedProseReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'preserve CLI compatibility',
          status: 'missing' as const,
          evidence: ['spec section: commit and push'],
        },
      ],
    }
    expect(
      isParentOwnedOrOutOfScopeRequirement('preserve CLI compatibility', [
        'spec section: commit and push',
      ]),
    ).toBe(false)
    const rawBlockers = collectReviewerBlockers(quotedProseReceipt)
    expect(rawBlockers).toEqual([
      'BLOCKING: requirement missing: preserve CLI compatibility',
    ])
    const parentOwned = collectParentOwnedRequirementBlockers(
      rawBlockers,
      quotedProseReceipt,
    )
    expect(parentOwned.has(rawBlockers[0]!)).toBe(false)
    // The gap survives the call-site filter, so the closed gate has a target.
    expect(rawBlockers.filter((blocker) => !parentOwned.has(blocker))).toEqual([
      'BLOCKING: requirement missing: preserve CLI compatibility',
    ])
    expect(getReviewerFinalizationVerdict(quotedProseReceipt)).toBe('')
    expect(
      referenceParentOwnedBlocker(
        rawBlockers[0]!,
        quotedProseReceipt.requirementCoverage,
      ),
    ).toBe(false)
    // Explicit ownership assertions in evidence are still honored.
    expect(
      isParentOwnedOrOutOfScopeRequirement('preserve CLI compatibility', [
        'parent/operator owns the release',
      ]),
    ).toBe(true)
    expect(
      isParentOwnedOrOutOfScopeRequirement('preserve CLI compatibility', [
        'parent must push the release branch',
      ]),
    ).toBe(true)
  })

  // base2 carries its OWN collectParentOwnedRequirementBlockers copy and the
  // gate call sites filter blockers with THAT copy at runtime, so the inline
  // mirror must stay equivalent to the export (an over-filtering mirror would
  // credit LOOKS_GOOD for a genuine in-scope gap).
  test('the inline base2 collectParentOwnedRequirementBlockers mirror matches the export', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const receipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      requirementCoverage: [
        {
          requirement: 'Commit and push',
          status: 'missing' as const,
          evidence: [] as string[],
        },
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
        {
          requirement: 'Reject the insert when the parent must be validated',
          status: 'missing' as const,
          evidence: ['the parent must be validated before insert'],
        },
        {
          // RF-2: quoted process prose in evidence stays in-scope in both copies.
          requirement: 'harden the parser',
          status: 'missing' as const,
          evidence: ['spec section: commit and push'],
        },
        {
          requirement: 'preserve CLI compatibility',
          status: 'uncertain' as const,
          evidence: ['flag parsing changed'],
        },
      ],
    }
    const blockers = [
      ...collectReviewerBlockers(receipt),
      'BLOCKING: requirement missing: the API should push changes to subscribers',
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      'NON_BLOCKING: tighten the docstring',
    ]
    // The in-scope-precedence branch (`!parentOwnedRow || !structuredRows.has`)
    // needs two same-status/same-text rows whose evidence disagrees, so pin the
    // mirror against that receipt too — in both row orders, since order must not
    // change either copy's classification.
    const duplicateKeyReceipt = {
      ...receipt,
      requirementCoverage: [
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing' as const,
          evidence: ['unit tests still fail on the new path'],
        },
      ],
    }
    const reversedDuplicateKeyReceipt = {
      ...duplicateKeyReceipt,
      requirementCoverage: [
        ...duplicateKeyReceipt.requirementCoverage,
      ].reverse(),
    }
    for (const toolResult of [
      receipt,
      { type: 'json', value: receipt },
      duplicateKeyReceipt,
      { type: 'json', value: duplicateKeyReceipt },
      reversedDuplicateKeyReceipt,
      { type: 'json', value: reversedDuplicateKeyReceipt },
      null,
    ]) {
      expect(
        Array.from(
          inlineHelpers.collectParentOwnedRequirementBlockers(
            blockers,
            toolResult,
          ),
        ),
      ).toEqual(
        Array.from(collectParentOwnedRequirementBlockers(blockers, toolResult)),
      )
    }
    // Same without a toolResult (text-only classification path).
    expect(
      Array.from(inlineHelpers.collectParentOwnedRequirementBlockers(blockers)),
    ).toEqual(Array.from(collectParentOwnedRequirementBlockers(blockers)))
  })

  // Entry-selection asymmetry (fail closed): attestation is resolved from the
  // schemaVersion-carrying entries while finalization/blocker collection scan
  // EVERY entry, so a result whose entries disagree on the verdict must be
  // rejected instead of letting an unattested LOOKS_GOOD entry take credit for
  // another entry's correct fingerprint + reviewedFiles.
  test('rejects a multi-entry receipt whose structured verdicts disagree', () => {
    const expected = 'v3:' + 'a'.repeat(64)
    const files = ['src/a.ts', 'src/b.ts']
    const mixedVerdictReceipt = {
      type: 'json',
      value: [
        // Finalization credit would come from this entry: attestation-shaped
        // (it carries schemaVersion) but reporting neither a fingerprint nor
        // reviewedFiles.
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [],
          coverage: 'covered',
        },
        // Attestation would come from this entry, which carries the fingerprint.
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: ['nit'],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(mixedVerdictReceipt, expected, files),
    ).toEqual([
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ])
    // The asymmetry the blocker closes: finalization still reads LOOKS_GOOD from
    // the first entry, so attestation is the only thing keeping the gate closed.
    expect(getReviewerFinalizationVerdict(mixedVerdictReceipt)).toBe(
      'LOOKS_GOOD',
    )
    // A duplicated receipt (nested spawn + set_output emitting the same object)
    // agrees on the verdict and must still attest normally.
    const duplicatedReceipt = {
      type: 'json',
      value: [
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [] as string[],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [] as string[],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(duplicatedReceipt, expected, files),
    ).toEqual([])
    // The finding's literal shape: an earlier LOOKS_GOOD entry that is NOT
    // attestation-shaped (no schemaVersion, so it is outside the narrowed
    // conflict check) plus a fully-attesting entry. Verdict agreement makes the
    // attesting entry authoritative for the same verdict the earlier entry would
    // have finalized, so this stays creditable.
    const unattestedFirstEntryReceipt = {
      type: 'json',
      value: [
        { verdict: 'LOOKS_GOOD', findings: [] as string[] },
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [] as string[],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(
        unattestedFirstEntryReceipt,
        expected,
        files,
      ),
    ).toEqual([])
    expect(getReviewerFinalizationVerdict(unattestedFirstEntryReceipt)).toBe(
      'LOOKS_GOOD',
    )
    // Same shape but both entries are attestation-shaped and the attesting one
    // BLOCKS: finalization would still read LOOKS_GOOD from the first entry, so
    // attestation must reject it.
    const blockingAttestingEntryReceipt = {
      type: 'json',
      value: [
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [] as string[],
          coverage: 'covered',
        },
        {
          schemaVersion: 1,
          verdict: 'BLOCKING',
          findings: ['real problem'],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(
        blockingAttestingEntryReceipt,
        expected,
        files,
      ),
    ).toEqual([
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ])
  })

  // RF-3-c7d841fd: `visitForStructuredVerdict` walks EVERY nested value, so a
  // reviewer that QUOTES an example receipt object beside its own receipt used
  // to trip the conflicting-verdict blocker and park the gate in `blocked`
  // after one retry. The conflict check is narrowed to entries carrying
  // `schemaVersion` (the attestation-shaped receipts).
  test('ignores a quoted example receipt without schemaVersion in the conflict check', () => {
    const expected = 'v3:' + 'a'.repeat(64)
    const files = ['src/a.ts']
    const quotedExampleReceipt = {
      type: 'json',
      value: [
        // Illustrative receipt the reviewer quoted in its output: verdict-shaped
        // but with no schemaVersion attestation of its own.
        { verdict: 'LOOKS_GOOD', findings: ['example: no findings'] },
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: ['real nit'],
          coverage: 'covered',
          snapshotFingerprint: expected,
          reviewedFiles: files,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(quotedExampleReceipt, expected, files),
    ).toEqual([])
    // The narrowing is not a silent pass: the real NON_BLOCKING finding is
    // still repair fuel, so the gate opens a repair round instead of
    // finalizing.
    expect(collectReviewerBlockers(quotedExampleReceipt)).toContain(
      'NON_BLOCKING: real nit',
    )
    // Two attestation-shaped receipts that disagree are still rejected.
    expect(
      collectReviewerAttestationIssues(
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'LOOKS_GOOD',
              findings: [] as string[],
              coverage: 'covered',
            },
            {
              schemaVersion: 1,
              verdict: 'NON_BLOCKING',
              findings: ['nit'],
              coverage: 'covered',
              snapshotFingerprint: expected,
              reviewedFiles: files,
            },
          ],
        },
        expected,
        files,
      ),
    ).toEqual([
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ])
  })

  // RF-1-f142a695 (PINNED INTENT): `collectReviewerAttestationIssues` narrows
  // its conflict check to schemaVersion-carrying entries, but
  // `collectReviewerBlockers` and `getReviewerFinalizationVerdict` deliberately
  // keep scanning EVERY nested entry. The asymmetry is intentional and fails
  // closed: a quoted BLOCKING/NON_BLOCKING example costs one extra repair
  // round, whereas narrowing the two collectors would DROP a genuine blocker
  // (and credit LOOKS_GOOD) whenever a reviewer's real findings arrive in an
  // entry that omits schemaVersion. Pin both halves so the tradeoff cannot be
  // flipped silently.
  test('a quoted BLOCKING example without schemaVersion still elevates a fail-closed blocker', () => {
    const expected = 'v3:' + 'a'.repeat(64)
    const files = ['src/a.ts']
    const attesting = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      snapshotFingerprint: expected,
      reviewedFiles: files,
    }
    // Illustrative receipts the reviewer quoted from its contract:
    // verdict-shaped, with no schemaVersion of their own.
    const quotedBlockingExample = {
      type: 'json',
      value: [
        attesting,
        { verdict: 'BLOCKING', findings: ['example: fix the thing'] },
      ],
    }
    const quotedNonBlockingExample = {
      type: 'json',
      value: [
        attesting,
        { verdict: 'NON_BLOCKING', findings: ['example: a nit'] },
      ],
    }
    // Attestation is read from the schemaVersion-carrying entry and the quote
    // stays outside the conflict check, so the receipt still attests.
    for (const toolResult of [
      quotedBlockingExample,
      quotedNonBlockingExample,
    ]) {
      expect(
        collectReviewerAttestationIssues(toolResult, expected, files),
      ).toEqual([])
    }
    // The unnarrowed collectors still see the quote, so the surviving blocker —
    // not the verdict — is what keeps the gate closed for one repair round.
    expect(collectReviewerBlockers(quotedBlockingExample)).toEqual([
      'BLOCKING: example: fix the thing',
    ])
    expect(collectReviewerBlockers(quotedNonBlockingExample)).toEqual([
      'NON_BLOCKING: example: a nit',
    ])
    expect(getReviewerFinalizationVerdict(quotedBlockingExample)).toBe(
      'LOOKS_GOOD',
    )
    // A quoted example carrying a hard-rule field blocks finalization outright
    // rather than being ignored (the same fail-closed direction).
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [
          attesting,
          { verdict: 'BLOCKING', findings: ['example'], coverage: 'missing' },
        ],
      }),
    ).toBe('')
    // base2 runs its OWN inline copies at every gate call site.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [
      quotedBlockingExample,
      quotedNonBlockingExample,
    ]) {
      expect(inlineHelpers.collectReviewerBlockers(toolResult)).toEqual(
        collectReviewerBlockers(toolResult),
      )
      expect(inlineHelpers.getReviewerFinalizationVerdict(toolResult)).toBe(
        getReviewerFinalizationVerdict(toolResult),
      )
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          toolResult,
          expected,
          files,
        ),
      ).toEqual(collectReviewerAttestationIssues(toolResult, expected, files))
    }
  })

  // RF-2-edb346ed (PINNED INTENT): the receipt example reviewers are shown
  // carries `schemaVersion: 1`, so a QUOTED example may copy it and is then
  // indistinguishable from a second real receipt. Such an entry stays in the
  // `verdicts` set on purpose: excluding entries that report neither
  // snapshotFingerprint nor reviewedFiles would also excuse the mixed-verdict
  // receipt pinned above, whose credited LOOKS_GOOD entry never attested at
  // all. Disagreement therefore fails closed, and only verdict AGREEMENT is
  // creditable.
  test('a quoted example carrying schemaVersion stays in the conflict check', () => {
    const expected = 'v3:' + 'a'.repeat(64)
    const files = ['src/a.ts']
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: expected,
      reviewedFiles: files,
    }
    // Quoted example copying the documented shape (schemaVersion, but no
    // fingerprint or reviewedFiles of its own) with a DIFFERENT verdict.
    const quotedSchemaVersionExample = {
      type: 'json',
      value: [
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          findings: [] as string[],
          coverage: 'covered',
        },
        attesting,
      ],
    }
    expect(
      collectReviewerAttestationIssues(
        quotedSchemaVersionExample,
        expected,
        files,
      ),
    ).toEqual([
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ])
    // Agreement is unaffected: the same quoted shape beside a receipt with the
    // SAME verdict still attests from the real (fingerprint-reporting) entry.
    const agreeingQuote = {
      type: 'json',
      value: [
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: ['example: a nit'],
          coverage: 'covered',
        },
        attesting,
      ],
    }
    expect(
      collectReviewerAttestationIssues(agreeingQuote, expected, files),
    ).toEqual([])
    // Two genuinely attesting receipts that disagree stay fail-closed.
    const twoAttestingReceipts = {
      type: 'json',
      value: [
        { ...attesting, verdict: 'LOOKS_GOOD', findings: [] as string[] },
        { ...attesting, verdict: 'BLOCKING', findings: ['real problem'] },
      ],
    }
    expect(
      collectReviewerAttestationIssues(twoAttestingReceipts, expected, files),
    ).toEqual([
      'BLOCKING: reviewer returned conflicting structured verdicts in one result',
    ])
    // base2's inline attestation copy is the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [
      quotedSchemaVersionExample,
      agreeingQuote,
      twoAttestingReceipts,
    ]) {
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          toolResult,
          expected,
          files,
        ),
      ).toEqual(collectReviewerAttestationIssues(toolResult, expected, files))
    }
  })

  // RF-1-919b6ae7 / RF-2-cdbf4706: the documented example receipt carries
  // `schemaVersion: 1`, so a reviewer may quote it AFTER its own receipt with
  // the SAME verdict. That passes the narrowed conflict check, so the
  // attestation and the drift must be read from the entry that actually
  // reported one — otherwise a well-behaved reviewer collects two spurious
  // BLOCKING attestation issues and, after base2's single
  // `reviewer-protocol-attestation-failed` retry, a terminal gate failure.
  test('reads the attestation from the attesting entry when a schemaVersion-carrying quote trails it', () => {
    const drifted = 'v3:' + 'e'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const files = ['src/a.ts']
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: drifted,
      reviewedFiles: files,
    }
    // Quote of the documented shape (schemaVersion: 1, SAME verdict, neither
    // snapshotFingerprint nor reviewedFiles) AFTER the real receipt.
    const trailingSchemaVersionQuote = {
      type: 'json',
      value: [
        attesting,
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: ['example: a nit'],
          coverage: 'covered',
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(
        trailingSchemaVersionQuote,
        expected,
        files,
      ),
    ).toEqual([])
    // The tolerated drift is still recorded from the attesting entry.
    expect(
      collectReviewerFingerprintDrift(trailingSchemaVersionQuote, expected),
    ).toBe(drifted)
    // Fail closed still: when NO schemaVersion-carrying entry reported a
    // fingerprint or reviewedFiles, the last one is read and rejected.
    const quoteOnlyReceipt = {
      type: 'json',
      value: [
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: ['example: a nit'],
          coverage: 'covered',
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(quoteOnlyReceipt, expected, files),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
      'BLOCKING: reviewer did not attest to every pending file: src/a.ts',
    ])
    expect(collectReviewerFingerprintDrift(quoteOnlyReceipt, expected)).toBe('')
    // base2's inline mirrors are the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [trailingSchemaVersionQuote, quoteOnlyReceipt]) {
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          toolResult,
          expected,
          files,
        ),
      ).toEqual(collectReviewerAttestationIssues(toolResult, expected, files))
      expect(
        inlineHelpers.collectReviewerFingerprintDrift(toolResult, expected),
      ).toBe(collectReviewerFingerprintDrift(toolResult, expected))
    }
  })

  // RF-1-7e02aac4 / RF-2-fb778b7d: the documented receipt example literally
  // shows `reviewedFiles: ["src/a.ts"]`, so a SAME-verdict quote of it trailing
  // the real receipt reports attestation payload of its own. A
  // last-payload-wins selector would read the attestation (and the drift) from
  // that quote and raise a spurious 'did not attest to every pending file'
  // blocker, so selection prefers the entry reporting the EXPECTED fingerprint
  // and otherwise the FIRST payload-carrying entry.
  test('keeps the attestation on the real receipt when a trailing quote also reports payload', () => {
    const drifted = 'v3:' + 'e'.repeat(64)
    const quoted = 'v3:' + 'c'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const files = ['src/a.ts']
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: drifted,
      reviewedFiles: files,
    }
    // Quote of the documented shape, copied WITH its reviewedFiles example.
    const quotedExample = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['example: a nit'],
      coverage: 'covered' as const,
      reviewedFiles: ['src/example.ts'],
    }
    const trailingQuoteWithFiles = {
      type: 'json',
      value: [attesting, quotedExample],
    }
    // The same quote, also copying a v3 fingerprint of its own.
    const trailingQuoteWithFingerprint = {
      type: 'json',
      value: [attesting, { ...quotedExample, snapshotFingerprint: quoted }],
    }
    // A LEADING quote cannot steal it either: the entry reporting the expected
    // fingerprint wins outright.
    const leadingQuoteWithFingerprint = {
      type: 'json',
      value: [
        { ...quotedExample, snapshotFingerprint: quoted },
        { ...attesting, snapshotFingerprint: expected },
      ],
    }
    const toolResults = [
      trailingQuoteWithFiles,
      trailingQuoteWithFingerprint,
      leadingQuoteWithFingerprint,
    ]
    for (const toolResult of toolResults) {
      expect(
        collectReviewerAttestationIssues(toolResult, expected, files),
      ).toEqual([])
    }
    // Drift telemetry follows the real receipt, not the quote.
    expect(
      collectReviewerFingerprintDrift(trailingQuoteWithFiles, expected),
    ).toBe(drifted)
    expect(
      collectReviewerFingerprintDrift(trailingQuoteWithFingerprint, expected),
    ).toBe(drifted)
    // Nothing to record when the preferred entry matched exactly, even though
    // the quote beside it reported a drifted fingerprint.
    expect(
      collectReviewerFingerprintDrift(leadingQuoteWithFingerprint, expected),
    ).toBe('')
    // base2's inline mirrors are the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of toolResults) {
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          toolResult,
          expected,
          files,
        ),
      ).toEqual(collectReviewerAttestationIssues(toolResult, expected, files))
      expect(
        inlineHelpers.collectReviewerFingerprintDrift(toolResult, expected),
      ).toBe(collectReviewerFingerprintDrift(toolResult, expected))
    }
  })

  // RF-1-e38fb9e1 / RF-2-410a3e1a: the mirror image of the trailing-quote
  // hazard. A LEADING quote of the documented example (schemaVersion: 1,
  // `reviewedFiles: ["src/example.ts"]`, no fingerprint of its own) beside a
  // real receipt whose fingerprint DRIFTED matches no entry, so a
  // first-payload-wins selector would read the attestation from the quote and
  // emit spurious 'fingerprint did not match' + 'did not attest to every
  // pending file' blockers while the drift recorder reported '' — a terminal
  // gate failure after base2's single reviewer-protocol retry, with the real
  // drift unrecorded. Selection is order-independent instead: reviewedFiles are
  // unioned across the schemaVersion-carrying entries and the fingerprint comes
  // from the entry matching the expected one, else the first attestable one.
  test('keeps the attestation on the real receipt when a leading quote precedes a drifted fingerprint', () => {
    const drifted = 'v3:' + 'e'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const files = ['src/a.ts']
    // Quote of the documented shape, copied WITH its reviewedFiles example and
    // no fingerprint of its own, LEADING the real receipt.
    const quotedExample = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['example: a nit'],
      coverage: 'covered' as const,
      reviewedFiles: ['src/example.ts'],
    }
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: drifted,
      reviewedFiles: files,
    }
    const leadingQuoteWithDriftedReal = {
      type: 'json',
      value: [quotedExample, attesting],
    }
    expect(
      collectReviewerAttestationIssues(
        leadingQuoteWithDriftedReal,
        expected,
        files,
      ),
    ).toEqual([])
    // Drift telemetry reports the REAL receipt's fingerprint rather than '' ...
    expect(
      collectReviewerFingerprintDrift(leadingQuoteWithDriftedReal, expected),
    ).toBe(drifted)
    // ... and the union is not a blanket pass: when NEITHER entry reported an
    // attestable fingerprint the receipt still fails closed.
    const leadingQuoteWithoutFingerprints = {
      type: 'json',
      value: [quotedExample, { ...attesting, snapshotFingerprint: undefined }],
    }
    expect(
      collectReviewerAttestationIssues(
        leadingQuoteWithoutFingerprints,
        expected,
        files,
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
    expect(
      collectReviewerFingerprintDrift(
        leadingQuoteWithoutFingerprints,
        expected,
      ),
    ).toBe('')
    // A pending file no entry attested still blocks, drifted fingerprint and
    // all, so the union cannot manufacture coverage.
    expect(
      collectReviewerAttestationIssues(leadingQuoteWithDriftedReal, expected, [
        ...files,
        'src/b.ts',
      ]),
    ).toEqual([
      'BLOCKING: reviewer snapshot fingerprint did not match the reviewed working tree',
      'BLOCKING: reviewer did not attest to every pending file: src/b.ts',
    ])
    // base2's inline mirrors are the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [
      leadingQuoteWithDriftedReal,
      leadingQuoteWithoutFingerprints,
    ]) {
      for (const pendingFiles of [files, [...files, 'src/b.ts']]) {
        expect(
          inlineHelpers.collectReviewerAttestationIssues(
            toolResult,
            expected,
            pendingFiles,
          ),
        ).toEqual(
          collectReviewerAttestationIssues(toolResult, expected, pendingFiles),
        )
      }
      expect(
        inlineHelpers.collectReviewerFingerprintDrift(toolResult, expected),
      ).toBe(collectReviewerFingerprintDrift(toolResult, expected))
    }
  })

  // RF-1-add6f07e (PINNED INTENT): `resolveReviewerAttestation` resolves PER
  // FIELD, so the credited attestation is a COMPOSITE — the fingerprint may come
  // from one shaped entry while the coverage union comes from all of them. A
  // receipt whose real entry reported no fingerprint is therefore creditable
  // from a quoted example entry's attestable v3 value. That looseness is
  // accepted deliberately: requiring the fingerprint-contributing entry to also
  // contribute a reviewed file would not close it (the documented example
  // carries `reviewedFiles`) and would reject the deletions-only receipt, which
  // legitimately attests with an empty `reviewedFiles`. What the gate relies on
  // is pinned below: the union still cannot manufacture coverage for a pending
  // file no entry reported, and a receipt where NO entry reported an attestable
  // fingerprint still fails closed.
  test('credits a spliced attestation: coverage from one entry, fingerprint from another', () => {
    const quotedFingerprint = 'v3:' + 'e'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const pendingFiles = ['src/a.ts']
    const splicedReceipt = {
      type: 'json',
      value: [
        // The real receipt: full coverage, but no fingerprint of its own.
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING' as const,
          findings: ['real nit'],
          coverage: 'covered' as const,
          reviewedFiles: pendingFiles,
          snapshotFingerprint: undefined,
        },
        // A quoted example receipt carrying the documented attestable shape.
        {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING' as const,
          findings: ['example: a nit'],
          coverage: 'covered' as const,
          reviewedFiles: ['src/example.ts'],
          snapshotFingerprint: quotedFingerprint,
        },
      ],
    }
    expect(
      collectReviewerAttestationIssues(splicedReceipt, expected, pendingFiles),
    ).toEqual([])
    // The credited fingerprint is the quoted one, so the drift is recorded
    // rather than accepted silently.
    expect(collectReviewerFingerprintDrift(splicedReceipt, expected)).toBe(
      quotedFingerprint,
    )
    // The union cannot manufacture coverage: a pending file no entry reported
    // still blocks (and the non-matching fingerprint is then a mismatch too).
    expect(
      collectReviewerAttestationIssues(splicedReceipt, expected, [
        ...pendingFiles,
        'src/b.ts',
      ]),
    ).toEqual([
      'BLOCKING: reviewer snapshot fingerprint did not match the reviewed working tree',
      'BLOCKING: reviewer did not attest to every pending file: src/b.ts',
    ])
    // Strip the quoted entry's fingerprint and the same receipt fails closed:
    // the splice never invents an attestable value.
    const noFingerprintReceipt = {
      type: 'json',
      value: [
        splicedReceipt.value[0]!,
        { ...splicedReceipt.value[1]!, snapshotFingerprint: undefined },
      ],
    }
    expect(
      collectReviewerAttestationIssues(
        noFingerprintReceipt,
        expected,
        pendingFiles,
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
    expect(
      collectReviewerFingerprintDrift(noFingerprintReceipt, expected),
    ).toBe('')
    // base2's inline mirrors are the gate's runtime authority.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [splicedReceipt, noFingerprintReceipt]) {
      for (const files of [pendingFiles, [...pendingFiles, 'src/b.ts']]) {
        expect(
          inlineHelpers.collectReviewerAttestationIssues(
            toolResult,
            expected,
            files,
          ),
        ).toEqual(collectReviewerAttestationIssues(toolResult, expected, files))
      }
      expect(
        inlineHelpers.collectReviewerFingerprintDrift(toolResult, expected),
      ).toBe(collectReviewerFingerprintDrift(toolResult, expected))
    }
  })

  // RF-2-1ce51577: schemaVersion conformance is checked on EVERY shaped entry,
  // not just the resolved one. A sibling entry claiming schemaVersion 2 must
  // reject the whole receipt even when the attesting entry reports 1 (and
  // regardless of which side the non-conforming entry arrives on).
  test('rejects a receipt whose sibling entry claims a non-1 schemaVersion', () => {
    const expected = 'v3:' + 'd'.repeat(64)
    const pendingFiles = ['src/a.ts']
    const attesting = {
      schemaVersion: 1,
      verdict: 'NON_BLOCKING' as const,
      findings: ['real nit'],
      coverage: 'covered' as const,
      snapshotFingerprint: expected,
      reviewedFiles: pendingFiles,
    }
    // Same verdict, so the conflict check passes and schemaVersion is what
    // decides. Non-conforming siblings are NOT ignored.
    const futureSchemaSibling = {
      schemaVersion: 2,
      verdict: 'NON_BLOCKING' as const,
      findings: ['from a newer schema'],
      coverage: 'covered' as const,
      reviewedFiles: ['src/example.ts'],
    }
    const trailingSibling = {
      type: 'json',
      value: [attesting, futureSchemaSibling],
    }
    const leadingSibling = {
      type: 'json',
      value: [futureSchemaSibling, attesting],
    }
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const toolResult of [trailingSibling, leadingSibling]) {
      expect(
        collectReviewerAttestationIssues(toolResult, expected, pendingFiles),
      ).toEqual([
        'BLOCKING: reviewer returned an invalid attestation schemaVersion',
      ])
      expect(
        inlineHelpers.collectReviewerAttestationIssues(
          toolResult,
          expected,
          pendingFiles,
        ),
      ).toEqual(
        collectReviewerAttestationIssues(toolResult, expected, pendingFiles),
      )
    }
    // A quoted example WITHOUT schemaVersion is still outside the conformance
    // check, so it does not reject the receipt (unchanged behavior).
    const unshapedQuote = {
      type: 'json',
      value: [
        attesting,
        { verdict: 'NON_BLOCKING' as const, findings: ['example: a nit'] },
      ],
    }
    expect(
      collectReviewerAttestationIssues(unshapedQuote, expected, pendingFiles),
    ).toEqual([])
  })

  test('structured v1 reviews require file coverage; fingerprint mismatch only blocks when coverage is incomplete', () => {
    // RF-3: 'stale' is not an attestable v3 fingerprint, so the operator
    // message must name the MISSING fingerprint rather than mislabelling it as
    // a mismatch (still fail-closed either way).
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'stale',
          reviewedFiles: ['src/a.ts'],
        },
        'current',
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
      'BLOCKING: reviewer did not attest to every pending file: src/b.ts',
    ])
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'b'.repeat(64),
          reviewedFiles: ['src/a.ts', 'src/b.ts'],
        },
        'v3:' + 'b'.repeat(64),
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([])
    // Full coverage + different but well-formed v3 fingerprint → no issues.
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'c'.repeat(64),
          reviewedFiles: ['src/a.ts', 'src/b.ts'],
        },
        'v3:' + 'd'.repeat(64),
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([])
  })

  test('rejects every non-1 attestation schema version', () => {
    for (const schemaVersion of [0, 2, 1.5]) {
      expect(
        collectReviewerAttestationIssues(
          {
            schemaVersion,
            verdict: 'NON_BLOCKING',
            snapshotFingerprint: 'current',
            reviewedFiles: ['src/a.ts'],
          },
          'current',
          ['src/a.ts'],
        ),
      ).toEqual([
        'BLOCKING: reviewer returned an invalid attestation schemaVersion',
      ])
    }
  })

  test('normalizes reviewed file paths before attestation comparison', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'c'.repeat(64),
          reviewedFiles: ['./src/a.ts', 'src\\b.ts'],
        },
        'v3:' + 'c'.repeat(64),
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([])
  })

  // The gate tolerates a fully-attesting review whose well-formed snapshot
  // fingerprint drifted from the exact bundle id (e.g. an unrelated plan-session
  // .jsonl/.md or a git-status bundle bump between spawn and attestation). Only
  // FILE-COVERAGE gaps, a missing fingerprint, or a non-attestable sentinel stay
  // hard blockers.
  test('tolerates a coverage-complete review with a wrong-but-well-formed fingerprint', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'e'.repeat(64),
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'd'.repeat(64),
        ['src/a.ts'],
      ),
    ).toEqual([])
  })

  // The tolerance above is deliberate but must not be silent: the drift is
  // reported separately so callers can record it (base2 emits gate telemetry).
  test('collectReviewerFingerprintDrift reports the tolerated non-matching v3 fingerprint', () => {
    const drifted = 'v3:' + 'e'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const coverageComplete = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: drifted,
      reviewedFiles: ['src/a.ts'],
    }
    // Attestation still tolerates the drift (no blocker) ...
    expect(
      collectReviewerAttestationIssues(coverageComplete, expected, [
        'src/a.ts',
      ]),
    ).toEqual([])
    // ... and the drift is surfaced for recording.
    expect(collectReviewerFingerprintDrift(coverageComplete, expected)).toBe(
      drifted,
    )
    // Nothing to record for an exact match or an already-blocking fingerprint.
    expect(
      collectReviewerFingerprintDrift(
        { ...coverageComplete, snapshotFingerprint: expected },
        expected,
      ),
    ).toBe('')
    expect(
      collectReviewerFingerprintDrift(
        { ...coverageComplete, snapshotFingerprint: 'unreadable:no-crypto' },
        expected,
      ),
    ).toBe('')
    expect(
      collectReviewerFingerprintDrift(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          reviewedFiles: ['src/a.ts'],
        },
        expected,
      ),
    ).toBe('')
    expect(collectReviewerFingerprintDrift(null, expected)).toBe('')
    // base2 consults its own inline copy at runtime; keep it equivalent.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    for (const input of [
      coverageComplete,
      { ...coverageComplete, snapshotFingerprint: expected },
      { type: 'json', value: [coverageComplete] },
      'BLOCKING: plain prose',
      null,
    ]) {
      expect(
        inlineHelpers.collectReviewerFingerprintDrift(input, expected),
      ).toBe(collectReviewerFingerprintDrift(input, expected))
    }
  })

  // RF-1-a0c548bf / RF-2-19213abe: `visitForStructuredVerdict` walks every
  // nested value, so a reviewer that QUOTES an example receipt AFTER its own one
  // must still be attested — and have its tolerated drift recorded — from the
  // attestation-shaped entry rather than from the trailing quote.
  test('reads the attestation and the drift from the schemaVersion-carrying entry when a quoted example trails it', () => {
    const drifted = 'v3:' + 'e'.repeat(64)
    const expected = 'v3:' + 'd'.repeat(64)
    const attestingReceiptWithDrift = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      snapshotFingerprint: drifted,
      reviewedFiles: ['src/a.ts'],
    }
    const quotedExampleWithoutFingerprint = {
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      reviewedFiles: ['src/example.ts'],
    }
    const toolResult = [
      attestingReceiptWithDrift,
      quotedExampleWithoutFingerprint,
    ]
    // The trailing quote no longer parks the gate in `blocked` on a bogus
    // invalid-schemaVersion blocker ...
    expect(
      collectReviewerAttestationIssues(toolResult, expected, ['src/a.ts']),
    ).toEqual([])
    // ... and the tolerated drift is still recorded from the attesting receipt.
    expect(collectReviewerFingerprintDrift(toolResult, expected)).toBe(drifted)
    // Fail-closed fallback: a receipt whose only entry carries no schemaVersion
    // is still rejected.
    expect(
      collectReviewerAttestationIssues(
        [quotedExampleWithoutFingerprint],
        expected,
        ['src/example.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer returned an invalid attestation schemaVersion',
    ])
    // base2 runs its own inline copies of both helpers at the gate call sites.
    const inlineHelpers = loadInlineGateReviewerHelpers()
    expect(
      inlineHelpers.collectReviewerAttestationIssues(toolResult, expected, [
        'src/a.ts',
      ]),
    ).toEqual([])
    expect(
      inlineHelpers.collectReviewerFingerprintDrift(toolResult, expected),
    ).toBe(drifted)
    expect(
      inlineHelpers.collectReviewerAttestationIssues(
        [quotedExampleWithoutFingerprint],
        expected,
        ['src/example.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer returned an invalid attestation schemaVersion',
    ])
  })

  // RF-3-3ed5cbee: the gate's fail-closed attestation authority runs from
  // base2's inline copy, so it needs the same broad parity coverage as the
  // hard-blocker and finding-record mirrors.
  test('the inline base2 collectReviewerAttestationIssues mirror matches the export', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const expected = 'v3:' + 'd'.repeat(64)
    const attesting = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      snapshotFingerprint: expected,
      reviewedFiles: ['src/a.ts', './src/b.ts'],
    }
    const inputs: unknown[] = [
      attesting,
      { type: 'json', value: attesting },
      { ...attesting, snapshotFingerprint: 'v3:' + 'e'.repeat(64) },
      { ...attesting, snapshotFingerprint: 'unreadable:no-crypto' },
      { ...attesting, snapshotFingerprint: undefined },
      { ...attesting, schemaVersion: 2 },
      { ...attesting, reviewedFiles: ['src/a.ts'] },
      { ...attesting, reviewedFiles: ['../outside/a.ts'] },
      // Quoted example receipt trailing the real one (RF-1) and a genuine
      // multi-receipt verdict conflict.
      [attesting, { verdict: 'LOOKS_GOOD', findings: [] as string[] }],
      [attesting, { schemaVersion: 1, verdict: 'BLOCKING', findings: ['x'] }],
      'BLOCKING: plain prose',
      null,
    ]
    const pendingFileSets = [['src/a.ts', 'src/b.ts'], ['src/a.ts'], []]
    for (const input of inputs) {
      for (const pendingFiles of pendingFileSets) {
        expect(
          inlineHelpers.collectReviewerAttestationIssues(
            input,
            expected,
            pendingFiles,
            ['src/b.ts'],
          ),
        ).toEqual(
          collectReviewerAttestationIssues(input, expected, pendingFiles, [
            'src/b.ts',
          ]),
        )
      }
    }
  })

  test('fails closed when a coverage-complete review reports no fingerprint', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'd'.repeat(64),
        ['src/a.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
  })

  test('fails closed when a coverage-complete review reports a non-attestable sentinel fingerprint', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'unreadable:no-crypto',
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'd'.repeat(64),
        ['src/a.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
  })

  test('blocks a coverage gap with an attestable-but-wrong fingerprint on both issues', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          // Attestable (well-formed lowercase hex) but NOT the expected value,
          // so the mismatch branch is what fires rather than the
          // non-attestable branch above.
          snapshotFingerprint: 'v3:' + 'e'.repeat(64),
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'f'.repeat(64),
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer snapshot fingerprint did not match the reviewed working tree',
      'BLOCKING: reviewer did not attest to every pending file: src/b.ts',
    ])
  })

  test('exact-match attestable fingerprint with full coverage yields no issues', () => {
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'a'.repeat(64),
          reviewedFiles: ['src/a.ts', 'src/b.ts'],
        },
        'v3:' + 'a'.repeat(64),
        ['src/a.ts', 'src/b.ts'],
      ),
    ).toEqual([])
  })

  // An empty reviewable subset short-circuits: there is nothing to attest, so
  // NO attestation issues are surfaced even when the reviewer output is
  // missing/empty.
  test('empty reviewable subset yields no attestation issues even with missing reviewer output', () => {
    expect(collectReviewerAttestationIssues(null, 'current', [])).toEqual([])
    expect(
      collectReviewerAttestationIssues(
        { type: 'json', value: [] },
        'current',
        [],
      ),
    ).toEqual([])
  })

  // Guard against over-broadening the short-circuit: a NON-empty pending list
  // with missing structured output must STILL block.
  test('non-empty pending list with missing structured output still blocks', () => {
    expect(
      collectReviewerAttestationIssues(null, 'current', ['src/a.ts']),
    ).toEqual([
      'BLOCKING: reviewer did not return the required structured snapshot attestation',
    ])
  })

  test('deleted pending paths are excluded from missing attestation', () => {
    // Deleted files cannot be read/attested in reviewedFiles; they are
    // attested-by-absence via deletedFiles and must not appear as missing.
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'd'.repeat(64),
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'd'.repeat(64),
        ['src/a.ts', 'src/deleted.ts'],
        ['src/deleted.ts'],
      ),
    ).toEqual([])
    // Path normalization applies to deletedFiles the same as reviewedFiles.
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'e'.repeat(64),
          reviewedFiles: ['./src/a.ts'],
        },
        'v3:' + 'e'.repeat(64),
        ['src/a.ts', 'src/gone.ts'],
        ['./src/gone.ts', 'src\\gone.ts'],
      ),
    ).toEqual([])
    // A non-deleted pending gap still surfaces as missing.
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'f'.repeat(64),
          reviewedFiles: ['src/a.ts'],
        },
        'v3:' + 'f'.repeat(64),
        ['src/a.ts', 'src/b.ts', 'src/deleted.ts'],
        ['src/deleted.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not attest to every pending file: src/b.ts',
    ])
  })

  test('deletions-only pending set still requires an attestable fingerprint', () => {
    // When every pending path is a deletion, missing is empty after exclusion,
    // but credit still requires a well-formed v3 fingerprint (fail closed).
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          reviewedFiles: [],
        },
        'v3:' + 'a'.repeat(64),
        ['src/deleted.ts'],
        ['src/deleted.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'unreadable:no-crypto',
          reviewedFiles: [],
        },
        'v3:' + 'a'.repeat(64),
        ['src/deleted.ts', 'src/also-gone.ts'],
        ['src/deleted.ts', 'src/also-gone.ts'],
      ),
    ).toEqual([
      'BLOCKING: reviewer did not report an attestable snapshot fingerprint',
    ])
    expect(
      collectReviewerAttestationIssues(
        {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'b'.repeat(64),
          reviewedFiles: [],
        },
        'v3:' + 'a'.repeat(64),
        ['src/deleted.ts'],
        ['src/deleted.ts'],
      ),
    ).toEqual([])
  })

  test('getReviewerFinalizationVerdict blocks finalization when coverage is missing', () => {
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'LOOKS_GOOD', coverage: 'missing' }],
      }),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'NON_BLOCKING', coverage: 'missing' }],
      }),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict blocks finalization when requirements are missing or uncertain', () => {
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [
          {
            verdict: 'LOOKS_GOOD',
            coverage: 'covered',
            requirementCoverage: [
              { requirement: 'add export', status: 'missing' },
            ],
          },
        ],
      }),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [
          {
            verdict: 'NON_BLOCKING',
            coverage: 'n/a',
            requirementCoverage: [
              { requirement: 'preserve API', status: 'uncertain' },
            ],
          },
        ],
      }),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict finalizes only LOOKS_GOOD when coverage is covered or n/a', () => {
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'LOOKS_GOOD', coverage: 'covered' }],
      }),
    ).toBe('LOOKS_GOOD')
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [{ verdict: 'NON_BLOCKING', coverage: 'n/a' }],
      }),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict({
        type: 'json',
        value: [
          {
            verdict: 'LOOKS_GOOD',
            coverage: 'covered',
            requirementCoverage: [
              { requirement: 'add export', status: 'satisfied' },
            ],
          },
        ],
      }),
    ).toBe('LOOKS_GOOD')
  })

  test('detectReviewerCrash identifies errorMessage / type:error / json-wrapped crashes and ignores normal results', () => {
    expect(detectReviewerCrash({ errorMessage: '  spawn failed  ' })).toBe(
      'spawn failed',
    )
    expect(detectReviewerCrash({ type: 'error', message: '  boom  ' })).toBe(
      'boom',
    )
    expect(detectReviewerCrash({ type: 'error', message: '' })).toBe(
      'reviewer agent reported an unspecified error',
    )
    expect(
      detectReviewerCrash({
        type: 'json',
        value: [{ nested: { errorMessage: 'inner crash' } }],
      }),
    ).toBe('inner crash')
    // Deeply nested but within the depth cap.
    expect(
      detectReviewerCrash({
        a: { b: { c: { d: { e: { errorMessage: 'deep' } } } } },
      }),
    ).toBe('deep')
    // Normal reviewer outputs (string, structured verdict, null, empty) → null.
    expect(detectReviewerCrash('LOOKS_GOOD: ok')).toBeNull()
    expect(
      detectReviewerCrash({
        type: 'json',
        value: [{ verdict: 'BLOCKING', findings: ['x'] }],
      }),
    ).toBeNull()
    expect(detectReviewerCrash(null)).toBeNull()
    expect(detectReviewerCrash({})).toBeNull()
    expect(detectReviewerCrash({ errorMessage: '   ' })).toBeNull()
  })

  test('isTransientReviewerCrash and classifyReviewerCrash taxonomy', () => {
    expect(isTransientReviewerCrash('rate_limit_error')).toBe(true)
    expect(isTransientReviewerCrash('Concurrency limit exceeded')).toBe(true)
    expect(isTransientReviewerCrash('HTTP 429 Too Many Requests')).toBe(true)
    expect(isTransientReviewerCrash('please retry later')).toBe(true)
    expect(isTransientReviewerCrash('resource_exhausted')).toBe(true)
    expect(isTransientReviewerCrash('provider overloaded')).toBe(true)
    expect(isTransientReviewerCrash('ordinary spawn failed')).toBe(false)
    expect(isTransientReviewerCrash('')).toBe(false)

    expect(classifyReviewerCrash(null)).toBe('none')
    expect(classifyReviewerCrash('')).toBe('none')
    expect(classifyReviewerCrash('   ')).toBe('none')
    expect(classifyReviewerCrash('rate_limit_error')).toBe('transient')
    expect(classifyReviewerCrash('Concurrency limit exceeded')).toBe(
      'transient',
    )
    expect(classifyReviewerCrash('HTTP 429')).toBe('transient')
    expect(
      classifyReviewerCrash('snapshot attestation failed for bare fingerprint'),
    ).toBe('protocol')
    expect(classifyReviewerCrash('non-attestable fingerprint')).toBe('protocol')
    expect(classifyReviewerCrash('ordinary spawn failed')).toBe('fatal')
  })

  // RF-2-c710dee9: the hasBareHex branch. A bare 64-hex run means the reviewer
  // echoed a raw digest instead of the canonical `v3:<64hex>` token, which is a
  // protocol failure rather than a content crash.
  test('classifyReviewerCrash classifies a bare 64-hex run as protocol', () => {
    expect(classifyReviewerCrash('a'.repeat(64))).toBe('protocol')
    expect(
      classifyReviewerCrash('reviewer emitted ' + 'c'.repeat(64) + ' verbatim'),
    ).toBe('protocol')
  })

  // PINNED INTENT (RF-2-c710dee9): a message carrying BOTH a well-formed
  // `v3:<64hex>` token AND a separate bare 64-hex run classifies as 'protocol'.
  // The bare run is the protocol failure; an unrelated valid token in the same
  // message must not suppress it.
  test('classifyReviewerCrash classifies a mixed v3 + bare-hex message as protocol', () => {
    expect(
      classifyReviewerCrash(
        'reviewer reported v3:' +
          'a'.repeat(64) +
          ' but the receipt carried ' +
          'b'.repeat(64),
      ),
    ).toBe('protocol')
  })

  // The `(?:^|[^:])` prefix excludes the v3 token's OWN hex: a message whose
  // only 64-hex run is the `v3:` token (and which carries no other protocol
  // cue) must fall through to 'fatal'.
  test('classifyReviewerCrash does not treat a v3 token as a bare hex run', () => {
    expect(
      classifyReviewerCrash(
        'reviewer process exited while writing v3:' + 'a'.repeat(64),
      ),
    ).toBe('fatal')
  })

  test('detectReviewerCrash respects depth cap to avoid pathological recursion', () => {
    // Build a chain deeper than the cap (8). At depth >8, nested crash is ignored.
    let deep: any = { errorMessage: 'unreachable' }
    for (let i = 0; i < 12; i += 1) deep = { next: deep }
    expect(detectReviewerCrash(deep)).toBeNull()
  })

  // RF-1-f9a386af: the structured walker carries the same depth cap (8) as
  // findReviewerCrash, so an envelope nested past the cap fails closed (empty
  // result / no finalization credit) instead of blowing the stack.
  test('visitForStructuredVerdict respects the depth cap for over-nested structured verdicts', () => {
    let deepStructured: any = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      findings: [] as string[],
      coverage: 'covered',
    }
    for (let i = 0; i < 12; i += 1) deepStructured = { nested: deepStructured }
    expect(getReviewerFinalizationVerdict(deepStructured)).toBe('')
    expect(collectReviewerBlockers(deepStructured)).toEqual([])
    expect(collectReviewerHardBlockers(deepStructured)).toEqual([])
    expect(collectReviewerFindingRecords(deepStructured)).toEqual([])
  })

  // Same cap on the text walker: a blocker string nested past the cap is
  // dropped rather than overflowing the stack.
  test('collectStrings respects the depth cap for over-nested reviewer text', () => {
    let deepText: any = 'BLOCKING: unreachable text verdict'
    for (let i = 0; i < 30; i += 1) deepText = { nested: [deepText] }
    expect(collectReviewerBlockers(deepText)).toEqual([])
  })

  // A self-referential envelope (a child pointing back at its parent) must
  // terminate in BOTH walkers instead of throwing RangeError.
  test('both reviewer walkers terminate on a self-referential envelope', () => {
    const cyclicText: any = { note: 'BLOCKING: cyclic path' }
    cyclicText.self = cyclicText
    // Structured walk finds nothing, so the text walk decides; repeated visits
    // are collapsed by the exact-string de-dupe.
    expect(collectReviewerBlockers(cyclicText)).toEqual([
      'BLOCKING: cyclic path',
    ])
    expect(getReviewerFinalizationVerdict(cyclicText)).toBe('')

    const cyclicStructured: any = {
      wrapper: {
        schemaVersion: 1,
        verdict: 'BLOCKING',
        findings: ['cyclic finding'],
        coverage: 'covered',
      },
    }
    cyclicStructured.wrapper.parent = cyclicStructured
    expect(collectReviewerBlockers(cyclicStructured)).toEqual([
      'BLOCKING: cyclic finding',
    ])
    expect(getReviewerFinalizationVerdict(cyclicStructured)).toBe('')
  })

  test('exported helpers match inline base2 mirror behavior', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()

    const preambleInputs = [
      '  <think>first</think>\nLOOKS_GOOD: ok  ',
      '<think>first</think>\n<think data-x="1">second</think>\nNON_BLOCKING: ok',
      '<think>unterminated\nLOOKS_GOOD',
      'BLOCKING: no preamble',
      '   ',
    ]
    for (const input of preambleInputs) {
      expect(inlineHelpers.stripReviewerPreamble(input)).toBe(
        stripReviewerPreamble(input),
      )
    }

    const toolResults: unknown[] = [
      'BLOCKING: plain blocker',
      '<think>analysis</think>\nLOOKS_GOOD: plain approval',
      'Reviewer gate passed with LOOKS_GOOD',
      'Reviewer gate passed (NON_BLOCKING)',
      [
        {
          type: 'json',
          value: [{ verdict: 'BLOCKING', findings: ['Fix structured'] }],
        },
      ],
      {
        nested: {
          type: 'json',
          value: [{ verdict: 'NON_BLOCKING', findings: 'nit' }],
        },
      },
      {
        nested: [
          'This sentence mentions BLOCKING but is not a line verdict.',
          '  blocking details are case-insensitive',
        ],
      },
      [{ type: 'json', value: [{ verdict: 'BLOCKING' }] }],
      {
        type: 'json',
        value: [{ verdict: 'NON_BLOCKING', coverage: 'missing' }],
      },
      {
        type: 'json',
        value: [{ verdict: 'LOOKS_GOOD', coverage: 'covered' }],
      },
      // RF-1-ac880186: parent-owned process requirementCoverage must match between
      // gate-reviewer.ts and the base2 inline mirror (no RF elevation).
      {
        type: 'json',
        value: [
          {
            verdict: 'LOOKS_GOOD',
            findings: [],
            coverage: 'covered',
            dimensions: {
              correctness: 'pass',
              security: 'pass',
              tests: 'pass',
              apiCompatibility: 'pass',
              performance: 'pass',
            },
            requirementCoverage: [
              { requirement: 'Rewrite git commit messages', status: 'missing' },
              { requirement: 'Run full validation gate', status: 'uncertain' },
              { requirement: 'Commit and push', status: 'missing' },
              { requirement: 'Confirm CI/CD is green', status: 'uncertain' },
            ],
          },
        ],
      },
      // Mixed: parent-owned rows ignored; in-scope gap still blocks both copies.
      {
        type: 'json',
        value: [
          {
            verdict: 'LOOKS_GOOD',
            findings: [],
            coverage: 'covered',
            dimensions: {
              correctness: 'pass',
              security: 'pass',
              tests: 'pass',
              apiCompatibility: 'pass',
              performance: 'pass',
            },
            requirementCoverage: [
              { requirement: 'Rewrite git commit messages', status: 'missing' },
              { requirement: 'preserve CLI compatibility', status: 'missing' },
            ],
          },
        ],
      },
      // RF-1-dd326e16: an empty-findings NON_BLOCKING receipt whose only gap is
      // parent-owned must keep the synthetic placeholder in BOTH copies.
      {
        type: 'json',
        value: [
          {
            verdict: 'NON_BLOCKING',
            findings: [],
            coverage: 'covered',
            requirementCoverage: [
              { requirement: 'Commit and push', status: 'missing' },
            ],
          },
        ],
      },
      null,
    ]

    const crashResults: unknown[] = [
      { errorMessage: 'spawn failed' },
      { type: 'error', message: 'boom' },
      { type: 'error', message: '' },
      { type: 'json', value: [{ nested: { errorMessage: 'inner crash' } }] },
      'LOOKS_GOOD: ok',
      { type: 'json', value: [{ verdict: 'BLOCKING', findings: ['x'] }] },
      null,
      {},
      { errorMessage: '   ' },
    ]

    for (const toolResult of [...toolResults, ...crashResults]) {
      expect(inlineHelpers.collectReviewerBlockers(toolResult)).toEqual(
        collectReviewerBlockers(toolResult),
      )
      expect(inlineHelpers.getReviewerFinalizationVerdict(toolResult)).toBe(
        getReviewerFinalizationVerdict(toolResult),
      )
      expect(inlineHelpers.detectReviewerCrash(toolResult)).toBe(
        detectReviewerCrash(toolResult),
      )
    }
  })

  // Automated gates require actual structured output objects. JSON-looking
  // prose remains untrusted text and must not authorize finalization.
  test('getReviewerFinalizationVerdict rejects prose containing JSON LOOKS_GOOD', () => {
    expect(
      getReviewerFinalizationVerdict(
        'I now have full context. Having reviewed all edits I see no blockers.\n{"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict rejects prose containing JSON NON_BLOCKING', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble prose explaining minor suggestions follow.\n{"verdict":"NON_BLOCKING","findings":["nit"],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict still blocks when embedded JSON verdict has coverage missing', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble prose before a verdict with missing coverage.\n{"verdict":"LOOKS_GOOD","findings":[],"coverage":"missing"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict still blocks when embedded JSON verdict is BLOCKING', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble prose before a BLOCKING verdict.\n{"verdict":"BLOCKING","findings":["Fix A"],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict rejects multiple embedded prose verdicts', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Earlier I thought this was off: {"verdict":"BLOCKING","findings":["x"],"coverage":"covered"}. After re-checking it passes. {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict does not false-positive on prose mentioning LOOKS_GOOD with no JSON object', () => {
    // Plain prose never authorizes the automated gate.
    expect(
      getReviewerFinalizationVerdict(
        'I think this LOOKS_GOOD in spirit but I have not emitted a verdict line.',
      ),
    ).toBe('')
    expect(
      getReviewerFinalizationVerdict(
        'LOOKS_GOOD: handled by existing line-verdict path',
      ),
    ).toBe('')
  })

  test('inline base2 mirror recognizes prose preamble followed by JSON verdict (parity)', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const proseJsonInputs: unknown[] = [
      'I now have full context. Having reviewed all edits I see no blockers.\n{"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      'Preamble prose explaining minor suggestions follow.\n{"verdict":"NON_BLOCKING","findings":["nit"],"coverage":"covered"}',
      'Preamble prose before a verdict with missing coverage.\n{"verdict":"LOOKS_GOOD","findings":[],"coverage":"missing"}',
      'Preamble prose before a BLOCKING verdict.\n{"verdict":"BLOCKING","findings":["Fix A"],"coverage":"covered"}',
      'Earlier I thought this was off: {"verdict":"BLOCKING","findings":["x"],"coverage":"covered"}. After re-checking it passes. {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      'I think this LOOKS_GOOD in spirit but I have not emitted a verdict line.',
      // Prose-embedded JSON is not schema-backed structured output; finalization
      // accepts only structured objects, so these all reject (parity both copies).
      'Preamble. {"verdict":"LOOKS_GOOD","note":"see {foo} for context","coverage":"covered"}',
      'Preamble. {"verdict":"LOOKS_GOOD","findings":["has \\"q\\" inside"],"coverage":"covered"}',
      'Preamble. {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"',
      'First pass: {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}. Second: {"verdict":"NON_BLOCKING","findings":["x"],"coverage":"covered"}. Final: {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      'Preamble. {"verdict":"MAYBE","findings":[],"coverage":"covered"}',
    ]
    for (const toolResult of proseJsonInputs) {
      expect(inlineHelpers.getReviewerFinalizationVerdict(toolResult)).toBe(
        getReviewerFinalizationVerdict(toolResult),
      )
    }
  })

  // Exported finalization only accepts structured objects; prose-embedded
  // JSON (even well-formed) is not credited as a gate verdict.
  test('getReviewerFinalizationVerdict rejects JSON embedded in prose even with braces in strings', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble. {"verdict":"LOOKS_GOOD","note":"see {foo} for context","coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict rejects prose JSON with escaped quotes', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble. {"verdict":"LOOKS_GOOD","findings":["has \\"q\\" inside"],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict returns empty when embedded JSON is truncated (no closing brace)', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble. {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict rejects three embedded objects in prose', () => {
    expect(
      getReviewerFinalizationVerdict(
        'First pass: {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}. Second: {"verdict":"NON_BLOCKING","findings":["x"],"coverage":"covered"}. Final: {"verdict":"LOOKS_GOOD","findings":[],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('getReviewerFinalizationVerdict rejects embedded JSON with an unknown verdict value', () => {
    expect(
      getReviewerFinalizationVerdict(
        'Preamble. {"verdict":"MAYBE","findings":[],"coverage":"covered"}',
      ),
    ).toBe('')
  })

  test('isTestCoverageReviewerFinding keys on the test-coverage bigram or coverage plus a .test.* token', () => {
    // The synthetic coverage blocker from collectReviewerBlockers must classify
    // as coverage so the all-coverage set routes exclusively to test-writer.
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      ),
    ).toBe(true)
    expect(isTestCoverageReviewerFinding('test coverage is insufficient')).toBe(
      true,
    )
    expect(isTestCoverageReviewerFinding('TEST COVERAGE missing')).toBe(true)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: coverage gap: add a case to src/foo.test.ts for the new behavior',
      ),
    ).toBe(true)
    expect(
      isTestCoverageReviewerFinding('coverage missing; extend widget.test.tsx'),
    ).toBe(true)
  })

  test('isTestCoverageReviewerFinding stays conservative for generic test/coverage mentions', () => {
    // Generic requirements mentioning test(s)/tested or bare coverage must
    // keep routing to repair-editor (status quo).
    expect(
      isTestCoverageReviewerFinding('BLOCKING: add tests for the parser'),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding('BLOCKING: this path is not tested'),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: coverage of edge cases is unclear',
      ),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: update foo.test.ts to match the new API',
      ),
    ).toBe(false)
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: fix the null dereference in parse()',
      ),
    ).toBe(false)
    expect(isTestCoverageReviewerFinding('')).toBe(false)
  })

  test('isTestCoverageReviewerFinding rejects non-string inputs', () => {
    expect(isTestCoverageReviewerFinding(undefined as unknown as string)).toBe(
      false,
    )
    expect(isTestCoverageReviewerFinding(null as unknown as string)).toBe(false)
    expect(isTestCoverageReviewerFinding(42 as unknown as string)).toBe(false)
    expect(isTestCoverageReviewerFinding({} as unknown as string)).toBe(false)
  })
})

// T0.1: gate-derived hard rules are the non-condonable subset of the blocker
// strings. base2's condone filter exempts them via exact Set.has membership
// against collectReviewerBlockers output, so byte identity is load-bearing.
describe('collectReviewerHardBlockers', () => {
  const HARD_RULE_INPUTS: unknown[] = [
    { verdict: 'NON_BLOCKING', findings: ['nit'], coverage: 'missing' },
    {
      verdict: 'LOOKS_GOOD',
      findings: [],
      coverage: 'covered',
      dimensions: { correctness: 'pass', security: 'block', tests: 'BLOCK' },
    },
    {
      verdict: 'NON_BLOCKING',
      findings: ['unrelated prose'],
      coverage: 'covered',
      requirementCoverage: [
        { requirement: 'add the export', status: 'missing' },
        { requirement: 'preserve CLI compatibility', status: 'uncertain' },
        { requirement: 'add tests', status: 'satisfied' },
      ],
    },
    {
      verdict: 'BLOCKING',
      findings: ['Fix A'],
      coverage: 'missing',
      dimensions: { security: 'block' },
      requirementCoverage: [
        { requirement: 'wire selfMutatedPaths', status: 'missing' },
      ],
    },
    { verdict: 'LOOKS_GOOD', findings: [], coverage: 'covered' },
    { verdict: 'NON_BLOCKING', findings: ['only prose'], coverage: 'covered' },
    { verdict: 'NON_BLOCKING', findings: [], coverage: 'covered' },
  ]

  test('returns the coverage-missing hard rule for coverage: missing', () => {
    expect(
      collectReviewerHardBlockers({
        verdict: 'NON_BLOCKING',
        findings: ['nit'],
        coverage: 'missing',
      }),
    ).toEqual([
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
    ])
  })

  test('returns one hard rule per blocked review dimension', () => {
    expect(
      collectReviewerHardBlockers({
        verdict: 'LOOKS_GOOD',
        findings: [],
        coverage: 'covered',
        dimensions: {
          correctness: 'pass',
          security: 'block',
          tests: 'BLOCK',
        },
      }),
    ).toEqual([
      'BLOCKING: security review dimension failed',
      'BLOCKING: tests review dimension failed',
    ])
  })

  test('returns one hard rule per missing/uncertain requirement', () => {
    expect(
      collectReviewerHardBlockers({
        verdict: 'NON_BLOCKING',
        findings: ['unrelated prose'],
        coverage: 'covered',
        requirementCoverage: [
          { requirement: 'add the export', status: 'missing' },
          { requirement: 'preserve CLI compatibility', status: 'uncertain' },
          { requirement: 'add tests', status: 'satisfied' },
        ],
      }),
    ).toEqual([
      'BLOCKING: requirement missing: add the export',
      'BLOCKING: requirement uncertain: preserve CLI compatibility',
    ])
  })

  test('returns nothing for a clean LOOKS_GOOD result or prose-only findings', () => {
    expect(
      collectReviewerHardBlockers({
        verdict: 'LOOKS_GOOD',
        findings: [],
        coverage: 'covered',
        dimensions: { correctness: 'pass' },
        requirementCoverage: [
          { requirement: 'add tests', status: 'satisfied' },
        ],
      }),
    ).toEqual([])
    // NON_BLOCKING prose findings and the synthetic empty-findings placeholder
    // are condonable reviewer prose, never hard rules.
    expect(
      collectReviewerHardBlockers({
        verdict: 'NON_BLOCKING',
        findings: ['minor naming nit', 'style tweak'],
        coverage: 'covered',
      }),
    ).toEqual([])
    expect(
      collectReviewerHardBlockers({
        verdict: 'NON_BLOCKING',
        findings: [],
        coverage: 'covered',
      }),
    ).toEqual([])
    // BLOCKING prose findings are also excluded.
    expect(
      collectReviewerHardBlockers({
        verdict: 'BLOCKING',
        findings: ['Fix A'],
        coverage: 'covered',
      }),
    ).toEqual([])
    expect(collectReviewerHardBlockers(null)).toEqual([])
    expect(collectReviewerHardBlockers('BLOCKING: plain text')).toEqual([])
  })

  // RF-1: the reviewer contract's prevailing style is "<word>: <clause>", so a
  // blocking dimension arrives as `block: <clause>`. Both collectors must emit
  // the byte-identical hard rule for it, and finalization must refuse credit.
  test('treats a "block: <clause>" dimension as failing in both collectors', () => {
    const clauseStyleReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      dimensions: { security: 'block: fails closed?' },
    }
    expect(collectReviewerHardBlockers(clauseStyleReceipt)).toEqual([
      'BLOCKING: security review dimension failed',
    ])
    expect(collectReviewerBlockers(clauseStyleReceipt)).toEqual([
      'BLOCKING: security review dimension failed',
    ])
    // A failing dimension must not ride along with a LOOKS_GOOD receipt.
    expect(getReviewerFinalizationVerdict(clauseStyleReceipt)).toBe('')
  })

  test('keeps "blocked" and "pass: <clause>" dimension values non-failing', () => {
    const passingReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD' as const,
      findings: [] as string[],
      coverage: 'covered' as const,
      dimensions: {
        security: 'pass: no auth gaps',
        // `blocked` is a different word: the prefix test is word-bounded.
        tests: 'blocked',
        docs: 'minor: tighten wording',
      },
    }
    expect(collectReviewerHardBlockers(passingReceipt)).toEqual([])
    expect(collectReviewerBlockers(passingReceipt)).toEqual([])
    expect(getReviewerFinalizationVerdict(passingReceipt)).toBe('LOOKS_GOOD')
    // Padded / upper-case `BLOCK` still fails: trim + lowercase first.
    const paddedReceipt = {
      ...passingReceipt,
      dimensions: { security: '  BLOCK: unauthenticated endpoint  ' },
    }
    expect(collectReviewerHardBlockers(paddedReceipt)).toEqual([
      'BLOCKING: security review dimension failed',
    ])
    expect(collectReviewerBlockers(paddedReceipt)).toEqual([
      'BLOCKING: security review dimension failed',
    ])
    expect(getReviewerFinalizationVerdict(paddedReceipt)).toBe('')
    // RF-1-ac6c3ba2: `\b` never matched between `block` and `i`/`e`, so these
    // plausible reviewer phrasings were silently treated as passing dimensions
    // and could finalize LOOKS_GOOD. The plural verb form `blocks` is covered
    // for the same reason: it is a verdict, unlike the state word `blocked`.
    for (const status of [
      'blocking: fails open on parse error',
      'blocker: fails open on parse error',
      'blockers: two unguarded paths',
      'blocks: fails open on parse error',
      'blocks finalization: missing auth',
      '  BLOCKING: unauthenticated endpoint  ',
      'blocking',
      'blocks',
    ]) {
      const failingReceipt = {
        ...passingReceipt,
        dimensions: { security: status },
      }
      expect(collectReviewerHardBlockers(failingReceipt)).toEqual([
        'BLOCKING: security review dimension failed',
      ])
      expect(collectReviewerBlockers(failingReceipt)).toEqual([
        'BLOCKING: security review dimension failed',
      ])
      expect(getReviewerFinalizationVerdict(failingReceipt)).toBe('')
    }
    // `blocked` stays a different word even when it carries a clause.
    const blockedClauseReceipt = {
      ...passingReceipt,
      dimensions: { tests: 'blocked: waiting on an upstream fixture' },
    }
    expect(collectReviewerHardBlockers(blockedClauseReceipt)).toEqual([])
    expect(collectReviewerBlockers(blockedClauseReceipt)).toEqual([])
    expect(getReviewerFinalizationVerdict(blockedClauseReceipt)).toBe(
      'LOOKS_GOOD',
    )
  })

  // Byte-identity contract: base2 exempts hard rules from condoning with
  // `hardBlockers.has(blocker)` over strings produced by collectReviewerBlockers.
  // If either template literal drifts by a single character the exemption
  // silently stops working, so this parity assertion is required.
  test('every hard-rule string is byte-identical to a collectReviewerBlockers string', () => {
    for (const input of HARD_RULE_INPUTS) {
      const blockers = collectReviewerBlockers(input)
      for (const hardBlocker of collectReviewerHardBlockers(input)) {
        expect(blockers).toContain(hardBlocker)
      }
    }
    // Nested spawn/set_output wrappers walk the same way and stay de-duped.
    const nested = {
      type: 'json',
      value: [HARD_RULE_INPUTS[3], HARD_RULE_INPUTS[3]],
    }
    const nestedHardBlockers = collectReviewerHardBlockers(nested)
    expect(nestedHardBlockers).toEqual([
      'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      'BLOCKING: security review dimension failed',
      'BLOCKING: requirement missing: wire selfMutatedPaths',
    ])
    for (const hardBlocker of nestedHardBlockers) {
      expect(collectReviewerBlockers(nested)).toContain(hardBlocker)
    }
  })

  // base2 carries its OWN collectReviewerHardBlockers copy and the condone
  // filter consults THAT copy at runtime, so the inline mirror must stay
  // equivalent to the export over every hard-rule shape.
  test('the inline base2 collectReviewerHardBlockers mirror matches the export', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const inputs: unknown[] = [
      ...HARD_RULE_INPUTS,
      // Nested spawn/set_output wrappers and non-structured results.
      { type: 'json', value: [HARD_RULE_INPUTS[3], HARD_RULE_INPUTS[3]] },
      { nested: { type: 'json', value: HARD_RULE_INPUTS[2] } },
      'BLOCKING: plain text',
      null,
    ]
    for (const input of inputs) {
      expect(inlineHelpers.collectReviewerHardBlockers(input)).toEqual(
        collectReviewerHardBlockers(input),
      )
    }
  })

  // RF-3-98832529: the gate correlates findings through base2's OWN
  // collectReviewerFindingRecords copy, so the first-record-per-id de-dupe must
  // hold there too (a mirror that kept the LAST record would correlate the
  // wrong text back to the reviewer's finding).
  test('the inline base2 collectReviewerFindingRecords mirror matches the export', () => {
    const inlineHelpers = loadInlineGateReviewerHelpers()
    const firstReceipt = {
      schemaVersion: 1,
      verdict: 'BLOCKING' as const,
      coverage: 'covered' as const,
      findings: [
        {
          id: 'code-reviewer:correctness:dup',
          severity: 'high',
          dimension: 'correctness',
          summary: 'first occurrence text',
          evidence: ['first evidence'],
          correction: 'fix it once',
        },
      ],
    }
    // A set_output-style duplicate of the same finding id carrying different text.
    const duplicateReceipt = {
      ...firstReceipt,
      findings: [
        {
          ...firstReceipt.findings[0]!,
          summary: 'second occurrence text',
          evidence: ['second evidence'],
        },
      ],
    }
    const duplicateIdReceipt = {
      type: 'json',
      value: [
        // Nested spawn wrapper around the first occurrence.
        { type: 'json', value: firstReceipt },
        duplicateReceipt,
      ],
    }
    const records = collectReviewerFindingRecords(duplicateIdReceipt)
    // Exactly one record for the duplicated id, keeping the FIRST text.
    expect(records).toEqual([
      {
        id: 'code-reviewer:correctness:dup',
        text: 'first occurrence text',
        severity: 'high',
        dimension: 'correctness',
        evidence: ['first evidence'],
        correction: 'fix it once',
      },
    ])
    for (const input of [
      duplicateIdReceipt,
      firstReceipt,
      { nested: duplicateIdReceipt },
      'BLOCKING: plain text',
      null,
    ]) {
      expect(inlineHelpers.collectReviewerFindingRecords(input)).toEqual(
        collectReviewerFindingRecords(input),
      )
    }
  })
})
