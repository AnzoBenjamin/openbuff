import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'
import { InlineResults } from '../tools/inline-results'
import { Button } from '../button'
import { capturedDiagnosticDocument } from '../../utils/captured-diagnostic-document'
import { useOutputReaderStore } from '../../state/output-reader-store'

import type { DoctorContentBlock } from '../../types/chat'
import type {
  DoctorCapabilityRow,
  DoctorCapabilityRowTone,
} from '../../utils/capability-tiers'

interface DoctorBoxProps {
  block: DoctorContentBlock
  onInsertCommand?: (command: string) => void
}

export const DoctorBox = memo(({ block, onInsertCommand }: DoctorBoxProps) => {
  const theme = useTheme()
  const providerLines = block.providerStatus
    ? block.providerStatus
        .split('\n')
        .filter((line) => line.trim() && line !== 'Openbuff provider status')
    : []
  const diagnostics = block.diagnostics
  const agentsBadge = block.agentsTrusted
    ? 'trusted and enabled'
    : 'disabled (use --trust-project-agents to enable)'
  const skillsBadge = block.skillsTrusted
    ? 'trusted and enabled'
    : 'disabled with project-agent trust policy'
  const capabilityRows = block.capabilities
  const capabilityToneFg: Record<
    DoctorCapabilityRowTone,
    typeof theme.foreground
  > = {
    default: theme.foreground,
    success: theme.success,
    warning: theme.warning,
    muted: theme.muted,
  }

  return (
    <HarnessBox tone="secondary" title="Doctor" gap={1} paddingBottom={1}>
      <text
        fg={diagnostics.length ? theme.warning : theme.foreground}
        style={{ wrapMode: 'word' }}
      >
        {diagnostics.length
          ? `${diagnostics.length} captured agent ${diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'} to review`
          : 'No agent diagnostics in this captured report.'}
      </text>
      <box style={{ flexDirection: 'column', gap: 0 }}>
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Project root:</span>
          <span
            style={{ fg: theme.foreground }}
          >{` ${block.projectRoot}`}</span>
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
      </box>
      {providerLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text fg={theme.primary}>Providers &amp; models</text>
          <InlineResults
            scope="providers"
            items={providerLines}
            previewCount={8}
            noun="provider line"
            renderItem={(line, idx) => (
              <text
                key={`provider-${idx}`}
                style={{
                  wrapMode: 'word',
                  fg: line.startsWith('Provider configuration error:')
                    ? theme.error
                    : theme.foreground,
                }}
              >
                {line}
              </text>
            )}
          />
          {onInsertCommand ? (
            <Button onClick={() => onInsertCommand('/provider')}>
              <text fg={theme.primary}>
                Use /provider to manage configuration
              </text>
            </Button>
          ) : null}
        </box>
      ) : null}
      {capabilityRows && capabilityRows.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Capability tiers:
          </text>
          <InlineResults
            scope="capabilities"
            items={capabilityRows}
            previewCount={2}
            noun="capability"
            pluralNoun="capabilities"
            renderItem={(row: DoctorCapabilityRow, rowIndex: number) => (
              <box
                key={`capability-${rowIndex}`}
                style={{ flexDirection: 'column', gap: 0 }}
              >
                <text style={{ wrapMode: 'word', fg: theme.foreground }}>
                  <span
                    style={{ fg: theme.secondary }}
                  >{`  ${row.label}:`}</span>
                  <span
                    style={{ fg: capabilityToneFg[row.tone] }}
                  >{` ${row.value}`}</span>
                </text>
                {row.rows?.map((detail, detailIndex) => (
                  <text
                    key={`capability-${rowIndex}-detail-${detailIndex}`}
                    style={{ wrapMode: 'word', fg: theme.muted }}
                  >
                    {`    - ${detail}`}
                  </text>
                ))}
              </box>
            )}
          />
        </box>
      ) : null}
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <span style={{ fg: theme.secondary }}>Agent diagnostics:</span>
        <span
          style={{ fg: theme.foreground }}
        >{` ${diagnostics.length} captured`}</span>
      </text>
      {diagnostics.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <InlineResults
            scope="diagnostics"
            items={diagnostics}
            previewCount={10}
            noun="diagnostic"
            renderItem={(diagnostic, idx) => (
              <text
                key={`diagnostic-${idx}`}
                style={{ wrapMode: 'word', fg: theme.muted }}
              >
                {`- ${diagnostic.filePath || diagnostic.agentId}: ${diagnostic.message}`}
              </text>
            )}
          />
        </box>
      ) : null}
      <Button
        onClick={() =>
          useOutputReaderStore.getState().open({
            document: capturedDiagnosticDocument(
              'doctor',
              'Captured doctor report',
              block,
            ),
          })
        }
      >
        <text fg={theme.primary}>Inspect captured doctor report</text>
      </Button>
    </HarnessBox>
  )
})
