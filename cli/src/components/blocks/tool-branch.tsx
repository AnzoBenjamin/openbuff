import { memo, useCallback } from 'react'

import { ContentWithMarkdown } from './content-with-markdown'
import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { shouldCollapseToolByDefault } from '../../utils/constants'
import {
  boundedFallbackOutput,
  hasFallbackInputValue,
} from '../../utils/fallback-input-summary'
import { renderToolComponent } from '../tools/registry'
import { StructuredResult } from '../tools/structured-result'
import {
  cleanPreviewText,
  humanizeFieldName,
  summarizeStructuredPreview,
} from '../../utils/structured-preview'
import { toolDisplayOutput } from '../../utils/tool-display-output'
import { sliceTextCells } from '../../utils/text-boundaries'
import { getStructuredErrorMessages } from '../../utils/tool-result-normalizer'
import { ToolCallItem } from '../tools/tool-call-item'
import { Button } from '../button'
import { InspectAction } from '../inspect-action'
import { documentForTool } from '../../utils/output-catalog'
import { createJsonDocument } from '../../utils/output-document'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { InlineResultScope } from '../tools/inline-results'

import type { ContentBlock } from '../../types/chat'
import {
  hasMarkdown,
  type MarkdownPalette,
} from '../../utils/markdown-renderer'

interface ToolBranchProps {
  toolBlock: Extract<ContentBlock, { type: 'tool' }>
  messageId?: string
  keyPrefix: string
  availableWidth: number
  onToggleCollapsed: (id: string) => void
  markdownPalette: MarkdownPalette
}

export const ToolBranch = memo(
  ({
    toolBlock,
    messageId,
    keyPrefix,
    availableWidth,
    onToggleCollapsed,
    markdownPalette,
  }: ToolBranchProps) => {
    const theme = useTheme()
    // Derive streaming boolean for this specific tool to avoid re-renders when other tools/agents change
    const isStreaming = useChatStore((state) =>
      state.streamingAgents.has(toolBlock.toolCallId),
    )

    const sanitizePreview = (value: string): string => {
      const text = cleanPreviewText(value)
        .replace(/[#*_`~\[\]()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      const width = Math.max(1, Math.min(140, availableWidth - 4))
      const shown = sliceTextCells(text, 0, Math.max(0, width - 1))
      return shown.length < text.length ? `${shown}…` : text
    }

    if (toolBlock.toolName === 'end_turn') {
      return null
    }
    if (toolBlock.toolName === 'ask_user') {
      return null
    }
    if ('includeToolCall' in toolBlock && toolBlock.includeToolCall === false) {
      return null
    }

    const displayInfo = { name: toolBlock.toolName }

    // Check if there's a registered custom component for this tool
    const toolRenderConfig = renderToolComponent(toolBlock, theme, {
      availableWidth,
      indentationOffset: 0,
      previewPrefix: '',
      labelWidth: 0,
    })

    // Tools without a registered component (fallback rendering) should be collapsed by default
    const hasRegisteredComponent = toolRenderConfig !== undefined
    const isCollapsed =
      toolBlock.isCollapsed ??
      (hasRegisteredComponent
        ? shouldCollapseToolByDefault(toolBlock.toolName)
        : true)

    // Custom and MCP tools get the same disclosure hierarchy as shipped tools.
    // Avoid projecting their fallback data at all when a bespoke renderer exists.
    const inputContent =
      !hasRegisteredComponent && hasFallbackInputValue(toolBlock.input)
        ? toolBlock.input
        : undefined
    const displayOutput = !hasRegisteredComponent
      ? toolDisplayOutput(toolBlock.outputRaw, toolBlock.output)
      : {}
    const fallbackError = !hasRegisteredComponent
      ? getStructuredErrorMessages(toolBlock.outputRaw)[0]
      : undefined
    const fallbackFailure =
      !hasRegisteredComponent &&
      (fallbackError ||
        toolBlock.lifecycle === 'failed' ||
        toolBlock.lifecycle === 'cancelled')
        ? `${toolBlock.lifecycle === 'cancelled' ? 'Cancelled' : 'Failed'}${fallbackError ? ` · ${cleanPreviewText(boundedFallbackOutput(fallbackError))}` : ''}`
        : undefined
    const structuredOutput = displayOutput.value
    const fullContent = cleanPreviewText(
      boundedFallbackOutput(displayOutput.text ?? ''),
    )

    const lines = fullContent.split('\n').filter((line) => line.trim())
    const firstLine =
      displayOutput.preview ??
      (structuredOutput !== undefined
        ? summarizeStructuredPreview(structuredOutput)
        : lines[0] || '')
    const lastLine = lines[lines.length - 1] || firstLine
    const commandPreview =
      toolBlock.toolName === 'run_terminal_command' &&
      toolBlock.input &&
      typeof toolBlock.input === 'object' &&
      'command' in toolBlock.input &&
      typeof toolBlock.input.command === 'string'
        ? `$ ${toolBlock.input.command.trim()}`
        : null

    const streamingPreview = isStreaming
      ? (commandPreview ?? (firstLine ? `${sanitizePreview(firstLine)}…` : ''))
      : ''

    const getToolFinishedPreview = useCallback(
      (commandPrev: string | null, lastLn: string): string => {
        if (commandPrev) {
          return commandPrev
        }

        if (toolBlock.toolName === 'run_terminal_command' && toolBlock.output) {
          const outputLines = toolBlock.output
            .split('\n')
            .filter((line) => line.trim())
          const lastThreeLines = outputLines.slice(-3)
          const hasMoreLines = outputLines.length > 3
          const preview = lastThreeLines.join('\n')
          return hasMoreLines ? `...\n${preview}` : preview
        }

        return sanitizePreview(lastLn)
      },
      [toolBlock],
    )

    const finishedPreview = !isStreaming
      ? (toolRenderConfig?.collapsedPreview ??
        sanitizePreview(
          fallbackFailure ??
            getToolFinishedPreview(
              commandPreview,
              displayOutput.preview ??
                (structuredOutput !== undefined ? firstLine : lastLine),
            ),
        ))
      : ''

    const agentMarkdownOptions = {
      codeBlockWidth: Math.max(10, availableWidth - 12),
      palette: {
        ...markdownPalette,
        codeTextFg: theme.foreground,
      },
    }

    const resultContent = fullContent ? (
      hasMarkdown(fullContent) ? (
        <ContentWithMarkdown
          content={fullContent}
          isStreaming={false}
          codeBlockWidth={agentMarkdownOptions.codeBlockWidth}
          palette={agentMarkdownOptions.palette}
        />
      ) : (
        <text fg={theme.foreground} style={{ wrapMode: 'word' }}>
          {fullContent}
        </text>
      )
    ) : null
    const renderableDisplayContent = (
      <box style={{ flexDirection: 'column', width: '100%', gap: 1 }}>
        {fallbackFailure ? (
          <text fg={theme.error} style={{ wrapMode: 'word' }}>
            {fallbackFailure}
          </text>
        ) : null}
        {resultContent}
        {structuredOutput !== undefined ? (
          <StructuredResult value={structuredOutput} />
        ) : null}
        {inputContent !== undefined ? (
          <box style={{ flexDirection: 'column', width: '100%' }}>
            <text fg={theme.muted}>Input</text>
            <StructuredResult value={inputContent} />
            <Button
              onClick={() =>
                useOutputReaderStore.getState().open({
                  document: createJsonDocument(
                    `tool:${toolBlock.toolCallId}:input`,
                    'Submitted input · captured request',
                    inputContent,
                  ),
                })
              }
            >
              <text fg={theme.muted}>Inspect input</text>
            </Button>
          </box>
        ) : null}
      </box>
    )

    const readableName = cleanPreviewText(
      humanizeFieldName(displayInfo.name),
    ).replace(/\s+/g, ' ')
    const headerName =
      readableName.charAt(0).toUpperCase() + readableName.slice(1)

    const handleToggle = useCallback(() => {
      onToggleCollapsed(toolBlock.toolCallId)
    }, [onToggleCollapsed, toolBlock.toolCallId])

    return (
      <box
        key={keyPrefix}
        style={{
          flexDirection: 'column',
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        <ToolCallItem
          name={toolRenderConfig?.displayName ?? headerName}
          content={
            <InlineResultScope
              messageId={messageId ?? keyPrefix}
              scope={`tool:${toolBlock.toolCallId}`}
            >
              {toolRenderConfig?.content ?? renderableDisplayContent}
            </InlineResultScope>
          }
          isCollapsed={isCollapsed}
          isStreaming={isStreaming}
          streamingPreview={streamingPreview}
          finishedPreview={
            toolRenderConfig?.collapsedPreview ?? finishedPreview
          }
          onToggle={handleToggle}
          titleSuffix={undefined}
          availableWidth={availableWidth}
        />
        {!isCollapsed &&
          (toolBlock.outputRaw !== undefined ||
            toolBlock.output !== undefined) && (
            <InspectAction
              label="Inspect captured output"
              onClick={() =>
                useOutputReaderStore
                  .getState()
                  .open({ document: documentForTool(toolBlock) })
              }
            />
          )}
      </box>
    )
  },
)
