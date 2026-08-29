import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { DoctorContentBlock } from '../../types/chat'

interface DoctorBoxProps {
  block: DoctorContentBlock
}

export const DoctorBox = memo(({ block }: DoctorBoxProps) => {
  const theme = useTheme()
  const providerLines = block.providerStatus
    ? block.providerStatus.split('\n')
    : []
  const diagnostics = block.diagnostics.slice(0, 10)
  const agentsBadge = block.agentsTrusted
    ? 'trusted and enabled'
    : 'disabled (use --trust-project-agents to enable)'
  const skillsBadge = block.skillsTrusted
    ? 'trusted and enabled'
    : 'disabled with project-agent trust policy'

  return (
    <HarnessBox tone="secondary" title="Doctor" gap={1} paddingBottom={1}>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Project root:</span>
        <span style={{ fg: theme.foreground }}>{` ${block.projectRoot}`}</span>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Project agents:</span>
        <span
          style={{ fg: block.agentsTrusted ? theme.success : theme.warning }}
        >{` ${agentsBadge}`}</span>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Project skills:</span>
        <span
          style={{ fg: block.skillsTrusted ? theme.success : theme.warning }}
        >{` ${skillsBadge}`}</span>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Loaded skills:</span>
        <span style={{ fg: theme.foreground }}>{` ${block.skillCount}`}</span>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Loaded MCP servers:</span>
        <span style={{ fg: theme.foreground }}>{` ${block.mcpCount}`}</span>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Agent diagnostics:</span>
        <span
          style={{ fg: theme.foreground }}
        >{` ${block.diagnostics.length}`}</span>
      </text>
      {diagnostics.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {diagnostics.map((diagnostic, idx) => (
            <text
              key={`diagnostic-${idx}`}
              style={{ wrapMode: 'word', fg: theme.muted }}
            >
              {`- ${diagnostic.filePath || diagnostic.agentId}: ${diagnostic.message}`}
            </text>
          ))}
        </box>
      ) : null}
      {providerLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {providerLines.map((line, idx) => (
            <text
              key={`provider-${idx}`}
              style={{
                wrapMode: 'word',
                fg: line.length === 0 ? theme.foreground : theme.muted,
              }}
            >
              {line.length > 0 ? line : ' '}
            </text>
          ))}
        </box>
      ) : null}
    </HarnessBox>
  )
})
