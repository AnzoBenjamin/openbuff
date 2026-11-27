import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import {
  getToolOutputRecords,
  getStructuredErrorMessages,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

/**
 * UI component for read_docs tool.
 * Displays library name and topic in a compact format.
 * Does not support expand/collapse - always shows as a simple line.
 */
export const ReadDocsComponent = defineToolComponent({
  toolName: 'read_docs',

  render(toolBlock): ToolRenderConfig {
    const input = toolBlock.input as any

    // Extract library and topic from input
    const libraryTitle =
      typeof input?.libraryTitle === 'string' ? input.libraryTitle.trim() : ''
    const topic = typeof input?.topic === 'string' ? input.topic.trim() : ''

    if (!libraryTitle && !topic) {
      return { content: null }
    }

    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const selected =
      record?.library && typeof record.library === 'object'
        ? (record.library as Record<string, unknown>)
        : undefined
    const error = getStructuredErrorMessages(toolBlock.outputRaw)[0]
    const state = error
      ? 'failed'
      : toolBlock.lifecycle === 'queued' ||
          toolBlock.lifecycle === 'running' ||
          toolBlock.lifecycle === 'cancelled' ||
          toolBlock.lifecycle === 'failed'
        ? toolBlock.lifecycle
        : typeof record?.documentation === 'string'
          ? record.documentation.trim()
            ? 'captured'
            : 'empty'
          : 'output unavailable'
    const description =
      libraryTitle && topic
        ? `${libraryTitle}: ${topic}`
        : libraryTitle || topic

    const detail = `${selected?.title ?? description}${typeof selected?.id === 'string' ? ` · ${selected.id}` : ''}${typeof selected?.branch === 'string' ? ` · branch ${selected.branch}` : ''} · ${state}${error ? ` · ${error}` : ''}`
    return {
      collapsedPreview: `Read Docs · ${detail}`,
      content: <SimpleToolCallItem name="Read Docs" description={detail} />,
    }
  },
})
