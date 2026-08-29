import { MAX_TRANSACTION_FILE_BYTES } from '@codebuff/common/actions'
import { replaceRangeParams } from '@codebuff/common/tools/params/tool/replace-range'
import {
  decodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  describeReanchorFailure,
  getLineCoordinates,
  reanchorCapabilityRange,
} from '@codebuff/common/util/line-coordinates'
import { resolveFilePathForFileSystemOperation } from './path-utils'
import { boundedDiagnosticEcho, changeFile } from './change-file'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { FileFilter } from './read-files'
import type { FilesystemAuthorityPolicy } from './filesystem-authority'

function errorResult(
  file: string,
  errorMessage: string,
): CodebuffToolOutput<'replace_range'> {
  return [{ type: 'json', value: { file, errorMessage } }]
}

/**
 * Raw span of the 1-indexed range [startLine, endLine], ending just past
 * endLine's text and before its terminator. Normalization only rewrites
 * newlines, so raw terminators can be spliced around verbatim; the walk (and
 * therefore `sawCrlf`) stops at endLine.
 */
function getRawRangeSpan(
  content: string,
  lines: string[],
  startLine: number,
  endLine: number,
): { start: number; end: number; sawCrlf: boolean } {
  let cursor = 0
  let start = 0
  let end = 0
  let sawCrlf = false
  for (let index = 0; index < endLine; index++) {
    if (index === startLine - 1) start = cursor
    end = cursor + lines[index]!.length
    if (content.startsWith('\r\n', end)) {
      sawCrlf = true
      cursor = end + 2
    } else {
      cursor = end < content.length ? end + 1 : end
    }
  }
  return { start, end, sawCrlf }
}

/**
 * Terminator for multi-line newContent, preferred from inside the replaced
 * span, then from the terminator ending it, then from the CRLF seen up to
 * endLine. `normalizeLineEndings` maps only \r\n, so CR-only files are out of
 * scope: a lone CR is content, not a terminator.
 */
function getRangeLineEnding(
  content: string,
  span: { start: number; end: number; sawCrlf: boolean },
): '\r\n' | '\n' {
  const replaced = content.slice(span.start, span.end)
  if (replaced.includes('\r\n')) return '\r\n'
  if (replaced.includes('\n')) return '\n'
  if (content.startsWith('\r\n', span.end)) return '\r\n'
  if (content.startsWith('\n', span.end)) return '\n'
  return span.sawCrlf ? '\r\n' : '\n'
}

export async function replaceRange(params: {
  parameters: unknown
  cwd: string
  fs: CodebuffFileSystem
  capabilityIssuer: ReadCapabilityIssuer
  signal?: AbortSignal
  fileFilter?: FileFilter
  callId?: string
  filesystemPolicy?: FilesystemAuthorityPolicy
  logger?: Logger
}): Promise<CodebuffToolOutput<'replace_range'>> {
  const parsed = replaceRangeParams.inputSchema.safeParse(params.parameters)
  if (!parsed.success) {
    // Echo a best-effort, length-bounded path so the agent can tell which call
    // failed even though the input never parsed.
    const rawParameters =
      typeof params.parameters === 'object' && params.parameters !== null
        ? (params.parameters as Record<string, unknown>)
        : null
    return errorResult(
      // No path supplied stays the empty path; any other unusable value becomes
      // `boundedDiagnosticEcho`'s obviously synthetic `(unparsed)` sentinel, so
      // unparsed model input can neither amplify the message nor inject fake
      // lines into it, and the agent can still tell the two apart.
      rawParameters?.path === undefined
        ? ''
        : boundedDiagnosticEcho(rawParameters.path),
      'Missing or invalid replace_range parameters.',
    )
  }
  const input = parsed.data

  const resolvedPath = await resolveFilePathForFileSystemOperation(
    params.cwd,
    input.path,
    params.fs,
  )
  if (!resolvedPath) {
    // The schema requires a non-empty string path, so the parsed value is
    // echoed through the shared bounded helper directly; only the unparsed
    // branch above can see a missing path.
    return errorResult(
      boundedDiagnosticEcho(input.path),
      'file path is outside the project directory',
    )
  }

  const { operationPath: fullPath, relativePath } = resolvedPath
  // `rawInputSchema.superRefine` already rejected any undecodable or non-cap.v3
  // token, so only the scope can still mismatch; the `typeof` test is narrowing.
  const decoded = decodeReadCapabilityToken(input.readCapability)
  if (
    typeof decoded === 'string' ||
    !readCapabilityMatchesScope(decoded, {
      ...params.capabilityIssuer,
      path: relativePath,
    })
  ) {
    return errorResult(
      relativePath,
      `replace_range blocked: the readCapability belongs to a different project, path, or agent run. Re-read ${relativePath} in this run and copy its cap.v3 token.`,
    )
  }

  // Occurrence targeting is resolved to absolute lines by the agent-runtime
  // handler against the content it just read; re-resolving here against a
  // second read could diverge, so it is rejected instead.
  if (input.occurrence) {
    return errorResult(
      relativePath,
      'replace_range rejected: occurrence targeting must be resolved to absolute lines before the edit is applied. Re-issue the edit through the agent runtime, or pass explicit startLine/endLine.',
    )
  }

  let oldContent: string
  try {
    oldContent = await params.fs.readFile(fullPath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null
    return errorResult(
      relativePath,
      code ? `replace_range failed with ${code}: ${message}` : message,
    )
  }

  // Refuse an already-oversize target before normalizing and splitting it: no
  // range edit to such a file could be committed anyway, and rejecting here
  // avoids materializing the normalized copy and the line array for it.
  const oldBytes = Buffer.byteLength(oldContent)
  if (oldBytes > MAX_TRANSACTION_FILE_BYTES) {
    return errorResult(
      relativePath,
      `replace_range rejected: ${relativePath} is already ${oldBytes} bytes, over the ${MAX_TRANSACTION_FILE_BYTES}-byte per-file limit. Split the file before editing ranges in it.`,
    )
  }

  const coordinates = getLineCoordinates(oldContent)
  const { normalized: normalizedOldContent, lines } = coordinates

  // The schema contains the target inside the capability range, and a
  // successful re-anchor below proves that range sits inside the current file,
  // so no separate target length check is needed. Computing the bounds here is
  // safe even when they are stale: only the slicing and the raw span walk
  // further down require in-range lines.
  let targetStartLine = input.startLine ?? input.capabilityStartLine
  let targetEndLine = input.endLine ?? input.capabilityEndLine

  // Freshness is proven by locating the exact observed slice, which tolerates
  // lines inserted or deleted ABOVE the span without widening what the
  // capability authorizes: a missing or duplicated span still fails closed.
  // The match is LF-normalized, so a purely CRLF<->LF external rewrite is not
  // detected here; any content-level change still fails to match, and the
  // byte-exact expectation passed to `changeFile` below refuses the commit if
  // only the terminators changed.
  const reanchored = reanchorCapabilityRange({
    coordinates,
    startLine: input.capabilityStartLine,
    endLine: input.capabilityEndLine,
    expectedHash: input.capabilityHash,
  })
  if (!reanchored.ok) {
    // Stale bounds are only reported once relocation has also failed: a
    // capability whose recorded span now lies past a shortened file is still
    // recoverable while its observed content sits uniquely elsewhere, which is
    // exactly what the transaction path does.
    if (
      input.capabilityStartLine > coordinates.maxCapabilityLine ||
      input.capabilityEndLine > coordinates.maxCapabilityLine
    ) {
      // `maxCapabilityLine` is one past the visible count when the content ends
      // in a newline, so the diagnostic names both bounds.
      const displayLineCount = coordinates.visibleLineCount
      const maxCapabilityLine = coordinates.maxCapabilityLine
      return errorResult(
        relativePath,
        `replace_range rejected: the capability-covered range ${input.capabilityStartLine}-${input.capabilityEndLine} is beyond the current file length (${displayLineCount} lines). Capability bounds may extend to line ${maxCapabilityLine}${maxCapabilityLine > displayLineCount ? ', the phantom final entry a read reports past the visible content' : ''}. Re-read the target range before editing.`,
      )
    }
    return errorResult(
      relativePath,
      `replace_range rejected: ${relativePath} changed after the readCapability was issued (${describeReanchorFailure(reanchored)}). Re-read the exact target in this run and retry with the fresh cap.v3 token.`,
    )
  }
  if (reanchored.shiftedBy !== undefined) {
    // The authorized window now lives at reanchored.startLine-endLine, so the
    // target moves by the SAME delta: it stays exactly where it was observed
    // inside that window, and the raw splice below hits the shifted lines
    // instead of the stale ones.
    targetStartLine += reanchored.shiftedBy
    targetEndLine += reanchored.shiftedBy
  }

  const currentRange = lines
    .slice(targetStartLine - 1, targetEndLine)
    .join('\n')
  const normalizedNewContent = normalizeLineEndings(input.newContent)
  // Both sides are LF-normalized, so a line-endings-only edit is rejected as a
  // no-op: the splice below cannot apply newContent's terminator style anyway.
  if (currentRange === normalizedNewContent) {
    return errorResult(
      relativePath,
      'replace_range rejected: newContent is identical to the current range; no change was made.',
    )
  }

  // Splice on the raw content so bytes outside [startLine, endLine] keep their
  // original line terminators; `changeFile` is still handed the whole file.
  const rawRangeSpan = getRawRangeSpan(
    oldContent,
    lines,
    targetStartLine,
    targetEndLine,
  )
  // Single-line newContent has no terminator to rewrite, so the terminator
  // inference — which slices and scans the whole replaced span — is skipped.
  const splicedNewContent = normalizedNewContent.includes('\n')
    ? normalizedNewContent
        .split('\n')
        .join(getRangeLineEnding(oldContent, rawRangeSpan))
    : normalizedNewContent
  const updatedContent =
    oldContent.slice(0, rawRangeSpan.start) +
    splicedNewContent +
    oldContent.slice(rawRangeSpan.end)
  // `newContent` is unbounded in the schema and `changeFile` starts with
  // `FileContentChangeSchema.parse`, whose per-file byte refine *throws*. The
  // same bound is checked here so an oversize edit still returns this tool's
  // declared `{ file, errorMessage }` shape instead of a ZodError.
  const updatedBytes = Buffer.byteLength(updatedContent)
  if (updatedBytes > MAX_TRANSACTION_FILE_BYTES) {
    return errorResult(
      relativePath,
      `replace_range rejected: the updated ${relativePath} would be ${updatedBytes} bytes, over the ${MAX_TRANSACTION_FILE_BYTES}-byte per-file limit. Split the work into smaller bounded range edits.`,
    )
  }

  // `changeFile` re-reads and commits conditionally on `expectedHash` inside
  // its path lock, so this read is only a pre-check and that lock closes the
  // TOCTOU window. The splice above was computed from the raw bytes of this
  // read while `expectedHash` is LF-normalized, so the byte-exact expectation
  // is passed too: a CRLF<->LF-only external rewrite would otherwise pass
  // freshness and resurrect the terminators this read observed.
  return changeFile({
    parameters: {
      type: 'file',
      path: relativePath,
      content: updatedContent,
      // `getContentHash` normalizes internally, so hashing the already
      // normalized copy yields the identical digest without a second rewrite.
      expectedHash: getContentHash(normalizedOldContent),
    },
    expectedExactHash: getExactContentHash(oldContent),
    cwd: params.cwd,
    fs: params.fs,
    signal: params.signal,
    fileFilter: params.fileFilter,
    callId: params.callId,
    filesystemPolicy: params.filesystemPolicy,
    capabilityIssuer: params.capabilityIssuer,
    logger: params.logger,
  })
}
