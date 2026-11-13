import { memo, useState } from 'react'

import { useTheme } from '../../hooks/use-theme'
import {
  hasMarkdown,
  type MarkdownPalette,
} from '../../utils/markdown-renderer'
import { ContentWithMarkdown } from '../blocks/content-with-markdown'
import { Button } from '../button'
import { BuildModeButtons } from '../build-mode-buttons'
import { HarnessBox } from './harness-box'
import { sliceTextCells } from '../../utils/text-boundaries'
import { createJsonDocument } from '../../utils/output-document'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { InlineResults } from '../tools/inline-results'

import type { PlanArtifactMetadata } from '../../types/chat'

interface PlanBoxProps {
  planContent: string
  metadata?: PlanArtifactMetadata
  /** Retained for call-site compatibility after the D47 Stage 2 renderer removal; no longer drives markdown wrapping (the native renderable wraps itself). */
  availableWidth: number
  markdownPalette: MarkdownPalette
  onBuildFast: () => void
  /** Insert a command into the chat input (no submit). Defaults to noop so existing tests can omit it. */
  onInsertCommand?: (command: string) => void
}

/** Known artifact paths (Session, SPEC/PLAN/STATUS/LESSONS) + custom artifacts. Rendered as static text. */
const formatArtifactRows = (metadata: PlanArtifactMetadata): string[] => {
  const artifactRows = [
    ['Session', metadata.sessionPath],
    ['SPEC.md', metadata.specPath],
    ['PLAN.md', metadata.planPath],
    ['STATUS.md', metadata.statusPath],
    ['LESSONS.md', metadata.lessonsPath],
  ]
    .filter((row): row is [string, string] => Boolean(row[1]?.trim()))
    .map(([label, value]) => `${label}: ${value}`)

  const customArtifactRows = (metadata.customArtifacts ?? [])
    .filter(
      ({ label, path }) => Boolean(label?.trim()) && Boolean(path?.trim()),
    )
    .map(({ label, path }) => `${label}: ${path}`)

  return [...artifactRows, ...customArtifactRows]
}

/** Command strings (build/maintain this plan) rendered as clickable buttons. */
const formatCommandRows = (metadata: PlanArtifactMetadata): string[] =>
  [
    metadata.executeCommand,
    metadata.resumeCommand,
    metadata.updateCommand,
    metadata.statusCommand,
    metadata.lessonsCommand,
    ...(metadata.customArtifactCommands ?? []),
  ].filter((command): command is string => Boolean(command?.trim()))

export const PlanBox = memo(
  ({
    planContent,
    metadata,
    availableWidth,
    markdownPalette,
    onBuildFast,
    onInsertCommand = () => {},
  }: PlanBoxProps) => {
    const theme = useTheme()
    const artifactRows = metadata ? formatArtifactRows(metadata) : []
    const commandRows = metadata ? formatCommandRows(metadata) : []
    const hasMetadata = artifactRows.length > 0 || commandRows.length > 0
    // Track which command is hovered so each button highlights independently.
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

    return (
      <HarnessBox tone="secondary" gap={1} paddingBottom={1}>
        {/* D47 Stage 2: the legacy remark renderer was removed, so markdown
            plan content renders through the native markdown renderable (a
            renderable cannot nest inside a text element) via
            ContentWithMarkdown, whose try/catch degrades native setup failures
            to plain text; plain text keeps the styled text path. */}
        {hasMarkdown(planContent) ? (
          <ContentWithMarkdown
            content={planContent}
            isStreaming={false}
            codeBlockWidth={availableWidth}
            palette={markdownPalette}
          />
        ) : (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            {planContent}
          </text>
        )}
        {hasMetadata && (
          <box style={{ flexDirection: 'column', gap: 0 }}>
            <text style={{ fg: theme.secondary }}>Artifacts</text>
            <InlineResults
              scope="artifacts"
              items={artifactRows}
              previewCount={2}
              noun="artifact"
              renderItem={(row, index) => (
                <text
                  key={`${row}-${index}`}
                  style={{ wrapMode: 'word', fg: theme.secondary }}
                >
                  {sliceTextCells(row, 0, Math.max(10, availableWidth - 6))}
                </text>
              )}
            />
            <InlineResults
              scope="commands"
              items={commandRows}
              previewCount={1}
              noun="command"
              renderItem={(command, index) => (
                <Button
                  key={`${command}-${index}`}
                  style={{
                    flexDirection: 'row',
                    height: 1,
                    flexShrink: 0,
                    paddingLeft: 1,
                    paddingRight: 1,
                  }}
                  onClick={() => onInsertCommand(command)}
                  onMouseOver={() => setHoveredIndex(index)}
                  onMouseOut={() =>
                    setHoveredIndex((current) =>
                      current === index ? null : current,
                    )
                  }
                >
                  <text
                    wrapMode="none"
                    style={{
                      fg:
                        hoveredIndex === index
                          ? theme.foreground
                          : theme.secondary,
                    }}
                  >
                    {sliceTextCells(
                      command,
                      0,
                      Math.max(10, availableWidth - 10),
                    )}
                  </text>
                </Button>
              )}
            />
            <Button
              onClick={() =>
                useOutputReaderStore.getState().open({
                  document: createJsonDocument(
                    'plan-artifact-details',
                    'Captured plan artifacts and commands',
                    metadata,
                  ),
                })
              }
            >
              <text fg={theme.link}>Inspect plan artifacts and commands</text>
            </Button>
          </box>
        )}
        <BuildModeButtons theme={theme} onBuildFast={onBuildFast} />
      </HarnessBox>
    )
  },
)
