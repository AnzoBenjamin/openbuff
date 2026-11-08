import {
  LOCAL_MODE_USER_EMAIL,
  LOCAL_MODE_USER_ID,
} from '@codebuff/common/constants/local-mode'
import { env as clientEnvDefault } from '@codebuff/common/env'
import { getCiEnv } from '@codebuff/common/env-ci'
import { clientEnvSchema } from '@codebuff/common/env-schema'
import { success } from '@codebuff/common/util/error'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type { ExecutionActor, ExecutionHostOperationOrigin, OnExecutionActionStart, RequestMcpToolDataFn, RequestToolCallFn, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import { isContextPrunerAgentId } from '@codebuff/agent-runtime/util/context-pruner-identity'
import { CONSOLIDATOR_AGENT_ID } from '@codebuff/agent-runtime/util/context-consolidation'

import { promptAiSdk, promptAiSdkStream, promptAiSdkStructured } from './llm'
import { resolveModelContextWindow } from './model-provider'
import { getCapturedProviderConfig } from '../host-config'
import type { RunHostServices } from '../host-execution'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import {
  getByokOpenrouterApiKeyFromEnv,
  getChatGptOAuthTokenFromEnv,
  getOpenbuffApiKeyFromEnv,
  getSystemProcessEnv,
} from '../env'

// The key list comes from a leaf module so this seam can enumerate it
// WITHOUT evaluating the supervisor module: supervised-spawn keeps the
// supervisor (and the receipt-schema imports it pulls) lazy behind its
// dynamic import, so the flag-off hot path never touches them.
import { SUPERVISED_CHILD_RUNTIME_ENV_KEYS } from '@codebuff/agent-runtime/supervision/supervised-child-env-keys'
import {
  buildDefaultSpawnSupervised,
  isSupervisedSpawnSupported,
} from '@codebuff/agent-runtime/supervision/supervised-spawn'

import type { SupervisedChildEnvSeed } from '@codebuff/agent-runtime/supervision/process-supervisor'

import type { RunResumeReport } from '@codebuff/agent-runtime/util/run-journal'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { DatabaseAgentCache } from '@codebuff/common/types/contracts/database'
import type { ConsumeCreditsWithFallbackFn } from '@codebuff/common/types/contracts/billing'
import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  AddAgentStepFn,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyInput,
  GetUserInfoFromApiKeyFn,
  StartAgentRunFn,
  UserColumn,
} from '@codebuff/common/types/contracts/database'

const databaseAgentCache: DatabaseAgentCache = new Map()

const PROCESS_SUPERVISION_ON = /^(1|true|yes|on)$/i
const PROCESS_SUPERVISION_OFF = /^(0|false|no|off)$/i

/** Apply the established local client defaults without consulting ambient env. */
const capturedClientEnv = (environment: Readonly<Record<string, string | undefined>>): ClientEnv =>
  clientEnvSchema.parse({
    NEXT_PUBLIC_CB_ENVIRONMENT: environment.NEXT_PUBLIC_CB_ENVIRONMENT ?? 'dev',
    NEXT_PUBLIC_CODEBUFF_APP_URL: environment.NEXT_PUBLIC_CODEBUFF_APP_URL ?? 'http://localhost:3000',
    NEXT_PUBLIC_OPENBUFF_APP_URL: environment.NEXT_PUBLIC_OPENBUFF_APP_URL,
    NEXT_PUBLIC_SUPPORT_EMAIL: environment.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@openbuff.local',
    NEXT_PUBLIC_POSTHOG_API_KEY: environment.NEXT_PUBLIC_POSTHOG_API_KEY ?? 'openbuff-local',
    NEXT_PUBLIC_POSTHOG_HOST_URL: environment.NEXT_PUBLIC_POSTHOG_HOST_URL ?? 'https://app.posthog.com',
    NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: environment.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID,
  })

/**
 * P2-T8: resolution of the `OPENBUFF_PROCESS_SUPERVISION` env var.
 * Supervision is ON by default; the value is trimmed and matched
 * case-insensitively against whole tokens:
 *
 *   unset / empty / whitespace-only  => true  (default on)
 *   `1` / `true` / `yes` / `on`       => true
 *   `0` / `false` / `no` / `off`      => false (opt-out)
 *   any other value                   => true  (keeps the default)
 *
 * Matching is anchored, so e.g. `nothing` is not read as `no`. This only
 * resolves the env var: when the caller passes no `processSupervision`,
 * getAgentRuntimeImpl also requires the supervised child to be launchable
 * (see resolveDefaultProcessSupervision), so under Node, inside the
 * compiled CLI binary, and on Windows subagents stay in-process. Exported so
 * tests can assert the truth table.
 */
export const isProcessSupervisionEnabled = (
  env: Record<string, string | undefined>,
): boolean => {
  const raw = env.OPENBUFF_PROCESS_SUPERVISION
  if (raw === undefined) {
    return true
  }
  return !PROCESS_SUPERVISION_OFF.test(raw.trim())
}

/**
 * P2-T8: the default when the caller passes no `processSupervision`. On when
 * the env var allows it AND the supervised child can be launched in this
 * runtime (isSupervisedSpawnSupported). If the env var explicitly asks for
 * supervision (`1`/`true`/`yes`/`on`) but the child cannot be launched, a
 * warning is logged and subagents run in-process.
 */
const resolveDefaultProcessSupervision = (logger: Logger, env = getSystemProcessEnv()): boolean => {
  if (!isProcessSupervisionEnabled(env)) {
    return false
  }
  if (isSupervisedSpawnSupported()) {
    return true
  }
  const raw = env.OPENBUFF_PROCESS_SUPERVISION
  if (raw !== undefined && PROCESS_SUPERVISION_ON.test(raw.trim())) {
    logger.warn(
      { OPENBUFF_PROCESS_SUPERVISION: raw },
      'Process supervision was requested, but the supervised child process cannot be launched in this runtime (it needs Bun with the child entry file on disk, not on Windows); subagents will run in-process.',
    )
  }
  return false
}

/**
 * P2-T8: the supervised-child env allowlist seed, sourced EXPLICITLY at this
 * SDK seam (the only place ambient `process.env` may be read for this
 * feature — agent-runtime production files never read ambient env).
 *
 * PATH/HOME are deliberately NOT seeded here: the default seam invokes the
 * child through the absolute `process.execPath`, so no PATH inheritance is
 * needed for the Bun runtime itself, and the P2-T8b bridged child runs the
 * agent loop over the sandbox RPC socket rather than native tools. A later
 * slice that enables native-tool children must seed them explicitly and
 * document that choice on `SupervisedChildEnvSeed`.
 */
const buildSupervisedChildEnvSeedFromSystemEnv = (env = getSystemProcessEnv(), parentMediated = false): SupervisedChildEnvSeed => {
  // Runtime pass-through keys (provider-config endpoint override, proxy,
  // TMPDIR/locale, ripgrep override) are picked ONE named key at a time
  // from the closed SUPERVISED_CHILD_RUNTIME_ENV_KEYS universe — ambient
  // env is never forwarded wholesale.
  const passthroughEnv: SupervisedChildEnvSeed['passthroughEnv'] = {}
  for (const key of SUPERVISED_CHILD_RUNTIME_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) {
      passthroughEnv[key] = value
    }
  }
  return {
    ...(!parentMediated && getOpenbuffApiKeyFromEnv(env)
      ? { openbuffApiKey: getOpenbuffApiKeyFromEnv(env) }
      : {}),
    ...(!parentMediated && getByokOpenrouterApiKeyFromEnv(env)
      ? { byokOpenrouterApiKey: getByokOpenrouterApiKeyFromEnv(env) }
      : {}),
    ...(!parentMediated && getChatGptOAuthTokenFromEnv(env)
      ? { chatGptOauthToken: getChatGptOAuthTokenFromEnv(env) }
      : {}),
    ...(env.NODE_ENV ? { nodeEnv: env.NODE_ENV } : {}),
    ...(Object.keys(passthroughEnv).length > 0 ? { passthroughEnv } : {}),
  }
}

/**
 * P2-audit-fix-8: the concrete deps superset this seam returns — the contract
 * deps plus the additive-optional production `resumeDriver`
 * (sdk/src/services/run-resume-driver.ts). The key is present ONLY when the
 * caller wired one, so a run without a journal carries no resumeDriver field
 * and stays byte-identical.
 */
export type AgentRuntimeImplDeps = AgentRuntimeDeps &
  AgentRuntimeScopedDeps & {
    resumeDriver?: (report: RunResumeReport) => Promise<unknown>
  }

export type RegisterExecutionActor = (registration: Readonly<{
  actor: ExecutionActor
  parentActor?: ExecutionActor
  executionContext?: ExecutionAdapterContext
  ancestorRunIds: readonly string[]
}>) => void

const nonemptyExecutionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const actorKey = (actor: ExecutionActor) => JSON.stringify([actor.rootRunId, actor.runId, actor.agentId])
const actionKey = (identity: ToolExecutionIdentity) => JSON.stringify([actorKey(identity), identity.actionId, identity.attemptId])
const matchesHostOperation = (origin: ExecutionHostOperationOrigin, actor: ExecutionActor, templateId: string) =>
  origin.actor && actorKey(origin.actor) === actorKey(actor) &&
  (origin.purpose === 'semantic-compaction' ? isContextPrunerAgentId(templateId) :
    origin.purpose === 'snapshot-consolidation' && templateId === CONSOLIDATOR_AGENT_ID)
const sameIdentity = (left: ToolExecutionIdentity, right: ToolExecutionIdentity) =>
  actorKey(left) === actorKey(right) && left.actionId === right.actionId && left.attemptId === right.attemptId &&
  left.basisId === right.basisId && left.basis.inputHash === right.basis?.inputHash &&
  left.basis.workspaceRevision === right.basis?.workspaceRevision && left.workspaceSnapshotId === right.workspaceSnapshotId

/** Parent-owned bridge registry. Wire descriptions cannot choose an existing sibling/root owner. */
export function createSupervisedExecutionScope(p: {
  request: SupervisedSpawnRequest
  executionContext: ExecutionAdapterContext
  registerExecutionActor: RegisterExecutionActor
  onExecutionActionStart: OnExecutionActionStart
  startAgentRun: StartAgentRunFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  executionForAction?: (identity: ToolExecutionIdentity) => ExecutionAdapterContext
  executionForActorOperation?: (actor: ExecutionActor) => ExecutionAdapterContext
}) {
  const parentIdentity = p.request.executionIdentity
  const hostOperation = p.request.executionHostOperation
  const parentOrigin = parentIdentity ?? hostOperation?.actor
  const childId = p.request.child?.agentId
  const childTemplateId = p.request.agentType
  const ancestors = p.request.ancestorRunIds
  if (!parentOrigin || (parentIdentity && hostOperation) ||
    !nonemptyExecutionId(childId) || !nonemptyExecutionId(childTemplateId) || !ancestors?.length ||
    (hostOperation && !matchesHostOperation(hostOperation, parentOrigin, childTemplateId)) ||
    ancestors[0] !== parentOrigin.rootRunId || ancestors.at(-1) !== parentOrigin.runId ||
    ancestors.some(value => !nonemptyExecutionId(value))) throw new Error('Supervised execution lineage is unavailable')
  const parentActor: ExecutionActor = Object.freeze({ runId: parentOrigin.runId, rootRunId: parentOrigin.rootRunId, agentId: parentOrigin.agentId })
  const rootAncestors = Object.freeze([...ancestors])
  const actors = new Map<string, { actor: ExecutionActor; ancestors: readonly string[]; context: ExecutionAdapterContext }>()
  const actions = new Map<string, ToolExecutionIdentity>()
  const actionContexts = new Map<string, ExecutionAdapterContext>()
  const operationContexts = new Map<string, ExecutionAdapterContext>()
  const pendingAgentIds = new Set<string>()
  let initialRegistrationStarted = false
  const signal = p.executionContext.execution.signal
  if (!signal) throw new Error('Supervised execution lifetime is unavailable')
  const checkSignal = (candidate?: AbortSignal) => { signal.throwIfAborted(); if (candidate?.aborted) candidate.throwIfAborted() }
  const checkContext = (context: ExecutionAdapterContext) => {
    const requestSignal = context.execution.signal
    if (!requestSignal) throw new Error('Supervised child spawning context signal is unavailable')
    checkSignal(requestSignal)
    context.signal?.throwIfAborted()
  }
  const requireActor = (candidate: ExecutionActor | undefined): ExecutionActor => {
    checkSignal()
    const registered = candidate && actors.get(candidate.runId)
    if (!registered || actorKey(registered.actor) !== actorKey(candidate!)) throw new Error('Unregistered supervised execution actor')
    checkContext(registered.context)
    return registered.actor
  }
  const startAgentRun: StartAgentRunFn = async input => {
    checkSignal()
    const lineage = input.ancestorRunIds
    const runtimeInput = input as typeof input & { agentState?: { agentId?: unknown }; executionIdentity?: ToolExecutionIdentity;
      executionHostOperation?: ExecutionHostOperationOrigin }
    const agentId = runtimeInput.agentState?.agentId
    if (!Array.isArray(lineage) || !nonemptyExecutionId(agentId)) throw new Error('Supervised actor registration requires runtime state')
    const isInitial = !initialRegistrationStarted
    const parent = isInitial ? undefined : actors.get(lineage.at(-1) ?? '')
    const expected = isInitial ? rootAncestors : parent ? [...parent.ancestors, parent.actor.runId] : undefined
    if (!expected || JSON.stringify(lineage) !== JSON.stringify(expected) ||
      (isInitial && (agentId !== childId || input.agentId !== childTemplateId)) ||
      agentId === parentActor.agentId || pendingAgentIds.has(agentId) || [...actors.values()].some(value => value.actor.agentId === agentId))
      throw new Error('Supervised actor ancestry does not match its parent scope')
    let executionContext = p.executionContext
    if (!isInitial) {
      const origin = runtimeInput.executionHostOperation, identity = runtimeInput.executionIdentity
      if (origin) {
        if (identity || !matchesHostOperation(origin, parent!.actor, input.agentId))
          throw new Error('Supervised host-operation origin does not match its registered parent')
        const key = actorKey(parent!.actor)
        const context = operationContexts.get(key) ?? p.executionForActorOperation?.(parent!.actor)
        if (!context) throw new Error('Supervised child host-operation context is unavailable')
        operationContexts.set(key, context)
        executionContext = context
      } else {
        const registered = identity && actions.get(actionKey(identity))
        if (!registered || !sameIdentity(registered, identity!) || actorKey(identity!) !== actorKey(parent!.actor))
          throw new Error('Supervised child lacks its acknowledged spawning action')
        const key = actionKey(registered)
        const context = actionContexts.get(key) ?? p.executionForAction?.(registered)
        if (!context) throw new Error('Supervised child spawning action context is unavailable')
        actionContexts.set(key, context)
        executionContext = context
      }
    }
    if (parent) checkContext(parent.context)
    checkContext(executionContext)
    initialRegistrationStarted = true
    pendingAgentIds.add(agentId)
    let runId: string | null
    try { runId = await p.startAgentRun({ ...input, ancestorRunIds: [...expected] }) }
    finally { pendingAgentIds.delete(agentId) }
    checkContext(executionContext)
    if (!nonemptyExecutionId(runId) || rootAncestors.includes(runId) || actors.has(runId)) throw new Error('Invalid host-issued supervised run ID')
    const actor: ExecutionActor = Object.freeze({ runId, rootRunId: parentActor.rootRunId, agentId })
    p.registerExecutionActor({ actor, parentActor: parent?.actor ?? parentActor,
      executionContext, ancestorRunIds: expected })
    actors.set(runId, { actor, ancestors: Object.freeze([...expected]), context: executionContext })
    return runId
  }
  const onExecutionActionStart: OnExecutionActionStart = async start => {
    checkSignal(start.signal)
    const actor = requireActor(start.identity)
    const value = start.identity
    if (!nonemptyExecutionId(value.actionId) || !nonemptyExecutionId(value.attemptId) || !nonemptyExecutionId(start.toolName) ||
      !value.basis || value.basis.inputHash !== hashActionInput(start.toolName, start.input) ||
      Object.keys(value.basis).some(key => !['inputHash', 'workspaceRevision'].includes(key)) ||
      (value.basis.workspaceRevision !== undefined && (!Number.isSafeInteger(value.basis.workspaceRevision) || value.basis.workspaceRevision < 0)) ||
      (value.workspaceSnapshotId !== undefined && !nonemptyExecutionId(value.workspaceSnapshotId)) ||
      value.basisId !== hashActionInput('openbuff.execution-b02-basis.v1', { basis: value.basis, workspaceSnapshotId: value.workspaceSnapshotId ?? null }))
      throw new Error('Supervised action basis does not match its original input')
    const identity: ToolExecutionIdentity = Object.freeze({ ...actor, actionId: value.actionId, attemptId: value.attemptId,
      basisId: value.basisId, basis: Object.freeze({ ...value.basis }), ...(value.workspaceSnapshotId ? { workspaceSnapshotId: value.workspaceSnapshotId } : {}) })
    const key = actionKey(identity), existing = actions.get(key)
    if (existing) {
      if (!sameIdentity(existing, identity)) throw new Error('Supervised action identity changed after registration')
      return
    }
    await p.onExecutionActionStart({ ...start, identity, signal: actors.get(actor.runId)!.context.execution.signal! })
    requireActor(actor)
    actions.set(key, identity)
  }
  const requestToolCall: RequestToolCallFn = input => {
    checkSignal(input.signal)
    requireActor(input.executionIdentity)
    const identity = input.executionIdentity && actions.get(actionKey(input.executionIdentity))
    if (!identity || !sameIdentity(identity, input.executionIdentity!) ||
      input.executionRequestHash !== hashActionInput(input.toolName, input.input))
      throw new Error('Supervised tool request lacks its registered action or exact forwarded input')
    return p.requestToolCall({ ...input, executionIdentity: identity, signal })
  }
  const requestMcpToolData: RequestMcpToolDataFn = input => {
    checkSignal(input.signal)
    return p.requestMcpToolData({ ...input, executionActor: requireActor(input.executionActor), signal })
  }
  return { startAgentRun, onExecutionActionStart, requestToolCall, requestMcpToolData }
}

export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    apiKey: string
    hostServices?: RunHostServices
    supervisedExecutionForRequest?: (request: SupervisedSpawnRequest) => ExecutionAdapterContext
    /** Root-only lookup of the already registered original spawning action. */
    executionForAction?: (identity: ToolExecutionIdentity) => ExecutionAdapterContext
    /** Root-owned infrastructure operation under the registered actor lifetime. */
    executionForActorOperation?: (actor: ExecutionActor) => ExecutionAdapterContext
    registerExecutionActor?: RegisterExecutionActor
    onExecutionActionStart?: OnExecutionActionStart
    clientEnv?: ClientEnv
    /** P2-audit-fix-8: production crash-resume driver (additive-optional). */
    resumeDriver?: (report: RunResumeReport) => Promise<unknown>
  } & Pick<
    AgentRuntimeDeps,
    | 'journalWriter'
    | 'journalReader'
    | 'onPlaybookGateOutcome'
    | 'processSupervision'
    | 'spawnSupervised'
  > &
    Pick<
      AgentRuntimeScopedDeps,
      | 'handleStepsLogChunk'
      | 'requestToolCall'
      | 'requestMcpToolData'
      | 'requestFiles'
      | 'requestOptionalFile'
      | 'fileSystem'
      | 'fileFilter'
      | 'sendAction'
      | 'sendSubagentChunk'
    >,
): AgentRuntimeImplDeps {
  const {
    logger,
    apiKey,
    clientEnv = params.hostServices ? capturedClientEnv(params.hostServices.provider.credentialEnvironment) : clientEnvDefault,
    journalWriter,
    journalReader,
    onPlaybookGateOutcome,
    resumeDriver,
    processSupervision,
    spawnSupervised,
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    fileSystem,
    fileFilter,
    sendAction,
    sendSubagentChunk,
  } = params

  const trackSdkRuntimeEvent: TrackEventFn = () => {
    return
  }
  const llmDeps = params.hostServices?.llm
  const boundStream: typeof promptAiSdkStream = p => promptAiSdkStream(p, llmDeps)
  const boundPlain: typeof promptAiSdk = p => promptAiSdk(p, llmDeps)
  const boundStructured: typeof promptAiSdkStructured = (p) => promptAiSdkStructured(p, llmDeps)
  const boundContextWindow: typeof resolveModelContextWindow = p => resolveModelContextWindow({ ...p,
    ...(params.hostServices ? { loadedConfig: getCapturedProviderConfig(params.hostServices.provider.snapshot) } : {}) })
  const localActors = new Map<string, { actor: ExecutionActor; ancestorRunIds: readonly string[] }>()
  const localSpawnContexts = new Map<string, { identity: ToolExecutionIdentity; context: ExecutionAdapterContext }>()
  const localOperationContexts = new Map<string, ExecutionAdapterContext>()
  const boundStartAgentRun: StartAgentRunFn = async input => {
    if (!params.registerExecutionActor) return localStartAgentRun(input)
    // loopAgentSteps receives this identity through the runtime-owned spawn
    // context, before it replaces the parent actor with the child's new run.
    const runtimeInput = input as typeof input & {
      agentState?: { agentId?: unknown }
      executionIdentity?: ToolExecutionIdentity
      executionHostOperation?: ExecutionHostOperationOrigin
    }
    const agentId = runtimeInput.agentState?.agentId
    if (!nonemptyExecutionId(agentId) || !Array.isArray(input.ancestorRunIds) ||
      input.ancestorRunIds.some(value => !nonemptyExecutionId(value)))
      throw new Error('Runtime actor registration requires actual state and ancestry')
    const ancestorRunIds = Object.freeze([...input.ancestorRunIds])
    const parent = localActors.get(ancestorRunIds.at(-1) ?? '')
    let executionContext: ExecutionAdapterContext | undefined
    let executionSignal: AbortSignal | undefined
    if (ancestorRunIds.length) {
      const identity = runtimeInput.executionIdentity, origin = runtimeInput.executionHostOperation
      if (!parent || JSON.stringify(ancestorRunIds) !== JSON.stringify([...parent.ancestorRunIds, parent.actor.runId]))
        throw new Error('In-process child lacks its registered spawning actor and ancestry')
      if (origin) {
        if (identity || !matchesHostOperation(origin, parent.actor, input.agentId))
          throw new Error('In-process host-operation origin does not match its registered parent')
        const key = actorKey(parent.actor)
        executionContext = localOperationContexts.get(key) ?? params.executionForActorOperation?.(parent.actor)
        if (executionContext) localOperationContexts.set(key, executionContext)
      } else {
        if (!identity || actorKey(identity) !== actorKey(parent.actor))
          throw new Error('In-process child lacks its registered spawning actor and ancestry')
        const key = actionKey(identity)
        const existing = localSpawnContexts.get(key)
        if (existing && !sameIdentity(existing.identity, identity))
          throw new Error('Original spawning action identity changed after registration')
        executionContext = existing?.context ?? params.executionForAction?.(identity)
        if (executionContext && !existing) localSpawnContexts.set(key, {
          identity: Object.freeze({ ...identity, basis: Object.freeze({ ...identity.basis }) }), context: executionContext,
        })
      }
      if (!executionContext) throw new Error('In-process child spawning action context is unavailable')
      executionSignal = executionContext.execution.signal
      if (!executionSignal) throw new Error('In-process child spawning action signal is unavailable')
      executionSignal.throwIfAborted()
      executionContext.signal?.throwIfAborted()
    } else if (runtimeInput.executionIdentity || runtimeInput.executionHostOperation) {
      throw new Error('Root actor cannot adopt a child spawning identity')
    }
    const runId = await localStartAgentRun(input)
    if (runId) {
      executionSignal?.throwIfAborted()
      executionContext?.signal?.throwIfAborted()
      const actor = Object.freeze({ runId, rootRunId: ancestorRunIds[0] ?? runId, agentId })
      params.registerExecutionActor({ actor, parentActor: parent?.actor, executionContext, ancestorRunIds })
      localActors.set(runId, { actor, ancestorRunIds })
    }
    return runId
  }
  const supervisedContexts = new WeakMap<SupervisedSpawnRequest, ExecutionAdapterContext>()
  const supervisedExecutionForRequest = (request: SupervisedSpawnRequest) => {
    const existing = supervisedContexts.get(request)
    if (existing) return existing
    const context = params.supervisedExecutionForRequest?.(request)
    if (!context) {
      if (params.hostServices) throw new Error('Supervised execution requires a registered parent action')
      return undefined
    }
    const derived = context.execution.derive({ memoKey: 'supervised.action', limit: request.timeoutMs === undefined
      ? { kind: 'unbounded' } : { kind: 'finite', durationMs: request.timeoutMs } })
    if (!derived.ok) throw new Error(derived.cause)
    const bounded = Object.freeze({ ...context, execution: derived.value, signal: derived.value.signal })
    supervisedContexts.set(request, bounded)
    return bounded
  }

  return {
    onExecutionActionStart: params.onExecutionActionStart,
    // Environment
    clientEnv,
    ciEnv: getCiEnv(params.hostServices?.provider.credentialEnvironment),

    // Database
    getUserInfoFromApiKey: localGetUserInfoFromApiKey,
    fetchAgentFromDatabase: localFetchAgentFromDatabase,
    startAgentRun: boundStartAgentRun,
    finishAgentRun: localFinishAgentRun,
    addAgentStep: localAddAgentStep,

    // Billing
    consumeCreditsWithFallback: localConsumeCreditsWithFallback,

    // LLM
    promptAiSdkStream: boundStream,
    promptAiSdk: boundPlain,
    promptAiSdkStructured: boundStructured,
    resolveModelContextWindow: boundContextWindow,

    // Mutable State
    databaseAgentCache,

    // Analytics
    trackEvent: trackSdkRuntimeEvent,

    // Other
    logger: logger ?? noopLogger,
    fetch: globalThis.fetch,

    // Durable run journal (P2-T2). Additive-optional: the keys are present
    // ONLY when a journal is actually wired (conditional spreads), so a run
    // without a journal carries no journal fields at all and stays
    // byte-identical to today.
    ...(journalWriter ? { journalWriter } : {}),
    ...(journalReader ? { journalReader } : {}),

    // Fire-and-forget playbook counter persistence; absent = no reporting.
    ...(onPlaybookGateOutcome ? { onPlaybookGateOutcome } : {}),

    // P2-audit-fix-8: production resume driver. Additive-optional exactly
    // like the journal deps above: the key exists ONLY when the caller wired
    // one, so the default run's deps carry no resumeDriver field at all.
    ...(resumeDriver ? { resumeDriver } : {}),

    // Process supervision (P2-T8). The keys are present ONLY when
    // supervision resolves on. An explicit `processSupervision: true` forces
    // it on and `false` forces it off. When the caller passes nothing, it is
    // ON by default wherever the supervised child can be launched (Bun
    // runtime, child entry file on disk, not Windows), off under Node and
    // inside the compiled CLI binary, and off when
    // `OPENBUFF_PROCESS_SUPERVISION` is `0`/`false`/`no`/`off` (see
    // resolveDefaultProcessSupervision). The seam is seeded from this SDK env
    // seam (via getSystemProcessEnv) — never from ambient process.env inside
    // agent-runtime. When supervision is on WITHOUT an injected seam, the
    // default supervisor seam (supervision/supervised-spawn.ts →
    // supervision/child-entry.ts) is built here.
    ...(processSupervision === true ||
    (processSupervision === undefined &&
      resolveDefaultProcessSupervision(logger ?? noopLogger, params.hostServices?.provider.credentialEnvironment))
      ? {
          processSupervision: true,
          spawnSupervised:
            spawnSupervised ??
            // P2-T8b: the default seam now carries the parent-side RPC handler
            // table built from the deps available in THIS scope, so the
            // supervised child runs the REAL agent loop over the sandbox Unix
            // socket instead of degrading to 'unsupported-deps'. The handler
            // table is constructed only on this flag-on branch (the flag-off
            // path never evaluates it and stays byte-identical). The parent's
            // own apiKey/logger/trackEvent/database stubs are stamped into
            // every bridged request; scoped client deps (sendAction,
            // requestToolCall, ...) flow through unchanged.
            buildDefaultSpawnSupervised(
              buildSupervisedChildEnvSeedFromSystemEnv(params.hostServices?.provider.credentialEnvironment, params.hostServices !== undefined),
              // P2-T8b lazy-load discipline: the handler table is supplied as
              // a THUNK, so this composition root never statically imports
              // parent-bridge-server.ts (node:net + zod-from-json-schema);
              // both the bridge module and the table construction are
              // evaluated only on the flag-on spawn path (see
              // supervised-spawn.ts ParentBridgeHandlersSource).
              async (request) => {
                const executionContext = supervisedExecutionForRequest(request)
                if (executionContext && (!params.onExecutionActionStart || !params.registerExecutionActor))
                  throw new Error('Supervised execution actor registration is unavailable')
                const executionScope = executionContext ? createSupervisedExecutionScope({ request, executionContext,
                  onExecutionActionStart: params.onExecutionActionStart!, registerExecutionActor: params.registerExecutionActor!,
                  executionForAction: params.executionForAction, executionForActorOperation: params.executionForActorOperation,
                  startAgentRun: localStartAgentRun, requestToolCall, requestMcpToolData }) : undefined
                const { buildSupervisedBridgeHandlers } =
                  await import('@codebuff/agent-runtime/supervision/parent-bridge-server')
                const { createMcpBridgeScope } =
                  await import('@codebuff/common/mcp/provenance')
                return buildSupervisedBridgeHandlers(
                  {
                    promptAiSdkStream: boundStream,
                    promptAiSdk: boundPlain,
                    promptAiSdkStructured: boundStructured,
                    sendAction,
                    requestToolCall: executionScope?.requestToolCall ?? requestToolCall,
                    onExecutionActionStart: executionScope?.onExecutionActionStart,
                    requestFiles,
                    requestOptionalFile,
                    requestMcpToolData: executionScope?.requestMcpToolData ?? requestMcpToolData,
                    handleStepsLogChunk,
                    sendSubagentChunk,
                    trackEvent: trackSdkRuntimeEvent,
                    fetch: globalThis.fetch,
                    startAgentRun: executionScope?.startAgentRun ?? localStartAgentRun,
                    finishAgentRun: localFinishAgentRun,
                    addAgentStep: localAddAgentStep,
                    fetchAgentFromDatabase: localFetchAgentFromDatabase,
                    consumeCreditsWithFallback: localConsumeCreditsWithFallback,
                    apiKey,
                    logger: logger ?? noopLogger,
                  },
                  {
                    mcpScope: createMcpBridgeScope(request),
                    readCapabilityProjectId: (request.fileContext as { projectRoot?: string } | undefined)?.projectRoot,
                  },
                )
              },
              {
                // P2-T8c: a BOUNDED restart policy so production callers get
                // automatic bounded retries on transport-level child crashes.
                // maxAttempts is passed EXPLICITLY (never a default that could
                // silently become unbounded); on a deterministic crash the
                // loop stops after this many restarts and returns the last
                // settled result. This option rides INSIDE the flag-on branch
                // only — the flag-off seam never calls buildDefaultSpawnSupervised
                // and stays byte-identical.
                restart: { maxAttempts: 3 },
                executionForRequest: params.hostServices || params.supervisedExecutionForRequest ? request => {
                  const context = supervisedExecutionForRequest(request)
                  if (!context) throw new Error('Supervised execution requires a registered parent action')
                  return context
                } : undefined,
              },
            ),
        }
      : {}),

    // Client (WebSocket)
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    fileSystem,
    fileFilter,
    sendAction,
    sendSubagentChunk,

    apiKey,
  }
}

const localUser = {
  id: LOCAL_MODE_USER_ID,
  email: LOCAL_MODE_USER_EMAIL,
  discord_id: null,
  stripe_customer_id: null,
  banned: false,
  created_at: new Date(0),
}

const localGetUserInfoFromApiKey: GetUserInfoFromApiKeyFn = async <
  T extends UserColumn,
>({
  fields,
}: GetUserInfoFromApiKeyInput<T>) => {
  return Object.fromEntries(
    fields.map((field) => [field, localUser[field]]),
  ) as { [K in T]: (typeof localUser)[K] }
}

const localFetchAgentFromDatabase: FetchAgentFromDatabaseFn = async ({
  parsedAgentId,
  logger,
}) => {
  logger.debug(
    { parsedAgentId },
    'Local mode: skipping remote agent registry lookup',
  )
  return null
}

const localStartAgentRun: StartAgentRunFn = async () =>
  `local-run-${crypto.randomUUID()}`

const localFinishAgentRun: FinishAgentRunFn = async () => {}

// P2-T8b: hoisted from the inline seam arrow so the supervised-bridge handler
// table references the SAME billing stub the deps object exposes.
const localConsumeCreditsWithFallback: ConsumeCreditsWithFallbackFn =
  async () =>
    success({
      chargedToOrganization: false,
    })

const localAddAgentStep: AddAgentStepFn = async () =>
  `local-step-${crypto.randomUUID()}`

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
