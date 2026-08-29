import { memo, useState } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'
import { BORDER_CHARS } from '../../utils/ui-constants'
import { Button } from '../button'
import { CollapseButton } from '../collapse-button'
import { formatAge, pluralizeEntries } from '../../utils/format-helpers'

import type { MemoryContentBlock } from '../../types/chat'

interface MemoryBoxProps {
  block: MemoryContentBlock
  onInsertCommand?: (command: string) => void
}

const statusColorForTone = (
  tone: 'success' | 'error' | 'warning' | 'secondary',
  theme: ReturnType<typeof useTheme>,
) => {
  switch (tone) {
    case 'success':
      return theme.success
    case 'error':
      return theme.error
    case 'warning':
      return theme.warning
    case 'secondary':
      return theme.secondary
  }
}

export const MemoryBox = memo(
  ({ block, onInsertCommand = () => {} }: MemoryBoxProps) => {
    const theme = useTheme()
    const [hoveredPrune, setHoveredPrune] = useState(false)
    const [goalExpanded, setGoalExpanded] = useState(false)
    const [staleExpanded, setStaleExpanded] = useState(false)

    if (block.state === 'empty') {
      return (
        <HarnessBox tone="secondary" gap={1} paddingBottom={1}>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            No persisted task memory for this project yet.
          </text>
          <text style={{ wrapMode: 'word', fg: theme.muted }}>
            It is written after your first successful run completes.
          </text>
        </HarnessBox>
      )
    }

    if (block.state === 'status') {
      const ageText = formatAge(Math.max(0, Date.now() - block.updatedAt))
      const header = `${block.revision} · ${ageText}`
      const staleTone: 'success' | 'warning' | 'error' =
        block.evidence.stale > 0
          ? block.evidence.fresh === 0
            ? 'error'
            : 'warning'
          : 'success'
      const tone: 'success' | 'warning' | 'error' | 'secondary' =
        block.evidence.stale > 0 ? staleTone : 'success'
      const goalText =
        block.isGoalTruncated && goalExpanded && block.goal
          ? block.goal
          : block.goalPreview
      const staleHeader = `Stale paths (${block.totalStaleCount})` // N via totalStaleCount, slice capped at STALE_PATHS_SHOWN in command

      return (
        <HarnessBox tone={tone} title={header} gap={1} paddingBottom={1}>
          <box style={{ flexDirection: 'column', gap: 0 }}>
            <text style={{ wrapMode: 'word', fg: theme.secondary }}>Goal</text>
            <text style={{ wrapMode: 'word', fg: theme.foreground }}>
              {goalText}
            </text>
            {block.isGoalTruncated ? (
              goalExpanded ? (
                <CollapseButton onClick={() => setGoalExpanded(false)} />
              ) : (
                <Button
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: 0,
                  }}
                  onClick={() => setGoalExpanded(true)}
                >
                  <text style={{ fg: theme.secondary, wrapMode: 'none' }}>
                    ▾ Expand
                  </text>
                </Button>
              )
            ) : null}
          </box>
          <box style={{ flexDirection: 'column', gap: 0 }}>
            <text style={{ wrapMode: 'word', fg: theme.foreground }}>
              <span
                style={{ fg: theme.foreground }}
              >{`Decisions: ${block.counts.decisions}`}</span>
              <span style={{ fg: theme.muted }}>{' \u00B7 '}</span>
              <span
                style={{ fg: theme.foreground }}
              >{`Requirements: ${block.counts.requirements}`}</span>
              <span style={{ fg: theme.muted }}>{' \u00B7 '}</span>
              <span
                style={{ fg: theme.foreground }}
              >{`Edits: ${block.counts.editsMade}`}</span>
            </text>
            <text style={{ wrapMode: 'word', fg: theme.foreground }}>
              <span
                style={{ fg: theme.foreground }}
              >{`Validations: ${block.counts.validationResults}`}</span>
              <span style={{ fg: theme.muted }}>{' \u00B7 '}</span>
              <span
                style={{ fg: theme.foreground }}
              >{`Blockers: ${block.counts.blockers}`}</span>
              <span style={{ fg: theme.muted }}>{' \u00B7 '}</span>
              <span
                style={{ fg: theme.foreground }}
              >{`Next actions: ${block.counts.nextActions}`}</span>
            </text>
          </box>
          <box style={{ flexDirection: 'row', gap: 1 }}>
            <text style={{ wrapMode: 'word', fg: theme.foreground }}>
              <span style={{ fg: theme.secondary }}>Evidence:</span>
              <span
                style={{ fg: statusColorForTone('success', theme) }}
              >{` ${block.evidence.fresh} fresh`}</span>
              <span style={{ fg: theme.muted }}>{', '}</span>
              <span
                style={{ fg: statusColorForTone(staleTone, theme) }}
              >{`${block.evidence.stale} stale`}</span>
              <span
                style={{ fg: theme.muted }}
              >{` (of ${block.evidence.total})`}</span>
            </text>
          </box>
          {block.totalStaleCount > 0 ? (
            staleExpanded ? (
              <box style={{ flexDirection: 'column', gap: 0 }}>
                <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
                  {staleHeader}
                </text>
                {block.stalePaths.map((p, idx) => (
                  <text
                    key={`${p}-${idx}`}
                    style={{ wrapMode: 'word', fg: theme.foreground }}
                  >
                    {p}
                  </text>
                ))}
                {block.totalStaleCount > block.stalePaths.length ? (
                  <text
                    style={{ fg: theme.muted, wrapMode: 'word' }}
                  >{`+ ${block.totalStaleCount - block.stalePaths.length} more`}</text>
                ) : null}
                <CollapseButton onClick={() => setStaleExpanded(false)} />
              </box>
            ) : (
              <Button
                style={{
                  flexDirection: 'row',
                  paddingLeft: 1,
                  paddingRight: 1,
                  borderStyle: 'single',
                  borderColor: theme.secondary,
                  customBorderChars: BORDER_CHARS,
                  alignSelf: 'flex-start',
                }}
                onClick={() => setStaleExpanded(true)}
              >
                <text
                  style={{ fg: theme.secondary, wrapMode: 'none' }}
                >{`▾ ${staleHeader}`}</text>
              </Button>
            )
          ) : null}
          {block.evidence.stale > 0 ? (
            <Button
              style={{
                flexDirection: 'row',
                paddingLeft: 1,
                paddingRight: 1,
                borderStyle: 'single',
                borderColor: hoveredPrune ? theme.foreground : theme.secondary,
                customBorderChars: BORDER_CHARS,
                alignSelf: 'flex-start',
              }}
              onClick={() => onInsertCommand('/memory prune')}
              onMouseOver={() => setHoveredPrune(true)}
              onMouseOut={() => setHoveredPrune(false)}
            >
              <text style={{ fg: theme.secondary, wrapMode: 'none' }}>
                Run /memory prune to drop stale evidence entries.
              </text>
            </Button>
          ) : null}
        </HarnessBox>
      )
    }

    if (block.state === 'pruned') {
      return (
        <HarnessBox tone="success" gap={1} paddingBottom={1}>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            {`Pruned ${block.removed} stale evidence ${pluralizeEntries(block.removed)}; ${block.remaining} remain.`}
          </text>
        </HarnessBox>
      )
    }

    if (block.state === 'nothing-to-prune') {
      return (
        <HarnessBox tone="success" gap={1} paddingBottom={1}>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            {`Nothing to prune: all ${block.remaining} evidence entries are fresh.`}
          </text>
        </HarnessBox>
      )
    }

    if (block.state === 'no-record') {
      return (
        <HarnessBox tone="secondary" gap={1} paddingBottom={1}>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            No persisted task memory to prune for this project.
          </text>
        </HarnessBox>
      )
    }

    if (block.state === 'failed') {
      return (
        <HarnessBox tone="error" gap={1} paddingBottom={1}>
          <text
            style={{ wrapMode: 'word', fg: theme.error }}
          >{`Memory prune failed: ${block.cause}.`}</text>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            {`The record is unchanged: ${block.removed} stale evidence ${pluralizeEntries(block.removed)} still present (${block.remaining} fresh).`}
          </text>
        </HarnessBox>
      )
    }

    // error state
    return (
      <HarnessBox tone="error" gap={1} paddingBottom={1}>
        <text style={{ wrapMode: 'word', fg: theme.error }}>
          {block.message}
        </text>
      </HarnessBox>
    )
  },
)
