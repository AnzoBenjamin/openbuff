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
  // call the agent will auto-correct, or a runtime-enforced tool-ordering
  // rejection the agent corrects by reordering). When present, UIs should show
  // this to the user instead of the full `message`, which carries detailed
  // recovery context intended for the agent's message history.
  userMessage: z.string().optional(),
  // True when the runtime is already steering the agent out of this error and
  // no user action is possible: a malformed tool call the model is retrying, or
  // a control-flow/ordering rejection (e.g. `suggest_followups` called before
  // the gate passed or after the turn's final tool) that the model resolves on
  // its own. UIs must not surface these as user-visible errors; the full
  // `message` still flows to the agent so it can correct itself.
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
  // Present when the subagent finished due to an error rather than completing
  // normally. Lets the UI distinguish a failed finish from a successful one.
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

/**
 * Live context-window usage for the status line.
 *
 * ADDITIVE, non-breaking public-contract change: the required `used`/`max`
 * pair is unchanged, and `compactionTriggerTokens`/`compactionTargetTokens`
 * were added afterwards. They report the runtime's model-aware
 * semantic-compaction budget for the ACTIVE model (exactly the values
 * `getSemanticCompactionBudget` returns for the resolved context window), so a
 * UI can show at what point compaction will fire instead of surprising the
 * user with it. Both are optional for compatibility with persisted or replayed
 * events emitted before the fields existed, and a consumer that ignores them
 * keeps its previous behavior — no consumer migration is required.
 *
 * RELATION TO `max` — the two are computed from DIFFERENT inputs, so a
 * consumer must NOT assume the trigger sits inside the reported window:
 *   - `max` is the status window: the resolved model context window, clamped
 *     by an explicit `maxContextLength` override when one is configured
 *     (`min(maxContextLength, contextWindow)`), and falling back to the flat
 *     190k default only when neither is known.
 *   - `compactionTriggerTokens`/`compactionTargetTokens` are derived from the
 *     RAW resolved model window alone and are deliberately NOT clamped by
 *     `maxContextLength` (an override does not move the window-derived
 *     trigger), and when that window is unknown they are the conservative
 *     140k/100k fallback budgets rather than anything derived from `max`.
 *
 * So `compactionTriggerTokens > max` is a legitimate, expected payload: an
 * override that shrinks `max` below the model's own trigger, or the
 * unknown-window fallback against a small configured window, both produce it.
 * The ONLY ordering guaranteed between the new fields themselves is
 * `1 <= compactionTargetTokens <= compactionTriggerTokens`. A consumer that
 * renders trigger against `max` (a marker on a usage bar, a percentage, a
 * warning threshold) must therefore clamp or suppress it for itself; the CLI
 * status bar drops the marker entirely once the trigger reaches `max`, since
 * pinning it to 100% would claim compaction fires exactly at the window edge.
 */
export const printModeContextWindowSchema = z.object({
  type: z.literal('context_window'),
  used: z.number(),
  max: z.number(),
  compactionTriggerTokens: z.number().optional(),
  compactionTargetTokens: z.number().optional(),
})
export type PrintModeContextWindow = z.infer<
  typeof printModeContextWindowSchema
>

const contextCategoryStatsSchema = z.object({
  tokens: z.number(),
  percent: z.number(),
  messages: z.number(),
})

// `boundedFileReads` is optional so persisted/replayed compaction events
// emitted before the bounded-vs-whole-file telemetry split (which lack the
// key) keep validating; the runtime always emits it for new events.
const contextCategorySummarySchema = z.object({
  toolResults: contextCategoryStatsSchema,
  todos: contextCategoryStatsSchema,
  fileReads: contextCategoryStatsSchema,
  boundedFileReads: contextCategoryStatsSchema.optional(),
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
      'boundedFileReads',
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
 *
 * EMISSION GATE. The only trigger is the window-derived semantic compaction
 * budget being exceeded by the pre-step context estimate. In particular:
 *   - It is NOT gated on the agent having a `handleSteps` generator. An
 *     orchestrator's generator spawns the pruner itself; a prompt-only
 *     template instead gets an equivalent runtime-driven pass, and both
 *     announce through this event. A consumer must therefore expect `started`
 *     from prompt-only agents too.
 *   - It IS suppressed for an iteration where the transient loop-owned
 *     anti-thrash advisory is active (`suppressSemanticCompaction` on the
 *     agent state, set after consecutive passes reclaimed no context space in
 *     the current turn and reset at loop entry). A suppressed iteration runs
 *     no pass and emits NEITHER half of the pair — it is not reported as a
 *     `started`/`settled` no-op — so a consumer must not infer "the trigger
 *     was never exceeded" from the absence of an event.
 *   - It is deliberately NOT gated on an explicit `maxContextLength` override,
 *     so an overridden run does not emit a `started` on every step.
 *   - For the runtime-driven (prompt-only) pass, the ordinary spawn-permission
 *     contract still applies AFTER the announcement: a template that does not
 *     declare `context-pruner` in its `spawnableAgents` announces a pass that
 *     then declines to spawn, so an announced pass is not a guarantee that any
 *     compaction happened. The terminal `context_compaction` result remains
 *     the only signal that context was actually reclaimed.
 *
 * `state: 'settled'` is emitted after the compaction branches for every
 * `started` of the SAME `runId`, and again on that run's exit path when a step
 * throws or is cancelled before reaching them, so a pass that decides NOT to
 * compact cannot leave a live state stuck on screen. A run emits at most one
 * unsettled `started` at a time. Both budgets and the pre-step context size are
 * optional because they are informational only.
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
 * Live progress WITHIN an announced context-compaction pass. ADDITIVE,
 * non-breaking public-contract change: this is a NEW member of the
 * {@link printModeEventSchema} discriminated union — no existing event variant
 * is removed, renamed, or retyped, so no consumer migration or deprecation is
 * required. In particular the `state` enum of
 * {@link printModeContextCompactionStatusSchema} is deliberately NOT widened to
 * carry progress: an added enum member would break a consumer that switches
 * exhaustively over it, while an unknown event `type` is already contractually
 * a no-op (see the forward-compatibility clause below).
 *
 * PRODUCER CONTRACT. This event only ever appears BETWEEN a
 * `context_compaction_status` `started` and its matching `settled` for the SAME
 * `runId`. The runtime emits it from deterministic milestones inside the
 * announced pass — `analyzing` as soon as the pass is announced, `summarizing`
 * per unit of observed pruner activity, `applying` once the pass has returned —
 * and emits nothing at all outside an announced pass, so a suppressed or
 * never-triggered iteration produces no progress events just as it produces
 * neither half of the status pair. Correlation mirrors
 * {@link printModeContextCompactionStatusSchema}: `runId` identifies the
 * emitting run and `ancestorRunIds` is its lineage (empty ONLY for the root
 * run); both are forwarded verbatim by every hop, while `agentId` is a display
 * hint only, because the `spawn_agents` forwarding path rewrites it and at
 * nesting depth >= 2 the delivered value names the nearest forwarding child
 * rather than the emitter.
 *
 * `percent` is a BEST-EFFORT monotonic 0..100 estimate of how far the announced
 * pass has progressed, never a guarantee. The pruner reports no total, two
 * producers emit for the same pass (the agent loop and the inline spawn path),
 * and events can be dropped or replayed, so a consumer MUST clamp for itself —
 * `Math.max` against the last value it rendered, bounded to 0..100 — rather
 * than trusting the sequence to arrive ordered or in range. `percent: 100` is
 * NOT a claim that any space was reclaimed: the terminal
 * {@link printModeContextCompactionSchema} result remains the ONLY signal that
 * context was actually reclaimed, exactly as it was before this variant
 * existed. Progress is telemetry, and no part of the compaction contract is
 * gated on it.
 *
 * Forward-compatibility contract for `handleEvent` consumers: an exhaustive
 * `switch`/match over `event.type` should treat unknown variants as no-ops
 * (the SDK's own default handler only branches on `error`, and the CLI handler
 * uses a catch-all `.otherwise`). Consumers may ignore this variant entirely
 * and keep their previous behavior.
 */
export const printModeContextCompactionProgressSchema = z.object({
  type: z.literal('context_compaction_progress'),
  runId: z.string(),
  ancestorRunIds: z.string().array(),
  agentId: z.string().optional(),
  /** Monotonic 0..100 completion estimate for the announced pass. */
  percent: z.number(),
  phase: z.enum(['analyzing', 'summarizing', 'applying']),
  contextTokens: z.number().optional(),
  targetBudgetTokens: z.number().optional(),
})
export type PrintModeContextCompactionProgress = z.infer<
  typeof printModeContextCompactionProgressSchema
>

/**
 * Request-time emergency context trim. ADDITIVE, non-breaking public-contract
 * change: this is a NEW member of the {@link printModeEventSchema}
 * discriminated union — no existing event variant is removed, renamed, or
 * retyped, so no consumer migration or deprecation is required. In particular
 * {@link printModeContextCompactionSchema} keeps its exact shape.
 *
 * PRODUCER CONTRACT. This reports the LAST-LINE-OF-DEFENSE trim performed at
 * request dispatch time, when the messages of an outgoing provider request
 * still exceed the provider-safe message budget after every runtime brake has
 * run. It is emitted only when that trim actually dropped messages. It is a
 * DIFFERENT event from `context_compaction`, which reports the runtime-owned
 * semantic and mechanical passes: a `context_request_trim` means those earlier
 * brakes were exceeded, so the two must not be merged or counted as one pass.
 * `messageBudgetTokens` is the message-only budget actually applied (the
 * resolved request budget minus the counted system + tool surface), and
 * `resolvedContextWindowTokens` is the post-routing model window when known.
 *
 * Agent/run correlation mirrors {@link printModeContextCompactionStatusSchema}:
 * `runId` identifies the emitting run and `ancestorRunIds` is its lineage
 * (empty ONLY for the root run); both are forwarded verbatim by every hop.
 * `agentId` is a display hint only — the `spawn_agents` forwarding path
 * rewrites it on every forwarded event that is not text/tool/subagent, so at
 * nesting depth >= 2 the delivered value names the nearest forwarding child
 * rather than the emitter. All three are optional so a persisted or replayed
 * payload emitted without correlation still validates.
 *
 * Forward-compatibility contract for `handleEvent` consumers: an exhaustive
 * `switch`/match over `event.type` should treat unknown variants as no-ops
 * (the SDK's own default handler only branches on `error`, and the CLI handler
 * uses a catch-all `.otherwise`). Consumers that only care about runtime-owned
 * compaction can safely ignore `context_request_trim` entirely.
 */
export const printModeContextRequestTrimSchema = z.object({
  type: z.literal('context_request_trim'),
  runId: z.string().optional(),
  ancestorRunIds: z.string().array().optional(),
  agentId: z.string().optional(),
  resolvedContextWindowTokens: z.number().optional(),
  messageBudgetTokens: z.number(),
  beforeTokens: z.number(),
  afterTokens: z.number(),
  beforeMessages: z.number(),
  afterMessages: z.number(),
  model: z.string().optional(),
})
export type PrintModeContextRequestTrim = z.infer<
  typeof printModeContextRequestTrimSchema
>

/**
 * Request-time sibling of {@link printModeContextRequestTrimSchema}: the
 * payload type of the optional `onRequestContextTrimmed` callback on the
 * published `promptAiSdk`/`promptAiSdkStream`/`promptAiSdkStructured`
 * signatures. It carries the same trim measurements as the event, minus the
 * run correlation the runtime stamps on when it forwards the trim as an event.
 *
 * DECLARED HERE rather than re-exported from `./contracts/llm` (which now
 * re-exports it back, so the runtime and SDK call sites that consume the
 * callback keep importing it from the same place): the SDK entry point
 * publishes THIS module's types wholesale and the published `dist/index.d.ts`
 * is generated from that entry point alone, so a declaration the published
 * module owns cannot be lost by a bundler resolving a re-export chain into an
 * unpublished internal module. `cli/src/utils/__tests__/sdk-event-handlers.test.ts`
 * names the type through `@openbuff/sdk` to pin that published path.
 *
 * `contextWindowTokens` is the resolved model window when known;
 * `messageBudgetTokens` is the message-only budget applied after reserving the
 * counted system + tool surface. Widening this is a public-contract change:
 * only add optional fields.
 */
export type RequestContextTrimInfo = {
  contextWindowTokens?: number
  messageBudgetTokens: number
  beforeTokens: number
  afterTokens: number
  beforeMessages: number
  afterMessages: number
  model?: string
}

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
  printModeContextCompactionProgressSchema,
  printModeContextCompactionStatusSchema,
  printModeContextRequestTrimSchema,
  printModeContextWindowSchema,
  printModeJobUpdateSchema,
  printModeReasoningDeltaSchema,
])

export type PrintModeEvent = z.infer<typeof printModeEventSchema>
