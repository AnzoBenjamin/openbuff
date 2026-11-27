import { outcomeForTool } from '../../utils/output-outcome'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import {
  DetailRow,
  ErrorRow,
  formatCount,
  isRecord,
  InlineResults,
  previewWithGlyph,
  readNumber,
  readRecordArray,
  readString,
  readStringArray,
  ResultBody,
  ResultHeader,
  ResultShell,
  rowWidth,
  statusGlyphFor,
  truncateText,
} from './human-result'
import { defineToolComponent } from './types'

import type { ToolRenderConfig, ToolRenderOptions } from './types'

/**
 * Human-facing renderers for the harness / audit-intelligence tools.
 *
 * Every tool here previously fell through to the generic raw-JSON fallback and
 * printed its whole envelope to the transcript. They are now rendered as one
 * family: one `Name summary ✓` header, the identity of the call as detail rows,
 * then bounded entry lists with honest overflow notes.
 *
 * Two output shapes are deliberately never expanded: the change-review
 * bundle's `diff` (which is capped far above the card's own budget) and the
 * hook-result lists, both of which are bounded to counts plus a few paths.
 */

/** Entry rows shown before the overflow note. */
const MAX_ENTRIES = 12

/** Toolchain capabilities listed before the overflow note. */
const MAX_TOOLS = 14

function errorOf(toolBlock: {
  outputRaw?: unknown
  output?: unknown
}): string | undefined {
  return getStructuredErrorMessages(toolBlock.outputRaw ?? toolBlock.output)[0]
}

function firstRecord(outputRaw: unknown): Record<string, unknown> | undefined {
  return getToolOutputRecords(outputRaw)[0]
}

/** Count non-empty lines in a git status blob. */
function countStatusLines(status: string | undefined): number {
  if (!status) return 0
  return status
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('##')).length
}

export const InspectWorkspaceComponent = defineToolComponent({
  toolName: 'inspect_workspace',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const branch = readString(record?.branch)
    const dirtyCount = countStatusLines(readString(record?.status))
    const summary = error
      ? 'Workspace lookup failed'
      : `Workspace ${branch ? `on ${branch} ` : ''}${dirtyCount > 0 ? `· ${dirtyCount} uncommitted` : record?.status !== undefined && toolBlock.lifecycle !== 'running' && toolBlock.lifecycle !== 'queued' && toolBlock.lifecycle !== 'failed' && toolBlock.lifecycle !== 'cancelled' ? '· clean captured tree' : `· ${toolBlock.lifecycle ?? 'status unavailable'}`}`
    const shortHead = readString(record?.headCommit)?.slice(0, 12)

    return {
      collapsedPreview: previewWithGlyph(
        summary,
        statusGlyphFor(
          error ? 'failed' : outcomeForTool(toolBlock).label,
          theme,
        ).glyph,
      ),
      content: (
        <ResultShell>
          <ResultHeader
            name="Workspace"
            summary={truncateText(summary, 60)}
            glyph={
              statusGlyphFor(
                error ? 'failed' : outcomeForTool(toolBlock).label,
                theme,
              ).glyph
            }
            glyphColor={
              statusGlyphFor(
                error ? 'failed' : outcomeForTool(toolBlock).label,
                theme,
              ).color
            }
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {branch ? (
              <DetailRow label="Branch" value={branch} width={width} />
            ) : null}
            {readString(record?.upstream) ? (
              <DetailRow
                label="Upstream"
                value={readString(record?.upstream) ?? ''}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {readString(record?.defaultBranch) ? (
              <DetailRow
                label="Default"
                value={readString(record?.defaultBranch) ?? ''}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {shortHead ? (
              <DetailRow
                label="Head"
                value={shortHead}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {readString(record?.canonicalRoot) ? (
              <DetailRow
                label="Root"
                value={readString(record?.canonicalRoot) ?? ''}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {record?.isLinkedWorktree === true ? (
              <DetailRow
                label="Worktree"
                value={'linked worktree'}
                width={width}
                valueColor={theme.warning}
              />
            ) : null}
            {dirtyCount > 0 ? (
              <DetailRow
                label="Dirty"
                value={`${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}`}
                width={width}
                valueColor={theme.warning}
              />
            ) : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const GetChangeReviewBundleComponent = defineToolComponent({
  toolName: 'get_change_review_bundle',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const files = readStringArray(record?.files)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Change bundle failed'
      : `Change bundle · ${formatCount(files.length, 'file')} changed`
    const findings = readRecordArray(record?.findings)
    const validation = readRecordArray(record?.validation)

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Change bundle"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            <DetailRow
              label="Snapshot"
              value={
                (readString(record?.snapshotId) ?? '').slice(0, 16) || 'unknown'
              }
              width={width}
              valueColor={theme.muted}
            />
            <InlineResults
              items={files}
              previewCount={MAX_ENTRIES}
              noun="file"
              renderItem={(file, index) => (
                <DetailRow
                  key={`${file}-${index}`}
                  value={file}
                  width={width}
                />
              )}
            />

            {findings.length > 0 ? (
              <DetailRow
                label="Reviewer findings"
                value={formatCount(findings.length, 'record')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {validation.length > 0 ? (
              <DetailRow
                label="Validation evidence"
                value={formatCount(validation.length, 'record')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const GetTaskComponent = defineToolComponent({
  toolName: 'get_task',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const state = isRecord(record?.state) ? record?.state : undefined
    const artifacts = readStringArray(record?.artifacts)
    const revision = readNumber(state?.revision)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Task lookup failed'
      : `Task · ${readString(record?.session) ?? 'session'}`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Task"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {revision !== undefined ? (
              <DetailRow
                label="Revision"
                value={`r${revision}`}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {readString(state?.status) ? (
              <DetailRow
                label="Status"
                value={readString(state?.status) ?? ''}
                width={width}
              />
            ) : null}
            {readString(state?.currentTask) ? (
              <DetailRow
                label="Current task"
                value={readString(state?.currentTask) ?? ''}
                width={width}
              />
            ) : null}
            {artifacts.map((artifact, index) => (
              <DetailRow
                key={`${artifact}-${index}`}
                value={artifact}
                width={width}
                valueColor={theme.muted}
              />
            ))}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const InspectEnvironmentComponent = defineToolComponent({
  toolName: 'inspect_environment',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const workspaces = readRecordArray(record?.workspaces)
    const manifests = readStringArray(record?.manifests)
    const lockfiles = readStringArray(record?.lockfiles)
    const toolsRaw = isRecord(record?.tools) ? record?.tools : undefined
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Environment inspection failed'
      : `Environment · ${readString(record?.packageManager) ?? 'package manager unknown'}`

    const toolEntries = toolsRaw
      ? Object.entries(toolsRaw).map(([name, value]) => {
          const available = isRecord(value) && value.available === true
          const version = isRecord(value)
            ? readString(value.version)
            : undefined
          return `${name} ${available ? 'yes' : 'no'}${version ? ` ${version}` : ''}`
        })
      : []

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Environment"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {manifests.length > 0 ? (
              <DetailRow
                label="Manifests"
                value={manifests.join(', ')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {lockfiles.length > 0 ? (
              <DetailRow
                label="Lockfiles"
                value={lockfiles.join(', ')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            <InlineResults
              items={workspaces}
              previewCount={MAX_ENTRIES}
              noun="workspace"
              renderItem={(workspace, index) => (
                <DetailRow
                  key={`${readString(workspace.root) ?? ''}-${index}`}
                  label={readString(workspace.root) ?? 'workspace'}
                  value={`${readString(workspace.ecosystem) ?? 'unknown'} / ${readString(workspace.manager) ?? 'unknown'}`}
                  width={width}
                  valueColor={theme.muted}
                />
              )}
            />

            <InlineResults
              items={toolEntries}
              previewCount={MAX_TOOLS}
              noun="toolchain"
              renderItem={(entry, index) => (
                <DetailRow
                  key={`tool-${index}`}
                  value={entry}
                  width={width}
                  valueColor={theme.muted}
                />
              )}
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const GetAffectedTestsComponent = defineToolComponent({
  toolName: 'get_affected_tests',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const impact = readRecordArray(record?.impact)
    const targets = readRecordArray(record?.targets)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Affected-test analysis failed'
      : `Affected tests · ${formatCount(impact.length || targets.length, 'changed file')} mapped · recommendations; tests not run${impact.some((entry) => typeof entry.graphNote === 'string') ? ' · graph tier unavailable' : ''}`
    const captured = impact.length ? impact : targets
    const candidateTotal = captured.reduce(
      (total, entry) =>
        total + (Array.isArray(entry.candidates) ? entry.candidates.length : 0),
      0,
    )

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Affected tests"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {targets.length === 0 && impact.length === 0 ? (
              <DetailRow
                value="No test targets resolved for the changed files."
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            <InlineResults
              items={captured}
              previewCount={MAX_ENTRIES}
              noun="source file"
              renderItem={(entry, index) => {
                const source = readString(entry.source) ?? 'changed file'
                const candidates = Array.isArray(entry.candidates)
                  ? entry.candidates.flatMap((candidate) =>
                      typeof candidate === 'string'
                        ? [candidate]
                        : candidate &&
                            typeof candidate === 'object' &&
                            typeof candidate.path === 'string'
                          ? [
                              `${candidate.path}${candidate.confidence !== undefined ? ` · confidence ${String(candidate.confidence)}` : ''}${typeof candidate.tier === 'string' ? ` · ${candidate.tier}` : ''}`,
                            ]
                          : [],
                    )
                  : []
                return (
                  <box
                    key={`${source}-${index}`}
                    style={{ flexDirection: 'column', gap: 0, width: '100%' }}
                  >
                    <text style={{ wrapMode: 'word' }}>
                      <span fg={theme.foreground}>{source}</span>
                    </text>
                    <InlineResults
                      items={candidates}
                      scope={`candidates:${source}`}
                      previewCount={MAX_ENTRIES}
                      noun="candidate"
                      renderItem={(candidate, candidateIndex) => (
                        <DetailRow
                          key={`${candidate}-${candidateIndex}`}
                          value={candidate}
                          width={width}
                          valueColor={theme.muted}
                        />
                      )}
                    />
                    {typeof entry.graphNote === 'string' ? (
                      <DetailRow
                        value={entry.graphNote}
                        width={width}
                        valueColor={theme.warning}
                      />
                    ) : null}
                  </box>
                )
              }}
            />

            {candidateTotal > 0 ? (
              <DetailRow
                label="Candidates"
                value={formatCount(candidateTotal, 'test path')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const GetBuildTargetsComponent = defineToolComponent({
  toolName: 'get_build_targets',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const targets = readRecordArray(record?.targets)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Build-target analysis failed'
      : `Build targets · ${formatCount(targets.length, 'package')}`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Build targets"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            <InlineResults
              items={targets}
              previewCount={MAX_ENTRIES}
              noun="package"
              renderItem={(target, index) => {
                const root = readString(target.packageRoot) ?? 'unknown package'
                const commands = readStringArray(target.commands)
                return (
                  <box
                    key={`${root}-${index}`}
                    style={{ flexDirection: 'column', gap: 0, width: '100%' }}
                  >
                    <text style={{ wrapMode: 'word' }}>
                      <span fg={theme.foreground}>{root}</span>
                      <span
                        fg={theme.muted}
                      >{` · ${readString(target.manager) ?? 'unknown'}`}</span>
                    </text>
                    {commands.map((command, commandIndex) => (
                      <DetailRow
                        key={`${command}-${commandIndex}`}
                        value={command}
                        width={width}
                        valueColor={theme.muted}
                      />
                    ))}
                  </box>
                )
              }}
            />

            {record?.truncated === true ? (
              <DetailRow
                value="The target list was truncated by the analyzer."
                width={width}
                valueColor={theme.warning}
              />
            ) : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})
