import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { describe, expect, test } from 'bun:test'

import {
  ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS,
  ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS,
  ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS,
  compileActivePlaybooksContext,
} from './playbook-context'

import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'

/**
 * Build a schema-valid playbook fixture. Parsing through MemoryPlaybookSchema
 * keeps the fixtures honest about the (final) common types — an invalid shape
 * would be silently dropped by the band and break the assertions below.
 */
const makePlaybook = (overrides: {
  playbookId?: string
  triggerSignature?: string
  title?: string
  instruction?: string
  status?: MemoryPlaybook['status']
}): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId: overrides.playbookId ?? 'pb-1',
    workspaceId: 'ws-1',
    title:
      overrides.title ?? 'Run local CI before spawning the git committer',
    instruction:
      overrides.instruction ??
      'Run `npm run check:ci-local` and fix failures.',
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        {
          kind: 'toolSucceeded',
          tool: 'run_terminal_command',
          commandPattern: '*check:ci-local*',
          withinMs: 30 * 60 * 1_000,
        },
      ],
    },
    scope: { repos: [] },
    status: overrides.status ?? 'active',
    enforcement: 'warn',
    counters: {
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    },
    provenance: {
      origin: 'derived',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: overrides.triggerSignature ?? 'sig-1',
    createdAt: 1,
    updatedAt: 2,
  })

describe('compileActivePlaybooksContext', () => {
  test('renders nothing for empty or wholly invalid input and never throws', () => {
    expect(compileActivePlaybooksContext([])).toBe('')
    expect(
      compileActivePlaybooksContext([null, 42, 'garbage', {}, []]),
    ).toBe('')
    // Only ACTIVE playbooks render; other schema-valid statuses drop.
    expect(
      compileActivePlaybooksContext([
        makePlaybook({ status: 'retired' }),
        makePlaybook({ status: 'verified' }),
        makePlaybook({ status: 'candidate' }),
      ]),
    ).toBe('')
  })

  test('compiles byte-identical bands regardless of input order', () => {
    const a = makePlaybook({ playbookId: 'pb-a', triggerSignature: 'sig-a' })
    const b = makePlaybook({ playbookId: 'pb-b', triggerSignature: 'sig-b' })
    const first = compileActivePlaybooksContext([a, b])
    const second = compileActivePlaybooksContext([b, a])
    expect(second).toBe(first)

    // Signature ties break deterministically on playbookId.
    const tieX = makePlaybook({
      playbookId: 'pb-x',
      triggerSignature: 'sig-same',
      title: 'Tie X rule',
    })
    const tieY = makePlaybook({
      playbookId: 'pb-y',
      triggerSignature: 'sig-same',
      title: 'Tie Y rule',
    })
    const forward = compileActivePlaybooksContext([tieX, tieY])
    const backward = compileActivePlaybooksContext([tieY, tieX])
    expect(backward).toBe(forward)
    expect(forward.indexOf('Tie X rule')).toBeLessThan(
      forward.indexOf('Tie Y rule'),
    )
  })

  test('caps the band at maxChars and clips every oversized entry visibly', () => {
    const playbooks = Array.from(
      { length: ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS },
      (_, index) =>
        makePlaybook({
          playbookId: `pb-${index}`,
          triggerSignature: `sig-${index}`,
          title: `cap-${index}`,
          instruction: 'x'.repeat(4_096),
        }),
    )
    const text = compileActivePlaybooksContext(playbooks)

    expect(text.length).toBeLessThanOrEqual(ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS)
    // Equal-share presence: every selected playbook's title still renders.
    for (
      let index = 0;
      index < ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS;
      index++
    ) {
      expect(text).toContain(`cap-${index}`)
    }
    // Every entry exceeded its equal share, so every entry is visibly clipped.
    expect(text.match(/\.\.\.\[truncated\]/g) ?? []).toHaveLength(
      ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS,
    )
  })

  test('renders only the lowest triggerSignature values past the playbook cap', () => {
    const playbooks = Array.from({ length: 9 }, (_, index) =>
      makePlaybook({
        playbookId: `pb-${index}`,
        triggerSignature: `sig-${index + 1}`,
        title: `slot-${index + 1}`,
      }),
    )
    const text = compileActivePlaybooksContext(playbooks)

    expect(text).toContain('[1/8]')
    expect(text).toContain('[8/8]')
    expect(text.match(/\n---\n/g) ?? []).toHaveLength(
      ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS - 1,
    )
    for (let slot = 1; slot <= 8; slot++) {
      expect(text).toContain(`slot-${slot}`)
    }
    // The highest signature lost its slot to the cap.
    expect(text).not.toContain('slot-9')
  })

  test('drops schema-invalid entries without vouching any fragment of them', () => {
    const valid = makePlaybook({
      playbookId: 'pb-keep',
      triggerSignature: 'sig-keep',
      title: 'Keep me',
    })
    const invalid = {
      ...valid,
      enforcement: 'not-a-real-mode',
      instruction: 'EVIL INVALID INSTRUCTION',
    }
    const text = compileActivePlaybooksContext([invalid, valid])

    expect(text).toContain('Keep me')
    expect(text).not.toContain('EVIL INVALID INSTRUCTION')
    // All-invalid input renders nothing at all.
    expect(compileActivePlaybooksContext([invalid])).toBe('')
  })

  test('frames the band as trusted operator rules with pre-satisfy and self-run clauses', () => {
    const text = compileActivePlaybooksContext([makePlaybook({})])

    expect(text).toContain('<active_playbooks>')
    expect(text).toContain('</active_playbooks>')
    expect(text).toContain('trusted, operator-authored')
    expect(text).toContain('FIRST with a real tool call')
    expect(text).toContain('not visible to this gate')
    // The trusted band is the opposite of the memory-v2 evidence banner.
    expect(text).not.toContain('untrusted')
  })

  test('describes triggers and required evidence in the gate verdict vocabulary', () => {
    const text = compileActivePlaybooksContext([makePlaybook({})])

    expect(text).toContain('spawn_agents spawning agent git-committer')
    expect(text).toContain(
      'a successful run_terminal_command matching *check:ci-local*',
    )
  })

  test('keeps the header within its dedicated budget', () => {
    const text = compileActivePlaybooksContext([makePlaybook({})])
    const header = text.slice(text.indexOf('\n') + 1, text.indexOf('[1/'))
    expect(header.length).toBeLessThanOrEqual(ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS)
  })

  test('handles a single playbook and degenerate budgets without breaking', () => {
    expect(compileActivePlaybooksContext([makePlaybook({})])).toContain('[1/1]')
    // Tiny budgets never divide by zero or slice negatively; the cap holds.
    const tiny = compileActivePlaybooksContext([makePlaybook({})], {
      maxChars: 120,
    })
    expect(tiny.length).toBeLessThanOrEqual(120)
    expect(compileActivePlaybooksContext([], { maxChars: 0 })).toBe('')
    expect(
      compileActivePlaybooksContext([makePlaybook({})], { maxPlaybooks: 0 }),
    ).toBe('')
  })
})
