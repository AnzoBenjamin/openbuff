import {
  getContentHash,
  getExactContentHash,
  normalizeLineEndings,
} from './content-hash'
import { MAX_REANCHOR_SCAN_LINE_PRODUCT } from './line-coordinates'
import { parseRawReadBasis } from './raw-read-basis'

import type { ReplacementReadCapability } from './content-hash'
import type { RawReadBasisV1 } from './raw-read-basis'

export type TextCaptureOptions = {
  /** False for a slice starting after byte zero, even when its content starts with U+FEFF. */
  includesBom?: boolean
  view?: RawReadBasisV1['view']
  coherence?: RawReadBasisV1['coherence']
  generation?: string
}

export type CapturedTextDocument = {
  readonly rawText: string
  readonly observation: string
  readonly rawHash: string
  readonly observationHash: string
  readonly byteLength: number
  readonly bomBytes: 0 | 3
  readonly documentBom: 'utf8' | 'none'
  readonly visibleLineCount: number
  readonly maxCapabilityLine: number
  readonly view: RawReadBasisV1['view']
  readonly coherence: RawReadBasisV1['coherence']
  readonly generation?: string
}

function assertLosslessText(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('Unsupported UTF-8 text: unpaired high surrogate')
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Unsupported UTF-8 text: unpaired low surrogate')
    }
  }
}

export function captureTextDocument(
  input: string | Uint8Array,
  options: TextCaptureOptions = {},
): CapturedTextDocument {
  const rawText =
    typeof input === 'string'
      ? input
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
  assertLosslessText(rawText)
  const includesBom = options.includesBom ?? rawText.startsWith('\uFEFF')
  if (includesBom && !rawText.startsWith('\uFEFF')) {
    throw new TypeError(
      'The captured bytes do not contain the claimed UTF-8 BOM',
    )
  }
  const observation = normalizeLineEndings(
    includesBom ? rawText.slice(1) : rawText,
  )
  let terminators = 0
  for (let index = 0; index < observation.length; index++) {
    if (observation.charCodeAt(index) === 0x0a) terminators++
  }
  return Object.freeze({
    rawText,
    observation,
    rawHash: getExactContentHash(rawText),
    observationHash: getContentHash(observation),
    byteLength: Buffer.byteLength(rawText),
    bomBytes: includesBom ? 3 : 0,
    documentBom: includesBom ? 'utf8' : 'none',
    visibleLineCount:
      observation.length === 0
        ? 0
        : terminators + (observation.endsWith('\n') ? 0 : 1),
    maxCapabilityLine: terminators + 1,
    view: options.view ?? 'text_view',
    coherence: options.coherence ?? 'observed',
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  })
}

function scalarWidth(
  text: string,
  index: number,
): { utf16: number; utf8: number } {
  const code = text.codePointAt(index)!
  return {
    utf16: code > 0xffff ? 2 : 1,
    utf8: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4,
  }
}

function observationBoundary(
  document: CapturedTextDocument,
  offset: number,
): { utf16: number; byte: number } {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > document.observation.length
  ) {
    throw new RangeError('Invalid observation UTF-16 offset')
  }
  let raw = document.bomBytes === 3 ? 1 : 0
  let byte: number = document.bomBytes
  let observed = 0
  while (observed < offset) {
    if (document.rawText.startsWith('\r\n', raw)) {
      raw += 2
      byte += 2
      observed++
    } else {
      const width = scalarWidth(document.rawText, raw)
      if (observed + width.utf16 > offset) {
        throw new RangeError('Observation offset splits a Unicode scalar')
      }
      raw += width.utf16
      byte += width.utf8
      observed += width.utf16
    }
  }
  return { utf16: raw, byte }
}

export function observationUtf16ToRawByte(
  document: CapturedTextDocument,
  offset: number,
): number {
  return observationBoundary(document, offset).byte
}

export function observationUtf16ToUtf8(
  document: CapturedTextDocument,
  offset: number,
): number {
  return observationUtf16ToRawByte(document, offset) - document.bomBytes
}

export function rawByteToObservationUtf16(
  document: CapturedTextDocument,
  offset: number,
): number {
  if (
    !Number.isSafeInteger(offset) ||
    offset < document.bomBytes ||
    offset > document.byteLength
  ) {
    throw new RangeError(
      'Raw byte offset is outside the UTF-8 payload or inside its BOM',
    )
  }
  let raw = document.bomBytes === 3 ? 1 : 0
  let byte: number = document.bomBytes
  let observed = 0
  while (byte < offset) {
    const crlf = document.rawText.startsWith('\r\n', raw)
    const width = crlf
      ? { utf16: 2, utf8: 2 }
      : scalarWidth(document.rawText, raw)
    if (byte + width.utf8 > offset) {
      throw new RangeError(
        crlf
          ? 'Raw byte offset splits a CRLF terminator'
          : 'Raw byte offset splits a Unicode scalar',
      )
    }
    raw += width.utf16
    byte += width.utf8
    observed += crlf ? 1 : width.utf16
  }
  return observed
}

export function utf8ToObservationUtf16(
  document: CapturedTextDocument,
  offset: number,
): number {
  return rawByteToObservationUtf16(document, offset + document.bomBytes)
}

type RawLine = {
  line: number
  startUtf16: number
  endUtf16: number
  startByte: number
  endByteExclusive: number
  terminatorEndUtf16: number
  terminatorEndByteExclusive: number
  startObservationOffset: number
  endObservationOffset: number
  endTerminator: RawReadBasisV1['endTerminator']
  sawCrlf: boolean
}

/** Only the requested span/ring window is retained, never a table per source character. */
function* rawLines(document: CapturedTextDocument): Generator<RawLine> {
  let raw = document.bomBytes === 3 ? 1 : 0
  let byte: number = document.bomBytes
  let observed = 0
  let line = 1
  let sawCrlf = false
  let startUtf16 = raw
  let startByte = byte
  let startObservationOffset = observed
  while (raw < document.rawText.length) {
    const crlf = document.rawText.startsWith('\r\n', raw)
    const lf = document.rawText.charCodeAt(raw) === 0x0a
    if (crlf || lf) {
      const width = crlf ? 2 : 1
      const entry: RawLine = {
        line,
        startUtf16,
        startByte,
        startObservationOffset,
        endUtf16: raw,
        endByteExclusive: byte,
        endObservationOffset: observed,
        terminatorEndUtf16: raw + width,
        terminatorEndByteExclusive: byte + width,
        endTerminator: crlf ? 'crlf' : 'lf',
        sawCrlf: sawCrlf || crlf,
      }
      yield entry
      raw += width
      byte += width
      observed++
      line++
      sawCrlf ||= crlf
      startUtf16 = raw
      startByte = byte
      startObservationOffset = observed
    } else {
      const width = scalarWidth(document.rawText, raw)
      raw += width.utf16
      byte += width.utf8
      observed += width.utf16
    }
  }
  yield {
    line,
    startUtf16,
    startByte,
    startObservationOffset,
    endUtf16: raw,
    endByteExclusive: byte,
    endObservationOffset: observed,
    terminatorEndUtf16: raw,
    terminatorEndByteExclusive: byte,
    endTerminator: 'none',
    sawCrlf,
  }
}

export type RawLineSpan = Omit<RawLine, 'line'>

export function getRawLineSpan(
  document: CapturedTextDocument,
  startLine: number,
  endLine: number,
): RawLineSpan {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > document.maxCapabilityLine
  ) {
    throw new RangeError('Invalid captured document line range')
  }
  let first: RawLine | undefined
  for (const entry of rawLines(document)) {
    if (entry.line === startLine) first = entry
    if (entry.line === endLine && first) {
      return {
        startUtf16: first.startUtf16,
        startByte: first.startByte,
        startObservationOffset: first.startObservationOffset,
        endUtf16: entry.endUtf16,
        endByteExclusive: entry.endByteExclusive,
        endObservationOffset: entry.endObservationOffset,
        terminatorEndUtf16: entry.terminatorEndUtf16,
        terminatorEndByteExclusive: entry.terminatorEndByteExclusive,
        endTerminator: entry.endTerminator,
        sawCrlf: entry.sawCrlf,
      }
    }
  }
  throw new RangeError('Line range is outside the captured document')
}

export function getRawReadBasis(
  document: CapturedTextDocument,
  startLine: number,
  endLine: number,
  scope: RawReadBasisV1['scope'],
): RawReadBasisV1 {
  const span = getRawLineSpan(document, startLine, endLine)
  const whole = scope === 'whole'
  if (
    whole &&
    (startLine !== 1 ||
      (endLine !== document.visibleLineCount &&
        endLine !== document.maxCapabilityLine))
  ) {
    throw new RangeError(
      'A whole raw basis requires complete document line coverage',
    )
  }
  const includesBom = document.bomBytes === 3 && (whole || startLine === 1)
  const startByte = whole || includesBom ? 0 : span.startByte
  const endByteExclusive = whole
    ? document.byteLength
    : span.terminatorEndByteExclusive
  const rawSlice = document.rawText.slice(
    whole || includesBom ? 0 : span.startUtf16,
    whole ? document.rawText.length : span.terminatorEndUtf16,
  )
  return parseRawReadBasis({
    version: 1,
    scope,
    rawHash: whole ? document.rawHash : getExactContentHash(rawSlice),
    documentRawHash: document.rawHash,
    documentBytes: document.byteLength,
    startByte,
    endByteExclusive,
    documentBom: document.documentBom,
    includesBom,
    endTerminator: whole
      ? document.rawText.endsWith('\r\n')
        ? 'crlf'
        : document.rawText.endsWith('\n')
          ? 'lf'
          : 'none'
      : span.endTerminator,
    view: document.view,
    coherence: document.coherence,
    ...(document.generation === undefined
      ? {}
      : { generation: document.generation }),
  })
}

function insertionEnding(
  document: CapturedTextDocument,
  start: number,
  end: number,
  sawCrlf: boolean,
): '\r\n' | '\n' {
  const replaced = document.rawText.slice(start, end)
  if (replaced.includes('\r\n')) return '\r\n'
  if (replaced.includes('\n')) return '\n'
  if (document.rawText.startsWith('\r\n', end)) return '\r\n'
  if (document.rawText.startsWith('\n', end)) return '\n'
  return sawCrlf ? '\r\n' : '\n'
}

export function spliceDocumentRange(
  document: CapturedTextDocument,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  assertLosslessText(replacement)
  const span = getRawLineSpan(document, startLine, endLine)
  const normalized = normalizeLineEndings(replacement)
  const inserted = normalized.includes('\n')
    ? normalized.replaceAll(
        '\n',
        insertionEnding(document, span.startUtf16, span.endUtf16, span.sawCrlf),
      )
    : normalized
  return (
    document.rawText.slice(0, span.startUtf16) +
    inserted +
    document.rawText.slice(span.endUtf16)
  )
}

export function spliceDocumentObservation(
  document: CapturedTextDocument,
  startOffset: number,
  endOffset: number,
  replacement: string,
): string {
  if (endOffset < startOffset) throw new RangeError('Inverted observation span')
  assertLosslessText(replacement)
  const start = observationBoundary(document, startOffset).utf16
  const end = observationBoundary(document, endOffset).utf16
  const normalized = normalizeLineEndings(replacement)
  const inserted = normalized.includes('\n')
    ? normalized.replaceAll(
        '\n',
        insertionEnding(
          document,
          start,
          end,
          document.rawText.slice(0, end).includes('\r\n'),
        ),
      )
    : normalized
  return (
    document.rawText.slice(0, start) + inserted + document.rawText.slice(end)
  )
}

export const MAX_RAW_REANCHOR_SCAN_BYTES = 128 * 1024 * 1024

export type RawReadReanchorResult =
  | { ok: true; startLine: number; endLine: number; shiftedBy?: number }
  | {
      ok: false
      reason:
        | 'missing_raw_basis'
        | 'raw_changed'
        | 'invalid_source'
        | 'not_found'
        | 'ambiguous'
        | 'over_budget'
      matchCount?: number
    }

export function reanchorRawReadCapability(params: {
  content: string
  capability: ReplacementReadCapability
}): RawReadReanchorResult {
  const { capability } = params
  if (!capability.rawBasis) return { ok: false, reason: 'missing_raw_basis' }
  let document: CapturedTextDocument
  let basis: RawReadBasisV1
  try {
    document = captureTextDocument(params.content)
    basis = parseRawReadBasis(capability.rawBasis)
  } catch {
    return { ok: false, reason: 'invalid_source' }
  }
  const count = capability.endLine - capability.startLine + 1
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, reason: 'not_found' }
  }
  const unchangedDocument = document.rawHash === basis.documentRawHash
  if (
    unchangedDocument &&
    (document.byteLength !== basis.documentBytes ||
      document.documentBom !== basis.documentBom)
  ) {
    return { ok: false, reason: 'invalid_source' }
  }
  const matches = (first: RawLine, last: RawLine): boolean => {
    const includesBom = document.bomBytes === 3 && first.line === 1
    if (
      includesBom !== basis.includesBom ||
      last.endTerminator !== basis.endTerminator
    )
      return false
    const startByte = includesBom ? 0 : first.startByte
    const endByteExclusive = last.terminatorEndByteExclusive
    if (
      endByteExclusive - startByte !==
        basis.endByteExclusive - basis.startByte ||
      (unchangedDocument &&
        (startByte !== basis.startByte ||
          endByteExclusive !== basis.endByteExclusive))
    )
      return false
    const rawSlice = document.rawText.slice(
      includesBom ? 0 : first.startUtf16,
      last.terminatorEndUtf16,
    )
    return (
      getExactContentHash(rawSlice) === basis.rawHash &&
      getContentHash(
        document.observation.slice(
          first.startObservationOffset,
          last.endObservationOffset,
        ),
      ) === capability.hash
    )
  }
  if (basis.scope === 'whole') {
    if (document.rawHash !== basis.rawHash)
      return { ok: false, reason: 'raw_changed' }
    const ending = document.rawText.endsWith('\r\n')
      ? 'crlf'
      : document.rawText.endsWith('\n')
        ? 'lf'
        : 'none'
    if (
      basis.includesBom !== (document.bomBytes === 3) ||
      basis.endTerminator !== ending
    ) {
      return { ok: false, reason: 'invalid_source' }
    }
    if (
      capability.startLine !== 1 ||
      (capability.endLine !== document.visibleLineCount &&
        capability.endLine !== document.maxCapabilityLine)
    ) {
      return { ok: false, reason: 'not_found' }
    }
    const span = getRawLineSpan(
      document,
      capability.startLine,
      capability.endLine,
    )
    if (
      getContentHash(
        document.observation.slice(
          span.startObservationOffset,
          span.endObservationOffset,
        ),
      ) !== capability.hash
    ) {
      return { ok: false, reason: 'not_found' }
    }
    return {
      ok: true,
      startLine: capability.startLine,
      endLine: capability.endLine,
    }
  }
  if (count > document.maxCapabilityLine)
    return { ok: false, reason: 'not_found' }
  if (unchangedDocument) {
    const span =
      capability.endLine <= document.maxCapabilityLine &&
      capability.startLine >= 1
        ? getRawLineSpan(document, capability.startLine, capability.endLine)
        : undefined
    if (!span) return { ok: false, reason: 'not_found' }
    const first = { ...span, line: capability.startLine } as RawLine
    const last = { ...span, line: capability.endLine } as RawLine
    return matches(first, last)
      ? {
          ok: true,
          startLine: capability.startLine,
          endLine: capability.endLine,
        }
      : { ok: false, reason: 'not_found' }
  }
  // After any document drift, even an old-position match must prove uniqueness.
  if (
    document.maxCapabilityLine * count > MAX_REANCHOR_SCAN_LINE_PRODUCT ||
    document.byteLength * count > MAX_RAW_REANCHOR_SCAN_BYTES
  ) {
    return { ok: false, reason: 'over_budget' }
  }
  const window: RawLine[] = []
  let matchCount = 0
  let matchStart = 0
  for (const entry of rawLines(document)) {
    window.push(entry)
    if (window.length > count) window.shift()
    if (window.length !== count || !matches(window[0]!, entry)) continue
    matchCount++
    matchStart = window[0]!.line
  }
  if (matchCount === 0) return { ok: false, reason: 'not_found' }
  if (matchCount > 1) return { ok: false, reason: 'ambiguous', matchCount }
  return {
    ok: true,
    startLine: matchStart,
    endLine: matchStart + count - 1,
    ...(matchStart === capability.startLine
      ? {}
      : { shiftedBy: matchStart - capability.startLine }),
  }
}

export function describeRawReadFailure(
  result: Extract<RawReadReanchorResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'missing_raw_basis':
      return 'the capability has no authenticated raw byte basis; obtain a fresh read'
    case 'raw_changed':
      return 'the whole-file raw bytes changed after observation'
    case 'invalid_source':
      return 'the current source or raw basis is not valid lossless UTF-8 text'
    case 'ambiguous':
      return `the observed raw content now appears at ${result.matchCount ?? 2} identical candidate spans`
    case 'over_budget':
      return 'the complete raw reanchor search exceeds its finite work budget'
    case 'not_found':
      return 'the observed raw bytes and line boundaries were not found in the current file'
  }
}
