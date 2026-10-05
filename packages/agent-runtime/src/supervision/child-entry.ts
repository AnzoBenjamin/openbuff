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
 * Other slice-1 scope notes:
 *  - the loop's `onResponseChunk` is a child-local no-op: print-mode events
 *    are parent-run-scoped, and child→parent display streaming flows through
 *    the bridged `sendSubagentChunk` / `handleStepsLogChunk` instead;
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
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
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
  state.ancestorRunIds = [...(request.ancestorRunIds ?? [])]
  return state
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
 * Runs the child entry logic for one parsed request and returns the single
 * receipt envelope to write. Pure with respect to stdout/stderr/exit — the
 * main() below owns the process contract.
 *
 * Failure discipline: ANY bridge or loop failure resolves to the structured
 * failed receipt (outcome 'crashed') — it never throws past this boundary,
 * so the process contract (exactly one envelope, exit 0) holds.
 */
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
    const loopParams = {
      ...bridgedDeps,
      ...buildLocalChildDeps(),
      agentState: childState,
      agentType: request.agentType,
      prompt: request.prompt,
      spawnParams: request.spawnParams,
      fileContext,
      localAgentTemplates: request.localAgentTemplates ?? {},
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
      logger: createBridgeStderrLogger('child-agent'),
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
    const loopResult = (await Promise.race([
      loopAgentStepsFn(loopParams),
      bridgeFailure,
    ])) as {
      agentState: unknown
      output: unknown
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
