import z from 'zod/v4'

/**
 * Namespaced Openbuff ACP extension method contracts (roadmap decision D9).
 * Each entry is a JSON-RPC extension method a client can invoke on the
 * Openbuff agent; params and result are pinned here as Zod schemas so the
 * wire contract, runtime validation, and the X-1 JSON Schema pipeline all
 * share one source of truth.
 */
export const ACP_EXTENSION_METHODS = [
  'openbuff/getReceipts',
  'openbuff/askUser',
  'openbuff/gateState',
] as const

export type AcpExtensionMethod = (typeof ACP_EXTENSION_METHODS)[number]

const getReceiptsParams = z.object({
  sessionId: z.string(),
  limit: z.number().optional(),
})

/** Mirrors the editor agent's mutationReceipts receipt shape. */
const getReceiptsResult = z.object({
  receipts: z.array(
    z.object({
      operationId: z.string(),
      receiptId: z.string(),
      paths: z.array(z.string()),
      actionIds: z.array(z.string()),
    }),
  ),
})

const askUserParams = z.object({
  sessionId: z.string(),
  question: z.string(),
  choices: z.array(z.string()),
})

const askUserResult = z.object({
  answer: z.string(),
})

const gateStateParams = z.object({
  sessionId: z.string(),
})

const gateStateResult = z.object({
  phase: z.string(),
  currentTask: z.string().nullable(),
})

export const acpExtensionSchemas: Record<
  AcpExtensionMethod,
  { params: z.ZodType; result: z.ZodType }
> = {
  'openbuff/getReceipts': {
    params: getReceiptsParams,
    result: getReceiptsResult,
  },
  'openbuff/askUser': {
    params: askUserParams,
    result: askUserResult,
  },
  'openbuff/gateState': {
    params: gateStateParams,
    result: gateStateResult,
  },
}

/**
 * Compiles the JSON Schema artifact for every Openbuff extension method,
 * keyed by method name in ACP_EXTENSION_METHODS iteration order. Mirrors
 * compileToolJsonSchemas in common/src/tools/compile-tool-definitions.ts so
 * the X-1 golden-vector pipeline can consume extension contracts the same
 * way it consumes tool contracts.
 */
export function compileAcpExtensionJsonSchemas(): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {}
  for (const method of ACP_EXTENSION_METHODS) {
    const { params, result } = acpExtensionSchemas[method]
    artifacts[method] = {
      params: z.toJSONSchema(params, { io: 'input' }),
      result: z.toJSONSchema(result, { io: 'input' }),
    }
  }
  return artifacts
}
