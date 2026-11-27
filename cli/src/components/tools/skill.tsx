import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { getStructuredErrorMessages } from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

/**
 * UI component for skill tool.
 * Displays the skill name being loaded in a compact format.
 */
export const SkillComponent = defineToolComponent({
  toolName: 'skill',

  render(toolBlock): ToolRenderConfig {
    const input = toolBlock.input as any

    const skillName = typeof input?.name === 'string' ? input.name.trim() : ''

    if (!skillName) {
      return { content: null }
    }

    const error = getStructuredErrorMessages(toolBlock.outputRaw)[0]
    const status = error
      ? `failed · ${error}`
      : toolBlock.lifecycle === 'queued' ||
          toolBlock.lifecycle === 'running' ||
          toolBlock.lifecycle === 'cancelled' ||
          toolBlock.lifecycle === 'failed'
        ? toolBlock.lifecycle
        : toolBlock.outputRaw !== undefined
          ? 'captured · Inspect for skill content'
          : 'output unavailable'
    return {
      collapsedPreview: `Load Skill ${skillName} · ${status}`,
      content: (
        <SimpleToolCallItem
          name="Load Skill"
          description={`${skillName} · ${status}`}
        />
      ),
    }
  },
})
