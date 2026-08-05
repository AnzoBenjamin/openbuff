import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { countTokens } from '@codebuff/agent-runtime/util/token-counter'

import { createBase2 } from '../base2/base2'
import {
  buildBroadAuditSection,
  gitDisciplineSection,
  qualitySection,
  securityReviewSection,
  specialistRoutingSection,
} from '../base2/quality-prompt-section'

// M2/M4 progressive prompt disclosure. Default is ON (M2 flip): each verbose
// advisory section is replaced by a compact pointer to an on-demand guide
// under agents/guides/, shrinking the authored prompt surface by at least
// 25% vs explicit-off. Explicit progressivePromptDisclosure: false keeps the
// disclose() helper as a pure passthrough so the verbose bodies stay inline
// verbatim (pre-M4 surface). The OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
// canary can only force ON, never OFF; explicit false always wins.

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

const BROAD_AUDIT_IMPL = buildBroadAuditSection(
  'proceed to implementation or the answer',
)
const BROAD_AUDIT_PLAN = buildBroadAuditSection(
  'translate the findings into the durable plan packet below',
)

describe('base2 progressive prompt disclosure (M4)', () => {
  test('flag defaults on: the verbose advisory sections relocate to guides', () => {
    const agent = createBase2('default')
    const system = agent.systemPrompt as string
    // The four relocatable systemPrompt sections are replaced by pointers.
    expect(system).not.toContain(qualitySection)
    expect(system).not.toContain(gitDisciplineSection)
    expect(system).not.toContain(securityReviewSection)
    expect(system).not.toContain(specialistRoutingSection)
    expect(system).toContain('agents/guides/code-craftsmanship.md')
    expect(system).toContain('agents/guides/git-discipline.md')
    expect(system).toContain('agents/guides/security-review.md')
    expect(system).toContain('agents/guides/specialist-routing.md')
    // The broad-audit section relocates out of the instructions prompt.
    const instructions = agent.instructionsPrompt as string
    expect(instructions).not.toContain(BROAD_AUDIT_IMPL)
    expect(instructions).toContain('agents/guides/broad-audit.md')
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

  test('flag on: verbose sections are removed and replaced by guide pointers', () => {
    const agent = createBase2('default', {
      progressivePromptDisclosure: true,
    })
    const system = agent.systemPrompt as string
    // The verbose bodies are gone...
    expect(system).not.toContain(qualitySection)
    expect(system).not.toContain(gitDisciplineSection)
    expect(system).not.toContain(securityReviewSection)
    expect(system).not.toContain(specialistRoutingSection)
    // ...replaced by compact pointers to the guide files.
    expect(system).toContain('agents/guides/code-craftsmanship.md')
    expect(system).toContain('agents/guides/git-discipline.md')
    expect(system).toContain('agents/guides/security-review.md')
    expect(system).toContain('agents/guides/specialist-routing.md')

    const instructions = agent.instructionsPrompt as string
    expect(instructions).not.toContain(BROAD_AUDIT_IMPL)
    expect(instructions).toContain('agents/guides/broad-audit.md')
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

  test('flag on preserves the standing obligation (no mandate silently dropped)', () => {
    const agent = createBase2('default', {
      progressivePromptDisclosure: true,
    })
    const system = agent.systemPrompt as string
    // The obligation triggers must survive inline so the model still knows
    // WHEN to act, even though the procedure moved to a guide.
    expect(system.toLowerCase()).toContain('code craftsmanship')
    expect(system.toLowerCase()).toContain('security-sensitive')
    expect(system.toLowerCase()).toContain('before any git')
    expect(system.toLowerCase()).toContain('specialist')
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

  test('canary can only force-on; a `0` value falls through to the true default', () => {
    // Contract: OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE canary can only force
    // ON, never OFF. `0` is not an off override; with no explicit option the
    // flag resolves to DEFAULT_PROGRESSIVE_PROMPT_DISCLOSURE (true), so the
    // surface stays disclosed.
    const previous = process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
    try {
      process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = '0'
      const agent = createBase2('default')
      const system = agent.systemPrompt as string
      expect(system).not.toContain(qualitySection)
      expect(system).toContain('agents/guides/code-craftsmanship.md')
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
      } else {
        process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = previous
      }
    }
  })

  test('explicit false overrides env canary on', () => {
    const previous = process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
    try {
      process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = '1'
      const agent = createBase2('default', {
        progressivePromptDisclosure: false,
      })
      const system = agent.systemPrompt as string
      expect(system).toContain(qualitySection)
      expect(system).not.toContain('agents/guides/code-craftsmanship.md')
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE
      } else {
        process.env.OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE = previous
      }
    }
  })

  test('every relocated guide file exists and carries its moved content', () => {
    const guidesDir = path.join(__dirname, '..', 'guides')
    const checks: Array<[string, string]> = [
      ['broad-audit.md', 'scope'],
      ['specialist-routing.md', 'specialist'],
      ['git-discipline.md', 'commit'],
      ['security-review.md', 'security'],
      ['code-craftsmanship.md', 'craftsmanship'],
    ]
    for (const [file, keyword] of checks) {
      const full = path.join(guidesDir, file)
      expect(existsSync(full)).toBe(true)
      expect(readFileSync(full, 'utf8').toLowerCase()).toContain(keyword)
    }
  })
})
