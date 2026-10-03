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

import type { SupervisedChildEnvSeed } from '@codebuff/agent-runtime/supervision/process-supervisor'
import { buildDefaultSpawnSupervised } from '@codebuff/agent-runtime/supervision/supervised-spawn'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { DatabaseAgentCache } from '@codebuff/common/types/contracts/database'
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

/**
 * P2-T8: truthiness resolution for the `OPENBUFF_PROCESS_SUPERVISION` flag,
 * matching the `OPENBUFF_COLLECT_FULL_FILE_CONTEXT` convention in
 * packages/agent-runtime find-files.ts: `1`/`true`/`yes`/`on`
 * (case-insensitive, trimmed). Exported so tests can assert the exact
 * truthiness table.
 */
export const isProcessSupervisionEnabled = (
  env: Record<string, string | undefined>,
): boolean => {
  const raw = env.OPENBUFF_PROCESS_SUPERVISION
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim())
}

/**
 * P2-T8: the supervised-child env allowlist seed, sourced EXPLICITLY at this
 * SDK seam (the only place ambient `process.env` may be read for this
 * feature — agent-runtime production files never read ambient env).
 *
 * PATH/HOME are deliberately NOT seeded here: the default seam invokes the
 * child through the absolute `process.execPath`, so no PATH inheritance is
 * needed for the Bun runtime itself, and this slice's limited supervised
 * agent class cannot run native tools (the parent→child RPC bridge has not
 * landed). A later slice that enables native-tool children must seed them
 * explicitly and document that choice on `SupervisedChildEnvSeed`.
 */
const buildSupervisedChildEnvSeedFromSystemEnv =
  (): SupervisedChildEnvSeed => {
    const env = getSystemProcessEnv()
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
    }
  }

export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    apiKey: string
    clientEnv?: ClientEnv
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
): AgentRuntimeDeps & AgentRuntimeScopedDeps {
  const {
    logger,
    apiKey,
    clientEnv = clientEnvDefault,
    journalWriter,
    journalReader,
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
    consumeCreditsWithFallback: async () =>
      success({
        chargedToOrganization: false,
      }),

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

    // Process supervision (P2-T8). Additive-optional like the journal deps
    // above: the keys are present ONLY when the
    // `OPENBUFF_PROCESS_SUPERVISION` flag resolves truthy (or the caller
    // passed `processSupervision: true` explicitly), so the default run
    // carries no supervision fields at all and the agent-runtime spawn path
    // stays byte-identical. The seam is seeded from this SDK env seam (via
    // getSystemProcessEnv) — never from ambient process.env inside
    // agent-runtime. When the flag is on WITHOUT an injected seam, the
    // default supervisor seam (supervision/supervised-spawn.ts →
    // supervision/child-entry.ts) is built here.
    ...(processSupervision === true ||
    (processSupervision === undefined &&
      isProcessSupervisionEnabled(getSystemProcessEnv()))
      ? {
          processSupervision: true,
          spawnSupervised:
            spawnSupervised ??
            buildDefaultSpawnSupervised(buildSupervisedChildEnvSeedFromSystemEnv()),
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

const localAddAgentStep: AddAgentStepFn = async () =>
  `local-step-${crypto.randomUUID()}`

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
