import { useTheme } from '../../hooks/use-theme'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
  getCanonicalMutationResult,
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
import { StrReplaceComponent } from './str-replace'

import type { ToolRenderConfig, ToolRenderOptions } from './types'

/** Per-file rows shown before the overflow note. */
const MAX_FILE_ROWS = 12

/** One applied/not-applied file from the shared semantic-edit result. */
type SemanticEditFile = {
  path: string
  applied: boolean
  errorMessage?: string
}

/** The shared published result for rename_symbol / code_action / extract_symbol. */
type SemanticEditResult = {
  applied: boolean | undefined
  files: SemanticEditFile[]
  errorMessage?: string
  unavailable?: string
}

/** Parse the shared `{ applied, results, errorMessage }` envelope. */
function readSemanticEditResult(outputRaw: unknown): SemanticEditResult {
  const record = getToolOutputRecords(outputRaw)[0]
  if (!record) {
    return { applied: undefined, files: [] }
  }

  const files = readRecordArray(record.results).flatMap((entry) => {
    const path = readString(entry.path)
    if (!path) return []
    const errorMessage = readString(entry.errorMessage)
    return [
      {
        path,
        applied: entry.applied === true,
        // Attach the message only when one exists, so an absent per-file
        // failure reads as a missing field rather than an explicit `undefined`.
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    ]
  })

  return {
    applied: typeof record.applied === 'boolean' ? record.applied : undefined,
    files,
    // Service failures surface under either `error` (the shared tool-result
    // normalizer field) or `errorMessage` (the per-file field), so accept
    // both rather than showing an empty body for a real failure.
    errorMessage: readString(record.errorMessage) ?? readString(record.error),
    unavailable: readString(record.unavailable),
  }
}

/**
 * Honest outcome for the whole call: an explicit failure, a partial apply, an
 * apply, or `no changes` when nothing was committed. Never reports success
 * while any listed file failed, because a partial broker commit is real.
 */
function semanticEditStatus(
  result: SemanticEditResult,
  error: string | undefined,
  lifecycle?: string,
): string {
  if (result.files.some((file) => file.applied))
    return result.applied === false ||
      result.files.some((file) => !file.applied) ||
      error
      ? 'partial'
      : 'applied'
  if (
    lifecycle === 'queued' ||
    lifecycle === 'running' ||
    lifecycle === 'cancelled' ||
    lifecycle === 'failed'
  )
    return lifecycle
  if (error || result.unavailable || result.errorMessage) return 'failed'
  if (result.applied === false) return 'not_applied'
  if (result.applied === true) {
    return result.files.some((file) => !file.applied) ? 'partial' : 'applied'
  }
  return 'outcome unknown'
}

/** `position.line` (1-based) plus a 1-based column from the raw LSP offset. */
function positionLabel(input: Record<string, unknown> | undefined): string {
  const position = isRecord(input?.position) ? input?.position : undefined
  const line = readNumber(position?.line) ?? readNumber(input?.line)
  const character =
    readNumber(position?.character) ?? readNumber(input?.character)
  if (line === undefined) return ''
  return `${line}:${(character ?? 0) + 1}`
}

/** Dotted LSP command ids (`source.organizeImports`) as human prose. */
function humanizeCodeActionKind(kind: string): string {
  const segment = kind.split('.').pop() ?? kind
  const spaced = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return spaced.length > 0 ? spaced : kind
}

/** Shared body: bounded per-file outcomes under the header. */
function SemanticEditBody({
  result,
  options,
}: {
  result: SemanticEditResult
  options?: ToolRenderOptions
}) {
  const theme = useTheme()
  const width = rowWidth(options?.availableWidth)
  const appliedCount = result.files.filter((file) => file.applied).length

  return (
    <ResultBody>
      {result.errorMessage ? (
        <ErrorRow message={result.errorMessage} width={width} />
      ) : null}
      {result.unavailable ? (
        <DetailRow
          label="Service"
          value={result.unavailable}
          width={width}
          valueColor={theme.warning}
        />
      ) : null}
      <InlineResults
        items={result.files}
        previewCount={MAX_FILE_ROWS}
        noun="file"
        renderItem={(file, index) => {
          const status = file.applied ? 'applied' : 'not applied'
          const color = file.applied ? theme.success : theme.error
          const suffix = file.applied
            ? ''
            : ` - ${truncateText(file.errorMessage ?? 'the action did not apply', width)}`
          return (
            <text key={`${file.path}-${index}`} style={{ wrapMode: 'word' }}>
              <span fg={theme.muted}>{`${index + 1}. `}</span>
              <span fg={color}>{status}</span>
              <span fg={theme.foreground}>{` ${file.path}${suffix}`}</span>
            </text>
          )
        }}
      />
      {result.files.length > 1 ? (
        <DetailRow
          label="Applied"
          value={`${appliedCount} of ${result.files.length} files`}
          width={width}
          valueColor={theme.muted}
        />
      ) : null}
    </ResultBody>
  )
}

export const RenameSymbolComponent = defineToolComponent({
  toolName: 'rename_symbol',
  render(toolBlock, theme, options): ToolRenderConfig {
    const input = isRecord(toolBlock.input) ? toolBlock.input : undefined
    const result = readSemanticEditResult(toolBlock.outputRaw)
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const status = semanticEditStatus(result, error, toolBlock.lifecycle)
    const { glyph, color } = statusGlyphFor(status, theme)
    const summary = `Rename to ${readString(input?.new_name) ?? 'a new name'} in ${formatCount(result.files.length, 'file')}`
    const path = readString(input?.path) ?? 'unknown file'
    const position = positionLabel(input)

    return {
      collapsedPreview: previewWithGlyph(`${summary} · ${status}`, glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Rename"
            summary={truncateText(`${status} · ${summary}`, 60)}
            glyph={glyph}
            glyphColor={color}
          />
          <ResultBody>
            <DetailRow
              label="File"
              value={path}
              width={rowWidth(options.availableWidth)}
            />
            {position ? (
              <DetailRow
                label="At"
                value={position}
                width={rowWidth(options.availableWidth)}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
          <SemanticEditBody result={result} options={options} />
        </ResultShell>
      ),
    }
  },
})

export const CodeActionComponent = defineToolComponent({
  toolName: 'code_action',
  render(toolBlock, theme, options): ToolRenderConfig {
    const input = isRecord(toolBlock.input) ? toolBlock.input : undefined
    const result = readSemanticEditResult(toolBlock.outputRaw)
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const status = semanticEditStatus(result, error, toolBlock.lifecycle)
    const { glyph, color } = statusGlyphFor(status, theme)
    const kind = humanizeCodeActionKind(readString(input?.kind) ?? 'quick fix')
    const summary = `Code action: ${kind} in ${formatCount(result.files.length, 'file')}`
    const path = readString(input?.path) ?? 'unknown file'
    const position = positionLabel(input)

    return {
      collapsedPreview: previewWithGlyph(`${summary} · ${status}`, glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Code action"
            summary={truncateText(`${status} · ${summary}`, 60)}
            glyph={glyph}
            glyphColor={color}
          />
          <ResultBody>
            <DetailRow
              label="File"
              value={path}
              width={rowWidth(options.availableWidth)}
            />
            {position ? (
              <DetailRow
                label="At"
                value={position}
                width={rowWidth(options.availableWidth)}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
          <SemanticEditBody result={result} options={options} />
        </ResultShell>
      ),
    }
  },
})

export const ExtractSymbolComponent = defineToolComponent({
  toolName: 'extract_symbol',
  render(toolBlock, theme, options): ToolRenderConfig {
    const input = isRecord(toolBlock.input) ? toolBlock.input : undefined
    const result = readSemanticEditResult(toolBlock.outputRaw)
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const status = semanticEditStatus(result, error, toolBlock.lifecycle)
    const { glyph, color } = statusGlyphFor(status, theme)
    const symbolName = readString(input?.symbol_name) ?? 'symbol'
    const summary = `Extract ${symbolName} to ${readString(input?.destination_path) ?? 'a new file'}`
    const path = readString(input?.path) ?? 'unknown file'
    const position = positionLabel(input)

    return {
      collapsedPreview: previewWithGlyph(`${summary} · ${status}`, glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Extract"
            summary={truncateText(`${status} · ${summary}`, 60)}
            glyph={glyph}
            glyphColor={color}
          />
          <ResultBody>
            <DetailRow
              label="From"
              value={path}
              width={rowWidth(options.availableWidth)}
            />
            {position ? (
              <DetailRow
                label="At"
                value={position}
                width={rowWidth(options.availableWidth)}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
          <SemanticEditBody result={result} options={options} />
        </ResultShell>
      ),
    }
  },
})

/**
 * `rewrite_symbol` delegates to the `str_replace` handler, so its successful
 * output is that tool's result envelope. A rejected edit returns
 * `{ file, errorMessage }`; a service failure returns a plain string or an
 * unknown object. All three degrade to an honest one-liner.
 */
export const RewriteSymbolComponent = defineToolComponent({
  toolName: 'rewrite_symbol',
  render(toolBlock, theme, options): ToolRenderConfig {
    const canonical = getCanonicalMutationResult(toolBlock.outputRaw)
    if (canonical)
      return StrReplaceComponent.render(toolBlock as any, theme, options)
    const input = isRecord(toolBlock.input) ? toolBlock.input : undefined
    const records = getToolOutputRecords(toolBlock.outputRaw)
    const record = records[0]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const width = rowWidth(options.availableWidth)
    const changedFiles = readRecordArray(record?.changedFiles).length
    const changedPaths = readStringArray(record?.changedPaths).length
    const message = readString(record?.message)
    const fileError = readString(record?.errorMessage)
    const failure =
      error ??
      fileError ??
      (message && /^(?:error|failed|failure)\b/i.test(message)
        ? message
        : undefined)
    const fileCount = Math.max(changedFiles, changedPaths)
    const status = failure
      ? 'failed'
      : fileCount > 0
        ? 'applied'
        : 'outcome unknown'
    const { glyph, color } = statusGlyphFor(status, theme)
    const summary = `Rewrite ${readString(input?.symbol) ?? 'symbol'} in ${formatCount(fileCount, 'file')}`
    const occurrence = readNumber(input?.occurrence)

    return {
      collapsedPreview: previewWithGlyph(`${summary} · ${status}`, glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Rewrite"
            summary={truncateText(`${status} · ${summary}`, 60)}
            glyph={glyph}
            glyphColor={color}
          />
          <ResultBody>
            <DetailRow
              label="File"
              value={readString(input?.path) ?? 'unknown file'}
              width={width}
            />
            {occurrence !== undefined && occurrence > 1 ? (
              <DetailRow
                label="Occurrence"
                value={String(occurrence)}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {failure ? <ErrorRow message={failure} width={width} /> : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})
