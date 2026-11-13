import z from 'zod/v4'

/** The exact bytes actually observed, separately from normalized display text. */
export type RawReadBasisV1 = {
  version: 1
  scope: 'whole' | 'lines'
  rawHash: string
  documentRawHash: string
  documentBytes: number
  startByte: number
  endByteExclusive: number
  documentBom: 'utf8' | 'none'
  includesBom: boolean
  endTerminator: 'lf' | 'crlf' | 'none'
  view: 'descriptor' | 'adapter_bytes' | 'text_view'
  coherence: 'checked' | 'observed'
  /** Actual adapter generation facts, when available; never a guessed version. */
  generation?: string
}

const byteOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const exactHash = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const rawReadBasisV1Schema = z
  .object({
    version: z.literal(1),
    scope: z.enum(['whole', 'lines']),
    rawHash: exactHash,
    documentRawHash: exactHash,
    documentBytes: byteOffset,
    startByte: byteOffset,
    endByteExclusive: byteOffset,
    documentBom: z.enum(['utf8', 'none']),
    includesBom: z.boolean(),
    endTerminator: z.enum(['lf', 'crlf', 'none']),
    view: z.enum(['descriptor', 'adapter_bytes', 'text_view']),
    coherence: z.enum(['checked', 'observed']),
    generation: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => Buffer.byteLength(value) <= 1024,
        'Generation exceeds its UTF-8 byte limit',
      )
      .optional(),
  })
  .strict()
  .superRefine((basis, ctx) => {
    if (
      basis.endByteExclusive < basis.startByte ||
      basis.endByteExclusive > basis.documentBytes ||
      (basis.documentBom === 'utf8' && basis.documentBytes < 3) ||
      (basis.documentBom === 'utf8' &&
        ((basis.startByte > 0 && basis.startByte < 3) ||
          (basis.endByteExclusive > 0 && basis.endByteExclusive < 3))) ||
      (basis.includesBom &&
        (basis.documentBom !== 'utf8' ||
          basis.startByte !== 0 ||
          basis.endByteExclusive < 3)) ||
      (basis.documentBom === 'utf8' &&
        basis.startByte === 0 &&
        !basis.includesBom)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid raw read byte boundaries or BOM identity',
      })
    }
    if (
      basis.scope === 'whole' &&
      (basis.startByte !== 0 ||
        basis.endByteExclusive !== basis.documentBytes ||
        basis.rawHash !== basis.documentRawHash ||
        basis.includesBom !== (basis.documentBom === 'utf8'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'A whole basis must bind every observed raw byte',
      })
    }
    if (
      basis.view === 'descriptor' &&
      basis.coherence === 'checked' &&
      !basis.generation
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Checked descriptor observations require actual generation facts',
      })
    }
  }) satisfies z.ZodType<RawReadBasisV1>

/** Validate and copy a streamed basis; this does not allocate or decode source text. */
export function parseRawReadBasis(value: unknown): RawReadBasisV1 {
  const basis = rawReadBasisV1Schema.parse(value)
  return Object.freeze({
    version: basis.version,
    scope: basis.scope,
    rawHash: basis.rawHash,
    documentRawHash: basis.documentRawHash,
    documentBytes: basis.documentBytes,
    startByte: basis.startByte,
    endByteExclusive: basis.endByteExclusive,
    documentBom: basis.documentBom,
    includesBom: basis.includesBom,
    endTerminator: basis.endTerminator,
    view: basis.view,
    coherence: basis.coherence,
    ...(basis.generation === undefined ? {} : { generation: basis.generation }),
  })
}

export function rawReadBasesMatch(left: unknown, right: unknown): boolean {
  try {
    return (
      JSON.stringify(parseRawReadBasis(left)) ===
      JSON.stringify(parseRawReadBasis(right))
    )
  } catch {
    return false
  }
}
