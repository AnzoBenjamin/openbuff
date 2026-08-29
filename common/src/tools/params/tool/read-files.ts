import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToArray,
  jsonToolResultSchema,
} from '../utils'
import {
  READ_FILES_BLOCK_CONTENT_MAX_BYTES,
  readFilesResultV1Schema,
  readFilesSliceSchema,
} from '../../results/filesystem'
import type { $ToolParams } from '../../constants'

const DEFAULT_WINDOW_SIZE = 400
const DEFAULT_CONTEXT_LINES = 40

export const MAX_WINDOW_SIZE = 5_000
export const MAX_CONTEXT_LINES = 2_000
/**
 * Byte budget enforced independently on each window/around/symbol block payload
 * (the decorated `content` and the exact `sourceContent`), not on their sum.
 * Re-exported from the result contract so the budget documented in the tool
 * description cannot drift from the bound enforced on block result items.
 */
export const MAX_READ_BLOCK_BYTES = READ_FILES_BLOCK_CONTENT_MAX_BYTES

export const readFilesWindowSelectorSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File path to read in contiguous line windows, relative to the project root.',
    ),
  windowSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_WINDOW_SIZE)
    .optional()
    .describe(
      `Lines per window. Defaults to ${DEFAULT_WINDOW_SIZE}, capped at ${MAX_WINDOW_SIZE}.`,
    ),
  window: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      '1-indexed window number to return. Omit to get the window manifest (totalLines, windowSize, windowCount) plus the first window.',
    ),
})

export const readFilesAroundSelectorSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File path to read a content-anchored block from, relative to the project root.',
    ),
  match: z
    .string()
    .min(1)
    .describe(
      'Exact literal string to anchor on. Robust to line-number drift.',
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-indexed occurrence of `match` to anchor on. Defaults to 1.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_LINES)
    .optional()
    .describe(
      `Lines of context to include on each side of the match, clamped at file boundaries. Defaults to ${DEFAULT_CONTEXT_LINES}, capped at ${MAX_CONTEXT_LINES}.`,
    ),
})

export const readFilesSymbolSelectorSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File path to extract a symbol slice from, relative to the project root.',
    ),
  name: z
    .string()
    .min(1)
    .describe(
      'Top-level symbol name (function, class, interface, method) to pull, as shown by read_outline.',
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'When multiple top-level symbols share this name, the 1-indexed one to return. Defaults to 1. Matches rewrite_symbol occurrence semantics.',
    ),
})

export const fileContentsSchema = z.union([
  z.object({
    summary: z.object({
      ok: z.number(),
      failed: z.number(),
      requested: z.number(),
    }),
  }),
  z.object({
    path: z.string(),
    content: z.string(),
    referencedBy: z.record(z.string(), z.string().array()).optional(),
  }),
  z.object({
    path: z.string(),
    contentOmittedForLength: z.literal(true),
  }),
  z.object({
    path: z.string(),
    slices: z.array(readFilesSliceSchema),
    errorMessage: z.string().optional(),
  }),
])

const toolName = 'read_files'
const endsAgentStep = true
/** Selector arrays a transport may have stringified and split on commas. */
const FRAGMENTED_SELECTOR_KEYS = [
  'ranges',
  'windows',
  'around',
  'symbol',
  'symbols',
] as const

const decodeFragmentedSelectors = (input: unknown): unknown => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const repaired: Record<string, unknown> = { ...record }
  let decodedAny = false
  for (const key of FRAGMENTED_SELECTOR_KEYS) {
    const selectors = record[key]
    if (!Array.isArray(selectors) || selectors.length === 0) continue
    if (!selectors.every((value) => typeof value === 'string')) continue

    const encoded = (selectors as string[]).join(',')
    try {
      const decoded = JSON.parse(encoded) as unknown
      if (!Array.isArray(decoded)) continue
      repaired[key] = decoded
      decodedAny = true
    } catch {
      continue
    }
  }
  return decodedAny ? repaired : input
}

const inferSingleSelectorPath = (input: unknown): unknown => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const paths = Array.isArray(record.paths)
    ? record.paths
    : typeof record.paths === 'string'
      ? [record.paths]
      : []
  if (paths.length !== 1 || typeof paths[0] !== 'string') return input
  let inferredPath = false
  const inferPath = (selectors: unknown): unknown => {
    const coerced = coerceToArray(selectors)
    if (!Array.isArray(coerced)) return selectors
    return coerced.map((selector) => {
      if (
        !selector ||
        typeof selector !== 'object' ||
        Array.isArray(selector)
      ) {
        return selector
      }
      const selectorRecord = selector as Record<string, unknown>
      if (selectorRecord.path !== undefined) return selector
      inferredPath = true
      return { ...selectorRecord, path: paths[0] }
    })
  }
  const ranges = inferPath(record.ranges)
  const windows = inferPath(record.windows)
  const around = inferPath(record.around)
  const symbol = inferPath(record.symbol)
  const symbols = inferPath(record.symbols)
  if (!inferredPath) return input

  // The sole path is acting as shorthand for the scoped selector, not as a
  // second whole-file selector. This also recovers the common model shape
  // `{ paths: [file], symbols: [{ names }] }` without weakening ambiguous
  // multi-file validation.
  return { ...record, paths: [], ranges, windows, around, symbol, symbols }
}

const inputSchema = z
  .preprocess(
    (input) => inferSingleSelectorPath(decodeFragmentedSelectors(input)),
    z.object({
      paths: z
        .preprocess(
          coerceToArray,
          z.array(
            z
              .string()
              .min(1, 'Paths cannot be empty')
              .describe(
                'File path relative to the project root (absolute paths fail).',
              ),
          ),
        )
        .optional()
        .default([])
        .describe(
          'Whole-file paths to read. Complete results include editAnchor.readCapability for follow-up edits.',
        ),
      ranges: z
        .array(
          z.object({
            path: z.string().min(1).describe('Project-relative file path.'),
            startLine: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('1-indexed inclusive start line. Defaults to 1.'),
            endLine: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                '1-indexed inclusive end line. Defaults to the last line.',
              ),
          }),
        )
        .optional()
        .describe(
          '1-indexed inclusive line ranges. Sole `paths` entry infers missing path.',
        ),
      windows: z
        .preprocess(coerceToArray, z.array(readFilesWindowSelectorSchema))
        .optional()
        .describe(
          'Contiguous line windows; each complete window mints a scoped cap.v3 editAnchor.',
        ),
      around: z
        .preprocess(coerceToArray, z.array(readFilesAroundSelectorSchema))
        .optional()
        .describe(
          'Literal-anchored context blocks with a scoped cap.v3 editAnchor per block.',
        ),
      symbol: z
        .preprocess(coerceToArray, z.array(readFilesSymbolSelectorSchema))
        .optional()
        .describe(
          'Nth top-level symbol by name (rewrite_symbol occurrence semantics); prefer batch `symbols` when possible.',
        ),
      symbols: z
        .array(
          z.object({
            path: z.string().min(1).describe('Project-relative file path.'),
            names: z
              .preprocess(coerceToArray, z.array(z.string().min(1)))
              .describe('Symbol names to slice.'),
          }),
        )
        .optional()
        .describe(
          'Named symbol slices with editAnchors; prefer over full reads when names are known.',
        ),
    }),
  )
  .superRefine((value, ctx) => {
    if (
      value.paths.length === 0 &&
      (value.ranges?.length ?? 0) === 0 &&
      (value.windows?.length ?? 0) === 0 &&
      (value.around?.length ?? 0) === 0 &&
      (value.symbol?.length ?? 0) === 0 &&
      (value.symbols?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message:
          'read_files requires at least one path, range, window, around, symbol, or symbols selector.',
      })
    }
  })
  .describe(
    `Read multiple files from disk and return their contents. Use this tool to read as many files as would be helpful to answer the user's request.`,
  )
const description = `
Read files from disk. Prefer ranges/windows/around/symbol slices over full reads before editing large files.

- Selectors (combinable): \`paths\`, \`ranges\`, \`windows\`, \`around\`, \`symbol\`, \`symbols\`.
- Complete reads return one editAnchor (startLine, endLine, contentHash, cap.v3 readCapability). Copy editAnchor.readCapability verbatim to basedOnRead/readCapability; other fields are diagnostics only.
- Authority: whole-file-covering reads grant sticky whole-file auth; complete sub-file blocks mint a scoped cap.v3 for that block only. Partial/truncated reads mint nothing — do not edit from truncated content.
- \`windows\`: contiguous line windows (default size 400); omit \`window\` for manifest + first window.
- \`around\`: Nth literal \`match\` + contextLines (default 40).
- \`symbol\` / \`symbols\`: named top-level slices (pair with read_outline). Prefer batch \`symbols\`; use \`symbol\` for a specific occurrence.
- Block budget: each window/around/symbol payload (decorated content and sourceContent independently) is capped at ${MAX_READ_BLOCK_BYTES} bytes; oversize blocks return \`too_large\` (shrink windowSize/contextLines).
- Prefer replace_range with readCapability for medium/large blocks; for large-file str_replace copy readCapability into basedOnRead. Range results include sourceContent for exact oldString text.
`.trim()
export const readFilesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([readFilesResultV1Schema, fileContentsSchema.array()]),
  ),
} satisfies $ToolParams
