import {
  createJsonDocument,
  createTextDocument,
  type OutputDocument,
} from './output-document'
import type { ContentBlock } from '../types/chat'

const MAX_PROJECTION_CHARS = 8_000_000
const MAX_PROJECTION_LINES = 100_000

/** Reject inherited/accessor fields before either validation or formatting reads them. */
function dataFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    return descriptor === undefined || 'value' in descriptor
  })
}
const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)

/** Inspect accepts unvalidated captures; fail over to bounded JSON before eager projection. */
function hasReadableDiagnosticShape(source: object): boolean {
  if (!dataFields(source, ['type'])) return false
  // Reserve headings, numeric summaries, separators and the raw-field action.
  let remainingChars = MAX_PROJECTION_CHARS - 1024
  let remainingLines = MAX_PROJECTION_LINES - 32
  const text = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    remainingChars -= value.length + 32
    if (remainingChars < 0 || --remainingLines < 0) return false
    for (
      let index = value.indexOf('\n');
      index !== -1;
      index = value.indexOf('\n', index + 1)
    )
      if (--remainingLines < 0) return false
    return true
  }
  const optionalText = (value: unknown) => value === undefined || text(value)
  const items = (value: unknown, validate: (item: unknown) => boolean) => {
    if (!Array.isArray(value)) return false
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      ['map', 'flatMap', 'constructor', Symbol.iterator].some((key) =>
        Object.getOwnPropertyDescriptor(value, key),
      )
    )
      return false
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    // Check collection extent before touching any entries or running .map/.flatMap.
    if (typeof length !== 'number' || length > remainingLines) return false
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index)
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !validate(descriptor.value)
      )
        return false
    }
    return true
  }
  const strings = (value: unknown) => items(value, text)
  const optionalStrings = (value: unknown) =>
    value === undefined || strings(value)
  switch (source.type) {
    case 'doctor':
      return (
        dataFields(source, [
          'projectRoot',
          'providerStatus',
          'agentsTrusted',
          'skillsTrusted',
          'skillCount',
          'mcpCount',
          'diagnostics',
          'capabilities',
        ]) &&
        text(source.projectRoot) &&
        text(source.providerStatus) &&
        typeof source.agentsTrusted === 'boolean' &&
        typeof source.skillsTrusted === 'boolean' &&
        finiteNumber(source.skillCount) &&
        finiteNumber(source.mcpCount) &&
        items(
          source.diagnostics,
          (item) =>
            dataFields(item, ['message', 'filePath', 'agentId']) &&
            text(item.message) &&
            optionalText(item.filePath) &&
            optionalText(item.agentId),
        ) &&
        (source.capabilities === undefined ||
          items(
            source.capabilities,
            (item) =>
              dataFields(item, ['label', 'value', 'rows']) &&
              text(item.label) &&
              text(item.value) &&
              optionalStrings(item.rows),
          ))
      )
    case 'context':
      return (
        dataFields(source, [
          'ledgerText',
          'gateBudgetsText',
          'instructionFilesText',
        ]) &&
        (source.ledgerText === null || text(source.ledgerText)) &&
        text(source.gateBudgetsText) &&
        optionalText(source.instructionFilesText)
      )
    case 'info':
      return (
        dataFields(source, ['version', 'workspace']) &&
        text(source.version) &&
        text(source.workspace)
      )
    case 'memory': {
      if (
        !dataFields(source, [
          'state',
          'revision',
          'updatedAt',
          'goal',
          'goalPreview',
          'counts',
          'evidence',
          'stalePaths',
          'totalStaleCount',
          'v2Lines',
          'memoryV2Status',
        ])
      )
        return false
      const counts = source.counts
      const evidence = source.evidence
      const countFields = [
        'decisions',
        'requirements',
        'editsMade',
        'validationResults',
        'blockers',
        'nextActions',
      ]
      const evidenceFields = ['fresh', 'stale', 'total']
      return (
        source.state === 'status' &&
        finiteNumber(source.revision) &&
        finiteNumber(source.updatedAt) &&
        (source.goal === null || text(source.goal)) &&
        text(source.goalPreview) &&
        dataFields(counts, countFields) &&
        countFields.every((key) => finiteNumber(counts[key])) &&
        dataFields(evidence, evidenceFields) &&
        evidenceFields.every((key) => finiteNumber(evidence[key])) &&
        strings(source.stalePaths) &&
        finiteNumber(source.totalStaleCount) &&
        optionalStrings(source.v2Lines) &&
        (source.memoryV2Status === undefined ||
          (typeof source.memoryV2Status === 'string' &&
            ['healthy', 'degraded', 'unavailable', 'unknown'].includes(
              source.memoryV2Status,
            )))
      )
    }
    default:
      return false
  }
}

/** Give local command captures readable sections while retaining their exact fields. */
export function createCommandDiagnosticDocument(
  id: string,
  title: string,
  source: object,
): OutputDocument | undefined {
  // Reject only the semantic view. The caller retains the original object in
  // its bounded raw-field adapter, including malformed or missing values.
  if (!hasReadableDiagnosticShape(source)) return undefined
  const block = source as ContentBlock
  let lines: string[]
  switch (block.type) {
    case 'doctor':
      lines = [
        'Project',
        `Project root: ${block.projectRoot}`,
        `Project agents: ${block.agentsTrusted ? 'trusted and enabled' : 'disabled'}`,
        `Project skills: ${block.skillsTrusted ? 'trusted and enabled' : 'disabled'}`,
        `Loaded skills: ${block.skillCount}`,
        `Loaded MCP servers: ${block.mcpCount}`,
        '',
        'Providers & models',
        ...block.providerStatus.split('\n'),
        '',
        `Agent diagnostics: ${block.diagnostics.length} captured`,
        ...block.diagnostics.map(
          (diagnostic) =>
            `${diagnostic.filePath || diagnostic.agentId || 'Agent'}: ${diagnostic.message}`,
        ),
        '',
        'Capabilities',
        ...(block.capabilities ?? []).flatMap((row) => [
          `${row.label}: ${row.value}`,
          ...(row.rows ?? []).map((detail) => `  ${detail}`),
        ]),
      ]
      break
    case 'context':
      lines = [
        'Budget ledger',
        block.ledgerText ?? 'Ledger not captured.',
        '',
        'Gate budgets',
        block.gateBudgetsText || 'Gate budgets not captured.',
        ...(block.instructionFilesText
          ? ['', block.instructionFilesText]
          : []),
      ]
      break
    case 'info':
      lines = [
        `Version: ${block.version}`,
        `Workspace: ${block.workspace}`,
        'Auth: Local/BYOK Mode',
      ]
      break
    case 'memory':
      if (block.state !== 'status') return undefined
      lines = [
        `Memory revision: ${block.revision}`,
        `Source updated at: ${block.updatedAt}`,
        `Memory V2 health: ${block.memoryV2Status ?? 'not captured'}`,
        ...(block.v2Lines ?? []),
        '',
        'Goal',
        block.goal || block.goalPreview,
        '',
        'Task summary',
        `Decisions: ${block.counts.decisions}`,
        `Requirements: ${block.counts.requirements}`,
        `Edits: ${block.counts.editsMade}`,
        `Validations: ${block.counts.validationResults}`,
        `Blockers: ${block.counts.blockers}`,
        `Next actions: ${block.counts.nextActions}`,
        '',
        `Evidence: ${block.evidence.fresh} fresh, ${block.evidence.stale} stale (of ${block.evidence.total})`,
        `Stale paths: ${block.stalePaths.length} names captured of ${block.totalStaleCount} entries`,
        ...block.stalePaths,
      ]
      break
    default:
      return undefined
  }
  // Command producers already bound captured lists. Keep projection bounds
  // explicit too; the lazy raw-field detail always retains the original source.
  const fullText = lines.join('\n')
  const projectedLines = fullText.slice(0, MAX_PROJECTION_CHARS).split('\n')
  const limited =
    fullText.length > MAX_PROJECTION_CHARS ||
    projectedLines.length > MAX_PROJECTION_LINES
  const shownLines = projectedLines.slice(0, MAX_PROJECTION_LINES)
  shownLines.push('', 'Raw captured fields · Enter to inspect')
  const text = shownLines.join('\n')
  const rawLine = shownLines.length - 1
  const sectionTitles = new Set([
    'Project',
    'Providers & models',
    'Capabilities',
    'Budget ledger',
    'Gate budgets',
    'Goal',
    'Task summary',
  ])
  let rawDocument: OutputDocument | undefined
  const document = createTextDocument({
    id,
    title,
    text,
    landmarks: shownLines.flatMap((line, index) =>
      sectionTitles.has(line) || line.startsWith('Agent diagnostics:')
        ? [{ id: `${id}:section:${index}`, label: line, line: index, level: 1 }]
        : [],
    ),
    availability: limited ? 'limited' : 'retained',
    notice:
      'Captured command report · Enter on Raw captured fields opens the original data',
    provenance: { source: 'capture', freshness: 'captured', exact: false },
    rowCount: rawLine + 1,
    row: (index) =>
      index === rawLine
        ? {
            id: `${id}:raw`,
            label: 'Raw captured fields',
            line: index,
            value: source,
          }
        : undefined,
    detail: (index) =>
      index === rawLine
        ? (rawDocument ??= createJsonDocument(
            `${id}:raw`,
            'Raw captured fields',
            source,
          ))
        : undefined,
  })
  if (block.type === 'doctor') document.diagnostics = block.diagnostics
  return document
}

// Object identity follows retained message data across windowing. Weak keys
// release documents with their source; projections are created only on Inspect.
const documents = new WeakMap<object, Map<string, OutputDocument>>()
let nextIdentity = 0

export function capturedDiagnosticDocument(
  kind: string,
  title: string,
  source: object,
): OutputDocument {
  let byKind = documents.get(source)
  if (!byKind) {
    byKind = new Map()
    documents.set(source, byKind)
  }
  let document = byKind.get(kind)
  if (!document) {
    const id = `${kind}:${++nextIdentity}`
    document =
      createCommandDiagnosticDocument(id, title, source) ??
      createJsonDocument(id, title, source)
    byKind.set(kind, document)
  }
  return document
}
