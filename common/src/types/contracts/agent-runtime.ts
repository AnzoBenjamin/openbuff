import type { TrackEventFn } from './analytics'
import type { ConsumeCreditsWithFallbackFn } from './billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from './client'
import type {
  AddAgentStepFn,
  DatabaseAgentCache,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyFn,
  StartAgentRunFn,
} from './database'
import type { ClientEnv, CiEnv } from './env'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
} from './llm'
import type { Logger } from './logger'
import type { CodebuffFileSystem } from '../filesystem'

/** Deterministic id generation (P2-T1). */
export interface IdGen {
  /** replaces crypto.randomUUID() */
  uuid(): string
  /** prefixed id, e.g. prefixedId('xml') -> 'xml-<uuid>' */
  prefixedId(prefix: string, separator?: string): string
}

/** Deterministic wall-clock (P2-T1). */
export interface Clock {
  /** replaces Date.now() for persisted state-timestamps */
  now(): number
}

/** One append-only run-journal event (P2-T2). JSON-serializable payload. */
export interface JournalEvent {
  eventType:
    | 'llm_request'
    | 'llm_response'
    | 'tool_call'
    | 'tool_result'
    | 'spawn'
    | 'step_boundary'
    | 'error'
  stepNumber: number
  correlation?: string | null
  payload: unknown
}

/** Append-only journal writer (P2-T2). Mints `seq` monotonically per runId. */
export interface JournalWriter {
  append(runId: string, event: JournalEvent): void
}

/** Journal reader used for crash classification and replay (P2-T2). */
export interface JournalReader {
  lastEvent(runId: string): (JournalEvent & { seq: number }) | undefined
  events(runId: string): Array<JournalEvent & { seq: number }>
  /** tool_result payload for a toolCallId, if journaled (replay short-circuit). */
  toolResultFor(runId: string, toolCallId: string): unknown | undefined
}

/** Shared dependencies */
export type AgentRuntimeDeps = {
  // Environment
  clientEnv: ClientEnv
  ciEnv: CiEnv

  // Database
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn

  // Billing
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn

  // LLM
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn
  /** Resolve the smallest declared context window across the agent's primary
   * BYOK route and configured failovers before a run. */
  resolveModelContextWindow?: (params: {
    agentId?: string
    model?: string
  }) => number | undefined

  // Mutable State
  databaseAgentCache: DatabaseAgentCache

  // Analytics
  trackEvent: TrackEventFn

  // Other
  logger: Logger
  fetch: typeof globalThis.fetch

  // Determinism (P2-T1)
  /** Injectable id generator; resolves to realIdGen when omitted. */
  idGen?: IdGen
  /** Injectable wall-clock; resolves to realClock when omitted. */
  clock?: Clock

  // Durable run journal (P2-T2)
  /** Append-only run-journal writer; when omitted, no journaling occurs. */
  journalWriter?: JournalWriter
  /** Run-journal reader for crash classification + replay short-circuit. */
  journalReader?: JournalReader
}

/** Per-run dependencies */
export type AgentRuntimeScopedDeps = {
  // Client (WebSocket)
  handleStepsLogChunk: HandleStepsLogChunkFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  /** Filesystem view used by runtime-native discovery tools such as read_subtree. */
  fileSystem?: CodebuffFileSystem
  /** Shared path policy classifier; blocked paths are omitted from discovery. */
  fileFilter?: (path: string) => {
    status: 'blocked' | 'allow-example' | 'allow'
  }
  sendAction: SendActionFn
  sendSubagentChunk: SendSubagentChunkFn

  apiKey: string
}
