import { TextAttributes } from '@opentui/core'
import React, { memo, type ReactNode } from 'react'

import { AgentBranchWrapper } from './agent-branch-wrapper'
import { AgentListBranch } from './agent-list-branch'
import { AskUserBranch } from './ask-user-branch'
import { trimNewlines, isReasoningTextBlock } from './block-helpers'
import { ContentWithMarkdown } from './content-with-markdown'
import { ImageBlock } from './image-block'
import { UserBlockTextWithInlineCopy } from './user-content-copy'
import { useTheme } from '../../hooks/use-theme'
import { CompactionBox } from '../renderers/compaction-box'
import { CompletionSummaryBox } from '../renderers/completion-summary-box'
import { ContextBox } from '../renderers/context-box'
import { DoctorBox } from '../renderers/doctor-box'
import { GateStateBox } from '../renderers/gate-state-box'
import { IndexStatusBox } from '../renderers/index-status-box'
import { InfoBox } from '../renderers/info-box'
import { MemoryBox } from '../renderers/memory-box'
import { PlanBox } from '../renderers/plan-box'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type { ContentBlock, TextContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface SingleBlockProps {
  block: ContentBlock
  idx: number
  messageId: string
  blocks?: ContentBlock[]
  isLoading: boolean
  isComplete?: boolean
  isUser: boolean
  textColor: string
  availableWidth: number
  markdownPalette: MarkdownPalette
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onInsertCommand: (command: string) => void
  isLastMessage?: boolean
  contentToCopy?: string
}

export const SingleBlock = memo(
  ({
    block,
    idx,
    messageId,
    blocks,
    isLoading,
    isComplete,
    isUser,
    textColor,
    availableWidth,
    markdownPalette,
    onToggleCollapsed,
    onBuildFast,
    onInsertCommand,
    isLastMessage,
    contentToCopy,
  }: SingleBlockProps): ReactNode => {
    const theme = useTheme()
    const codeBlockWidth = Math.max(10, availableWidth - 8)

    switch (block.type) {
      case 'text': {
        if (isReasoningTextBlock(block)) {
          return null
        }
        const textBlock = block as TextContentBlock
        const isStreamingText = isLoading || !isComplete
        const filteredContent = isStreamingText
          ? trimNewlines(textBlock.content)
          : textBlock.content.trim()
        if (!filteredContent) {
          return null
        }
        const renderKey = `${messageId}-text-${idx}`
        const explicitColor = textBlock.color
        const blockTextColor = explicitColor ?? textColor

        if (contentToCopy) {
          return (
            <UserBlockTextWithInlineCopy
              key={renderKey}
              content={filteredContent}
              contentToCopy={contentToCopy}
              isStreaming={isStreamingText}
              textColor={blockTextColor}
              codeBlockWidth={codeBlockWidth}
              palette={markdownPalette}
              marginTop={0}
              marginBottom={0}
            />
          )
        }

        return (
          <text
            key={renderKey}
            style={{
              wrapMode: 'word',
              fg: blockTextColor,
            }}
            attributes={isUser ? TextAttributes.ITALIC : undefined}
          >
            <ContentWithMarkdown
              content={filteredContent}
              isStreaming={isStreamingText}
              codeBlockWidth={codeBlockWidth}
              palette={markdownPalette}
            />
          </text>
        )
      }

      case 'plan': {
        return (
          <box key={`${messageId}-plan-${idx}`} style={{ width: '100%' }}>
            <PlanBox
              planContent={block.content}
              metadata={block.metadata}
              availableWidth={availableWidth}
              markdownPalette={markdownPalette}
              onBuildFast={onBuildFast}
              onInsertCommand={onInsertCommand}
            />
          </box>
        )
      }

      case 'gate-state': {
        return (
          <box key={`${messageId}-gate-state-${idx}`} style={{ width: '100%' }}>
            <GateStateBox block={block} />
          </box>
        )
      }

      case 'completion-summary': {
        return (
          <box
            key={`${messageId}-completion-summary-${idx}`}
            style={{ width: '100%' }}
          >
            <CompletionSummaryBox block={block} />
          </box>
        )
      }

      case 'compaction': {
        return (
          <box key={`${messageId}-compaction-${idx}`} style={{ width: '100%' }}>
            <CompactionBox block={block} />
          </box>
        )
      }

      case 'memory': {
        return (
          <box key={`${messageId}-memory-${idx}`} style={{ width: '100%' }}>
            <MemoryBox block={block} onInsertCommand={onInsertCommand} />
          </box>
        )
      }

      case 'context': {
        return (
          <box key={`${messageId}-context-${idx}`} style={{ width: '100%' }}>
            <ContextBox block={block} />
          </box>
        )
      }

      case 'info': {
        return (
          <box key={`${messageId}-info-${idx}`} style={{ width: '100%' }}>
            <InfoBox block={block} />
          </box>
        )
      }

      case 'doctor': {
        return (
          <box key={`${messageId}-doctor-${idx}`} style={{ width: '100%' }}>
            <DoctorBox block={block} />
          </box>
        )
      }

      case 'index-status': {
        return (
          <box
            key={`${messageId}-index-status-${idx}`}
            style={{ width: '100%' }}
          >
            <IndexStatusBox block={block} />
          </box>
        )
      }

      case 'plan-status':
      case 'plan-status-list': {
        return (
          <box
            key={`${messageId}-plan-status-${idx}`}
            style={{ width: '100%' }}
          >
            <PlanStatusBox block={block} />
          </box>
        )
      }

      case 'html': {
        return (
          <box
            key={`${messageId}-html-${idx}`}
            style={{
              flexDirection: 'column',
              gap: 0,
              width: '100%',
            }}
          >
            {block.render({ textColor, theme })}
          </box>
        )
      }

      case 'tool': {
        // Tool blocks are rendered via AgentBranchWrapper and dedicated tool renderers;
        // suppressing here is intentional to avoid duplicate top-level rendering.
        return null
      }

      case 'ask-user': {
        return (
          <AskUserBranch
            key={`${messageId}-ask-user-${idx}`}
            block={block}
            availableWidth={availableWidth}
          />
        )
      }

      case 'image': {
        return (
          <ImageBlock
            key={`${messageId}-image-${idx}`}
            block={block}
            availableWidth={availableWidth}
          />
        )
      }

      case 'agent': {
        return (
          <AgentBranchWrapper
            key={`${messageId}-agent-${block.agentId}`}
            agentBlock={block}
            keyPrefix={`${messageId}-agent-${block.agentId}`}
            availableWidth={availableWidth}
            markdownPalette={markdownPalette}
            onToggleCollapsed={onToggleCollapsed}
            onBuildFast={onBuildFast}
            onInsertCommand={onInsertCommand}
            siblingBlocks={blocks}
            isLastMessage={isLastMessage}
          />
        )
      }

      case 'agent-list': {
        return (
          <AgentListBranch
            key={`${messageId}-agent-list-${block.id}`}
            agentListBlock={block}
            keyPrefix={`${messageId}-agent-list-${block.id}`}
            onToggleCollapsed={onToggleCollapsed}
          />
        )
      }

      default:
        return null
    }
  },
)
