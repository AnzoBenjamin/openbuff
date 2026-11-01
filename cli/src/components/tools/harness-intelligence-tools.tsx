import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import {
  DetailRow,
  ErrorRow,
  formatCount,
  isRecord,
  OverflowNote,
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
  return status.split('\n').filter((line) => line.trim().length > 0).length
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
      : `Workspace ${branch ? `on ${branch} ` : ''}${dirtyCount > 0 ? `· ${dirtyCount} uncommitted` : '· clean'}`
    const shortHead = readString(record?.headCommit)?.slice(0, 12)

    return {
      collapsedPreview: previewWithGlyph(
        summary,
        statusGlyphFor(error ? 'failed' : 'ready', theme).glyph,
      ),
      content: (
        <ResultShell>
          <ResultHeader
            name="Workspace"
            summary={truncateText(summary, 60)}
            glyph={statusGlyphFor(error ? 'failed' : 'ready', theme).glyph}
            glyphColor={statusGlyphFor(error ? 'failed' : 'ready', theme).color}
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
                value={"linked worktree"}
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
    const statuses = statusGlyphFor(error ? 'failed' : 'ready', theme)
    const summary = error
      ? 'Change bundle failed'
      : `Change bundle · ${formatCount(files.length, 'file')} changed`
    const shown = files.slice(0, MAX_ENTRIES)
    const hidden = files.length - shown.length
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
              value={(readString(record?.snapshotId) ?? '').slice(0, 16) || 'unknown'}
              width={width}
              valueColor={theme.muted}
            />
            {shown.map((file, index) => (
              <DetailRow
                key={`${file}-${index}`}
                value={file}
                width={width}
              />
            ))}
            <OverflowNote hiddenCount={hidden} noun="file" />
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
    const statuses = statusGlyphFor(error ? 'failed' : 'ready', theme)
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
    const statuses = statusGlyphFor(error ? 'failed' : 'ready', theme)
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
    const shownTools = toolEntries.slice(0, MAX_TOOLS)
    const hiddenTools = toolEntries.length - shownTools.length
    const shownWorkspaces = workspaces.slice(0, MAX_ENTRIES)
    const hiddenWorkspaces = workspaces.length - shownWorkspaces.length

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
            {shownWorkspaces.map((workspace, index) => (
              <DetailRow
                key={`${readString(workspace.root) ?? ''}-${index}`}
                label={readString(workspace.root) ?? 'workspace'}
                value={`${readString(workspace.ecosystem) ?? 'unknown'} / ${readString(workspace.manager) ?? 'unknown'}`}
                width={width}
                valueColor={theme.muted}
              />
            ))}
            <OverflowNote hiddenCount={hiddenWorkspaces} noun="workspace" />
            {shownTools.map((entry, index) => (
              <DetailRow
                key={`tool-${index}`}
                value={entry}
                width={width}
                valueColor={theme.muted}
              />
            ))}
            <OverflowNote hiddenCount={hiddenTools} noun="toolchain" />
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
    const statuses = statusGlyphFor(error ? 'failed' : 'ready', theme)
    const summary = error
      ? 'Affected-test analysis failed'
      : `Affected tests · ${formatCount(impact.length, 'changed file')} mapped`
    const shown = impact.slice(0, MAX_ENTRIES)
    const hidden = impact.length - shown.length
    const candidateTotal = impact.reduce(
      (total, entry) => total + readRecordArray(entry.candidates).length,
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
            {shown.map((entry, index) => {
              const source = readString(entry.source) ?? 'changed file'
              const candidates = readStringArray(
                readRecordArray(entry.candidates).map((candidate) =>
                  readString(candidate.path),
                ),
              )
              return (
                <box
                  key={`${source}-${index}`}
                  style={{ flexDirection: 'column', gap: 0, width: '100%' }}
                >
                  <text style={{ wrapMode: 'word' }}>
                    <span fg={theme.foreground}>{source}</span>
                  </text>
                  {candidates.map((candidate, candidateIndex) => (
                    <DetailRow
                      key={`${candidate}-${candidateIndex}`}
                      value={candidate}
                      width={width}
                      valueColor={theme.muted}
                    />
                  ))}
                </box>
              )
            })}
            <OverflowNote hiddenCount={hidden} noun="source file" />
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
    const statuses = statusGlyphFor(error ? 'failed' : 'ready', theme)
    const summary = error
      ? 'Build-target analysis failed'
      : `Build targets · ${formatCount(targets.length, 'package')}`
    const shown = targets.slice(0, MAX_ENTRIES)
    const hidden = targets.length - shown.length

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
            {shown.map((target, index) => {
              const root = readString(target.packageRoot) ?? 'unknown package'
              const commands = readStringArray(target.commands)
              return (
                <box
                  key={`${root}-${index}`}
                  style={{ flexDirection: 'column', gap: 0, width: '100%' }}
                >
                  <text style={{ wrapMode: 'word' }}>
                    <span fg={theme.foreground}>{root}</span>
                    <span fg={theme.muted}>{` · ${readString(target.manager) ?? 'unknown'}`}</span>
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
            })}
            <OverflowNote hiddenCount={hidden} noun="package" />
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
