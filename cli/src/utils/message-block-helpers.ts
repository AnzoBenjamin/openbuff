import { sanitizeMediaForUiState } from './payload-sanitizer'

import type {
  ContentBlock,
  AgentContentBlock,
  AskUserContentBlock,
  GateStateContentBlock,
  GateStateStatus,
  ToolContentBlock,
  PlanArtifactMetadata,
} from '../types/chat'

/**
 * Extracts the base agent name from a potentially scoped/versioned agent type string.
 *
 * @example
 * getAgentBaseName('openbuff/file-picker@0.0.2') // 'file-picker'
 * getAgentBaseName('file-picker@1.0.0') // 'file-picker'
 * getAgentBaseName('file-picker') // 'file-picker'
 * getAgentBaseName('file_picker') // 'file-picker'
 */
export const getAgentBaseName = (type: string): string => {
  const segment = type.split('/').pop() ?? type
  return segment.split('@')[0].replace(/_/g, '-')
}

const GATE_STATE_BLOCK_RE = /<gate-state>\s*([\s\S]*?)\s*<\/gate-state>/i

const SCRUB_GATE_STATE_TAGS_RE = new RegExp(GATE_STATE_BLOCK_RE.source, 'gi')

const GATE_STATE_STATUSES: ReadonlySet<GateStateStatus> =
  new Set<GateStateStatus>(['pending', 'passed', 'failed', 'skipped'])

/**
 * Parse the inner text of a gate-state block as a JSON object. Returns null
 * when the text is not valid JSON or is not a plain object, so callers can
 * fall back to the legacy `key: value` line form.
 */
const tryParseJsonObject = (text: string): UnknownRecord | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecordValue(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Normalize reviewer-authored gate-state text. Order matters: collapse
 * whitespace FIRST so tabs/newlines become spaces, then strip the remaining
 * C0/DEL control bytes. The text flows verbatim into the opentui `<text>`
 * renderer, so a surviving ESC could corrupt or spoof terminal output.
 */
const sanitizeGateStateText = (value: string): string =>
  value
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()

/**
 * Producer bounds mirrored from base2's `formatGateStateBlock`, which caps the
 * emitted advisory list at 8 entries and each entry at 240 characters. The
 * parser reads arbitrary assistant text, so it enforces the same bounds: a
 * non-base2 or malformed `<gate-state>` payload cannot render an unbounded
 * advisory list in the CLI.
 */
const MAX_GATE_STATE_ADVISORIES = 8
const MAX_GATE_STATE_ADVISORY_LENGTH = 240
/**
 * Mirrors base2's `boundWorkflowProgress`, which caps the emitted
 * `nextWorkflowAction` at 240 characters. Same reason as the advisory bounds:
 * this parser also reads hand-authored/non-base2 assistant text, so it enforces
 * the producer's cap itself instead of trusting the payload.
 */
const MAX_GATE_STATE_WORKFLOW_ACTION_LENGTH = 240

/**
 * Accept advisories only when they are an array of non-empty strings within the
 * producer's bounds. Anything else (not an array, empty entries, mixed types,
 * more than MAX_GATE_STATE_ADVISORIES entries, or an entry longer than
 * MAX_GATE_STATE_ADVISORY_LENGTH) is dropped whole so the renderer never
 * receives malformed or unbounded data.
 *
 * Each entry is sanitized BEFORE the non-empty and length checks, so an entry
 * made only of control characters becomes empty and drops the whole list under
 * the existing strictness rule.
 */
const parseGateStateAdvisories = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_GATE_STATE_ADVISORIES) return []
  const advisories = value.map((entry) =>
    typeof entry === 'string' ? sanitizeGateStateText(entry) : '',
  )
  return advisories.every(
    (entry) =>
      entry.length > 0 && entry.length <= MAX_GATE_STATE_ADVISORY_LENGTH,
  )
    ? advisories
    : []
}

/**
 * Accept declared-workflow progress only when the producer's contract holds:
 * a record whose `completedCount`/`totalCount` are finite non-negative integers
 * (`Number.isInteger` already rejects NaN/Infinity/floats) with
 * `totalCount > 0` and `completedCount < totalCount` — work must actually
 * remain — and whose `nextWorkflowAction` is a non-empty string within
 * MAX_GATE_STATE_WORKFLOW_ACTION_LENGTH characters AFTER sanitization.
 *
 * Anything else drops the field WHOLE, fail-closed exactly like
 * `parseGateStateAdvisories`: a partial or zeroed object would render nonsense
 * progress math, and admitting `completedCount === totalCount` would report a
 * finished workflow as incomplete on every clean turn — the false signal this
 * field exists to avoid.
 *
 * The action is sanitized BEFORE the non-empty and length checks (whitespace
 * collapsed first, then C0/DEL stripped), so a hand-authored payload cannot
 * smuggle ANSI escapes into the opentui `<text>` renderer, and an action made
 * only of control characters becomes empty and drops the field.
 */
const parseGateStateWorkflow = (
  value: unknown,
): GateStateContentBlock['workflow'] => {
  if (!isRecordValue(value)) return undefined
  const { completedCount, totalCount } = value
  if (
    typeof completedCount !== 'number' ||
    typeof totalCount !== 'number' ||
    !Number.isInteger(completedCount) ||
    !Number.isInteger(totalCount) ||
    completedCount < 0 ||
    totalCount <= 0 ||
    completedCount >= totalCount
  ) {
    return undefined
  }
  if (typeof value.nextWorkflowAction !== 'string') return undefined
  const nextWorkflowAction = sanitizeGateStateText(value.nextWorkflowAction)
  if (
    nextWorkflowAction.length === 0 ||
    nextWorkflowAction.length > MAX_GATE_STATE_WORKFLOW_ACTION_LENGTH
  ) {
    return undefined
  }
  return { completedCount, totalCount, nextWorkflowAction }
}

/**
 * Build a gate-state block from an already-parsed JSON payload whose `gate` is
 * a non-empty string. Returns null when the status is not one of the pinned
 * statuses, keeping the JSON form exactly as strict as the line form.
 */
const buildGateStateFromJson = (
  payload: UnknownRecord,
  gate: string,
): GateStateContentBlock | null => {
  const status =
    typeof payload.status === 'string'
      ? (payload.status.trim().toLowerCase() as GateStateStatus)
      : undefined
  if (!status || !GATE_STATE_STATUSES.has(status)) return null

  const details =
    typeof payload.details === 'string'
      ? sanitizeGateStateText(payload.details)
      : ''
  const origin = typeof payload.origin === 'string' ? sanitizeGateStateText(payload.origin) : ''
  const advisories = parseGateStateAdvisories(payload.advisories)
  const workflow = parseGateStateWorkflow(payload.workflow)

  return {
    type: 'gate-state',
    gate,
    gateStatus: status,
    ...(details ? { details } : {}),
    ...(advisories.length > 0 ? { advisories } : {}),
    ...(workflow ? { workflow } : {}),
    origin: origin || 'Base2',
  }
}

/**
 * Parse the pinned Base2 gate-state shape from a message buffer.
 *
 * PUBLISHED BLOCK SCHEMA (canonical parse contract for downstream consumers;
 * this docblock and `GateStateContentBlock` in cli/src/types/chat.ts are the
 * published enumeration, and both must list every key the producer emits):
 * - `gate` (string, required)
 * - `status` (required): pending | passed | failed | skipped
 * - `details` (string, optional)
 * - `origin` (string, optional; defaults to "Base2")
 * - `advisories` (string[], optional; non-blocking reviewer observations)
 * - `workflow` (object, optional; declared write_todos progress on a PASSING
 *   gate, as `{ completedCount, totalCount, nextWorkflowAction }`)
 * Producers may also emit `repairRound`/`maxRepairRounds`, which this parser
 * ignores. Every optional key is additive: a block persisted before a key
 * existed replays unchanged.
 *
 * Base2 emits a JSON payload, which is tried first:
 *
 *   <gate-state>{"gate":"validation/reviewer","status":"passed",
 *   "details":"...","origin":"Base2","advisories":["..."],
 *   "workflow":{"completedCount":1,"totalCount":3,
 *   "nextWorkflowAction":"..."}}</gate-state>
 *
 * The legacy line form remains supported (case-insensitive on keys/status,
 * narrow on purpose):
 *
 *   <gate-state>
 *   gate: <name>
 *   status: pending | passed | failed | skipped
 *   details: <optional free text>
 *   origin: <optional label, default "Base2">
 *   </gate-state>
 *
 * Returns null if the buffer does not contain a well-formed gate-state
 * block. If multiple gate-state blocks are present, only the first is parsed.
 * The parser is intentionally strict so ordinary prose mentioning "gate" or
 * "status" never produces a false positive.
 *
 * Delimiter contract: the producer escapes `</` as `<\/` (a legal JSON string
 * escape) before emitting the block, so reviewer-authored `details`/`advisories`
 * text containing a literal `</gate-state>` cannot terminate the block early and
 * JSON.parse restores it byte-for-byte here. This parser deliberately does NOT
 * retry longer matches for an unescaped delimiter: such a payload stays unparsed
 * (fail closed) rather than weakening the strictness above.
 *
 * Parse/render contract (pinned in
 * cli/src/utils/__tests__/message-block-helpers.test.ts):
 * - Both pre-existing forms keep their exact behavior: the legacy `key: value`
 *   line form and the JSON payload form agree on gate/status/details/origin.
 * - `advisories` is a JSON-payload-only field. The line form never carried it,
 *   so an `advisories:` line stays an unrecognized key and yields no advisories.
 * - `workflow` (declared write_todos progress on a PASSING gate) is likewise
 *   JSON-payload-only, and is admitted only within the producer's bounds: a
 *   240-char sanitized `nextWorkflowAction` plus finite non-negative integer
 *   counts with `totalCount > 0` and `completedCount < totalCount`. A violating
 *   payload drops the field whole rather than rendering partial progress math.
 * - Advisories are admitted only within the producer's bounds
 *   (MAX_GATE_STATE_ADVISORIES entries, MAX_GATE_STATE_ADVISORY_LENGTH chars per
 *   entry); an out-of-bounds or otherwise malformed list is dropped whole and
 *   never widens the rendered output.
 * - JSON-payload `details` and every advisory are sanitized (whitespace
 *   collapsed, then C0/DEL control bytes stripped) BEFORE those bounds checks,
 *   so a hand-authored payload carrying ANSI escapes cannot bypass the
 *   producer, and an advisory made only of control characters becomes empty and
 *   drops the whole list.
 */
export const parseGateStateBlock = (
  buffer: string,
): GateStateContentBlock | null => {
  const match = buffer.match(GATE_STATE_BLOCK_RE)
  if (!match) return null

  const inner = match[1].trim()
  const payload = tryParseJsonObject(inner)
  const jsonGate = typeof payload?.gate === 'string' ? payload.gate.trim() : ''
  if (payload && jsonGate) {
    return buildGateStateFromJson(payload, jsonGate)
  }

  const fields: Record<string, string> = {}
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (!value) continue
    fields[key] = value
  }

  const gate = fields.gate
  const statusRaw = fields.status?.toLowerCase() as GateStateStatus | undefined
  if (!gate || !statusRaw || !GATE_STATE_STATUSES.has(statusRaw)) {
    return null
  }

  return {
    type: 'gate-state',
    gate,
    gateStatus: statusRaw,
    ...(fields.details ? { details: sanitizeGateStateText(fields.details) } : {}),
    origin: (fields.origin ? sanitizeGateStateText(fields.origin) : '') || 'Base2',
  }
}

/**
 * Strip any <gate-state>...</gate-state> blocks from a buffer. Used when
 * promoting a parsed gate-state into a dedicated UI block so the raw block
 * does not also render as prose.
 */
export const scrubGateStateTags = (s: string): string =>
  s
    .replace(SCRUB_GATE_STATE_TAGS_RE, '')
    .replace(/\n{3,}/g, '\n\n')

/**
 * Extracts plan content from a buffer containing <PLAN>...</PLAN> tags.
 * Returns the trimmed content between tags, or null if not found.
 */
export const extractPlanFromBuffer = (buffer: string): string | null => {
  const openIdx = buffer.indexOf('<PLAN>')
  const closeIdx = buffer.indexOf('</PLAN>')
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    return buffer.slice(openIdx + '<PLAN>'.length, closeIdx).trim()
  }
  return null
}

const SCRUB_PLAN_COMPLETE_RE = /<PLAN>[\s\S]*?(?:<\/PLAN>|<\/cb_plan>)/g
const SCRUB_PLAN_OPEN_RE = /<PLAN>[\s\S]*$/g

export const scrubPlanTags = (s: string): string =>
  s.replace(SCRUB_PLAN_COMPLETE_RE, '').replace(SCRUB_PLAN_OPEN_RE, '')

export const scrubPlanTagsInBlocks = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  return blocks
    .map((block) => {
      if (block.type !== 'text') {
        return block
      }
      const newContent = scrubPlanTags(block.content)
      if (newContent === block.content) return block
      return { ...block, content: newContent }
    })
    .filter((block) => block.type !== 'text' || block.content.trim() !== '')
}

type StringArtifactKey =
  | 'sessionPath'
  | 'specPath'
  | 'planPath'
  | 'statusPath'
  | 'lessonsPath'

const PLAN_METADATA_LABELS: Record<string, StringArtifactKey> = {
  session: 'sessionPath',
  'session path': 'sessionPath',
  'session directory': 'sessionPath',
  'session dir': 'sessionPath',
  'spec.md': 'specPath',
  spec: 'specPath',
  'plan.md': 'planPath',
  plan: 'planPath',
  'status.md': 'statusPath',
  status: 'statusPath',
  'lessons.md': 'lessonsPath',
  lessons: 'lessonsPath',
}

const PLAN_ARTIFACT_FILENAMES: Array<{
  suffix: string
  key: StringArtifactKey
}> = [
  { suffix: '/SPEC.md', key: 'specPath' },
  { suffix: '/PLAN.md', key: 'planPath' },
  { suffix: '/STATUS.md', key: 'statusPath' },
  { suffix: '/LESSONS.md', key: 'lessonsPath' },
]

const normalizePlanMetadataLabel = (label: string): string =>
  label
    .replace(/[*_`]/g, '')
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()

/**
 * Strip markdown formatting marks (`*_`) and leading `#`/whitespace from a
 * label while preserving its original casing. Used for custom artifact
 * display labels, which may be arbitrary user-authored strings.
 */
const stripPlanMetadataLabelFormatting = (label: string): string =>
  label
    .replace(/[*_`]/g, '')
    .replace(/^#+\s*/, '')
    .trim()

/**
 * Returns true when a metadata value looks like a path worth capturing as a
 * custom artifact — it contains at least one path separator or ends with
 * `.md`. Values that read as prose (spaces but no separators) are rejected.
 */
const isCustomArtifactPathValue = (value: string): boolean =>
  value.includes('/') || value.endsWith('.md')

const normalizePlanMetadataPath = (value: string): string => {
  const withoutMarkdownLink = value.match(/\(([^)]+)\)/)?.[1] ?? value
  return withoutMarkdownLink
    .replace(/[`*_]/g, '')
    .replace(/[.,;]+$/g, '')
    .trim()
}

const isNonEmptyPlanMetadata = (
  metadata: PlanArtifactMetadata,
): metadata is PlanArtifactMetadata =>
  Object.values(metadata).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  )

const getPlanSessionCommandTarget = (
  metadata: PlanArtifactMetadata,
): string | undefined => {
  const explicitSession = metadata.sessionPath
  if (explicitSession) return explicitSession

  const artifactPath =
    metadata.planPath ??
    metadata.statusPath ??
    metadata.specPath ??
    metadata.lessonsPath
  return (
    artifactPath?.match(/^(\.agents\/sessions\/[^/]+)/)?.[1] ?? artifactPath
  )
}

const getCustomArtifactCommand = (path: string): string =>
  path.endsWith('.md') ? `Read ${path}` : `Open ${path}`

const withPlanCommands = (
  metadata: PlanArtifactMetadata,
): PlanArtifactMetadata => {
  const commandTarget = getPlanSessionCommandTarget(metadata)
  const customArtifactCommands = metadata.customArtifacts?.length
    ? metadata.customArtifacts.map(({ path }) => getCustomArtifactCommand(path))
    : undefined

  if (!commandTarget) {
    if (!customArtifactCommands) {
      return metadata
    }
    return { ...metadata, customArtifactCommands }
  }

  return {
    ...metadata,
    executeCommand: '/mode:execute_plan Build it!',
    resumeCommand: `/resume-plan ${commandTarget}`,
    updateCommand: `/update-plan ${commandTarget}`,
    statusCommand: `/plan-status ${commandTarget}`,
    lessonsCommand: `/lessons ${commandTarget}`,
    ...(customArtifactCommands ? { customArtifactCommands } : {}),
  }
}

export const extractPlanMetadata = (
  planContent: string,
): PlanArtifactMetadata | undefined => {
  const metadata: PlanArtifactMetadata = {}

  for (const rawLine of planContent.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const bulletMatch = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)?([^:]+):\s*(.+)$/)
    if (bulletMatch) {
      const label = normalizePlanMetadataLabel(bulletMatch[1])
      const key = PLAN_METADATA_LABELS[label]
      if (key) {
        metadata[key] = normalizePlanMetadataPath(bulletMatch[2])
        continue
      }

      // Unrecognized `Label: value` bullet. Capture it as a custom artifact
      // only when the value looks path-like (contains `/` or ends with
      // `.md`). Prose like `Note: this is important` is skipped because it
      // has spaces but no path separators.
      const rawValue = bulletMatch[2]
      const normalizedValue = normalizePlanMetadataPath(rawValue)
      if (isCustomArtifactPathValue(normalizedValue)) {
        const customLabel = stripPlanMetadataLabelFormatting(bulletMatch[1])
        if (customLabel) {
          if (!metadata.customArtifacts) {
            metadata.customArtifacts = []
          }
          metadata.customArtifacts.push({ label: customLabel, path: normalizedValue })
        }
      }
      continue
    }

    const pathMatch = line.match(/(`?\.agents\/sessions\/[^`\s)]+`?)/)
    if (!pathMatch) continue

    const path = normalizePlanMetadataPath(pathMatch[1])
    if (!metadata.sessionPath) {
      const sessionMatch = path.match(/^(\.agents\/sessions\/[^/]+)/)
      metadata.sessionPath = sessionMatch?.[1] ?? path
    }

    for (const artifact of PLAN_ARTIFACT_FILENAMES) {
      if (path.endsWith(artifact.suffix)) {
        metadata[artifact.key] = path
      }
    }
  }

  return isNonEmptyPlanMetadata(metadata)
    ? withPlanCommands(metadata)
    : undefined
}

export const insertPlanBlock = (
  blocks: ContentBlock[],
  planContent: string,
): ContentBlock[] => {
  const cleanedBlocks = scrubPlanTagsInBlocks(blocks)
  const metadata = extractPlanMetadata(planContent)
  return [
    ...cleanedBlocks,
    {
      type: 'plan',
      content: planContent,
      ...(metadata ? { metadata } : {}),
    },
  ]
}

const MAX_AUTO_COLLAPSE_DEPTH = 20

// Structural rewrites (tempId->realId migration, nesting, extraction) must
// reach their target at any depth: silently skipping them would strand a
// spawn-agent block in its temp-id state, so later events matched by the
// real id never find it and there is no signal that anything went wrong.
// This cap only guards against pathological recursion (for example a cyclic
// block graph) and sits far above any legitimate agent nesting depth —
// unlike MAX_AUTO_COLLAPSE_DEPTH, which bounds render-time collapse work
// where skipping a deeper block is benign.
const MAX_BLOCK_UPDATE_DEPTH = 200

/**
 * Recursively collapses blocks that weren't manually opened by the user.
 * Preserves user intent by keeping blocks open if userOpened is true.
 *
 * Agent blocks only auto-collapse once their run has reached a terminal
 * status ('complete' | 'partial' | 'failed' | 'cancelled'; an absent status
 * is treated as terminal for legacy/persisted blocks). A still-'running'
 * agent block is left untouched so its live output stays visible. Nested
 * agent blocks follow the same terminal-status rule through the recursion.
 */
export const autoCollapseBlocks = (blocks: ContentBlock[], _depth = 0): ContentBlock[] => {
  let result: ContentBlock[] | null = null

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let newBlock: ContentBlock

    // Handle thinking blocks (grouped text blocks)
    if (block.type === 'text' && block.thinkingId) {
      newBlock = block.userOpened
        ? block
        : { ...block, thinkingCollapseState: 'hidden' as const }
    } else if (block.type === 'agent') {
      // Handle agent blocks: collapse only terminal (non-running) blocks the
      // user has not explicitly opened; running agents stay visible.
      const isTerminal = block.status !== 'running'
      let updatedBlock: typeof block =
        isTerminal && !block.userOpened
          ? { ...block, isCollapsed: true }
          : block

      // Recursively update nested blocks
      if (updatedBlock.blocks && _depth < MAX_AUTO_COLLAPSE_DEPTH) {
        const newBlocks = autoCollapseBlocks(updatedBlock.blocks, _depth + 1)
        if (newBlocks !== updatedBlock.blocks) {
          updatedBlock = { ...updatedBlock, blocks: newBlocks }
        }
      }
      newBlock = updatedBlock
    } else if (block.type === 'tool') {
      // Handle tool blocks
      newBlock = block.userOpened ? block : { ...block, isCollapsed: true }
    } else if (block.type === 'agent-list') {
      // Handle agent-list blocks
      newBlock = block.userOpened ? block : { ...block, isCollapsed: true }
    } else {
      newBlock = block
    }

    if (newBlock !== block) {
      if (result === null) {
        result = blocks.slice(0, i)
      }
      result.push(newBlock)
    } else if (result !== null) {
      result.push(block)
    }
  }

  return result ?? blocks
}

/**
 * Result of extracting content from a spawn_agents result value.
 */
export interface SpawnAgentResultContent {
  content: string
  hasError: boolean
}

type UnknownRecord = Record<string, unknown>

const isRecordValue = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getStringField = (
  obj: UnknownRecord,
  field: string,
): string | undefined =>
  typeof obj[field] === 'string' ? obj[field] : undefined

const formatBrowserUseStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  if (value.outputKind !== 'browser-use') {
    return undefined
  }

  const status = getStringField(value, 'overallStatus')
  const summary = getStringField(value, 'summary')
  const results = Array.isArray(value.results) ? value.results : undefined

  if (!status || !summary || !results) {
    return undefined
  }

  const lines = [`Browser test ${status}: ${summary}`]

  const finalUrl = getStringField(value, 'finalUrl')
  const finalPageTitle = getStringField(value, 'finalPageTitle')
  if (finalUrl || finalPageTitle) {
    const finalState = [finalPageTitle, finalUrl].filter(Boolean).join(' — ')
    lines.push('', `Final: ${finalState}`)
  }

  if (results.length > 0) {
    lines.push('', 'Results:')
    for (const item of results) {
      if (!isRecordValue(item)) continue
      const name = getStringField(item, 'name') ?? 'Unnamed step'
      const passed = item.passed === false ? '✗' : '✓'
      const details = getStringField(item, 'details')
      const url = getStringField(item, 'url')
      const mediaFlags = [
        item.screenshotAttached === true ? 'screenshot attached' : undefined,
        item.pdfAttached === true ? 'PDF generated' : undefined,
        item.recordingAttached === true ? 'recording attached' : undefined,
      ].filter(Boolean)
      const suffixParts = [url, ...mediaFlags]
      const suffix =
        suffixParts.length > 0 ? ` (${suffixParts.join('; ')})` : ''
      lines.push(
        `- ${passed} ${name}${suffix}${details ? ` — ${details}` : ''}`,
      )
    }
  }

  const consoleErrors = Array.isArray(value.consoleErrors)
    ? value.consoleErrors
    : []
  if (consoleErrors.length > 0) {
    lines.push('', 'Console/runtime issues:')
    for (const item of consoleErrors) {
      if (!isRecordValue(item)) continue
      const message = getStringField(item, 'message')
      const url = getStringField(item, 'url')
      if (message) lines.push(`- ${message}${url ? ` (${url})` : ''}`)
    }
  }

  const lessons = Array.isArray(value.lessons) ? value.lessons : []
  if (lessons.length > 0) {
    lines.push('', 'Notes:')
    for (const lesson of lessons) {
      if (typeof lesson === 'string' && lesson.trim()) {
        lines.push(`- ${lesson}`)
      }
    }
  }

  return lines.join('\n')
}

const formatExternalCliStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  if (value.outputKind !== 'external-cli') return undefined
  const status = getStringField(value, 'overallStatus')
  const summary = getStringField(value, 'summary')
  const permissionProfile = getStringField(value, 'permissionProfile')
  if (!status || !summary || !permissionProfile) return undefined

  const lines = [
    `External CLI ${status}: ${summary}`,
    `Permission profile: ${permissionProfile}`,
  ]
  const results = Array.isArray(value.results) ? value.results : []
  if (results.length > 0) {
    lines.push('', 'Results:')
    for (const item of results) {
      if (!isRecordValue(item)) continue
      const name = getStringField(item, 'name') ?? 'Unnamed step'
      const details = getStringField(item, 'details')
      lines.push(
        `- ${item.passed === false ? '✗' : '✓'} ${name}${details ? ` — ${details}` : ''}`,
      )
    }
  }
  return lines.join('\n')
}

const formatResearcherWebStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const data = isRecordValue(value.data) ? value.data : value
  const questions = Array.isArray(data.questions) ? data.questions : undefined
  const sources = Array.isArray(data.sources) ? data.sources : []
  if (!questions) return undefined
  const lines = ['Web research:']
  for (const item of questions) {
    if (!isRecordValue(item)) continue
    const question = getStringField(item, 'question') ?? 'Question'
    const status = getStringField(item, 'status') ?? 'unknown'
    const answer = getStringField(item, 'answer') ?? ''
    lines.push(`- ${question} [${status}]${answer ? ` — ${answer}` : ''}`)
    const citations = Array.isArray(item.citations) ? item.citations : []
    for (const citation of citations) {
      if (typeof citation === 'string') lines.push(`  Source: ${citation}`)
    }
  }
  if (sources.length > 0) {
    lines.push('', 'Sources:')
    for (const source of sources) {
      if (!isRecordValue(source)) continue
      const url = getStringField(source, 'url')
      const title = getStringField(source, 'title')
      if (url) lines.push(`- ${title || url}: ${url}`)
    }
  }
  return lines.join('\n')
}

const formatResearcherDocsStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const status = getStringField(value, 'status')
  const answer = getStringField(value, 'answer')
  const source = getStringField(value, 'source')
  const version = getStringField(value, 'version')
  if (!status || answer === undefined || !source || !version) return undefined
  const lines = [
    `Documentation research ${status}: ${source} (${version})`,
    answer,
  ]
  const failure = getStringField(value, 'failure')
  if (failure) lines.push('', `Limitation: ${failure}`)
  return lines.join('\n')
}

/**
 * Returns the text of a message content field only when it is text-only:
 * either a plain string, or an array whose every part is a text part with a
 * string `text`. Returns undefined for any other shape (missing content,
 * non-text parts) so callers can treat the entry as "not displayable text".
 */
const getTextOnlyMessageContent = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (
      !isRecordValue(part) ||
      part.type !== 'text' ||
      typeof part.text !== 'string'
    ) {
      return undefined
    }
    parts.push(part.text)
  }
  return parts.join('')
}

// Display bounds for the reviewer structured-output formatter, mirroring the
// siblings in the same dispatch chain (formatEditorNestedOutput's DISPLAY_CAP
// and cappedJsonStringify's STRINGIFY_CAP, both 4000): a spawn result with
// very large reviewedFiles/findings/advisories arrays must not allocate an
// unbounded display string on the render path.
const REVIEWER_DISPLAY_CAP = 4000
const REVIEWER_CONTENT_CAP = 3800

/**
 * Formats a reviewer/advisory agent's structured output as plain-text lines.
 * Returns undefined when the value is not reviewer-shaped (no reviewer/
 * advisory family and no verdict) or carries none of the structured
 * sections, so the caller can fall through to the next formatter.
 *
 * Output is capped like its siblings: lines stop being pushed once the
 * accumulated total passes REVIEWER_DISPLAY_CAP, so peak allocation on the
 * render path stays proportional to the cap rather than to the payload size.
 * The `totalChars > 0` guard lets the very first line through even when it
 * alone exceeds the cap (so a single oversized field cannot blank the block),
 * and the final slice below bounds that case, reusing the shared
 * '…[truncated]' token.
 */
const formatReviewerStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const family = getStringField(value, 'family')
  const verdict = getStringField(value, 'verdict')
  const isReviewerShaped =
    family === 'reviewer' || family === 'advisory' || verdict !== undefined
  if (!isReviewerShaped) return undefined

  const hasStructuredSections =
    value.reviewedFiles !== undefined ||
    value.dimensions !== undefined ||
    value.findings !== undefined ||
    value.requirementCoverage !== undefined
  if (verdict === undefined && !hasStructuredSections) return undefined

  const lines: string[] = []
  let totalChars = 0
  let truncated = false
  const pushCappedLine = (line: string): boolean => {
    if (totalChars > 0 && totalChars + line.length + 1 > REVIEWER_DISPLAY_CAP) {
      truncated = true
      return false
    }
    lines.push(line)
    totalChars += line.length + 1
    return true
  }

  if (family === 'advisory') {
    pushCappedLine('Advisory review')
  } else if (verdict !== undefined) {
    pushCappedLine(`Verdict: ${verdict}`)
  }

  const reviewedFiles = Array.isArray(value.reviewedFiles)
    ? value.reviewedFiles.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  if (reviewedFiles.length > 0 && pushCappedLine('Reviewed files:')) {
    for (const file of reviewedFiles) {
      if (truncated) break
      if (!pushCappedLine(`- ${file}`)) break
    }
  }

  const dimensions = isRecordValue(value.dimensions) ? value.dimensions : {}
  for (const [key, dimensionValue] of Object.entries(dimensions)) {
    if (truncated) break
    if (typeof dimensionValue === 'string') {
      if (!pushCappedLine(`- ${key}: ${dimensionValue}`)) break
    }
  }

  const findings = Array.isArray(value.findings) ? value.findings : []
  for (const finding of findings) {
    if (truncated) break
    if (typeof finding === 'string') {
      if (!pushCappedLine(`- ${finding}`)) break
      continue
    }
    if (!isRecordValue(finding)) continue
    const summary = getStringField(finding, 'summary')
    if (summary === undefined) continue
    const severity = getStringField(finding, 'severity')
    if (!pushCappedLine(`- ${severity ? `[${severity}] ` : ''}${summary}`)) {
      break
    }
    const correction = getStringField(finding, 'correction')
    if (correction !== undefined && !pushCappedLine(`  Fix: ${correction}`)) {
      break
    }
  }

  const requirementCoverage = Array.isArray(value.requirementCoverage)
    ? value.requirementCoverage
    : []
  for (const item of requirementCoverage) {
    if (truncated) break
    if (!isRecordValue(item)) continue
    const requirement = getStringField(item, 'requirement')
    const status = getStringField(item, 'status')
    if (requirement === undefined || status === undefined) continue
    if (!pushCappedLine(`- ${status}: ${requirement}`)) break
  }

  const advisories = Array.isArray(value.advisories)
    ? value.advisories.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  if (
    advisories.length > 0 &&
    pushCappedLine('') &&
    pushCappedLine('Advisories:')
  ) {
    for (const advisory of advisories) {
      if (truncated) break
      if (!pushCappedLine(`- ${advisory}`)) break
    }
  }

  const output = lines.join('\n')
  if (output.length > REVIEWER_DISPLAY_CAP) {
    return `${output.slice(0, REVIEWER_CONTENT_CAP)}\n…[truncated]`
  }
  return truncated ? `${output}\n…[truncated]` : output
}

const formatFilePickerStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  if (!Array.isArray(value.files)) return undefined
  const files = value.files
  // Validate at least the first item has path/summary string fields before committing
  if (files.length > 0) {
    const first = files[0]
    if (
      !isRecordValue(first) ||
      typeof first.path !== 'string' ||
      typeof first.summary !== 'string'
    ) {
      return undefined
    }
  }
  if (files.length === 0) return 'No files found.'
  const lines = [`Files found (${files.length}):`]
  for (const item of files) {
    if (!isRecordValue(item)) continue
    const path = getStringField(item, 'path')
    const summary = getStringField(item, 'summary')
    if (path !== undefined && summary !== undefined) {
      lines.push(`- ${path} — ${summary}`)
    }
  }
  return lines.join('\n')
}

const formatBasherStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const command = getStringField(value, 'command')
  if (command === undefined) return undefined
  const hasStdout = typeof value.stdout === 'string'
  const hasExitCode = typeof value.exitCode === 'number'
  // Require BOTH command AND (exitCode or stdout) to avoid false-positives on
  // unrelated records that happen to have a command field.
  if (!hasStdout && !hasExitCode) return undefined

  const STDOUT_CAP = 2000
  const STDERR_CAP = 500

  const lines: string[] = [`$ ${command}`]

  if (hasExitCode) {
    lines.push(`exitCode: ${value.exitCode}`)
  }

  const stdout = getStringField(value, 'stdout')
  if (stdout && stdout.trim()) {
    lines.push('')
    lines.push(
      stdout.length > STDOUT_CAP
        ? stdout.slice(0, STDOUT_CAP) + '…[truncated]'
        : stdout,
    )
  }

  const stderr = getStringField(value, 'stderr')
  if (stderr && stderr.trim() && stderr !== stdout) {
    const capped =
      stderr.length > STDERR_CAP
        ? stderr.slice(0, STDERR_CAP) + '…[truncated]'
        : stderr
    lines.push(`stderr: ${capped}`)
  }

  return lines.join('\n')
}

const formatGeneralAgentReceiptStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const status = getStringField(value, 'status')
  if (status === undefined) return undefined
  if (!Array.isArray(value.changedFiles)) return undefined
  // Defer to formatEditorNestedOutput when value.output carries a message transcript.
  const outputRecord = isRecordValue(value.output) ? value.output : undefined
  if (outputRecord && Array.isArray(outputRecord.messages)) return undefined

  const lines: string[] = [`Status: ${status}`]

  const changedFiles = value.changedFiles.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  if (changedFiles.length > 0) {
    lines.push('Changed files:')
    for (const file of changedFiles) lines.push(`- ${file}`)
  }

  const requirementsAddressed = Array.isArray(value.requirementsAddressed)
    ? value.requirementsAddressed.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  if (requirementsAddressed.length > 0) {
    lines.push(`Requirements addressed: ${requirementsAddressed.join(', ')}`)
  }

  const unresolved = Array.isArray(value.unresolved)
    ? value.unresolved.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  if (unresolved.length > 0) {
    lines.push(`Unresolved: ${unresolved.join(', ')}`)
  }

  return lines.join('\n')
}

const formatGeneralAgentSummaryStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  // Defer to formatReviewerStructuredOutput: reviewer/advisory shapes have a family field.
  if (typeof value.family === 'string') return undefined
  // Defer to formatGeneralAgentReceiptStructuredOutput: receipt shape has changedFiles.
  if (Array.isArray(value.changedFiles)) return undefined
  // Defer to formatFilePickerStructuredOutput: file-picker shape has files.
  if (Array.isArray(value.files)) return undefined
  // Defer to formatBrowserUseStructuredOutput: browser-use output has outputKind = 'browser-use'.
  if (value.outputKind === 'browser-use') return undefined
  // Defer to formatExternalCliStructuredOutput: external CLI output has outputKind = 'external-cli'.
  if (value.outputKind === 'external-cli') return undefined
  // Defer to JSON fallback: overallStatus signals a structured results payload (reviewer, agent
  // status) that either has its own formatter or should render as JSON — not a bare summary string.
  if (typeof value.overallStatus === 'string') return undefined

  const summary = getStringField(value, 'summary')
  if (summary === undefined) return undefined

  const SUMMARY_CAP = 4000
  const cappedSummary =
    summary.length > SUMMARY_CAP
      ? summary.slice(0, SUMMARY_CAP) + '\u2026[truncated]'
      : summary

  const lines: string[] = [cappedSummary]

  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter((e): e is string => typeof e === 'string')
    : []
  if (artifacts.length > 0) {
    lines.push(`[Artifacts: ${artifacts.join(', ')}]`)
  }

  const coveredSubsystems = Array.isArray(value.coveredSubsystems)
    ? value.coveredSubsystems.filter((e): e is string => typeof e === 'string')
    : []
  if (coveredSubsystems.length > 0) {
    lines.push(`[Systems: ${coveredSubsystems.join(', ')}]`)
  }

  const coveredFeatures = Array.isArray(value.coveredFeatures)
    ? value.coveredFeatures.filter((e): e is string => typeof e === 'string')
    : []
  if (coveredFeatures.length > 0) {
    lines.push(`[Features: ${coveredFeatures.join(', ')}]`)
  }

  const unresolved = Array.isArray(value.unresolved)
    ? value.unresolved.filter((e): e is string => typeof e === 'string')
    : []
  if (unresolved.length > 0) {
    lines.push(`[Unresolved: ${unresolved.join(', ')}]`)
  }

  return lines.join('\n')
}

const formatLibrarianStructuredOutput = (
  value: UnknownRecord,
): string | undefined => {
  const status = getStringField(value, 'status')
  const answer = getStringField(value, 'answer')
  if (status === undefined || answer === undefined) return undefined
  if (!Array.isArray(value.relevantFiles)) return undefined

  const ANSWER_CAP = 3000
  const cappedAnswer =
    answer.length > ANSWER_CAP
      ? answer.slice(0, ANSWER_CAP) + '\u2026[truncated]'
      : answer

  const lines: string[] = [`Status: ${status}`, cappedAnswer]

  const relevantFiles = value.relevantFiles.filter(
    (e): e is string => typeof e === 'string',
  )
  if (relevantFiles.length > 0) {
    lines.push('', `Relevant files (${relevantFiles.length}):`)
    for (const file of relevantFiles) {
      lines.push(`- ${file}`)
    }
  }

  const error = getStringField(value, 'error')
  if (error) {
    lines.push(`Error: ${error}`)
  }

  return lines.join('\n')
}

/**
 * Formats an editor agent's nested structured output (a value whose `output`
 * carries the agent's message transcript) as plain-text lines. Returns
 * undefined when the value is not editor-shaped so the caller can fall
 * through to the next formatter.
 */
const formatEditorNestedOutput = (
  value: UnknownRecord,
): string | undefined => {
  const output = isRecordValue(value.output) ? value.output : undefined
  if (!output || !Array.isArray(output.messages)) return undefined

  const lines: string[] = []
  const status = getStringField(value, 'status')
  if (status !== undefined) {
    lines.push(`Status: ${status}`)
  }

  const changedFiles = Array.isArray(value.changedFiles)
    ? value.changedFiles.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  if (changedFiles.length > 0) {
    lines.push('Changed files:')
    for (const file of changedFiles) lines.push(`- ${file}`)
  } else {
    lines.push('Changed files: none')
  }

  // Reconstruct the editor's final report: walk backwards over the message
  // transcript collecting the trailing run of consecutive assistant messages
  // whose content is text-only. Text fragments are per-delta and can split
  // mid-word, so they are joined with '' (no separator). Fragments are
  // collected into an array and joined once at the end: prepending each
  // fragment to an accumulated string would copy the whole report per
  // message, making the walk quadratic in the transcript's total size.
  //
  // Early-exit: stop before allocating a fragment that would push the
  // accumulated total past the display cap. We already have more than enough
  // content at that point, so the overshoot fragment is never pushed. The
  // guard `totalChars > 0` ensures the very first (last) fragment is always
  // collected even when it alone exceeds the cap. This keeps peak allocation
  // proportional to the cap rather than to the full transcript length.
  //
  // When the early exit actually skips an older, non-empty assistant
  // fragment, the collected text is only the tail of the report. Mark that
  // explicitly — reusing the single-message path's '…[truncated]' token — so
  // a long multi-fragment report cannot render as a mid-report excerpt that
  // looks complete.
  const DISPLAY_CAP = 4000
  const messages = output.messages as unknown[]
  const fragments: string[] = []
  let totalChars = 0
  let droppedHead = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecordValue(message) || message.role !== 'assistant') break
    const text = getTextOnlyMessageContent(message.content)
    if (text === undefined) break
    // Zero-length fragments contribute nothing to the report; skipping them
    // prevents a run of empty assistant messages from bypassing the cap guard
    // and forcing an unbounded walk of the entire transcript.
    if (text.length === 0) continue
    if (totalChars > 0 && totalChars + text.length > DISPLAY_CAP) {
      droppedHead = true
      break
    }
    fragments.push(text)
    totalChars += text.length
  }
  const report = fragments.reverse().join('')

  const trimmedReport = report.trim()
  if (trimmedReport) {
    if (droppedHead) {
      lines.push('', '…[truncated]')
    }
    const cappedReport =
      trimmedReport.length > DISPLAY_CAP
        ? `${trimmedReport.slice(0, 3800)}\n…[truncated]`
        : trimmedReport
    lines.push('', cappedReport)
  }

  return lines.join('\n')
}

/**
 * Extracts text content from a Message object's content array.
 * Handles assistant messages with TextPart content.
 */
const extractTextFromMessageContent = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (part): part is { text: string } =>
        isRecordValue(part) &&
        part.type === 'text' &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('')
}

const STRINGIFY_CAP = 4000
const STRINGIFY_CONTENT_CAP = 3800

// Hard recursion bound for _trimJsonValue, mirroring MAX_SANITIZE_DEPTH in
// payload-sanitizer.ts: a pathologically deep agent result degrades to a
// truncation marker instead of overflowing the stack inside first-party code.
const MAX_JSON_TRIM_DEPTH = 32

const TRIM_JSON_DEPTH_MARKER = `[Openbuff omitted payload nested deeper than ${MAX_JSON_TRIM_DEPTH} levels.]`
const TRIM_JSON_CYCLE_MARKER = '[Circular]'

/**
 * Lower-bound estimate of the characters a non-string leaf contributes to
 * JSON.stringify output. Strings are budgeted exactly by the caller; numbers,
 * booleans and null are estimated from their literal length, and leaves that
 * serialize to nothing (undefined, functions, symbols) charge a minimal cost
 * so enumerating a container full of them still terminates. Together with the
 * fixed per-container bracket cost this keeps traversal work proportional to
 * the budget instead of to the full input size for shapes made of non-string
 * leaves (e.g. a large numeric/boolean array or a wide object of numbers).
 */
const estimateJsonLeafCost = (v: unknown): number => {
  if (v === null) return 4
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return String(v).length
    case 'boolean':
      return v ? 4 : 5
    default:
      return 1
  }
}

/**
 * Recursive traversal helper for `cappedJsonStringify`. Declared at module
 * scope so `cappedJsonStringify` never allocates a new function object per
 * call. `budget` is a single-element mutable ref that threads the remaining
 * character allowance through the recursion without closure capture. `seen`
 * detects self-referential values and `depth` bounds the recursion, so
 * pathological agent result shapes degrade to markers instead of throwing a
 * RangeError from first-party code.
 */
const _trimJsonValue = (
  v: unknown,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (typeof v === 'string') {
    if (budget.remaining <= 0) return ''
    if (v.length <= budget.remaining) {
      budget.remaining -= v.length
      return v
    }
    const truncated = v.slice(0, budget.remaining)
    budget.remaining = 0
    return truncated
  }
  if (budget.remaining <= 0) return null
  if (v === null || typeof v !== 'object') {
    // Charge non-string leaves against the budget too, so wide arrays or
    // objects of numbers/booleans stop being enumerated once it is spent.
    budget.remaining -= estimateJsonLeafCost(v)
    return v
  }
  if (depth >= MAX_JSON_TRIM_DEPTH) return TRIM_JSON_DEPTH_MARKER
  if (seen.has(v)) return TRIM_JSON_CYCLE_MARKER
  seen.add(v)
  try {
    if (Array.isArray(v)) {
      budget.remaining -= 2
      const out: unknown[] = []
      for (const item of v) {
        if (budget.remaining <= 0) break
        out.push(_trimJsonValue(item, budget, seen, depth + 1))
      }
      return out
    }
    const record = v as Record<string, unknown>
    budget.remaining -= 2
    const out: Record<string, unknown> = {}
    const proto = Object.getPrototypeOf(record)
    if (proto === Object.prototype || proto === null) {
      // Lazy for-in instead of Object.entries for plain JSON-shaped objects:
      // entries materializes the full key/value list up front, which alone is
      // O(all keys) even after the budget is spent. for-in enumerates lazily
      // and, restricted to Object.prototype/null receivers, enumerates exactly
      // the own enumerable keys JSON.stringify would serialize.
      for (const k in record) {
        if (budget.remaining <= 0) break
        out[k] = _trimJsonValue(record[k], budget, seen, depth + 1)
      }
    } else {
      for (const [k, item] of Object.entries(record)) {
        if (budget.remaining <= 0) break
        out[k] = _trimJsonValue(item, budget, seen, depth + 1)
      }
    }
    return out
  } finally {
    seen.delete(v)
  }
}

/**
 * Serialize `value` to indented JSON capped at STRINGIFY_CAP characters.
 * A pre-processing traversal charges every visited value a lower bound of
 * its serialized size — exact for strings, estimated for non-string leaves
 * plus a fixed bracket cost for containers — and stops enumerating the
 * moment the budget is spent, so wide flat objects and large arrays of
 * primitives pay no per-sibling cost after budget exhaustion. A final slice
 * guard covers structural overhead (keys, whitespace) that the traversal
 * cannot predict in advance. Depth and cycle guards keep pathological shapes
 * serializable instead of throwing.
 */
const cappedJsonStringify = (value: unknown): string => {
  const budget = { remaining: STRINGIFY_CONTENT_CAP }
  const trimmed = _trimJsonValue(value, budget, new WeakSet(), 0)
  const raw = JSON.stringify(trimmed, null, 2)
  return raw.length > STRINGIFY_CAP
    ? raw.slice(0, STRINGIFY_CONTENT_CAP) + '\n\u2026[truncated]'
    : raw
}

/**
 * Extracts displayable content from a spawn_agents result value.
 * Handles various nested structures that can come back from agent spawns.
 */
export const extractSpawnAgentResultContent = (
  resultValue: unknown,
): SpawnAgentResultContent => {
  // Handle null/undefined
  if (!resultValue) {
    return { content: '', hasError: false }
  }

  // Handle direct string
  if (typeof resultValue === 'string') {
    return { content: resultValue, hasError: false }
  }

  if (!isRecordValue(resultValue)) {
    return { content: '', hasError: false }
  }

  const obj = resultValue

  // Handle empty object
  if (Object.keys(obj).length === 0) {
    return { content: '', hasError: false }
  }

  // Handle error messages (check both top-level and nested)
  if (obj.errorMessage) {
    return { content: String(obj.errorMessage), hasError: true }
  }
  if (obj.error) {
    return { content: String(obj.error), hasError: true }
  }
  if (obj.type === 'error') {
    const message =
      typeof obj.message === 'string'
        ? obj.message
        : JSON.stringify(obj, null, 2)
    return { content: message, hasError: true }
  }

  const nestedValue = isRecordValue(obj.value) ? obj.value : undefined
  if (nestedValue?.errorMessage) {
    return { content: String(nestedValue.errorMessage), hasError: true }
  }
  if (nestedValue?.error) {
    return { content: String(nestedValue.error), hasError: true }
  }
  if (nestedValue?.type === 'error') {
    const message =
      typeof nestedValue.message === 'string'
        ? nestedValue.message
        : JSON.stringify(nestedValue, null, 2)
    return { content: message, hasError: true }
  }

  // Handle lastMessage and allMessages output modes: { type: "lastMessage"|"allMessages", value: [Message array] }
  // This is common for agents like researcher-web
  if (
    (obj.type === 'lastMessage' || obj.type === 'allMessages') &&
    Array.isArray(obj.value)
  ) {
    const messages = obj.value as Array<{ role?: string; content?: unknown }>
    const parts: string[] = []
    for (const msg of messages) {
      if (msg?.role !== 'assistant') continue
      const text = extractTextFromMessageContent(msg?.content)
      if (text) parts.push(text)
    }
    const textContent = parts.join('\n')
    return { content: textContent, hasError: false }
  }

  // Handle structuredOutput mode: { type: "structuredOutput", value: any }
  if (obj.type === 'structuredOutput') {
    const value = obj.value
    // Check for message field in structured output
    if (isRecordValue(value)) {
      const filePickerSummary = formatFilePickerStructuredOutput(value)
      if (filePickerSummary) {
        return { content: filePickerSummary, hasError: false }
      }
      const basherSummary = formatBasherStructuredOutput(value)
      if (basherSummary) {
        return { content: basherSummary, hasError: false }
      }
      const generalReceiptSummary = formatGeneralAgentReceiptStructuredOutput(value)
      if (generalReceiptSummary) {
        return { content: generalReceiptSummary, hasError: false }
      }
      const generalSummarySummary = formatGeneralAgentSummaryStructuredOutput(value)
      if (generalSummarySummary) {
        return { content: generalSummarySummary, hasError: false }
      }
      const librarianSummary = formatLibrarianStructuredOutput(value)
      if (librarianSummary) {
        return { content: librarianSummary, hasError: false }
      }
      const externalCliSummary = formatExternalCliStructuredOutput(value)
      if (externalCliSummary) {
        return { content: externalCliSummary, hasError: false }
      }
      const browserUseSummary = formatBrowserUseStructuredOutput(value)
      if (browserUseSummary) {
        return { content: browserUseSummary, hasError: false }
      }
      const webResearchSummary = formatResearcherWebStructuredOutput(value)
      if (webResearchSummary) {
        return { content: webResearchSummary, hasError: false }
      }
      const docsResearchSummary = formatResearcherDocsStructuredOutput(value)
      if (docsResearchSummary) {
        return { content: docsResearchSummary, hasError: false }
      }
      const reviewerSummary = formatReviewerStructuredOutput(value)
      if (reviewerSummary) {
        return { content: reviewerSummary, hasError: false }
      }
      const editorSummary = formatEditorNestedOutput(value)
      if (editorSummary) {
        return { content: editorSummary, hasError: false }
      }
      if (typeof value.message === 'string') {
        return { content: value.message, hasError: false }
      }
      if (typeof value.errorMessage === 'string') {
        return { content: value.errorMessage, hasError: true }
      }
      if (typeof value.error === 'string') {
        return { content: value.error, hasError: true }
      }
      // Check for data.message pattern
      if (isRecordValue(value.data) && typeof value.data.message === 'string') {
        return { content: value.data.message, hasError: false }
      }
    }
    // Fall through to format as JSON. Fenced so the markdown renderer shows
    // it verbatim instead of conceal-eating the JSON syntax.
    return {
      content: "```json\n" + cappedJsonStringify(obj.value) + "\n```",
      hasError: false,
    }
  }

  // Handle nested string value: { value: "..." }
  if (typeof obj.value === 'string') {
    return { content: obj.value, hasError: false }
  }

  // Handle message field (top-level or nested)
  if (obj.message) {
    return { content: String(obj.message), hasError: false }
  }
  if (nestedValue?.message) {
    return { content: String(nestedValue.message), hasError: false }
  }

  // Fallback to formatted output. Fenced so the markdown renderer shows it
  // verbatim instead of conceal-eating the JSON syntax.
  return {
    content: "```json\n" + cappedJsonStringify(resultValue) + "\n```",
    hasError: false,
  }
}

/**
 * Appends an interruption notice to blocks, either by modifying the last
 * text block or adding a new one.
 */
export const appendInterruptionNotice = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  const lastBlock = blocks[blocks.length - 1]

  if (lastBlock && lastBlock.type === 'text') {
    const interruptedBlock: ContentBlock = {
      ...lastBlock,
      content: `${lastBlock.content}\n\n[response interrupted]`,
    }
    return [...blocks.slice(0, -1), interruptedBlock]
  }

  const interruptionNotice: ContentBlock = {
    type: 'text',
    content: '[response interrupted]',
  }
  return [...blocks, interruptionNotice]
}

/**
 * Terminates every still-running (`status: 'pending'`) root-level compaction
 * block, rewriting it to the terminal `'interrupted'` state and dropping the
 * now-meaningless `liveSessionId` stamp. Composed into the abort/teardown block
 * update so a pass whose run ended before it reported a result can never be
 * persisted — or replayed — as a live "Compacting context…" card.
 *
 * Returns the ORIGINAL array reference when nothing was pending so React skips
 * a re-render. Root-level only: compaction blocks are never nested under an
 * agent block.
 */
export const markPendingCompactionInterrupted = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  let result: ContentBlock[] | undefined
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let updated: ContentBlock = block
    if (block.type === 'compaction' && block.status === 'pending') {
      const { liveSessionId: _liveSessionId, ...rest } = block
      updated = { ...rest, status: 'interrupted' as const }
    }
    if (updated !== block) {
      if (!result) result = blocks.slice(0, i)
    }
    if (result) result.push(updated)
  }
  return result ?? blocks
}

/**
 * Removes every `transient` compaction block. Such a card is a purely transient
 * progress affordance — a healthy pass that reclaimed space and has nothing the
 * user must act on — so it must never reach persistence: the renderer only
 * HIDES it after a short hold, and this is what actually takes it out of state,
 * composed into the same abort/turn-end block update as
 * {@link markPendingCompactionInterrupted}. Degraded, declined and interrupted
 * passes are never marked transient, so they are untouched here and keep their
 * permanent warning card.
 *
 * Returns the ORIGINAL array reference when nothing was dropped so React skips
 * a re-render. Root-level only: compaction blocks are never nested under an
 * agent block.
 */
export const dropTransientCompactionBlocks = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  let result: ContentBlock[] | undefined
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type === 'compaction' && block.transient === true) {
      if (!result) result = blocks.slice(0, i)
    } else if (result) {
      result.push(block)
    }
  }
  return result ?? blocks
}

/**
 * Recursively finds an agent block by ID and returns its agent type.
 * Returns undefined if not found.
 */
export const findAgentTypeById = (
  blocks: ContentBlock[],
  agentId: string,
  _depth = 0,
): string | undefined => {
  for (const block of blocks) {
    if (block.type === 'agent') {
      if (block.agentId === agentId) {
        return block.agentType
      }
      if (block.blocks && _depth < MAX_AUTO_COLLAPSE_DEPTH) {
        const found = findAgentTypeById(block.blocks, agentId, _depth + 1)
        if (found) {
          return found
        }
      }
    }
  }
  return undefined
}

/**
 * Options for creating an agent content block.
 */
export interface CreateAgentBlockOptions {
  agentId: string
  agentType: string
  prompt?: string
  params?: Record<string, unknown>
  /** The spawn_agents tool call ID that created this block */
  spawnToolCallId?: string
  /** The index within the spawn_agents call */
  spawnIndex?: number
  /** The agent type of the parent agent that spawned this one */
  parentAgentType?: string
}

/**
 * Creates a new agent content block with standard defaults.
 */
export const createAgentBlock = (
  options: CreateAgentBlockOptions,
): AgentContentBlock => {
  const {
    agentId,
    agentType,
    prompt,
    params,
    spawnToolCallId,
    spawnIndex,
  } = options
  // Subagents start EXPANDED so their full live stream is visible by default.
  // Grid-row sizing still uses shouldCollapseByDefault (see block-processor's
  // splitByAgentSize); that layout grouping is intentionally decoupled from
  // the initial expand/collapse state. The user can still collapse manually.
  return {
    type: 'agent',
    agentId,
    agentName: agentType || 'Agent',
    agentType: agentType || 'unknown',
    content: '',
    status: 'running' as const,
    blocks: [] as ContentBlock[],
    initialPrompt: prompt || '',
    ...(params && { params }),
    ...(spawnToolCallId && { spawnToolCallId }),
    ...(spawnIndex !== undefined && { spawnIndex }),
  }
}

/**
 * Helper function to recursively update blocks by target agent ID.
 */
export const updateBlocksRecursively = (
  blocks: ContentBlock[],
  targetAgentId: string,
  updateFn: (block: ContentBlock) => ContentBlock,
  _depth = 0,
): ContentBlock[] => {
  let result: ContentBlock[] | null = null

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let newBlock: ContentBlock

    if (block.type === 'agent' && block.agentId === targetAgentId) {
      newBlock = updateFn(block)
    } else if (block.type === 'agent' && block.blocks && _depth < MAX_BLOCK_UPDATE_DEPTH) {
      const updatedBlocks = updateBlocksRecursively(
        block.blocks,
        targetAgentId,
        updateFn,
        _depth + 1,
      )
      newBlock =
        updatedBlocks !== block.blocks
          ? { ...block, blocks: updatedBlocks }
          : block
    } else {
      newBlock = block
    }

    if (newBlock !== block) {
      if (result === null) {
        result = blocks.slice(0, i)
      }
      result.push(newBlock)
    } else if (result !== null) {
      result.push(block)
    }
  }

  return result ?? blocks
}

/**
 * Result from nestBlockUnderParent indicating whether the parent was found.
 */
export interface NestBlockResult {
  blocks: ContentBlock[]
  parentFound: boolean
}

/**
 * Nests a block under a parent agent, or returns it at top level if parent not found.
 */
export const nestBlockUnderParent = (
  blocks: ContentBlock[],
  parentAgentId: string,
  blockToNest: ContentBlock,
): NestBlockResult => {
  let parentFound = false
  const updatedBlocks = updateBlocksRecursively(
    blocks,
    parentAgentId,
    (parentBlock) => {
      if (parentBlock.type !== 'agent') {
        return parentBlock
      }
      parentFound = true
      return {
        ...parentBlock,
        blocks: [...(parentBlock.blocks || []), blockToNest],
      }
    },
  )

  return { blocks: updatedBlocks, parentFound }
}

/**
 * Checks if a block with the given targetId exists anywhere in the children of the blocks.
 */
const findBlockInChildren = (
  blocks: ContentBlock[],
  targetId: string,
  _depth = 0,
): boolean => {
  for (const block of blocks) {
    if (block.type === 'agent' && block.agentId === targetId) {
      return true
    }
    if (block.type === 'agent' && block.blocks && _depth < MAX_AUTO_COLLAPSE_DEPTH) {
      if (findBlockInChildren(block.blocks, targetId, _depth + 1)) {
        return true
      }
    }
  }
  return false
}


/**
 * Extracts a block with given agentId from nested blocks structure.
 * Returns the remaining blocks and the extracted block (if found).
 */
export const extractBlockById = (
  blocks: ContentBlock[],
  targetAgentId: string,
): { remainingBlocks: ContentBlock[]; extractedBlock: ContentBlock | null } => {
  let extractedBlock: ContentBlock | null = null

  const extractRecursively = (blocks: ContentBlock[], _depth = 0): ContentBlock[] => {
    const result: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type === 'agent' && block.agentId === targetAgentId) {
        extractedBlock = block
        // Don't add to result - we're extracting it
      } else if (extractedBlock === null && block.type === 'agent' && block.blocks && _depth < MAX_BLOCK_UPDATE_DEPTH) {
        // Only recurse into agent children if the target hasn't been found yet
        result.push({
          ...block,
          blocks: extractRecursively(block.blocks, _depth + 1),
        })
      } else {
        result.push(block)
      }
    }
    return result
  }

  const remainingBlocks = extractRecursively(blocks)
  return { remainingBlocks, extractedBlock }
}

export const moveSpawnAgentBlock = (
  blocks: ContentBlock[],
  tempId: string,
  realId: string,
  parentId?: string,
  params?: Record<string, unknown>,
  prompt?: string,
  realAgentType?: string,
): ContentBlock[] => {
  const updateAgentBlock = (block: ContentBlock): ContentBlock => {
    if (block.type !== 'agent') {
      return block
    }
    const updatedBlock: ContentBlock = {
      ...block,
      agentId: realId,
    }

    if (params) {
      updatedBlock.params = params
    }

    if (prompt && block.initialPrompt === '') {
      updatedBlock.initialPrompt = prompt
    }

    if (realAgentType) {
      updatedBlock.agentType = realAgentType
      updatedBlock.agentName = realAgentType
    }

    return updatedBlock
  }

  // If there's a parentId, we need to move the block under the parent.
  // Extract then nest in two passes rather than three: skipping the
  // checkBlockIsUnderParent pre-check lets extractBlockById + nestBlockUnderParent
  // handle both the already-nested and needs-reparent cases correctly.
  if (parentId) {
    const { remainingBlocks, extractedBlock } = extractBlockById(blocks, tempId)
    if (extractedBlock && extractedBlock.type === 'agent') {
      const blockToMove = updateAgentBlock(extractedBlock)
      const { blocks: nestedBlocks, parentFound } = nestBlockUnderParent(
        remainingBlocks,
        parentId,
        blockToMove,
      )
      if (parentFound) {
        return nestedBlocks
      }
      // Parent not found, update in place instead of appending to end
      return updateBlocksRecursively(blocks, tempId, updateAgentBlock)
    }
  }

  // No parentId or block not found - just update in place to preserve order
  return updateBlocksRecursively(blocks, tempId, updateAgentBlock)
}

/**
 * Options for transforming ask_user tool blocks to ask-user content blocks.
 */
export interface TransformAskUserOptions {
  toolCallId: string
  resultValue: unknown
}

/**
 * Transforms ask_user tool blocks into ask-user content blocks when tool results arrive.
 * Recursively processes nested agent blocks.
 */
export const transformAskUserBlocks = (
  blocks: ContentBlock[],
  options: TransformAskUserOptions,
  _depth = 0,
): ContentBlock[] => {
  const { toolCallId, resultValue } = options

  let result: ContentBlock[] | undefined
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let updated: ContentBlock = block
    if (
      block.type === 'tool' &&
      block.toolCallId === toolCallId &&
      block.toolName === 'ask_user'
    ) {
      const record = isRecordValue(resultValue) ? resultValue : undefined
      const skipped = record?.skipped
      const answers = record?.answers
      const questions = block.input.questions

      if (answers || skipped) {
        updated = {
          type: 'ask-user',
          toolCallId,
          questions,
          answers,
          skipped,
        } as AskUserContentBlock
      }
      // If no result data, keep as tool block (fallback)
    } else if (block.type === 'agent' && block.blocks && _depth < MAX_AUTO_COLLAPSE_DEPTH) {
      const updatedBlocks = transformAskUserBlocks(block.blocks, options, _depth + 1)
      if (updatedBlocks !== block.blocks) {
        updated = { ...block, blocks: updatedBlocks }
      }
    }
    if (updated !== block) {
      if (!result) result = blocks.slice(0, i)
    }
    if (result) result.push(updated)
  }
  return result ?? blocks
}

/**
 * Options for updating tool blocks with output.
 */
export interface UpdateToolBlockOptions {
  toolCallId: string
  toolOutput: unknown[]
}

const getFirstToolOutputValue = (toolOutput: unknown[]): unknown => {
  const firstOutput = toolOutput?.[0]
  return firstOutput &&
    typeof firstOutput === 'object' &&
    'value' in firstOutput
    ? (firstOutput as { value: unknown }).value
    : undefined
}

/**
 * Extract a BACKGROUND shell job id from a successful run_terminal_command
 * tool_result value. The job id is only known after the SDK starts the
 * detached process, so production correlation is via tool_result — not tool_call.
 *
 * Successful BACKGROUND launch shape:
 * `{ command, processId, backgroundProcessStatus: 'running', jobId, logFile, ... }`
 * Error results have `errorMessage` and must not wire a backgroundJobId.
 */
export const extractBackgroundShellJobId = (
  value: unknown,
): string | undefined => {
  if (!isRecordValue(value)) return undefined
  if (typeof value.errorMessage === 'string') return undefined
  if (typeof value.jobId !== 'string' || value.jobId.length === 0) {
    return undefined
  }

  // Primary contract: BACKGROUND start reports status "running" with a jobId.
  if (value.backgroundProcessStatus === 'running') {
    return value.jobId
  }

  // Defensive fallback: jobId without completion fields (stdout/stderr/exitCode).
  // Do not treat a SYNC result that happens to include jobId as BACKGROUND.
  if (
    value.backgroundProcessStatus === undefined &&
    value.exitCode === undefined &&
    value.stdout === undefined &&
    value.stderr === undefined
  ) {
    return value.jobId
  }

  return undefined
}

/** Resolve BACKGROUND shell jobId from a tool_result output array. */
export const getBackgroundShellJobIdFromToolOutput = (
  toolOutput: unknown[],
): string | undefined =>
  extractBackgroundShellJobId(getFirstToolOutputValue(toolOutput))

const formatTransactionToolOutput = (toolOutput: unknown[]): string => {
  const value = getFirstToolOutputValue(toolOutput)
  if (!value || typeof value !== 'object') {
    return JSON.stringify(toolOutput, null, 2)
  }

  const result = value as Record<string, unknown>
  if (typeof result.errorMessage === 'string') return result.errorMessage
  if (typeof result.error === 'string') return result.error

  if (typeof result.message === 'string') {
    const files = Array.isArray(result.files) ? result.files : []
    if (files.length === 0) return result.message

    const fileList = files
      .map((file) => {
        const entry = file as Record<string, unknown>
        return typeof entry.path === 'string'
          ? entry.path
          : typeof entry.file === 'string'
            ? entry.file
            : null
      })
      .filter((path): path is string => typeof path === 'string')
      .map((path) => `- ${path}`)
      .join('\n')

    return fileList ? `${result.message}\n${fileList}` : result.message
  }

  return JSON.stringify(toolOutput, null, 2)
}

const formatToolOutput = (
  toolName: ToolContentBlock['toolName'],
  toolOutput: unknown[],
): string => {
  if (toolName === 'run_terminal_command') {
    const parsed = getFirstToolOutputValue(toolOutput) as
      | { stdout?: string; stderr?: string }
      | undefined
    if (parsed?.stdout || parsed?.stderr) {
      return (parsed.stdout || '') + (parsed.stderr || '')
    }
    // BACKGROUND launch has no stdout/stderr yet; leave output empty so live
    // job_update deltas stream cleanly instead of a frozen JSON dump.
    if (extractBackgroundShellJobId(parsed) !== undefined) {
      return ''
    }
    return JSON.stringify(toolOutput, null, 2)
  }

  if (toolName === 'edit_transaction') {
    return formatTransactionToolOutput(toolOutput)
  }

  return JSON.stringify(toolOutput, null, 2)
}

// hasMediaPayload must reach every media payload that sanitizeMediaForUiState
// could redact. It is depth-capped (mirroring MAX_SANITIZE_DEPTH, which the
// sanitizer applies to the same walk) so a pathologically deep tool output
// cannot overflow the stack inside this hot pre-check. Hitting the cap
// returns true — "media possibly present" — so the caller still runs
// sanitizeMediaForUiState, whose own depth cap replaces anything nested
// deeper with a truncation marker; no unsanitized media payload can bypass
// redaction by hiding below the cap.
//
// The memo maps each visited object to the shallowest entry depth from which
// its reachable subtree has already been fully explored without finding
// media. The subtree hanging off a shared object is identical on every path,
// and the depth cap truncates at the same absolute depth regardless of entry
// depth, so a revisit at an equal-or-deeper entry depth cannot discover
// anything the first visit missed and reuses that false; a revisit at a
// shallower depth is re-explored. An add-only visited set would suppress even
// the shallower revisit, so it can never be proven safe here; tracking the
// shallowest explored entry depth keeps the memo sound for any reference
// shape. Cycles stay bounded because a node on the current path always finds
// a recorded depth <= its own, and each node is re-explored at most
// MAX_HAS_MEDIA_DEPTH times, so the walk stays bounded on shared or cyclic
// inputs.
const MAX_HAS_MEDIA_DEPTH = 32

const _hasMediaPayloadImpl = (
  value: unknown,
  explored: Map<object, number>,
  depth: number,
): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const exploredAtDepth = explored.get(value)
  if (exploredAtDepth !== undefined && depth >= exploredAtDepth) {
    return false
  }
  if (depth >= MAX_HAS_MEDIA_DEPTH) {
    return true
  }
  explored.set(value, depth)

  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.type === 'media' && typeof record.data === 'string') {
      return true
    }
    if (record.type === 'file' && typeof record.data === 'string') {
      return true
    }
    if (record.type === 'image' && typeof record.image === 'string') {
      return true
    }
  }

  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (_hasMediaPayloadImpl(obj[key], explored, depth + 1)) {
      return true
    }
  }
  return false
}

const hasMediaPayload = (value: unknown): boolean =>
  _hasMediaPayloadImpl(value, new Map<object, number>(), 0)

/**
 * Updates tool blocks with their output when tool results arrive.
 * Handles special formatting for terminal command and transaction output.
 * Recursively processes nested agent blocks.
 */
export const updateToolBlockWithOutput = (
  blocks: ContentBlock[],
  options: UpdateToolBlockOptions,
  _depth = 0,
): ContentBlock[] => {
  const { toolCallId, toolOutput } = options
  const backgroundJobId = getBackgroundShellJobIdFromToolOutput(toolOutput)

  let result: ContentBlock[] | undefined
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let updated: ContentBlock = block
    if (block.type === 'tool' && block.toolCallId === toolCallId) {
      const displayToolOutput = hasMediaPayload(toolOutput)
        ? sanitizeMediaForUiState(toolOutput)
        : toolOutput
      updated = {
        ...block,
        output: formatToolOutput(block.toolName, displayToolOutput),
        outputRaw: displayToolOutput,
        // Wire BACKGROUND shell jobId so live job_update events can correlate.
        // Only set when the result is a successful BACKGROUND launch; do not
        // clear an existing backgroundJobId from spawn_agents agent wiring.
        ...(backgroundJobId !== undefined &&
        block.toolName === 'run_terminal_command'
          ? { backgroundJobId }
          : {}),
      }
    } else if (block.type === 'agent' && block.blocks && _depth < MAX_AUTO_COLLAPSE_DEPTH) {
      const updatedBlocks = updateToolBlockWithOutput(block.blocks, options, _depth + 1)
      if (updatedBlocks !== block.blocks) {
        updated = { ...block, blocks: updatedBlocks }
      }
    }
    if (updated !== block) {
      if (!result) result = blocks.slice(0, i)
    }
    if (result) result.push(updated)
  }
  return result ?? blocks
}
