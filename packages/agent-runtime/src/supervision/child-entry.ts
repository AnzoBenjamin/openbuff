/**
 * P2-T8/T8b supervised child entrypoint (Bun entry module).
 *
 * Contract (mirrors supervision/__fixtures__/settle-child.ts):
 *  - argv[2] is the path of a temp file holding the JSON-serialized
 *    `SupervisedSpawnRequest` (stdin is 'ignore' in the supervisor);
 *  - stdout carries EXACTLY ONE newline-terminated JSON line: an
 *    `agentReceiptSchema` envelope. The envelope is compact by schema and
 *    bounded before writing so it stays under the supervisor's 8 MiB stdout
 *    capture cap (beyond-cap bytes are discarded by the supervisor and settle
 *    as 'truncated');
 *  - exit 0 when an envelope was written, 1 on any other failure (the
 *    supervisor classifies non-zero exits / no output as crashed or
 *    missing_output).
 *
 * P2-T8b RPC BRIDGE: when the request carries `rpcSocketPath`, the callback
 * deps are supplied over the parent bridge (newline-delimited JSON on the
 * sandbox Unix socket — NEVER stdout/stderr, so the single-envelope stdout
 * contract above is untouched) and the REAL `loopAgentSteps` runs with the
 * child AgentState rebuilt from `request.child`. Both heavy imports
 * (`loopAgentSteps` and the bridge client) are LAZY and reached only on the
 * bridged path: a bridge-less request never evaluates them, and if the
 * import itself fails the process contract still holds — the failure
 * degrades into the same structured failed receipt and exit 0.
 *
 * Without `rpcSocketPath` (bridge-less request, or handlers omitted at the
 * parent seam) the entrypoint returns the structured FAILED receipt
 * (status 'failed', outcome 'crashed', errors[].code 'unsupported-deps')
 * naming every unbridged callback dep — the honest, schema-valid
 * degradation the parent settle chain reconciles like any other failed
 * spawn.
 *
 * Per-dep supply table (the real check behind
 * {@link missingChildCallbackDeps}):
 *  - BRIDGED over the parent socket (JSON-serializable params AND result,
 *    modulo the nonce-stamped wire-marker protocol for non-JSON-native
 *    members such as live Date timestamps — see bridge-protocol.ts):
 *    promptAiSdkStream, promptAiSdk, promptAiSdkStructured, sendAction,
 *    requestToolCall, requestFiles, requestOptionalFile,
 *    requestMcpToolData, handleStepsLogChunk, sendSubagentChunk, trackEvent,
 *    fetch, startAgentRun, finishAgentRun, addAgentStep — plus two
 *    plus two serializable additions the loop needs:
 *    fetchAgentFromDatabase (required for template resolution; its result is
 *    validated ROUND-TRIP-SAFE fail-closed parent-side — a template carrying
 *    a programmatic handleSteps or live zod inputSchema is rejected with a
 *    structured error instead of silently damaged across the wire) and
 *    consumeCreditsWithFallback (keeps paid-tool gating honest instead of
 *    silently free).
 *    `requestFiles`' `capabilityIssuer` ({ projectId, runId }) is part of
 *    that serializable param surface and crosses verbatim: the parent mints
 *    cap.v3 editAnchors over the content it read and this process re-mints
 *    them with its own in-process HMAC key (a cap.v3 token is verifiable
 *    only where minted), so capability-bearing edits never loop on
 *    'fresh_read_required' in a bridged child.
 *  - LOCALLY reconstructed (NOT bridged, but the child can supply a faithful
 *    implementation itself, so they never fail the gate):
 *      · databaseAgentCache — a stateful Map handle whose has/get/set are
 *        SYNCHRONOUS and therefore cannot cross an async RPC boundary. The
 *        child builds a fresh per-run Map; published agents resolve through
 *        the BRIDGED fetchAgentFromDatabase, which populates that cache —
 *        memoization semantics preserved, so no agent class needs to fail
 *        closed on it.
 *      · getUserInfoFromApiKey — its result carries a non-serializable Date
 *        column; the child supplies a null-failing stub (the subagent loop
 *        does not consume it; higher layers already resolved the user).
 *
 * Dropped prompt-param callbacks (documented divergence) — supervised
 * children only; the in-process path invokes all of these:
 *  - resolveModelContextWindow — NOT bridged (a function). The parent stamps
 *    the INITIAL window into the transport slice (runSupervisedSubagent) and
 *    relays per-request ROUTE windows through the stream replies
 *    (contextWindowTokens on promptAiSdkStreamStart / legacy
 *    promptAiSdkStream — see bridge-protocol.ts);
 *    child-bridge-client.ts applies them to the loop's callback below.
 *  - onModelContextResolved — dropped by the sanitizer (a function),
 *    re-applied locally from the relayed stream replies (child-bridge-client
 *    buildBridgedChildDeps → bridgedPromptAiSdkStream), so a mid-run failover
 *    to a different-window model still updates the child's compaction budget.
 *  - onCostCalculated — RELAYED: the parent injects a captor, llm.ts's
 *    provider cost rides the prompt/stream replies as providerCostCents, and
 *    child-bridge-client re-applies it to the loop's callback (creditsUsed +
 *    BYOK telemetry now match the in-process path).
 *  - onRequestContextTrimmed — RELAYED (same pattern): the parent injects a
 *    per-request captor, the trim telemetry rides the prompt/stream replies
 *    as `contextTrim`, and child-bridge-client re-applies it to the loop's
 *    callback — full observational parity with the in-process path.
 *  - onCacheDebug* — RELAYED (same pattern): the parent injects per-request
 *    captors, the cache-debug telemetry rides the prompt/stream replies as
 *    `cacheDebugRequestBuilt` / `cacheDebugUsage`, and child-bridge-client
 *    re-applies them to the loop's callbacks — full observational parity
 *    with the in-process path. `cacheDebugRequestBuilt` is size-guarded
 *    parent-side at 1 MB: an oversize provider rawBody degrades to
 *    `{ provider, rawBodyDropped: true, bytes }` so the relay never risks
 *    the 16 MiB per-message bridge cap.
 *
 * Other slice-1 scope notes:
 *  - the loop's `onResponseChunk` FORWARDS the child's own live stream to the
 *    parent (see {@link buildChildOnResponseChunk}): string chunks and
 *    `text`-type PrintModeEvents cross the bridged fire-and-forget
 *    `sendSubagentChunk` channel keyed to the child's own agentId/agentType
 *    and the request's verbatim `userInputId`, so the CLI renders the
 *    supervised child's reasoning/text deltas live in the agent block it
 *    already created from the spawn event; every OTHER PrintModeEvent
 *    (tool_call, tool_result, subagent_start, subagent_finish, phase, error,
 *    ...) is relayed over the EXISTING bridged `sendAction` channel as a
 *    `response-chunk` action, which the parent routes to the SAME
 *    `handleEvent` path the in-process path uses — so the supervised child's
 *    tool/lifecycle events render exactly like the orchestrator's own;
 *  - the child does NOT observe the parent AbortSignal; it is bounded by the
 *    supervisor's wall-clock deadline (and by bridge fail-closed teardown);
 *  - the child reads ONLY its own allowlisted env (OPENBUFF_API_KEY legacy
 *    fallback) for the scoped `apiKey` — the parent bridge re-stamps its own
 *    authoritative key on every bridged request that carries one.
 *
 * Scope note: the `processSupervision` flag applies at the `executeSubagent`
 * choke point, so the two programmatic call sites
 * (util/context-consolidation-runner.ts, util/runtime-semantic-compaction.ts)
 * are subject to the same flag — deliberately no second gate.
 */
import { ensureAgentTemplateZodSchemas } from '@codebuff/common/templates/agent-validation'
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  SendActionFn,
  SendSubagentChunkFn,
} from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import { getCiEnv } from '@codebuff/common/env-ci'
import { clientProcessEnv } from '@codebuff/common/env-schema'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { taskMemoryV1Schema } from '@codebuff/common/types/task-memory'
import { generateCompactId } from '@codebuff/common/util/string'
import { readFileSync } from 'node:fs'

import { createBridgeStderrLogger } from './bridge-protocol'
import type { SupervisedSpawnRequest } from './process-supervisor'
import type { ChildBridgeClient } from './child-bridge-client'

/**
 * The parent-callback deps `loopAgentSteps` needs that cannot be rebuilt from
 * a JSON-serializable request. Each is either BRIDGED over the parent socket
 * or LOCALLY reconstructed (see the module docblock's per-dep table).
 */
const CHILD_CALLBACK_DEPS = [
  'promptAiSdkStream',
  'promptAiSdk',
  'promptAiSdkStructured',
  'sendAction',
  'requestToolCall',
  'requestFiles',
  'requestOptionalFile',
  'requestMcpToolData',
  'handleStepsLogChunk',
  'sendSubagentChunk',
  'trackEvent',
  'fetch',
  'startAgentRun',
  'finishAgentRun',
  'addAgentStep',
  'fetchAgentFromDatabase',
  'consumeCreditsWithFallback',
  'databaseAgentCache',
  'getUserInfoFromApiKey',
] as const

/** Deps supplied over the parent bridge when `rpcSocketPath` is present. */
const BRIDGED_CHILD_DEP_NAMES = [
  'promptAiSdkStream',
  'promptAiSdk',
  'promptAiSdkStructured',
  'sendAction',
  'requestToolCall',
  'requestFiles',
  'requestOptionalFile',
  'requestMcpToolData',
  'handleStepsLogChunk',
  'sendSubagentChunk',
  'trackEvent',
  'fetch',
  'startAgentRun',
  'finishAgentRun',
  'addAgentStep',
  'fetchAgentFromDatabase',
  'consumeCreditsWithFallback',
] as const

/**
 * Deps the child reconstructs locally on every run (never bridged — see the
 * module docblock): a fresh per-run databaseAgentCache Map and a
 * null-failing getUserInfoFromApiKey.
 */
const LOCALLY_SUPPLIED_DEP_NAMES = [
  'databaseAgentCache',
  'getUserInfoFromApiKey',
] as const

/**
 * Names the required callback deps the request fails to supply — a REAL
 * per-dep check: a dep is supplied when it is bridged (socket present) or
 * locally reconstructible. Without `rpcSocketPath` no dep is bridged, so the
 * list is the full unbridged set and the unsupported-deps gate fails closed.
 */
export function missingChildCallbackDeps(
  request: SupervisedSpawnRequest,
): string[] {
  const bridged =
    typeof request.rpcSocketPath === 'string' && request.rpcSocketPath.length > 0
      ? new Set<string>(BRIDGED_CHILD_DEP_NAMES)
      : new Set<string>()
  const supplied = new Set<string>([
    ...bridged,
    ...LOCALLY_SUPPLIED_DEP_NAMES,
  ])
  return CHILD_CALLBACK_DEPS.filter((dep) => !supplied.has(dep))
}

/**
 * Structured 'unsupported-deps' failed receipt: field-complete,
 * `agentReceiptSchema`-valid, exit-code-free — the parent's settle chain
 * reconciles it exactly like any other failed spawn.
 */
export function buildUnsupportedDepsReceipt(params: {
  agentType: string
  agentId: string
  missing: string[]
}): AgentReceipt {
  return agentReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: generateCompactId(),
    taskId: `spawn-${params.agentId}`,
    role: 'specialist',
    agentId: params.agentId,
    status: 'failed',
    outcome: 'crashed',
    changedFiles: [],
    requirementsAddressed: [],
    acceptanceCriteriaAddressed: [],
    findingsAddressed: [],
    evidence: [],
    assumptions: [],
    unresolved: [],
    requestedValidation: [],
    artifacts: [],
    errors: [
      {
        code: 'unsupported-deps',
        message: `Supervised spawn of "${params.agentType}" cannot run: the required parent-callback deps (${params.missing.join(', ')}) are not serializable and are not bridged (P2-T8b). Only agents whose tools need no unbridged parent callbacks are eligible.`,
        retryable: false,
      },
    ],
    output: {
      errorMessage:
        'Supervised spawn degraded honestly: required parent-callback deps are not bridged (unsupported-deps).',
      partial: true,
    },
  })
}

/**
 * Rehydration validators for the serialized child-state slice.
 *
 * WHY: the request crosses the temp-file transport as JSON (parent-side
 * JSON.stringify → child-side JSON.parse), so any non-JSON-native value in
 * the child state was already coerced (a Date timestamp became an ISO
 * string) or the parent-side stringify threw (guarded in
 * supervised-spawn.ts). Presenting coerced/malformed fields to
 * `loopAgentSteps` under the live AgentState member types is a runtime
 * divergence from the in-process path that surfaces only as a mid-loop crash
 * settled as 'crashed'. Instead, a field that fails its structural check is
 * DROPPED here — the fresh initial-state default stands in, exactly like the
 * in-process fresh-spawn state — and the drop is logged to stderr (never
 * parsed into the receipt).
 */
const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural check for a rehydrated `messageHistory`: an array of objects
 * with a valid `role` and an array `content`, and every timestamp-ish
 * auxiliary field (`sentAt`) a finite NUMBER — an ISO-string value is the
 * fingerprint of a Date the JSON round trip already mangled.
 */
function isRehydratableMessageHistory(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (!isPlainObject(entry)) return false
    if (!(MESSAGE_ROLES as readonly unknown[]).includes(entry.role)) return false
    if (!Array.isArray(entry.content)) return false
    if (entry.sentAt !== undefined && typeof entry.sentAt !== 'number') return false
    return true
  })
}

/**
 * Structural check for a rehydrated `workspaceState` (WorkspaceStateV1):
 * schemaVersion 1, finite numeric revision/updatedAt, and change records
 * whose `occurredAt` is a finite NUMBER (an ISO string = mangled Date).
 */
function isRehydratableWorkspaceState(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (value.schemaVersion !== 1) return false
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision)) return false
  if (typeof value.snapshotId !== 'string') return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  if (!Array.isArray(value.changes)) return false
  return value.changes.every((change) => {
    if (!isPlainObject(change)) return false
    if (typeof change.revision !== 'number' || !Number.isFinite(change.revision)) return false
    if (typeof change.source !== 'string') return false
    if (typeof change.occurredAt !== 'number' || !Number.isFinite(change.occurredAt)) return false
    return Array.isArray(change.actions)
  })
}

/** Logs a dropped-state diagnostic to stderr (never into the receipt). */
function logStateFieldDropped(field: string, reason: string): void {
  process.stderr.write(
    `child-entry: dropping rehydrated child-state field "${field}": ${reason} (fresh initial-state default stands in)\n`,
  )
}

/**
 * Rebuilds the child's AgentState from the serialized request slice. Fields
 * outside the request contract (agentContext, childRunIds, creditsUsed, ...)
 * come from `getInitialAgentState` — a supervised child always starts from a
 * fresh spawn-shaped state, which is what the parent serialized in the first
 * place.
 *
 * Every serialized state field is structurally VALIDATED before it is
 * assigned (see the rehydration-validator docblock above): a field that
 * fails validation is dropped — the fresh initial-state default stands in
 * — instead of being blind-cast to the live shape. Exported so the
 * rehydration-validation branches are directly testable.
 */
export function buildChildAgentState(request: SupervisedSpawnRequest) {
  const state = getInitialAgentState()
  state.agentId = request.child?.agentId ?? generateCompactId()
  const child =
    request.child ?? ({} as NonNullable<SupervisedSpawnRequest['child']>)
  if (child.messageHistory !== undefined) {
    if (isRehydratableMessageHistory(child.messageHistory)) {
      state.messageHistory = child.messageHistory as typeof state.messageHistory
    } else {
      logStateFieldDropped(
        'messageHistory',
        'failed rehydration validation (wrong shape, or a non-JSON-native value such as a Date timestamp was coerced by the JSON round trip)',
      )
    }
  }
  if (child.systemPrompt !== undefined) {
    state.systemPrompt = child.systemPrompt
  }
  if (child.taskMemory !== undefined) {
    const parsed = taskMemoryV1Schema.safeParse(child.taskMemory)
    if (parsed.success) {
      state.taskMemory = parsed.data
    } else {
      logStateFieldDropped('taskMemory', `failed schema validation: ${parsed.error.message}`)
    }
  }
  if (child.workspaceState !== undefined) {
    if (isRehydratableWorkspaceState(child.workspaceState)) {
      state.workspaceState = child.workspaceState as typeof state.workspaceState
    } else {
      logStateFieldDropped(
        'workspaceState',
        'failed rehydration validation (wrong shape, or a non-JSON-native value such as a Date timestamp was coerced by the JSON round trip)',
      )
    }
  }
  if (child.contextTokenCount !== undefined) {
    state.contextTokenCount = child.contextTokenCount
  }
  if (child.contextWindowTokens !== undefined) {
    if (
      typeof child.contextWindowTokens === 'number' &&
      Number.isFinite(child.contextWindowTokens) &&
      child.contextWindowTokens > 0
    ) {
      state.contextWindowTokens = child.contextWindowTokens
    } else {
      logStateFieldDropped(
        'contextWindowTokens',
        'failed rehydration validation (not a finite positive number)',
      )
    }
  }
  state.ancestorRunIds = [...(request.ancestorRunIds ?? [])]
  return state
}

/**
 * Re-coerce every schema member of the transported localAgentTemplates back
 * to a live zod schema. The request file is a JSON.stringify transport
 * boundary: live zod schemas degrade to plain JSON-Schema objects (or, worse,
 * degraded zod-v4 husks that still carry the `~standard` marker but no live
 * internals). loopAgentSteps indexes localAgentTemplates[id] directly (tool
 * set construction, set_output schema, prompts) without passing through the
 * getAgentTemplate coercion backstop, so an uncoerced husk reaches the AI
 * SDK's asSchema, which reads schema._def.typeName on undefined and crashes
 * the child run. Exported so this transport-boundary repair is directly
 * testable.
 */
export function rehydrateLocalAgentTemplates(
  templates: SupervisedSpawnRequest['localAgentTemplates'],
): Record<string, AgentTemplate> {
  const source = templates ?? {}
  // Degradation signal: ensureAgentTemplateZodSchemas returns the original
  // template BY REFERENCE when no member needs coercion, so an identity
  // change reliably marks a template whose schema members arrived degraded.
  const reCoercedIds: string[] = []
  const result = Object.fromEntries(
    Object.entries(source).map(([id, template]) => {
      const coerced = ensureAgentTemplateZodSchemas(template as AgentTemplate)
      if (coerced !== template) reCoercedIds.push(id)
      return [id, coerced]
    }),
  )
  if (reCoercedIds.length > 0) {
    // Diagnostics go to stderr only (never parsed into the receipt) — the
    // same contract as logStateFieldDropped above. This is the one place
    // binary users can see WHICH bundled/transported agents arrived with
    // degraded schemas if the silent-spawn failure mode ever resurfaces.
    process.stderr.write(
      `child-entry: re-coerced degraded schema members on ${reCoercedIds.length} transported template(s): ${reCoercedIds.join(', ')}\n`,
    )
  }
  return result
}

/**
 * Deps the child reconstructs LOCALLY (never bridged — see the module
 * docblock): a fresh per-run databaseAgentCache Map and a null-failing
 * getUserInfoFromApiKey. The bridged fetchAgentFromDatabase populates the
 * fresh cache, so published-agent memoization semantics are preserved.
 */
function buildLocalChildDeps(): {
  databaseAgentCache: Map<string, unknown>
  getUserInfoFromApiKey: () => Promise<null>
} {
  return {
    databaseAgentCache: new Map(),
    getUserInfoFromApiKey: async () => null,
  }
}

/**
 * Structured failed receipt for a bridge/loop failure (outcome 'crashed',
 * one error entry). Field-complete and schema-valid; exit-code-free like the
 * unsupported-deps degradation. Used on the paths where the full in-process
 * receipt derivation is unavailable (import failure, bridge-connect failure)
 * and for any loop throw.
 */
function buildFailedChildReceipt(params: {
  agentType: string
  agentId: string
  message: string
}): AgentReceipt {
  return agentReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: generateCompactId(),
    taskId: `spawn-${params.agentId}`,
    role: 'specialist',
    agentId: params.agentId,
    status: 'failed',
    outcome: 'crashed',
    changedFiles: [],
    requirementsAddressed: [],
    acceptanceCriteriaAddressed: [],
    findingsAddressed: [],
    evidence: [],
    assumptions: [],
    unresolved: [],
    requestedValidation: [],
    artifacts: [],
    errors: [
      {
        message: `Supervised child "${params.agentType}" failed: ${params.message}`,
        retryable: false,
      },
    ],
    output: {
      errorMessage: params.message,
      partial: true,
    },
  })
}

/**
 * Builds the supervised child's `onResponseChunk` stream forwarder (wired
 * into the loop params by {@link runSupervisedChildEntry}): the child's OWN
 * live stream, relayed to the parent so the CLI renders the child's activity
 * in the agent block it already created from the spawn event — keyed to the
 * child's own `agentId` (never a fresh id) and the request's verbatim
 * `userInputId`, mirroring the foreground spawn path's forwarding rule
 * (spawn-agents.ts `onResponseChunk`).
 *
 * Forward rule:
 *  - a string chunk forwards verbatim over the bridged fire-and-forget
 *    `sendSubagentChunk` display channel;
 *  - a `text`-type PrintModeEvent forwards its non-empty `text` as the string
 *    chunk on that same channel;
 *  - a `reasoning_delta` PrintModeEvent forwards its non-empty `text` as a
 *    REASONING chunk — the same `chunk` string on the display channel, tagged
 *    with `chunkKind: 'reasoning'` and carrying the event's `ancestorRunIds`
 *    verbatim, so the SDK maps it to the SAME `reasoning_chunk` stream event
 *    the root loop emits for its own reasoning deltas (see sdk/src/run.ts
 *    `onResponseChunk`);
 *  - EVERY other PrintModeEvent variant (tool_call, tool_result,
 *    subagent_start, subagent_finish, phase, error, ...) is relayed over the
 *    EXISTING bridged `sendAction` channel as a `response-chunk` action whose
 *    `chunk` is the event VERBATIM. That is the exact shape the parent's
 *    `sendAction` handler routes to `onResponseChunk`, which forwards a
 *    non-string, non-`reasoning_delta` chunk to `handleEvent` — the SAME
 *    `createEventHandler` path the in-process path uses. So the supervised
 *    child's tool/lifecycle events render identically to the orchestrator's
 *    own, instead of being silently dropped. `sendAction` is chosen over
 *    `sendSubagentChunk` deliberately: the display channel's contract carries
 *    text/reasoning chunks only, and widening `SendSubagentChunkFn` would be a
 *    contract change.
 *
 * BOUNDED: exactly one `sendAction` notification is emitted per non-text
 * event — no per-token or per-field fan-out — so a chatty child cannot starve
 * the parent's fire-and-forget notify budget (see the bridge client's
 * `bridge_notify_overflow` saturation reply, logged loudly child-side).
 *
 * Never throws: a forwarding failure is swallowed after one stderr warn per
 * run — a display-stream failure must never crash the child run, and the
 * bridge client already logs notify-overflow/failure replies loudly
 * child-side (not duplicated here). Exported so the forwarding contract is
 * directly testable.
 */
export function buildChildOnResponseChunk(params: {
  sendSubagentChunk: SendSubagentChunkFn
  sendAction: SendActionFn
  agentId: string
  agentType: string
  userInputId: string
  prompt: string | undefined
  logger: Logger
}): (chunk: string | PrintModeEvent) => void {
  const {
    sendSubagentChunk,
    sendAction,
    agentId,
    agentType,
    userInputId,
    prompt,
    logger,
  } = params
  let warnedForwardFailure = false
  return (chunk: string | PrintModeEvent): void => {
    try {
      if (typeof chunk === 'string') {
        sendSubagentChunk({ userInputId, agentId, agentType, chunk, prompt })
        return
      }
      if (chunk.type === 'text') {
        if (chunk.text) {
          sendSubagentChunk({
            userInputId,
            agentId,
            agentType,
            chunk: chunk.text,
            prompt,
          })
        }
        return
      }
      if (chunk.type === 'reasoning_delta') {
        if (chunk.text) {
          sendSubagentChunk({
            userInputId,
            agentId,
            agentType,
            chunk: chunk.text,
            prompt,
            chunkKind: 'reasoning',
            ancestorRunIds: chunk.ancestorRunIds,
          })
        }
        return
      }
      // Remaining PrintModeEvent variants (tool_call, tool_result,
      // subagent_start, subagent_finish, phase, error, ...): relay the event
      // VERBATIM to the parent over the bridged sendAction channel as a
      // `response-chunk` action. The parent's sendAction routes a non-string,
      // non-reasoning_delta chunk to handleEvent — the same createEventHandler
      // path the in-process stream uses — so the child's tool/lifecycle events
      // render exactly like the orchestrator's own. Exactly ONE notification
      // per event (no per-token fan-out), keeping the notify budget bounded.
      sendAction({
        action: { type: 'response-chunk', userInputId, chunk },
      })
    } catch (error) {
      // A display-stream failure must never crash the child run: swallow it
      // after one stderr warn (the bridge client already logs notify
      // overflow/failure replies loudly, so this covers local bugs only).
      if (!warnedForwardFailure) {
        warnedForwardFailure = true
        logger.warn(
          {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'supervised child display-stream forwarding failed; further forwarding failures are swallowed',
        )
      }
    }
  }
}

/**
 * Runs the child entry logic for one parsed request and returns the single
 * receipt envelope to write. Pure with respect to stdout/stderr/exit — the
 * main() below owns the process contract.
 *
 * Failure discipline: ANY bridge or loop failure resolves to the structured
 * failed receipt (outcome 'crashed') — it never throws past this boundary,
 * so the process contract (exactly one envelope, exit 0) holds.
 */
export const CHILD_LOOP_CLEANUP_TIMEOUT_MS = 5_000

export async function abortAndAwaitChildLoop<T>(
  loopPromise: Promise<T>,
  abortLoop: () => void,
  onCleanupTimeout?: () => void,
  cleanupTimeoutMs = CHILD_LOOP_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  abortLoop()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const cleanupDeadline = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      onCleanupTimeout?.()
      resolve()
    }, cleanupTimeoutMs)
  })
  // Cleanup only needs settlement, not the loop's result. Observe both outcomes
  // here while leaving the original loop promise's rejection intact for the
  // caller's failure-receipt path.
  await Promise.race([
    loopPromise.then(
      () => undefined,
      () => undefined,
    ),
    cleanupDeadline,
  ])
  if (timeout !== undefined) clearTimeout(timeout)
}

export async function runSupervisedChildEntry(
  request: SupervisedSpawnRequest,
): Promise<AgentReceipt> {
  const agentId = request.child?.agentId ?? generateCompactId()

  const missing = missingChildCallbackDeps(request)
  if (missing.length > 0) {
    return buildUnsupportedDepsReceipt({
      agentType: request.agentType,
      agentId,
      missing,
    })
  }

  // LAZY and WRAPPED: loopAgentSteps pulls a large dependency graph (and
  // spawn-agent-utils re-exports the in-process receipt builder). If either
  // import fails, the failure lands in the same structured failed receipt
  // instead of breaking the exactly-one-envelope process contract.
  let loopAgentStepsFn: (params: unknown) => Promise<{
    agentState: unknown
    output: unknown
  }>
  let buildRuntimeAgentReceiptFn: (params: {
    agentType: string
    agentId: string
    output: unknown
    agentState?: unknown
    error?: unknown
  }) => AgentReceipt
  try {
    const [{ loopAgentSteps }, { buildRuntimeAgentReceipt }] = await Promise.all([
      import('../run-agent-step'),
      import('../tools/handlers/tool/spawn-agent-utils'),
    ])
    loopAgentStepsFn = loopAgentSteps as unknown as typeof loopAgentStepsFn
    buildRuntimeAgentReceiptFn =
      buildRuntimeAgentReceipt as unknown as typeof buildRuntimeAgentReceiptFn
  } catch (error) {
    return buildFailedChildReceipt({
      agentType: request.agentType,
      agentId,
      message: `bridge-import-failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const { connectChildBridge, buildBridgedChildDeps } = await import(
    './child-bridge-client'
  )
  let client: ChildBridgeClient
  try {
    client = await connectChildBridge(request.rpcSocketPath as string)
  } catch (error) {
    return buildFailedChildReceipt({
      agentType: request.agentType,
      agentId,
      message: `bridge-connect-failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  try {
    const childState = buildChildAgentState(request)
    // The per-table bridge marker nonce (see bridge-protocol.ts's
    // collision-proof sentinel) rides on the request envelope; the child
    // sanitizer stamps markers with it so the parent rehydrates ONLY exact
    // matches. A raw parent table (no nonce) leaves it undefined: markers
    // cross the bridge as data, never substituted.
    const bridgedDeps = buildBridgedChildDeps(client, {
      bridgeNonce: request.rpcBridgeNonce,
    })
    // Fail-closed: a socket closed/disconnected mid-loop rejects this promise
    // promptly, racing the loop instead of hanging to the supervisor deadline.
    const bridgeFailure = new Promise<never>((_, reject) => {
      client.onClose(() => {
        reject(new Error('bridge socket closed mid-run'))
      })
    })
    bridgeFailure.catch(() => {}) // never unhandled; raced against the loop

    // Mirrors the in-process call in executeSubagent's loopAgentSteps branch:
    // the same request fields, with the child's rebuilt agentState and the
    // bridged callback deps standing in for the parent's live functions.
    // The loop's additionalToolDefinitions step runs
    // `Object.entries(fileContext.customToolDefinitions)` unguarded, so the
    // object members it reads are defaulted here exactly like the
    // schema-defaulted ProjectFileContext the in-process path always supplies.
    const fileContextRecord = (request.fileContext ?? {}) as Record<
      string,
      unknown
    >
    const fileContext = {
      ...fileContextRecord,
      customToolDefinitions:
        (fileContextRecord.customToolDefinitions as
          | Record<string, unknown>
          | undefined) ?? {},
    }
    const childLogger = createBridgeStderrLogger('child-agent')
    // The loop owns file/tool resources and is cancellable through its own
    // AbortController. It is aborted whenever the bridge fails so a mid-run
    // socket close actually stops the child's work instead of leaving the
    // losing loop promise running unobserved until process exit.
    const loopAbortController = new AbortController()
    const loopParams = {
      ...bridgedDeps,
      ...buildLocalChildDeps(),
      agentState: childState,
      agentType: request.agentType,
      prompt: request.prompt,
      spawnParams: request.spawnParams,
      fileContext,
      localAgentTemplates: rehydrateLocalAgentTemplates(
        request.localAgentTemplates,
      ),
      userId: request.userId,
      clientSessionId: request.clientSessionId ?? '',
      userInputId: request.userInputId ?? '',
      fingerprintId: request.fingerprintId ?? '',
      ancestorRunIds: [...(request.ancestorRunIds ?? [])],
      ...(request.parentSystemPrompt !== undefined
        ? { parentSystemPrompt: request.parentSystemPrompt }
        : {}),
      repoId: undefined,
      repoUrl: undefined,
      // The child's own allowlisted credential; the parent bridge re-stamps
      // its authoritative key on every bridged request that carries one.
      apiKey:
        process.env.OPENBUFF_API_KEY ?? process.env.CODEBUFF_API_KEY ?? '',
      clientEnv: clientProcessEnv,
      ciEnv: getCiEnv(),
      logger: childLogger,
      // The child's OWN live stream: text/reasoning deltas ride the bridged
      // fire-and-forget sendSubagentChunk display channel (the same shape the
      // foreground spawn path forwards) keyed to this child's own agentId so
      // the CLI appends to the EXISTING agent block; every other PrintModeEvent
      // rides the EXISTING bridged sendAction channel as a response-chunk
      // action so the child's tool/lifecycle events render like the parent's.
      // Never throws.
      onResponseChunk: buildChildOnResponseChunk({
        sendSubagentChunk: bridgedDeps.sendSubagentChunk,
        sendAction: bridgedDeps.sendAction,
        agentId,
        agentType: request.agentType,
        userInputId: request.userInputId ?? '',
        prompt: request.prompt,
        logger: childLogger,
      }),
      signal: loopAbortController.signal,
    }
    // Race the loop against the bridge-failure promise. On the bridge-failure
    // branch the losing loop promise keeps running: its AbortController is
    // never aborted and the loop owns file/tool resources, so Promise.race
    // settling with the rejection left the loop running unobserved until
    // process exit. Abort the loop on EITHER outcome so a mid-run socket close
    // actually stops the child's work; the abort is idempotent and harmless
    // when the loop won (the run is already settled). A loop rejection remains
    // a rejection from this race and is converted by the outer catch into the
    // structured failed-child receipt. The abort is issued in a `finally` so
    // the invariant holds on BOTH branches: a loop that wins the race also sees
    // an aborted signal before any trailing cleanup runs.
    let loopResult: { agentState: unknown; output: unknown }
    // Keep the loop's rejection observable to the race below: a rejected child
    // loop must enter the structured failed-receipt path, never look like a
    // fulfilled result eligible for normal runtime receipt derivation. The
    // cleanup helper separately observes either settlement outcome after abort.
    const loopPromise = Promise.resolve(
      loopAgentStepsFn(loopParams),
    ).then((value) => value as { agentState: unknown; output: unknown })
    // A loop rejection propagates out of the race into the outer catch below
    // (structured failed-child receipt); the finally still aborts first.
    try {
      loopResult = (await Promise.race([loopPromise, bridgeFailure])) as {
        agentState: unknown
        output: unknown
      }
    } finally {
      // The loop owns the bridged resources. Abort it first, then await
      // cooperative settlement for a bounded interval. If the loop ignores
      // cancellation, close the bridge at the deadline so pending RPCs and
      // fire-and-forget resource ownership are released without depending on
      // the outer process-supervisor deadline.
      await abortAndAwaitChildLoop(
        loopPromise,
        () => {
          loopAbortController.abort()
        },
        () => {
          client.close()
        },
      )
    }

    // Mirror the in-process settle chain's receipt derivation exactly.
    return buildRuntimeAgentReceiptFn({
      agentType: request.agentType,
      agentId,
      output: loopResult.output,
      agentState: loopResult.agentState,
    })
  } catch (error) {
    return buildFailedChildReceipt({
      agentType: request.agentType,
      agentId,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    client.close()
  }
}

/**
 * Stdout sink for the single-envelope contract. Injectable so tests can
 * capture the emitted bytes without owning the process' real stdout.
 */
export type ChildEntryWrite = (line: string) => void | Promise<void>

const defaultWrite: ChildEntryWrite = (line) => {
  void Bun.write(Bun.stdout, line)
}

/**
 * Process entry contract: read the request file, emit EXACTLY ONE
 * newline-terminated JSON envelope on stdout, exit 0 on ok / 1 otherwise.
 * Diagnostics go to stderr only (never parsed into the receipt).
 *
 * A bridge/loop failure inside {@link runSupervisedChildEntry} still yields
 * an envelope (exit 0, the structured failed receipt); exit 1 is reserved
 * for process-level failures like the missing-argv / corrupt-request cases.
 */
export async function runChildEntryMain(
  argv: string[],
  write: ChildEntryWrite = defaultWrite,
): Promise<number> {
  const requestPath = argv[2]
  if (!requestPath) {
    process.stderr.write('child-entry: missing request-file argv\n')
    return 1
  }
  let request: SupervisedSpawnRequest
  try {
    const parsed: unknown = JSON.parse(readFileSync(requestPath, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { agentType?: unknown }).agentType !== 'string'
    ) {
      throw new Error('request file is not a SupervisedSpawnRequest envelope')
    }
    request = parsed as SupervisedSpawnRequest
  } catch (error) {
    process.stderr.write(
      `child-entry: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
  let envelope: AgentReceipt
  try {
    envelope = await runSupervisedChildEntry(request)
  } catch (error) {
    // Total contract: even an unexpected entry failure must emit exactly one
    // valid envelope (the structured failed receipt) and exit 0.
    envelope = buildFailedChildReceipt({
      agentType: request.agentType,
      agentId: request.child?.agentId ?? 'unknown-agent',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  await write(`${JSON.stringify(envelope)}\n`)
  return 0
}

if (import.meta.main) {
  process.exit(await runChildEntryMain(process.argv))
}
