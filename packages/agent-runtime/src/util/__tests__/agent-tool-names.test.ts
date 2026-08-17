import { describe, expect, it } from 'bun:test'

import { getEffectiveAgentToolNames } from '../agent-tool-names'
import { ALLOW_ALL_TIER_TOOLS } from '../base2-tool-tiers'

import type { AgentTemplate } from '../../templates/types'

function template(overrides: Partial<AgentTemplate>): AgentTemplate {
  return {
    id: 'test-agent',
    displayName: 'Test Agent',
    model: 'openai/gpt-5.3',
    toolNames: [],
    spawnableAgents: [],
    ...overrides,
  } as AgentTemplate
}

describe('getEffectiveAgentToolNames', () => {
  it('adds set_output to structured-output agents that omitted it', () => {
    expect(
      getEffectiveAgentToolNames(
        template({
          outputMode: 'structured_output',
          toolNames: ['read_files'],
        }),
      ),
    ).toEqual(['read_files', 'set_output'])
  })

  it('does not duplicate an explicitly declared set_output tool', () => {
    expect(
      getEffectiveAgentToolNames(
        template({
          outputMode: 'structured_output',
          toolNames: ['read_files', 'set_output'],
        }),
      ),
    ).toEqual(['read_files', 'set_output'])
  })

  it('does not grant set_output to ordinary last-message agents', () => {
    expect(
      getEffectiveAgentToolNames(
        template({ outputMode: 'last_message', toolNames: ['read_files'] }),
      ),
    ).toEqual(['read_files'])
  })

  it('does not inject programmatic-only set_output into the model-visible list', () => {
    expect(
      getEffectiveAgentToolNames(
        template({
          outputMode: 'structured_output',
          toolNames: ['read_files'],
          programmaticToolNames: ['set_output'],
        }),
      ),
    ).toEqual(['read_files'])
  })

  describe('progressive tool disclosure', () => {
    it('ignores persisted unlocks when the canary is explicitly off', () => {
      expect(
        getEffectiveAgentToolNames(
          template({
            toolNames: ['read_files', 'run_terminal_command'],
            programmaticConfig: { progressiveToolDisclosure: false },
          }),
          { unlockedToolTiers: ['implement'] },
        ),
      ).toEqual(['read_files', 'run_terminal_command'])
    })

    it('leaves the template surface unchanged for absent or empty unlocks', () => {
      const agentTemplate = template({
        toolNames: ['read_files', 'run_terminal_command'],
      })
      expect(getEffectiveAgentToolNames(agentTemplate)).toEqual([
        'read_files',
        'run_terminal_command',
      ])
      expect(
        getEffectiveAgentToolNames(agentTemplate, { unlockedToolTiers: [] }),
      ).toEqual(['read_files', 'run_terminal_command'])
    })

    it('fails closed when a non-empty unlock list has no published fullToolSurface', () => {
      expect(
        getEffectiveAgentToolNames(template({ toolNames: ['read_files'] }), {
          unlockedToolTiers: ['implement'],
        }),
      ).toEqual(['read_files'])
    })

    it('appends only tier tools the published fullToolSurface admits', () => {
      expect(
        getEffectiveAgentToolNames(
          template({
            toolNames: ['read_files'],
            programmaticConfig: { fullToolSurface: ['edit_transaction'] },
          }),
          { unlockedToolTiers: ['implement'] },
        ),
      ).toEqual(['read_files', 'edit_transaction'])
    })

    it('admits every unlocked tier tool for the ALLOW_ALL sentinel', () => {
      const names = getEffectiveAgentToolNames(
        template({
          toolNames: ['read_files'],
          programmaticConfig: { fullToolSurface: ALLOW_ALL_TIER_TOOLS },
        }),
        { unlockedToolTiers: ['implement'] },
      )
      expect(names).toContain('edit_transaction')
      expect(names).toContain('run_terminal_command')
    })
  })
})
