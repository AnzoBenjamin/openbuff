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
import { outcomeForTool } from '../../utils/output-outcome'

import type { ToolRenderConfig, ToolRenderOptions } from './types'

/**
 * Human-facing renderers for the plan-artifact, audit, and misc tools that
 * previously fell through to the generic raw-JSON fallback.
 *
 * Every one of these returns a short message plus a couple of counters. They
 * are rendered as one family: one `Name summary ✓` header, then bounded
 * detail rows. Long free-form bodies (an outline, a web result, an artifact
 * path list) are bounded and trimmed, never dumped.
 */

const MAX_ROWS = 10

function errorOf(toolBlock: {
  outputRaw?: unknown
  output?: unknown
}): string | undefined {
  return getStructuredErrorMessages(toolBlock.outputRaw ?? toolBlock.output)[0]
}

function firstRecord(outputRaw: unknown): Record<string, unknown> | undefined {
  return getToolOutputRecords(outputRaw)[0]
}

export const CreatePlanComponent = defineToolComponent({
  toolName: 'create_plan',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const message = readString(record?.message)
    const writtenPath =
      readString(record?.path) ??
      readString(record?.artifactPath) ??
      readString(record?.file)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary =
      error ??
      `${outcomeForTool(toolBlock).label} · ${message ?? 'Plan artifact result'}`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Plan"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {writtenPath ? (
              <DetailRow label="Artifact" value={writtenPath} width={width} />
            ) : null}
            {message && !error ? (
              <DetailRow
                value={message}
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

export const UpdatePlanStatusComponent = defineToolComponent({
  toolName: 'update_plan_status',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const message = readString(record?.message)
    const updates = readRecordArray(record?.updates)
    const unmatched = readStringArray(record?.unmatchedTasks)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary =
      error ??
      `${outcomeForTool(toolBlock).label} · ${message ?? 'Plan status result; update count not captured'}`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Plan status"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {readString(record?.sessionStatus) ? (
              <DetailRow
                label="Session"
                value={readString(record?.sessionStatus) ?? ''}
                width={width}
              />
            ) : null}
            {updates.length > 0 ? (
              <DetailRow
                label="Updated"
                value={formatCount(updates.length, 'task line')}
                width={width}
                valueColor={theme.success}
              />
            ) : null}
            {unmatched.slice(0, MAX_ROWS).map((task, index) => (
              <DetailRow
                key={`${task}-${index}`}
                value={`no match: ${task}`}
                width={width}
                valueColor={theme.warning}
              />
            ))}
            <OverflowNote
              hiddenCount={Math.max(0, unmatched.length - MAX_ROWS)}
              noun="task"
            />
            {message && !error ? (
              <DetailRow
                value={message}
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

export const RecordDecisionComponent = defineToolComponent({
  toolName: 'record_decision',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const message = readString(record?.message)
    const kind = readString(record?.kind)
    const evidenceCount = readNumber(record?.evidenceCount) ?? 0
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error ?? message ?? 'Decision recorded.'

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Decision"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {kind ? (
              <DetailRow label="Kind" value={kind} width={width} />
            ) : null}
            {evidenceCount > 0 ? (
              <DetailRow
                label="Evidence"
                value={formatCount(evidenceCount, 'path')}
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

export const WriteAuditFindingsComponent = defineToolComponent({
  toolName: 'write_audit_findings',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const message = readString(record?.message)
    const writtenPaths = readStringArray(record?.writtenPaths)
    const artifactPaths = readStringArray(record?.artifactPaths)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error ?? message ?? 'Audit findings written.'
    const paths = writtenPaths.length > 0 ? writtenPaths : artifactPaths

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Audit findings"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {paths.slice(0, MAX_ROWS).map((path, index) => (
              <DetailRow
                key={`${path}-${index}`}
                value={path}
                width={width}
                valueColor={theme.muted}
              />
            ))}
            <OverflowNote
              hiddenCount={Math.max(0, paths.length - MAX_ROWS)}
              noun="file"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const GitBranchComponent = defineToolComponent({
  toolName: 'git_branch',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const branch = readString(record?.branch) ?? 'branch'
    const created = record?.created === true
    const switched = record?.switched === true
    const previous = readString(record?.previousBranch)
    const statuses = statusGlyphFor(
      error ? 'failed' : created ? 'ready' : 'partial',
      theme,
    )
    const summary = error
      ? 'Branch failed'
      : created
        ? `Branch ${branch}${switched ? ' created and switched' : ' created'}`
        : `Branch ${branch} was not created`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Branch"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            <DetailRow label="Branch" value={branch} width={width} />
            {switched && previous ? (
              <DetailRow
                label="Previous"
                value={previous}
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

export const ReadOutlineComponent = defineToolComponent({
  toolName: 'read_outline',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const outline = readString(record?.outline) ?? ''
    const outlineFailure =
      /(?:does not exist|outside|not found|error reading)/i.test(outline)
    const emptyMarker =
      /(?:^|\n)\[No (?:structural components|(?:Markdown )?headings|components|symbols)/i.test(
        outline,
      )
    const symbolRows = outline
      .split('\n')
      .filter(
        (line) =>
          line.trim() &&
          !line.trim().startsWith('[') &&
          !/^(?:Line\s+\d+:\s*)?import\s/.test(line.trim()),
      )
    const symbolCount = outlineFailure || emptyMarker ? 0 : symbolRows.length
    const statuses = statusGlyphFor(
      error || outlineFailure ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Outline failed'
      : `Outline · ${outlineFailure ? 'unavailable' : !record ? (toolBlock.lifecycle ?? 'output unavailable') : formatCount(symbolCount, 'symbol')} · ${readString(record?.path) ?? readString((toolBlock.input as Record<string, unknown>)?.path) ?? 'source unknown'}${outline.includes('[heuristic outline:') ? ' · heuristic source' : ''}${outline.includes('[Outline truncated') ? ' · capture truncated; more may exist' : ''}`
    const shown = outline
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_ROWS)

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Outline"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {shown.map((line, index) => (
              <DetailRow
                key={`${line}-${index}`}
                value={line}
                width={width}
                valueColor={theme.muted}
              />
            ))}
            <OverflowNote
              hiddenCount={Math.max(0, symbolCount - shown.length)}
              noun="symbol"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const WebSearchComponent = defineToolComponent({
  toolName: 'web_search',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const links = readRecordArray(record?.links)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Web search failed'
      : `Web search · ${record ? 'captured result' : (toolBlock.lifecycle ?? 'output unavailable')}`
    const shown = links.slice(0, MAX_ROWS)

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Web"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {(readString(record?.text) ??
            readString(record?.content) ??
            readString(record?.description)) ? (
              <DetailRow
                value={(
                  readString(record?.text) ??
                  readString(record?.content) ??
                  readString(record?.description) ??
                  ''
                ).slice(0, 600)}
                width={width}
              />
            ) : null}
            {(readString(record?.text) ??
            readString(record?.content) ??
            readString(record?.description)) ? (
              <DetailRow
                value="Captured text preview · Inspect for full retained body"
                width={width}
              />
            ) : null}
            {shown.map((link, index) => {
              const href = readString(link.href) ?? ''
              const text = readString(link.text) ?? href
              return (
                <DetailRow
                  key={`${href}-${index}`}
                  label={text}
                  value={href}
                  width={width}
                  valueColor={theme.muted}
                />
              )
            })}
            <OverflowNote
              hiddenCount={Math.max(0, links.length - shown.length)}
              noun="link"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const InspectCodebaseStructureComponent = defineToolComponent({
  toolName: 'inspect_codebase_structure',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const subsystems = readRecordArray(record?.subsystems)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Structure inspection failed'
      : `Structure · ${formatCount(readNumber(record?.subsystems) ?? readNumber(record?.subsystemCount) ?? subsystems.length, 'subsystem')}`
    const shown = subsystems.slice(0, MAX_ROWS)

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Structure"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {shown.map((subsystem, index) => {
              const name =
                readString(subsystem.name) ??
                readString(subsystem.id) ??
                'subsystem'
              const files = readStringArray(subsystem.files)
              return (
                <DetailRow
                  key={`${name}-${index}`}
                  label={name}
                  value={formatCount(files.length, 'file')}
                  width={width}
                  valueColor={theme.muted}
                />
              )
            })}
            <OverflowNote
              hiddenCount={Math.max(0, subsystems.length - shown.length)}
              noun="subsystem"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const InspectFeatureCompletenessComponent = defineToolComponent({
  toolName: 'inspect_feature_completeness',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const receipt = isRecord(record?.coverageReceipt)
      ? record.coverageReceipt
      : undefined
    const evidence = isRecord(record?.evidence)
      ? record.evidence
      : isRecord(receipt?.evidence)
        ? receipt.evidence
        : undefined
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Feature inspection failed'
      : `Feature · ${readString(record?.feature) ?? 'unknown'} · ${readString(record?.evidenceKind) ?? readString(record?.evidence_kind) ?? readString(receipt?.evidence_kind) ?? 'assurance unknown'} evidence · ${readString(record?.status) ?? 'status unknown'}`

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Feature"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {evidence
              ? (
                  [
                    'entrypoints',
                    'implementation',
                    'consumers',
                    'tests',
                    'docs',
                    'failure_states',
                  ] as const
                ).map((key) => {
                  const count = readStringArray(
                    key === 'failure_states'
                      ? (evidence.failure_states ?? evidence.failureStates)
                      : evidence[key],
                  ).length
                  if (count === 0) return null
                  return (
                    <DetailRow
                      key={key}
                      label={key.replace(/_/g, ' ')}
                      value={formatCount(count, 'path')}
                      width={width}
                      valueColor={theme.muted}
                    />
                  )
                })
              : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const EvaluateAuditCoverageComponent = defineToolComponent({
  toolName: 'evaluate_audit_coverage',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const shards = readRecordArray(record?.shards)
    const statuses = statusGlyphFor(
      error ? 'failed' : outcomeForTool(toolBlock).label,
      theme,
    )
    const summary = error
      ? 'Coverage check failed'
      : `Coverage · ${formatCount(shards.length, 'shard')} · ${record?.complete === false || record?.coverageComplete === false || record?.status === 'partial' ? 'incomplete' : (readString(record?.status) ?? 'completeness unknown')}`
    const shown = shards.slice(0, MAX_ROWS)

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Coverage"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {shown.map((shard, index) => {
              const id =
                readString(shard.shard_id) ?? readString(shard.id) ?? 'shard'
              const files = readStringArray(shard.files)
              return (
                <DetailRow
                  key={`${id}-${index}`}
                  label={id}
                  value={formatCount(files.length, 'file')}
                  width={width}
                  valueColor={theme.muted}
                />
              )
            })}
            <OverflowNote
              hiddenCount={Math.max(0, shards.length - shown.length)}
              noun="shard"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})

export const RunTargetedValidationComponent = defineToolComponent({
  toolName: 'run_targeted_validation',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = firstRecord(toolBlock.outputRaw)
    const error = errorOf(toolBlock)
    const width = rowWidth(options.availableWidth)
    const status = readString(record?.status)
    const assurance = readString(record?.assurance)
    const results = readRecordArray(record?.results)
    const files = readStringArray(record?.files)
    const statuses = statusGlyphFor(error ? 'failed' : status, theme)
    const summary = error ?? readString(record?.summary) ?? 'Validation ran.'
    const failures = results.filter(
      (result) => typeof result.errorMessage === 'string',
    )
    const shown = failures.slice(0, MAX_ROWS)

    return {
      collapsedPreview: previewWithGlyph(
        `Validation ${status ?? 'unknown'}`,
        statuses.glyph,
      ),
      content: (
        <ResultShell>
          <ResultHeader
            name="Validation"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {status ? (
              <DetailRow label="Status" value={status} width={width} />
            ) : null}
            {assurance ? (
              <DetailRow
                label="Assurance"
                value={assurance}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {files.length > 0 ? (
              <DetailRow
                label="Files"
                value={formatCount(files.length, 'path')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {shown.map((failure, index) => {
              const message = readString(failure.errorMessage) ?? 'failed'
              return (
                <ErrorRow
                  key={`${message}-${index}`}
                  message={message}
                  width={width}
                />
              )
            })}
            <OverflowNote
              hiddenCount={Math.max(0, failures.length - shown.length)}
              noun="failure"
            />
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})
