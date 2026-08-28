import { describe, expect, test } from 'bun:test'

import { countTokens } from '@codebuff/agent-runtime/util/token-counter'

import { GUIDE_FALLBACK_SECTIONS } from '@codebuff/common/util/guides'

import { createBase2, GUIDE_POINTERS, type GuidePath } from '../base2/base2'
import {
  buildBroadAuditSection,
  gateAwarenessSection,
  gitDisciplineSection,
  preReviewSelfCheckSection,
  qualitySection,
} from '../base2/quality-prompt-section'
import { PLACEHOLDER } from '../types/secret-agent-definition'
import { describeRepoFileExistence } from './guide-test-utils'

// M2/M4 progressive prompt disclosure. Default is ON (M2 flip): each verbose
// advisory section is replaced by a compact pointer to an on-demand guide
// under agents/guides/, shrinking the authored prompt surface by at least
// 25% vs explicit-off. Explicit progressivePromptDisclosure: false keeps the
// disclose() helper as a pure passthrough so the verbose bodies stay inline
// verbatim (pre-M4 surface). Resolution is option-driven only: no environment
// variable participates in it.

type Base2Agent = ReturnType<typeof createBase2>

function authoredSurface(agent: Base2Agent): string {
  // The base2-authored always-on text we control in M4: the system prompt
  // template plus the mode's instructions and step prompts. Runtime
  // placeholders (file tree, knowledge, etc.) appear only as short
  // ${PLACEHOLDER.X} markers here, so they do not distort the ratio.
  return [
    (agent.systemPrompt as string | undefined) ?? '',
    (agent.instructionsPrompt as string | undefined) ?? '',
    (agent.stepPrompt as string | undefined) ?? '',
  ].join('\n')
}

// Every disclosed mode that emits pointers: default implementation, plan-only,
// and durable-plan execution (EXECUTE_PLAN forwards `progressiveDisclosure`
// through buildExecutePlanInstructionsPrompt, so its pointers must be checked
// too).
function disclosedSurface(): string {
  return [
    authoredSurface(createBase2('default')),
    authoredSurface(createBase2('default', { planOnly: true })),
    authoredSurface(createBase2('default', { executePlan: true })),
  ].join('\n')
}

// Matches the workspace-relative guide path every pointer emits. Global so
// `String.match` collects all of them; both uses go through `match`, which
// resets `lastIndex` itself, so the shared regex stays stateless.
const GUIDE_POINTER_PATH_PATTERN = /agents\/guides\/[A-Za-z0-9._-]+\.md/g

// Derived from the single exported guide/pointer table in base2.ts so adding,
// renaming, or dropping a relocated guide cannot leave this test asserting a
// stale hardcoded file list.
const SYSTEM_GUIDE_POINTERS = GUIDE_POINTERS.filter(
  ({ surface }) => surface === 'system',
)
const INSTRUCTIONS_GUIDE_POINTERS = GUIDE_POINTERS.filter(
  ({ surface }) => surface === 'instructions',
)

const BROAD_AUDIT_IMPL = buildBroadAuditSection(
  'proceed to implementation or the answer',
)
const BROAD_AUDIT_PLAN = buildBroadAuditSection(
  'translate the findings into the durable plan packet below',
)

// `satisfies GuidePath` so a renamed guide path is a compile error rather than a
// silently never-matching comparison in the mode-exclusion assertions below.
const GIT_DISCIPLINE_GUIDE =
  'agents/guides/git-discipline.md' satisfies GuidePath
const BROAD_AUDIT_GUIDE = 'agents/guides/broad-audit.md' satisfies GuidePath

describe('base2 progressive prompt disclosure (M4)', () => {
  test('flag defaults on: the verbose advisory sections relocate to guides', () => {
    const agent = createBase2('default')
    const system = agent.systemPrompt as string
    // Every relocatable systemPrompt section is replaced by its pointer.
    // Numeric vacuity guard only: an emptied table must not make the loop below
    // pass by iterating nothing. The exact system-surface guide count is owned
    // by `GUIDE_PATHS`/`GUIDE_POINTERS` in base2.ts, so it is not restated here.
    expect(SYSTEM_GUIDE_POINTERS.length).toBeGreaterThan(0)
    for (const {
      guide,
      sectionName,
      section,
      pointer,
    } of SYSTEM_GUIDE_POINTERS) {
      // Labelled so a failure names the section that stayed inline instead of
      // dumping two multi-kilobyte strings.
      expect(
        system.includes(section)
          ? `${sectionName} is still inline instead of relocated to ${guide}`
          : 'relocated',
      ).toBe('relocated')
      // The whole pointer, not just its guide path: a pointer stripped down to
      // a bare path (no trigger clause, no fetch verb, no degrade clause) must
      // fail here. This assertion is the single owner of the pointer wording
      // (trigger clause included), so no other case re-asserts substrings of it.
      expect(
        system.includes(pointer)
          ? 'pointed'
          : `${guide} pointer is missing from the system prompt`,
      ).toBe('pointed')
      // Row-level pairing: without this a mis-paired row (guide A with guide
      // B's pointer) still passes, because both strings appear somewhere in
      // the prompt.
      expect(pointer).toContain(guide)
    }
    // gateAwarenessSection is deliberately NOT relocatable: the gate contract
    // (GATE: PENDING/PASSED, pending-set authority, final_response_allowed)
    // must stay inline verbatim rather than being compressed into a pointer.
    // base2.ts emits it only for `isDefault && !planOnly`, so the plan-only and
    // `fast` surfaces omit the section entirely; asserting it inline on those
    // surfaces would encode an invariant the prompt does not have.
    expect(
      system.includes(gateAwarenessSection)
        ? 'inline'
        : 'default: gate awareness section is not inline verbatim',
    ).toBe('inline')
    // On the surfaces that omit it, what must not happen is relocation: no
    // gate-awareness guide pointer may appear in its place.
    const gateOmittedSurfaces = {
      plan: createBase2('default', { planOnly: true }).systemPrompt as string,
      fast: createBase2('fast').systemPrompt as string,
    }
    for (const [label, gateSystem] of Object.entries(gateOmittedSurfaces)) {
      // Labelled so a failure names the mode whose gate contract moved.
      expect(
        gateSystem.includes('agents/guides/gate-awareness')
          ? `${label}: gate contract was relocated to a guide pointer`
          : 'not relocated',
      ).toBe('not relocated')
    }
    // The broad-audit section relocates out of the instructions prompt.
    const instructions = agent.instructionsPrompt as string
    expect(INSTRUCTIONS_GUIDE_POINTERS.length).toBeGreaterThan(0)
    for (const {
      guide,
      sectionName,
      section,
      pointer,
    } of INSTRUCTIONS_GUIDE_POINTERS) {
      expect(
        instructions.includes(section)
          ? `${sectionName} is still inline instead of relocated to ${guide}`
          : 'relocated',
      ).toBe('relocated')
      expect(
        instructions.includes(pointer)
          ? 'pointed'
          : `${guide} pointer is missing from the instructions prompt`,
      ).toBe('pointed')
      expect(pointer).toContain(guide)
    }
  })

  // Mechanical pointer->file wiring check, independent of the GUIDE_POINTERS
  // table the assertions above derive from: every `agents/guides/*.md` path the
  // default surface actually emits must exist on disk, so a typo'd pointer such
  // as `agents/guides/code-craftmanship.md` fails here even though the table
  // itself still lines up.
  test('every agents/guides pointer path in the default surface resolves to a real guide file', () => {
    const pointerPaths = new Set(
      disclosedSurface().match(GUIDE_POINTER_PATH_PATTERN) ?? [],
    )

    // Guard against the regex silently matching nothing (e.g. a pointer format
    // change) and making the existence check vacuous: one pointer path per
    // relocated section.
    expect(pointerPaths.size).toBeGreaterThanOrEqual(GUIDE_POINTERS.length)
    for (const pointerPath of pointerPaths) {
      // Labelled so a failure names the dangling pointer instead of printing
      // `expected false to be true`.
      expect(
        describeRepoFileExistence(pointerPath, `${pointerPath} pointer`),
      ).toBe('exists')
    }
  })

  test('flag on with an omitted option is byte-identical to flag explicitly on', () => {
    // Default-on flip: omitting the option must equal passing it explicitly
    // true; the previous explicit-false-equals-default contract inverted.
    for (const mode of ['default', 'fast'] as const) {
      const implicit = createBase2(mode)
      const explicit = createBase2(mode, { progressivePromptDisclosure: true })
      expect(authoredSurface(explicit)).toBe(authoredSurface(implicit))
    }
    // Plan mode too.
    const implicitPlan = createBase2('default', { planOnly: true })
    const explicitPlan = createBase2('default', {
      planOnly: true,
      progressivePromptDisclosure: true,
    })
    expect(authoredSurface(explicitPlan)).toBe(authoredSurface(implicitPlan))
  })

  // Every pointer must degrade gracefully for embedders whose workspace has no
  // `agents/guides/` directory: without this case the inline fallback clauses
  // could be deleted with all other assertions still passing.
  test('every emitted guide pointer carries its "If that guide is unavailable" clause', () => {
    const pointerLines = disclosedSurface()
      .split('\n')
      .filter((line) => line.match(GUIDE_POINTER_PATH_PATTERN) !== null)

    // Guard against the filter matching nothing (pointer reformatting) and
    // making the clause check vacuous: one line per relocated section, and the
    // broad-audit pointer is emitted once per mode.
    expect(pointerLines.length).toBeGreaterThanOrEqual(GUIDE_POINTERS.length)
    for (const line of pointerLines) {
      // Labelled so a failure names the pointer that lost its fallback.
      expect(
        line.includes('If that guide is unavailable')
          ? 'degrades'
          : `pointer lost its degrade clause: ${line.slice(0, 120)}`,
      ).toBe('degrades')
      // A pointer that keeps the path but loses the fetch verb leaves the model
      // with nothing to act on, so pin the read_files instruction too.
      expect(
        line.includes('read_files')
          ? 'fetchable'
          : `pointer lost its read_files instruction: ${line.slice(0, 120)}`,
      ).toBe('fetchable')
    }
  })

  test('plan mode emits neither the git-discipline pointer nor its section', () => {
    // The system prompt gates git-discipline behind `!planOnly`, and every
    // GUIDE_POINTERS-derived loop above runs against `createBase2('default')`
    // only, so without this case making that disclosure unconditional in plan
    // mode (read-only, no commits) would still pass everything else here.
    // `satisfies GuidePath` so a renamed guide path is a compile error instead
    // of a runtime "git-discipline has no GUIDE_POINTERS row" failure.
    const gitDisciplineGuide = GIT_DISCIPLINE_GUIDE
    const gitDisciplineRow = GUIDE_POINTERS.find(
      ({ guide }) => guide === gitDisciplineGuide,
    )
    // Labelled so a renamed guide names the missing row instead of failing on a
    // bare undefined dereference.
    expect(
      gitDisciplineRow ? 'present' : 'git-discipline has no GUIDE_POINTERS row',
    ).toBe('present')
    if (!gitDisciplineRow) return

    const planSystem = createBase2('default', { planOnly: true })
      .systemPrompt as string
    expect(planSystem).not.toContain(gitDisciplineRow.guide)
    expect(planSystem).not.toContain(gitDisciplineRow.pointer)
    expect(planSystem).not.toContain(gitDisciplineSection)
    // Recovery must mirror the exclusion: emitting git-discipline's fallback
    // placeholder here would hand a guide-less embedder commit/push guidance
    // back in read-only plan mode.
    expect(planSystem).not.toContain(gitDisciplineRow.fallbackPlaceholder)
    // Vacuity guard: the same pointer IS emitted on the non-plan surface, so
    // this case cannot pass merely because the wiring disappeared entirely.
    expect(createBase2('default').systemPrompt as string).toContain(
      gitDisciplineRow.pointer,
    )
    expect(createBase2('default').systemPrompt as string).toContain(
      gitDisciplineRow.fallbackPlaceholder,
    )
  })

  test('the guide block is headed when disclosed and keeps one blank line per gap in every mode', () => {
    // The block is assembled with buildArray().join('\n\n') precisely so (a) the
    // bare pointer sentences do not read as a continuation of `# Repository
    // state`, (b) the explicit-off surface does not run
    // `# Pre-Review Self-Check` onto qualitySection's last bullet, and (c) plan
    // mode's omitted git-discipline entry leaves no stray double blank line.
    const heading = '# On-demand guides'
    for (const progressivePromptDisclosure of [true, false]) {
      for (const planOnly of [false, true]) {
        const system = createBase2('default', {
          planOnly,
          progressivePromptDisclosure,
        }).systemPrompt as string
        const label = `disclosure=${progressivePromptDisclosure} planOnly=${planOnly}`
        // The heading belongs to the disclosed branch only: with disclosure off
        // each inline section already carries its own `#` heading.
        expect(
          system.includes(heading) === progressivePromptDisclosure
            ? 'expected'
            : `${label}: ${heading} presence does not follow the disclosed branch`,
        ).toBe('expected')
        // Everything from `# Repository state` to the end of the prompt is the
        // guide block plus its two short lead-ins, so a stray double blank line
        // (an emptied plan-mode entry) shows up as a triple newline here.
        const tail = system.slice(system.indexOf('# Repository state'))
        expect(
          tail.includes('\n\n\n')
            ? `${label}: guide block has a stray double blank line`
            : 'single-gap',
        ).toBe('single-gap')
        // The conditional gate contract is interpolated between
        // `# Core Mandates` and `# Openbuff Meta-information`, so that span
        // needs the same guard: dropping it in plan mode must not leave a stray
        // double blank line behind.
        const mandates = system.slice(
          system.indexOf('# Core Mandates'),
          system.indexOf('# Openbuff Meta-information'),
        )
        expect(
          mandates.includes('\n\n\n')
            ? `${label}: core-mandates span has a stray double blank line`
            : 'single-gap',
        ).toBe('single-gap')
        // ...and exactly one blank line before the meta heading, whether the
        // gate section is present (default) or omitted (plan mode), so the
        // heading cannot abut the block above it either.
        const metaIndex = system.indexOf('# Openbuff Meta-information')
        // Guard the index like the neighbouring labelled assertions: a dropped
        // heading makes indexOf return -1, and the negative-index slices below
        // would then satisfy the blank-line check on garbage instead of naming
        // the missing heading.
        expect(
          metaIndex >= 3
            ? 'present'
            : `${label}: # Openbuff Meta-information is missing or has no preceding blank line`,
        ).toBe('present')
        const oneBlankLineBeforeMeta =
          system.slice(metaIndex - 2, metaIndex) === '\n\n' &&
          system[metaIndex - 3] !== '\n'
        expect(
          oneBlankLineBeforeMeta
            ? 'one blank line'
            : `${label}: # Openbuff Meta-information does not follow exactly one blank line`,
        ).toBe('one blank line')
        // Non-plan default is the surface that carries the gate section: pin
        // both of its seams so `# Automated Validation & Review Gate` cannot
        // abut the preceding context-pruner bullet and its last bullet cannot
        // abut the meta heading.
        if (!planOnly) {
          expect(
            system.includes(
              `\n\n${gateAwarenessSection}\n\n# Openbuff Meta-information`,
            )
              ? 'spaced'
              : `${label}: gate section seam lost its blank-line gaps`,
          ).toBe('spaced')
        }
      }
    }
    // Disclosed: every pointer sits under the block heading rather than
    // trailing `# Repository state` bare.
    const disclosed = createBase2('default').systemPrompt as string
    const headingIndex = disclosed.indexOf(heading)
    for (const { guide, pointer } of SYSTEM_GUIDE_POINTERS) {
      expect(
        disclosed.indexOf(pointer) > headingIndex
          ? 'under heading'
          : `${guide} pointer is emitted before ${heading}`,
      ).toBe('under heading')
    }
    // Explicit off: the two adjacent system sections keep a blank-line gap.
    const inline = createBase2('default', {
      progressivePromptDisclosure: false,
    }).systemPrompt as string
    expect(inline).toContain(
      `${qualitySection}\n\n${preReviewSelfCheckSection}`,
    )
  })

  test('explicit off emits no agents/guides pointer path in the system prompt', () => {
    // The disclosure-off system surface is otherwise only checked for heading
    // absence and section adjacency, so a `discloseGuide` change that emitted
    // the pointer AND the section (instead of one or the other) would slip
    // through. Assert the whole explicit-off system prompt carries no
    // `agents/guides/*.md` path at all, in both plan and non-plan mode.
    for (const planOnly of [false, true]) {
      const system = createBase2('default', {
        planOnly,
        progressivePromptDisclosure: false,
      }).systemPrompt as string
      const pointerPaths = system.match(GUIDE_POINTER_PATH_PATTERN) ?? []
      // Labelled so a failure names the leaked pointer paths instead of
      // printing a bare length mismatch.
      expect(
        pointerPaths.length === 0
          ? 'no pointer paths'
          : `planOnly=${planOnly}: explicit-off system prompt still emits ${pointerPaths.join(', ')}`,
      ).toBe('no pointer paths')
    }
  })

  test('flag on in plan mode also relocates the broad-audit section', () => {
    const agent = createBase2('default', {
      planOnly: true,
      progressivePromptDisclosure: true,
    })
    const instructions = agent.instructionsPrompt as string
    expect(instructions).not.toContain(BROAD_AUDIT_PLAN)
    expect(instructions).toContain('agents/guides/broad-audit.md')
  })

  test('the broad-audit pointer tail is plan-mode only', () => {
    // The pointer body is shared by every disclosed surface, but its plan-mode
    // "do not implement" sentence is inert noise on the implementation and
    // execute-plan surfaces, so `discloseBroadAudit` parameterizes the tail the
    // same way `buildBroadAuditSection` parameterizes the section body.
    const planTail =
      'In plan mode, do not implement — translate the findings into the durable plan packet instead.'
    const planInstructions = createBase2('default', { planOnly: true })
      .instructionsPrompt as string
    expect(planInstructions).toContain(planTail)
    for (const options of [{}, { executePlan: true }]) {
      const instructions = createBase2('default', options)
        .instructionsPrompt as string
      // Still the same disclosed pointer, just without the plan-mode tail.
      expect(instructions).toContain('agents/guides/broad-audit.md')
      expect(instructions).not.toContain(planTail)
    }
  })

  test('flag off in plan mode keeps the PLAN-variant broad-audit section inline', () => {
    // Plan mode's broad-audit body is the plan-variant finalize clause, not the
    // implementation variant the GUIDE_POINTER_TABLE row pins. Without this
    // case, swapping the plan builder to the implementation variant (or to the
    // pointer) would still pass every other assertion here.
    const agent = createBase2('default', {
      planOnly: true,
      progressivePromptDisclosure: false,
    })
    const instructions = agent.instructionsPrompt as string
    expect(instructions).toContain(BROAD_AUDIT_PLAN)
    expect(instructions).not.toContain(BROAD_AUDIT_IMPL)
    expect(instructions).not.toContain('agents/guides/broad-audit.md')
  })

  test('flag off keeps the IMPL-variant broad-audit section inline on the default and execute-plan surfaces', () => {
    // Positive counterpart to the disclosed-surface cases, which only assert
    // the implementation body is ABSENT. Without this, replacing the
    // implementation body with the plan variant — or with the pointer — on the
    // explicit-off default/execute-plan surfaces would pass everything else.
    for (const options of [{}, { executePlan: true }]) {
      const instructions = createBase2('default', {
        ...options,
        progressivePromptDisclosure: false,
      }).instructionsPrompt as string
      expect(instructions).toContain(BROAD_AUDIT_IMPL)
      expect(instructions).not.toContain(BROAD_AUDIT_PLAN)
      expect(instructions).not.toContain('agents/guides/broad-audit.md')
    }
  })

  test('flag on in execute-plan mode also relocates the broad-audit section', () => {
    // EXECUTE_PLAN wraps buildImplementationInstructionsPrompt and forwards
    // progressiveDisclosure into it, so the implementation-variant broad-audit
    // body must be replaced by the pointer there too.
    const agent = createBase2('default', { executePlan: true })
    const instructions = agent.instructionsPrompt as string
    expect(instructions).not.toContain(BROAD_AUDIT_IMPL)
    expect(instructions).toContain('agents/guides/broad-audit.md')
    // The durable-plan block still rides along, so the pointer above is coming
    // from the EXECUTE_PLAN surface rather than a plain implementation prompt.
    expect(instructions).toContain('## Durable plan execution mode')
  })

  // AC4 acceptance metric: progressive disclosure must shrink the authored
  // always-on surface by >=25%. Post-flip both `createBase2('default')` and
  // `progressivePromptDisclosure: true` resolve to ON, so the explicit-off
  // branch is the only verbose baseline. No separate buffbench harness.
  test('flag on shrinks the authored prompt surface by at least 25%', () => {
    const off = countTokens(
      authoredSurface(
        createBase2('default', { progressivePromptDisclosure: false }),
      ),
    )
    const on = countTokens(
      authoredSurface(
        createBase2('default', { progressivePromptDisclosure: true }),
      ),
    )
    const reduction = (off - on) / off
    expect(reduction).toBeGreaterThanOrEqual(0.25)
  })

  test('the disclosed surfaces emit one guide-fallback placeholder per emitted pointer and the explicit-off surfaces emit none', () => {
    // T1.4d: the placeholders are what recover the FULL relocated bodies for an
    // embedder whose workspace has no `agents/guides/` (their providers live in
    // packages/agent-runtime/src/templates/strings.ts and collapse to '' when
    // the guide exists). They are appended AFTER the pointers, never in place of
    // them, so the pointer-presence and >=25% cases above stay meaningful. With
    // disclosure off the six bodies are already inline, so emitting them there
    // would duplicate them.
    //
    // Recovery is per pointer: plan mode omits git-discipline's placeholder
    // exactly as it omits the pointer, and substitutes the plan-clause
    // broad-audit placeholder for the implementation-clause one.
    const modes: ReadonlyArray<{
      label: string
      options: Parameters<typeof createBase2>[1]
      planOnly: boolean
    }> = [
      { label: 'default', options: {}, planOnly: false },
      { label: 'plan', options: { planOnly: true }, planOnly: true },
      {
        label: 'execute-plan',
        options: { executePlan: true },
        planOnly: false,
      },
    ]
    for (const { label, options, planOnly } of modes) {
      const disclosed = createBase2('default', options).systemPrompt as string
      for (const { guide, fallbackPlaceholder } of GUIDE_POINTERS) {
        // Plan mode omits the git-discipline pointer entirely, and swaps the
        // broad-audit recovery for the plan-clause placeholder below.
        const expected =
          guide === GIT_DISCIPLINE_GUIDE || guide === BROAD_AUDIT_GUIDE
            ? !planOnly
            : true
        expect(
          disclosed.includes(fallbackPlaceholder) === expected
            ? 'expected'
            : expected
              ? `${label}: disclosed surface does not emit the ${guide} fallback placeholder`
              : `${label}: disclosed surface emits the ${guide} fallback placeholder even though it omits that pointer`,
        ).toBe('expected')
      }
      // The plan-clause broad-audit recovery is plan-mode only: recovering the
      // implementation-variant body there would contradict plan mode's own
      // "do not implement" pointer tail.
      expect(
        disclosed.includes(
          PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN,
        ) === planOnly
          ? 'expected'
          : `${label}: plan-clause broad-audit recovery presence does not follow plan mode`,
      ).toBe('expected')

      const inline = createBase2('default', {
        ...options,
        progressivePromptDisclosure: false,
      }).systemPrompt as string
      expect(
        inline.includes('{CODEBUFF_ON_DEMAND_GUIDE_FALLBACK')
          ? `${label}: explicit-off surface emits a guide-fallback placeholder, duplicating the inline bodies`
          : 'omitted',
      ).toBe('omitted')
    }
  })

  test('every relocated guide has a fallback body and vice versa', () => {
    // Drift guard: adding a relocated guide without a recovery body (or a body
    // without a pointer) silently reintroduces the lost-section defect for
    // embedder workspaces.
    expect(GUIDE_POINTERS.length).toBeGreaterThan(0)
    // Widened to string[]: GUIDE_FALLBACK_SECTIONS is keyed by plain string
    // (common/ cannot import the GuidePath union), so comparing the narrower
    // pointer paths directly has no matching toEqual overload.
    expect(GUIDE_POINTERS.map(({ guide }) => String(guide)).sort()).toEqual(
      Object.keys(GUIDE_FALLBACK_SECTIONS).sort(),
    )
  })

  test('OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE has no effect on resolution', () => {
    // base2 reads no env var for prompt disclosure: the resolved surface is
    // driven only by the option (omitted => DEFAULT, which is ON). Capture the
    // whole authored surface for both option states under each env value and
    // compare them byte-for-byte across values; which sections relocate is
    // owned by the first test in this file, not re-derived here.
    const previous = process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
    try {
      let baseline: { disclosed: string; inline: string } | undefined
      for (const value of ['0', '1']) {
        process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = value
        // Omitted option => disclosed surface; explicit false => inline bodies.
        const disclosed = authoredSurface(createBase2('default'))
        const inline = authoredSurface(
          createBase2('default', { progressivePromptDisclosure: false }),
        )
        // Vacuity guard: the two option states must differ, otherwise the
        // byte-equality assertions below would hold trivially.
        expect(disclosed).not.toBe(inline)
        if (!baseline) {
          baseline = { disclosed, inline }
          continue
        }
        expect(disclosed).toBe(baseline.disclosed)
        expect(inline).toBe(baseline.inline)
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
      } else {
        process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = previous
      }
    }
  })
})
