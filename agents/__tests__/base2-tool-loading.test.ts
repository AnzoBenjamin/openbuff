import { describe, expect, it } from 'bun:test'

import { getEffectiveAgentToolNames } from '@codebuff/agent-runtime/util/agent-tool-names'
import { handleToolLoad } from '@codebuff/agent-runtime/tools/handlers/tool/tool-load'
import { handleToolSearch } from '@codebuff/agent-runtime/tools/handlers/tool/tool-search'
import { createBase2 } from '../base2/base2'

import type { AgentState } from '@codebuff/common/types/session-state'
import type { AgentTemplate } from '@codebuff/agent-runtime/templates/types'

function stateWith(unlockedToolTiers: string[] = []): AgentState {
  return { unlockedToolTiers } as unknown as AgentState
}

function base2Template(
  options?: Parameters<typeof createBase2>[1],
): AgentTemplate {
  return createBase2('default', options) as unknown as AgentTemplate
}

function toolCall<T extends 'tool_load' | 'tool_search'>(
  toolName: T,
  input: T extends 'tool_load'
    ? { tier: 'implement' | 'audit' | 'media_3d' | 'job_extra' }
    : { query?: string },
) {
  return {
    toolName,
    toolCallId: `call-${toolName}`,
    input,
  } as never
}

describe('base2 progressive tool loading', () => {
  it('starts core-only and loads an available tier for the next step', async () => {
    const agentTemplate = base2Template()
    const agentState = stateWith()
    const firstSurface = getEffectiveAgentToolNames(agentTemplate, agentState)
    expect(firstSurface).toContain('tool_search')
    expect(firstSurface).toContain('tool_load')
    expect(firstSurface).not.toContain('edit_transaction')

    const searchResult = await handleToolSearch({
      agentTemplate,
      agentState,
      toolCall: toolCall('tool_search', { query: 'edit_transaction' }),
    } as never)
    const search = searchResult.output[0]?.value as {
      status: string
      tiers: Array<{ tier: string; tools: string[] }>
    }
    expect(search.status).toBe('ok')
    expect(search.tiers).toContainEqual(
      expect.objectContaining({
        tier: 'implement',
        tools: expect.arrayContaining(['edit_transaction']),
      }),
    )

    const loadResult = await handleToolLoad({
      agentTemplate,
      agentState,
      toolCall: toolCall('tool_load', { tier: 'implement' }),
    } as never)
    expect((loadResult.output[0]?.value as { status: string }).status).toBe(
      'ok',
    )
    expect(getEffectiveAgentToolNames(agentTemplate, agentState)).toContain(
      'edit_transaction',
    )
    expect(agentState.unlockedToolTiers).toEqual(['implement'])
  })

  it('never loads a mode-filtered mutation into plan mode', async () => {
    const agentTemplate = base2Template({ planOnly: true })
    const agentState = stateWith()
    const searchResult = await handleToolSearch({
      agentTemplate,
      agentState,
      toolCall: toolCall('tool_search', { query: 'edit_transaction' }),
    } as never)
    const search = searchResult.output[0]?.value as {
      status: string
      tiers: Array<{ tools: string[] }>
    }
    expect(search.status).toBe('ok')
    expect(search.tiers.flatMap((entry) => entry.tools)).not.toContain(
      'edit_transaction',
    )

    const loadResult = await handleToolLoad({
      agentTemplate,
      agentState,
      toolCall: toolCall('tool_load', { tier: 'implement' }),
    } as never)
    expect(
      (loadResult.output[0]?.value as { loadedTools: string[] }).loadedTools,
    ).not.toContain('edit_transaction')
    expect(getEffectiveAgentToolNames(agentTemplate, agentState)).not.toContain(
      'edit_transaction',
    )
  })

  it('fails closed when progressive disclosure is explicitly disabled', async () => {
    const agentTemplate = base2Template({
      progressiveToolDisclosure: false,
    })
    const agentState = stateWith()
    const result = await handleToolLoad({
      agentTemplate,
      agentState,
      toolCall: toolCall('tool_load', { tier: 'implement' }),
    } as never)

    expect((result.output[0]?.value as { status: string }).status).toBe(
      'unavailable',
    )
    expect(agentState.unlockedToolTiers).toEqual([])
  })
})
