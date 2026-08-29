import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { formatPlanSessionListRow } from '../../commands/plan-artifacts'
import { useTheme } from '../../hooks/use-theme'

import type { PlanStatusContentBlock } from '../../types/chat'

interface PlanStatusBoxProps {
  block: PlanStatusContentBlock
}

const STATUS_BADGE_COLOR: Record<string, string> = {
  active: 'success',
  paused: 'warning',
  completed: 'secondary',
  archived: 'muted',
}

const getBadgeColor = (
  status: string,
  theme: ReturnType<typeof useTheme>,
): string => {
  const tone = STATUS_BADGE_COLOR[status] ?? 'secondary'
  if (tone === 'success') return theme.success
  if (tone === 'warning') return theme.warning
  if (tone === 'muted') return theme.muted
  return theme.secondary
}

export const PlanStatusBox = memo(({ block }: PlanStatusBoxProps) => {
  const theme = useTheme()
  const isList = block.mode === 'list'
  const title = isList ? 'Plan sessions' : 'Plan status'
  const lines = block.reportText ? block.reportText.split('\n') : []
  const sessions = block.sessions ?? []

  return (
    <HarnessBox tone="secondary" title={title} gap={1} paddingBottom={1}>
      {isList && sessions.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {sessions.map((session) => {
            // Shared with the /plans text report so the two cannot drift.
            const row = formatPlanSessionListRow(session)
            const badgeColor = getBadgeColor(session.status, theme)
            return (
              <text
                key={session.slug}
                style={{ wrapMode: 'word', fg: theme.foreground }}
              >
                <span style={{ fg: theme.muted }}>{row.activeMarker}</span>
                <span style={{ fg: badgeColor }}>{`${row.badge} `}</span>
                <span style={{ fg: theme.foreground }}>{row.label}</span>
                {row.current ? (
                  <span style={{ fg: theme.muted }}>{row.current}</span>
                ) : null}
              </text>
            )
          })}
        </box>
      ) : (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {lines.map((line, idx) => {
            const badgeMatch = line.match(
              /\[(active|paused|completed|archived)\]/,
            )
            if (badgeMatch) {
              const status = badgeMatch[1]
              const badgeColor = getBadgeColor(status, theme)
              const badge = badgeMatch[0]
              const badgeIndex = line.indexOf(badge)
              const before = line.slice(0, badgeIndex)
              const after = line.slice(badgeIndex + badge.length)
              return (
                <text
                  key={`line-${idx}`}
                  style={{ wrapMode: 'word', fg: theme.foreground }}
                >
                  {before ? (
                    <span style={{ fg: theme.foreground }}>{before}</span>
                  ) : null}
                  <span style={{ fg: badgeColor }}>{badge}</span>
                  {after ? (
                    <span style={{ fg: theme.foreground }}>{after}</span>
                  ) : null}
                </text>
              )
            }
            const isCurrentTask = line.trimStart().startsWith('current:')
            return (
              <text
                key={`line-${idx}`}
                style={{
                  wrapMode: 'word',
                  fg: isCurrentTask ? theme.muted : theme.foreground,
                }}
              >
                {line.length > 0 ? line : ' '}
              </text>
            )
          })}
        </box>
      )}
    </HarnessBox>
  )
})
