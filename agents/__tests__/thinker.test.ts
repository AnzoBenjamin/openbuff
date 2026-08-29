import { describe, test, expect } from 'bun:test'

import { createBase2 } from '../base2/base2'
import thinker from '../thinker/thinker'

import type { AgentState } from '../types/agent-definition'
import type { Message } from '../types/util-types'

describe('thinker agent', () => {
  const createMockAgentState = (
    messageHistory: Message[] = [],
  ): AgentState => ({
    agentId: 'thinker-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  describe('definition', () => {
    test('has correct id', () => {
      expect(thinker.id).toBe('thinker')
    })

    test('has display name', () => {
      expect(thinker.displayName).toBe('Theo the Theorizer')
    })

    test('does not pin a specific model', () => {
      expect(thinker.model).toBeUndefined()
    })

    test('has output mode set to structured_output', () => {
      expect(thinker.outputMode).toBe('structured_output')
    })

    test('uses an isolated decision packet', () => {
      expect(thinker.includeMessageHistory).toBe(false)
      expect(thinker.spawnerPrompt).toContain('self-contained')
      expect(thinker.spawnerPrompt).toContain(
        'does not inherit conversation history',
      )
    })

    test('does not inherit parent orchestration prompt', () => {
      expect(thinker.inheritParentSystemPrompt).toBe(false)
    })

    test('exposes read_files to the model and set_output programmatically', () => {
      expect(thinker.toolNames).toEqual(['read_files'])
      expect(thinker.programmaticToolNames).toEqual(['set_output'])
    })

    test('has empty spawnable agents', () => {
      expect(thinker.spawnableAgents).toHaveLength(0)
    })
  })

  describe('input schema', () => {
    test('has prompt parameter', () => {
      expect(thinker.inputSchema?.prompt?.type).toBe('string')
    })

    test('prompt has description', () => {
      expect(thinker.inputSchema?.prompt?.description).toContain('decision')
    })

    // M2.3: optional depth + outputSchemaHint hints.
    test('has optional params with depth and outputSchemaHint', () => {
      const paramsSchema = thinker.inputSchema?.params
      expect(
        paramsSchema &&
          typeof paramsSchema === 'object' &&
          'type' in paramsSchema &&
          paramsSchema.type,
      ).toBe('object')
      const props = (paramsSchema as { properties?: Record<string, unknown> })
        ?.properties
      expect(props).toBeTruthy()
      const depth = props?.depth as
        | { type?: string; enum?: string[] }
        | undefined
      expect(depth?.type).toBe('string')
      expect(depth?.enum).toEqual(['shallow', 'deep'])
      const hint = props?.outputSchemaHint as { type?: string } | undefined
      expect(hint?.type).toBe('string')
      expect((paramsSchema as { required?: unknown[] })?.required).toHaveLength(
        0,
      )
    })

    test('instructions prompt surfaces depth and outputSchemaHint guidance', () => {
      expect(thinker.instructionsPrompt).toContain('params.depth')
      expect(thinker.instructionsPrompt).toContain('params.outputSchemaHint')
      expect(thinker.instructionsPrompt).toContain('shallow')
      expect(thinker.instructionsPrompt).toContain('deep')
    })
  })

  describe('base2 thinker spawn guidance', () => {
    test('does not tell spawners they can omit context for thinker', () => {
      const base2 = createBase2('default')

      expect(base2.systemPrompt).not.toContain('No need to include context')
      expect(base2.systemPrompt).not.toContain(
        'you can be brief in prompting them without needing to include context',
      )
      expect(base2.systemPrompt).toContain('includeMessageHistory:false')
      expect(base2.systemPrompt).toContain('self-contained')
      expect(base2.systemPrompt).toContain('params.depth')
      expect(base2.systemPrompt).toContain('params.outputSchemaHint')
      expect(base2.instructionsPrompt).toContain('includeMessageHistory:false')
      expect(base2.instructionsPrompt).toContain(
        'self-contained decision packet',
      )
      expect(base2.instructionsPrompt).toContain('params.depth')
      expect(base2.instructionsPrompt).toContain('params.outputSchemaHint')
    })
  })

  describe('output schema', () => {
    test('has object type', () => {
      expect(thinker.outputSchema?.type).toBe('object')
    })

    test('has message property', () => {
      const messageSchema = thinker.outputSchema?.properties?.message
      expect(
        messageSchema &&
          typeof messageSchema === 'object' &&
          'type' in messageSchema &&
          messageSchema.type,
      ).toBe('string')
    })

    test('message has description', () => {
      const messageSchema = thinker.outputSchema?.properties?.message
      expect(
        messageSchema &&
          typeof messageSchema === 'object' &&
          'description' in messageSchema &&
          messageSchema.description,
      ).toContain('response')
    })
  })

  describe('instructions prompt', () => {
    test('does not ask for XML think tags or mention set_output', () => {
      expect(thinker.instructionsPrompt).not.toContain('<think>')
      expect(thinker.instructionsPrompt).not.toContain('set_output')
    })

    test('instructs native reasoning or silent reasoning then ordinary assistant text', () => {
      expect(thinker.instructionsPrompt).toContain('native reasoning')
      expect(thinker.instructionsPrompt).toContain('reason silently')
      expect(thinker.instructionsPrompt).toContain('ordinary assistant text')
    })

    test('prefers plain assistant text for the final answer', () => {
      expect(thinker.instructionsPrompt).toContain(
        'prefer plain assistant text',
      )
      expect(thinker.instructionsPrompt).toContain('ordinary response text')
      expect(thinker.instructionsPrompt).toContain(
        'harvested automatically from that plain text',
      )
      expect(thinker.instructionsPrompt).toContain(
        'not only inside a tool call',
      )
    })
  })

  describe('handleSteps', () => {
    test('yields STEP to get agent state', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      const result = generator.next()

      expect(result.value).toBe('STEP')
    })

    test('extracts text from last assistant message', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me think about this' }],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      // First yield is STEP
      generator.next()

      // Provide updated agent state
      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: { message: 'Let me think about this' },
        includeToolCall: false,
      })
    })

    test('removes think tags from output', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<think>This is my thinking process</think>Final answer here',
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      // First yield is STEP
      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        toolName: string
        input: { message: string }
      }
      expect(toolCall.input.message).toBe('Final answer here')
      expect(toolCall.input.message).not.toContain('<think>')
      expect(toolCall.input.message).not.toContain('</think>')
    })

    test('handles multiline think tags', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `<think>
Line 1 of thinking
Line 2 of thinking
</think>
Actual response here`,
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Actual response here')
    })

    test('strips unclosed think tails so they are not harvested as the answer', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<think>closed first</think>Final answer here\n<think>unclosed tail that must not be harvested',
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Final answer here')
      expect(toolCall.input.message).not.toContain('<think>')
      expect(toolCall.input.message).not.toContain('unclosed tail')
    })

    test('returns error message when no assistant message found', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        toolName: string
        input: { message: string }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.message).toContain('Error')
      expect(toolCall.input.message).toContain('No assistant message found')
    })

    test('handles array content in message', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'text', text: 'Part 2.' },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Part 1. Part 2.')
    })

    test('filters out non-text content parts', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Text part' },
            { type: 'tool-call', toolCallId: '1', toolName: 'test', input: {} },
            { type: 'text', text: 'More text' },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Text partMore text')
      expect(toolCall.input.message).not.toContain('tool-call')
    })

    test('finds last assistant message in mixed history', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'First question' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'First answer' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Second question' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final answer' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Tool result' }],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Final answer')
    })

    test('handleSteps can be serialized for sandbox execution', () => {
      const handleStepsString = thinker.handleSteps!.toString()

      // Verify it's a valid generator function string
      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      // Should be able to create a new function from it
      const isolatedFunction = new Function(`return (${handleStepsString})`)()
      expect(typeof isolatedFunction).toBe('function')
    })

    test('trims whitespace from extracted text', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '  \n  Response with whitespace  \n  ',
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Response with whitespace')
    })

    test('handles string content directly', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: 'Simple string response' as unknown as [
            { type: 'text'; text: string },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as { input: { message: string } }
      expect(toolCall.input.message).toBe('Simple string response')
    })

    // Regression: empty harvest after <think> strip must not clobber a
    // successful prior set_output (buffbench spawn LsHOhL5cwBo).
    test('does not clobber existing non-empty output with empty harvest', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<think>only thinking, no final answer</think>',
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      updatedState.output = { message: 'Prior successful answer' }
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      // Must not yield set_output at all — leave existing output intact.
      expect(result.done).toBe(true)
      expect(result.value).toBeUndefined()
    })

    test('preserves existing output when no assistant message is present', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      updatedState.output = { message: 'Already set via set_output' }
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.done).toBe(true)
      expect(result.value).toBeUndefined()
    })

    // Regression: a bare read_files tool-call step must not finish the
    // thinker. handleSteps should re-yield STEP and wait for a final answer.
    test('re-yields STEP when last assistant message is only a read_files tool call', () => {
      const toolCallOnlyMessages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'read_files',
              input: { paths: ['src/index.ts'] },
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(toolCallOnlyMessages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(toolCallOnlyMessages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: false,
      })

      // Must request another LLM step rather than harvesting/finishing.
      expect(result.done).toBe(false)
      expect(result.value).toBe('STEP')
    })

    test('harvests final text on the step after a read_files tool call', () => {
      const toolCallOnlyMessages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'read_files',
              input: { paths: ['src/index.ts'] },
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(toolCallOnlyMessages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      // First step ends on a bare read_files tool call -> re-yield STEP.
      const stepResult = generator.next({
        agentState: createMockAgentState(toolCallOnlyMessages),
        toolResult: undefined,
        stepsComplete: false,
      })
      expect(stepResult.value).toBe('STEP')

      // Next step now has final plain text and no tool call -> harvest.
      const finalMessages: Message[] = [
        ...toolCallOnlyMessages,
        {
          role: 'user',
          content: [{ type: 'text', text: 'read_files result here' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final answer from thinker' }],
        },
      ]
      const result = generator.next({
        agentState: createMockAgentState(finalMessages),
        toolResult: undefined,
        stepsComplete: false,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: { message: 'Final answer from thinker' },
        includeToolCall: false,
      })
    })

    test('breaks out on stepsComplete/hitStepCap instead of looping on a tool-call-only message', () => {
      const toolCallOnlyMessages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'read_files',
              input: { paths: ['src/index.ts'] },
            },
          ],
        },
      ]

      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      // Case 1: stepsComplete === true -> fall through to harvest/fallback.
      const genComplete = thinker.handleSteps!({
        agentState: createMockAgentState(toolCallOnlyMessages),
        logger: mockLogger as any,
        params: {},
      })
      genComplete.next()
      const completeResult = genComplete.next({
        agentState: createMockAgentState(toolCallOnlyMessages),
        toolResult: undefined,
        stepsComplete: true,
      })
      // Empty harvest path: yields set_output with empty message, not STEP.
      expect(completeResult.value).toEqual({
        toolName: 'set_output',
        input: { message: '' },
        includeToolCall: false,
      })

      // Case 2: hitStepCap === true -> fall through to harvest/fallback.
      const genCap = thinker.handleSteps!({
        agentState: createMockAgentState(toolCallOnlyMessages),
        logger: mockLogger as any,
        params: {},
      })
      genCap.next()
      const capResult = genCap.next({
        agentState: createMockAgentState(toolCallOnlyMessages),
        toolResult: undefined,
        stepsComplete: false,
        hitStepCap: true,
      } as Parameters<typeof genCap.next>[0] & { hitStepCap?: boolean })
      expect(capResult.value).toEqual({
        toolName: 'set_output',
        input: { message: '' },
        includeToolCall: false,
      })
    })

    test('recovers message from set_output tool-call when assistant text is empty', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<think>thinking only</think>',
            },
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'set_output',
              input: { message: 'Answer from tool call' },
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: { message: 'Answer from tool call' },
        includeToolCall: false,
      })
    })

    test('recovers message from set_output input.data.message when text is empty', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'set_output',
              input: { data: { message: 'Nested data message' } },
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: { message: 'Nested data message' },
        includeToolCall: false,
      })
    })

    test('prefers cleaned assistant text over set_output tool-call message', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Text answer wins' },
            {
              type: 'tool-call',
              toolCallId: '1',
              toolName: 'set_output',
              input: { message: 'Tool call answer' },
            },
          ],
        },
      ]

      const mockAgentState = createMockAgentState(messages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = thinker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState(messages)
      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: { message: 'Text answer wins' },
        includeToolCall: false,
      })
    })
  })
})
