import z from 'zod/v4'

import {
  decodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
  type ReadCapabilityScope,
} from '../../util/content-hash'

export const FILESYSTEM_RESULT_CONTENT_MAX_BYTES = 10 * 1024 * 1024
export const FILESYSTEM_RESULT_AGGREGATE_CONTENT_MAX_BYTES = 20 * 1024 * 1024
export const FILESYSTEM_RESULT_MAX_ACTIONS = 128
export const FILESYSTEM_RESULT_MAX_CAPABILITIES = 128

const boundedMutationContentSchema = z
  .string()
  .max(FILESYSTEM_RESULT_CONTENT_MAX_BYTES)
  .refine(
    (content) =>
      new TextEncoder().encode(content).byteLength <=
      FILESYSTEM_RESULT_CONTENT_MAX_BYTES,
    'mutation content exceeds the per-action byte limit',
  )

export const filesystemErrorCodeSchema = z.enum([
  'not_found',
  'blocked',
  'outside_project',
  'too_large',
  'io_error',
  'invalid_request',
  'stale_read',
  'no_match',
  'ambiguous_match',
  'application_rejected',
  'already_exists',
  'binary',
  'unsupported_encoding',
  'cancelled',
  'malformed_result',
  'stale_state',
  'rollback_incomplete',
  'illegal_transition',
  'unsupported',
  'resource_limit',
])

export const filesystemErrorSchema = z.object({
  code: filesystemErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  requiresFreshRead: z.boolean().optional(),
  recovery: z
    .enum([
      'discover_path',
      'read_again',
      'read_smaller_range',
      'choose_symbol',
      'change_edit_strategy',
      'choose_new_path',
      'use_supported_encoding',
      'retry',
      'inspect_rollback',
      'fix_result',
      'split_transaction',
    ])
    .optional(),
})

export const toolLifecycleStateV1Schema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export const toolLifecycleV1Schema = z.object({
  kind: z.literal('tool_lifecycle'),
  version: z.literal(1),
  callId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  state: toolLifecycleStateV1Schema,
})

export const nativeToolResultErrorV1Schema = z.object({
  kind: z.literal('native_tool_result_error'),
  version: z.literal(1),
  toolName: z.string().min(1),
  lifecycle: toolLifecycleV1Schema,
  error: filesystemErrorSchema,
  issueCount: z.number().int().nonnegative(),
})

export const nativeToolResultErrorOutputV1Schema = z.tuple([
  z.object({
    type: z.literal('json'),
    value: nativeToolResultErrorV1Schema,
  }),
])

export const authorityCapabilityTierSchema = z.enum([
  'portable_path',
  'conditional_commit',
])

export const fileSnapshotV1Schema = z.object({
  kind: z.literal('file_snapshot'),
  version: z.literal(1),
  canonicalPath: z.string().min(1),
  contentHash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'binary', 'unsupported']),
  readGeneration: z.number().int().nonnegative(),
})

const fileCapabilityBaseV1Schema = z.object({
  version: z.literal(1),
  token: z
    .string()
    .min(1)
    .describe(
      'Fresh opaque read capability for the snapshot. Active cap.v3 tokens are authenticated and bound to the issuing project, path, and run; copy them verbatim only to the matching edit target.',
    ),
  snapshot: fileSnapshotV1Schema,
})

export const wholeFileCapabilityV1Schema = fileCapabilityBaseV1Schema.extend({
  kind: z.literal('whole_file'),
})

export const rangeCapabilityV1Schema = fileCapabilityBaseV1Schema
  .extend({
    kind: z.literal('range'),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    rangeHash: z.string().min(1),
    symbol: z.string().min(1).optional(),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: 'range capability endLine must be at or after startLine',
  })

export const readOnlyCapabilityV1Schema = fileCapabilityBaseV1Schema.extend({
  kind: z.literal('read_only'),
  provenance: z.enum(['full_file', 'range', 'symbol', 'heuristic']),
})

export const fileCapabilityV1Schema = z.union([
  wholeFileCapabilityV1Schema,
  rangeCapabilityV1Schema,
  readOnlyCapabilityV1Schema,
])

export const readFilesEditAnchorSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  readCapability: z.string().min(1),
})

export const fileActionKindV1Schema = z.enum([
  'create',
  'update',
  'delete',
  'move',
])

export const mutationActionOutcomeV1Schema = z.enum([
  'applied',
  'not_applied',
  'rolled_back',
  'rollback_incomplete',
  'unconfirmed',
])

export const fileMutationActionV1Schema = z
  .object({
    actionId: z.string().min(1),
    index: z.number().int().nonnegative(),
    action: fileActionKindV1Schema,
    path: z.string().min(1),
    destinationPath: z.string().min(1).optional(),
    outcome: mutationActionOutcomeV1Schema,
    beforeHash: z.string().min(1).nullable(),
    afterHash: z.string().min(1).nullable(),
    afterContent: boundedMutationContentSchema.optional(),
    editAnchor: readFilesEditAnchorSchema.optional(),
    patch: boundedMutationContentSchema.optional(),
    error: filesystemErrorSchema.optional(),
    rollback: z
      .object({
        attempted: z.boolean(),
        succeeded: z.boolean(),
        error: filesystemErrorSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'move' && !value.destinationPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'move actions require destinationPath',
      })
    }
    if (value.action !== 'move' && value.destinationPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'only move actions may include destinationPath',
      })
    }
    if (value.afterHash === null && value.afterContent !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'actions without an afterHash cannot include afterContent',
      })
    }
    if (
      value.afterContent !== undefined &&
      getExactContentHash(value.afterContent) !== value.afterHash
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'action afterContent must match afterHash',
      })
    }
    if (
      (value.editAnchor !== undefined) !== (value.afterContent !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'action afterContent and editAnchor must be exposed or omitted together',
      })
    }
    if (
      value.editAnchor &&
      (value.outcome !== 'applied' ||
        value.action === 'delete' ||
        value.editAnchor.startLine !== 1 ||
        value.editAnchor.endLine !==
          normalizeLineEndings(value.afterContent ?? '').split('\n').length ||
        value.editAnchor.contentHash !== getContentHash(value.afterContent ?? ''))
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'action editAnchor must describe the complete visible applied text',
      })
    }
  })

export const fileMutationOutcomeV1Schema = z.enum([
  'applied',
  'not_applied',
  'partial',
  'rolled_back',
  'rollback_incomplete',
  'unconfirmed',
])

export const fileMutationResultV1Schema = z
  .object({
    kind: z.literal('file_mutation_result'),
    version: z.literal(1),
    operationId: z.string().min(1),
    outcome: fileMutationOutcomeV1Schema,
    actions: fileMutationActionV1Schema
      .array()
      .max(FILESYSTEM_RESULT_MAX_ACTIONS),
    authorityTier: authorityCapabilityTierSchema.nullable(),
    receiptId: z.string().min(1).optional(),
    workspaceRevision: z.number().int().nonnegative().optional(),
    workspaceSnapshotId: z.string().min(1).optional(),
    authorityReceipt: z.lazy(() => commitReceiptV1Schema).optional(),
    errors: filesystemErrorSchema.array(),
    freshCapabilities: fileCapabilityV1Schema
      .array()
      .max(FILESYSTEM_RESULT_MAX_CAPABILITIES),
  })
  .superRefine((value, ctx) => {
    if (value.actions.some((action, index) => action.index !== index)) {
      ctx.addIssue({
        code: 'custom',
        message: 'mutation action indexes must be contiguous and ordered',
      })
    }

    const outcomes = value.actions.map((action) => action.outcome)
    const applied = outcomes.filter((outcome) => outcome === 'applied').length
    const rollbackIncomplete = outcomes.filter(
      (outcome) => outcome === 'rollback_incomplete',
    ).length

    if (
      (value.outcome === 'applied' &&
        (outcomes.length === 0 || applied !== outcomes.length)) ||
      (value.outcome === 'not_applied' &&
        outcomes.some((outcome) => outcome !== 'not_applied')) ||
      (value.outcome === 'partial' &&
        (applied === 0 || applied === outcomes.length)) ||
      (value.outcome === 'rolled_back' &&
        (outcomes.length === 0 ||
          !outcomes.includes('rolled_back') ||
          outcomes.some(
            (outcome) => outcome !== 'rolled_back' && outcome !== 'not_applied',
          ))) ||
      (value.outcome === 'rollback_incomplete' &&
        applied + rollbackIncomplete === 0) ||
      (value.outcome === 'unconfirmed' &&
        outcomes.some((outcome) => outcome !== 'unconfirmed'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'mutation aggregate outcome does not match action outcomes',
      })
    }

    if (
      value.outcome !== 'applied' &&
      (value.freshCapabilities.length > 0 ||
        value.actions.some(
          (action) =>
            action.afterContent !== undefined || action.editAnchor !== undefined,
        ))
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'only fully applied mutations may expose post-edit content or capabilities',
      })
    }
    if (
      value.freshCapabilities.some(
        (capability) =>
          capability.kind === 'whole_file' &&
          !value.actions.some(
            (action) =>
              action.outcome === 'applied' &&
              action.editAnchor?.readCapability === capability.token,
          ),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'whole-file fresh capabilities require a matching action anchor',
      })
    }

    if (value.authorityTier === null && value.receiptId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'receipt-backed mutations require an authority tier',
      })
    }
    if (
      value.outcome !== 'unconfirmed' &&
      value.outcome !== 'not_applied' &&
      value.authorityTier === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'applied or rollback mutation outcomes require an authority tier',
      })
    }
    if (
      value.authorityReceipt &&
      (value.authorityReceipt.operationId !== value.operationId ||
        value.authorityReceipt.receiptId !== value.receiptId ||
        value.authorityReceipt.authorityTier !== value.authorityTier ||
        value.authorityReceipt.actions.length !== value.actions.length ||
        value.actions.some((action, index) => {
          const receiptAction = value.authorityReceipt!.actions[index]
          return (
            !receiptAction ||
            receiptAction.actionId !== action.actionId ||
            receiptAction.index !== action.index ||
            receiptAction.action !== action.action ||
            receiptAction.path !== action.path ||
            receiptAction.destinationPath !== action.destinationPath ||
            receiptAction.beforeHash !== action.beforeHash ||
            receiptAction.afterHash !== action.afterHash
          )
        }))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'mutation result does not correlate to its authority receipt',
      })
    }
  })

export const commitActionStatusV1Schema = z.enum([
  'not_started',
  'committed',
  'failed',
  'rolled_back',
  'rollback_failed',
])

export const commitActionReceiptV1Schema = z
  .object({
    actionId: z.string().min(1),
    index: z.number().int().nonnegative(),
    action: fileActionKindV1Schema,
    path: z.string().min(1),
    destinationPath: z.string().min(1).optional(),
    status: commitActionStatusV1Schema,
    beforeHash: z.string().min(1).nullable(),
    afterHash: z.string().min(1).nullable(),
    error: filesystemErrorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.action === 'move') !== (value.destinationPath !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'commit receipt move actions require destinationPath',
      })
    }
  })

export const commitReceiptStatusV1Schema = z.enum([
  'not_started',
  'committed',
  'failed',
  'rolled_back',
  'rollback_incomplete',
])

export const commitReceiptV1Schema = z
  .object({
    kind: z.literal('commit_receipt'),
    version: z.literal(1),
    receiptId: z.string().min(1),
    operationId: z.string().min(1),
    callId: z.string().min(1),
    authorityTier: authorityCapabilityTierSchema,
    status: commitReceiptStatusV1Schema,
    actions: commitActionReceiptV1Schema
      .array()
      .max(FILESYSTEM_RESULT_MAX_ACTIONS),
    finalHashes: z.record(z.string(), z.string().min(1).nullable()),
    workspaceRevision: z.number().int().nonnegative().optional(),
    workspaceSnapshotId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.actions.some((action, index) => action.index !== index)) {
      ctx.addIssue({
        code: 'custom',
        message: 'commit action indexes must be contiguous and ordered',
      })
    }
    if (value.actions.some((action) => action.actionId.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'commit action IDs must be nonempty',
      })
    }
    if (
      new Set(value.actions.map((action) => action.actionId)).size !==
      value.actions.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'commit action IDs must be unique',
      })
    }

    const statuses = value.actions.map((action) => action.status)
    const invalid =
      (value.status === 'not_started' &&
        statuses.some(
          (status) => status !== 'not_started' && status !== 'failed',
        )) ||
      (value.status === 'committed' &&
        (statuses.length === 0 ||
          statuses.some((status) => status !== 'committed'))) ||
      (value.status === 'failed' && !statuses.includes('failed')) ||
      (value.status === 'rolled_back' &&
        (statuses.length === 0 ||
          !statuses.includes('rolled_back') ||
          statuses.some(
            (status) =>
              status !== 'rolled_back' &&
              status !== 'not_started' &&
              status !== 'failed',
          ))) ||
      (value.status === 'rollback_incomplete' &&
        !statuses.some(
          (status) => status === 'committed' || status === 'rollback_failed',
        ))

    if (invalid) {
      ctx.addIssue({
        code: 'custom',
        message: 'commit receipt status does not match action receipts',
      })
    }
  })

export const readFilesSliceSchema = z
  .object({
    symbol: z.string(),
    kind: z.string().optional(),
    content: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    editAnchor: readFilesEditAnchorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.editAnchor &&
      (value.editAnchor.startLine !== value.startLine ||
        value.editAnchor.endLine !== value.endLine)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'symbol editAnchor must match the slice bounds',
      })
    }
  })

const readFilesErrorItemSchema = z.object({
  selector: z.enum(['file', 'range', 'symbols', 'window', 'around', 'symbol']),
  requestIndex: z.number().int().nonnegative(),
  path: z.string(),
  status: z.literal('error'),
  error: filesystemErrorSchema,
})

/** Referencing modules surfaced alongside a read result (R5). */
const readReferencedBySchema = z.record(z.string(), z.string().array())

const readFilesFileItemSchema = z
  .object({
    selector: z.literal('file'),
    requestIndex: z.number().int().nonnegative(),
    path: z.string(),
    status: z.enum(['ok', 'partial']),
    content: z.string().optional(),
    contentOmittedForLength: z.literal(true).optional(),
    complete: z.boolean(),
    template: z.boolean(),
    editAnchor: readFilesEditAnchorSchema.optional(),
    referencedBy: readReferencedBySchema.optional(),
    truncation: z
      .object({
        reason: z.literal('character_limit'),
        omittedStartLine: z.number().int().positive().optional(),
        omittedEndLine: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (typeof value.content === 'string') !==
      (value.contentOmittedForLength === true),
    'read_files file results require exactly one content payload or omission marker',
  )
  .refine(
    (value) => value.complete || value.editAnchor === undefined,
    'partial file results cannot expose edit capabilities',
  )

const readFilesRangeItemSchema = z
  .object({
    selector: z.literal('range'),
    requestIndex: z.number().int().nonnegative(),
    path: z.string(),
    status: z.enum(['ok', 'partial']),
    content: z.string().optional(),
    /** Exact undecorated normalized source text for deterministic follow-up edits. */
    sourceContent: z.string().optional(),
    contentOmittedForLength: z.literal(true).optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    totalLines: z.number().int().nonnegative(),
    complete: z.boolean(),
    editAnchor: readFilesEditAnchorSchema.optional(),
    referencedBy: readReferencedBySchema.optional(),
    truncation: z.object({ reason: z.literal('character_limit') }).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (typeof value.content === 'string') !==
      (value.contentOmittedForLength === true),
    'read_files range results require exactly one content payload or omission marker',
  )
  .superRefine((value, ctx) => {
    if (
      value.editAnchor &&
      (value.editAnchor.startLine !== value.startLine ||
        value.editAnchor.endLine !== value.endLine)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'range editAnchor must match the range bounds',
      })
    }
  })

const readFilesSymbolsItemSchema = z
  .object({
    selector: z.literal('symbols'),
    requestIndex: z.number().int().nonnegative(),
    path: z.string(),
    status: z.enum(['ok', 'partial']),
    requestedSymbols: z.string().array(),
    missingSymbols: z.string().array(),
    slices: readFilesSliceSchema.array().optional(),
    slicesOmittedForLength: z.literal(true).optional(),
  })
  .refine(
    (value) =>
      Array.isArray(value.slices) !== (value.slicesOmittedForLength === true),
    'read_files symbol results require exactly one slices payload or omission marker',
  )

const readBlocksBlockBaseFields = {
  requestIndex: z.number().int().nonnegative(),
  path: z.string(),
  status: z.enum(['ok', 'partial']),
  content: z.string(),
  /** Exact undecorated normalized block text for deterministic follow-up edits. */
  sourceContent: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  complete: z.boolean(),
  editAnchor: readFilesEditAnchorSchema.optional(),
  referencedBy: readReferencedBySchema.optional(),
} as const

const readBlocksBlockSuperRefine = (
  value: {
    startLine: number
    endLine: number
    complete: boolean
    editAnchor?: { startLine: number; endLine: number }
  },
  ctx: z.RefinementCtx,
) => {
  if (
    value.editAnchor &&
    (value.editAnchor.startLine !== value.startLine ||
      value.editAnchor.endLine !== value.endLine)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'block editAnchor must match the block bounds',
    })
  }
  if (!value.complete && value.editAnchor !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'partial blocks cannot expose edit capabilities',
    })
  }
}

export const readBlocksWindowItemSchema = z
  .object({
    selector: z.literal('window'),
    ...readBlocksBlockBaseFields,
    windowSize: z.number().int().positive(),
    windowCount: z.number().int().positive(),
    window: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    readBlocksBlockSuperRefine(value, ctx)
    if (value.window > value.windowCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'window index cannot exceed windowCount',
      })
    }
  })

export const readBlocksAroundItemSchema = z
  .object({
    selector: z.literal('around'),
    ...readBlocksBlockBaseFields,
    match: z.string(),
    /** 1-indexed matched occurrence this block was anchored on. */
    occurrence: z.number().int().positive(),
    totalOccurrences: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(readBlocksBlockSuperRefine)

export const readBlocksSymbolItemSchema = z
  .object({
    selector: z.literal('symbol'),
    ...readBlocksBlockBaseFields,
    symbol: z.string(),
    kind: z.string().optional(),
    /** 1-indexed AST match this slice was selected from. */
    occurrence: z.number().int().positive(),
  })
  .strict()
  .superRefine(readBlocksBlockSuperRefine)

/**
 * The single shared read item union for read_files: every selector kind
 * (file, range, symbols, window, around, symbol) plus per-selector errors.
 */
export const readFilesItemV1Schema = z.union([
  readFilesFileItemSchema,
  readFilesRangeItemSchema,
  readFilesSymbolsItemSchema,
  readBlocksWindowItemSchema,
  readBlocksAroundItemSchema,
  readBlocksSymbolItemSchema,
  readFilesErrorItemSchema,
])

export const readFilesResultV1Schema = z
  .object({
    kind: z.literal('read_files_result'),
    version: z.literal(1),
    status: z.enum(['ok', 'partial', 'error']),
    summary: z.object({
      requested: z.number().int().nonnegative(),
      ok: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      uniquePaths: z.number().int().nonnegative(),
    }),
    results: readFilesItemV1Schema.array(),
  })
  .superRefine((value, ctx) => {
    const { requested, ok, partial, failed, uniquePaths } = value.summary
    const actualOk = value.results.filter(
      (result) => result.status === 'ok',
    ).length
    const actualPartial = value.results.filter(
      (result) => result.status === 'partial',
    ).length
    const actualFailed = value.results.filter(
      (result) => result.status === 'error',
    ).length
    if (
      ok + partial + failed !== requested ||
      requested !== value.results.length ||
      ok !== actualOk ||
      partial !== actualPartial ||
      failed !== actualFailed
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'read_files summary counts must equal the number of result items',
      })
    }
    if (
      new Set(value.results.map((result) => result.path)).size !== uniquePaths
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'read_files summary.uniquePaths does not match results',
      })
    }
    const expectedStatus =
      failed === requested && failed > 0
        ? 'error'
        : failed > 0 || partial > 0
          ? 'partial'
          : 'ok'
    if (value.status !== expectedStatus) {
      ctx.addIssue({
        code: 'custom',
        message: 'read_files aggregate status does not match summary counts',
      })
    }
    if (value.results.some((result, index) => result.requestIndex !== index)) {
      ctx.addIssue({
        code: 'custom',
        message: 'read_files request indexes must be contiguous and ordered',
      })
    }
    for (const result of value.results) {
      if (result.status === 'error') continue
      if (result.selector === 'symbols') {
        if (result.status === 'ok' && result.missingSymbols.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'ok symbol results cannot contain missing symbols',
          })
        }
        if (result.status === 'partial' && result.missingSymbols.length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'partial symbol results require missing symbols',
          })
        }
        continue
      }
      if (
        (result.selector === 'file' || result.selector === 'range') &&
        result.status === 'ok' &&
        !result.complete
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'ok file/range results must be complete',
        })
      }
      if (
        (result.selector === 'file' || result.selector === 'range') &&
        result.status === 'partial' &&
        (result.complete || !result.truncation)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'partial file/range results must be incomplete and truncated',
        })
      }
      if (
        result.selector === 'range' &&
        result.status === 'partial' &&
        (result.editAnchor !== undefined || result.sourceContent !== undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'partial range results cannot expose exact source content or edit capabilities',
        })
      }
    }
  })

export type FilesystemError = z.infer<typeof filesystemErrorSchema>
export type FilesystemErrorCode = z.infer<typeof filesystemErrorCodeSchema>
export type ToolLifecycleStateV1 = z.infer<typeof toolLifecycleStateV1Schema>
export type ToolLifecycleV1 = z.infer<typeof toolLifecycleV1Schema>
export type NativeToolResultErrorV1 = z.infer<
  typeof nativeToolResultErrorV1Schema
>
export type NativeToolResultErrorOutputV1 = z.infer<
  typeof nativeToolResultErrorOutputV1Schema
>
export type AuthorityCapabilityTier = z.infer<
  typeof authorityCapabilityTierSchema
>
export type FileSnapshotV1 = z.infer<typeof fileSnapshotV1Schema>
export type WholeFileCapabilityV1 = z.infer<typeof wholeFileCapabilityV1Schema>
export type RangeCapabilityV1 = z.infer<typeof rangeCapabilityV1Schema>
export type ReadOnlyCapabilityV1 = z.infer<typeof readOnlyCapabilityV1Schema>
export type FileCapabilityV1 = z.infer<typeof fileCapabilityV1Schema>
export type FileMutationActionV1 = z.infer<typeof fileMutationActionV1Schema>
export type FileMutationOutcomeV1 = z.infer<typeof fileMutationOutcomeV1Schema>
export type FileMutationResultV1 = z.infer<typeof fileMutationResultV1Schema>
export type CommitActionReceiptV1 = z.infer<typeof commitActionReceiptV1Schema>
export type CommitReceiptV1 = z.infer<typeof commitReceiptV1Schema>
export type ReadFilesEditAnchor = z.infer<typeof readFilesEditAnchorSchema>
export type ReadFilesItemV1 = z.infer<typeof readFilesItemV1Schema>
export type ReadFilesResultV1 = z.infer<typeof readFilesResultV1Schema>

const TOOL_LIFECYCLE_TRANSITIONS: Record<
  ToolLifecycleStateV1,
  readonly ToolLifecycleStateV1[]
> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

function contractError(
  code: FilesystemErrorCode,
  message: string,
  options: Pick<
    FilesystemError,
    'retryable' | 'requiresFreshRead' | 'recovery'
  >,
): FilesystemError {
  return { code, message, ...options }
}

export function isTerminalToolLifecycleStateV1(
  state: ToolLifecycleStateV1,
): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function buildNativeToolResultErrorOutputV1(params: {
  toolName: string
  callId: string
  issueCount: number
  message?: string
}): NativeToolResultErrorOutputV1 {
  return [
    {
      type: 'json',
      value: {
        kind: 'native_tool_result_error',
        version: 1,
        toolName: params.toolName,
        lifecycle: {
          kind: 'tool_lifecycle',
          version: 1,
          callId: params.callId,
          sequence: 0,
          state: 'failed',
        },
        error: {
          code: 'malformed_result',
          message:
            params.message ??
            'The native tool returned a malformed result. No mutation is confirmed; inspect the tool implementation and retry only after verifying current state.',
          retryable: false,
          recovery: 'fix_result',
        },
        issueCount: params.issueCount,
      },
    },
  ]
}

export function getToolLifecycleTransitionErrorV1(
  previous: ToolLifecycleV1,
  next: ToolLifecycleV1,
): FilesystemError | undefined {
  if (previous.callId !== next.callId) {
    return contractError(
      'illegal_transition',
      'tool lifecycle transitions must preserve callId',
      { retryable: false },
    )
  }
  if (next.sequence <= previous.sequence) {
    return contractError(
      'illegal_transition',
      'tool lifecycle sequence must increase monotonically',
      { retryable: false },
    )
  }
  if (!TOOL_LIFECYCLE_TRANSITIONS[previous.state].includes(next.state)) {
    return contractError(
      'illegal_transition',
      `tool lifecycle cannot transition from ${previous.state} to ${next.state}`,
      { retryable: false },
    )
  }
  return undefined
}

export function canTransitionToolLifecycleV1(
  previous: ToolLifecycleV1,
  next: ToolLifecycleV1,
): boolean {
  return getToolLifecycleTransitionErrorV1(previous, next) === undefined
}

export type FileCapabilityAuthorizationRequestV1 = {
  operation:
    | 'whole_file_update'
    | 'delete'
    | 'move'
    | 'range_update'
    | 'symbol_update'
  canonicalPath: string
  baseHash: string
  startLine?: number
  endLine?: number
  symbol?: string
}

export function fileCapabilityAuthorizesV1(
  capability: FileCapabilityV1,
  request: FileCapabilityAuthorizationRequestV1,
): boolean {
  if (
    capability.kind === 'read_only' ||
    capability.snapshot.canonicalPath !== request.canonicalPath ||
    capability.snapshot.contentHash !== request.baseHash
  ) {
    return false
  }

  if (capability.kind === 'whole_file') {
    return (
      request.operation === 'whole_file_update' ||
      request.operation === 'delete' ||
      request.operation === 'move'
    )
  }

  if (request.operation === 'range_update') {
    return (
      request.startLine === capability.startLine &&
      request.endLine === capability.endLine
    )
  }
  return (
    request.operation === 'symbol_update' &&
    capability.symbol !== undefined &&
    request.symbol === capability.symbol
  )
}

export function getConfirmedAppliedActionsV1(
  result: FileMutationResultV1,
): FileMutationActionV1[] {
  if (!result.authorityReceipt) return []
  if (
    result.outcome !== 'applied' &&
    result.outcome !== 'partial' &&
    result.outcome !== 'rollback_incomplete'
  ) {
    return []
  }
  return result.actions.filter((action) => action.outcome === 'applied')
}

function mutationActionFromReceipt(
  action: CommitActionReceiptV1,
  receiptStatus: CommitReceiptV1['status'],
  afterContent?: string,
  editAnchor?: z.infer<typeof readFilesEditAnchorSchema>,
): FileMutationActionV1 {
  let outcome: FileMutationActionV1['outcome']
  if (action.status === 'committed') {
    outcome = 'applied'
  } else if (action.status === 'rolled_back') {
    outcome = 'rolled_back'
  } else if (action.status === 'rollback_failed') {
    outcome = 'applied'
  } else if (receiptStatus === 'failed') {
    outcome = 'unconfirmed'
  } else {
    outcome = 'not_applied'
  }

  const exposeAfterState =
    receiptStatus === 'committed' &&
    action.status === 'committed' &&
    typeof afterContent === 'string' &&
    new TextEncoder().encode(afterContent).byteLength <=
      FILESYSTEM_RESULT_CONTENT_MAX_BYTES

  return {
    actionId: action.actionId,
    index: action.index,
    action: action.action,
    path: action.path,
    ...(action.destinationPath
      ? { destinationPath: action.destinationPath }
      : {}),
    outcome,
    beforeHash: action.beforeHash,
    afterHash: action.afterHash,
    ...(exposeAfterState
      ? { afterContent, ...(editAnchor ? { editAnchor } : {}) }
      : {}),
    ...(action.error ? { error: action.error } : {}),
    ...(action.status === 'rolled_back' || action.status === 'rollback_failed'
      ? {
          rollback: {
            attempted: true,
            succeeded: action.status === 'rolled_back',
            ...(action.error ? { error: action.error } : {}),
          },
        }
      : {}),
  }
}

export type FileMutationActionContentsV1 = ReadonlyMap<
  number | string,
  string
>

export type FileMutationActionEditAnchorsV1 = ReadonlyMap<
  number | string,
  z.infer<typeof readFilesEditAnchorSchema>
>

export function buildFileMutationResultFromReceiptV1(
  receipt: CommitReceiptV1,
  additionalErrors: FilesystemError[] = [],
  freshCapabilities: FileCapabilityV1[] = [],
  actionContents?: FileMutationActionContentsV1,
  actionEditAnchors?: FileMutationActionEditAnchorsV1,
): FileMutationResultV1 {
  const validatedReceipt = commitReceiptV1Schema.parse(receipt)
  const actions = validatedReceipt.actions.map((action) =>
    mutationActionFromReceipt(
      action,
      validatedReceipt.status,
      actionContents?.get(action.index) ?? actionContents?.get(action.actionId),
      actionEditAnchors?.get(action.index) ??
        actionEditAnchors?.get(action.actionId),
    ),
  )
  const outcome: FileMutationOutcomeV1 =
    validatedReceipt.status === 'committed'
      ? 'applied'
      : validatedReceipt.status === 'not_started'
        ? 'not_applied'
        : validatedReceipt.status === 'rolled_back'
          ? 'rolled_back'
          : validatedReceipt.status === 'rollback_incomplete'
            ? 'rollback_incomplete'
            : actions.some((action) => action.outcome === 'applied')
              ? 'partial'
              : 'unconfirmed'

  return fileMutationResultV1Schema.parse({
    kind: 'file_mutation_result',
    version: 1,
    operationId: validatedReceipt.operationId,
    outcome,
    actions,
    authorityTier: validatedReceipt.authorityTier,
    receiptId: validatedReceipt.receiptId,
    ...(validatedReceipt.workspaceRevision !== undefined
      ? { workspaceRevision: validatedReceipt.workspaceRevision }
      : {}),
    ...(validatedReceipt.workspaceSnapshotId !== undefined
      ? { workspaceSnapshotId: validatedReceipt.workspaceSnapshotId }
      : {}),
    authorityReceipt: validatedReceipt,
    errors: [
      ...validatedReceipt.actions.flatMap((action) =>
        action.error ? [action.error] : [],
      ),
      ...additionalErrors,
    ],
    freshCapabilities,
  })
}

export function mutationResultExceedsCheapBoundsV1(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    (Array.isArray(record.actions) &&
      record.actions.length > FILESYSTEM_RESULT_MAX_ACTIONS) ||
    (Array.isArray(record.freshCapabilities) &&
      record.freshCapabilities.length > FILESYSTEM_RESULT_MAX_CAPABILITIES)
  ) {
    return true
  }

  let aggregateBytes = 0
  for (const action of Array.isArray(record.actions) ? record.actions : []) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) continue
    const actionRecord = action as Record<string, unknown>
    for (const field of ['afterContent', 'patch'] as const) {
      const content = actionRecord[field]
      if (typeof content !== 'string') continue
      if (content.length > FILESYSTEM_RESULT_CONTENT_MAX_BYTES) return true
      const bytes = new TextEncoder().encode(content).byteLength
      if (bytes > FILESYSTEM_RESULT_CONTENT_MAX_BYTES) return true
      aggregateBytes += bytes
      if (aggregateBytes > FILESYSTEM_RESULT_AGGREGATE_CONTENT_MAX_BYTES) {
        return true
      }
    }
  }
  return false
}

export type ReconciledFileMutationV1 = {
  lifecycle: ToolLifecycleV1
  mutation: FileMutationResultV1
  handlerResultValid: boolean
}

export function reconcileFileMutationResultV1({
  lifecycle,
  operationId,
  handlerResult,
  receipt,
  capabilityScope,
}: {
  lifecycle: ToolLifecycleV1
  operationId: string
  handlerResult: unknown
  receipt?: unknown
  capabilityScope?: Omit<ReadCapabilityScope, 'path'>
}): ReconciledFileMutationV1 {
  const parsedHandlerResult =
    fileMutationResultV1Schema.safeParse(handlerResult)
  const parsedReceipt = commitReceiptV1Schema.safeParse(receipt)
  const matchingReceipt =
    parsedReceipt.success &&
    parsedReceipt.data.operationId === operationId &&
    parsedReceipt.data.callId === lifecycle.callId
      ? parsedReceipt.data
      : undefined
  const malformedError = contractError(
    'malformed_result',
    parsedHandlerResult.success
      ? 'mutation result lacks matching independent authority evidence'
      : 'mutation handler returned a malformed result',
    { retryable: false, recovery: 'fix_result' },
  )

  if (matchingReceipt) {
    const correlatedActions = new Map<number | string, string>()
    const correlatedAnchors = new Map<
      number | string,
      z.infer<typeof readFilesEditAnchorSchema>
    >()
    const validatedCapabilities: FileCapabilityV1[] = []

    const usedTokens = new Set<string>()
    if (
      parsedHandlerResult.success &&
      matchingReceipt.status === 'committed' &&
      parsedHandlerResult.data.workspaceRevision ===
        matchingReceipt.workspaceRevision &&
      parsedHandlerResult.data.workspaceSnapshotId ===
        matchingReceipt.workspaceSnapshotId
    ) {
      for (const receiptAction of matchingReceipt.actions) {
        const matchingHandlerActions = parsedHandlerResult.data.actions.filter(
          (action) =>
            action.index === receiptAction.index &&
            action.actionId === receiptAction.actionId &&
            action.action === receiptAction.action &&
            action.path === receiptAction.path &&
            action.destinationPath === receiptAction.destinationPath &&
            action.beforeHash === receiptAction.beforeHash &&
            action.afterHash === receiptAction.afterHash,
        )
        if (matchingHandlerActions.length !== 1) continue
        const handlerAction = matchingHandlerActions[0]
        const afterContent = handlerAction.afterContent
        const editAnchor = handlerAction.editAnchor
        if (
          receiptAction.status !== 'committed' ||
          receiptAction.afterHash === null ||
          afterContent === undefined ||
          editAnchor === undefined ||
          new TextEncoder().encode(afterContent).byteLength >
            FILESYSTEM_RESULT_CONTENT_MAX_BYTES ||
          getExactContentHash(afterContent) !== receiptAction.afterHash
        ) {
          continue
        }

        const matchingCapabilities =
          parsedHandlerResult.data.freshCapabilities.filter(
            (candidate) =>
              candidate.kind === 'whole_file' &&
              candidate.token === editAnchor.readCapability,
          )
        if (
          matchingCapabilities.length !== 1 ||
          usedTokens.has(editAnchor.readCapability) ||
          capabilityScope === undefined
        ) {
          continue
        }
        const capability = matchingCapabilities[0]!
        const decoded = decodeReadCapabilityToken(capability.token)
        if (typeof decoded === 'string') continue

        const targetPath = receiptAction.destinationPath ?? receiptAction.path
        const normalizedHash = getContentHash(afterContent)
        const endLine = normalizeLineEndings(afterContent).split('\n').length
        const canonicalProject = capabilityScope.projectId
          .replaceAll('\\', '/')
          .replace(/\/+$/, '')
        const canonicalTarget = targetPath
          .replaceAll('\\', '/')
          .replace(/^\.\//, '')
        const expectedCanonicalPath = `${canonicalProject}/${canonicalTarget}`
        if (
          matchingReceipt.finalHashes[targetPath] !== receiptAction.afterHash ||
          !readCapabilityMatchesScope(decoded, {
            ...capabilityScope,
            path: targetPath,
          }) ||
          capability.snapshot.canonicalPath.replaceAll('\\', '/') !==
            expectedCanonicalPath ||
          capability.snapshot.contentHash !== receiptAction.afterHash ||
          capability.snapshot.sizeBytes !==
            new TextEncoder().encode(afterContent).byteLength ||
          capability.snapshot.encoding !== 'utf8' ||
          decoded.hash !== normalizedHash ||
          decoded.startLine !== 1 ||
          decoded.endLine !== endLine ||
          editAnchor.startLine !== 1 ||
          editAnchor.endLine !== endLine ||
          editAnchor.contentHash !== normalizedHash
        ) {
          continue
        }

        usedTokens.add(editAnchor.readCapability)
        correlatedActions.set(receiptAction.index, afterContent)
        correlatedAnchors.set(receiptAction.index, editAnchor)
        if (!validatedCapabilities.includes(capability)) {
          validatedCapabilities.push(capability)
        }
      }
    }

    return {
      lifecycle,
      mutation: buildFileMutationResultFromReceiptV1(
        matchingReceipt,
        parsedHandlerResult.success ? [] : [malformedError],
        validatedCapabilities,
        correlatedActions,
        correlatedAnchors,
      ),
      handlerResultValid: parsedHandlerResult.success,
    }
  }

  const sourceActions = parsedHandlerResult.success
    ? parsedHandlerResult.data.actions
    : []
  return {
    lifecycle,
    mutation: {
      kind: 'file_mutation_result',
      version: 1,
      operationId,
      outcome: 'unconfirmed',
      actions: sourceActions.map((action) => ({
        ...action,
        outcome: 'unconfirmed',
        beforeHash: null,
        afterHash: null,
        afterContent: undefined,
        editAnchor: undefined,
        rollback: undefined,
      })),
      authorityTier: null,
      errors: [malformedError],
      freshCapabilities: [],
    },
    handlerResultValid: parsedHandlerResult.success,
  }
}

export function isToolLifecycleV1(value: unknown): value is ToolLifecycleV1 {
  return toolLifecycleV1Schema.safeParse(value).success
}

export function isFileMutationResultV1(
  value: unknown,
): value is FileMutationResultV1 {
  return fileMutationResultV1Schema.safeParse(value).success
}

export function isCommitReceiptV1(value: unknown): value is CommitReceiptV1 {
  return commitReceiptV1Schema.safeParse(value).success
}

export function buildReadFilesResultV1(
  results: ReadFilesItemV1[],
): ReadFilesResultV1 {
  const ok = results.filter((result) => result.status === 'ok').length
  const partial = results.filter((result) => result.status === 'partial').length
  const failed = results.filter((result) => result.status === 'error').length
  return {
    kind: 'read_files_result',
    version: 1,
    status:
      failed === results.length && failed > 0
        ? 'error'
        : failed > 0 || partial > 0
          ? 'partial'
          : 'ok',
    summary: {
      requested: results.length,
      ok,
      partial,
      failed,
      uniquePaths: new Set(results.map((result) => result.path)).size,
    },
    results,
  }
}

export function isReadFilesResultV1(
  value: unknown,
): value is ReadFilesResultV1 {
  return readFilesResultV1Schema.safeParse(value).success
}
