import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'
import { deriveTitle } from '../../utils/format-helpers'
import { hashString } from '../../utils/hash'

import type { IndexStatusContentBlock } from '../../types/chat'

interface IndexStatusBoxProps {
  block: IndexStatusContentBlock
}

export const IndexStatusBox = memo(({ block }: IndexStatusBoxProps) => {
  const theme = useTheme()
  const title = deriveTitle(block.statusLine) || 'Index status'
  const diagnostics = block.diagnosticsLines ?? []

  return (
    <HarnessBox tone="secondary" title={title} gap={1} paddingBottom={1}>
      {block.messageLine ? (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          {block.messageLine}
        </text>
      ) : null}
      {block.corpusLine?.trim() ? (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Corpus:</span>
          <span style={{ fg: theme.foreground }}>{` ${block.corpusLine}`}</span>
        </text>
      ) : null}
      {block.ageLine?.trim() ? (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Age:</span>
          <span style={{ fg: theme.foreground }}>{` ${block.ageLine}`}</span>
        </text>
      ) : null}
      {block.vectorLine?.trim() ? (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Vector:</span>
          <span style={{ fg: theme.foreground }}>{` ${block.vectorLine}`}</span>
        </text>
      ) : null}
      {block.hintLine ? (
        <text style={{ wrapMode: 'word', fg: theme.muted }}>
          {block.hintLine}
        </text>
      ) : null}
      {block.coverageLine ? (
        <text style={{ wrapMode: 'word', fg: theme.warning }}>
          {block.coverageLine}
        </text>
      ) : null}
      {diagnostics.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text
            style={{ wrapMode: 'word', fg: theme.secondary }}
          >{`Diagnostics (${diagnostics.length})`}</text>
          {(() => {
            const seen = new Map<string, number>()
            return diagnostics.map((line) => {
              const h = hashString(line)
              const n = seen.get(h) ?? 0
              seen.set(h, n + 1)
              const key = n === 0 ? `diag-${h}` : `diag-${h}-${n}`
              return (
                <text key={key} style={{ wrapMode: 'word', fg: theme.muted }}>
                  {line}
                </text>
              )
            })
          })()}
        </box>
      ) : null}
    </HarnessBox>
  )
})
