import { stripAnsiSequences } from '@opentui/core'

export type OutputKind =
  | 'markdown'
  | 'log'
  | 'diff'
  | 'json'
  | 'text'
  | 'search'
  | 'table'
  | 'receipt'
  | 'agent'
  | 'job'
  | 'replay'
export type OutputAvailability =
  | 'retained'
  | 'limited'
  | 'pending'
  | 'unavailable'
export type OutputLocation = { line: number; character: number }
export type OutputLandmark = {
  id: string
  label: string
  line: number
  level: number
}
export type OutputProvenance = {
  source: 'capture' | 'saved-artifact'
  identity?: string
  version?: string
  freshness: 'captured' | 'cached' | 'stale' | 'unverified'
  exact: boolean
  startLine?: number
}
export type OutputCoverage = {
  captured?: number
  unit?: string
  total?: number
  reasons: string[]
  nextOffset?: number
}
export type OutputColumn = { key: string; label: string }
export type OutputRow = {
  id: string
  label: string
  line: number
  value: unknown
}

/** A retained snapshot with logical locations independent of terminal width. */
export interface OutputDocument {
  id: string
  revision: string
  title: string
  kind: OutputKind
  availability: OutputAvailability
  notice: string
  text: string
  lineCount: number
  landmarks: OutputLandmark[]
  provenance?: OutputProvenance
  coverage?: OutputCoverage
  outcome?: {
    label: string
    tone: 'good' | 'warn' | 'bad' | 'neutral'
    source: string
  }
  diagnostics?: readonly unknown[]
  columns?: readonly OutputColumn[]
  rowCount?: number
  row?(index: number): OutputRow | undefined
  detail?(index: number): OutputDocument | undefined
  line(index: number): string
  range(start: number, count: number): string[]
  find(
    query: string,
    from: OutputLocation,
    direction: 1 | -1,
  ): OutputLocation | null
  copyLine(index: number): string
  section?(landmarkId: string): { start: number; count: number } | undefined
  copySection?(landmarkId: string): string | undefined
}

const cleanLine = (text: string) =>
  stripAnsiSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
let nextDocumentRevision = 0

export function createTextDocument(options: {
  id: string
  title: string
  text: string
  kind?: OutputKind
  availability?: OutputAvailability
  notice?: string
  landmarks?: OutputLandmark[]
  scalarValues?: Map<number, string>
  provenance?: OutputProvenance
  coverage?: OutputCoverage
  outcome?: OutputDocument['outcome']
  diagnostics?: readonly unknown[]
  columns?: readonly OutputColumn[]
  rowCount?: number
  row?: OutputDocument['row']
  detail?: OutputDocument['detail']
}): OutputDocument {
  const { text, id, title, kind = 'text' } = options
  const starts = [0]
  for (
    let index = text.indexOf('\n');
    index !== -1;
    index = text.indexOf('\n', index + 1)
  )
    starts.push(index + 1)
  const rawLine = (index: number) =>
    index < 0 || index >= starts.length
      ? ''
      : text
          .slice(
            starts[index],
            index + 1 < starts.length ? starts[index + 1] - 1 : text.length,
          )
          .replace(/\r$/, '')
  const line = (index: number) => cleanLine(rawLine(index))
  const landmarks: OutputLandmark[] = options.landmarks ?? []
  if (!options.landmarks && (kind === 'markdown' || kind === 'diff')) {
    let fence: { character: string; length: number } | undefined
    for (let index = 0; index < starts.length; index++) {
      const content = line(index)
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      if (marker) {
        if (!fence)
          fence = { character: marker[1][0], length: marker[1].length }
        else if (
          marker[1][0] === fence.character &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined
        continue
      }
      const heading =
        kind === 'markdown' && !fence
          ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(content)
          : null
      if (heading)
        landmarks.push({
          id: `${id}:${index}`,
          label: heading[2],
          level: heading[1].length,
          line: index,
        })
      if (
        kind === 'markdown' &&
        !fence &&
        index > 0 &&
        /^ {0,3}(=+|-+)\s*$/.test(content)
      ) {
        const previous = line(index - 1).trim()
        if (previous && !/^(?:#{1,6}\s|>|[-*+]\s|`|~)/.test(previous))
          landmarks.push({
            id: `${id}:${index - 1}`,
            label: previous,
            level: content.trim().startsWith('=') ? 1 : 2,
            line: index - 1,
          })
      }
      if (kind === 'diff' && /^(diff --git |\+\+\+ |@@)/.test(content))
        landmarks.push({
          id: `${id}:${index}`,
          label: content,
          level: content.startsWith('@@') ? 2 : 1,
          line: index,
        })
    }
  }
  let searchProjection: { text: string; starts: number[] } | undefined
  const searchable = () => {
    if (searchProjection) return searchProjection
    let visible = cleanLine(text)
    if (visible === text) return (searchProjection = { text, starts })
    let visibleStarts = [0]
    for (let index = visible.indexOf('\n'); index !== -1; index = visible.indexOf('\n', index + 1)) visibleStarts.push(index + 1)
    // An escape sequence spanning logical lines can remove newlines when
    // stripped as a whole. Match the same per-line projection used to render.
    if (visibleStarts.length !== starts.length) {
      visible = Array.from({ length: starts.length }, (_, index) => line(index)).join('\n')
      visibleStarts = [0]
      for (let index = visible.indexOf('\n'); index !== -1; index = visible.indexOf('\n', index + 1)) visibleStarts.push(index + 1)
    }
    return (searchProjection = { text: visible, starts: visibleStarts })
  }
  const locate = (offset: number, offsets = starts): OutputLocation => {
    let low = 0,
      high = offsets.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (offsets[middle] <= offset) low = middle
      else high = middle - 1
    }
    return { line: low, character: offset - offsets[low] }
  }
  const section = (landmarkId: string) => {
    const index = landmarks.findIndex((landmark) => landmark.id === landmarkId)
    if (index < 0) return undefined
    const selected = landmarks[index]
    let end = starts.length
    for (let next = index + 1; next < landmarks.length; next++)
      if (landmarks[next].level <= selected.level) {
        end = landmarks[next].line
        break
      }
    return { start: selected.line, count: Math.max(0, end - selected.line) }
  }
  return {
    id,
    revision: `${id}:${++nextDocumentRevision}`,
    title,
    kind,
    text,
    lineCount: starts.length,
    landmarks,
    provenance: options.provenance,
    coverage: options.coverage,
    outcome: options.outcome,
    diagnostics: options.diagnostics,
    columns: options.columns,
    rowCount: options.rowCount,
    row: options.row,
    detail: options.detail,
    availability: options.availability ?? 'retained',
    notice:
      options.notice ??
      (options.availability === 'pending'
        ? 'Output pending'
        : options.availability === 'unavailable'
          ? 'Output was not captured'
          : 'Captured output · no current-file reads'),
    line,
    range: (start, count) =>
      Array.from(
        {
          length: Math.max(
            0,
            Math.min(
              Number.isFinite(count) ? Math.floor(count) : 0,
              starts.length - Math.max(0, Math.floor(start) || 0),
            ),
          ),
        },
        (_, offset) => line(Math.max(0, Math.floor(start) || 0) + offset),
      ),
    copyLine: (index) => options.scalarValues?.get(index) ?? rawLine(index),
    section,
    copySection: (landmarkId) => {
      const range = section(landmarkId)
      return range
        ? text
            .slice(
              starts[range.start],
              starts[range.start + range.count] ?? text.length,
            )
            .replace(/\n$/, '')
        : undefined
    },
    find: (query, from, direction) => {
      if (!query) return null
      const projection = searchable()
      const originLine = Math.max(0, Math.min(from.line, projection.starts.length - 1))
      const origin = Math.min(
        projection.text.length,
        projection.starts[originLine] + Math.max(0, from.character),
      )
      const index =
        direction === 1
          ? projection.text.indexOf(query, origin)
          : projection.text.lastIndexOf(query, origin)
      return index < 0 ? null : locate(index, projection.starts)
    },
  }
}

/** Iterative projection: cycles, shared objects and excessive depth stay bounded. */
export function createJsonDocument(
  id: string,
  title: string,
  value: unknown,
  limits: { maxLines?: number; maxCharacters?: number; maxDepth?: number } = {},
): OutputDocument {
  const maxLines = Math.max(1, Math.min(100_000, limits.maxLines ?? 100_000))
  const maxCharacters = Math.max(
    128,
    Math.min(8_000_000, limits.maxCharacters ?? 8_000_000),
  )
  const lines: string[] = []
  const landmarks: OutputLandmark[] = []
  const scalarValues = new Map<number, string>()
  const rowValues = new Map<number, { path: string; value: unknown }>()
  const details = new Map<number, OutputDocument>()
  const seen = new WeakMap<object, number>()
  type Item = { path: string; value: unknown; depth: number }
  type Frame = Item | { iterator: Generator<Item> }
  const stack: Frame[] = [{ path: '$', value, depth: 0 }]
  let limited = false
  let characters = 0
  const append = (line: string) => {
    lines.push(line)
    characters += line.length
  }
  // Enumerate one child at a time. No Object.keys/entries allocation or eager
  // getter invocation is needed even for a million-element retained array.
  function* children(item: Item): Generator<Item> {
    const object = item.value as Record<string, unknown>
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(object, index)
        yield {
          path: `${item.path}[${index}]`,
          value:
            descriptor && 'value' in descriptor
              ? descriptor.value
              : descriptor
                ? '[accessor not evaluated]'
                : undefined,
          depth: item.depth + 1,
        }
      }
      return
    }
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      yield {
        path: Array.isArray(object)
          ? `${item.path}[${key}]`
          : `${item.path}[${JSON.stringify(key)}]`,
        value:
          descriptor && 'value' in descriptor
            ? descriptor.value
            : '[accessor not evaluated]',
        depth: item.depth + 1,
      }
    }
  }
  while (
    stack.length &&
    lines.length < maxLines &&
    characters < maxCharacters
  ) {
    const frame = stack.pop()!
    if ('iterator' in frame) {
      const next = frame.iterator.next()
      if (!next.done) stack.push(frame, next.value)
      continue
    }
    const item = frame
    const line = lines.length
    rowValues.set(line, { path: item.path, value: item.value })
    if (item.value === null || typeof item.value !== 'object') {
      const scalar =
        typeof item.value === 'string' ? item.value : String(item.value)
      scalarValues.set(line, scalar)
      // Long scalar values remain copyable; the projection labels its limit.
      const shown =
        scalar.length > 8192
          ? `${scalar.slice(0, 8192)} … [long value; C copies the complete scalar]`
          : scalar
      if (shown !== scalar) limited = true
      append(`${item.path}: ${shown.replaceAll('\n', '\\n')}`)
      continue
    }
    if (seen.has(item.value)) {
      append(
        `${item.path}: [shared or circular reference] · see line ${seen.get(item.value)! + 1}`,
      )
      continue
    }
    seen.set(item.value, line)
    if (item.depth >= (limits.maxDepth ?? 100)) {
      append(`${item.path}: [depth limit reached]`)
      limited = true
      continue
    }
    const array = Array.isArray(item.value)
    append(
      array
        ? `${item.path} · ${(item.value as unknown[]).length} items`
        : `${item.path} · object fields`,
    )
    if (item.depth < 3 && landmarks.length < 1000)
      landmarks.push({
        id: `${id}:${item.path}`,
        label: item.path,
        line,
        level: item.depth + 1,
      })
    stack.push({ iterator: children(item) })
  }
  if (stack.length) limited = true
  const document = createTextDocument({
    id,
    title,
    kind: 'json',
    text: lines.join('\n'),
    landmarks,
    scalarValues,
    rowCount: lines.length,
    row: (index) => {
      const value = rowValues.get(index)
      return value
        ? {
            id: `${id}:field:${index}`,
            label: value.path,
            line: index,
            value: value.value,
          }
        : undefined
    },
    detail: (index) => {
      const value = rowValues.get(index)
      if (!value) return undefined
      const cached = details.get(index)
      if (cached) return cached
      const detailId = `${id}:field:${index}`
      const detail = Array.isArray(value.value)
        ? createArrayRangeDocument(
            detailId,
            value.path,
            value.value,
            0,
            value.value.length,
          )
        : scalarValues.has(index)
          ? createTextDocument({
              id: detailId,
              title: value.path,
              text: scalarValues.get(index)!,
              notice: 'Complete retained scalar · logical lines and exact copy',
            })
          : createJsonDocument(detailId, value.path, value.value)
      detail.revision = `${document.revision}:field:${index}`
      if (details.size >= 128) details.delete(details.keys().next().value!)
      details.set(index, detail)
      return detail
    },
    availability: limited ? 'limited' : 'retained',
    notice: limited
      ? 'Captured values · projection limit reached; C copies the selected scalar'
      : 'Captured values · C copies the selected scalar exactly',
  })
  return document
}

/** Partition a retained array into at most 1,000 ranges; materialize only a selected leaf. */
export function createArrayRangeDocument(
  id: string,
  title: string,
  values: readonly unknown[],
  start = 0,
  count = values.length,
): OutputDocument {
  const length = Math.max(0, Math.min(count, values.length - start))
  const size = Math.max(1, Math.ceil(length / 1000))
  const ranges = Array.from(
    { length: Math.ceil(length / size) },
    (_, index) => ({
      start: start + index * size,
      count: Math.min(size, length - index * size),
    }),
  )
  const document = createTableDocument({
    id,
    title,
    rows: ranges,
    columns: [{ key: 'range', label: 'Captured array indices' }],
    label: (value) => {
      const range = value as { start: number; count: number }
      return `[${range.start}–${range.start + range.count - 1}] · ${range.count} captured items`
    },
  })
  const details = new Map<number, OutputDocument>()
  document.detail = (index) => {
    const range = ranges[index]
    if (!range) return undefined
    const cached = details.get(index)
    if (cached) return cached
    const childId = `${id}:range:${range.start}`
    const child =
      range.count > 1000
        ? createArrayRangeDocument(
            childId,
            `${title}[${range.start}…${range.start + range.count - 1}]`,
            values,
            range.start,
            range.count,
          )
        : createJsonDocument(
            childId,
            `${title}[${range.start}…${range.start + range.count - 1}]`,
            values.slice(range.start, range.start + range.count),
          )
    child.revision = `${document.revision}:range:${range.start}`
    if (details.size >= 128) details.delete(details.keys().next().value!)
    details.set(index, child)
    return child
  }
  document.notice =
    'Captured array ranges · Enter opens a selected range · original indices appear in the title'
  return document
}

/** Rows keep their captured payload; only selected row details are projected. */
export function createTableDocument(options: {
  id: string
  title: string
  rows: readonly unknown[]
  columns: readonly OutputColumn[]
  label: (value: unknown, index: number) => string
  kind?: OutputKind
}): OutputDocument {
  const details = new Map<number, OutputDocument>()
  const projected = Math.min(options.rows.length, 100_000)
  const labels: string[] = []
  const landmarks: OutputLandmark[] = []
  let characters = 0
  for (let index = 0; index < projected && characters < 8_000_000; index++) {
    const label = cleanLine(options.label(options.rows[index], index)).slice(
      0,
      8192,
    )
    labels.push(label)
    characters += label.length
    if (index < 1000)
      landmarks.push({
        id: `${options.id}:row:${index}`,
        label,
        line: index + 1,
        level: 1,
      })
  }
  const row = (index: number): OutputRow | undefined =>
    Number.isInteger(index) && index >= 0 && index < options.rows.length
      ? {
          id: `${options.id}:row:${index}`,
          label: labels[index] ?? `Row ${index + 1}`,
          line: index + 1,
          value: options.rows[index],
        }
      : undefined
  const document = createTextDocument({
    id: options.id,
    title: options.title,
    kind: options.kind ?? 'table',
    text: [
      options.columns.map((column) => column.label).join(' | '),
      ...labels,
    ].join('\n'),
    landmarks,
    columns: options.columns,
    rowCount: options.rows.length,
    row,
    detail: (index) => {
      const selected = row(index)
      if (!selected) return undefined
      const cached = details.get(index)
      if (cached) return cached
      const detail = createJsonDocument(
        selected.id,
        selected.label,
        selected.value,
      )
      detail.revision = `${document.revision}:row:${index}`
      if (details.size >= 128) details.delete(details.keys().next().value!)
      details.set(index, detail)
      return detail
    },
    availability: labels.length < options.rows.length ? 'limited' : 'retained',
    coverage: {
      captured: options.rows.length,
      unit: 'rows',
      reasons:
        labels.length < options.rows.length
          ? [
              'Reader projection limit; use G then row <number> to inspect any retained row',
            ]
          : [],
    },
    notice: `Captured rows · ${labels.length} of ${options.rows.length} projected · row details retain every captured field`,
  })
  return document
}
