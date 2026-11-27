import { describe, expect, test } from 'bun:test'

import { toolMetadata } from '@codebuff/common/tools/metadata'
import { toolNames } from '@codebuff/common/tools/constants'
import { getRegisteredToolNames, toolRendererDispositions } from '../registry'

describe('tool renderer metadata', () => {
  test('[DEP-M02] every native tool has an explicit renderer disposition', () => {
    expect(Object.keys(toolRendererDispositions).sort()).toEqual(
      [...toolNames].sort(),
    )
    for (const toolName of toolNames) {
      expect(['custom', 'fallback', 'hidden']).toContain(
        toolRendererDispositions[toolName],
      )
      if (toolMetadata[toolName].renderer === 'custom') {
        expect(getRegisteredToolNames()).toContain(toolName)
      }
    }
  })
})

describe('language intelligence renderer registration', () => {
  test('[REG-LI01] all four LSP tools are pinned in the tool component registry', () => {
    const registered = getRegisteredToolNames()
    for (const toolName of [
      'go_to_definition',
      'find_references',
      'hover_type',
      'workspace_symbol',
    ] as const) {
      expect(registered).toContain(toolName)
    }
  })
})
