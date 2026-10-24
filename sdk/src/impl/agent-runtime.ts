import {
  LOCAL_MODE_USER_EMAIL,
  LOCAL_MODE_USER_ID,
} from '@codebuff/common/constants/local-mode'
import { env as clientEnvDefault } from '@codebuff/common/env'
import { getCiEnv } from '@codebuff/common/env-ci'
import { success } from '@codebuff/common/util/error'

import { promptAiSdk, promptAiSdkStream, promptAiSdkStructured } from './llm'
import { resolveModelContextWindow } from './model-provider'
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
const resolveDefaultProcessSupervision = (logger: Logger): boolean => {
  const env = getSystemProcessEnv()
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
const buildSupervisedChildEnvSeedFromSystemEnv =
  (): SupervisedChildEnvSeed => {
    const env = getSystemProcessEnv()
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
      ...(getOpenbuffApiKeyFromEnv()
        ? { openbuffApiKey: getOpenbuffApiKeyFromEnv() }
        : {}),
      ...(getByokOpenrouterApiKeyFromEnv()
        ? { byokOpenrouterApiKey: getByokOpenrouterApiKeyFromEnv() }
        : {}),
      ...(getChatGptOAuthTokenFromEnv()
        ? { chatGptOauthToken: getChatGptOAuthTokenFromEnv() }
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

export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    apiKey: string
    clientEnv?: ClientEnv
    /** P2-audit-fix-8: production crash-resume driver (additive-optional). */
    resumeDriver?: (report: RunResumeReport) => Promise<unknown>
  } & Pick<
    AgentRuntimeDeps,
    | 'journalWriter'
    | 'journalReader'
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
    clientEnv = clientEnvDefault,
    journalWriter,
    journalReader,
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

  return {
    // Environment
    clientEnv,
    ciEnv: getCiEnv(),

    // Database
    getUserInfoFromApiKey: localGetUserInfoFromApiKey,
    fetchAgentFromDatabase: localFetchAgentFromDatabase,
    startAgentRun: localStartAgentRun,
    finishAgentRun: localFinishAgentRun,
    addAgentStep: localAddAgentStep,

    // Billing
    consumeCreditsWithFallback: localConsumeCreditsWithFallback,

    // LLM
    promptAiSdkStream,
    promptAiSdk,
    promptAiSdkStructured,
    resolveModelContextWindow,

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
      resolveDefaultProcessSupervision(logger ?? noopLogger))
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
              buildSupervisedChildEnvSeedFromSystemEnv(),
              // P2-T8b lazy-load discipline: the handler table is supplied as
              // a THUNK, so this composition root never statically imports
              // parent-bridge-server.ts (node:net + zod-from-json-schema);
              // both the bridge module and the table construction are
              // evaluated only on the flag-on spawn path (see
              // supervised-spawn.ts ParentBridgeHandlersSource).
              async () => {
                const { buildSupervisedBridgeHandlers } = await import(
                  '@codebuff/agent-runtime/supervision/parent-bridge-server'
                )
                return buildSupervisedBridgeHandlers({
                  promptAiSdkStream,
                  promptAiSdk,
                  promptAiSdkStructured,
                  sendAction,
                  requestToolCall,
                  requestFiles,
                  requestOptionalFile,
                  requestMcpToolData,
                  handleStepsLogChunk,
                  sendSubagentChunk,
                  trackEvent: trackSdkRuntimeEvent,
                  fetch: globalThis.fetch,
                  startAgentRun: localStartAgentRun,
                  finishAgentRun: localFinishAgentRun,
                  addAgentStep: localAddAgentStep,
                  fetchAgentFromDatabase: localFetchAgentFromDatabase,
                  consumeCreditsWithFallback: localConsumeCreditsWithFallback,
                  apiKey,
                  logger: logger ?? noopLogger,
                })
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
const localConsumeCreditsWithFallback: ConsumeCreditsWithFallbackFn = async () =>
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
