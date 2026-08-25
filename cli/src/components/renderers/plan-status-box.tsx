import { memo } from 'react'

import { HarnessBox } from './harness-box'
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

const getBadgeColor = (status: string, theme: ReturnType<typeof useTheme>): string => {
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
            const badgeLabel = `[${session.status}]`
            const badgeColor = getBadgeColor(session.status, theme)
            const activeMarker = session.isActive ? ' * ' : '   '
            const progress =
              session.progress.total > 0
                ? ` ${session.progress.done}/${session.progress.total} done`
                : ''
            const current = session.currentTask ? `  current: "${session.currentTask}"` : ''
            return (
              <text key={session.slug} style={{ wrapMode: 'word', fg: theme.foreground }}>
                <text style={{ fg: theme.muted }}>{activeMarker}</text>
                <text style={{ fg: badgeColor }}>{`${badgeLabel} `}</text>
                <text style={{ fg: theme.foreground }}>{`${session.slug}${progress}`}</text>
                {current ? <text style={{ fg: theme.muted }}>{current}</text> : null}
              </text>
            )
          })}
        </box>
      ) : (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {lines.map((line, idx) => {
            const badgeMatch = line.match(/\[(active|paused|completed|archived)\]/)
            if (badgeMatch) {
              const status = badgeMatch[1]
              const badgeColor = getBadgeColor(status, theme)
              const badge = badgeMatch[0]
              const badgeIndex = line.indexOf(badge)
              const before = line.slice(0, badgeIndex)
              const after = line.slice(badgeIndex + badge.length)
              return (
                <text key={`line-${idx}`} style={{ wrapMode: 'word', fg: theme.foreground }}>
                  {before ? <text style={{ fg: theme.foreground }}>{before}</text> : null}
                  <text style={{ fg: badgeColor }}>{badge}</text>
                  {after ? <text style={{ fg: theme.foreground }}>{after}</text> : null}
                </text>
              )
            }
            const isCurrentTask = line.trimStart().startsWith('current:')
            return (
              <text
                key={`line-${idx}`}
                style={{ wrapMode: 'word', fg: isCurrentTask ? theme.muted : theme.foreground }}
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
