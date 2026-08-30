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

/**
 * Context-compaction telemetry on the public `handleEvent` surface.
 *
 * ADDITIVE, non-breaking public-contract change: every field added after the
 * original `before`/`after`/`removedCategories`/`retainedKnowledgeMemory`/
 * `recovery` core is optional, so persisted or replayed events emitted before
 * that telemetry existed still validate and consumers that ignore the new
 * fields keep their previous behavior. No consumer migration is required. The
 * documented contract lives in `docs/agents-and-tools.md` under
 * "Context-window-aware compaction budgets".
 */
export const printModeContextCompactionSchema = z.object({
  type: z.literal('context_compaction'),
  action: z.enum(['semantic_compaction', 'mechanical_trim']),
  // Agent/run correlation for the loop that compacted. `loopAgentSteps` runs
  // for the root turn, for foreground subagents, and for inline agents, so a
  // consumer that keeps per-turn state MUST scope this payload — `runId`
  // identifies the emitting run and `ancestorRunIds` is its lineage (empty
  // ONLY for the root run). Those two are the authoritative keys: they are
  // forwarded verbatim by every hop between the emitting run and the consumer.
  // `agentId` is stamped by the emitting run but is NOT reliable end-to-end —
  // the `spawn_agents` forwarding path rewrites it to the direct child's agent
  // id on every forwarded event that is not text/tool/subagent, so for a run
  // nested two or more levels deep the DELIVERED `agentId` names the nearest
  // forwarding child rather than the emitter. Treat it as a display hint and
  // key per-agent state off `runId`. All three are optional for compatibility
  // with persisted/replayed events emitted before the fields existed; an event
  // without `ancestorRunIds` predates nested-run attribution and stays
  // root-attributed, which is the previous behavior.
  runId: z.string().optional(),
  ancestorRunIds: z.string().array().optional(),
  agentId: z.string().optional(),
  resolvedContextWindowTokens: z.number().optional(),
  // Optional for compatibility with persisted/replayed events emitted before
  // model-aware compaction telemetry was added.
  triggerBudgetTokens: z.number().optional(),
  targetBudgetTokens: z.number().optional(),
  // Also optional for compatibility with persisted/replayed events emitted
  // before anti-thrash and fit-verification telemetry existed: how many
  // compactions the EMITTING agent run (`runId` above) has performed — not a
  // per-turn total across nested runs, so a consumer tracking one run's count
  // must ignore counts correlated to another run — how many consecutive ones
  // reclaimed almost nothing, and (mechanical trims only) whether the trimmed
  // request actually fits the budget, by how many tokens it misses, and
  // whether the escalation pass had to drop extra optional messages.
  compactionCount: z.number().optional(),
  consecutiveNoProgressCompactions: z.number().optional(),
  shortfallTokens: z.number().optional(),
  fitsBudget: z.boolean().optional(),
  escalated: z.boolean().optional(),
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
 * Live context-compaction progress. ADDITIVE, non-breaking public-contract
 * change: this is a NEW member of the {@link printModeEventSchema}
 * discriminated union — no existing event variant is removed, renamed, or
 * retyped, so no consumer migration or deprecation is required. In particular
 * the terminal {@link printModeContextCompactionSchema} result event keeps its
 * exact shape.
 *
 * PRODUCER CONTRACT. Every `loopAgentSteps` invocation emits this event —
 * the root turn, foreground subagents, and inline agents alike — so every
 * emission is correlated to its own run by the required `runId` /
 * `ancestorRunIds` pair (`agentId` is supplied when the producer knows it, and
 * is rewritten by subagent forwarding — see the CONSUMER CONTRACT below).
 * `state: 'started'` is emitted immediately before a step that is likely to run
 * semantic compaction (the pruner agent runs inline and is hidden from the
 * CLI, so without this the user sees nothing until the result arrives).
 * `state: 'settled'` is emitted after the compaction branches for every
 * `started` of the SAME `runId`, and again on that run's exit path when a step
 * throws before reaching them, so a pass that decides NOT to compact cannot
 * leave a live state stuck on screen. A run emits at most one unsettled
 * `started` at a time. Both budgets and the pre-step context size are optional
 * because they are informational only.
 *
 * CONSUMER CONTRACT. Pair `started` with `settled` by `runId`: a `settled` from
 * one run never settles another run's `started`, so concurrent or nested loops
 * cannot cross-settle each other. `ancestorRunIds` is empty ONLY for the root
 * agent run (mirroring `printModeReasoningDelta`), so a consumer that renders
 * live compaction state as root-level UI must ignore events whose
 * `ancestorRunIds` is non-empty — otherwise a subagent's compaction shows up as
 * a root-level 'Compacting context…' card. Consumers that nest per-agent UI can
 * instead key off `runId`, which — like `ancestorRunIds` — is forwarded
 * verbatim. `agentId` is NOT a per-agent key: the `spawn_agents` forwarding
 * path overwrites it with the direct child's agent id on every forwarded event
 * that is not text/tool/subagent, so a depth>=2 run's delivered `agentId`
 * identifies the nearest forwarding child rather than the emitter.
 *
 * One case stays unreachable by construction: a user-initiated abort makes the
 * SDK drop every post-abort event, so a consumer that renders `started` as live
 * UI must be able to settle that state on its own — the CLI stamps its pending
 * card with the producing process id and renders a replayed one as an
 * interrupted pass, so a persisted transcript never replays a permanently live
 * card.
 *
 * Forward-compatibility contract for `handleEvent` consumers: an exhaustive
 * `switch`/match over `event.type` should treat unknown variants as no-ops
 * (the SDK's own default handler only branches on `error`, and the CLI handler
 * uses a catch-all `.otherwise`). Consumers that only care about the final
 * compaction result can safely ignore `context_compaction_status` entirely.
 */
export const printModeContextCompactionStatusSchema = z.object({
  type: z.literal('context_compaction_status'),
  state: z.enum(['started', 'settled']),
  // Required agent/run correlation: this event is stateful, so an unattributed
  // payload would be unusable — a consumer could not tell whose pending state
  // a `settled` belongs to, nor whether a `started` came from the root run.
  // `ancestorRunIds` is empty exactly for the root run.
  runId: z.string(),
  ancestorRunIds: z.string().array(),
  // Emitting agent id as stamped by the producer. Display hint only: subagent
  // forwarding rewrites it (see the CONSUMER CONTRACT above), so it is not a
  // stable per-agent key at nesting depth >= 2.
  agentId: z.string().optional(),
  contextTokens: z.number().optional(),
  resolvedContextWindowTokens: z.number().optional(),
  triggerBudgetTokens: z.number().optional(),
  targetBudgetTokens: z.number().optional(),
})
export type PrintModeContextCompactionStatus = z.infer<
  typeof printModeContextCompactionStatusSchema
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
  printModeContextCompactionStatusSchema,
  printModeContextWindowSchema,
  printModeJobUpdateSchema,
  printModeReasoningDeltaSchema,
])

export type PrintModeEvent = z.infer<typeof printModeEventSchema>
