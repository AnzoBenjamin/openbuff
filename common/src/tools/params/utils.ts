import z from 'zod/v4'

import {
  endsAgentStepParam,
  endToolTag,
  startToolTag,
  toolNameParam,
} from '../constants'

import type { JSONValue } from '../../types/json'
import type { ToolResultOutput } from '../../types/messages/content-part'

/**
 * Coerces a value into an array if it isn't one already.
 * Handles common LLM mistakes:
 * - Single object/string passed instead of an array → wraps in array
 * - Stringified JSON array passed as a string → parses it
 * - Already an array → passes through
 * - null/undefined → passes through (let Zod handle it)
 */
export function coerceToArray(val: unknown): unknown {
  if (Array.isArray(val)) {
    // Recover comma-split fragment arrays (transports that tokenize a
    // stringified JSON array on every comma). Returns the array unchanged
    // for legitimate string arrays and arrays of objects.
    return repairCommaSplitFragments(val)
  }
  if (typeof val === 'string') {
    const parsed = parseJsonBounded(val)
    if (Array.isArray(parsed)) return parsed
  }
  if (val != null) return [val]
  return val
}

/**
 * Coerces a stringified JSON object into an object.
 * This is intentionally narrow so malformed values still fail validation.
 */
export function coerceToObject(val: unknown): unknown {
  if (typeof val !== 'string') {
    return val
  }

  const parsed = parseJsonBounded(val)
  if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed
  }

  return val
}

const MAX_REPAIRABLE_JSON_LENGTH = 256_000

/**
 * Repairs redundant or trailing JSON separators outside quoted strings. Only
 * complete, bounded object/array payloads are eligible; callers still parse
 * the result and validate it against the destination schema.
 */
export function repairMalformedJsonSeparators(
  input: string,
): string | undefined {
  const trimmed = input.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_TRUNCATION_SCAN_LENGTH ||
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return undefined
  }

  let output = ''
  let inString = false
  let escaped = false
  let repaired = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < input.length && /\s/.test(input[next])) next++
      if (input[next] === ',' || input[next] === '}' || input[next] === ']') {
        repaired = true
        continue
      }
    }
    output += char
  }
  return repaired ? output : undefined
}

/** Machine-readable code for arguments cut in transport; distinct from malformed. */
export const PAYLOAD_TRUNCATED_ERROR_CODE = 'payload_truncated' as const

/** Structural scan state for classification + boundary recovery (bounds CPU). */
const MAX_TRUNCATION_SCAN_LENGTH = MAX_REPAIRABLE_JSON_LENGTH

type TruncationScanState = {
  depth: number
  inString: boolean
  escapedData: boolean
}

/** Single pass over the raw argument string tracking string/escape/brace depth. */
function scanTruncationState(input: string): TruncationScanState | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_TRUNCATION_SCAN_LENGTH) {
    return undefined
  }
  let depth = 0
  let inString = false
  let escapedData = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escapedData) escapedData = false
      else if (ch === '\\') escapedData = true
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth--
      if (depth < 0) return undefined
    }
  }
  return { depth, inString, escapedData }
}

/** True only for transport-truncation signatures, never for complete payloads. */
export function detectTransportTruncation(
  input: string,
  parseError?: string,
): boolean {
  if (typeof input !== 'string') return false
  const state = scanTruncationState(input)
  if (!state) return false
  // A balanced, fully-closed, no-dangling-string payload is never truncated,
  // regardless of what a fallback parse error claimed (malformed stays malformed).
  const balancedClosed =
    state.depth === 0 && !state.inString && !state.escapedData
  if (balancedClosed) return false
  if (parseError !== undefined && /unexpected end of json input/i.test(parseError)) {
    return true
  }
  return state.inString || state.depth > 0 || state.escapedData
}

/**
 * Attempts to recover a transport-truncated tool-call argument object ONLY when
 * the cut dropped nothing but container closers. The sole eligible cut boundary
 * is a position whose last non-whitespace character is `}` or `]` — i.e. the
 * prefix ends at a fully closed container whose every member was completely
 * written. Candidates are scanned latest-to-earliest; each prefix is closed with
 * balanced closers and accepted only when JSON.parse yields a non-empty plain
 * object. A payload cut mid-string or mid-member is NEVER recovered: no trailing
 * comma is trimmed and no partially-written key or value is completed, so a
 * guessed/truncated value can never be applied as an edit. Returns undefined
 * when no clean container-close boundary recovers a complete object.
 */
export function tryRecoverTruncatedToolArguments(
  rawInput: string,
): Record<string, unknown> | undefined {
  const state = scanTruncationState(rawInput)
  if (!state || (state.depth === 0 && !state.inString && !state.escapedData)) {
    // Non-strings, empty/oversized inputs, mismatched closers, and complete
    // balanced payloads are never truncation-recovery candidates.
    return undefined
  }
  // Scan `}`/`]` candidate cut positions from LATEST to EARLIEST. For each,
  // build the prefix ending at that closer, append balanced closers for the
  // residual open containers, and let JSON.parse be the final gate.
  for (let pos = rawInput.length - 1; pos >= 0; pos--) {
    const closingChar = rawInput[pos]
    if (closingChar !== '}' && closingChar !== ']') {
      continue
    }
    const prefix = rawInput.slice(0, pos + 1)
    // Rescan the prefix with the string/escape state machine to compute the
    // residual open-container stack. When the candidate character was consumed
    // inside a string literal (inString at end of prefix) it is data, not a
    // structural boundary — skip it.
    const openStack: string[] = []
    let inString = false
    let escapedData = false
    for (let i = 0; i < prefix.length; i++) {
      const c = prefix[i]
      if (inString) {
        if (escapedData) escapedData = false
        else if (c === '\\') escapedData = true
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '{') openStack.push('{')
      else if (c === '[') openStack.push('[')
      else if (c === '}' || c === ']') openStack.pop()
    }
    if (inString) continue
    let candidate = prefix
    for (let i = openStack.length - 1; i >= 0; i--) {
      candidate += openStack[i] === '{' ? '}' : ']'
    }
    try {
      const recovered = JSON.parse(candidate)
      if (
        recovered !== null &&
        typeof recovered === 'object' &&
        !Array.isArray(recovered) &&
        Object.keys(recovered).length > 0
      ) {
        return recovered
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Summarizes a recovered truncation candidate (from
 * tryRecoverTruncatedToolArguments) as bounded evidence for the truncation
 * error path: its serialized byte count plus a capped structural preview.
 * Returns undefined when there is no recovery to describe. The summary is
 * metadata only — the recovered object itself must NEVER be substituted for
 * the tool-call input; it may only ever appear inside an error message.
 *
 * SECURITY: the preview is deliberately structural, not a raw substring of the
 * serialized object. A raw `JSON.stringify(recovered).slice(0, N)` could carry
 * secret content verbatim (an edit payload's path/oldString/newString) into a
 * logged, model-visible error. This preview reports only top-level key names
 * and edit path fields — never string contents — so no payload secret survives
 * into the preview regardless of what the truncated payload carried.
 */
export function describeTruncationRecovery(
  recovered: Record<string, unknown> | undefined,
): { recoveredBytes: number; recoveredPreview: string } | undefined {
  if (recovered === undefined) {
    return undefined
  }
  const serialized = JSON.stringify(recovered)
  return {
    recoveredBytes: serialized.length,
    recoveredPreview: structuralRecoveryPreview(recovered),
  }
}

/**
 * Builds a secret-free structural preview of a recovered truncation candidate.
 * Reports only the top-level key names and, for an `edits` array, each edit's
 * type and path. String values (oldString/newString/content) are never
 * included, so the preview cannot leak payload secrets into an error message.
 */
function structuralRecoveryPreview(recovered: Record<string, unknown>): string {
  const keys = Object.keys(recovered)
  const parts: string[] = [`keys: [${keys.join(', ')}]`]
  const edits = recovered.edits
  if (Array.isArray(edits)) {
    const editSummaries = edits.map((edit) => {
      if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
        return '(non-object edit)'
      }
      const record = edit as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : 'unknown'
      const path = typeof record.path === 'string' ? record.path : '<no path>'
      return `${type} ${path}`
    })
    parts.push(`edits: [${editSummaries.join('; ')}]`)
  }
  const preview = `{ ${parts.join('; ')} }`
  return preview.slice(0, 200)
}

/** Parse one JSON encoding, applying only the bounded separator repair. */
export function parseJsonStringWithRepair(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch (error) {
    const repaired = repairMalformedJsonSeparators(input)
    if (repaired !== undefined) {
      try {
        return JSON.parse(repaired)
      } catch {
        // Preserve the original parse error when repair cannot produce JSON.
      }
    }
    throw error
  }
}

export function parseJsonBounded(value: unknown, maxDepth = 3): unknown {
  let parsed = value
  for (let depth = 0; depth < maxDepth && typeof parsed === 'string'; depth++) {
    try {
      parsed = parseJsonStringWithRepair(parsed)
    } catch {
      return parsed
    }
  }
  return parsed
}

/**
 * Repairs a comma-split fragment array: some transports tokenize a
 * stringified JSON array on every comma, producing an array of string
 * fragments that individually cannot parse as objects. Without this
 * recovery, Zod emits one "expected object, received string" error per
 * fragment — potentially 100+ — drowning out the actionable hint.
 *
 * Returns the recovered array when the rejoined fragments parse back into
 * an array. When the array is unrecoverable (no fragment parses as a
 * standalone object AND the rejoined string looks like JSON), returns the
 * joined string so Zod emits a single field-level error. Otherwise returns
 * the original value unchanged so legitimate string arrays survive.
 */
function repairCommaSplitFragments(value: unknown): unknown {
  if (
    !Array.isArray(value) ||
    value.length <= 1 ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    return value
  }

  // Fail fast on implausibly large fragment arrays — these are almost
  // certainly genuinely malformed payloads, not comma-split transport
  // artifacts. Zod will emit per-element errors for them.
  if (value.length > MAX_FRAGMENT_COUNT) {
    return value
  }

  const rejoined = value.join(',')
  if (rejoined.length > MAX_REJOINED_LENGTH) {
    return value
  }
  const reparsed = parseJsonBounded(rejoined)
  if (Array.isArray(reparsed)) {
    return reparsed
  }

  // Only collapse to a single string when the rejoined fragments look like
  // they could be a (possibly malformed) stringified JSON array/object.
  // Legitimate string arrays like ['file1.ts', 'file2.ts'] rejoin to
  // 'file1.ts,file2.ts' which does not start with '[' or '{', so they are
  // returned unchanged.
  const firstChar = rejoined.trim()[0]
  if (firstChar !== '[' && firstChar !== '{') {
    return value
  }

  // If every individual fragment also fails to parse as a standalone
  // object, the array is unrecoverable. Return the joined string so Zod
  // emits a single field-level error rather than one per-element error.
  const hasStandaloneObject = value.some((entry) => {
    const parsed = parseJsonBounded(entry)
    return (
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    )
  })
  if (!hasStandaloneObject) {
    return rejoined
  }

  // At least one fragment parses as a standalone object — return the
  // original array so the caller can apply per-entry repairs.
  return value
}

/**
 * Upper bounds for repairCommaSplitFragments. Beyond these ceilings the input
 * is almost certainly a genuinely malformed payload rather than a comma-split
 * transport artifact, so we fail fast and let Zod emit per-element errors
 * instead of doing unbounded CPU work rejoining and re-parsing every fragment.
 */
const MAX_FRAGMENT_COUNT = 256
const MAX_REJOINED_LENGTH = 65_536

/**
 * Known array-shaped spawn_agents params fields whose stringified-array values
 * should be decoded back into real arrays. Module-scoped (alongside
 * REPLACEMENT_PLACEHOLDER_KEYS) so it is not recreated for every entry.
 */
const ARRAY_PARAM_KEYS = [
  'searchQueries',
  'filePaths',
  'directories',
  'prompts',
  'changed_files',
  'paths',
  'patterns',
  'queries',
]

const MAX_TAGGED_PARAM_LENGTH = 65_536
const ARG_TAG_PATTERN = /<\/?arg_(?:key|value)>/i

/**
 * Repairs a provider serialization that places a Basher command inside the
 * params string as `command</arg_key><arg_value>...`. The opening arg_key and
 * closing arg_value tags may already have been consumed by the provider's tool
 * parser. Keep this Basher-only: interpreting arbitrary agent params strings
 * as tagged data would make malformed custom-agent inputs ambiguous.
 */
function repairBasherTaggedParams(agentType: unknown, value: unknown): unknown {
  if (
    agentType !== 'basher' ||
    typeof value !== 'string' ||
    value.length > MAX_TAGGED_PARAM_LENGTH
  ) {
    return value
  }

  const prefix = value.match(
    /^\s*(?:<arg_key>)?command<\/arg_key>\s*<arg_value>/i,
  )
  if (!prefix) return value

  let command = value.slice(prefix[0].length)
  const closingTag = command.match(/<\/arg_value>\s*$/i)
  if (closingTag?.index !== undefined) {
    command = command.slice(0, closingTag.index)
  }

  // Additional tag markers indicate a multi-field or truncated serialization.
  // Leave it untouched so normal schema validation rejects it instead of
  // accidentally treating wrapper syntax as part of a shell command.
  if (!command.trim() || ARG_TAG_PATTERN.test(command)) return value

  return { command }
}

/**
 * Repairs the common spawn_agents encodings produced by tool-calling models:
 * a stringified array, a double-stringified array, or stringified object
 * entries. Malformed/truncated values remain untouched so Zod fails closed.
 */
export function normalizeSpawnAgentList(value: unknown, depth = 0): unknown {
  const decoded = parseJsonBounded(value)

  // Detect and repair a comma-split fragment array: some transports
  // tokenize a stringified JSON array on every comma, producing an array
  // of string fragments that individually cannot parse as objects.
  const repaired = repairCommaSplitFragments(decoded)
  if (Array.isArray(decoded) && typeof repaired === 'string') {
    // Unrecoverable fragments collapsed to a single string — return it so
    // Zod emits one field-level error rather than one per fragment.
    return repaired
  }
  if (Array.isArray(repaired) && repaired !== decoded) {
    // Successfully recovered the original array — recurse to apply
    // per-entry repairs (stringified params, handoffs, etc.). Bound the
    // recursion at depth 2: parseJsonBounded maxDepth=3 means at most two
    // re-parse layers can produce a NEW array that differs from the
    // previous one; a third pass is a guaranteed no-op. This makes
    // termination explicit without relying on the maxDepth cap alone.
    if (depth >= 2) return repaired
    return normalizeSpawnAgentList(repaired, depth + 1)
  }

  const entries = Array.isArray(decoded) ? decoded : [decoded]
  return entries.map((entry) => {
    const parsedEntry = parseJsonBounded(entry)
    if (
      parsedEntry === null ||
      typeof parsedEntry !== 'object' ||
      Array.isArray(parsedEntry)
    ) {
      return entry
    }

    const record = parsedEntry as Record<string, unknown>
    const repairedRecord = { ...record }
    let repaired = false

    const parsedHandoff = parseJsonBounded(record.handoff)
    if (
      typeof record.handoff === 'string' &&
      parsedHandoff !== null &&
      typeof parsedHandoff === 'object' &&
      !Array.isArray(parsedHandoff)
    ) {
      repairedRecord.handoff = parsedHandoff
      repaired = true
    }

    const taggedParams = repairBasherTaggedParams(
      record.agent_type,
      record.params,
    )
    const parsedParams = parseJsonBounded(taggedParams)
    const canMergeParams =
      parsedParams === undefined ||
      (parsedParams !== null &&
        typeof parsedParams === 'object' &&
        !Array.isArray(parsedParams))

    if (canMergeParams) {
      const paramsRecord = {
        ...((parsedParams ?? {}) as Record<string, unknown>),
      }
      let paramsRepaired =
        taggedParams !== record.params || typeof record.params === 'string'

      // Provider tool-call serializers sometimes preserve an agent-specific
      // array as a JSON string inside an otherwise valid params object (for
      // example, `searchQueries: "[...]"`). Decode only known array-shaped
      // handoff fields; leave commands, prompts, and arbitrary custom values
      // untouched so intentional strings are never reinterpreted as data.
      for (const key of ARRAY_PARAM_KEYS) {
        const value = paramsRecord[key]
        const parsedValue = parseJsonBounded(value)
        if (typeof value !== 'string' || !Array.isArray(parsedValue)) {
          continue
        }
        paramsRecord[key] = parsedValue.map((item) => parseJsonBounded(item))
        paramsRepaired = true
      }

      // Direct agent calls accept legacy top-level params and convert them
      // into the nested `params` object. Apply the same narrowly-scoped repair
      // to spawn_agents for Basher's explicit command field. Never derive a
      // shell command from `prompt`: prose is not executable authority.
      if (
        record.agent_type === 'basher' &&
        typeof record.command === 'string' &&
        paramsRecord.command === undefined
      ) {
        paramsRecord.command = record.command
        paramsRepaired = true
      }

      // Code-searcher: recover params.searchQueries from explicit structured
      // fields only (mirror basher command repair). Prefer nested params over
      // top-level. Never invent patterns from prompt prose; leave ambiguous
      // shapes untouched so Zod fails closed.
      if (record.agent_type === 'code-searcher') {
        const wrapSearchQueryObject = (
          value: unknown,
        ): unknown[] | undefined => {
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
          ) {
            return undefined
          }
          const query = value as Record<string, unknown>
          if (
            typeof query.pattern !== 'string' ||
            query.pattern.trim() === ''
          ) {
            return undefined
          }
          return [value]
        }

        const buildQueryFromPattern = (
          pattern: string,
          source: Record<string, unknown>,
        ): Record<string, unknown> => {
          const query: Record<string, unknown> = { pattern }
          if (typeof source.flags === 'string') query.flags = source.flags
          if (typeof source.cwd === 'string') query.cwd = source.cwd
          if (
            typeof source.maxResults === 'number' &&
            Number.isFinite(source.maxResults)
          ) {
            query.maxResults = source.maxResults
          }
          return query
        }

        const nonEmptyStringPatterns = (
          value: unknown,
        ): string[] | undefined => {
          if (!Array.isArray(value) || value.length === 0) return undefined
          if (
            !value.every(
              (entry) => typeof entry === 'string' && entry.trim() !== '',
            )
          ) {
            return undefined
          }
          return value as string[]
        }

        // Single object at params.searchQueries → one-element array.
        if (paramsRecord.searchQueries !== undefined) {
          const wrapped = wrapSearchQueryObject(paramsRecord.searchQueries)
          if (wrapped) {
            paramsRecord.searchQueries = wrapped
            paramsRepaired = true
          }
          // Non-empty string that is not a JSON array was already left alone
          // by ARRAY_PARAM_KEYS; do not reinterpret it here.
        } else {
          // Prefer nested structured fields over top-level aliases.
          if (
            typeof paramsRecord.pattern === 'string' &&
            paramsRecord.pattern.trim() !== ''
          ) {
            paramsRecord.searchQueries = [
              buildQueryFromPattern(paramsRecord.pattern, paramsRecord),
            ]
            paramsRepaired = true
          } else {
            const nestedPatterns = nonEmptyStringPatterns(paramsRecord.patterns)
            if (nestedPatterns) {
              paramsRecord.searchQueries = nestedPatterns.map((pattern) => ({
                pattern,
              }))
              paramsRepaired = true
            } else if (Array.isArray(record.searchQueries)) {
              paramsRecord.searchQueries = record.searchQueries
              paramsRepaired = true
            } else {
              const wrappedTop = wrapSearchQueryObject(record.searchQueries)
              if (wrappedTop) {
                paramsRecord.searchQueries = wrappedTop
                paramsRepaired = true
              } else if (
                typeof record.pattern === 'string' &&
                record.pattern.trim() !== ''
              ) {
                paramsRecord.searchQueries = [
                  buildQueryFromPattern(record.pattern, record),
                ]
                paramsRepaired = true
              } else {
                const topPatterns = nonEmptyStringPatterns(record.patterns)
                if (topPatterns) {
                  paramsRecord.searchQueries = topPatterns.map((pattern) => ({
                    pattern,
                  }))
                  paramsRepaired = true
                }
              }
            }
          }
        }
      }

      // Recover labelled v3 gate tokens from prose after compaction; never bare
      // hex. Snapshot-scoped specialists still verify the fingerprint against
      // the live review bundle, so recovery does not grant authority.
      if (
        paramsRecord.snapshot_id === undefined &&
        typeof record.prompt === 'string'
      ) {
        const matches = [
          ...record.prompt.matchAll(
            /\b(?:Snapshot(?: ID| fingerprint)?(?:\s*\([^\n)]*\)|\s+to verify)?|snapshot_id)\s*:\s*`?([A-Za-z0-9][A-Za-z0-9._:-]{0,511})`?/gi,
          ),
        ]
        // Only recover gate-attestable tokens (v3: + 64 lowercase hex). Bare bundle
        // hex and short/cap.v2 labels must not be injected: non-advisory createSpecialist
        // requires ^v3:[a-f0-9]{64}$ and bare fill fails schema / contradicts recovery hints.
        const explicitSnapshot = matches.at(-1)?.[1]
        if (
          typeof explicitSnapshot === 'string' &&
          /^v3:[a-f0-9]{64}$/.test(explicitSnapshot)
        ) {
          paramsRecord.snapshot_id = explicitSnapshot
          paramsRepaired = true
        }
      }

      if (paramsRepaired) {
        repairedRecord.params = paramsRecord
        repaired = true
      }
    }

    return repaired ? repairedRecord : parsedEntry
  })
}

const OBVIOUS_EDIT_PLACEHOLDER =
  /^\s*[\[<{(]\s*(?:(?:see|use|same as|copy|paste|insert)\b[\s\S]*\b(?:above|below|patch|code|content|here)|(?:old|new|existing|current)\s+(?:code|content)\s+here)\s*[\]}>)]\s*$/i

/** True only for explicit prose placeholders that can never be file content. */
export function isObviousEditPlaceholder(value: string): boolean {
  return OBVIOUS_EDIT_PLACEHOLDER.test(value)
}

/**
 * Handles common replacement-key aliases emitted by some models while keeping
 * the documented schema stable. Equivalent aliases are consumed; conflicting
 * aliases remain so the strict replacement schema rejects ambiguous intent.
 */
export function normalizeReplacementAliases(val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return val
  }

  const replacement = { ...(val as Record<string, unknown>) }
  for (const [target, aliases] of [
    ['oldString', ['old', 'old_str', 'old_string']],
    ['newString', ['new', 'new_str', 'new_string']],
  ] as const) {
    const stringAliases = aliases.filter(
      (key) => typeof replacement[key] === 'string',
    )
    if (replacement[target] === undefined && stringAliases.length > 0) {
      replacement[target] = replacement[stringAliases[0]]
    }

    for (const alias of stringAliases) {
      if (replacement[alias] === replacement[target]) {
        delete replacement[alias]
      }
    }
  }
  return replacement
}

const REPLACEMENT_PLACEHOLDER_KEYS = new Set([
  'oldString',
  'newString',
  'old',
  'new',
  'old_str',
  'new_str',
  'old_string',
  'new_string',
  'allowMultiple',
  'occurrenceIndex',
  'basedOnRead',
  'skipIfMissing',
])

/** Returns the first string value found among the given keys, else undefined. */
function firstDefinedReplacementString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Drops only operation-less replacement placeholders such as `{}`,
 * `{ allowMultiple: false }`, or a pure empty->empty entry that only carries
 * placeholder-set keys (e.g. `{ oldString: '', newString: '', basedOnRead }`).
 * Some providers append one of these after an otherwise complete replacement
 * array; without this, the empty->empty entry would reach Zod and hard-fail
 * the entire transaction with `oldString cannot be empty` even when a valid
 * replacement is present. Entries carrying any unknown key remain untouched so
 * normal validation still reports misspelled real edits, and a one-sided edit
 * (empty oldString with real newString, or a real deletion) is kept so Zod
 * still surfaces the precise guidance.
 */
export function normalizeReplacementList(val: unknown): unknown {
  const replacements = coerceToArray(val)
  if (!Array.isArray(replacements)) return replacements

  return replacements.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    const record = entry as Record<string, unknown>
    if (
      Object.keys(record).some((key) => !REPLACEMENT_PLACEHOLDER_KEYS.has(key))
    ) {
      return true
    }

    const oldValue = firstDefinedReplacementString(record, [
      'oldString',
      'old',
      'old_str',
      'old_string',
    ])
    const newValue = firstDefinedReplacementString(record, [
      'newString',
      'new',
      'new_str',
      'new_string',
    ])

    const oldEmpty = oldValue === undefined || oldValue === ''
    const newEmpty = newValue === undefined || newValue === ''
    if (oldEmpty && newEmpty) return false

    return oldValue !== undefined || newValue !== undefined
  })
}

export const TRANSACTION_EDIT_TYPES = [
  'str_replace',
  'replace_range',
  'structured',
  'create',
  'delete',
  'move',
  'rewrite_symbol',
  'patch',
  'write_file',
] as const

const TRANSACTION_EDIT_TYPE_SET = new Set<string>(TRANSACTION_EDIT_TYPES)

function canonicalizeTransactionEditType(rawType: unknown): string | undefined {
  if (typeof rawType !== 'string') return undefined
  const normalized = rawType.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return TRANSACTION_EDIT_TYPE_SET.has(normalized) ? normalized : undefined
}

/**
 * Repairs omitted edit_transaction discriminators only when the payload shape
 * identifies exactly one operation. Ambiguous content-only edits remain
 * untouched because they could be create or write_file operations.
 */
export function normalizeTransactionEditList(val: unknown): unknown {
  const decoded = parseJsonBounded(val)
  // A malformed/truncated serialized array must fail at `edits` itself. Do
  // not wrap it as a one-element array, which produces the misleading
  // `edits[0] expected object, received string` diagnostic and encourages the
  // model to retry the same broken payload.
  if (typeof val === 'string' && typeof decoded === 'string') return decoded

  const edits = coerceToArray(decoded)
  if (!Array.isArray(edits)) return edits

  return edits.map((entry) => {
    const parsedEntry = parseJsonBounded(entry)
    if (
      parsedEntry === null ||
      typeof parsedEntry !== 'object' ||
      Array.isArray(parsedEntry)
    ) {
      return entry
    }

    const edit = parsedEntry as Record<string, unknown>
    if (
      typeof edit.type === 'string' &&
      TRANSACTION_EDIT_TYPE_SET.has(edit.type)
    ) {
      return parsedEntry
    }

    const candidateTypes: string[] = []
    if (edit.replacements !== undefined) candidateTypes.push('str_replace')
    if (edit.operation !== undefined) candidateTypes.push('structured')
    if (edit.destinationPath !== undefined) candidateTypes.push('move')
    if (edit.diff !== undefined) candidateTypes.push('patch')
    if (edit.symbol !== undefined && edit.content !== undefined) {
      candidateTypes.push('rewrite_symbol')
    } else if (edit.content !== undefined) {
      candidateTypes.push('create', 'write_file')
    }
    if (
      ((edit.startLine !== undefined &&
        edit.endLine !== undefined &&
        edit.expectedHash !== undefined) ||
        edit.readCapability !== undefined) &&
      edit.newContent !== undefined
    ) {
      candidateTypes.push('replace_range')
    }

    // Case/separator-only variant of a real type: canonicalize regardless of
    // shape (e.g. "Str-Replace" -> "str_replace").
    const canonicalType = canonicalizeTransactionEditType(edit.type)
    if (canonicalType) {
      return { ...edit, type: canonicalType }
    }

    // Omitted or genuinely-invalid type: infer only when the payload shape
    // identifies exactly one operation. Otherwise leave it for Zod to reject.
    return candidateTypes.length === 1
      ? { ...edit, type: candidateTypes[0] }
      : parsedEntry
  })
}

/** Only used for generating tool call strings before all tools are defined.
 *
 * @param toolName - The name of the tool to call
 * @param inputSchema - The zod schema for the tool. This is only used as type validation and is unused otherwise.
 * @param input - The input to the tool
 * @param endsAgentStep - Whether the agent should end its turn after this tool call
 */
export function $getToolCallString<Input>(params: {
  toolName: string
  inputSchema: z.ZodType<any, Input> | null
  input: Input
  endsAgentStep: boolean
}): string {
  const { toolName, input, endsAgentStep } = params
  const obj: Record<string, any> = {
    [toolNameParam]: toolName,
    ...input,
  }
  if (endsAgentStep) {
    obj[endsAgentStepParam] = endsAgentStep satisfies true
  }
  return [startToolTag, JSON.stringify(obj, null, 2), endToolTag].join('')
}

export function $getNativeToolCallExampleString<Input>(params: {
  toolName: string
  inputSchema: z.ZodType<any, Input> | null
  input: Input
  endsAgentStep?: boolean // unused
}): string {
  const { toolName, input } = params
  return [
    `<${toolName}_params_example>\n`,
    JSON.stringify(input, null, 2),
    `\n</${toolName}_params_example>`,
  ].join('')
}

/** Generates the zod schema for a single JSON tool result. */
export function jsonToolResultSchema<T extends JSONValue>(
  valueSchema: z.ZodType<T>,
) {
  return z.tuple([
    z.object({
      type: z.literal('json'),
      value: valueSchema,
    }) satisfies z.ZodType<ToolResultOutput>,
  ])
}

/** Generates the zod schema for an empty tool result. */
export function emptyToolResultSchema() {
  return z.tuple([])
}

/** Generates the zod schema for a simple text tool result. */
export function textToolResultSchema() {
  return z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }) satisfies z.ZodType<ToolResultOutput>,
  ])
}
