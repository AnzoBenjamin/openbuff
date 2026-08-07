import z from 'zod/v4'

import { toolResultOutputSchema } from './messages/content-part'

export const printModeStartSchema = z.object({
  type: z.literal('start'),
  agentId: z.string().optional(),
  messageHistoryLength: z.number(),
})
export type PrintModeStart = z.infer<typeof printModeStartSchema>

export const printModeErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  // Concise, calm summary for agent-recoverable errors (e.g. a malformed tool
  // call the agent will auto-correct). When present, UIs should show this to
  // the user instead of the full `message`, which carries detailed recovery
  // context intended for the agent's message history.
  userMessage: z.string().optional(),
  // True when the runtime is already auto-correcting this error (e.g. a
  // malformed tool call the model is retrying). UIs should not surface these
  // as user-visible errors; the full `message` still flows to the agent.
  autoRecovering: z.boolean().optional(),
})
export type PrintModeError = z.infer<typeof printModeErrorSchema>

export const printModeProviderStatusSchema = z.object({
  type: z.literal('provider_status'),
  status: z.enum(['retrying', 'failover', 'recovered']),
  model: z.string().optional(),
  nextModel: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  delayMs: z.number().nonnegative().optional(),
  statusCode: z.number().int().optional(),
})
export type PrintModeProviderStatus = z.infer<
  typeof printModeProviderStatusSchema
>

export const printModeDownloadStatusSchema = z.object({
  type: z.literal('download'),
  version: z.string(),
  status: z.enum(['complete', 'failed']),
})
export type PrintModeDownloadStatus = z.infer<
  typeof printModeDownloadStatusSchema
>

export const printModeToolCallSchema = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.any()),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  includeToolCall: z.boolean().optional(),
  // True when this write tool call is waiting on a prior same-path write that is
  // still in flight (queued behind a per-path write barrier). Omitted for
  // read-only tools and for writes whose target path cannot be statically
  // determined (custom/MCP tools, multi-path edit_transaction). Lets the CLI
  // distinguish a "queued" write from one that is actively running but has no
  // result yet ("pending").
  queued: z.boolean().optional(),
  // Detached background shell (process) job id assigned when this tool call
  // launches a run_terminal_command BACKGROUND process. Lets the CLI correlate
  // later `job_update` events (M5) to this exact tool card. Omitted for
  // foreground tool calls that have no associated background job.
  backgroundJobId: z.string().optional(),
})
export type PrintModeToolCall = z.infer<typeof printModeToolCallSchema>

export const printModeToolStartSchema = z.object({
  type: z.literal('tool_start'),
  toolCallId: z.string(),
})
export type PrintModeToolStart = z.infer<typeof printModeToolStartSchema>

export const printModeToolResultSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  toolName: z.string(),
  output: toolResultOutputSchema.array(),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
})
export type PrintModeToolResult = z.infer<typeof printModeToolResultSchema>

export const printModeTextSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  agentId: z.string().optional(),
})
export type PrintModeText = z.infer<typeof printModeTextSchema>

export const printModeFinishSchema = z.object({
  type: z.literal('finish'),
  agentId: z.string().optional(),
  totalCost: z.number(),
})
export type PrintModeFinish = z.infer<typeof printModeFinishSchema>

export const printModeSubagentStartSchema = z.object({
  type: z.literal('subagent_start'),
  agentId: z.string(),
  agentType: z.string(),
  displayName: z.string(),
  onlyChild: z.boolean(),
  parentAgentId: z.string().optional(),
  params: z.record(z.string(), z.any()).optional(),
  prompt: z.string().optional(),
  /** Correlates this real agent with its optimistic spawn tool card. */
  spawnToolCallId: z.string().optional(),
  spawnIndex: z.number().int().nonnegative().optional(),
})
export type PrintModeSubagentStart = z.infer<
  typeof printModeSubagentStartSchema
>

export const printModeSubagentFinishSchema = z.object({
  type: z.literal('subagent_finish'),
  agentId: z.string(),
  agentType: z.string(),
  displayName: z.string(),
  onlyChild: z.boolean(),
  parentAgentId: z.string().optional(),
  params: z.record(z.string(), z.any()).optional(),
  prompt: z.string().optional(),
  spawnToolCallId: z.string().optional(),
  spawnIndex: z.number().int().nonnegative().optional(),
  // Present when the subagent finished due to an error (e.g. wall-clock
  // timeout) rather than completing normally. Lets the UI distinguish a
  // failed finish from a successful one.
  error: z.string().optional(),
})
export type PrintModeSubagentFinish = z.infer<
  typeof printModeSubagentFinishSchema
>

export const printModeReasoningDeltaSchema = z.object({
  type: z.literal('reasoning_delta'),
  text: z.string(),
  ancestorRunIds: z.string().array(),
  runId: z.string(),
  agentId: z.string().optional(),
})
export type PrintModeReasoningDelta = z.infer<
  typeof printModeReasoningDeltaSchema
>

export const printModePhaseSchema = z.object({
  type: z.literal('phase'),
  phase: z.enum([
    'gathering_context',
    'planning',
    'editing',
    'reviewing',
    'validating',
    'summarizing',
    'complete',
  ]),
  detail: z.string().optional(),
})
export type PrintModePhase = z.infer<typeof printModePhaseSchema>

export const printModeContextWindowSchema = z.object({
  type: z.literal('context_window'),
  used: z.number(),
  max: z.number(),
})
export type PrintModeContextWindow = z.infer<
  typeof printModeContextWindowSchema
>

const contextCategoryStatsSchema = z.object({
  tokens: z.number(),
  percent: z.number(),
  messages: z.number(),
})

const contextCategorySummarySchema = z.object({
  toolResults: contextCategoryStatsSchema,
  todos: contextCategoryStatsSchema,
  fileReads: contextCategoryStatsSchema,
  subagents: contextCategoryStatsSchema,
  userAssistantMessages: contextCategoryStatsSchema,
})

export const printModeContextCompactionSchema = z.object({
  type: z.literal('context_compaction'),
  action: z.enum(['semantic_compaction', 'mechanical_trim']),
  resolvedContextWindowTokens: z.number().optional(),
  // Optional for compatibility with persisted/replayed events emitted before
  // model-aware compaction telemetry was added.
  triggerBudgetTokens: z.number().optional(),
  targetBudgetTokens: z.number().optional(),
  reason: z.string().optional(),
  before: z.object({
    tokens: z.number(),
    messages: z.number(),
    categories: contextCategorySummarySchema,
  }),
  after: z.object({
    tokens: z.number(),
    messages: z.number(),
    categories: contextCategorySummarySchema,
  }),
  removedCategories: z
    .enum([
      'toolResults',
      'todos',
      'fileReads',
      'subagents',
      'userAssistantMessages',
    ])
    .array(),
  retainedKnowledgeMemory: z.boolean(),
  recovery: z.string(),
})
export type PrintModeContextCompaction = z.infer<
  typeof printModeContextCompactionSchema
>

/**
 * Live background-job update (M5). ADDITIVE, non-breaking public-contract
 * change: this is a NEW member of the {@link printModeEventSchema}
 * discriminated union — no existing event variant is removed, renamed, or
 * retyped, so no consumer migration or deprecation is required.
 *
 * Forward-compatibility contract for `handleEvent` consumers: an exhaustive
 * `switch`/match over `event.type` should treat unknown variants as no-ops
 * (the SDK's own default handler only branches on `error`, and the CLI
 * handler uses a catch-all `.otherwise`). Consumers that do not care about
 * background-job progress can safely ignore `job_update` events entirely.
 */
export const printModeJobUpdateSchema = z.object({
  type: z.literal('job_update'),
  jobId: z.string(),
  kind: z.enum(['process', 'agent']),
  state: z.enum([
    'queued',
    'running',
    'stopping',
    'completed',
    'error',
    'stopped',
    'lost',
    'cancelled',
  ]),
  sequence: z.number(),
  label: z.string().optional(),
  outputDelta: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  error: z.string().optional(),
})
export type PrintModeJobUpdate = z.infer<typeof printModeJobUpdateSchema>

export const printModeEventSchema = z.discriminatedUnion('type', [
  printModeDownloadStatusSchema,
  printModeErrorSchema,
  printModeFinishSchema,
  printModePhaseSchema,
  printModeProviderStatusSchema,
  printModeStartSchema,
  printModeSubagentFinishSchema,
  printModeSubagentStartSchema,
  printModeTextSchema,
  printModeToolCallSchema,
  printModeToolResultSchema,
  printModeToolStartSchema,

  printModeContextCompactionSchema,
  printModeContextWindowSchema,
  printModeJobUpdateSchema,
  printModeReasoningDeltaSchema,
])

export type PrintModeEvent = z.infer<typeof printModeEventSchema>
