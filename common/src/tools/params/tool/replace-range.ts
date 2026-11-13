import z from 'zod/v4'

import { FileContentChangeSchema } from '../../../actions'
import {
  $getNativeToolCallExampleString,
  isObviousEditPlaceholder,
  editToolResultSchema,
} from '../utils'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
} from '../../../util/content-hash'
import { captureTextDocument, getRawReadBasis } from '../../../util/byte-text'

import { updateFileResultSchema } from './str-replace'

import type { $ToolParams } from '../../constants'

const toolName = 'replace_range'
const endsAgentStep = false

const rawInputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe('The path to the file to edit.'),
    readCapability: z
      .string()
      .min(1)
      .describe(
        'Copy the cap.v4 readCapability verbatim from the matching fresh read_files editAnchor. The token supplies the observed line bounds and content hash.',
      ),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional 1-indexed target start within the capability-covered range. Omit with endLine to replace the complete observed range.',
      ),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional 1-indexed target end within the capability-covered range. Omit with startLine to replace the complete observed range.',
      ),
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
    newContent: z
      .string()
      .refine((value) => !isObviousEditPlaceholder(value), {
        message:
          'newContent is an explicit placeholder. Provide the complete replacement content for the range.',
      })
      .describe('Complete replacement content for the selected line range.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    const decoded = decodeReadCapabilityToken(input.readCapability)
    if (
      typeof decoded === 'string' ||
      (decoded.tokenVersion !== 'v3' && decoded.tokenVersion !== 'v4')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['readCapability'],
        message:
          typeof decoded === 'string'
            ? decoded
            : 'readCapability requires an authenticated project/path/run-bound cap.v4 token.',
      })
      return
    }
    const hasStart = input.startLine !== undefined
    const hasEnd = input.endLine !== undefined
    if (input.occurrence && (hasStart || hasEnd)) {
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
      (input.startLine! < decoded.startLine ||
        input.endLine! > decoded.endLine ||
        input.startLine! > input.endLine!)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Target lines must be contained within the readCapability range ${decoded.startLine}-${decoded.endLine}.`,
      })
    }
  })
  .describe(
    'Replace all of, a contained sub-range of, or the Nth literal occurrence inside content observed through one fresh cap.v4 read capability.',
  )

const inputSchema = rawInputSchema.transform((input) => {
  const decoded = decodeReadCapabilityToken(input.readCapability)
  if (typeof decoded === 'string') {
    throw new Error(decoded)
  }
  // Occurrence targeting resolves concrete line bounds at runtime against the
  // authorized slice of current content, so leave them underived here instead
  // of defaulting to the full capability range.
  const bounds = input.occurrence
    ? { startLine: input.startLine, endLine: input.endLine }
    : {
        startLine: input.startLine ?? decoded.startLine,
        endLine: input.endLine ?? decoded.endLine,
      }
  return {
    ...input,
    ...bounds,
    capabilityStartLine: decoded.startLine,
    capabilityEndLine: decoded.endLine,
    capabilityHash: decoded.hash,
  }
})

const providerInputSchema = rawInputSchema

/** Internal application payload, prepared only after runtime raw authorization. */
export const preparedRangeMutationSchema = FileContentChangeSchema.extend({
  type: z.literal('file'),
  path: z.string().min(1),
  content: FileContentChangeSchema.shape.content.refine((content) => {
    try {
      captureTextDocument(content)
      return true
    } catch {
      return false
    }
  }, 'Prepared range content must be lossless UTF-8 text.'),
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedRawHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()

const description = `
Use this tool to replace a range observed through an authenticated cap.v4. Fresh after-edit authority is returned only when the client confirms the exact after-content.

Important:
- Copy the single cap.v4 readCapability token verbatim from the matching fresh read_files editAnchor.
- The token supplies the observed line bounds and content hash. To replace only part of the observed content, pass startLine and endLine together; they must remain inside the token's range.
- To target one instance of a repeated literal block instead of absolute lines, pass occurrence: { match, occurrence } and omit startLine/endLine. The runtime resolves the 1-indexed occurrence (default 1) of the exact literal match inside the capability-authorized range; occurrence and startLine/endLine cannot be combined.
- Never pass expectedHash. The runtime derives and verifies freshness from the authenticated capability.
- An explicit final empty entry requires a capability that authenticates that entry and complete EOF metadata. Omitted read end bounds stay at the visible ceiling.
- The runtime verifies exact raw bytes before editing. Whole bases require unchanged whole bytes; scoped bases can relocate only to one unchanged raw slice within the finite search budget.
- newContent replaces the entire selected range, so include all lines that should remain in that range.
- Never pass an out-of-band reference such as "[see patch above]"; newContent must be complete.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'path/to/large-file.ts',
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('freshly read example range'),
      scope: {
        projectId: '/example/project',
        path: 'path/to/large-file.ts',
        runId: 'example-run',
      },
      rawBasis: getRawReadBasis(
        captureTextDocument('freshly read example range'),
        1,
        1,
        'lines',
      ),
    }),
    newContent: 'function updated() {\n  return true\n}',
  },
  endsAgentStep,
})}
`.trim()

export const replaceRangeParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  providerInputSchema,
  outputSchema: editToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
