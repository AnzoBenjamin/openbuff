import path from 'node:path'
import { isSandboxSensitivePath } from '@codebuff/common/util/filesystem-sandbox'

import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import {
  buildReadFilesResultV1,
  FILESYSTEM_RESULT_CONTENT_MAX_BYTES,
  isReadFilesResultV1,
  type FilesystemError,
  type ReadFilesItemV1,
  type ReadFilesResultV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  encodeReadCapabilityToken,
  getContentHash,
  hasAuthoritativeReadCapabilityScope,
  normalizeLineEndings,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import { parseRawReadBasis } from '@codebuff/common/util/raw-read-basis'
import { rankNearPaths } from '@codebuff/common/util/path-suggestions'
import {
  isEnvTemplatePath,
  isMandatorySensitiveReadPath,
} from '@codebuff/common/util/sensitive-paths'

import {
  getScopedReadPolicyAliases,
  isSafeProjectRelativePath,
  resolveFilePathForFileSystemOperation,
  resolveFilePathForFileSystemReadOperation,
} from './path-utils'
import { mapWithConcurrency, throwIfAborted } from './concurrency'

import type { FileLineRange } from '@codebuff/common/types/contracts/client'
import type {
  CodebuffFileSystem,
  CodebuffTextRangeReadResult,
} from '@codebuff/common/types/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type {
  CapturedTextDocument,
  TextCaptureOptions,
} from '@codebuff/common/util/byte-text'
import type { RawReadBasisV1 } from '@codebuff/common/util/raw-read-basis'

export type FileFilterResult = {
  status: 'blocked' | 'allow-example' | 'allow'
}

export type FileFilter = (filePath: string) => FileFilterResult

export type { FileLineRange }

export const READ_SNAPSHOT_CONCURRENCY = 8
export const MAX_RANGE_READ_BYTES = 4_194_304

const MAX_FILE_BYTES = FILESYSTEM_RESULT_CONTENT_MAX_BYTES
// The 10MB byte gate (MAX_FILE_BYTES) is now the single read ceiling: any file
// that passes it renders fully (whole-file and range reads) so reviewers and
// agents can read and attest to large source files. content.length is a
// UTF-16 code-unit count that is always <= the file's byte size, so equating
// the char render cap to the byte gate means "never truncate on characters
// below the 10MB byte ceiling."
const MAX_RENDER_CHARS = MAX_FILE_BYTES
const numFmt = new Intl.NumberFormat('en-US')

/** Stable marker for rendered range reads. */
export const RANGE_BLOCK_MARKER = '[RANGE_BLOCK '

const BINARY_MARKER = '[FILE_BINARY]'
const UNSUPPORTED_ENCODING_MARKER = '[FILE_UNSUPPORTED_ENCODING]'

type AuthorizedReadTarget = {
  displayPath: string
  operationPath: string
  isExampleFile: boolean
}

type ResolvedReadTarget =
  | { ok: true; target: AuthorizedReadTarget }
  | { ok: false; displayPath: string; error: FilesystemError }

type PlannedSelector =
  | {
      selector: 'file'
      requestIndex: number
      requestedPath: string
      resolved: ResolvedReadTarget
    }
  | {
      selector: 'range'
      requestIndex: number
      requestedPath: string
      range: FileLineRange
      resolved: ResolvedReadTarget
    }

type FullSnapshot = {
  state: 'full'
  content: string
  document: CapturedTextDocument
  sizeBytes: number
  metadataComplete: boolean
  rawBasis?: RawReadBasisV1
}

type RangeWindow = {
  content: string
  document: CapturedTextDocument
  startLine: number
  endLine: number
  totalLines: number
  complete: boolean
  metadataComplete?: boolean
  rawBasis?: RawReadBasisV1
}

type LargeSnapshot = {
  state: 'large'
  sizeBytes?: number
  windows?: Map<number, RangeWindow>
  rangeErrors?: Map<number, FilesystemError>
}

type FailedSnapshot = {
  state: 'error'
  error: FilesystemError
}

type ReadSnapshot = FullSnapshot | LargeSnapshot | FailedSnapshot

export type OptionalFileReadResult =
  | {
      status: 'found'
      path: string
      content: string
      template: boolean
      metadataComplete?: boolean
      rawBasis?: RawReadBasisV1
    }
  | {
      status:
        | 'not_found'
        | 'blocked'
        | 'outside_project'
        | 'too_large'
        | 'io_error'
        | 'binary'
        | 'unsupported_encoding'
      path: string
      error: FilesystemError
    }

function filesystemError(
  code: FilesystemError['code'],
  message: string,
  options: Pick<FilesystemError, 'retryable' | 'recovery'>,
): FilesystemError {
  return { code, message, ...options }
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

export { isMandatorySensitiveReadPath }

function uniquePolicyAliases(...values: string[]): string[] {
  const aliases = new Set<string>()
  for (const value of values) {
    const portable = toPortablePath(value)
    aliases.add(portable)
    aliases.add(portable.toLowerCase())
  }
  return [...aliases]
}

async function authorizeReadTarget(params: {
  requestedPath: string
  cwd: string
  canonicalRoot: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}): Promise<ResolvedReadTarget> {
  const { requestedPath, cwd, canonicalRoot, fs, fileFilter } = params
  if (!isSafeProjectRelativePath(requestedPath, fs.hostReadPolicy)) {
    return {
      ok: false,
      displayPath: requestedPath,
      error: filesystemError(
        'outside_project',
        FILE_READ_STATUS.OUTSIDE_PROJECT,
        { retryable: false },
      ),
    }
  }

  // Read-only resolver: in-project and owned-temp paths behave exactly as
  // before, plus paths strictly inside an explicitly allowlisted external read
  // root. The write path keeps using resolveFilePathForFileSystemOperation.
  const resolved = await resolveFilePathForFileSystemReadOperation(
    cwd,
    requestedPath,
    fs,
  )
  if (!resolved) {
    return {
      ok: false,
      displayPath: requestedPath,
      error: filesystemError(
        'outside_project',
        FILE_READ_STATUS.OUTSIDE_PROJECT,
        { retryable: false },
      ),
    }
  }

  const canonicalRelative = path.relative(canonicalRoot, resolved.operationPath)
  const aliases = uniquePolicyAliases(
    resolved.relativePath,
    canonicalRelative || resolved.relativePath,
  )
  // Non-project scopes (owned-temp AND external-read) carry an ABSOLUTE
  // `relativePath`, so a host filter written against project-relative globs
  // never matches it and would silently fail OPEN. `getScopedReadPolicyAliases`
  // is the CANONICAL builder for those keys (`owned-temp/notes.txt`,
  // `external-read/notes.txt`), shared with read-logs / read-image /
  // list-directory so the four read tools cannot drift on the key a host
  // fileFilter must target; it returns nothing for scope 'project'. The
  // mandatory sensitive-path blocklist below is basename-driven and unaffected.
  for (const alias of uniquePolicyAliases(
    ...getScopedReadPolicyAliases(resolved.scope, resolved.operationPath),
  )) {
    if (!aliases.includes(alias)) aliases.push(alias)
  }
  if (aliases.some(alias => isSandboxSensitivePath(alias, fs.hostReadPolicy))) {
    return {
      ok: false,
      displayPath: resolved.relativePath,
      error: filesystemError('blocked', FILE_READ_STATUS.IGNORED, {
        retryable: false,
      }),
    }
  }

  const filterResults = fileFilter
    ? aliases.map((alias) => fileFilter(alias))
    : []
  if (filterResults.some((result) => result.status === 'blocked')) {
    return {
      ok: false,
      displayPath: resolved.relativePath,
      error: filesystemError('blocked', FILE_READ_STATUS.IGNORED, {
        retryable: false,
      }),
    }
  }

  // Ignore files are a discovery preference, not an authorization boundary.
  // Explicit project-contained reads remain available; mandatory sensitive
  // paths and host filters above continue to fail closed.
  const isExampleFile =
    aliases.every(isEnvTemplatePath) &&
    filterResults.some((result) => result.status === 'allow-example')

  return {
    ok: true,
    target: {
      displayPath: resolved.relativePath,
      operationPath: resolved.operationPath,
      isExampleFile,
    },
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function toBytes(value: NodeJS.ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function decodeText(
  input: string | Uint8Array,
  options: TextCaptureOptions = {},
):
  | { ok: true; document: CapturedTextDocument }
  | { ok: false; error: FilesystemError } {
  if (typeof input === 'string' ? input.includes('\0') : input.includes(0)) {
    return {
      ok: false,
      error: filesystemError(
        'binary',
        `${BINARY_MARKER} Binary content cannot be read with read_files.`,
        { retryable: false },
      ),
    }
  }
  if (
    typeof input !== 'string' &&
    ((input[0] === 0xff && input[1] === 0xfe) ||
      (input[0] === 0xfe && input[1] === 0xff))
  ) {
    return {
      ok: false,
      error: filesystemError(
        'unsupported_encoding',
        `${UNSUPPORTED_ENCODING_MARKER} UTF-16 text is not supported by read_files.`,
        { retryable: false, recovery: 'use_supported_encoding' },
      ),
    }
  }
  try {
    return {
      ok: true,
      document: captureTextDocument(input, options),
    }
  } catch {
    return {
      ok: false,
      error: filesystemError(
        'unsupported_encoding',
        `${UNSUPPORTED_ENCODING_MARKER} The file is not valid UTF-8 text.`,
        { retryable: false, recovery: 'use_supported_encoding' },
      ),
    }
  }
}

function readerMatchesView(
  fs: CodebuffFileSystem,
  reader: NonNullable<
    CodebuffFileSystem['readTextRange'] | CodebuffFileSystem['readTextFile']
  >,
  member: 'readTextRange' | 'readTextFile',
): boolean {
  return reader.readFileView !== undefined
    ? reader.readFileView === fs.readFile
    : member === 'readTextRange' && Object.hasOwn(fs, member)
}

function decodeBoundedResult(
  result: CodebuffTextRangeReadResult,
  maxBytes: number,
  paired: boolean,
): { ok: true; window: RangeWindow } | { ok: false; error: FilesystemError } {
  const invalid = (): { ok: false; error: FilesystemError } => ({
    ok: false,
    error: filesystemError(
      'io_error',
      'The filesystem returned an invalid bounded text result.',
      { retryable: true, recovery: 'read_again' },
    ),
  })
  if (
    !(result.data instanceof Uint8Array) ||
    result.data.byteLength > maxBytes ||
    !Number.isSafeInteger(result.startLine) ||
    !Number.isSafeInteger(result.endLine) ||
    !Number.isSafeInteger(result.totalLines) ||
    result.startLine < 1 ||
    result.endLine < 0 ||
    result.totalLines < 0 ||
    (result.endLine !== 0 && result.endLine < result.startLine)
  )
    return invalid()
  if (result.metadataComplete === false) {
    return {
      ok: false,
      error: filesystemError(
        'unsupported',
        'This bounded text view did not observe complete EOF and total metadata.',
        { retryable: false },
      ),
    }
  }
  let basis: RawReadBasisV1 | undefined
  try {
    if (result.rawBasis !== undefined)
      basis = parseRawReadBasis(result.rawBasis)
  } catch {
    return invalid()
  }
  const decoded = decodeText(result.data, {
    includesBom:
      basis?.includesBom ?? (result.startLine === 1 ? undefined : false),
    view: basis?.view ?? 'adapter_bytes',
    coherence: basis?.coherence ?? 'observed',
    ...(basis?.generation === undefined
      ? {}
      : { generation: basis.generation }),
  })
  if (!decoded.ok) return decoded
  const { document } = decoded
  if (
    basis &&
    (basis.rawHash !== document.rawHash ||
      basis.endByteExclusive - basis.startByte !== document.byteLength ||
      (basis.scope === 'whole' && result.startLine !== 1))
  )
    return invalid()
  if (
    result.endLine > result.totalLines &&
    (result.endLine !== result.totalLines + 1 ||
      !basis ||
      result.metadataComplete !== true ||
      basis.endByteExclusive !== basis.documentBytes ||
      result.endLine - result.startLine + 1 !== document.maxCapabilityLine)
  )
    return invalid()
  // Missing pairing/basis/metadata is a legacy display tier, never new edit authority.
  const verifiedBasis =
    paired && result.metadataComplete === true ? basis : undefined
  return {
    ok: true,
    window: {
      content: document.observation,
      document,
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: result.totalLines,
      complete: result.complete,
      metadataComplete: result.metadataComplete,
      ...(verifiedBasis ? { rawBasis: verifiedBasis } : {}),
    },
  }
}

function snapshotReadError(error: unknown): FilesystemError {
  if (errorCode(error) === 'ENOENT') {
    return filesystemError('not_found', FILE_READ_STATUS.DOES_NOT_EXIST, {
      retryable: true,
      recovery: 'discover_path',
    })
  }
  if (errorCode(error) === 'UNSUPPORTED_ENCODING') {
    return filesystemError(
      'unsupported_encoding',
      `${UNSUPPORTED_ENCODING_MARKER} The file is not valid UTF-8 text.`,
      { retryable: false, recovery: 'use_supported_encoding' },
    )
  }
  return filesystemError('io_error', FILE_READ_STATUS.ERROR, {
    retryable: true,
    recovery: 'read_again',
  })
}

async function readCanonicalSnapshot(params: {
  operationPath: string
  selectors: PlannedSelector[]
  fs: CodebuffFileSystem
  signal?: AbortSignal
}): Promise<ReadSnapshot> {
  const { operationPath, selectors, fs, signal } = params
  throwIfAborted(signal)
  let sizeBytes: number
  try {
    sizeBytes = (await fs.stat(operationPath)).size
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new TypeError('Invalid filesystem size metadata')
    }
  } catch (error) {
    throwIfAborted(signal)
    return { state: 'error', error: snapshotReadError(error) }
  }

  const readRanges = async (observedSize?: number): Promise<LargeSnapshot> => {
    const ranges = selectors.filter(
      (selector): selector is Extract<PlannedSelector, { selector: 'range' }> =>
        selector.selector === 'range',
    )
    if (ranges.length === 0) return { state: 'large', sizeBytes: observedSize }
    const readTextRange = fs.readTextRange
    if (
      !readTextRange ||
      !readerMatchesView(fs, readTextRange, 'readTextRange')
    ) {
      return {
        state: 'large',
        sizeBytes: observedSize,
        rangeErrors: new Map(
          ranges.map((selector) => [
            selector.requestIndex,
            filesystemError(
              'unsupported',
              'This filesystem does not advertise bounded text range reads for oversized files.',
              { retryable: false },
            ),
          ]),
        ),
      }
    }
    const windows = new Map<number, RangeWindow>()
    const rangeErrors = new Map<number, FilesystemError>()

    // Oversized selectors are independent bounded reads. This deliberately
    // avoids collapsing distant ranges into one min..max window whose byte
    // budget can be consumed entirely by the unrelated gap.
    for (const selector of ranges) {
      const startLine = Math.max(1, selector.range.startLine ?? 1)
      const endLine = selector.range.endLine ?? Number.MAX_SAFE_INTEGER
      try {
        throwIfAborted(signal)
        const range = await readTextRange.call(
          fs,
          operationPath,
          startLine,
          endLine,
          MAX_RANGE_READ_BYTES,
          { signal },
        )
        throwIfAborted(signal)
        const decoded = decodeBoundedResult(
          range,
          MAX_RANGE_READ_BYTES,
          readTextRange.readFileView === fs.readFile,
        )
        if (!decoded.ok) {
          rangeErrors.set(selector.requestIndex, decoded.error)
          continue
        }
        windows.set(selector.requestIndex, decoded.window)
      } catch (error) {
        throwIfAborted(signal)
        rangeErrors.set(selector.requestIndex, snapshotReadError(error))
      }
    }
    return { state: 'large', sizeBytes: observedSize, windows, rangeErrors }
  }

  if (sizeBytes > MAX_FILE_BYTES) return readRanges(sizeBytes)

  try {
    throwIfAborted(signal)
    const readTextFile = fs.readTextFile
    if (readTextFile && readerMatchesView(fs, readTextFile, 'readTextFile')) {
      const result = await readTextFile.call(
        fs,
        operationPath,
        MAX_FILE_BYTES,
        { signal },
      )
      throwIfAborted(signal)
      const decoded = decodeBoundedResult(result, MAX_FILE_BYTES, true)
      if (!decoded.ok) return { state: 'error', error: decoded.error }
      const { window } = decoded
      if (!window.complete) return readRanges(window.rawBasis?.documentBytes)
      if (
        window.startLine !== 1 ||
        (window.endLine !== window.document.visibleLineCount &&
          window.endLine !== window.document.maxCapabilityLine) ||
        (window.rawBasis && window.rawBasis.scope !== 'whole')
      ) {
        return {
          state: 'error',
          error: filesystemError(
            'io_error',
            'The bounded whole reader did not return complete document coverage.',
            {
              retryable: true,
              recovery: 'read_again',
            },
          ),
        }
      }
      return {
        state: 'full',
        content: window.content,
        document: window.document,
        sizeBytes: window.document.byteLength,
        metadataComplete: window.metadataComplete === true,
        ...(window.rawBasis ? { rawBasis: window.rawBasis } : {}),
      }
    }
    // Custom unbounded views can still be displayed. They cannot claim the
    // default descriptor's allocation or raw authority after decorating it.
    const raw = await fs.readFile(operationPath)
    throwIfAborted(signal)
    const actualBytes =
      typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
    if (actualBytes > MAX_FILE_BYTES) return readRanges(actualBytes)
    const decoded = decodeText(typeof raw === 'string' ? raw : toBytes(raw), {
      view: typeof raw === 'string' ? 'text_view' : 'adapter_bytes',
      coherence: 'observed',
    })
    return decoded.ok
      ? {
          state: 'full',
          content: decoded.document.observation,
          document: decoded.document,
          sizeBytes: actualBytes,
          metadataComplete: false,
        }
      : { state: 'error', error: decoded.error }
  } catch (error) {
    throwIfAborted(signal)
    return { state: 'error', error: snapshotReadError(error) }
  }
}

async function planNativeReads(params: {
  filePaths: string[]
  ranges: FileLineRange[]
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
  signal?: AbortSignal
}): Promise<{
  selectors: PlannedSelector[]
  snapshots: Map<string, ReadSnapshot>
}> {
  const { filePaths, ranges, cwd, fs, fileFilter, signal } = params
  throwIfAborted(signal)
  const requestedPaths = [
    ...new Set([...filePaths, ...ranges.map((range) => range.path)]),
  ]
  const root = await resolveFilePathForFileSystemOperation(cwd, '.', fs)
  const canonicalRoot = root?.operationPath ?? path.resolve(cwd)
  const resolvedValues = await mapWithConcurrency(
    requestedPaths,
    READ_SNAPSHOT_CONCURRENCY,
    (requestedPath) =>
      authorizeReadTarget({
        requestedPath,
        cwd,
        canonicalRoot,
        fs,
        fileFilter,
      }),
    signal,
  )
  const resolvedByPath = new Map(
    requestedPaths.map((requestedPath, index) => [
      requestedPath,
      resolvedValues[index]!,
    ]),
  )
  const selectors: PlannedSelector[] = [
    ...filePaths.map((requestedPath, requestIndex) => ({
      selector: 'file' as const,
      requestIndex,
      requestedPath,
      resolved: resolvedByPath.get(requestedPath)!,
    })),
    ...ranges.map((range, index) => ({
      selector: 'range' as const,
      requestIndex: filePaths.length + index,
      requestedPath: range.path,
      range,
      resolved: resolvedByPath.get(range.path)!,
    })),
  ]

  const groups = new Map<
    string,
    { operationPath: string; selectors: PlannedSelector[] }
  >()
  for (const selector of selectors) {
    if (!selector.resolved.ok) continue
    const { operationPath } = selector.resolved.target
    const group = groups.get(operationPath) ?? { operationPath, selectors: [] }
    group.selectors.push(selector)
    groups.set(operationPath, group)
  }
  const groupValues = [...groups.values()]
  const snapshots = await mapWithConcurrency(
    groupValues,
    READ_SNAPSHOT_CONCURRENCY,
    (group) => readCanonicalSnapshot({ ...group, fs, signal }),
    signal,
  )
  return {
    selectors,
    snapshots: new Map(
      groupValues.map((group, index) => [
        group.operationPath,
        snapshots[index]!,
      ]),
    ),
  }
}

function renderWithLinePrefixes(
  lines: string[],
  startIdx: number,
  endIdx: number,
  maxLineForWidth: number,
  lineOffset = 0,
): string {
  const width = String(maxLineForWidth).length
  const output: string[] = []
  for (let index = startIdx; index <= endIdx; index++) {
    const lineNumber = String(index + 1 + lineOffset).padStart(width, ' ')
    output.push(`${lineNumber}\t${lines[index] ?? ''}`)
  }
  return output.join('\n')
}

function splitVisibleLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = normalizeLineEndings(content).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// Defensive/retained helper: only feeds the whole-file truncation branch
// above, which is unreachable while MAX_RENDER_CHARS === MAX_FILE_BYTES. Kept
// so it auto re-activates if MAX_RENDER_CHARS is ever lowered below the byte gate.
function pickHeadTailLines(
  lines: string[],
  maxChars: number,
): { headEnd: number; tailStart: number } {
  const headBudget = Math.floor(maxChars * 0.6)
  const tailBudget = maxChars - headBudget
  let headChars = 0
  let headEnd = -1
  for (let index = 0; index < lines.length; index++) {
    const added = (lines[index]?.length ?? 0) + 1
    if (headChars + added > headBudget) break
    headChars += added
    headEnd = index
  }
  let tailChars = 0
  let tailStart = lines.length
  for (let index = lines.length - 1; index > headEnd; index--) {
    const added = (lines[index]?.length ?? 0) + 1
    if (tailChars + added > tailBudget) break
    tailChars += added
    tailStart = index
  }
  return { headEnd, tailStart }
}

function errorItem(
  selector: PlannedSelector,
  pathValue: string,
  error: FilesystemError,
): ReadFilesItemV1 {
  return {
    selector: selector.selector,
    requestIndex: selector.requestIndex,
    path: pathValue,
    status: 'error',
    error,
  }
}

function renderWholeFileItem(
  selector: Extract<PlannedSelector, { selector: 'file' }>,
  snapshot: ReadSnapshot,
  capabilityIssuer?: ReadCapabilityIssuer,
): ReadFilesItemV1 {
  if (!selector.resolved.ok) {
    return errorItem(
      selector,
      selector.resolved.displayPath,
      selector.resolved.error,
    )
  }
  const { target } = selector.resolved
  if (snapshot.state === 'error') {
    return errorItem(selector, target.displayPath, snapshot.error)
  }
  if (snapshot.state === 'large') {
    return errorItem(
      selector,
      target.displayPath,
      filesystemError(
        'too_large',
        `${FILE_READ_STATUS.TOO_LARGE} [${
          snapshot.sizeBytes === undefined
            ? 'The file exceeded the 10MB read limit'
            : `${(snapshot.sizeBytes / (1024 * 1024)).toFixed(1)}MB exceeds 10MB limit`
        }. Read an exact bounded range instead.]`,
        { retryable: true, recovery: 'read_smaller_range' },
      ),
    )
  }

  const { content } = snapshot
  const partial = content.length > MAX_RENDER_CHARS
  let renderedContent = content
  let truncation:
    | {
        reason: 'character_limit'
        omittedStartLine?: number
        omittedEndLine?: number
      }
    | undefined
  if (partial) {
    // Defensive/retained code: unreachable while MAX_RENDER_CHARS ===
    // MAX_FILE_BYTES, because content.length (UTF-16 code units) is always <=
    // the file's byte size, so a sub-10MB full snapshot never has
    // content.length > MAX_RENDER_CHARS. Kept intentionally so it auto
    // re-activates if MAX_RENDER_CHARS is ever lowered below the byte gate.
    const lines = splitVisibleLines(content)
    const totalLines = lines.length
    const { headEnd, tailStart } = pickHeadTailLines(lines, MAX_RENDER_CHARS)
    if (headEnd < 0 || tailStart > totalLines - 1 || tailStart <= headEnd + 1) {
      renderedContent = `${content.slice(0, MAX_RENDER_CHARS)}\n\n[FILE_TOO_LARGE: This file is ${numFmt.format(content.length)} chars (${numFmt.format(totalLines)} lines), exceeding the ${numFmt.format(MAX_RENDER_CHARS)} char limit. The content above has been truncated. Re-read specific sections with read_files using ranges: [{ path: "${target.displayPath}", startLine, endLine }]. Do not edit from this truncated content. Large-file edits require basedOnRead from fresh range reads.]`
      truncation = { reason: 'character_limit' }
    } else {
      const omittedStartLine = headEnd + 2
      const omittedEndLine = tailStart
      renderedContent = `${renderWithLinePrefixes(lines, 0, headEnd, totalLines)}\n\n[FILE_TOO_LARGE: This file is ${numFmt.format(content.length)} chars (${numFmt.format(totalLines)} lines), exceeding the ${numFmt.format(MAX_RENDER_CHARS)} char limit. Omitted lines ${numFmt.format(omittedStartLine)}-${numFmt.format(omittedEndLine)}. Re-read specific sections with read_files using ranges: [{ path: "${target.displayPath}", startLine, endLine }]. Do not edit from this truncated content. Large-file edits require basedOnRead from fresh range reads.]\n\n${renderWithLinePrefixes(lines, tailStart, totalLines - 1, totalLines)}`
      truncation = {
        reason: 'character_limit',
        omittedStartLine,
        omittedEndLine,
      }
    }
  }
  const contentHash = !partial ? snapshot.document.observationHash : undefined
  const rawBasis =
    !partial && snapshot.metadataComplete ? snapshot.rawBasis : undefined
  const capabilityScope = capabilityIssuer
    ? { ...capabilityIssuer, path: target.displayPath }
    : undefined
  const readCapability =
    contentHash &&
    rawBasis?.scope === 'whole' &&
    capabilityScope &&
    hasAuthoritativeReadCapabilityScope(capabilityScope)
      ? encodeReadCapabilityToken({
          startLine: 1,
          endLine: snapshot.document.maxCapabilityLine,
          hash: contentHash,
          scope: capabilityScope,
          rawBasis,
        })
      : undefined
  return {
    selector: 'file',
    requestIndex: selector.requestIndex,
    path: target.displayPath,
    status: partial ? 'partial' : 'ok',
    content: renderedContent,
    complete: !partial,
    metadataComplete: snapshot.metadataComplete,
    template: target.isExampleFile,
    ...(contentHash && readCapability
      ? {
          editAnchor: {
            startLine: 1,
            endLine: snapshot.document.maxCapabilityLine,
            contentHash,
            readCapability,
            rawBasis,
          },
          rawSourceContent: snapshot.document.rawText,
        }
      : {}),
    ...(truncation ? { truncation } : {}),
  }
}

function getWindowRawBasis(
  window: RangeWindow,
  startLine: number,
  endLine: number,
): RawReadBasisV1 | undefined {
  const original = window.rawBasis
  if (!original || window.metadataComplete !== true || !window.complete)
    return undefined
  const first = startLine - window.startLine + 1
  const last = endLine - window.startLine + 1
  const local = getRawReadBasis(window.document, first, last, 'lines')
  return parseRawReadBasis({
    ...original,
    scope: 'lines',
    rawHash: local.rawHash,
    startByte: original.startByte + local.startByte,
    endByteExclusive: original.startByte + local.endByteExclusive,
    includesBom: local.includesBom,
    endTerminator: local.endTerminator,
  })
}

function renderRangeItem(
  selector: Extract<PlannedSelector, { selector: 'range' }>,
  snapshot: ReadSnapshot,
  capabilityIssuer?: ReadCapabilityIssuer,
): ReadFilesItemV1 {
  if (!selector.resolved.ok) {
    return errorItem(
      selector,
      selector.resolved.displayPath,
      selector.resolved.error,
    )
  }
  const { target } = selector.resolved
  if (snapshot.state === 'error') {
    return errorItem(selector, target.displayPath, snapshot.error)
  }
  const largeWindow =
    snapshot.state === 'large'
      ? snapshot.windows?.get(selector.requestIndex)
      : undefined
  if (snapshot.state === 'large' && !largeWindow) {
    return errorItem(
      selector,
      target.displayPath,
      snapshot.rangeErrors?.get(selector.requestIndex) ??
        filesystemError(
          'unsupported',
          'Bounded range reading is unavailable for this oversized file.',
          { retryable: false },
        ),
    )
  }

  const fullDocument = snapshot.state === 'full' ? snapshot.document : undefined
  const window = snapshot.state === 'large' ? largeWindow! : undefined
  const sourceDocument = fullDocument ?? window!.document
  const lines = sourceDocument.observation.split('\n')
  const totalLines = fullDocument
    ? fullDocument.visibleLineCount
    : window!.totalLines
  const maximumLine =
    fullDocument?.maxCapabilityLine ??
    Math.max(
      totalLines,
      window!.rawBasis &&
        window!.metadataComplete === true &&
        window!.rawBasis.endByteExclusive === window!.rawBasis.documentBytes
        ? window!.endLine
        : totalLines,
    )
  const desiredStart = Math.max(1, selector.range.startLine ?? 1)
  const desiredEnd = Math.min(
    maximumLine,
    selector.range.endLine ?? Math.max(1, totalLines),
  )
  if (desiredStart > maximumLine || desiredEnd < desiredStart) {
    return errorItem(
      selector,
      target.displayPath,
      filesystemError(
        'invalid_request',
        `${RANGE_BLOCK_MARKER}requested lines ${desiredStart}-${selector.range.endLine ?? totalLines} but file ${target.displayPath} has only ${numFmt.format(totalLines)} lines.]`,
        { retryable: true, recovery: 'read_smaller_range' },
      ),
    )
  }

  const sourceStart = window?.startLine ?? 1
  const sourceEnd = window?.endLine ?? fullDocument!.maxCapabilityLine
  const returnedStart = Math.max(desiredStart, sourceStart)
  const returnedEnd = Math.min(desiredEnd, sourceEnd)
  if (returnedEnd < returnedStart) {
    return errorItem(
      selector,
      target.displayPath,
      filesystemError(
        'too_large',
        'The requested range was outside the bounded snapshot. Request a smaller range.',
        { retryable: true, recovery: 'read_smaller_range' },
      ),
    )
  }

  const startIndex = returnedStart - sourceStart
  const endIndex = returnedEnd - sourceStart
  const slice = lines.slice(startIndex, endIndex + 1).join('\n')
  let body = renderWithLinePrefixes(
    lines,
    startIndex,
    endIndex,
    returnedEnd,
    sourceStart - 1,
  )
  const covered = returnedStart === desiredStart && returnedEnd === desiredEnd
  const exceedsRenderLimit = body.length > MAX_RENDER_CHARS
  const complete = covered && (window?.complete ?? true) && !exceedsRenderLimit
  if (!complete) {
    body = `${body.slice(0, MAX_RENDER_CHARS)}\n\n[FILE_TOO_LARGE: This range exceeded a bounded read or render limit. Request a smaller line range before editing; do not edit from this truncated range.]`
  }
  const rangeHash = complete ? getContentHash(slice) : undefined
  const rawBasis = complete
    ? snapshot.state === 'full'
      ? snapshot.metadataComplete && snapshot.rawBasis
        ? getRawReadBasis(snapshot.document, desiredStart, desiredEnd, 'lines')
        : undefined
      : getWindowRawBasis(window!, desiredStart, desiredEnd)
    : undefined
  const capabilityScope = capabilityIssuer
    ? { ...capabilityIssuer, path: target.displayPath }
    : undefined
  const readCapability =
    rangeHash &&
    rawBasis &&
    capabilityScope &&
    hasAuthoritativeReadCapabilityScope(capabilityScope)
      ? encodeReadCapabilityToken({
          startLine: desiredStart,
          endLine: desiredEnd,
          hash: rangeHash,
          scope: capabilityScope,
          rawBasis,
        })
      : undefined
  // Range header: emitted as a single line so normalizeReadFilesOverrideResult's
  // regex still matches (lines N-M of X ... rangeHash=...; readCapability=...).
  // rangeHash and readCapability stay on that same line (separated by '; '),
  // followed by inline `preferred block edit:` and `scoped str_replace:`
  // guidance that repeats the readCapability for quick copy/paste.
  const header = complete
    ? readCapability
      ? `${RANGE_BLOCK_MARKER}lines ${desiredStart}-${desiredEnd} of ${numFmt.format(totalLines)} in ${target.displayPath}; rangeHash=${rangeHash}; readCapability=${readCapability}; preferred block edit: replace_range { readCapability: "${readCapability}", newContent: "..." }; scoped str_replace: basedOnRead="${readCapability}"]\n`
      : `${RANGE_BLOCK_MARKER}lines ${desiredStart}-${desiredEnd} of ${numFmt.format(totalLines)} in ${target.displayPath}; rangeHash=${rangeHash}; readCapability=omitted; This filesystem view supplied no verified bounded raw edit authority. Obtain a fresh supported read before editing.]\n`
    : `${RANGE_BLOCK_MARKER}lines ${returnedStart}-${returnedEnd} of ${numFmt.format(totalLines)} in ${target.displayPath}; rangeHash=omitted; readCapability=omitted; NO edit capability or read authorization was minted by this truncated read — request a smaller, fully-covered range before editing to obtain a fresh basedOnRead capability]\n`
  return {
    selector: 'range',
    requestIndex: selector.requestIndex,
    path: target.displayPath,
    status: complete ? 'ok' : 'partial',
    content: header + body,
    ...(complete ? { sourceContent: slice } : {}),
    startLine: complete ? desiredStart : returnedStart,
    endLine: complete ? desiredEnd : returnedEnd,
    totalLines,
    complete,
    metadataComplete:
      snapshot.state === 'full'
        ? snapshot.metadataComplete
        : window!.metadataComplete,
    ...(rangeHash && readCapability
      ? {
          editAnchor: {
            startLine: desiredStart,
            endLine: desiredEnd,
            contentHash: rangeHash,
            readCapability,
            rawBasis,
          },
        }
      : {}),
    ...(!complete
      ? { truncation: { reason: 'character_limit' as const } }
      : {}),
  }
}

export async function getFilesStructured(params: {
  filePaths: string[]
  cwd: string
  fs: CodebuffFileSystem
  /** Custom policy composes with mandatory sensitive and ignore policy. */
  fileFilter?: FileFilter
  ranges?: FileLineRange[]
  signal?: AbortSignal
  capabilityIssuer?: ReadCapabilityIssuer
}): Promise<ReadFilesResultV1> {
  const {
    filePaths,
    cwd,
    fs,
    fileFilter,
    ranges = [],
    signal,
    capabilityIssuer,
  } = params
  const plan = await planNativeReads({
    filePaths,
    ranges,
    cwd,
    fs,
    fileFilter,
    signal,
  })
  throwIfAborted(signal)
  const results = plan.selectors.map((selector) => {
    if (!selector.resolved.ok) {
      return errorItem(
        selector,
        selector.resolved.displayPath,
        selector.resolved.error,
      )
    }
    const snapshot = plan.snapshots.get(selector.resolved.target.operationPath)!
    return selector.selector === 'file'
      ? renderWholeFileItem(selector, snapshot, capabilityIssuer)
      : renderRangeItem(selector, snapshot, capabilityIssuer)
  })
  await attachNotFoundCandidates({
    results,
    cwd,
    fs,
    fileFilter,
    signal,
  })
  return buildReadFilesResultV1(results)
}

const SUGGESTION_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.next',
  '.turbo',
])
const SUGGESTION_MAX_ENTRIES = 2_000
const SUGGESTION_MAX_ANCESTOR_HOPS = 3
const SUGGESTION_MAX_MISSING = 8

/**
 * Bounded listing of files under `dir` (project-relative, portable), two
 * levels deep. `undefined` when `dir` itself cannot be listed, so the caller
 * can walk up to the nearest existing ancestor.
 */
async function listNearbyFiles(
  fs: CodebuffFileSystem,
  cwd: string,
  dir: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const files: string[] = []
  const queue: Array<{ rel: string; depth: number }> = [{ rel: dir, depth: 0 }]
  let first = true
  while (queue.length > 0 && files.length < SUGGESTION_MAX_ENTRIES) {
    throwIfAborted(signal)
    const { rel, depth } = queue.shift()!
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = (await fs.readdir(path.join(cwd, rel), {
        withFileTypes: true,
      })) as unknown as typeof entries
    } catch {
      if (first) return undefined
      continue
    }
    first = false
    for (const entry of entries) {
      const child = rel === '.' || rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth < 1 && !SUGGESTION_SKIP_DIRS.has(entry.name)) {
          queue.push({ rel: child, depth: depth + 1 })
        }
      } else if (entry.isFile()) {
        files.push(child)
        if (files.length >= SUGGESTION_MAX_ENTRIES) break
      }
    }
  }
  return files
}

/**
 * Up to 3 near-match paths for a missing project-relative path
 * (read-search-12). Every suggestion passes the same read authorization as
 * a real read, so blocked or sensitive files are never revealed.
 * Best-effort: any failure yields no suggestions.
 */
async function suggestNearPaths(params: {
  requestedPath: string
  cwd: string
  canonicalRoot: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
  signal?: AbortSignal
}): Promise<string[]> {
  const { requestedPath, cwd, canonicalRoot, fs, fileFilter, signal } = params
  try {
    if (path.isAbsolute(requestedPath)) return []
    const portable = toPortablePath(requestedPath)
    if (!portable || portable.split('/').includes('..')) return []
    let dir = path.posix.dirname(portable)
    let listed: string[] | undefined
    for (let hop = 0; hop <= SUGGESTION_MAX_ANCESTOR_HOPS; hop++) {
      listed = await listNearbyFiles(fs, cwd, dir, signal)
      if (listed !== undefined || dir === '.') break
      dir = path.posix.dirname(dir)
    }
    if (!listed || listed.length === 0) return []
    const suggestions: string[] = []
    for (const candidate of rankNearPaths(portable, listed, 10)) {
      const authorized = await authorizeReadTarget({
        requestedPath: candidate,
        cwd,
        canonicalRoot,
        fs,
        fileFilter,
      })
      if (authorized.ok) suggestions.push(candidate)
      if (suggestions.length >= 3) break
    }
    return suggestions
  } catch {
    return []
  }
}

async function attachNotFoundCandidates(params: {
  results: ReadFilesItemV1[]
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
  signal?: AbortSignal
}): Promise<void> {
  const { results, cwd, fs, fileFilter, signal } = params
  const missing = results.filter(
    (item) =>
      item.status === 'error' &&
      'error' in item &&
      item.error?.code === 'not_found',
  )
  if (missing.length === 0) return
  let canonicalRoot = path.resolve(cwd)
  try {
    const root = await resolveFilePathForFileSystemOperation(cwd, '.', fs)
    if (root?.operationPath) canonicalRoot = root.operationPath
  } catch {
    // Fall back to the resolved cwd.
  }
  for (const item of missing.slice(0, SUGGESTION_MAX_MISSING)) {
    const withError = item as ReadFilesItemV1 & { error: FilesystemError }
    const candidates = await suggestNearPaths({
      requestedPath: item.path,
      cwd,
      canonicalRoot,
      fs,
      fileFilter,
      signal,
    })
    if (candidates.length > 0) {
      withError.error = { ...withError.error, candidates }
    }
  }
}

export async function getFileForEditResult(params: {
  filePath: string
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
  signal?: AbortSignal
}): Promise<OptionalFileReadResult> {
  const plan = await planNativeReads({
    filePaths: [params.filePath],
    ranges: [],
    cwd: params.cwd,
    fs: params.fs,
    fileFilter: params.fileFilter,
    signal: params.signal,
  })
  throwIfAborted(params.signal)
  const selector = plan.selectors[0]!
  if (!selector.resolved.ok) {
    return {
      status: selector.resolved.error.code as Exclude<
        OptionalFileReadResult['status'],
        'found'
      >,
      path: selector.resolved.displayPath,
      error: selector.resolved.error,
    }
  }
  const snapshot = plan.snapshots.get(selector.resolved.target.operationPath)!
  if (snapshot.state !== 'full') {
    const error =
      snapshot.state === 'error'
        ? snapshot.error
        : filesystemError(
            'too_large',
            `${FILE_READ_STATUS.TOO_LARGE} Full-file editing is unavailable above 10MB.`,
            { retryable: true, recovery: 'read_smaller_range' },
          )
    return {
      status: error.code as Exclude<OptionalFileReadResult['status'], 'found'>,
      path: selector.resolved.target.displayPath,
      error,
    }
  }
  return {
    status: 'found',
    path: selector.resolved.target.displayPath,
    content: snapshot.document.rawText,
    template: selector.resolved.target.isExampleFile,
    metadataComplete: snapshot.metadataComplete,
    ...(snapshot.rawBasis ? { rawBasis: snapshot.rawBasis } : {}),
  }
}

type ExpectedOverrideSelector =
  | { selector: 'file'; path: string }
  | { selector: 'range'; path: string; range: FileLineRange }

function overrideRangeMatchesRequest(
  item: ReadFilesItemV1,
  range: FileLineRange,
): boolean {
  if (item.selector !== 'range' || item.status === 'error') return false
  const requestedStart = Math.max(1, range.startLine ?? 1)
  const requestedEnd = range.endLine ?? item.totalLines
  const expectedEnd = Math.min(requestedEnd, item.totalLines)
  return (
    item.startLine === requestedStart &&
    item.endLine <= requestedEnd &&
    (!item.complete || item.endLine === expectedEnd)
  )
}

function missingOverrideItem(
  selector: ExpectedOverrideSelector,
  requestIndex: number,
  message = 'The read_files override did not return a result for the requested selector.',
): ReadFilesItemV1 {
  return {
    selector: selector.selector,
    requestIndex,
    path: selector.path,
    status: 'error',
    error: filesystemError('invalid_request', message, {
      retryable: true,
      recovery: 'read_again',
    }),
  }
}

export function normalizeReadFilesOverrideResult(params: {
  filePaths: string[]
  ranges?: FileLineRange[]
  raw: unknown
}): ReadFilesResultV1 {
  const { filePaths, ranges = [], raw } = params
  const selectors: ExpectedOverrideSelector[] = [
    ...filePaths.map((pathValue) => ({
      selector: 'file' as const,
      path: pathValue,
    })),
    ...ranges.map((range) => ({
      selector: 'range' as const,
      path: range.path,
      range,
    })),
  ]
  if (!isReadFilesResultV1(raw)) {
    return buildReadFilesResultV1(
      selectors.map((selector, requestIndex) =>
        missingOverrideItem(
          selector,
          requestIndex,
          'The read_files override returned a malformed structured result. No read authorization was granted.',
        ),
      ),
    )
  }
  const results: ReadFilesItemV1[] = []
  const used = new Set<number>()
  for (let requestIndex = 0; requestIndex < selectors.length; requestIndex++) {
    const selector = selectors[requestIndex]!
    let sourceIndex = requestIndex
    let item: ReadFilesItemV1 | undefined = raw.results[sourceIndex]
    if (
      !item ||
      item.selector !== selector.selector ||
      item.path !== selector.path ||
      (selector.selector === 'range' &&
        !overrideRangeMatchesRequest(item, selector.range) &&
        item.status !== 'error') ||
      used.has(sourceIndex)
    ) {
      sourceIndex = raw.results.findIndex(
        (candidate, index) =>
          !used.has(index) &&
          candidate.selector === selector.selector &&
          candidate.path === selector.path &&
          (selector.selector !== 'range' ||
            overrideRangeMatchesRequest(candidate, selector.range) ||
            candidate.status === 'error'),
      )
      item = sourceIndex >= 0 ? raw.results[sourceIndex] : undefined
    }
    if (!item) {
      results.push(missingOverrideItem(selector, requestIndex))
      continue
    }
    used.add(sourceIndex)
    results.push({ ...item, requestIndex })
  }
  return buildReadFilesResultV1(results)
}

/** Structured overrides keep one logical batch call and ordered adaptation. */
export async function getFilesStructuredFromOverride(params: {
  filePaths: string[]
  ranges?: FileLineRange[]
  override: (input: {
    filePaths: string[]
    ranges?: FileLineRange[]
  }) => Promise<ReadFilesResultV1>
}): Promise<ReadFilesResultV1> {
  const { filePaths, ranges = [], override } = params
  const raw = await override({ filePaths, ranges })
  return normalizeReadFilesOverrideResult({ filePaths, ranges, raw })
}
