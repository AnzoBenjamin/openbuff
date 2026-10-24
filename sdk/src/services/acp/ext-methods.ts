import z from 'zod/v4'

import {
  capabilityMapV1Schema,
  gateStateV1Schema,
  laneV1Schema,
  receiptEnvelopeV1Schema,
} from '@codebuff/common/protocol/acp-ext-v1'
import type {
  CapabilityMapV1,
  GateStateV1,
  LaneV1,
  ReceiptEnvelopeV1,
} from '@codebuff/common/protocol/acp-ext-v1'

/**
 * The ext-v1 ACP extension surface (P1-T1-DESIGN §6): methods are named
 * `_openbuff.dev/<area>/<verb>` and notifications `_openbuff.dev/<area>`,
 * with `_meta` payloads under the single key `"openbuff.dev"`. These are the
 * v1 namespaced methods (the legacy `openbuff/*` names in ./extensions stay
 * for back-compat and are served by the same dispatcher).
 */
export const OPENBUFF_EXT_METHOD_PREFIX = '_openbuff.dev/'

/**
 * The Openbuff extension names the agent can negotiate (§3.2). The agent
 * responds to `initialize` with the INTERSECTION of the client's requested
 * list and this set, and emits extension notifications only for enabled
 * extensions. `lanes` is negotiable now (its shape is frozen) even though
 * create/land stay refused until P6.
 */
export const OPENBUFF_SUPPORTED_EXTENSIONS = [
  'capabilities',
  'receipts',
  'lanes',
  'gate',
  'events',
] as const

export type OpenbuffSupportedExtension =
  (typeof OPENBUFF_SUPPORTED_EXTENSIONS)[number]

export const OPENBUFF_EXT_METHODS = [
  '_openbuff.dev/capabilities/get',
  '_openbuff.dev/receipts/get',
  '_openbuff.dev/lanes/list',
  '_openbuff.dev/lanes/create',
  '_openbuff.dev/lanes/land',
  '_openbuff.dev/gate_state/get',
] as const

export type OpenbuffExtMethod = (typeof OPENBUFF_EXT_METHODS)[number]

/** The `_openbuff.dev/capabilities_changed` push notification (§6.1). */
export const OPENBUFF_CAPABILITIES_CHANGED_NOTIFICATION =
  '_openbuff.dev/capabilities_changed'

/** The `_openbuff.dev/gate_state` push notification (§6.4). */
export const OPENBUFF_GATE_STATE_NOTIFICATION = '_openbuff.dev/gate_state'

/**
 * All session-scoped ext methods carry the ACP session id (§6) — including
 * `_openbuff.dev/capabilities/get`: its store lookup is per-session, so an
 * empty params object would pin the dispatcher to sessionId '' and make the
 * method unreachable for every real session.
 */
const sessionIdParams = z.object({ sessionId: z.string().min(1) }).strict()

/** `_openbuff.dev/receipts/get` names the receipt's mutation receiptId. */
const receiptsGetParams = z
  .object({ sessionId: z.string().min(1), receiptId: z.string().min(1) })
  .strict()

/**
 * Result contracts (§6): the published wire shapes the dispatcher serves,
 * pinned by the common protocol schemas so the compiled JSON-Schema artifact
 * can validate ext-v1 RESULTS and not just params.
 */
const capabilitiesGetResult = capabilityMapV1Schema
const receiptsGetResult = z.object({ receipt: receiptEnvelopeV1Schema }).strict()
const lanesListResult = z.object({ lanes: z.tuple([laneV1Schema]) }).strict()
// `lanes/create` and `lanes/land` ALWAYS fail with -32601 capability_disabled
// while lanes are unsupported (GV-10): they never return a result, so the
// honest result contract is `never`.
const lanesUnsupportedResult = z.never()
const gateStateGetResult = gateStateV1Schema

export const openbuffExtMethodSchemas: Record<
  OpenbuffExtMethod,
  { params: z.ZodType; result: z.ZodType }
> = {
  '_openbuff.dev/capabilities/get': {
    params: sessionIdParams,
    result: capabilitiesGetResult,
  },
  '_openbuff.dev/receipts/get': {
    params: receiptsGetParams,
    result: receiptsGetResult,
  },
  '_openbuff.dev/lanes/list': {
    params: sessionIdParams,
    result: lanesListResult,
  },
  '_openbuff.dev/lanes/create': {
    params: sessionIdParams,
    result: lanesUnsupportedResult,
  },
  '_openbuff.dev/lanes/land': {
    params: sessionIdParams,
    result: lanesUnsupportedResult,
  },
  '_openbuff.dev/gate_state/get': {
    params: sessionIdParams,
    result: gateStateGetResult,
  },
}

/** Result shapes (type-level contracts served by the dispatcher). */
export type CapabilitiesGetResult = CapabilityMapV1
export type ReceiptsGetResult = { receipt: ReceiptEnvelopeV1 }
export type LanesListResult = { lanes: [LaneV1] }
export type GateStateGetResult = GateStateV1

/**
 * The honest P1 serve-mode capability map (§6.1) now lives beside the schema
 * it populates: `defaultCapabilityMapV1` in
 * `@codebuff/common/protocol/acp-ext-v1` is the single canonical builder, so
 * every advertising surface (SDK serve mode and the CLI's status-bar chip /
 * doctor rows) derives from one source and can never drift on a value change
 * (e.g. a sandbox-tier or gate-default update). Re-exported here for
 * back-compat with existing internal imports; `journalAvailable` still
 * reflects whether the backing store actually mirrors to a durable journal,
 * and the map is always derived locally from the serving process's real
 * posture — a journal-replayed map is untrusted input and is never served
 * verbatim.
 */
export { defaultCapabilityMapV1 } from '@codebuff/common/protocol/acp-ext-v1'

/**
 * Compiles the JSON Schema artifact for every ext-v1 method, keyed by method
 * name in OPENBUFF_EXT_METHODS iteration order. Mirrors
 * compileAcpExtensionJsonSchemas in ./extensions exactly — `{ params, result }`
 * per method — so the X-1 golden-vector pipeline can consume ext-v1 contracts
 * the same way it consumes the legacy extension contracts, and the published
 * artifact can validate ext-v1 results.
 */
export function compileExtV1JsonSchemas(): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {}
  for (const method of OPENBUFF_EXT_METHODS) {
    const { params, result } = openbuffExtMethodSchemas[method]
    artifacts[method] = {
      params: z.toJSONSchema(params, { io: 'input' }),
      result: z.toJSONSchema(result, { io: 'input' }),
    }
  }
  return artifacts
}
