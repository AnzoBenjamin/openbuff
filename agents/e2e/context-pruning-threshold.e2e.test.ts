/**
 * E2E Test: Context Pruning Threshold Verification
 *
 * This test verifies that context pruning triggers at the correct token count
 * threshold and not prematurely. It uses the real token counting API and
 * a multi-turn conversation to accumulate context naturally.
 *
 * Background: A previous bug caused the token counting API to either fail
 * (falling back to a local overcounting formula) or apply a 30% buffer
 * for non-Anthropic models, causing pruning to trigger at ~140k instead
 * of the 200k limit. This test ensures:
 *
 * 1. Pruning does NOT trigger when token count is well below the limit
 * 2. Pruning DOES trigger when token count exceeds the limit
 * 3. The token count reported by the API is accurate (no 30% buffer for Anthropic models)
 * 4. After pruning, tool-call/tool-result pairs remain intact
 *
 * Detection strategy: We detect pruning by checking for significant message
 * count reduction and token count reduction. The context-pruner may produce
 * a <conversation_summary> message, OR the fallback trimMessagesToFitTokenLimit
 * may produce a compacted-context pointer. Both count as successful pruning for
 * our purposes.
 */

import {
  OpenbuffClient,
  initialSessionState,
  withMessageHistory,
  type AgentDefinition,
  type Message,
  type ToolMessage,
  type JSONValue,
} from '@openbuff/sdk'
import { beforeAll, describe, expect, it } from 'bun:test'

import {
  isTextPart,
  makeLargeContent,
  isToolCallPart,
  isToolMessageWithId,
  verifyToolCallPairIntegrity,
} from './helpers/pruning-test-helpers'

type SpawnAgentInlineToolInput = {
  agent_type: string
  params?: Record<string, unknown>
  prompt?: string
}
import { setupE2eMocks } from '../../sdk/e2e/utils/e2e-mocks'

import contextPruner from '../context-pruner'

// Typed wrapper preserves schema-drift detection via `satisfies` — avoids `as unknown` erasure (RF-3 companion).
const prunerAgent = contextPruner satisfies AgentDefinition

// Helper to create a text message
const createMessage = (
  role: 'user' | 'assistant',
  content: string,
): Message => ({
  role,
  content: [{ type: 'text', text: content }],
})

// Helper to create a tool call message
const createToolCallMessage = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
    },
  ],
})

// Helper to create a tool result message
const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  value: JSONValue,
): ToolMessage => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [{ type: 'json', value }],
})

/**
 * Test agent that auto-spawns context-pruner inline before each step,
 * exactly mirroring how base2 works in production.
 *
 * The handleSteps function uses ({ params }) to receive maxContextLength
 * from client.run({ params: { maxContextLength: ... } }), which flows through
 * as spawnParams → toolCallParams → generator params, matching base2 exactly.
 */
const testAgent: AgentDefinition = {
  id: 'context-pruning-threshold-test-agent',
  displayName: 'Context Pruning Threshold Test Agent',
  model: 'anthropic/claude-haiku-4.5',
  includeMessageHistory: true,
  toolNames: ['spawn_agents'],
  spawnableAgents: ['context-pruner'],
  instructionsPrompt: `You are a test agent for verifying context pruning behavior. When the user asks you to do something, do it briefly and concisely. Just say "OK" or "DONE" as requested.`,
  handleSteps: function* ({ params }: any) {
    while (true) {
      yield {
        toolName: 'spawn_agent_inline',
        input: {
          agent_type: 'context-pruner',
          params: (params as Record<string, unknown> | undefined) ?? {},
        },
        includeToolCall: false,
      } as any

      const { stepsComplete } = (yield 'STEP' as any) as { stepsComplete: boolean }
      if (stepsComplete) break
    }
  },
}

/**
 * Builds a message history targeting a specific approximate token count.
 *
 * Token estimation uses word-based content (NATO alphabet words repeated)
 * which tokenizes at a predictable ~4 chars/token for Anthropic models.
 * This is much more accurate than repeated 'x' characters which compress
 * to ~5-6 chars/token, making estimates unreliable.
 *
 * Each round creates user (8k chars) + assistant (8k chars) +
 * tool pair every other round (~4k chars). At ~4 chars/token:
 * - User message: 8k/4 = 2k tokens
 * - Assistant message: 8k/4 = 2k tokens
 * - Tool pair (every other round avg): ~550 tokens
 * - Tokens per round ≈ 4,550
 * - Plus system prompt + tool definitions add ~15-20k tokens
 */
const LARGE_CONTENT_SIZE = 8_000
const CHARS_PER_TOKEN = 4
const TOOL_PAIR_TOKENS = 550 // avg tokens for tool call + result every other round
const TOKENS_PER_ROUND = Math.ceil(
  (2 * LARGE_CONTENT_SIZE) / CHARS_PER_TOKEN + TOOL_PAIR_TOKENS,
)



function buildMessageHistory(targetApproxTokens: number): Message[] {
  const messages: Message[] = []
  const roundsNeeded = Math.max(
    1,
    Math.ceil(targetApproxTokens / TOKENS_PER_ROUND),
  )
  const now = Date.now()

  // (quiet: removed console.log noise for CI diagnostics)

  for (let i = 0; i < roundsNeeded; i++) {
    // Add sentAt timestamps so context-pruner's cache-miss detection works correctly.
    // Space messages 30s apart so no cache-miss (>5min gap) is triggered inadvertently.
    const sentAt = now - (roundsNeeded - i) * 30_000

    // User message with diverse word content (~4 chars/token)
    const userMsg = createMessage(
      'user',
      makeLargeContent(`Round ${i + 1}: `, LARGE_CONTENT_SIZE),
    )
    userMsg.sentAt = sentAt
    messages.push(userMsg)

    // Assistant response with diverse word content
    const assistantMsg = createMessage(
      'assistant',
      makeLargeContent(`Response ${i + 1}: `, LARGE_CONTENT_SIZE),
    )
    assistantMsg.sentAt = sentAt + 10_000
    messages.push(assistantMsg)

    // Add a tool call pair every other round for realism
    if (i % 2 === 0) {
      const callId = `call-${i}`
      messages.push(
        createToolCallMessage(callId, 'read_files', {
          paths: [`file-${i}.ts`],
        }),
      )
      messages.push(
        createToolResultMessage(callId, 'read_files', {
          content: makeLargeContent('', LARGE_CONTENT_SIZE / 2),
        }),
      )
    }
  }

  return messages
}

/**
 * Detects whether context pruning occurred by checking for:
 * 1. <conversation_summary> tag (context-pruner's output)
 * 2. A compacted-context pointer (trimMessagesToFitTokenLimit fallback)
 * 3. Significant message count reduction (>50% fewer messages than original)
 */
function detectPruning(
  finalMessages: Message[],
  originalMessageCount: number,
): {
  wasPruned: boolean
  hasSummary: boolean
  hasTrimFallback: boolean
  messageReduction: number
} {
  const hasSummary = finalMessages.some((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return false
    return msg.content.some(
      (part) => isTextPart(part) && part.text.includes('<conversation_summary>'),
    )
  })

  const hasTrimFallback = finalMessages.some((msg) => {
    if (!Array.isArray(msg.content)) return false
    return msg.content.some(
      (part) =>
        isTextPart(part) && part.text.includes('Previous context compacted'),
    )
  })

  // Message reduction: if fewer than 50% of original messages remain
  const messageReduction =
    originalMessageCount > 0
      ? 1 - finalMessages.length / originalMessageCount
      : 0

  const wasPruned = hasSummary || hasTrimFallback || messageReduction > 0.5

  return { wasPruned, hasSummary, hasTrimFallback, messageReduction }
}



function collectText(messages: Message[]): string {
  return messages
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter(
              (part): part is { type: 'text'; text: string } =>
                part.type === 'text' && typeof part.text === 'string',
            )
            .map((part) => part.text)
        : [],
    )
    .join('\n')
}

// Load-bearing pruning cases run unconditionally in default CI via deterministic e2e mocks.
// RUN_CONTEXT_PRUNING_E2E was previously considered for isolated gating but is no longer
// used; all pruning threshold cases run without env gating to ensure coverage.

describe('Context Pruning Threshold E2E', () => {
  beforeAll(() => {
    setupE2eMocks()
  })
  it(
    'should NOT prune when token count is well below the limit',
    async () => {
      // Build message history targeting ~30k tokens of message content
      // With maxContextLength=100k, this should be well below the pruning threshold
      const messages = buildMessageHistory(30_000)

      const client = new OpenbuffClient({
        agentDefinitions: [
          testAgent,
          prunerAgent,
        ],
      })

      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: { sessionState, output: { type: 'error', message: '' } },
        messages,
      })

      // Run the agent with maxContextLength=100k - context-pruner should NOT prune
      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "OK" and nothing else.',
        previousRun: runStateWithMessages,
        params: { maxContextLength: 100_000 },
        handleEvent: () => {},
      })

      // Should complete without error
      if (run.output.type === 'error') {
        console.error(
          'Below-limit test error:',
          JSON.stringify(run.output, null, 2),
        )
      }
      expect(run.output.type).not.toEqual('error')

      // Check the final message history
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const tokenCount = run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const pruningResult = detectPruning(finalMessages, messages.length)

      // (quiet: removed console.log noise for CI diagnostics)

      // Key assertion: pruning should NOT have happened
      expect(pruningResult.wasPruned).toBe(false)

      // Token count should be below the limit
      expect(tokenCount).toBeLessThan(100_000)

      // CRITICAL: The token count should NOT have a 30% buffer applied
      // If the old bug were present, the actual count (~50k) would be reported as ~65k
      // With accurate counting for Anthropic models, no buffer is applied
      expect(tokenCount).toBeGreaterThan(10_000) // At least some tokens accumulated
      expect(tokenCount).toBeLessThan(80_000) // Well below limit even with natural variance
    },
    { timeout: 120_000 },
  )

  it(
    'should prune when token count exceeds the limit',
    async () => {
      // Build message history targeting ~80k tokens of message content
      // With maxContextLength=50k, this should exceed the pruning threshold
      const messages = buildMessageHistory(80_000)
      const requiredPath = 'packages/agent-runtime/src/run-agent-step.ts'
      const requiredConstraint =
        'CONSTRAINT_CONTEXT_RECALL: preserve semantic compaction before mechanical trimming.'
      // Synthetic history prepended out-of-order to seed recall-invariant — not meant to model natural turn order.
      // Order-insensitivity: the pruner must preserve causality (user constraint → file-picker discovery → structured result)
      // regardless of synthetic prepend position. The invariant below validates that compaction preserves
      // file-picker discovery provenance and that the user constraint remains causally prior to its discovery (RF-5).
      messages.unshift(
        createMessage(
          'user',
          `Implement the context lifecycle fix. ${requiredConstraint}`,
        ),
        createToolCallMessage('discovery-file-picker', 'spawn_agents', {
          agents: [
            {
              agent_type: 'file-picker',
              prompt: 'Find the runtime context lifecycle entry point.',
            },
          ],
        }),
        createToolResultMessage('discovery-file-picker', 'spawn_agents', [
          {
            agentType: 'file-picker',
            value: {
              type: 'structuredOutput',
              value: {
                files: [
                  {
                    path: requiredPath,
                    summary:
                      'Owns step ordering and context compaction event emission.',
                  },
                ],
              },
            },
          },
        ]),
      )

      const client = new OpenbuffClient({
        agentDefinitions: [
          testAgent,
          prunerAgent,
        ],
      })

      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: { sessionState, output: { type: 'error', message: '' } },
        messages,
      })

      // Run the agent with maxContextLength=50k - context-pruner SHOULD prune
      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "DONE" and nothing else.',
        previousRun: runStateWithMessages,
        params: { maxContextLength: 50_000 },
        handleEvent: () => {},
      })

      // Should complete without error
      if (run.output.type === 'error') {
        console.error(
          'Above-limit test error:',
          JSON.stringify(run.output, null, 2),
        )
      }
      expect(run.output.type).not.toEqual('error')

      // Check the final message history
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const tokenCount = run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const pruningResult = detectPruning(finalMessages, messages.length)

      // (quiet: removed console.log noise for CI diagnostics)

      // Key assertion: pruning SHOULD have happened
      // We accept any form of pruning: conversation_summary, trimMessages fallback, or significant reduction
      expect(pruningResult.wasPruned).toBe(true)

      // After pruning, the message count should be significantly reduced
      expect(finalMessages.length).toBeLessThan(messages.length)

      // Verify tool-call/tool-result pair integrity after pruning
      verifyToolCallPairIntegrity(finalMessages)

      // Factual recall is the invariant, not merely observing that pruning ran.
      // Exact discovery output, the controlling user constraint, and discovery
      // provenance must all survive in the compacted/resumed conversation.
      const retainedText = collectText(finalMessages)
      expect(retainedText).toContain(requiredPath)
      expect(retainedText).toContain(requiredConstraint)
      expect(retainedText).toContain('(discovered by file-picker)')
      // Invariant: pruner preserves causality — constraint must remain causally prior to its discovery provenance.
      expect(retainedText.indexOf(requiredConstraint)).toBeLessThan(retainedText.indexOf(requiredPath))

      // After pruning, the token count should be below the limit
      expect(tokenCount).toBeLessThan(50_000)
    },
    { timeout: 180_000 },
  )

  it(
    'should verify token counting accuracy: no premature 30% buffer for Anthropic models',
    async () => {
      // This test verifies that the token counting API returns accurate counts
      // for Anthropic models without a 30% buffer or local fallback overcounting.
      //
      // Strategy: Run TWO agent calls with the same message history:
      //   1. Calibration run with 200k limit (no pruning) → measure TRUE token count
      //   2. Test run with 100k limit → check if pruning triggers
      //
      // If true tokens < 100k but pruning triggered in the 100k run, that proves
      // the token counting API is over-reporting (30% buffer or fallback bug).
      //
      // We target ~95k estimated tokens of content, which should produce ~95-100k
      // actual tokens — close to the 100k limit but safely under with accurate counting.
      //
      // Accurate counting:  ~90k < 100k → no pruning in either run ✓
      // 30% buffer:         ~90k reported as ~117k → premature pruning in 100k run ✗
      // Local fallback:     ~90k reported as ~135k+ → premature pruning in 100k run ✗

      // Tightened to ~70k to keep true tokens deterministically <100k even with 1.3x variance.
      // Previously 95k *1.3 = 123k could exceed the 100k limit due to token variance, causing
      // the no-premature-prune assertion to be conditionally skipped and hiding the 30% buffer bug.
      const TARGET_ESTIMATED_TOKENS = 70_000
      const messages = buildMessageHistory(TARGET_ESTIMATED_TOKENS)

      const client = new OpenbuffClient({
        agentDefinitions: [
          testAgent,
          prunerAgent,
        ],
      })

      // =========================================================================
      // Step 1: CALIBRATION RUN — measure true token count with 200k limit (no pruning)
      // =========================================================================
      const sessionStateCal = await initialSessionState({})
      const runStateCal = withMessageHistory({
        runState: {
          sessionState: sessionStateCal,
          output: { type: 'error', message: '' },
        },
        messages,
      })

      const calRun = await client.run({
        agent: testAgent.id,
        prompt: 'Say "CAL" and nothing else.',
        previousRun: runStateCal,
        params: { maxContextLength: 200_000 },
        handleEvent: () => {},
      })

      const trueTokenCount =
        calRun.sessionState?.mainAgentState.contextTokenCount ?? 0
      const calMessages =
        calRun.sessionState?.mainAgentState.messageHistory ?? []
      const calPruning = detectPruning(calMessages, messages.length)

      // (quiet: removed console.log noise for CI diagnostics)

      // Calibration should not have pruned (200k limit is very high)
      expect(calPruning.wasPruned).toBe(false)
      expect(trueTokenCount).toBeGreaterThan(50_000)

      // =========================================================================
      // Step 2: TEST RUN — same content with 100k limit
      // =========================================================================
      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: { sessionState, output: { type: 'error', message: '' } },
        messages,
      })

      const MAX_CONTEXT_LENGTH = 100_000

      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "ACK" and nothing else.',
        previousRun: runStateWithMessages,
        params: { maxContextLength: MAX_CONTEXT_LENGTH },
        handleEvent: () => {},
      })

      if (run.output.type === 'error') {
        console.error(
          'Accuracy test error:',
          JSON.stringify(run.output, null, 2),
        )
      }
      expect(run.output.type).not.toEqual('error')

      const reportedTokenCount =
        run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const pruningResult = detectPruning(finalMessages, messages.length)

      // Ratio of true token count to estimated content tokens.
      // Estimate is for message content only; actual includes system prompt + tool definitions.
      // So ratio 1.0-1.3 is expected. A 30% buffer on the full count pushes ratio above 1.3.
      const ratio = trueTokenCount / TARGET_ESTIMATED_TOKENS
      // Deterministic ratio bounds — fail fast if token counting is over-reporting (30% buffer or fallback)
      expect(ratio).toBeGreaterThan(0.8)
      expect(ratio).toBeLessThan(1.3)

      // Deterministic no-premature-prune assertion: with TARGET 70k, true tokens must be <100k
      // when counting is accurate (70k*1.3=91k <100k). If true tokens exceed the limit, the
      // test is mis-targeted and should fail rather than silently skip the critical assertion.
      expect(trueTokenCount).toBeLessThan(MAX_CONTEXT_LENGTH)
      expect(pruningResult.wasPruned).toBe(false)
      // Also ensure reported count stays in expected band
      expect(reportedTokenCount).toBeLessThan(MAX_CONTEXT_LENGTH)
    },
    { timeout: 300_000 },
  )
})
