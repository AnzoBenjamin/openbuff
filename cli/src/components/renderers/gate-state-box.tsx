import { memo } from 'react'

import { useTheme } from '../../hooks/use-theme'
import { HarnessBox } from './harness-box'

import type { GateStateContentBlock, GateStateStatus } from '../../types/chat'

interface GateStateBoxProps {
  block: GateStateContentBlock
}

const STATUS_LABEL: Record<GateStateStatus, string> = {
  pending: 'PENDING',
  passed: 'PASSED',
  failed: 'FAILED',
  skipped: 'SKIPPED',
}

const STATUS_ICON: Record<GateStateStatus, string> = {
  pending: '…',
  passed: '✓',
  failed: '✗',
  skipped: '–',
}

const STATUS_TONE: Record<
  GateStateStatus,
  'success' | 'error' | 'warning' | 'secondary'
> = {
  pending: 'warning',
  passed: 'success',
  failed: 'error',
  skipped: 'secondary',
}

/**
 * Renders a parsed `<gate-state>` block.
 *
 * PUBLISHED BLOCK SCHEMA (the rendered surface of the consumer contract
 * declared on `GateStateContentBlock` in cli/src/types/chat.ts): `gate` and
 * `status` are required; `details`, `origin`, `advisories`, and `workflow` are
 * optional and additive. Rendered order is details -> `workflow` (declared
 * write_todos progress remaining on a PASSING gate, warning tone) ->
 * `advisories` (non-blocking reviewer observations, secondary tone). Keep this
 * list, the type, and the parser docblock in step when the producer adds a key.
 */
export const GateStateBox = memo(({ block }: GateStateBoxProps) => {
  const theme = useTheme()
  const color = theme[STATUS_TONE[block.gateStatus]]
  const heading = `${STATUS_ICON[block.gateStatus]} ${block.origin?.trim() || 'Gate'} · ${block.gate} · ${STATUS_LABEL[block.gateStatus]}`

  return (
    <HarnessBox
      tone={STATUS_TONE[block.gateStatus]}
      title={heading}
      gap={0}
      paddingBottom={0}
    >
      {block.gateStatus === 'skipped' ? (
        <text
          style={{
            wrapMode: 'word',
            fg: color,
          }}
        >
          SKIPPED — gate intentionally not run
        </text>
      ) : null}
      {block.details ? (
        <text
          style={{
            wrapMode: 'word',
            fg: theme.foreground,
          }}
        >
          {block.details}
        </text>
      ) : null}
      {block.workflow ? (
        <>
          <text
            style={{
              wrapMode: 'word',
              fg: theme.warning,
            }}
          >
            {`Declared workflow: ${block.workflow.completedCount}/${block.workflow.totalCount} complete — ${block.workflow.totalCount - block.workflow.completedCount} remaining`}
          </text>
          <text
            style={{
              wrapMode: 'word',
              fg: theme.warning,
            }}
          >
            {`Next: ${block.workflow.nextWorkflowAction}`}
          </text>
        </>
      ) : null}
      {block.advisories && block.advisories.length > 0 ? (
        <>
          <text
            style={{
              wrapMode: 'word',
              fg: theme.secondary,
            }}
          >
            Advisory (non-blocking):
          </text>
          {block.advisories.map((advisory, index) => (
            <text
              key={`${index}-${advisory}`}
              style={{
                wrapMode: 'word',
                fg: theme.secondary,
              }}
            >
              {`• ${advisory}`}
            </text>
          ))}
        </>
      ) : null}
    </HarnessBox>
  )
})
