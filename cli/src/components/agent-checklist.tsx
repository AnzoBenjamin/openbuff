import { pluralize } from '@codebuff/common/util/string'
import { TextAttributes } from '@opentui/core'
import React, { useMemo, useRef, useEffect, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { getSimpleAgentId } from '../utils/agent-id-utils'

import type { LocalAgentInfo } from '../utils/local-agent-registry'
import type { ScrollBoxRenderable } from '@opentui/core'

const SYMBOLS = {
  CHECKBOX_CHECKED: '☑',
  CHECKBOX_UNCHECKED: '☐',
} as const

export type VisibleAgentRow =
  | { kind: 'agent'; key: string; agent: LocalAgentInfo }
  | {
      kind: 'dependency'
      key: string
      agentId: string
      displayName: string
      depth: number
      isLast: boolean
      reference?: 'shared' | 'cycle' | 'limited'
    }

export function countDependencies(
  agentId: string,
  agentDefinitions: Map<string, { spawnableAgents?: string[] }>,
  localAgentIds: Set<string>,
): number {
  const visited = new Set([agentId])
  const stack = [agentId]
  while (stack.length) {
    const parent = stack.pop()!
    for (const id of agentDefinitions.get(parent)?.spawnableAgents ?? []) {
      const child = getSimpleAgentId(id)
      if (localAgentIds.has(child) && !visited.has(child)) {
        visited.add(child)
        stack.push(child)
      }
    }
  }
  return visited.size - 1
}

/** Expand each unique dependency once; repeated DAG edges stay short links. */
export function buildVisibleAgentRows(params: {
  allAgents: LocalAgentInfo[]
  filteredAgents: LocalAgentInfo[]
  agentDefinitions: Map<string, { spawnableAgents?: string[] }>
  expandedAgentIds: Set<string>
  maxDependencyRows?: number
}): VisibleAgentRow[] {
  const agents = new Map(params.allAgents.map((agent) => [agent.id, agent]))
  const rows: VisibleAgentRow[] = []
  const limit = Math.max(1, Math.min(2000, params.maxDependencyRows ?? 2000))
  for (const agent of params.filteredAgents) {
    rows.push({ kind: 'agent', key: agent.id, agent })
    if (!params.expandedAgentIds.has(agent.id)) continue
    const seen = new Set([agent.id])
    const ancestors = new Set([agent.id])
    type Frame = {
      id: string
      children: readonly string[]
      index: number
      depth: number
    }
    const stack: Frame[] = [
      {
        id: agent.id,
        children: params.agentDefinitions.get(agent.id)?.spawnableAgents ?? [],
        index: 0,
        depth: 0,
      },
    ]
    let emitted = 0
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.index >= frame.children.length) {
        ancestors.delete(frame.id)
        stack.pop()
        continue
      }
      const index = frame.index++
      const id = getSimpleAgentId(frame.children[index])
      const child = agents.get(id)
      if (!child) continue
      if (emitted >= limit) {
        rows.push({
          kind: 'dependency',
          key: `${agent.id}:limit`,
          agentId: agent.id,
          displayName:
            'Dependency link limit reached; expand a specific agent to inspect its links',
          depth: 0,
          isLast: true,
          reference: 'limited',
        })
        break
      }
      const reference = ancestors.has(id)
        ? 'cycle'
        : seen.has(id)
          ? 'shared'
          : undefined
      rows.push({
        kind: 'dependency',
        key: `${agent.id}:${frame.id}:${id}:${index}`,
        agentId: id,
        displayName: child.displayName,
        depth: Math.min(frame.depth, 12),
        isLast: frame.index === frame.children.length,
        reference,
      })
      emitted++
      if (!reference) {
        seen.add(id)
        ancestors.add(id)
        stack.push({
          id,
          children: params.agentDefinitions.get(id)?.spawnableAgents ?? [],
          index: 0,
          depth: frame.depth + 1,
        })
      }
    }
  }
  return rows
}

interface AgentChecklistProps {
  /** All agents (used for dependency tree calculations) */
  allAgents: LocalAgentInfo[]
  /** Agents filtered by search query (displayed in the list) */
  filteredAgents: LocalAgentInfo[]
  selectedIds: Set<string>
  searchQuery: string
  focusedIndex: number
  onToggleAgent: (agentId: string) => void
  onFocusChange: (index: number) => void
  onVisibleRowsChange?: (agentIds: string[]) => void
  agentDefinitions: Map<string, { spawnableAgents?: string[] }>
  maxHeight?: number
}

export const AgentChecklist: React.FC<AgentChecklistProps> = ({
  allAgents,
  filteredAgents,
  selectedIds,
  searchQuery,
  focusedIndex,
  onToggleAgent,
  onFocusChange,
  onVisibleRowsChange,
  agentDefinitions,
  maxHeight = 8,
}) => {
  const theme = useTheme()
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(
    new Set(),
  )
  const [hoveredSubagentLink, setHoveredSubagentLink] = useState<string | null>(
    null,
  )

  // Precompute local agent IDs for dependency calculations
  const localAgentIds = useMemo(
    () => new Set(allAgents.map((a) => a.id)),
    [allAgents],
  )

  // Calculate dependency count for each agent
  const dependencyCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const agent of filteredAgents) {
      const count = countDependencies(agent.id, agentDefinitions, localAgentIds)
      counts.set(agent.id, count)
    }
    return counts
  }, [filteredAgents, agentDefinitions, localAgentIds])

  const visibleRows = useMemo(
    () =>
      buildVisibleAgentRows({
        allAgents,
        filteredAgents,
        agentDefinitions,
        expandedAgentIds,
      }),
    [agentDefinitions, allAgents, expandedAgentIds, filteredAgents],
  )

  useEffect(() => {
    onVisibleRowsChange?.(
      visibleRows.map((row) =>
        row.kind === 'agent' ? row.agent.id : row.agentId,
      ),
    )
    if (focusedIndex >= visibleRows.length) {
      onFocusChange(Math.max(0, visibleRows.length - 1))
    }
  }, [focusedIndex, onFocusChange, onVisibleRowsChange, visibleRows])

  // Toggle expansion of an agent's dependencies
  const toggleExpanded = (agentId: string) => {
    setExpandedAgentIds((prev) => {
      const next = new Set(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        next.add(agentId)
      }
      return next
    })
  }

  // Scroll focused item into view when focus changes via keyboard
  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox || visibleRows.length === 0) return

    const itemHeight = 1
    const focusedTop = Math.max(0, focusedIndex) * itemHeight
    const focusedBottom = focusedTop + itemHeight

    const viewportHeight = scrollbox.viewport.height
    const currentScroll = scrollbox.scrollTop

    // Scroll up if focused item is above viewport
    if (focusedTop < currentScroll) {
      scrollbox.scrollTop = focusedTop
    }
    // Scroll down if focused item is below viewport
    else if (focusedBottom > currentScroll + viewportHeight) {
      scrollbox.scrollTop = focusedBottom - viewportHeight
    }
  }, [focusedIndex, visibleRows.length, maxHeight])

  if (filteredAgents.length === 0) {
    return (
      <box style={{ paddingLeft: 1, paddingTop: 1 }}>
        <text style={{ fg: theme.muted, attributes: TextAttributes.ITALIC }}>
          {searchQuery ? 'No agents match your search' : 'No agents available'}
        </text>
      </box>
    )
  }

  const needsScroll = visibleRows.length > maxHeight

  return (
    <box style={{ flexDirection: 'column', gap: 0 }}>
      <scrollbox
        ref={scrollRef}
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          visible: needsScroll,
          trackOptions: { width: 1 },
        }}
        style={{
          height: maxHeight,
          rootOptions: {
            flexDirection: 'row',
            backgroundColor: 'transparent',
          },
          wrapperOptions: {
            border: false,
            backgroundColor: 'transparent',
            flexDirection: 'column',
          },
          contentOptions: {
            flexDirection: 'column',
            gap: 0,
            backgroundColor: 'transparent',
          },
        }}
      >
        {visibleRows.map((row, rowIndex) => {
          if (row.kind === 'dependency') {
            const isSelected = selectedIds.has(row.agentId)
            const isFocused = rowIndex === focusedIndex
            const symbol = isSelected
              ? SYMBOLS.CHECKBOX_CHECKED
              : SYMBOLS.CHECKBOX_UNCHECKED
            const displayText =
              row.displayName !== row.agentId
                ? `${row.displayName} (${row.agentId})`
                : row.displayName
            return (
              <Button
                key={row.key}
                onClick={() => {
                  onFocusChange(rowIndex)
                  onToggleAgent(row.agentId)
                }}
                style={{
                  flexDirection: 'row',
                  gap: 1,
                  backgroundColor: isFocused ? theme.surface : 'transparent',
                  paddingLeft: row.depth * 3 + 3,
                  paddingRight: 1,
                  paddingTop: 0,
                  paddingBottom: 0,
                }}
              >
                <text style={{ fg: theme.muted }}>
                  {row.isLast ? '└─' : '├─'}
                </text>
                <text
                  style={{
                    fg: isSelected
                      ? theme.success
                      : isFocused
                        ? theme.foreground
                        : theme.muted,
                    attributes: isFocused ? TextAttributes.BOLD : undefined,
                  }}
                >
                  {symbol}{' '}
                  {row.reference === 'shared'
                    ? 'shared · '
                    : row.reference === 'cycle'
                      ? 'cycle · '
                      : ''}
                  {displayText}
                </text>
              </Button>
            )
          }

          const { agent } = row
          const idx = rowIndex
          const isSelected = selectedIds.has(agent.id)
          const isFocused = idx === focusedIndex
          const isHovered = idx === hoveredIndex
          const isHighlighted = isFocused || isHovered
          const depCount = dependencyCounts.get(agent.id) ?? 0
          const isExpanded = expandedAgentIds.has(agent.id)
          const isSubagentLinkHovered = hoveredSubagentLink === agent.id
          const subagentLabel = `(${isExpanded ? '-' : '+'} ${pluralize(depCount, 'subagent')})`

          const symbol = isSelected
            ? SYMBOLS.CHECKBOX_CHECKED
            : SYMBOLS.CHECKBOX_UNCHECKED

          const displayText =
            agent.displayName !== agent.id
              ? `${agent.displayName} (${agent.id})`
              : agent.displayName

          return (
            <React.Fragment key={row.key}>
              <box
                style={{
                  flexDirection: 'row',
                  gap: 1,
                  backgroundColor: isHighlighted ? theme.surface : undefined,
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 0,
                  paddingBottom: 0,
                }}
              >
                {/* Checkbox and agent name - clickable to toggle selection */}
                <Button
                  onClick={() => {
                    onFocusChange(idx)
                    onToggleAgent(agent.id)
                  }}
                  onMouseOver={() => setHoveredIndex(idx)}
                  onMouseOut={() => setHoveredIndex(null)}
                  style={{
                    flexDirection: 'row',
                    gap: 1,
                    backgroundColor: 'transparent',
                    paddingLeft: 0,
                    paddingRight: 0,
                    paddingTop: 0,
                    paddingBottom: 0,
                  }}
                >
                  <text
                    style={{
                      fg: isSelected
                        ? theme.success
                        : isHighlighted
                          ? theme.foreground
                          : theme.muted,
                      attributes: isHighlighted
                        ? TextAttributes.BOLD
                        : undefined,
                    }}
                  >
                    {symbol}
                  </text>
                  <text
                    style={{
                      fg: isSelected
                        ? theme.success
                        : isHighlighted
                          ? theme.foreground
                          : theme.muted,
                      attributes: isHighlighted
                        ? TextAttributes.BOLD
                        : undefined,
                    }}
                  >
                    {displayText}
                  </text>
                </Button>

                {/* Subagent count - clickable to expand/collapse */}
                {depCount > 0 && (
                  <Button
                    onClick={() => toggleExpanded(agent.id)}
                    onMouseOver={() => setHoveredSubagentLink(agent.id)}
                    onMouseOut={() => setHoveredSubagentLink(null)}
                    style={{
                      backgroundColor: 'transparent',
                      paddingLeft: 0,
                      paddingRight: 0,
                      paddingTop: 0,
                      paddingBottom: 0,
                    }}
                  >
                    <text
                      style={{
                        fg: theme.secondary,
                        attributes: isSubagentLinkHovered
                          ? TextAttributes.UNDERLINE
                          : undefined,
                      }}
                    >
                      {subagentLabel}
                    </text>
                  </Button>
                )}
              </box>
            </React.Fragment>
          )
        })}
      </scrollbox>
    </box>
  )
}
