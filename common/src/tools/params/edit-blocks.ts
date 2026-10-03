/**
 * Plain-text SEARCH/REPLACE edit-block parsing for edit_transaction
 * (PR-T4 wave 1). Enabled behind the default-off OPENBUFF_EDIT_BLOCKS env
 * flag; `normalizeTransactionEditList` translates successfully parsed blocks
 * into canonical str_replace edit objects at the preprocess seam.
 *
 * The parser is deliberately fail-closed and deterministic:
 * - A block is recognized only when its marker lines EXACTLY equal
 *   `<<<<<<< SEARCH`, `=======` (7 equals), and `>>>>>>> REPLACE`. Any other
 *   marker-like content (e.g. `<<<<<<< HEAD`, leading/trailing whitespace,
 *   wrong divider length) is never guessed into block structure.
 * - A valid block-mode payload is 100% block content: path lines and blocks
 *   only, with blank lines allowed between blocks. Any other text makes the
 *   whole input unparseable so the caller can fall back to the JSON pipeline
 *   and its structured diagnostics instead of guessing.
 * - Parsed block bodies that themselves contain marker-like lines are
 *   rejected as marker collisions, preventing content injection/confusion.
 * - Line endings: input may use \n or \r\n. Lines are split on \n with one
 *   trailing \r stripped per line; reconstructed bodies always join with \n
 *   so oldString/newString stay comparable against file content.
 *
 * Pure string logic: no fs, no runtime-only imports, no side effects.
 *
 * Known documented limitation (EB-SEC-2, security review 2026-09-28): a body
 * line that is exactly the divider in a CRLF payload is treated as the
 * divider because the trailing \r is stripped before marker comparison —
 * such a payload mis-segments instead of failing closed. Bounded impact
 * (oldString must still exact-match downstream; no authorization boundary is
 * crossed), pinned as a unit-test expectation. Block bodies therefore cannot
 * represent a line that is exactly '=======' in a CRLF file; payloads
 * containing such content must use the JSON path.
 */

import { MAX_TRANSACTION_INPUT_BYTES } from '../../actions'

const SEARCH_MARKER = '<<<<<<< SEARCH'
const DIVIDER_MARKER = '======='
const REPLACE_MARKER = '>>>>>>> REPLACE'

/** Any body line starting with one of these prefixes is a marker collision. */
const MARKER_PREFIXES = ['<<<<<<<', DIVIDER_MARKER, '>>>>>>>'] as const

export type EditBlockParseErrorCode = 'unparseable_block' | 'marker_collision'

export type EditBlockParseError = {
  code: EditBlockParseErrorCode
  message: string
  /** 0-based index of the block being parsed, when a block was identified. */
  blockIndex?: number
}

export type ParsedEditBlocks = Array<{
  path: string
  replacements: Array<{ oldString: string; newString: string }>
}>

export type ParseEditBlocksResult =
  | { edits: ParsedEditBlocks }
  | { error: EditBlockParseError }

const EDIT_BLOCKS_ENV_VAR = 'OPENBUFF_EDIT_BLOCKS'
/** Truthy set mirrored from OPENBUFF_COLLECT_FULL_FILE_CONTEXT handling. */
const TRUTHY_ENV_PATTERN = /^(1|true|yes|on)$/i

let cachedEditBlocksEnabled: boolean | null = null

function readEditBlocksEnvFlag(): boolean {
  const envValue = process.env[EDIT_BLOCKS_ENV_VAR]
  if (envValue === undefined) {
    return false
  }
  return TRUTHY_ENV_PATTERN.test(envValue.trim())
}

/**
 * Whether plain-text edit-block input is accepted for edit_transaction.
 * The flag is cached at first call; wave 1 has no config-file fallback.
 */
export function areEditBlocksEnabled(): boolean {
  if (cachedEditBlocksEnabled === null) {
    cachedEditBlocksEnabled = readEditBlocksEnvFlag()
  }
  return cachedEditBlocksEnabled
}

/**
 * Test override for the cached flag. `undefined` clears the cache so the
 * next areEditBlocksEnabled() call re-reads the environment variable.
 */
export function __setEditBlocksEnabledForTest(
  enabled: boolean | undefined,
): void {
  cachedEditBlocksEnabled = enabled === undefined ? null : enabled
}

function lineStartsWithMarkerPrefix(line: string): boolean {
  return MARKER_PREFIXES.some((prefix) => line.startsWith(prefix))
}

/** Bounded, quoted rendering of an offending line for error messages. */
function describeOffendingLine(line: string): string {
  const truncated = line.length > 80 ? `${line.slice(0, 77)}...` : line
  return JSON.stringify(truncated)
}

export function parseEditBlocks(text: string): ParseEditBlocksResult {
  // EB-SEC-1 (security review 2026-09-28): fail closed BEFORE materializing
  // the line array. The parser is linear and allocates ~2-3x the input, so a
  // cap derived from the transaction input bound prevents oversized tool-arg
  // strings from being split before any other bound applies. The error is
  // deliberately unparseable_block: the payload was not valid block content
  // at this size, and the caller's JSON pipeline (or its existing size
  // diagnostics) stays authoritative.
  if (text.length > MAX_TRANSACTION_INPUT_BYTES) {
    return {
      error: {
        code: 'unparseable_block',
        message: `Block payload exceeds the ${MAX_TRANSACTION_INPUT_BYTES}-byte transaction input limit; use the JSON path for oversized payloads.`,
      },
    }
  }
  // Split on \n and strip exactly one trailing \r per line so \r\n input
  // parses; reconstructed bodies always join with \n (see module doc).
  const lines = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  const edits: ParsedEditBlocks = []
  let lineIndex = 0
  let blockIndex = 0

  const fail = (
    code: EditBlockParseErrorCode,
    message: string,
    withBlockIndex?: number,
  ): { error: EditBlockParseError } => ({
    error:
      withBlockIndex === undefined
        ? { code, message }
        : { code, message, blockIndex: withBlockIndex },
  })

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]
    // Blank lines are allowed between blocks (and around the payload) but
    // never inside a block's marker structure.
    if (line === '') {
      lineIndex++
      continue
    }
    // Top-level marker-like lines cannot start a block (the path line comes
    // first) and are never guessed into block structure.
    if (lineStartsWithMarkerPrefix(line)) {
      return fail(
        'unparseable_block',
        `Line ${lineIndex + 1} is not valid block content: ${describeOffendingLine(line)}`,
      )
    }

    const path = line
    const currentBlockIndex = blockIndex
    lineIndex++

    // The line immediately after a path line must be the exact SEARCH
    // marker; anything else (including marker variants like `<<<<<<< HEAD`,
    // double spaces, or leading whitespace) is not a block and fails closed.
    if (lineIndex >= lines.length || lines[lineIndex] !== SEARCH_MARKER) {
      const found =
        lineIndex < lines.length
          ? `; found ${describeOffendingLine(lines[lineIndex])}`
          : ' (unexpected end of input)'
      return fail(
        'unparseable_block',
        `Block ${currentBlockIndex} for path ${JSON.stringify(path)} is missing the exact "${SEARCH_MARKER}" marker line${found}`,
        currentBlockIndex,
      )
    }
    lineIndex++

    // SEARCH body: every line up to the exact divider. A body line starting
    // with any marker prefix that is not the expected next marker is a
    // collision (content injection/confusion), never body content.
    const searchBodyLines: string[] = []
    while (lineIndex < lines.length && lines[lineIndex] !== DIVIDER_MARKER) {
      const bodyLine = lines[lineIndex]
      if (lineStartsWithMarkerPrefix(bodyLine)) {
        return fail(
          'marker_collision',
          `Block ${currentBlockIndex} SEARCH body contains a marker-like line: ${describeOffendingLine(bodyLine)}`,
          currentBlockIndex,
        )
      }
      searchBodyLines.push(bodyLine)
      lineIndex++
    }
    if (lineIndex >= lines.length) {
      return fail(
        'unparseable_block',
        `Block ${currentBlockIndex} is missing the exact "${DIVIDER_MARKER}" divider line`,
        currentBlockIndex,
      )
    }
    if (searchBodyLines.length === 0) {
      return fail(
        'unparseable_block',
        `Block ${currentBlockIndex} has an empty SEARCH body; oldString cannot be empty`,
        currentBlockIndex,
      )
    }
    lineIndex++ // past the divider

    // REPLACE body: every line up to the exact REPLACE marker. The literal
    // divider text inside a body is itself a marker collision.
    const replaceBodyLines: string[] = []
    while (lineIndex < lines.length && lines[lineIndex] !== REPLACE_MARKER) {
      const bodyLine = lines[lineIndex]
      if (lineStartsWithMarkerPrefix(bodyLine)) {
        return fail(
          'marker_collision',
          `Block ${currentBlockIndex} REPLACE body contains a marker-like line: ${describeOffendingLine(bodyLine)}`,
          currentBlockIndex,
        )
      }
      replaceBodyLines.push(bodyLine)
      lineIndex++
    }
    if (lineIndex >= lines.length) {
      return fail(
        'unparseable_block',
        `Block ${currentBlockIndex} is missing the exact "${REPLACE_MARKER}" marker line`,
        currentBlockIndex,
      )
    }
    lineIndex++ // past the REPLACE marker
    blockIndex++

    const oldString = searchBodyLines.join('\n')
    const newString = replaceBodyLines.join('\n')

    // Consecutive blocks for the same path coalesce into one edit; a
    // different path starts a new edit.
    const lastEdit = edits[edits.length - 1]
    if (lastEdit && lastEdit.path === path) {
      lastEdit.replacements.push({ oldString, newString })
    } else {
      edits.push({ path, replacements: [{ oldString, newString }] })
    }
  }

  return { edits }
}
