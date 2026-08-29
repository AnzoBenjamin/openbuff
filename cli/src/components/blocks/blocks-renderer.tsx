import React, { memo, useMemo, useRef, type ReactNode } from 'react'

import { AgentBlockGrid } from './agent-block-grid'
import { AgentBranchWrapper } from './agent-branch-wrapper'
import { ImageBlock } from './image-block'
import { ImplementorGroup } from './implementor-row'
import { SingleBlock } from './single-block'
import { ThinkingBlock } from './thinking-block'
import { ToolBlockGroup } from './tool-block-group'
import { useTheme } from '../../hooks/use-theme'
import {
  processBlocks,
  type BlockProcessorHandlers,
} from '../../utils/block-processor'
import { ErrorBoundary } from '../error-boundary'

import type { ContentBlock } from '../../types/chat'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

interface BlocksRendererProps {
  sourceBlocks: ContentBlock[]
  messageId: string
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

/** Props stored in ref for stable handler access */
interface BlocksRendererPropsRef {
  sourceBlocks: ContentBlock[]
  messageId: string
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
  lastTextBlockIndex: number
}

/** Stands in for a block whose render threw. */
const BlockRenderFallback = memo(({ label }: { label: string }) => {
  const theme = useTheme()
  return (
    <text
      style={{ wrapMode: 'word', fg: theme.error }}
    >{`Could not render this ${label} block.`}</text>
  )
})

/**
 * Wrap one rendered block (or block group) so a render throw stays local.
 *
 * OpenTUI rejects some element nestings when it commits the tree — a `<text>`
 * inside a `<text>`, for example — and a throw that reaches `@opentui/react`'s
 * root error boundary replaces the WHOLE app with that boundary's fallback,
 * which a production React build paints as nothing at all: the terminal goes
 * blank, message list, status line and input bar included. Blocks are persisted
 * to chat-messages.json and re-rendered when the session is reopened, so one bad
 * block would blank that session permanently. A boundary per block degrades the
 * same failure to a single visible line while the rest of the app keeps working.
 */
const isolateBlock = (
  key: string,
  label: string,
  node: ReactNode,
): ReactNode => (
  <ErrorBoundary
    key={key}
    componentName={`BlocksRenderer(${label})`}
    fallback={<BlockRenderFallback label={label} />}
  >
    {node}
  </ErrorBoundary>
)

export const BlocksRenderer = memo(
  ({
    sourceBlocks,
    messageId,
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
  }: BlocksRendererProps) => {
    const lastTextBlockIndex = contentToCopy
      ? sourceBlocks.reduceRight(
          (acc, block, idx) =>
            acc === -1 && block.type === 'text' ? idx : acc,
          -1,
        )
      : -1

    // Store props in ref for stable handler access (avoids 17 useMemo dependencies)
    const propsRef = useRef<BlocksRendererPropsRef>(null!)
    propsRef.current = {
      sourceBlocks,
      messageId,
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
      lastTextBlockIndex,
    }

    // Handlers are stable (empty deps) and read latest props from ref
    const handlers: BlockProcessorHandlers = useMemo(
      () => ({
        onReasoningGroup: (reasoningBlocks, startIndex) => {
          const p = propsRef.current
          return isolateBlock(
            reasoningBlocks[0]?.thinkingId ??
              `${p.messageId}-thinking-${startIndex}`,
            'thinking',
            <ThinkingBlock
              blocks={reasoningBlocks}
              onToggleCollapsed={p.onToggleCollapsed}
              availableWidth={p.availableWidth}
              isNested={false}
              isMessageComplete={p.isComplete ?? false}
            />,
          )
        },

        onImageBlock: (block, index) => {
          const p = propsRef.current
          return isolateBlock(
            `${p.messageId}-image-${index}`,
            'image',
            <ImageBlock block={block} availableWidth={p.availableWidth} />,
          )
        },

        onToolGroup: (toolBlocks, startIndex, nextIndex) => {
          const p = propsRef.current
          return isolateBlock(
            `${p.messageId}-tool-group-${startIndex}`,
            'tool',
            <ToolBlockGroup
              toolBlocks={toolBlocks}
              keyPrefix={p.messageId}
              startIndex={startIndex}
              nextIndex={nextIndex}
              siblingBlocks={p.sourceBlocks}
              availableWidth={p.availableWidth}
              onToggleCollapsed={p.onToggleCollapsed}
              markdownPalette={p.markdownPalette}
            />,
          )
        },

        onImplementorGroup: (implementors, startIndex) => {
          const p = propsRef.current
          return isolateBlock(
            `${p.messageId}-implementor-group-${startIndex}`,
            'implementor',
            <ImplementorGroup
              implementors={implementors}
              siblingBlocks={p.sourceBlocks}
              availableWidth={p.availableWidth}
            />,
          )
        },

        onAgentGroup: (agentBlocks, startIndex) => {
          const p = propsRef.current
          return isolateBlock(
            `${p.messageId}-agent-grid-${startIndex}`,
            'agent',
            <AgentBlockGrid
              agentBlocks={agentBlocks}
              keyPrefix={`${p.messageId}-agent-grid-${startIndex}`}
              availableWidth={p.availableWidth}
              renderAgentBranch={(agentBlock, prefix, width) => (
                <AgentBranchWrapper
                  agentBlock={agentBlock}
                  keyPrefix={prefix}
                  availableWidth={width}
                  markdownPalette={p.markdownPalette}
                  onToggleCollapsed={p.onToggleCollapsed}
                  onBuildFast={p.onBuildFast}
                  onInsertCommand={p.onInsertCommand}
                  siblingBlocks={p.sourceBlocks}
                  isLastMessage={p.isLastMessage}
                />
              )}
            />,
          )
        },

        onSingleBlock: (block, index) => {
          const p = propsRef.current
          return isolateBlock(
            `${p.messageId}-block-${index}`,
            block.type,
            <SingleBlock
              block={block}
              idx={index}
              messageId={p.messageId}
              blocks={p.sourceBlocks}
              isLoading={p.isLoading}
              isComplete={p.isComplete}
              isUser={p.isUser}
              textColor={p.textColor}
              availableWidth={p.availableWidth}
              markdownPalette={p.markdownPalette}
              onToggleCollapsed={p.onToggleCollapsed}
              onBuildFast={p.onBuildFast}
              onInsertCommand={p.onInsertCommand}
              isLastMessage={p.isLastMessage}
              contentToCopy={
                index === p.lastTextBlockIndex ? p.contentToCopy : undefined
              }
            />,
          )
        },
      }),
      [], // Empty deps - handlers read from propsRef.current
    )

    return <>{processBlocks(sourceBlocks, handlers)}</>
  },
)
