import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { userMessage } from '@codebuff/common/util/messages'
import { COMPACTED_CONTEXT_POINTER } from '@codebuff/agent-runtime/util/messages'
import { countTokensJson } from '@codebuff/agent-runtime/util/token-counter'
import { describe, expect, spyOn, test } from 'bun:test'

import z from 'zod/v4'

import {
  countRequestOverheadTokens,
  getMessagesForModelContext,
  getProviderContextLimitFromError,
} from '../llm'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('getMessagesForModelContext', () => {
  test('uses the default trim limit when context window is unknown', () => {
    const messages: Message[] = [userMessage('short context')]

    const result = getMessagesForModelContext({
      messages,
      logger,
    })

    expect(result).toBe(messages)
  })

  test('trims messages using the resolved model context window', () => {
    const messages: Message[] = [
      userMessage('old context '.repeat(10_000)),
      userMessage('middle context '.repeat(10_000)),
      userMessage('recent context '.repeat(10_000)),
    ]

    const largeContextResult = getMessagesForModelContext({
      messages,
      contextWindowTokens: 200_000,
      logger,
    })
    const smallContextResult = getMessagesForModelContext({
      messages,
      contextWindowTokens: 2_000,
      logger,
    })

    const smallContextJson = JSON.stringify(smallContextResult)

    expect(largeContextResult).toHaveLength(messages.length)
    expect(largeContextResult).toBe(messages)
    expect(smallContextResult).not.toEqual(messages)
    expect(smallContextJson).toContain(COMPACTED_CONTEXT_POINTER)
    expect(smallContextJson).not.toContain('old context old context')
  })

  test('reserves part of the model context window for non-message request overhead', () => {
    const messages: Message[] = [userMessage('reserve-sensitive '.repeat(600))]
    const rawMessageTokens = countTokensJson(messages)

    const result = getMessagesForModelContext({
      messages,
      contextWindowTokens: rawMessageTokens + 512,
      logger,
    })

    expect(result).not.toEqual(messages)
    expect(JSON.stringify(result)).toContain(COMPACTED_CONTEXT_POINTER)
  })

  test('emits cache_emergency_trim telemetry when request-time trim drops messages (M4.3)', () => {
    const messages: Message[] = [
      userMessage('old context '.repeat(10_000)),
      userMessage('middle context '.repeat(10_000)),
      userMessage('recent context '.repeat(10_000)),
    ]

    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {})

    try {
      // Large context window -> no trim, no telemetry
      getMessagesForModelContext({
        messages,
        contextWindowTokens: 1_000_000,
        logger,
      })
      expect(warnSpy).not.toHaveBeenCalled()

      // Tiny context window -> trim fires, telemetry emitted
      const result = getMessagesForModelContext({
        messages,
        contextWindowTokens: 2_000,
        logger,
      })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const call = warnSpy.mock.calls[0]
      const payload = call[0] as Record<string, unknown>
      expect(payload.eventId).toBe(AnalyticsEvent.CACHE_EMERGENCY_TRIM)
      expect(payload.contextWindowTokens).toBe(2_000)
      expect(payload.triggerBudgetTokens).toBe(1_000)
      expect(payload.targetBudgetTokens).toBe(1_000)
      expect(payload.reason).toContain('provider-safe request budget')
      expect(payload.inputMessageCount).toBe(messages.length)
      expect(payload.outputMessageCount).toBe(result.length)
      expect(payload.tokensDropped).toBeGreaterThan(0)
      const message = call[1] as string
      expect(message).toContain('cache_emergency_trim')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not emit cache_emergency_trim telemetry when no trim occurs (M4.3)', () => {
    const messages: Message[] = [userMessage('short context')]
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {})

    try {
      getMessagesForModelContext({
        messages,
        contextWindowTokens: 200_000,
        logger,
      })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('reports the applied message-only threshold in trigger/target trim telemetry', () => {
    // `triggerBudgetTokens`/`targetBudgetTokens` are the pair consumers compare
    // against message token counts, so once a system/tool surface is reserved
    // they must report the message-only budget actually applied, not the
    // pre-subtraction request budget still carried by `maxTotalTokens`.
    const messages: Message[] = [
      userMessage('old context '.repeat(10_000)),
      userMessage('middle context '.repeat(10_000)),
      userMessage('recent context '.repeat(10_000)),
    ]
    const trackedEvents: {
      event: string
      properties?: Record<string, unknown>
    }[] = []
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {})

    try {
      getMessagesForModelContext({
        messages,
        contextWindowTokens: 2_000,
        systemTokens: 400,
        logger,
        trackEvent: ({ event, properties }) =>
          trackedEvents.push({ event, properties }),
      })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const call = warnSpy.mock.calls[0]
      const payload = call[0] as Record<string, unknown>
      // Resolved request budget keeps its previous meaning.
      expect(payload.maxTotalTokens).toBe(1_000)
      expect(payload.systemTokens).toBe(400)
      expect(payload.effectiveMessageBudgetTokens).toBe(600)
      expect(payload.triggerBudgetTokens).toBe(600)
      expect(payload.targetBudgetTokens).toBe(600)
      expect(call[1] as string).toContain('trigger=600, target=600')

      // The analytics payload carries the same unambiguous pair.
      expect(trackedEvents).toHaveLength(1)
      expect(trackedEvents[0]).toMatchObject({
        event: AnalyticsEvent.CACHE_EMERGENCY_TRIM,
        properties: {
          maxTotalTokens: 1_000,
          systemTokens: 400,
          effectiveMessageBudgetTokens: 600,
          triggerBudgetTokens: 600,
          targetBudgetTokens: 600,
        },
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('keeps trigger/target equal to the request budget when no overhead is reserved', () => {
    // Callers that reserve no system/tool surface see the previous values, so
    // the field pair is a pure clarification for them rather than a break.
    const messages: Message[] = [
      userMessage('old context '.repeat(10_000)),
      userMessage('recent context '.repeat(10_000)),
    ]
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {})

    try {
      getMessagesForModelContext({
        messages,
        contextWindowTokens: 2_000,
        systemTokens: 0,
        logger,
      })

      const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>
      expect(payload.maxTotalTokens).toBe(1_000)
      expect(payload.triggerBudgetTokens).toBe(1_000)
      expect(payload.targetBudgetTokens).toBe(1_000)
      expect(payload.effectiveMessageBudgetTokens).toBe(1_000)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('honors an adaptive provider message-limit override', () => {
    const messages: Message[] = [
      userMessage('oversized context '.repeat(8_000)),
    ]
    const result = getMessagesForModelContext({
      messages,
      contextWindowTokens: 1_000_000,
      maxTotalTokensOverride: 2_000,
      logger,
    })

    expect(result).not.toEqual(messages)
    expect(JSON.stringify(result)).toContain(COMPACTED_CONTEXT_POINTER)
  })

  test('subtracts systemTokens so the brake matches the runtime message budget', () => {
    const messages: Message[] = Array.from({ length: 24 }, (_, index) =>
      userMessage(`chunk ${index} context `.repeat(400)),
    )
    const messageTokens = countTokensJson(messages)
    // Window large enough that the whole history fits when the system surface
    // is ignored, but not once a real system+tools cost is subtracted.
    const contextWindowTokens = messageTokens * 2

    const withoutSystemTokens = getMessagesForModelContext({
      messages,
      contextWindowTokens,
      systemTokens: 0,
      logger,
    })
    const withSystemTokens = getMessagesForModelContext({
      messages,
      contextWindowTokens,
      systemTokens: messageTokens,
      logger,
    })

    expect(withoutSystemTokens).toBe(messages)
    expect(withSystemTokens).not.toBe(messages)
    expect(countTokensJson(withSystemTokens)).toBeLessThan(
      countTokensJson(withoutSystemTokens),
    )

    // A system surface larger than the entire window still leaves a positive
    // message budget instead of a zero/negative one.
    const clamped = getMessagesForModelContext({
      messages,
      contextWindowTokens,
      systemTokens: Number.MAX_SAFE_INTEGER,
      logger,
    })
    expect(clamped.length).toBeGreaterThan(0)
  })

  test('omitting systemTokens is identical to passing 0', () => {
    const messages: Message[] = [
      userMessage('old context '.repeat(10_000)),
      userMessage('middle context '.repeat(10_000)),
      userMessage('recent context '.repeat(10_000)),
    ]
    // The mechanical recovery message the trim injects carries a fresh
    // `sentAt`, so two calls are never byte-identical in wall-clock terms.
    // Compare the trimmed content only.
    const shape = (trimmed: Message[]): string =>
      JSON.stringify(trimmed.map(({ sentAt, ...rest }) => rest))

    const explicitZero = getMessagesForModelContext({
      messages,
      contextWindowTokens: 2_000,
      systemTokens: 0,
      logger,
    })
    const omitted = getMessagesForModelContext({
      messages,
      contextWindowTokens: 2_000,
      logger,
    })

    expect(omitted).not.toBe(messages)
    expect(shape(omitted)).toBe(shape(explicitZero))

    // Non-finite and negative inputs sanitize to 0.
    for (const systemTokens of [-5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        shape(
          getMessagesForModelContext({
            messages,
            contextWindowTokens: 2_000,
            systemTokens,
            logger,
          }),
        ),
      ).toBe(shape(explicitZero))
    }
  })

  test('stays behaviorally safe for a Zod-schema toolset on the exported request paths', () => {
    // The canonical AI-SDK form the published `promptAiSdkStream`/`promptAiSdk`
    // param types accept: `inputSchema` is a Zod schema instance, not JSON.
    const tools = {
      read_file: {
        description: 'Read a file from the project',
        inputSchema: z.object({
          path: z.string(),
          startLine: z.number().optional(),
        }),
      },
      write_file: {
        description: 'Write a file in the project',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
      },
    }

    const overhead = countRequestOverheadTokens({
      system: 'system prompt',
      tools,
      includeTools: true,
    })

    // Bounded: the schemas are converted to JSON Schema and counted (clamped
    // between the per-tool floor and ceiling), so a two-tool surface of small
    // schemas is still nowhere near the thousands of tokens that serializing
    // the schema instances' internals would produce.
    expect(overhead).toBeGreaterThan(0)
    expect(overhead).toBeLessThan(1_000)

    // And the resulting budget still leaves a comfortably-fitting history
    // untouched, so existing consumers keep their previous behavior.
    const messages: Message[] = [userMessage('fits comfortably '.repeat(50))]
    expect(
      getMessagesForModelContext({
        messages,
        contextWindowTokens: 200_000,
        systemTokens: overhead,
        logger,
      }),
    ).toBe(messages)
  })

  test('reserves materially more for a large Zod schema than a small one', () => {
    // The reservation is size-aware: a flat per-tool estimate under-reserved a
    // large tool surface, which made the request-time brake believe more
    // message budget was available than really was. Assert the relationship,
    // not a token count.
    const smallOverhead = countRequestOverheadTokens({
      tools: {
        tiny_tool: {
          description: 'A tool with one small field',
          inputSchema: z.object({ path: z.string() }),
        },
      },
      includeTools: true,
    })
    const largeOverhead = countRequestOverheadTokens({
      tools: {
        tiny_tool: {
          description: 'A tool with one small field',
          inputSchema: z.object({
            path: z.string().describe('Absolute or project-relative file path'),
            startLine: z.number().describe('First line to read, 1-indexed'),
            endLine: z.number().describe('Last line to read, inclusive'),
            encoding: z.string().describe('Text encoding of the file'),
            includeHidden: z.boolean().describe('Include dot-prefixed entries'),
            maxBytes: z.number().describe('Hard cap on bytes read'),
            glob: z.string().describe('Glob filter applied to matches'),
            exclude: z.array(z.string()).describe('Glob patterns to skip'),
            followSymlinks: z.boolean().describe('Resolve symbolic links'),
            recursive: z.boolean().describe('Walk nested directories'),
            sortBy: z.string().describe('Sort key for the returned entries'),
            limit: z.number().describe('Maximum number of entries returned'),
          }),
        },
      },
      includeTools: true,
    })

    expect(largeOverhead).toBeGreaterThan(smallOverhead)
  })

  test('counts a Zod schema in the same ballpark as its JSON-Schema equivalent', () => {
    // Conversion output is not byte-identical to a hand-written schema, so the
    // parity claim is a ballpark one: the Zod surface must no longer be charged
    // a token order of magnitude less than the plain JSON Schema it compiles to.
    const zodOverhead = countRequestOverheadTokens({
      tools: {
        read_file: {
          description: 'Read a file',
          inputSchema: z.object({
            path: z.string().describe('File path'),
            startLine: z.number().describe('First line to read'),
            endLine: z.number().describe('Last line to read'),
            encoding: z.string().describe('Text encoding'),
          }),
        },
      },
      includeTools: true,
    })
    const jsonSchemaOverhead = countRequestOverheadTokens({
      tools: {
        read_file: {
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
              startLine: { type: 'number', description: 'First line to read' },
              endLine: { type: 'number', description: 'Last line to read' },
              encoding: { type: 'string', description: 'Text encoding' },
            },
            required: ['path', 'startLine', 'endLine', 'encoding'],
          },
        },
      },
      includeTools: true,
    })

    expect(zodOverhead).toBeGreaterThanOrEqual(
      Math.floor(jsonSchemaOverhead / 2),
    )
  })

  test('reserves at least the fallback floor for an unconvertible schema', () => {
    // An `inputSchema` that is neither plain JSON data nor convertible to JSON
    // Schema still has to reserve something, or the brake would silently treat
    // an opaque tool surface as free.
    class OpaqueSchema {
      readonly kind = 'opaque'
      validate(): boolean {
        return true
      }
    }

    const withoutSchema = countRequestOverheadTokens({
      tools: { opaque_tool: { description: 'Opaque schema' } },
      includeTools: true,
    })
    const withOpaqueSchema = countRequestOverheadTokens({
      tools: {
        opaque_tool: {
          description: 'Opaque schema',
          inputSchema: new OpaqueSchema(),
        },
      },
      includeTools: true,
    })

    // A tool with no `inputSchema` at all reserves nothing for a schema.
    expect(withoutSchema).toBe(
      countTokensJson({ name: 'opaque_tool', description: 'Opaque schema' }),
    )
    // The floor is today's flat estimate, so behavior never regresses below it.
    expect(withOpaqueSchema - withoutSchema).toBeGreaterThanOrEqual(120)
  })

  test('clamps an absurdly large schema to the per-tool ceiling', () => {
    // Size-awareness must not let one pathological schema collapse the message
    // budget: the counted reservation is capped per tool (8_000 tokens).
    const shape: Record<string, z.ZodType> = {}
    for (let index = 0; index < 1_500; index++) {
      shape[`field_${index}`] = z
        .string()
        .describe(`Description of field number ${index} on this absurd schema`)
    }

    const overhead = countRequestOverheadTokens({
      tools: {
        absurd_tool: {
          description: 'A tool with a pathologically large schema',
          inputSchema: z.object(shape),
        },
      },
      includeTools: true,
    })

    // Materially size-aware (far above the 120-token floor) but still bounded
    // by the ceiling plus the exactly-counted name/description.
    expect(overhead).toBeGreaterThan(1_000)
    expect(overhead).toBeLessThan(8_100)
  })

  test('counts plain JSON Schema tool surfaces exactly', () => {
    const jsonSchema = {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    }

    const bare = countRequestOverheadTokens({
      tools: {
        read_file: { description: 'Read a file', inputSchema: jsonSchema },
      },
      includeTools: true,
    })
    // The AI-SDK `jsonSchema()` wrapper exposes the same schema on a
    // `jsonSchema` property, so both forms must count identically.
    const wrapped = countRequestOverheadTokens({
      tools: {
        read_file: { description: 'Read a file', inputSchema: { jsonSchema } },
      },
      includeTools: true,
    })

    expect(bare).toBe(wrapped)
    expect(bare).toBe(
      countTokensJson({
        name: 'read_file',
        description: 'Read a file',
        input_schema: jsonSchema,
      }),
    )
  })

  test('never serializes a self-referential tool schema', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.self = cyclic

    // A cyclic non-schema object cannot be converted to JSON Schema, so the
    // conversion attempt must be swallowed and the tool must fall back to the
    // flat floor rather than throwing out of countRequestOverheadTokens.

    expect(() =>
      countRequestOverheadTokens({
        system: 'system prompt',
        tools: {
          looping: { description: 'Cyclic schema', inputSchema: cyclic },
        },
        includeTools: true,
      }),
    ).not.toThrow()
    expect(
      countRequestOverheadTokens({
        tools: {
          looping: { description: 'Cyclic schema', inputSchema: cyclic },
        },
        includeTools: true,
      }),
    ).toBeLessThan(1_000)
  })

  test('omits the tool surface when the provider strips tools', () => {
    const tools = {
      read_file: {
        description: 'Read a file',
        inputSchema: z.object({ path: z.string() }),
      },
    }

    expect(
      countRequestOverheadTokens({
        system: 'system prompt',
        tools,
        includeTools: false,
      }),
    ).toBe(countTokensJson('system prompt'))
  })

  test('extracts provider context limits from oversized-prompt errors', () => {
    expect(
      getProviderContextLimitFromError(
        new Error('prompt is too long: 200548 tokens > 200000 maximum'),
      ),
    ).toBe(200_000)
    expect(
      getProviderContextLimitFromError({
        responseBody: 'maximum context length is 128000 tokens',
      }),
    ).toBe(128_000)
    expect(getProviderContextLimitFromError(new Error('rate limited'))).toBe(
      undefined,
    )
  })
})
