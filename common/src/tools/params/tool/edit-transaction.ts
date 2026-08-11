import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  isObviousEditPlaceholder,
  jsonToolResultSchema,
  normalizeReplacementAliases,
  normalizeReplacementList,
  normalizeTransactionEditList,
} from '../utils'
import { basedOnReadSchema, canonicalBasedOnReadSchema } from '../based-on-read'
import { fileMutationResultV1Schema } from '../../results/filesystem'
import { decodeReadCapabilityToken } from '../../../util/content-hash'
import {
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_INPUT_BYTES,
  MAX_TRANSACTION_UNIQUE_PATHS,
} from '../../../actions'

import { updateFileResultSchema } from './str-replace'

import type { $ToolParams } from '../../constants'

const replacementSchema = z.preprocess(
  normalizeReplacementAliases,
  z
    .object({
      oldString: z
        .string()
        .min(1, 'oldString cannot be empty')
        .describe(
          'The string to replace. This must match the current file content exactly unless the deterministic near-match guard can prove one safe target.',
        ),
      newString: z
        .string()
        .describe(
          'The string to replace the corresponding oldString with. Can be empty to delete.',
        ),
      allowMultiple: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether to allow multiple replacements of oldString.'),
      occurrenceIndex: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Optional 1-indexed exact occurrence to replace when oldString appears multiple times. Matches str_replace occurrenceIndex semantics and may be combined with basedOnRead to count only within an anchored range.',
        ),
      basedOnRead: basedOnReadSchema,
      skipIfMissing: z
        .boolean()
        .optional()
        .describe(
          'For deletion replacements only (newString is empty): treat a missing oldString as an already-applied no-op. Use only for explicit idempotent cleanup retries, never for ordinary edits.',
        ),
    })
    .strict()
    .superRefine((replacement, ctx) => {
      if (isObviousEditPlaceholder(replacement.oldString)) {
        ctx.addIssue({
          code: 'custom',
          path: ['oldString'],
          message:
            'oldString is an explicit placeholder, not file content. Copy exact current text from read_files or use a replace_range edit with a fresh readCapability.',
        })
      }
      if (isObviousEditPlaceholder(replacement.newString)) {
        ctx.addIssue({
          code: 'custom',
          path: ['newString'],
          message:
            'newString is an explicit placeholder, not replacement content. Provide the complete intended text.',
        })
      }
      if (replacement.skipIfMissing && replacement.newString !== '') {
        ctx.addIssue({
          code: 'custom',
          path: ['skipIfMissing'],
          message:
            'skipIfMissing is only valid for deletion replacements with an empty newString.',
        })
      }
    }),
)
const editBaseSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe('Optional stable edit identifier echoed in diagnostics.'),
  path: z.string().min(1, 'Path cannot be empty').describe('The file to edit.'),
})

const strReplaceEditSchema = editBaseSchema.extend({
  type: z.literal('str_replace').describe('The edit operation type.'),
  replacements: z
    .preprocess(
      normalizeReplacementList,
      z.array(replacementSchema).min(1, 'Replacements cannot be empty'),
    )
    .describe('String replacements to apply to this file.'),
})

const insertTextOperationSchema = z.object({
  kind: z.literal('insert_text').describe('Deterministic text insertion.'),
  position: z
    .object({
      line: z.number().int().min(1).describe('1-indexed target line.'),
      column: z.number().int().min(1).describe('1-indexed target column.'),
    })
    .describe('1-indexed insertion position.'),
  text: z.string().min(1, 'Inserted text cannot be empty'),
})

const insertImportOperationSchema = z.object({
  kind: z.literal('insert_import').describe('Language-aware import insertion.'),
  importStatement: z
    .string()
    .min(1, 'importStatement cannot be empty')
    .describe(
      'Complete language-native import statement to add, e.g. "import { foo } from \'bar\'", "from app import value", or "use crate::value".',
    ),
})

const removeImportOperationSchema = z
  .object({
    kind: z.literal('remove_import').describe('Language-aware import removal.'),
    importStatement: z
      .string()
      .min(1, 'importStatement cannot be empty')
      .optional()
      .describe(
        'Complete language-native import statement to remove. Required unless moduleSpecifier is provided.',
      ),
    moduleSpecifier: z
      .string()
      .min(1, 'moduleSpecifier cannot be empty')
      .optional()
      .describe(
        'Module specifier to remove imports from, e.g. "react" or "./helper".',
      ),
  })
  .refine(
    (operation) => operation.importStatement || operation.moduleSpecifier,
    {
      message: 'remove_import requires importStatement or moduleSpecifier',
    },
  )

const structuredEditSchema = editBaseSchema.extend({
  type: z
    .literal('structured')
    .describe('A structured edit dispatched by operation kind.'),
  operation: z
    .discriminatedUnion('kind', [
      insertTextOperationSchema,
      insertImportOperationSchema,
      removeImportOperationSchema,
    ])
    .describe('Structured edit operation to apply to this file.'),
})

const createFileEditSchema = editBaseSchema.extend({
  type: z.literal('create'),
  content: z
    .string()
    .refine((value) => !isObviousEditPlaceholder(value), {
      message: 'content is an explicit placeholder; provide exact file bytes.',
    })
    .describe('Exact bytes to write to the new file.'),
})

const deleteFileEditSchema = editBaseSchema.extend({
  type: z.literal('delete'),
})

const moveFileEditSchema = editBaseSchema.extend({
  type: z.literal('move'),
  destinationPath: z
    .string()
    .min(1, 'destinationPath cannot be empty')
    .describe('New project-relative path. The destination must be absent.'),
})

const replaceRangeEditSchema = editBaseSchema
  .extend({
    type: z.literal('replace_range'),
    readCapability: z
      .string()
      .min(1)
      .describe(
        'Target anchor copied verbatim from a fresh read_files editAnchor. It supplies the observed bounds and content hash.',
      ),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    occurrence: z
      .object({
        match: z.string().min(1),
        occurrence: z.number().int().min(1).optional(),
      })
      .strict()
      .optional()
      .describe(
        'Optional occurrence targeting: replace the 1-indexed occurrence (default 1) of the exact literal match found inside the capability-authorized range. Mutually exclusive with startLine/endLine.',
      ),
    newContent: z.string().refine((value) => !isObviousEditPlaceholder(value), {
      message:
        'newContent is an explicit placeholder; provide the complete range replacement.',
    }),
  })
  .strict()
  .superRefine((edit, ctx) => {
    const decoded = decodeReadCapabilityToken(edit.readCapability)
    if (typeof decoded === 'string' || decoded.tokenVersion !== 'v3') {
      ctx.addIssue({
        code: 'custom',
        path: ['readCapability'],
        message:
          typeof decoded === 'string'
            ? decoded
            : 'readCapability requires an authenticated project/path/run-bound cap.v3 token.',
      })
      return
    }
    const hasStart = edit.startLine !== undefined
    const hasEnd = edit.endLine !== undefined
    if (edit.occurrence && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurrence'],
        message:
          'occurrence is mutually exclusive with startLine/endLine. Provide occurrence alone to target a repeated literal block inside the capability range.',
      })
      return
    }
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide startLine and endLine together, or omit both.',
      })
      return
    }
    if (
      hasStart &&
      hasEnd &&
      (edit.startLine! < decoded.startLine ||
        edit.endLine! > decoded.endLine ||
        edit.startLine! > edit.endLine!)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Target lines must be contained within the readCapability range ${decoded.startLine}-${decoded.endLine}.`,
      })
    }
  })

const rewriteSymbolEditSchema = editBaseSchema.extend({
  type: z.literal('rewrite_symbol'),
  symbol: z.string().min(1),
  content: z.string().refine((value) => !isObviousEditPlaceholder(value), {
    message:
      'content is an explicit placeholder; provide the complete symbol source.',
  }),
  occurrence: z.number().int().positive().optional(),
  readCapability: basedOnReadSchema.describe(
    'Optional cap.v3 copied from the matching read_files symbol slice. It authorizes exactly the symbol and its contiguous preceding comment block.',
  ),
})

const patchEditSchema = editBaseSchema.extend({
  type: z.literal('patch'),
  diff: z
    .string()
    .min(1)
    .refine((value) => !isObviousEditPlaceholder(value), {
      message: 'diff is an explicit placeholder; provide the complete patch.',
    }),
})

const writeFileEditSchema = editBaseSchema.extend({
  type: z.literal('write_file'),
  content: z.string().refine((value) => !isObviousEditPlaceholder(value), {
    message: 'content is an explicit placeholder; provide exact file bytes.',
  }),
  basedOnRead: basedOnReadSchema.describe(
    'Optional whole-file-covering cap.v3 from a fresh complete whole-file read. Only a full-file capability with a hash matching current content may authorize overwrite; partial ranges never authorize write_file.',
  ),
})

export const transactionEditSchema = z.discriminatedUnion('type', [
  strReplaceEditSchema,
  structuredEditSchema,
  createFileEditSchema,
  deleteFileEditSchema,
  moveFileEditSchema,
  replaceRangeEditSchema,
  rewriteSymbolEditSchema,
  patchEditSchema,
  writeFileEditSchema,
])

const canonicalReplacementSchema = z
  .object({
    oldString: z.string().min(1),
    newString: z.string(),
    allowMultiple: z.boolean().optional().default(false),
    occurrenceIndex: z.number().int().min(1).optional(),
    basedOnRead: canonicalBasedOnReadSchema,
    skipIfMissing: z.boolean().optional(),
  })
  .strict()
const canonicalStrReplaceEditSchema = editBaseSchema.extend({
  type: z.literal('str_replace'),
  replacements: z.array(canonicalReplacementSchema).min(1),
})
const canonicalReplaceRangeEditSchema = editBaseSchema.extend({
  type: z.literal('replace_range'),
  readCapability: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  occurrence: z
    .object({
      match: z.string().min(1),
      occurrence: z.number().int().min(1).optional(),
    })
    .strict()
    .optional(),
  newContent: z.string(),
})
const providerTransactionEditSchema = z.discriminatedUnion('type', [
  canonicalStrReplaceEditSchema,
  structuredEditSchema,
  createFileEditSchema,
  deleteFileEditSchema,
  moveFileEditSchema,
  canonicalReplaceRangeEditSchema,
  rewriteSymbolEditSchema,
  patchEditSchema,
  writeFileEditSchema,
])

/**
 * Byte size of the model-supplied edit payload, summed per string field rather
 * than by serializing the whole array. `JSON.stringify` + `TextEncoder.encode`
 * would materialize two full copies of every successful transaction; the sum
 * below is an equivalent bound on payload content (structural JSON punctuation
 * is negligible against the limit) and allocates nothing.
 */
function transactionEditInputBytes(
  edit: z.infer<typeof transactionEditSchema>,
): number {
  let bytes = Buffer.byteLength(edit.type) + Buffer.byteLength(edit.path)
  if (edit.id) bytes += Buffer.byteLength(edit.id)
  switch (edit.type) {
    case 'str_replace':
      for (const replacement of edit.replacements) {
        bytes +=
          Buffer.byteLength(replacement.oldString) +
          Buffer.byteLength(replacement.newString)
        if (replacement.basedOnRead) {
          bytes += Buffer.byteLength(replacement.basedOnRead)
        }
      }
      return bytes
    case 'structured':
      if (edit.operation.kind === 'insert_text') {
        return bytes + Buffer.byteLength(edit.operation.text)
      }
      if (edit.operation.kind === 'insert_import') {
        return bytes + Buffer.byteLength(edit.operation.importStatement)
      }
      if (edit.operation.importStatement) {
        bytes += Buffer.byteLength(edit.operation.importStatement)
      }
      if (edit.operation.moduleSpecifier) {
        bytes += Buffer.byteLength(edit.operation.moduleSpecifier)
      }
      return bytes
    case 'create':
      return bytes + Buffer.byteLength(edit.content)
    case 'delete':
      return bytes
    case 'move':
      return bytes + Buffer.byteLength(edit.destinationPath)
    case 'replace_range':
      return (
        bytes +
        Buffer.byteLength(edit.readCapability) +
        Buffer.byteLength(edit.newContent) +
        (edit.occurrence ? Buffer.byteLength(edit.occurrence.match) : 0)
      )
    case 'rewrite_symbol':
      return (
        bytes +
        Buffer.byteLength(edit.symbol) +
        Buffer.byteLength(edit.content) +
        (edit.readCapability ? Buffer.byteLength(edit.readCapability) : 0)
      )
    case 'patch':
      return bytes + Buffer.byteLength(edit.diff)
    case 'write_file':
      return (
        bytes +
        Buffer.byteLength(edit.content) +
        (edit.basedOnRead ? Buffer.byteLength(edit.basedOnRead) : 0)
      )
  }
}

export const boundedTransactionEditListSchema = z
  .array(transactionEditSchema)
  // The edit-count bounds live here rather than as chained .min/.max because a
  // stringified `edits` payload fails the array type check, yet chained bounds
  // would still measure the string's character length and emit a misleading
  // "too many edits" diagnostic. superRefine only runs on a successfully parsed
  // array, so all three transaction bounds (count, unique paths, input bytes)
  // are evaluated in one place against real edits. The empty/oversized list
  // issues deliberately keep the `too_small`/`too_big` codes that chained
  // bounds emitted, so consumers branching on `issue.code` keep matching.
  .superRefine((edits, ctx) => {
    if (edits.length < 1) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'array',
        minimum: 1,
        inclusive: true,
        input: edits,
        message: 'Transaction edits cannot be empty',
      })
    }
    if (edits.length > MAX_FILE_CHANGES_PER_TRANSACTION) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'array',
        maximum: MAX_FILE_CHANGES_PER_TRANSACTION,
        inclusive: true,
        input: edits,
        message: `A transaction can contain at most ${MAX_FILE_CHANGES_PER_TRANSACTION} edits. Split larger changes into bounded transactions.`,
      })
    }
    const paths = new Set(
      edits.flatMap((edit) =>
        edit.type === 'move' ? [edit.path, edit.destinationPath] : [edit.path],
      ),
    )
    if (paths.size > MAX_TRANSACTION_UNIQUE_PATHS) {
      ctx.addIssue({
        code: 'custom',
        message: `A transaction can touch at most ${MAX_TRANSACTION_UNIQUE_PATHS} unique paths. Split larger changes into bounded transactions.`,
      })
    }
    let inputBytes = 0
    for (const edit of edits) inputBytes += transactionEditInputBytes(edit)
    if (inputBytes > MAX_TRANSACTION_INPUT_BYTES) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'array',
        maximum: MAX_TRANSACTION_INPUT_BYTES,
        inclusive: true,
        input: edits,
        message: `Transaction input exceeds the ${MAX_TRANSACTION_INPUT_BYTES}-byte limit. Split larger changes into bounded transactions.`,
      })
    }
  })

export const editTransactionResultSchema = z.union([
  fileMutationResultV1Schema,
  updateFileResultSchema,
  z.object({
    message: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        patch: z.string(),
        messages: z.array(z.string()),
      }),
    ),
  }),
  z.object({
    errorMessage: z.string(),
    failures: z.array(
      z.object({
        editIndex: z.number().int().min(-1),
        id: z.string().optional(),
        path: z.string(),
        errorMessage: z.string(),
        basedOnRead: basedOnReadSchema.optional().describe(
          'Ready-to-paste whole-file or recovery capability echoed on residual failures.',
        ),
        failureKind: z
          .enum([
            'capability_stale',
            'capability_scope',
            'capability_invalid',
            'no_match',
            'preflight_failed',
            'payload_truncated',
            'generic',
          ])
          .optional()
          .describe(
            'Structured classification of capability, match, or preflight failures; lets consumers classify without parsing errorMessage.',
          ),
      }),
    ),
    requiresFreshRead: z
      .boolean()
      .optional()
      .describe(
        'True when retrying this aborted transaction requires a fresh read of every recovery.paths target from one coherent snapshot.',
      ),
    errorCode: z
      .enum([
        'no_match',
        'stale_capability',
        'preflight_failed',
        'payload_truncated',
      ])
      .optional()
      .describe(
        'Compact machine-readable abort code models can key off without parsing errorMessage. payload_truncated means the tool-call argument payload was cut in transport (distinct from a genuine syntax preflight failure).',
      ),
    recovery: z
      .object({
        action: z.enum([
          'rebuild_whole_transaction',
          'read_again',
          'change_edit_strategy',
        ]),
        requiresFreshRead: z.boolean(),
        paths: z.array(z.string()).describe(
          'All unique transaction paths that must be re-read before rebuilding the whole aborting transaction.',
        ),
        failedEditIndex: z.number().int().min(0).optional(),
        failedReplacementIndex: z.number().int().min(0).optional(),
        preferredStrategy: z
          .enum(['replace_range', 'smaller_oldString', 'rewrite_symbol'])
          .optional(),
        tool: z.literal('read_files').optional(),
        input: z
          .object({
            paths: z.array(z.string()),
          })
          .optional(),
      })
      .optional()
      .describe(
        'Structured abort recovery packet. Additive; models should obey these fields when present without parsing prose.',
      ),
  }),
])

const toolName = 'edit_transaction'
const endsAgentStep = false
const inputSchema = z
  .object({
    edits: z
      .preprocess(
        normalizeTransactionEditList,
        boundedTransactionEditListSchema,
      )
      .describe(
        'All edits that must preflight together. Pass an actual array of edit objects; do not JSON.stringify the array or its entries. The runtime defensively decodes complete legacy JSON encodings, and payloads cut in transport are detected and may be recovered at a clean edit boundary when provably complete (otherwise they fail with a structured payload_truncated code rather than a misleading syntax error). An omitted type is inferred only when the payload shape identifies one unambiguous operation, such as replacements implying str_replace. If any edit fails during preflight, no files are changed.',
      ),
  })
  .describe(
    'Preflight related edits together, then apply them in one coordinated client-side transaction with deterministic order and explicit rollback outcomes.',
  )
const providerInputSchema = z.object({
  edits: z
    .array(providerTransactionEditSchema)
    .min(1)
    .max(MAX_FILE_CHANGES_PER_TRANSACTION),
})

const description = `
Use this tool when related edits across one or more files should be preflighted together before applying, such as updating a utility and its tests together.

Important:
- Pass edits as a real JSON array of objects. Never JSON.stringify the edits array or individual entries. Complete legacy encodings may be repaired, but truncated serialized payloads cannot be recovered safely.
- Never use prose placeholders such as "[see patch above]" in any edit. Each oldString must contain exact current file content and each newString/content/diff field must contain the complete intended bytes. Placeholder calls are rejected before they can consume a valid read authorization.
- The transaction preflights every edit against in-memory file contents first.
- If ANY edit fails during preflight, NO files are changed.
- Every per-file edit is atomic during preflight, including small files.
- Structured edits are dispatched deterministically by operation kind; supported operations include insert_text, insert_import, and remove_import.
- Select an edit type per operation: str_replace, replace_range, rewrite_symbol, patch, structured, create, delete, move, or write_file.
- Every replace_range edit uses one readCapability copied from a fresh read_files editAnchor. Omit startLine/endLine to replace the full observed range, or provide both to target a contained sub-range. Never pass expectedHash.
- Use insert_import/remove_import for TypeScript import-only changes; use the str_replace edit type for larger semantic changes.
- Large-file str_replace edits use deterministic exact-match semantics: unique oldString edits can apply without basedOnRead; ambiguous targets should use basedOnRead from fresh read_files.ranges output.
- Patches are applied as one coordinated client-side transaction after preflight. Commit failures trigger best-effort rollback and report rolled-back or rollback-incomplete outcomes; do not assume external filesystem atomicity.
- A transaction may contain one simple one-file edit or a coordinated multi-file change; this is the canonical model-facing mutation surface.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    edits: [
      {
        id: 'update-helper',
        type: 'str_replace',
        path: 'src/helper.ts',
        replacements: [
          {
            oldString: 'export const value = 1',
            newString: 'export const value = 2',
          },
        ],
      },
      {
        id: 'update-helper-test',
        type: 'str_replace',
        path: 'src/helper.test.ts',
        replacements: [
          {
            oldString: 'expect(value).toBe(1)',
            newString: 'expect(value).toBe(2)',
          },
        ],
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const editTransactionParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  providerInputSchema,
  outputSchema: jsonToolResultSchema(editTransactionResultSchema),
} satisfies $ToolParams
