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

// M4 progressive prompt disclosure. When the flag is OFF (default), the
// assembled base2 prompt must be byte-identical to the pre-M4 prompt: the
// disclose() helper is a pure passthrough, so the verbose advisory sections
// stay inline verbatim. When the flag is ON, each verbose section is replaced
// by a compact pointer to an on-demand guide file under agents/guides/, and
// the authored prompt surface shrinks by at least 25%.

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
  test('flag defaults off: the verbose advisory sections stay inline verbatim', () => {
    const agent = createBase2('default')
    const system = agent.systemPrompt as string
    // The four relocatable systemPrompt sections are present byte-for-byte.
    expect(system).toContain(qualitySection)
    expect(system).toContain(gitDisciplineSection)
    expect(system).toContain(securityReviewSection)
    expect(system).toContain(specialistRoutingSection)
    // The broad-audit section is present verbatim in the instructions prompt.
    expect(agent.instructionsPrompt as string).toContain(BROAD_AUDIT_IMPL)
  })

  test('flag off is byte-identical to omitting the option entirely', () => {
    // Passing the option explicitly false must equal the default.
    for (const mode of ['default', 'fast'] as const) {
      const implicit = createBase2(mode)
      const explicit = createBase2(mode, { progressivePromptDisclosure: false })
      expect(authoredSurface(explicit)).toBe(authoredSurface(implicit))
    }
    // Plan mode too.
    const implicitPlan = createBase2('default', { planOnly: true })
    const explicitPlan = createBase2('default', {
      planOnly: true,
      progressivePromptDisclosure: false,
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

  test('flag on shrinks the authored prompt surface by at least 25%', () => {
    const off = countTokens(authoredSurface(createBase2('default')))
    const on = countTokens(
      authoredSurface(
        createBase2('default', { progressivePromptDisclosure: true }),
      ),
    )
    const reduction = (off - on) / off
    expect(reduction).toBeGreaterThanOrEqual(0.25)
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
