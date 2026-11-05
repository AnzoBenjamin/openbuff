import React, { memo, useCallback, useMemo } from 'react'

import { GridLayout } from '../grid-layout'
import { splitAgentsBySize } from '../../utils/block-processor'
import { ErrorBoundary } from '../error-boundary'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { createJsonDocument } from '../../utils/output-document'

function AgentView({
  block,
  prefix,
  width,
  render,
}: {
  block: AgentContentBlock
  prefix: string
  width: number
  render: AgentBlockGridProps['renderAgentBranch']
}) {
  return render(block, prefix, width)
}

import type { AgentContentBlock } from '../../types/chat'

export interface AgentBlockGridProps {
  agentBlocks: AgentContentBlock[]
  keyPrefix: string
  availableWidth: number
  renderAgentBranch: (
    agentBlock: AgentContentBlock,
    keyPrefix: string,
    availableWidth: number,
  ) => React.ReactNode
}

export const AgentBlockGrid = memo(
  ({
    agentBlocks,
    keyPrefix,
    availableWidth,
    renderAgentBranch,
  }: AgentBlockGridProps) => {
    const getItemKey = useCallback(
      (agentBlock: AgentContentBlock) => agentBlock.agentId,
      [],
    )

    const renderItem = useCallback(
      (agentBlock: AgentContentBlock, _idx: number, columnWidth: number) => (
        <ErrorBoundary
          componentName={`Agent(${agentBlock.agentId})`}
          fallback={
            <text>
              Could not render agent{' '}
              {agentBlock.agentName || agentBlock.agentId}.
            </text>
          }
          allowRetry
          onInspect={() =>
            useOutputReaderStore
              .getState()
              .open({
                document: createJsonDocument(
                  `${keyPrefix}:${agentBlock.agentId}:failed-view`,
                  'Captured agent source',
                  agentBlock,
                ),
              })
          }
        >
          <AgentView
            block={agentBlock}
            prefix={`${keyPrefix}-agent-${agentBlock.agentId}`}
            width={columnWidth}
            render={renderAgentBranch}
          />
        </ErrorBoundary>
      ),
      [keyPrefix, renderAgentBranch],
    )

    const subGroups = useMemo(
      () => splitAgentsBySize(agentBlocks),
      [agentBlocks],
    )

    if (agentBlocks.length === 0) return null

    return (
      <box
        style={{
          flexDirection: 'column',
          gap: 0,
          flexGrow: 0,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        {subGroups.map((group) => (
          <GridLayout
            key={getItemKey(group[0])}
            items={group}
            stableColumns
            availableWidth={availableWidth}
            getItemKey={getItemKey}
            renderItem={renderItem}
          />
        ))}
      </box>
    )
  },
)
