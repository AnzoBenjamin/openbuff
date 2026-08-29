import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'

import { GUIDE_POINTERS, type GuidePath } from '../base2/base2'
import { preReviewSelfCheckSection } from '../base2/quality-prompt-section'
import reviewerDefinition from '../reviewer/code-reviewer'
import { describeRepoFileExistence, resolveRepoPath } from './guide-test-utils'

import type { JsonSchema } from '../types/util-types'

/**
 * Parity guard: every mechanically-blocking rule the automated reviewer gate
 * enforces must also be taught to implementation agents through
 * `preReviewSelfCheckSection` (and its `agents/guides/pre-review-self-check.md`
 * mirror). Adding a blocking rule to the reviewer without teaching implementers
 * fails here.
 *
 * The reviewer side is asserted against the imported reviewer definition's
 * `outputSchema` rather than a text read of `agents/reviewer/code-reviewer.ts`:
 * a renamed or removed schema field is then a lookup miss (and a renamed
 * export a type error), and reformatting the reviewer source — a printWidth
 * change, a property broken across lines, a quote-style flip — cannot fail the
 * guard without real semantic drift.
 *
 * The reviewer uses camelCase schema field names while the rubric is human
 * prose, so each schema path maps to a verbatim rubric excerpt and matching is
 * case-insensitive. The excerpts are bullet labels rather than bare topic
 * words: a bare word like `security` is a substring of almost any rubric prose,
 * so deleting the bullet that teaches the rule would not fail the check.
 */
const REVIEWER_SOURCE = 'agents/reviewer/code-reviewer.ts'

/**
 * Resolve a node inside the reviewer output schema by a dotted path. Each
 * segment is a `properties` key, except the literal `items` segment, which
 * steps into an array's item schema. Returns undefined when any hop is
 * missing or is not an object schema, so a renamed field fails the lookup
 * instead of silently making the parity check vacuous.
 */
function resolveSchemaNode(
  root: JsonSchema | undefined,
  path: string,
): JsonSchema | undefined {
  let current = root
  for (const segment of path.split('.')) {
    const next: unknown =
      segment === 'items' ? current?.items : current?.properties?.[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      return undefined
    }
    current = next as JsonSchema
  }
  return current
}

// reviewer schema path -> verbatim rubric excerpt that teaches it, plus the
// exact enum the field must still declare when the blocking behaviour lives in
// the enum rather than in the field's presence. This table covers every
// mechanically-blocking field of the reviewer receipt: `requirementCoverage`
// (and its blocking `missing`/`uncertain` statuses), `reviewedFiles`, the five
// `dimensions`, `coverage` (where `missing` blocks), and `verdict` (whose
// `BLOCKING` value is the gate's own signal). `coverage` and `dimensions.tests`
// share one rubric bullet on purpose — the merged `Test coverage (blocking)`
// bullet is the single owner of the coverage-naming rule. Every rubric excerpt
// is a bullet label except `correctness`, which the rubric teaches through its
// dimension enumeration rather than a dedicated bullet, and the `uncertain`
// status, whose rule lives in a clause of the requirement-coverage bullet.
const REVIEWER_SCHEMA_RULES: Array<
  [schemaPath: string, rubricExcerpt: string, enumValues?: readonly string[]]
> = [
  ['requirementCoverage', '**Requirement coverage (blocking):**'],
  [
    'requirementCoverage.items.status',
    '`uncertain` blocks exactly like `missing`',
    ['satisfied', 'missing', 'uncertain'],
  ],
  ['reviewedFiles', '**File attestation:**'],
  [
    'dimensions.correctness',
    'scores correctness, security, tests, apiCompatibility, and performance',
  ],
  ['dimensions.security', '**Security pass:**'],
  ['dimensions.tests', '**Test coverage (blocking):**'],
  ['dimensions.apiCompatibility', '**Compatibility:**'],
  ['dimensions.performance', '**Resource safety:**'],
  ['coverage', '**Test coverage (blocking):**', ['covered', 'missing', 'n/a']],
  [
    'verdict',
    '**Advisory vs blocking:**',
    ['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING'],
  ],
]

describe('review rubric parity — reviewer gate rules reach implementers', () => {
  test('every blocking reviewer schema field has a corresponding rubric concept', () => {
    const { outputSchema } = reviewerDefinition
    const rubric = preReviewSelfCheckSection.toLowerCase()

    for (const [
      schemaPath,
      rubricExcerpt,
      enumValues,
    ] of REVIEWER_SCHEMA_RULES) {
      // Assert the reviewer still declares the field instead of skipping: a
      // renamed schema field (requirementCoverage -> requirements) must fail
      // here rather than silently making the parity check vacuous. Labelled so
      // the failure names the missing path instead of printing `undefined`.
      const node = resolveSchemaNode(outputSchema, schemaPath)
      expect(
        node
          ? 'declared'
          : `${REVIEWER_SOURCE} outputSchema no longer declares ${schemaPath}`,
      ).toBe('declared')
      if (enumValues) {
        // Exact-set comparison rather than containment: a NEW enum value (a
        // fourth requirement status, a fourth coverage marker) changes what
        // blocks, so it must be taught to implementers too.
        const declared = node?.enum ?? []
        const enumMatches =
          declared.length === enumValues.length &&
          enumValues.every((value) => declared.includes(value))
        expect(
          enumMatches
            ? 'declared'
            : `${REVIEWER_SOURCE} ${schemaPath}.enum is [${declared.join(', ')}], expected exactly [${enumValues.join(', ')}]`,
        ).toBe('declared')
      }
      expect(rubric).toContain(rubricExcerpt.toLowerCase())
    }
  })

  test('the requirement-coverage and test-coverage rules stay marked blocking', () => {
    // Pinned to the two bullet labels rather than a bare `(blocking)` count: a
    // count would still pass if both markers migrated onto unrelated bullets.
    expect(preReviewSelfCheckSection).toContain(
      '**Requirement coverage (blocking):**',
    )
    expect(preReviewSelfCheckSection).toContain('**Test coverage (blocking):**')
    // The merged `Test coverage (blocking)` bullet is now the single owner of
    // the coverage-naming rule, so the superseded duplicate bullet must not
    // come back alongside it.
    expect(preReviewSelfCheckSection).not.toContain('**Coverage naming')
  })
})

/**
 * Guide/constant drift guard: every guide with a `GUIDE_POINTERS` row
 * duplicates the exported prompt section that progressive prompt disclosure
 * relocates into it. Editing a section without updating its guide (or the
 * reverse) would silently serve stale guidance to any agent that follows the
 * pointer. This check owns both existence and content parity for every guide
 * with a `GUIDE_POINTERS` row, replacing the weaker keyword-per-file table that
 * used to live in `base2-progressive-disclosure.test.ts`.
 *
 * Normalization: drop the leading markdown H1 heading from both sides (each
 * guide repeats its section's heading), collapse every whitespace run to a
 * single space, then trim — which absorbs the guides' trailing newline and any
 * markdown re-wrapping. Escaped backticks in the TypeScript template literals
 * are plain backticks in the exported string value, so the two sides compare
 * directly. The two sides are normalized independently, so a section that keeps
 * an H2 heading (the broad-audit prompt subsection) still compares correctly:
 * its drift check runs against an excerpt that starts after the heading.
 */
function normalizeMarkdown(text: string): string {
  return text
    .replace(/^#\s[^\n]*\n/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Guide-specific drift metadata, keyed by the workspace-relative guide path in
 * `GUIDE_POINTERS`. The guide/section/pointer wiring itself is owned by that
 * exported table in base2.ts, so this test derives the file list instead of
 * duplicating it.
 */
type GuideDriftOverride = {
  /**
   * Set only when the guide is intentionally not a verbatim copy of the whole
   * section; the drift check then covers the contiguous excerpt running from
   * `from` through the end of `to` instead of the full section body.
   */
  excerpt?: { from: string; to: string }
  /**
   * Guide-only tail content that must survive. Excerpt comparison stops at
   * `excerpt.to`, so anything after it is otherwise unguarded and could be
   * deleted without failing this check.
   */
  tailContains?: string[]
}

/**
 * Keyed by `GuidePath` so a renamed or unknown guide path is a compile error
 * instead of a runtime "override matches no GUIDE_POINTERS entry" assertion —
 * the same compile-time-over-runtime argument the `GUIDE_POINTER_TABLE`
 * comment in base2.ts makes.
 */
const GUIDE_DRIFT_OVERRIDES: Partial<Record<GuidePath, GuideDriftOverride>> = {
  'agents/guides/specialist-routing.md': {
    // specialist-routing.md is a reordered superset rather than a copy: the
    // section leads with its "Gate vs Specialists — ownership matrix" table
    // before the routing list, while the guide leads with the routing list and
    // carries its own expanded ownership/params tables plus deterministic
    // router-trigger sections the section does not contain. Full containment
    // therefore cannot hold. The excerpt below still pins the routing intro,
    // all seven routing bullets, and the evidence paragraph verbatim.
    excerpt: {
      from: 'Use specialists when repository evidence',
      to: 'the final code-reviewer gate.',
    },
    // Anchors for content the excerpt window does not cover, so a deleted
    // section fails here instead of passing on the excerpt alone. These are
    // NOT all guide-only headings: several (`## Gate vs Specialists`,
    // `## Params Contract`, `## Compaction recovery`,
    // `## Sequential vs parallel`) also exist in `specialistRoutingSection`
    // but sit outside the excerpt bounds, while others (the deterministic
    // router-trigger sections) are genuinely guide-only. Keep both kinds: one
    // anchor per uncovered H2/H3 heading plus a distinctive line from the
    // sections whose body carries the substance (the deterministic router
    // table, the ownership matrix, and the params contract).
    tailContains: [
      '## Deterministic routing triggers',
      'computed by `selectSpecialistReviewers`',
      '### Why a specialist may not spawn',
      '## Gate vs Specialists',
      'Ownership and timing — Final Gate always runs last',
      '## Params Contract',
      '`params.snapshot_id` = `v3:<64-hex>` (opaque gate token)',
      '## Example spawns',
      '## Compaction recovery',
      '## Sequential vs parallel',
    ],
  },
  'agents/guides/broad-audit.md': {
    // The builder is parameterized on the finalize clause, and the guide
    // documents the implementation variant plus a trailing plan-mode note the
    // section does not contain, so full containment cannot hold. The excerpt
    // still pins the scope-then-shard intro paragraph, all four steps, and the
    // closing sharding mandate verbatim against the implementation variant.
    excerpt: {
      from: 'For broad, open-ended',
      to: 'not a single codesearch.',
    },
    // The plan-mode note trails the excerpt window; pin it so it cannot be
    // dropped silently.
    tailContains: [
      'In plan mode, do not implement — translate the findings into the durable plan packet instead.',
    ],
  },
}

/**
 * Guides under `agents/guides/` that intentionally have no `GUIDE_POINTERS`
 * row, and therefore no exported prompt section to mirror. Listed explicitly so
 * a NEW guide file cannot land without a drift owner: the reverse-direction
 * sweep below fails until it is either pointed at from base2 or added here.
 */
type DriftExemptGuide =
  | 'agents/guides/editor-writers-and-repair.md'
  | 'agents/guides/knowledge-files.md'

const DRIFT_EXEMPT_GUIDES = new Set<DriftExemptGuide>([
  // Spawn-contract documentation referenced from specialist-routing.md; it
  // documents agent relationships rather than duplicating a prompt section.
  'agents/guides/editor-writers-and-repair.md',
  // Knowledge-file conventions; the runtime injects knowledge files directly,
  // so no exported prompt-section constant mirrors this guide.
  'agents/guides/knowledge-files.md',
])

/**
 * Membership check for the directory-read guide names, which are plain strings.
 * The set itself stays keyed by the `DriftExemptGuide` literal union — the same
 * compile-time-over-runtime argument `GUIDE_DRIFT_OVERRIDES` makes with
 * `Partial<Record<GuidePath, ...>>` — so a typo'd exemption is a compile error
 * instead of only a runtime "exempt but missing" message.
 */
function isDriftExemptGuide(guide: string): guide is DriftExemptGuide {
  return (DRIFT_EXEMPT_GUIDES as ReadonlySet<string>).has(guide)
}

describe('guide/constant drift — relocated guides mirror their sections', () => {
  test('every agents/guides markdown file has a drift owner', () => {
    // Reverse direction of the mirror check below: without this, a new guide
    // (or an existing unreferenced one) could sit under agents/guides/ with
    // nothing asserting it stays in sync with anything.
    // Recursive so a guide added under `agents/guides/<subdir>/` still needs a
    // drift owner — a non-recursive read would leave exactly the hole this
    // sweep exists to close. Separators are normalized to `/` because the
    // GUIDE_POINTERS paths are workspace-relative POSIX paths.
    const guidesDir = resolveRepoPath('agents/guides')
    const guideFiles = readdirSync(guidesDir, {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((name) => name.endsWith('.md'))
      .map((name) => `agents/guides/${name.split(path.sep).join('/')}`)
    // Guard against a bad directory read making the sweep vacuous.
    expect(guideFiles.length).toBeGreaterThanOrEqual(GUIDE_POINTERS.length)
    const pointedGuides = new Set<string>(
      GUIDE_POINTERS.map((entry) => entry.guide),
    )
    for (const guide of guideFiles) {
      expect(
        pointedGuides.has(guide) || isDriftExemptGuide(guide)
          ? 'owned'
          : `${guide} has no GUIDE_POINTERS row and is not in DRIFT_EXEMPT_GUIDES`,
      ).toBe('owned')
    }
    // A stale exemption (guide deleted, or later given a pointer) must fail too,
    // so the exempt list cannot silently accumulate dead entries.
    for (const exempt of DRIFT_EXEMPT_GUIDES) {
      expect(
        guideFiles.includes(exempt) && !pointedGuides.has(exempt)
          ? 'exempt'
          : `${exempt} is exempt but is missing or now has a GUIDE_POINTERS row`,
      ).toBe('exempt')
    }
  })

  test('every relocated guide carries its exported section content', () => {
    // Numeric vacuity guard only: an emptied table must not make the whole
    // drift check pass by iterating nothing. The exact guide count is owned by
    // `GUIDE_PATHS`/`GUIDE_POINTERS` in base2.ts, so it is not restated here.
    expect(GUIDE_POINTERS.length).toBeGreaterThan(0)
    for (const { guide, sectionName, section } of GUIDE_POINTERS) {
      const { excerpt, tailContains } = GUIDE_DRIFT_OVERRIDES[guide] ?? {}
      const guidePath = resolveRepoPath(guide)
      // Labelled so a missing guide names the file instead of failing with
      // `expected false to be true`.
      expect(describeRepoFileExistence(guide)).toBe('exists')
      const guideBody = normalizeMarkdown(readFileSync(guidePath, 'utf8'))
      const sectionBody = normalizeMarkdown(section)

      let expected = sectionBody
      if (excerpt) {
        const from = normalizeMarkdown(excerpt.from)
        const to = normalizeMarkdown(excerpt.to)
        const start = sectionBody.indexOf(from)
        // Labelled like the neighbouring assertions so a stale excerpt bound
        // names the guide/constant pair instead of printing a bare number.
        expect(
          start >= 0
            ? 'found'
            : `${sectionName} (${guide}) no longer contains excerpt start "${excerpt.from}"`,
        ).toBe('found')
        const end = sectionBody.indexOf(to, start)
        expect(
          end > start
            ? 'found'
            : `${sectionName} (${guide}) no longer contains excerpt end "${excerpt.to}" after its start`,
        ).toBe('found')
        expected = sectionBody.slice(start, end + to.length)
      }

      // Guard against the comparison degrading into a keyword check.
      expect(expected.length).toBeGreaterThan(200)
      // Labelled so a drift failure names the guide/constant pair instead of
      // dumping two multi-kilobyte strings.
      expect(
        guideBody.includes(expected)
          ? 'mirrored'
          : `${guide} drifted from ${sectionName}`,
      ).toBe('mirrored')

      for (const tail of tailContains ?? []) {
        expect(
          guideBody.includes(normalizeMarkdown(tail))
            ? 'present'
            : `${guide} no longer contains its tail section "${tail}"`,
        ).toBe('present')
      }
    }
  })
})
