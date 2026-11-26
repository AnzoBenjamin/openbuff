import {
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_FILE_BYTES,
  MAX_TRANSACTION_PREPARED_BYTES,
} from '@codebuff/common/actions'
import { captureTextDocument } from '@codebuff/common/util/byte-text'
import { getObservationContentHash } from '@codebuff/common/util/content-hash'

import type {
  LspPosition,
  LspPositionEncoding,
  LspTextEdit,
} from './lsp-multiplexer'

const MAX_EDIT_COUNT = 4096
function isPosition(position: unknown): position is LspPosition {
  if (!position || typeof position !== 'object') return false
  const { line, character } = position as Partial<LspPosition>
  return (
    typeof line === 'number' &&
    Number.isSafeInteger(line) &&
    line >= 0 &&
    typeof character === 'number' &&
    Number.isSafeInteger(character) &&
    character >= 0
  )
}

/** Record only referenced lines; CRLF, LF and CR terminators are never content. */
function referencedLines(text: string, wanted: Set<number>) {
  const ranges = new Map<number, { start: number; end: number }>()
  let start = 0
  let line = 0
  for (let end = 0; end <= text.length; end++) {
    const unit = text.charCodeAt(end)
    if (end !== text.length && unit !== 0x0d && unit !== 0x0a) continue
    if (wanted.has(line)) ranges.set(line, { start, end })
    if (ranges.size === wanted.size || end === text.length) break
    if (unit === 0x0d && text.charCodeAt(end + 1) === 0x0a) end++
    start = end + 1
    line++
  }
  return ranges
}

function utf16Offset(
  text: string,
  range: { start: number; end: number },
  character: number,
): number {
  if (character > range.end - range.start)
    throw new Error('edit range is out of bounds of the current document')
  const index = range.start + character
  const unit = text.charCodeAt(index)
  if (index !== range.end && unit >= 0xdc00 && unit <= 0xdfff)
    throw new Error('edit range splits a Unicode scalar')
  return index
}

function utf8Offsets(
  text: string,
  range: { start: number; end: number },
  sortedOffsets: readonly number[],
): Map<number, number> {
  const raw = new Map<number, number>()
  let byte = 0
  let index = range.start
  for (const wanted of sortedOffsets) {
    while (byte < wanted && index < range.end) {
      const scalar = text.codePointAt(index)!
      byte +=
        scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4
      index += scalar > 0xffff ? 2 : 1
    }
    if (byte < wanted)
      throw new Error('edit range is out of bounds of the current document')
    if (byte > wanted)
      throw new Error('UTF-8 edit range splits a Unicode scalar')
    raw.set(wanted, index)
  }
  return raw
}

/** Convert a caller/view position using only the document bytes it describes. */
export function convertSemanticPosition(
  text: string,
  position: unknown,
  from: LspPositionEncoding,
  to: LspPositionEncoding,
): LspPosition {
  if (!isPosition(position)) throw new Error('malformed LSP position')
  const range = referencedLines(text, new Set([position.line])).get(
    position.line,
  )
  if (!range) throw new Error('LSP position is outside the current document')
  const index =
    from === 'utf-8'
      ? utf8Offsets(text, range, [position.character]).get(position.character)!
      : utf16Offset(text, range, position.character)
  return {
    line: position.line,
    character:
      to === 'utf-8'
        ? Buffer.byteLength(text.slice(range.start, index))
        : index - range.start,
  }
}

/** Splice negotiated ranges without normalizing the attested raw document. */
export function spliceSemanticText(
  text: string,
  edits: readonly LspTextEdit[],
  encoding: LspPositionEncoding = 'utf-16',
): string {
  if (!Array.isArray(edits) || edits.length > MAX_EDIT_COUNT) {
    throw new Error('semantic edit count exceeds the supported limit')
  }
  const wanted = new Map<number, Set<number>>()
  const add = ({ line, character }: LspPosition) => {
    const positions = wanted.get(line) ?? new Set<number>()
    positions.add(character)
    wanted.set(line, positions)
  }
  let replacementBytes = 0
  for (const edit of edits) {
    if (
      !isPosition(edit?.range?.start) ||
      !isPosition(edit?.range?.end) ||
      typeof edit.newText !== 'string'
    ) {
      throw new Error('malformed edit range or replacement text')
    }
    replacementBytes += Buffer.byteLength(edit.newText)
    if (replacementBytes > MAX_TRANSACTION_FILE_BYTES)
      throw new Error('semantic replacement bytes exceed the file limit')
    add(edit.range.start)
    add(edit.range.end)
  }
  const lines = referencedLines(text, new Set(wanted.keys()))
  const byteOffsets = new Map<number, Map<number, number>>()
  if (encoding === 'utf-8') {
    for (const [line, characters] of wanted) {
      const range = lines.get(line)
      if (!range)
        throw new Error('edit range is out of bounds of the current document')
      byteOffsets.set(
        line,
        utf8Offsets(
          text,
          range,
          [...characters].sort((a, b) => a - b),
        ),
      )
    }
  }
  const offset = ({ line, character }: LspPosition): number => {
    const range = lines.get(line)
    if (!range)
      throw new Error('edit range is out of bounds of the current document')
    return encoding === 'utf-8'
      ? byteOffsets.get(line)!.get(character)!
      : utf16Offset(text, range, character)
  }
  const positioned: Array<{
    start: number
    end: number
    newText: string
    order: number
  }> = []
  for (const [order, edit] of edits.entries()) {
    const start = offset(edit.range.start)
    const end = offset(edit.range.end)
    if (start > end) throw new Error('edit range is reversed')
    positioned.push({ start, end, newText: edit.newText, order })
  }
  // At a shared start the wire order must be inserts followed by at most
  // one replacement. Sorting by end would silently repair malformed input.
  positioned.sort((a, b) => a.start - b.start || a.order - b.order)
  let current = 0
  const pieces: string[] = []
  for (const { start, end, newText } of positioned) {
    if (start < current)
      throw new Error('edit ranges overlap in the current document')
    pieces.push(text.slice(current, start), newText)
    current = end
  }
  pieces.push(text.slice(current))
  const result = captureTextDocument(pieces.join(''))
  if (result.byteLength > MAX_TRANSACTION_FILE_BYTES)
    throw new Error('semantic result exceeds the file byte limit')
  return result.rawText
}

export type SemanticDocumentBasis = Readonly<{
  version: number
  rawText: string
  rawHash: string
  byteLength: number
}>

export type SemanticEditAnnotation = {
  id: string
  label: string
  description?: string
}
type AnnotatedOperation = { annotations?: SemanticEditAnnotation[] }
const MAX_ANNOTATION_DEFINITIONS = 128
const MAX_ANNOTATION_REFERENCES = 256
const MAX_ANNOTATION_BYTES = 64 * 1024
type AnnotationDefinition = SemanticEditAnnotation & {
  needsConfirmation: boolean
}
function parseAnnotations(input: unknown): Map<string, AnnotationDefinition> {
  const definitions = new Map<string, AnnotationDefinition>()
  if (input === undefined) return definitions
  if (
    !record(input) ||
    Object.keys(input).length > MAX_ANNOTATION_DEFINITIONS
  ) {
    throw new Error('invalid change annotation table')
  }
  const plain = (text: unknown, max: number): text is string =>
    typeof text === 'string' &&
    text.length <= max &&
    !/[\x00-\x08\x0b-\x1f\x7f]/.test(text)
  for (const [id, annotation] of Object.entries(input)) {
    if (
      !plain(id, 128) ||
      !id.trim() ||
      !record(annotation) ||
      Object.keys(annotation).some(
        (key) => !['label', 'description', 'needsConfirmation'].includes(key),
      ) ||
      !plain(annotation.label, 256) ||
      !annotation.label.trim() ||
      /[\t\n]/.test(annotation.label) ||
      (annotation.description !== undefined &&
        !plain(annotation.description, 1024)) ||
      (annotation.needsConfirmation !== undefined &&
        typeof annotation.needsConfirmation !== 'boolean')
    ) {
      throw new Error('invalid change annotation metadata')
    }
    definitions.set(id, {
      id,
      label: annotation.label,
      needsConfirmation: annotation.needsConfirmation === true,
      ...(annotation.description === undefined
        ? {}
        : { description: annotation.description }),
    })
  }
  return definitions
}

type SemanticFileOperation = AnnotatedOperation & {
  kind: 'file'
  uri: string
  version: number | null
  requestedVersion: number | null
  expectedRawHash: string | null
  newContent: string
}

export type VersionedSemanticOperation =
  | SemanticFileOperation
  | (AnnotatedOperation & {
      uri: string
      version: number
      expectedRawHash: string
      expectedHash: string
    } & ({ kind: 'delete' } | { kind: 'move'; destinationUri: string }))

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function localUri(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('file:///')) {
    const uri = new URL(value)
    if (!uri.search && !uri.hash && uri.href === value) return value
  }
  throw new Error('invalid local semantic document URI')
}
function validateResourceOptions(
  change: Record<string, unknown>,
  keys: string[],
) {
  if (
    'options' in change &&
    (!record(change.options) ||
      Object.entries(change.options).some(
        ([key, value]) => !keys.includes(key) || value !== false,
      ))
  ) {
    throw new Error('unsupported resource option')
  }
}
/** Compile the whole ordered intent, without touching the live filesystem. */
export function compileVersionedSemanticEdit(
  raw: unknown,
  basis: ReadonlyMap<string, SemanticDocumentBasis>,
  encoding: LspPositionEncoding = 'utf-16',
): VersionedSemanticOperation[] {
  if (raw === null) return []
  if (!record(raw) || 'changes' in raw === 'documentChanges' in raw) {
    throw new Error('expected exactly one supported WorkspaceEdit form')
  }
  if ('changes' in raw && 'changeAnnotations' in raw) {
    throw new Error('change annotations require documentChanges')
  }
  const annotations = parseAnnotations(raw.changeAnnotations)
  const annotationFor = (
    entry: Record<string, unknown>,
  ): SemanticEditAnnotation | undefined => {
    if (!('annotationId' in entry)) return undefined
    const definition =
      typeof entry.annotationId === 'string'
        ? annotations.get(entry.annotationId)
        : undefined
    if (!definition)
      throw new Error('unsupported annotation reference: missing definition')
    if (definition.needsConfirmation)
      throw new Error('the change annotation requires host confirmation')
    const { id, label, description } = definition
    return { id, label, ...(description === undefined ? {} : { description }) }
  }
  let annotationReferences = 0
  let annotationBytes = 0
  const attach = (
    operation: AnnotatedOperation,
    values: Array<SemanticEditAnnotation | undefined>,
  ) => {
    const seen = new Set(operation.annotations?.map(({ id }) => id))
    for (const value of values) {
      if (!value || seen.has(value.id)) continue
      seen.add(value.id)
      annotationReferences++
      annotationBytes += Buffer.byteLength(JSON.stringify(value))
      if (
        annotationReferences > MAX_ANNOTATION_REFERENCES ||
        annotationBytes > MAX_ANNOTATION_BYTES
      ) {
        throw new Error(
          'change annotations exceed the transaction metadata limit',
        )
      }
      ;(operation.annotations ??= []).push(value)
    }
  }
  let inputs: unknown[]
  if ('changes' in raw) {
    if (!record(raw.changes)) throw new Error('invalid changes map')
    inputs = Object.entries(raw.changes).map(([uri, edits]) => ({
      textDocument: { uri, version: null },
      edits,
    }))
  } else {
    if (!Array.isArray(raw.documentChanges))
      throw new Error('invalid documentChanges list')
    inputs = raw.documentChanges
  }
  if (inputs.length > MAX_FILE_CHANGES_PER_TRANSACTION)
    throw new Error('semantic operation count exceeds the transaction limit')

  const seen = new Set<string>()
  const created = new Map<string, SemanticFileOperation>()
  const operations: VersionedSemanticOperation[] = []
  let totalBytes = 0
  const charge = (size: number) => {
    totalBytes += size
    if (totalBytes > MAX_TRANSACTION_PREPARED_BYTES)
      throw new Error('semantic transaction exceeds the prepared byte limit')
  }
  const claim = (uri: string, absent = false) => {
    if (seen.has(uri) || (absent && basis.has(uri)))
      throw new Error('conflicting or repeated semantic path operation')
    seen.add(uri)
  }
  const requireDocument = (uri: string) => {
    const document = basis.get(uri)
    if (!document) throw new Error('missing pre-request document basis')
    return document
  }
  for (const input of inputs) {
    if (!record(input)) throw new Error('malformed document change')
    if (input.kind === 'create') {
      validateResourceOptions(input, ['overwrite', 'ignoreIfExists'])
      const uri = localUri(input.uri)
      claim(uri, true)
      const file: SemanticFileOperation = {
        kind: 'file',
        uri,
        version: null,
        requestedVersion: null,
        expectedRawHash: null,
        newContent: '',
      }
      attach(file, [annotationFor(input)])
      operations.push(file)
      created.set(uri, file)
      continue
    }
    if (input.kind === 'rename' || input.kind === 'delete') {
      validateResourceOptions(
        input,
        input.kind === 'rename'
          ? ['overwrite', 'ignoreIfExists']
          : ['recursive', 'ignoreIfNotExists'],
      )
      const uri = localUri(input.kind === 'rename' ? input.oldUri : input.uri)
      claim(uri)
      const document = requireDocument(uri)
      const common = {
        uri,
        version: document.version,
        expectedRawHash: document.rawHash,
        expectedHash: getObservationContentHash(document.rawText),
      }
      charge(document.byteLength)
      let operation: VersionedSemanticOperation
      if (input.kind === 'rename') {
        const destinationUri = localUri(input.newUri)
        claim(destinationUri, true)
        operation = { ...common, kind: 'move', destinationUri }
      } else operation = { ...common, kind: 'delete' }
      attach(operation, [annotationFor(input)])
      operations.push(operation)
      continue
    }
    if ('kind' in input || !record(input.textDocument))
      throw new Error(
        'unsupported resource operation or malformed document change',
      )
    const uri = localUri(input.textDocument.uri)
    const requestedVersion = input.textDocument.version
    const edits = input.edits
    if (
      !Array.isArray(edits) ||
      edits.length > MAX_EDIT_COUNT ||
      edits.some(
        (edit) =>
          !record(edit) ||
          Object.keys(edit).some(
            (key) => !['range', 'newText', 'annotationId'].includes(key),
          ),
      )
    ) {
      throw new Error('unsupported annotation or malformed text edit')
    }
    // Do not drop a document basis from the group or turn it into a write just
    // to check it. This lane has no check-only operation.
    if (edits.length === 0)
      throw new Error('empty text edit lists are unsupported in WorkspaceEdit')
    const textAnnotations = edits.map((edit) => annotationFor(edit))
    const staged = created.get(uri)
    if (staged) {
      if (requestedVersion !== null)
        throw new Error('created document does not have a pre-request version')
      staged.newContent = spliceSemanticText(
        '',
        edits as LspTextEdit[],
        encoding,
      )
      charge(Buffer.byteLength(staged.newContent))
      attach(staged, textAnnotations)
      created.delete(uri) // A second edit batch to the same path is unsupported.
      continue
    }
    claim(uri)
    const document = requireDocument(uri)
    if (
      requestedVersion !== null &&
      (!Number.isSafeInteger(requestedVersion) ||
        requestedVersion !== document.version)
    ) {
      throw new Error(
        'semantic edit document version does not match the pre-request version',
      )
    }
    const newContent = spliceSemanticText(
      document.rawText,
      edits as LspTextEdit[],
      encoding,
    )
    charge(document.byteLength + Buffer.byteLength(newContent))
    const operation: SemanticFileOperation = {
      kind: 'file',
      uri,
      version: document.version,
      requestedVersion: requestedVersion as number | null,
      expectedRawHash: document.rawHash,
      newContent,
    }
    attach(operation, textAnnotations)
    operations.push(operation)
  }
  return operations
}
