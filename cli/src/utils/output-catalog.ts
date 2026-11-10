import type { ChatMessage, ContentBlock, ToolContentBlock } from '../types/chat'
import {
  createJsonDocument,
  createTableDocument,
  createTextDocument,
  type OutputDocument,
  type OutputKind,
  type OutputLandmark,
} from './output-document'
import {
  getToolOutputRecords,
  getToolOutputValues,
  getCanonicalMutationResult,
  TOOL_RESULT_METADATA_LIMIT,
  type ToolResultRecord,
} from './tool-result-normalizer'
import { outcomeForTool, classifyOutputOutcome } from './output-outcome'
import { acceptedReceiptVerdict, submittedReceiptValue } from './review-outcome'
import { capturedArtifacts, recoverCapturedArtifact } from './output-artifact'
import { parseTerminalResult } from '../components/tools/run-terminal-command'
import { createCommandDiagnosticDocument } from './captured-diagnostic-document'

export interface OutputEntry {
  id: string
  title: string
  messageId: string
  toolCallId?: string
  /** Conservative kind metadata; unmatched destinations need not project content. */
  possibleKinds?: readonly OutputKind[]
  read: () => OutputDocument
  recover?: () => Promise<OutputDocument>
}

const NON_CHANGE_KINDS: readonly OutputKind[] = [
  'markdown',
  'log',
  'json',
  'text',
  'search',
  'table',
  'agent',
  'job',
  'replay',
]

export function filterOutputEntries(
  entries: OutputEntry[],
  kinds: readonly OutputKind[],
): OutputEntry[] {
  return entries.filter(
    (entry) =>
      (!entry.possibleKinds ||
        entry.possibleKinds.some((kind) => kinds.includes(kind))) &&
      kinds.includes(entry.read().kind),
  )
}

type CacheItem = {
  raw: unknown
  text: unknown
  lifecycle: unknown
  document: OutputDocument
}
const secondaryCache = new WeakMap<
  object,
  Map<string, { source: unknown; document: OutputDocument }>
>()
let nextSecondaryRevision = 0
function secondaryDocument(
  block: object,
  key: string,
  build: () => OutputDocument,
  source?: unknown,
): OutputDocument {
  let cache = secondaryCache.get(block)
  if (!cache) {
    cache = new Map()
    secondaryCache.set(block, cache)
  }
  const cached = cache.get(key)
  if (cached && cached.source === source) return cached.document
  const document = build()
  document.revision =
    source === undefined ? key : `${key}:${++nextSecondaryRevision}`
  if (cache.size >= 128) cache.delete(cache.keys().next().value!)
  cache.set(key, { source, document })
  return document
}
const documentCache = new WeakMap<object, CacheItem>()
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const record = (value: unknown): ToolResultRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ToolResultRecord)
    : undefined
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
const hasFields = (value: object) => {
  for (const key in value)
    if (Object.prototype.hasOwnProperty.call(value, key)) return true
  return false
}

function cachedDocument(
  block: object,
  raw: unknown,
  text: unknown,
  lifecycle: unknown,
  build: () => OutputDocument,
): OutputDocument {
  const cached = documentCache.get(block)
  if (
    cached &&
    cached.raw === raw &&
    cached.text === text &&
    (Array.isArray(cached.lifecycle) && Array.isArray(lifecycle)
      ? cached.lifecycle.length === lifecycle.length &&
        cached.lifecycle.every((value, index) =>
          Object.is(value, lifecycle[index]),
        )
      : cached.lifecycle === lifecycle)
  )
    return cached.document
  const document = build()
  documentCache.set(block, { raw, text, lifecycle, document })
  return document
}

/** Schema-owned collection rows; opaque nested data is never status evidence. */
function resultRows(
  block: ToolContentBlock,
  records: ToolResultRecord[],
): readonly unknown[] | undefined {
  const result = records[0]
  if (!result) return undefined
  if (block.toolName === 'recall_context') {
    const matches = Array.isArray(result.matches)
      ? result.matches
      : Array.isArray(result.hits)
        ? result.hits
        : []
    const consolidations = Array.isArray(result.consolidations)
      ? result.consolidations
      : Array.isArray(result.consolidationHits)
        ? result.consolidationHits
        : []
    return [...matches, ...consolidations]
  }
  const fields =
    block.toolName === 'list_jobs'
      ? ['jobs']
      : block.toolName === 'check_job' ||
          block.toolName === 'check_background_agent'
        ? ['events']
        : block.toolName === 'query_index'
          ? ['results', 'matches']
          : block.toolName === 'find_references' ||
              block.toolName === 'go_to_definition'
            ? ['locations']
            : block.toolName === 'workspace_symbol'
              ? ['symbols']
              : []
  for (const field of fields)
    if (Array.isArray(result[field])) return result[field] as unknown[]
  return undefined
}

function metadataForTool(
  block: ToolContentBlock,
  document: OutputDocument,
): OutputDocument {
  const records = getToolOutputRecords(block.outputRaw)
  const result = records[0]
  const ownedRows = resultRows(block, records)
  // Inspect schema-owned rows only, at a bounded depth; getters/opaque custom
  // descendants are not traversed to infer success or capture completeness.
  const values = getToolOutputValues(block.outputRaw)
  const rows: ToolResultRecord[] = records.slice(0, 1000)
  if (
    [
      'read_subtree',
      'run_file_change_hooks',
      'spawn_agents',
      'spawn_agent_inline',
    ].includes(block.toolName)
  ) {
    for (const value of values)
      if (Array.isArray(value))
        for (let i = 0; i < Math.min(value.length, 1000); i++) {
          const row = record(value[i])
          if (row) rows.push(row)
        }
  }
  const canonicalRead = records.find((row) => row.kind === 'read_files_result')
  if (Array.isArray(canonicalRead?.results))
    for (const value of canonicalRead.results.slice(0, 1000)) {
      const row = record(value)
      if (row) rows.push(row)
    }
  const reasons = new Set(document.coverage?.reasons ?? [])
  if (
    Array.isArray(block.outputRaw) &&
    block.outputRaw.length > TOOL_RESULT_METADATA_LIMIT
  )
    reasons.add(
      'Result metadata inspection limited; full captured collection remains in the reader projection',
    )
  for (const row of rows) {
    if (
      row.truncated === true ||
      row.liveScanTruncated === true ||
      row.complete === false
    )
      reasons.add('Producer capture is partial; more may exist')
    if (row.logPersisted === true)
      reasons.add('Captured log may be bounded; saved artifact available')
    if (row.salvaged === true) reasons.add('Runtime retained a bounded salvage')
    if (
      row.truncation !== undefined ||
      (typeof row.truncationLevel === 'string' &&
        row.truncationLevel !== 'none')
    )
      reasons.add(
        `Capture limit: ${String(row.truncationLevel ?? 'see result details')}`,
      )
    if ((finite(row.dropped) ?? 0) > 0)
      reasons.add(`${row.dropped} events dropped before capture`)
    if ((finite(row.truncatedCount) ?? 0) > 0)
      reasons.add(`${row.truncatedCount} producer entries omitted`)
  }
  if (reasons.size && document.availability === 'retained')
    document.availability = 'limited'
  if (block.lifecycle === 'queued' || block.lifecycle === 'running')
    document.availability = 'pending'
  const stale = rows.some(
    (row) =>
      row.stale === true ||
      row.symbolsMayBeStale === true ||
      row.freshness === 'stale',
  )
  const cached = rows.some(
    (row) =>
      row.cached === true ||
      row.source === 'cache' ||
      row.source === 'cached' ||
      row.provenance === 'cached' ||
      row.cacheStatus === 'hit',
  )
  const memory =
    typeof result?.message === 'string' &&
    /served from verified memory/i.test(result.message)
  document.provenance ??= {
    source: 'capture',
    identity: string(result?.path) ?? string(result?.jobId),
    version:
      string(result?.sourceVersion) ??
      string(result?.snapshotFingerprint) ??
      string(result?.snapshotId),
    freshness: stale ? 'stale' : cached || memory ? 'cached' : 'captured',
    exact:
      document.kind === 'text' ||
      document.kind === 'markdown' ||
      document.kind === 'log',
  }
  document.outcome = outcomeForTool(block)
  const verdict = acceptedReceiptVerdict(block)
  if (verdict)
    document.outcome = {
      label: verdict,
      tone: classifyOutputOutcome(verdict),
      source: 'producer',
    }
  document.coverage = {
    ...document.coverage,
    captured: document.coverage?.captured ?? ownedRows?.length,
    unit: document.coverage?.unit ?? (ownedRows ? 'rows' : undefined),
    reasons: [...reasons],
    nextOffset: finite(result?.nextOffset),
  }
  const diagnostics: unknown[] = []
  for (const row of rows)
    for (const key of ['diagnostics', 'newDiagnostics', 'errors', 'fixIts'])
      if (Array.isArray(row[key]))
        diagnostics.push(
          ...(row[key] as unknown[]).slice(
            0,
            Math.max(0, 1000 - diagnostics.length),
          ),
        )
  document.diagnostics = diagnostics
  const flags = [
    document.outcome.label,
    block.interrupted ? 'Run interrupted · captured disk outcome retained' : '',
    stale
      ? 'stale captured evidence'
      : cached || memory
        ? 'cached evidence'
        : '',
    ...reasons,
    typeof result?.message === 'string' ? result.message : '',
    typeof result?.note === 'string' ? result.note : '',
  ].filter(Boolean)
  document.notice = [
    document.notice,
    ...flags.slice(0, 8).map((flag) => flag.slice(0, 600)),
    ...(flags.length > 8 ? ['More coverage details retained in metadata'] : []),
  ].join(' · ')
  return document
}

function hoverText(result: ToolResultRecord | undefined): string | undefined {
  const hover = record(result?.hover)
  const contents = hover?.contents ?? result?.contents
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents))
    return contents
      .map((value) =>
        typeof value === 'string'
          ? value
          : (string(record(value)?.value) ?? ''),
      )
      .join('\n\n')
  return string(record(contents)?.value)
}

export function documentForTool(block: ToolContentBlock): OutputDocument {
  const primary = getToolOutputRecords(block.outputRaw)[0]
  const status = record(primary?.status)
  const lifecycle = [
    block.lifecycle,
    block.interrupted,
    block.backgroundJobId,
    primary?.state,
    primary?.status,
    status?.state,
    status?.refreshing,
    primary?.exitCode,
    primary?.timedOut,
    primary?.outcome,
    primary?.salvaged,
    primary?.truncated,
    primary?.stdout,
    primary?.stderr,
    primary?.content,
    primary?.documentation,
    primary?.revision,
    primary?.events,
    Array.isArray(primary?.events) ? primary.events.length : undefined,
    primary?.results,
    Array.isArray(primary?.results) ? primary.results.length : undefined,
  ]
  return cachedDocument(block, block.outputRaw, block.output, lifecycle, () => {
    const id = `tool:${block.toolCallId}`
    const title = block.toolName.replaceAll('_', ' ')
    const records = getToolOutputRecords(block.outputRaw)
    const result = records[0]
    let document: OutputDocument
    if (block.toolName === 'run_terminal_command') {
      // Typed payload is authoritative; text-only stdout stays literal, even
      // when it happens to spell JSON with terminal-like keys.
      const parsed = parseTerminalResult(block.outputRaw, block.output)
      const streams = [string(result?.stdout), string(result?.stderr)].filter(
        (value): value is string => value !== undefined,
      )
      document = createTextDocument({
        id,
        title:
          typeof block.input?.command === 'string'
            ? `$ ${block.input.command}`
            : title,
        kind: 'log',
        text: streams.length ? streams.join('') : (parsed.output ?? ''),
        availability:
          block.outputRaw === undefined && block.output === undefined
            ? 'unavailable'
            : 'retained',
        notice: `Captured log${parsed.exitCode !== undefined ? ` · exit ${parsed.exitCode}` : ''}${parsed.status ? ` · ${parsed.status}` : ''}${string(result?.logFile) ? ` · saved log: ${result!.logFile}` : ''} · ${streams.length > 1 ? 'stdout then stderr; original interleaving not captured' : 'stream identity available in result details'}`,
      })
    } else if (
      block.toolName === 'code_search' &&
      (typeof result?.stdout === 'string' ||
        typeof result?.stdoutExcerpt === 'string' ||
        block.outputRaw === undefined)
    ) {
      const text =
        string(result?.stdout) ??
        string(result?.stdoutExcerpt) ??
        block.output ??
        ''
      const landmarks: OutputLandmark[] = []
      let line = 0
      for (const content of text.split('\n')) {
        if (/^.+:\s*$/.test(content) && !/^Line\s/.test(content))
          landmarks.push({
            id: `${id}:${line}`,
            label: content.replace(/:\s*$/, ''),
            line,
            level: 1,
          })
        line++
      }
      document = createTextDocument({
        id,
        title,
        kind: 'search',
        text,
        landmarks,
        notice:
          'Captured search evidence · source paths and match/context lines retained',
        availability:
          result?.stdoutExcerpt !== undefined && result?.stdout === undefined
            ? 'limited'
            : 'retained',
      })
    } else if (
      block.toolName === 'read_docs' &&
      typeof result?.documentation === 'string'
    ) {
      const library = record(result.library)
      document = createTextDocument({
        id,
        title: string(library?.title) ?? title,
        kind: 'markdown',
        text: result.documentation,
        notice: `Captured documentation${string(library?.id) ? ` · ${library!.id}` : ''}${string(library?.branch) ? ` · branch ${library!.branch}` : ''}`,
      })
    } else if (
      block.toolName === 'hover_type' &&
      hoverText(result) !== undefined
    ) {
      document = createTextDocument({
        id,
        title,
        kind: 'markdown',
        text: hoverText(result)!,
        notice: 'Captured type information · complete retained scalar',
      })
    } else if (
      block.toolName === 'read_logs' &&
      (typeof result?.content === 'string' ||
        typeof result?.output === 'string')
    ) {
      document = createTextDocument({
        id,
        title,
        kind: 'log',
        text: string(result?.content) ?? string(result?.output) ?? '',
        notice: 'Captured log range · not a new log read',
      })
    } else {
      const rows = resultRows(block, records)
      if (rows) {
        const label = (value: unknown, index: number) => {
          const row = record(value)
          const payload = record(row?.payload)
          const text =
            string(payload?.data) ??
            string(payload?.text) ??
            string(payload?.message)
          return [
            string(row?.path) ??
              string(row?.filePath) ??
              string(row?.jobId) ??
              string(row?.name) ??
              `Row ${index + 1}`,
            string(row?.state) ?? string(row?.status) ?? string(payload?.type),
            text,
          ]
            .filter(Boolean)
            .join(' | ')
        }
        document = createTableDocument({
          id,
          title,
          rows,
          columns: [
            { key: 'identity', label: 'Source / identity' },
            { key: 'state', label: 'State / evidence' },
          ],
          label,
          kind:
            block.toolName === 'list_jobs' ||
            block.toolName === 'check_job' ||
            block.toolName === 'check_background_agent'
              ? 'job'
              : 'table',
        })
      } else if (block.outputRaw !== undefined) {
        const values = getToolOutputValues(block.outputRaw)
        document = createJsonDocument(
          id,
          title,
          block.toolName === 'set_output'
            ? {
                submitted: submittedReceiptValue(block.input),
                acknowledgment: values.length === 1 ? values[0] : values,
              }
            : {
                input: block.input,
                result: values.length === 1 ? values[0] : values,
              },
        )
        if (block.toolName === 'set_output') document.kind = 'receipt'
        if (
          block.toolName === 'spawn_agents' ||
          block.toolName === 'spawn_agent_inline'
        )
          document.kind = 'agent'
      } else
        document = createTextDocument({
          id,
          title,
          text: block.output ?? '',
          availability: block.output === undefined ? 'unavailable' : 'retained',
        })
    }
    return metadataForTool(block, document)
  })
}

/** Index identities first; selected documents and row details materialize lazily. */
export function collectOutputEntries(
  messages: readonly ChatMessage[],
): OutputEntry[] {
  const entries: OutputEntry[] = []
  const seen = new WeakSet<object>()
  const addBlocks = (blocks: readonly ContentBlock[], messageId: string) => {
    const stack = [{ blocks, index: 0 }]
    let visited = 0
    while (stack.length && visited++ < 100_000) {
      const frame = stack[stack.length - 1]
      if (frame.index >= frame.blocks.length) {
        stack.pop()
        continue
      }
      const index = frame.index++
      const block = frame.blocks[index]
      if (seen.has(block)) continue
      seen.add(block)
      if (block.type === 'tool') {
        if (['end_turn', 'ask_user'].includes(block.toolName)) continue
        const id = `tool:${block.toolCallId}`
        const retained = (key: string, build: () => OutputDocument) => () =>
          secondaryDocument(
            block,
            `${key}:${documentForTool(block).revision}`,
            build,
          )
        entries.push({
          id,
          title: block.toolName.replaceAll('_', ' '),
          messageId,
          toolCallId: block.toolCallId,
          possibleKinds:
            block.toolName === 'set_output'
              ? ['receipt', 'text']
              : NON_CHANGE_KINDS,
          read: () => documentForTool(block),
        })
        if (
          block.input &&
          typeof block.input === 'object' &&
          hasFields(block.input)
        )
          entries.push({
            id: `${id}:input`,
            title: `${block.toolName.replaceAll('_', ' ')} · submitted input`,
            messageId,
            toolCallId: block.toolCallId,
            possibleKinds: NON_CHANGE_KINDS,
            read: () =>
              secondaryDocument(block, `${id}:input`, () =>
                createJsonDocument(
                  `${id}:input`,
                  'Submitted input · captured request',
                  block.toolName === 'set_output'
                    ? submittedReceiptValue(block.input)
                    : block.input,
                ),
              ),
          })
        // Structured readers expose rows; this entry also retains enclosing
        // metadata/results that are not part of the row collection.
        if (
          resultRows(block, getToolOutputRecords(block.outputRaw)) ||
          (block.outputRaw !== undefined &&
            [
              'run_terminal_command',
              'code_search',
              'read_docs',
              'hover_type',
              'read_logs',
            ].includes(block.toolName))
        )
          entries.push({
            id: `${id}:result`,
            title: `${block.toolName.replaceAll('_', ' ')} · full captured result`,
            messageId,
            toolCallId: block.toolCallId,
            possibleKinds: NON_CHANGE_KINDS,
            read: () =>
              secondaryDocument(
                block,
                `${id}:result:${documentForTool(block).revision}`,
                () => {
                  const values = getToolOutputValues(block.outputRaw)
                  return metadataForTool(
                    block,
                    createJsonDocument(
                      `${id}:result`,
                      'Full captured result',
                      values.length === 1 ? values[0] : values,
                    ),
                  )
                },
              ),
          })
        for (const [artifactIndex, artifact] of capturedArtifacts(
          block.outputRaw,
        ).entries())
          entries.push({
            id: `${id}:artifact:${artifactIndex}`,
            title: `Saved artifact · ${artifact.path}`,
            messageId,
            toolCallId: block.toolCallId,
            possibleKinds: NON_CHANGE_KINDS,
            read: retained(`${id}:artifact:${artifactIndex}`, () =>
              createTextDocument({
                id: `${id}:artifact:${artifactIndex}`,
                title: artifact.path,
                text: '',
                availability: 'unavailable',
                notice:
                  'Saved artifact referenced by captured result · activate recovery to read the local artifact; original version requires verification',
              }),
            ),
            recover: () =>
              recoverCapturedArtifact(
                `${id}:artifact:${artifactIndex}`,
                artifact,
              ),
          })
        const mutation = getCanonicalMutationResult(block.outputRaw)
        const review = getToolOutputRecords(block.outputRaw)[0]
        if (
          ['git_status', 'get_change_review_bundle'].includes(block.toolName) &&
          typeof review?.diff === 'string'
        )
          entries.push({
            id: `${id}:diff`,
            possibleKinds: ['diff'],
            title: 'Captured review diff · file and hunk outline',
            messageId,
            toolCallId: block.toolCallId,
            read: retained(`${id}:diff`, () =>
              metadataForTool(
                block,
                createTextDocument({
                  id: `${id}:diff`,
                  title: 'Captured review diff',
                  kind: 'diff',
                  text: review.diff as string,
                  notice:
                    'Captured diff evidence · snapshot identity is not a review attestation',
                }),
              ),
            ),
          })
        if (
          Array.isArray(mutation?.actions) &&
          mutation.actions.some(
            (value) => typeof record(value)?.patch === 'string',
          )
        ) {
          const actions = mutation.actions
          entries.push({
            id: `${id}:changes`,
            possibleKinds: ['diff'],
            title: 'Captured changes · file and hunk outline',
            messageId,
            toolCallId: block.toolCallId,
            read: retained(`${id}:changes`, () =>
              metadataForTool(
                block,
                createTextDocument({
                  id: `${id}:changes`,
                  title: 'Captured changes',
                  kind: 'diff',
                  text: actions
                    .filter((value) => typeof record(value)?.patch === 'string')
                    .map((value) => {
                      const action = value as ToolResultRecord
                      return `diff --git a/${action.path} b/${action.destinationPath ?? action.path}\n${action.patch}`
                    })
                    .join('\n\n'),
                  notice:
                    'Captured patches · proposed/applied/rollback outcomes remain in the tool result',
                }),
              ),
            ),
          })
        }
        const read = getToolOutputRecords(block.outputRaw).find(
          (value) => value.kind === 'read_files_result',
        )
        if (Array.isArray(read?.results))
          for (
            let resultIndex = 0;
            resultIndex < Math.min(read.results.length, 100_000);
            resultIndex++
          ) {
            const result = record(read.results[resultIndex])
            const source =
              string(result?.sourceContent) ?? string(result?.content)
            if (source === undefined) continue
            const readId = `${id}:read:${resultIndex}`
            const title = string(result?.path) ?? 'Captured file'
            entries.push({
              id: readId,
              possibleKinds: ['text'],
              title,
              messageId,
              toolCallId: block.toolCallId,
              read: retained(readId, () =>
                createTextDocument({
                  id: readId,
                  title,
                  kind: 'text',
                  text: source,
                  availability:
                    result?.status === 'partial' || result?.complete === false
                      ? 'limited'
                      : 'retained',
                  provenance: {
                    source: 'capture',
                    identity: title,
                    freshness: 'captured',
                    exact: typeof result?.sourceContent === 'string',
                    startLine: finite(result?.startLine) ?? 1,
                    version:
                      string(result?.contentHash) ??
                      string(result?.sourceVersion),
                  },
                  notice: `Captured ${result?.selector ?? 'read'} · source lines ${result?.startLine ?? 1}${result?.endLine ? `–${result.endLine}` : ''} · ${result?.status ?? 'status unknown'} · ${typeof result?.sourceContent === 'string' ? 'exact source text' : 'formatted capture'}`,
                }),
              ),
            })
          }
      } else if (
        block.type === 'text' ||
        block.type === 'plan' ||
        block.type === 'agent'
      ) {
        const id =
          block.type === 'agent'
            ? `agent:${block.agentId}`
            : block.type === 'text' && block.thinkingId
              ? `text:${block.thinkingId}`
              : `${messageId}:${block.type}:${index}`
        const title =
          block.type === 'agent'
            ? block.agentName
            : block.type === 'plan'
              ? 'Plan'
              : block.type === 'text' && block.textType === 'reasoning'
                ? 'Reasoning'
                : 'Message'
        if (block.content)
          entries.push({
            id,
            title,
            messageId,
            possibleKinds: ['markdown'],
            read: () =>
              cachedDocument(
                block,
                undefined,
                block.content,
                block.type === 'agent' ? block.status : undefined,
                () =>
                  createTextDocument({
                    id,
                    title,
                    kind: 'markdown',
                    text: block.content,
                    provenance: {
                      source: 'capture',
                      freshness: 'captured',
                      exact: true,
                    },
                  }),
              ),
          })
        if (block.type === 'agent' && block.blocks)
          stack.push({ blocks: block.blocks, index: 0 })
      } else {
        const id = `${messageId}:${block.type}:${index}`
        const title = block.type.replaceAll('-', ' ')
        const value = block as unknown as ToolResultRecord
        entries.push({
          id,
          title,
          messageId,
          possibleKinds: NON_CHANGE_KINDS,
          read: () =>
            cachedDocument(
              block,
              value.lines ?? value.reportText ?? block,
              undefined,
              value.state ?? value.statusLine ?? value.updateStatus,
              () => {
                if (block.type === 'image')
                  return createJsonDocument(id, 'Captured image metadata', {
                    ...block,
                    image: undefined,
                  })
                if (block.type === 'html')
                  return createTextDocument({
                    id,
                    title,
                    text: '',
                    availability: 'unavailable',
                    notice:
                      'Dynamic rendered content has no retained text capture',
                  })
                const lines = Array.isArray(value.lines)
                  ? value.lines.filter(
                      (line): line is string => typeof line === 'string',
                    )
                  : undefined
                if (lines)
                  return createTextDocument({
                    id,
                    title: string(value.title) ?? title,
                    text: lines.join('\n'),
                    notice:
                      'Captured command report · limits and checked-source details are retained in the report',
                    provenance: {
                      source: 'capture',
                      freshness: 'captured',
                      exact: true,
                    },
                  })
                if (typeof value.reportText === 'string')
                  return createTextDocument({
                    id,
                    title,
                    text: value.reportText,
                    kind: 'markdown',
                    notice: 'Captured plan report · no current artifact read',
                  })
                const document =
                  createCommandDiagnosticDocument(id, title, block) ??
                  createJsonDocument(id, title, block)
                if (block.type === 'doctor') {
                  const diagnostics = Object.getOwnPropertyDescriptor(
                    block,
                    'diagnostics',
                  )?.value
                  if (Array.isArray(diagnostics)) {
                    document.diagnostics = diagnostics
                    document.notice = `${document.notice} · ${diagnostics.length} captured diagnostics`
                  } else
                    document.notice = `${document.notice} · Diagnostic list unavailable in captured data`
                }
                return document
              },
            ),
        })
      }
    }
  }
  for (const message of messages) {
    if (message.validationErrors?.length)
      entries.push({
        id: `message:${message.id}:validation`,
        title: 'Captured validation errors',
        messageId: message.id,
        possibleKinds: NON_CHANGE_KINDS,
        read: () =>
          secondaryDocument(
            message,
            `message:${message.id}:validation`,
            () =>
              createJsonDocument(
                `message:${message.id}:validation`,
                'Captured validation errors',
                message.validationErrors,
              ),
            message.validationErrors,
          ),
      })
    if (message.userError)
      entries.push({
        id: `message:${message.id}:error`,
        title: 'Captured error',
        messageId: message.id,
        possibleKinds: ['text'],
        read: () =>
          secondaryDocument(
            message,
            `message:${message.id}:error`,
            () =>
              createTextDocument({
                id: `message:${message.id}:error`,
                title: 'Captured error',
                text: message.userError!,
              }),
            message.userError,
          ),
      })
    if (message.blocks?.length) addBlocks(message.blocks, message.id)
    else if (message.content)
      entries.push({
        id: `message:${message.id}`,
        title: message.variant === 'user' ? 'Prompt' : 'Response',
        messageId: message.id,
        possibleKinds: ['markdown'],
        read: () =>
          cachedDocument(message, undefined, message.content, undefined, () =>
            createTextDocument({
              id: `message:${message.id}`,
              title: message.variant === 'user' ? 'Prompt' : 'Response',
              kind: 'markdown',
              text: message.content,
            }),
          ),
      })
  }
  return entries
}
