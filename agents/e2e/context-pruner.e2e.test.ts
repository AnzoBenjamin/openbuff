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
} from './helpers/pruning-test-helpers'
import { setupE2eMocks } from '../../sdk/e2e/utils/e2e-mocks'

import contextPruner from '../context-pruner'

// Typed wrapper preserves schema-drift detection via `satisfies` — avoids `as unknown` erasure (RF-3).
const prunerAgent = contextPruner satisfies AgentDefinition


/**
 * Integration tests for the context-pruner agent.
 * These tests verify that context-pruner correctly prunes message history
 * while maintaining tool-call/tool-result pair integrity for Anthropic API compliance.
 */
describe('Context Pruner Agent Integration', () => {
  beforeAll(() => {
    setupE2eMocks()
  })
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

  it(
    'should prune large message history and maintain tool-call/tool-result pairs',
    async () => {
      // Create a test agent that spawns context-pruner and reports completion
      // without making a provider call. The mutation performed by the spawned
      // agent is the behavior under test here.
      const testAgent: AgentDefinition = {
        id: 'context-pruner-test-agent',
        displayName: 'Context Pruner Test Agent',
        model: 'anthropic/claude-haiku-4.5',
        includeMessageHistory: true,
        toolNames: ['spawn_agents'],
        spawnableAgents: ['context-pruner'],
        handleSteps: function* () {
          // Spawn context-pruner with a lower token limit to force pruning
          yield {
            toolName: 'spawn_agents',
            input: {
              agents: [
                {
                  agent_type: 'context-pruner',
                  params: {
                    maxContextLength: 50000, // Low limit to force pruning
                  },
                },
              ],
            },
          }
          yield { type: 'STEP_TEXT', text: 'PRUNING_COMPLETE' }
        },
      }

      // Create a large message history that exceeds the token limit
      // Include proper tool-call/tool-result pairs
      const largeContent = makeLargeContent('', 20000)
      const initialMessages: Message[] = [
        createMessage('user', `First message: ${largeContent}`),
        createMessage('assistant', `Response 1: ${largeContent}`),
        createMessage('user', `Second message: ${largeContent}`),
        // Tool call pair 1
        createToolCallMessage('call-1', 'read_files', { paths: ['test.ts'] }),
        createToolResultMessage('call-1', 'read_files', {
          content: 'file content',
        }),
        createMessage('user', `Third message: ${largeContent}`),
        createMessage('assistant', `Response 2: ${largeContent}`),
        // Tool call pair 2
        createToolCallMessage('call-2', 'code_search', { pattern: 'test' }),
        createToolResultMessage('call-2', 'code_search', { results: [] }),
        createMessage('user', `Fourth message: ${largeContent}`),
        createMessage('assistant', `Response 3: ${largeContent}`),
        createMessage('user', 'Now spawn the context-pruner'),
      ]

      const client = new OpenbuffClient({
        agentDefinitions: [testAgent, prunerAgent],
      })

      // Create initial session state with the large message history
      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: { sessionState, output: { type: 'error', message: '' } },
        messages: initialMessages,
      })

      // Run the test agent
      const run = await client.run({
        agent: 'context-pruner-test-agent',
        prompt: '', // Empty prompt since we pre-populated messages
        previousRun: runStateWithMessages,
        handleEvent: () => {},
      })

      // Verify no error
      if (run.output.type === 'error') {
        console.error('Test 1 Error:', JSON.stringify(run.output, null, 2))
      }
      expect(run.output.type).not.toEqual('error')

      // Get the final message history from session state
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []

      // Verify tool-call/tool-result pairs are intact
      // Extract all tool call IDs from assistant messages
      const toolCallIds = new Set<string>()
      for (const msg of finalMessages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (isToolCallPart(part)) {
              toolCallIds.add(part.toolCallId)
            }
          }
        }
      }

      // Extract all tool result IDs
      const toolResultIds = new Set<string>()
      for (const msg of finalMessages) {
        if (isToolMessageWithId(msg)) {
          toolResultIds.add(msg.toolCallId)
        }
      }

      // Every tool result should have a matching tool call
      for (const resultId of toolResultIds) {
        expect(toolCallIds.has(resultId)).toBe(true)
      }

      // Every tool call should have a matching tool result
      for (const callId of toolCallIds) {
        expect(toolResultIds.has(callId)).toBe(true)
      }

      // Verify pruning actually occurred — would pass if pruner no-oped otherwise
      const hasSummary = finalMessages.some((msg) => {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) return false
        return msg.content.some(
          (part) =>
            isTextPart(part) &&
            (part.text.includes('<conversation_summary>') ||
              part.text.includes('Previous context compacted')),
        )
      })
      const wasPruned = hasSummary || finalMessages.length < initialMessages.length
      expect(wasPruned).toBe(true)
      expect(finalMessages.length).toBeLessThan(initialMessages.length)
    },
    { timeout: 120_000 },
  )

  it(
    'should prune context with small token limit and preserve tool pairs',
    async () => {
      // Create a test agent that spawns context-pruner with very aggressive pruning
      const testAgent: AgentDefinition = {
        id: 'aggressive-prune-test-agent',
        displayName: 'Aggressive Prune Test Agent',
        model: 'anthropic/claude-haiku-4.5',
        includeMessageHistory: true,
        toolNames: ['spawn_agents'],
        spawnableAgents: ['context-pruner'],
        handleSteps: function* () {
          yield {
            toolName: 'spawn_agents',
            input: {
              agents: [
                {
                  agent_type: 'context-pruner',
                  params: {
                    maxContextLength: 10000, // Very low limit to force aggressive pruning
                  },
                },
              ],
            },
          }
          yield { type: 'STEP_TEXT', text: 'DONE' }
        },
      }

      // Create message history with multiple tool-call/tool-result pairs
      // These should be preserved as pairs even when pruning aggressively
      const largeContent = makeLargeContent('', 5000)
      const initialMessages: Message[] = [
        createMessage('user', `Start: ${largeContent}`),
        createMessage('assistant', `Response: ${largeContent}`),
        // Tool call pair 1
        createToolCallMessage('pair-1', 'read_files', { paths: ['a.ts'] }),
        createToolResultMessage('pair-1', 'read_files', {
          content: largeContent,
        }),
        createMessage('user', `More: ${largeContent}`),
        // Tool call pair 2
        createToolCallMessage('pair-2', 'code_search', { pattern: 'foo' }),
        createToolResultMessage('pair-2', 'code_search', {
          results: [largeContent],
        }),
        createMessage('user', 'Now prune the context'),
      ]

      const client = new OpenbuffClient({
        agentDefinitions: [testAgent, prunerAgent],
      })

      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: { sessionState, output: { type: 'error', message: '' } },
        messages: initialMessages,
      })

      const run = await client.run({
        agent: 'aggressive-prune-test-agent',
        prompt: '',
        previousRun: runStateWithMessages,
        handleEvent: () => {},
      })

      // Should complete without error
      if (run.output.type === 'error') {
        console.error('Test 2 Error:', JSON.stringify(run.output, null, 2))
      }
      expect(run.output.type).not.toEqual('error')

      // Get final messages and verify tool pairs are intact
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []

      // Extract tool call IDs and tool result IDs
      const toolCallIds = new Set<string>()
      const toolResultIds = new Set<string>()

      for (const msg of finalMessages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (isToolCallPart(part)) {
              toolCallIds.add(part.toolCallId)
            }
          }
        }
        if (isToolMessageWithId(msg)) {
          toolResultIds.add(msg.toolCallId)
        }
      }

      // Every tool result must have a matching tool call
      for (const resultId of toolResultIds) {
        expect(toolCallIds.has(resultId)).toBe(true)
      }

      // Every tool call must have a matching tool result
      for (const callId of toolCallIds) {
        expect(toolResultIds.has(callId)).toBe(true)
      }

      // Verify pruning actually occurred — would pass if pruner no-oped otherwise
      const hasSummary = finalMessages.some((msg) => {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) return false
        return msg.content.some(
          (part) =>
            isTextPart(part) &&
            (part.text.includes('<conversation_summary>') ||
              part.text.includes('Previous context compacted')),
        )
      })
      const wasPruned = hasSummary || finalMessages.length < initialMessages.length
      expect(wasPruned).toBe(true)
      expect(finalMessages.length).toBeLessThan(initialMessages.length)
    },
    { timeout: 60_000 },
  )
})
