import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { toolParams } from '@codebuff/common/tools/list'
import { describe, test, expect, mock } from 'bun:test'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import {
  ensureAgentTemplateZodSchemas,
  serializeAgentTemplatesForTransport,
} from '@codebuff/common/templates/agent-validation'
import { z } from 'zod/v4'

import { additionalSystemPrompts } from '../system-prompt/prompts'
import {
  buildAgentToolInputSchema,
  buildAgentToolSet,
} from '../templates/prompts'
import { tryTransformAgentToolCall } from '../tools/tool-executor'
import { handleLookupAgentInfo } from '../tools/handlers/tool/lookup-agent-info'
import {
  compactToolInputSchemaForProvider,
  ensureZodSchema,
  buildToolDescription,
  getToolsInstructions,
  getToolSet,
  toolDescriptions,
} from '../tools/prompts'

import type { AgentTemplate } from '../templates/types'
import securityReviewer from '../../../../agents/security-reviewer/security-reviewer'

/** Create a mock logger using bun:test mock() for better test consistency */
const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
})

describe('Schema handling error recovery', () => {
  test('security-reviewer exposes its canonical required params before spawn', () => {
    expect(securityReviewer.spawnerPrompt).toContain('`changed_files`')
    expect(securityReviewer.spawnerPrompt).toContain('`snapshot_fingerprint`')
    expect(securityReviewer.spawnerPrompt).toContain(
      '`snapshot_id` is not accepted',
    )
    expect(securityReviewer.inputSchema?.params).toMatchObject({
      required: ['changed_files', 'snapshot_fingerprint'],
    })
  })

  describe('mutation tool instructions', () => {
    test('adds self-contained edit guidance only for mutation-capable agents', () => {
      const mutationPrompt = getToolsInstructions(['str_replace'], {})
      const readOnlyPrompt = getToolsInstructions(['read_files'], {})

      expect(mutationPrompt).toContain('Deterministic Editing Discipline')
      expect(mutationPrompt).toContain('[see patch above]')
      expect(readOnlyPrompt).not.toContain('Deterministic Editing Discipline')
    })
  })

  describe('/compact prompt schema', () => {
    test('prescribes the structured knowledge-memory fields (M8 regression)', () => {
      const prompt = additionalSystemPrompts['/compact']

      expect(prompt).toContain('Goal:')
      expect(prompt).toContain('Decisions:')
      expect(prompt).toContain('Files Inspected:')
      expect(prompt).toContain('Edits Made:')
      expect(prompt).toContain('Validation Results:')
      expect(prompt).toContain('Blockers:')
      expect(prompt).toContain('Next Action:')
      expect(prompt).toContain('file paths')
      expect(prompt).toContain('commands run')
    })
  })

  describe('ensureJsonSchemaCompatible in templates/prompts.ts', () => {
    test('handles schema that cannot be converted to JSON Schema', async () => {
      // Create a schema that will fail JSON Schema conversion
      // z.function() cannot be converted to JSON Schema
      const problematicSchema = z.function()

      const agentTemplate: AgentTemplate = {
        id: 'test-agent',
        displayName: 'Test Agent',
        spawnerPrompt: 'Test spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('A test prompt'),
          params: problematicSchema as unknown as z.ZodType<
            Record<string, unknown> | undefined
          >,
        },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      // buildAgentToolSet uses ensureJsonSchemaCompatible internally
      // It should not throw even with problematic schema
      const toolSet = await buildAgentToolSet({
        spawnableAgents: ['test-agent'],
        agentTemplates: { 'test-agent': agentTemplate },
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      // Should have created a tool without throwing
      expect(toolSet['test_agent']).toBeDefined()
      expect(toolSet['test-agent']).toBeUndefined()
    })

    test('generic spawn mode omits redundant per-agent native tools', async () => {
      const agentTemplate: AgentTemplate = {
        id: 'test-agent',
        displayName: 'Test Agent',
        spawnerPrompt: 'Test spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: { prompt: z.string() },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const toolSet = await buildAgentToolSet({
        spawnableAgents: ['test-agent'],
        spawnableAgentToolMode: 'generic',
        agentTemplates: { 'test-agent': agentTemplate },
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(toolSet).toEqual({})
    })

    test('keeps context-pruner internal while exposing ordinary child agents', async () => {
      const makeTemplate = (id: string): AgentTemplate => ({
        id,
        displayName: id,
        spawnerPrompt: `Spawn ${id}`,
        inputSchema: { prompt: z.string().optional() },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      })
      const contextPruner = makeTemplate('context-pruner')
      const reviewer = makeTemplate('code-reviewer')

      const toolSet = await buildAgentToolSet({
        spawnableAgents: ['context-pruner', 'code-reviewer'],
        agentTemplates: {
          'context-pruner': contextPruner,
          'code-reviewer': reviewer,
        },
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(toolSet.context_pruner).toBeUndefined()
      expect(toolSet.code_reviewer).toBeDefined()
    })

    test('buildAgentToolInputSchema handles valid schemas', () => {
      const agentTemplate: AgentTemplate = {
        id: 'valid-agent',
        displayName: 'Valid Agent',
        spawnerPrompt: 'Valid spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('A valid prompt'),
          params: z.object({ foo: z.string() }),
        },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      // Should return a valid schema that can be converted to JSON Schema
      expect(() => z.toJSONSchema(inputSchema, { io: 'input' })).not.toThrow()
    })

    test('buildAgentToolInputSchema handles empty inputSchema', () => {
      const agentTemplate: AgentTemplate = {
        id: 'empty-schema-agent',
        displayName: 'Empty Schema Agent',
        spawnerPrompt: 'Empty schema spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {},
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      // Should return a valid schema
      expect(() => z.toJSONSchema(inputSchema, { io: 'input' })).not.toThrow()
    })

    test('buildAgentToolInputSchema coerces plain JSON-Schema members across the JSON boundary', () => {
      // Bundled/bridged templates lose their zod prototype in a
      // JSON.stringify round-trip and arrive as plain JSON-Schema objects;
      // feeding those to asSchema crashes on schema._def.typeName.
      const agentTemplate: AgentTemplate = {
        id: 'bridged-agent',
        displayName: 'Bridged Agent',
        spawnerPrompt: 'Run a bridged task',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: { type: 'string', description: 'The task prompt' },
          params: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        } as unknown as AgentTemplate['inputSchema'],
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      // asSchema-safe: the members were converted to zod, and the same
      // payloads the plain JSON schema described still parse.
      expect(() => z.toJSONSchema(inputSchema, { io: 'input' })).not.toThrow()
      expect(
        inputSchema.safeParse({
          prompt: 'Run it',
          params: { command: 'pwd' },
        }).success,
      ).toBe(true)
    })

    test('ensureAgentTemplateZodSchemas leaves zod members untouched (no double conversion)', () => {
      const promptSchema = z.string()
      const paramsSchema = z.object({ command: z.string() })
      const outputSchema = z.object({ answer: z.string() })
      const template = {
        id: 'zod-agent',
        inputSchema: { prompt: promptSchema, params: paramsSchema },
        outputSchema,
      } as unknown as AgentTemplate

      const result = ensureAgentTemplateZodSchemas(template)

      // Identity-preserving: already-zod members are never re-wrapped.
      expect(result).toBe(template)
      expect(result.inputSchema.prompt).toBe(promptSchema)
      expect(result.inputSchema.params).toBe(paramsSchema)
      expect(result.outputSchema).toBe(outputSchema)
    })

    test('ensureAgentTemplateZodSchemas converts plain JSON-Schema members and preserves payloads', () => {
      const template = {
        id: 'json-agent',
        inputSchema: {
          prompt: { type: 'string' },
          params: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
        outputSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      } as unknown as AgentTemplate

      const result = ensureAgentTemplateZodSchemas(template)

      expect(typeof result.inputSchema.prompt?.safeParse).toBe('function')
      expect(typeof result.inputSchema.params?.safeParse).toBe('function')
      expect(typeof result.outputSchema?.safeParse).toBe('function')
      // The converted schemas accept the same payloads the plain JSON schema
      // described.
      expect(result.inputSchema.prompt!.safeParse('hello').success).toBe(true)
      expect(result.inputSchema.params!.safeParse({ q: 'x' }).success).toBe(
        true,
      )
      expect(result.outputSchema!.safeParse({ answer: 'x' }).success).toBe(true)
    })
  })

  describe('direct agent control envelope', () => {
    test('exposes the background control for every direct agent tool', () => {
      const schema = buildAgentToolInputSchema({
        id: 'editor',
        displayName: 'Editor',
        inputSchema: { prompt: z.string() },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      } as AgentTemplate)

      expect(
        schema.safeParse({
          prompt: 'Implement it',
          background: true,
        }).success,
      ).toBe(true)
    })
  })

  describe('direct subagent tool names', () => {
    test('uses underscored tool aliases while preserving hyphenated agent IDs', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'file_picker',
        input: { prompt: 'Find relevant files' },
        spawnableAgents: ['openbuff/file-picker@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/file-picker@1.0.0',
              prompt: 'Find relevant files',
            },
          ],
        },
      })
    })

    test('repairs malformed direct-agent alias input before transformation', () => {
      expect(
        tryTransformAgentToolCall({
          toolName: 'basher',
          input:
            '{"prompt":"Run tests",,"params":"{\\"command\\":\\"bun test\\",,\\"timeout_seconds\\":30}"}',
          spawnableAgents: ['basher'],
        }),
      ).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'basher',
              prompt: 'Run tests',
              params: { command: 'bun test', timeout_seconds: 30 },
            },
          ],
        },
      })
    })

    test('does not fabricate a direct-agent call from truncated input', () => {
      expect(
        tryTransformAgentToolCall({
          toolName: 'basher',
          input: '{"params":{"command":"bun test"}',
          spawnableAgents: ['basher'],
        }),
      ).toBeNull()
    })

    test('parses stringified params for direct agent tool schemas', () => {
      const agentTemplate: AgentTemplate = {
        id: 'basher-like-agent',
        displayName: 'Basher-like Agent',
        spawnerPrompt: 'Run a shell command',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string(),
          params: z.object({ command: z.string() }),
        },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      const parsed = inputSchema.safeParse({
        prompt: 'Run pwd',
        params: '{"command":"pwd"}',
      })

      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data).toEqual({
          prompt: 'Run pwd',
          params: { command: 'pwd' },
        })
      }

      expect(
        inputSchema.safeParse({
          prompt: 'Run pwd',
          params: '["pwd"]',
        }).success,
      ).toBe(false)
      expect(
        inputSchema.safeParse({
          prompt: 'Run pwd',
          params: '{}',
        }).success,
      ).toBe(false)
    })

    test('preserves structured handoff on direct agent tool calls', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'file_picker',
        input: {
          prompt: 'Find relevant files',
          params: { directories: ['src'] },
          handoff: {
            summary: 'Use the existing implementation notes',
            successCriteria: ['Return the most relevant files'],
          },
        },
        spawnableAgents: ['openbuff/file-picker@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/file-picker@1.0.0',
              prompt: 'Find relevant files',
              params: { directories: ['src'] },
              handoff: {
                summary: 'Use the existing implementation notes',
                successCriteria: ['Return the most relevant files'],
              },
            },
          ],
        },
      })
    })

    test('preserves stringified params on direct agent tool calls', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'basher',
        input: {
          prompt: 'Run pwd',
          params: '{"command":"pwd"}',
        },
        spawnableAgents: ['openbuff/basher@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/basher@1.0.0',
              prompt: 'Run pwd',
              params: '{"command":"pwd"}',
            },
          ],
        },
      })
    })

    test('preserves explicit null params on direct agent tool calls', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'basher',
        input: {
          prompt: 'Run pwd',
          params: null,
        },
        spawnableAgents: ['openbuff/basher@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/basher@1.0.0',
              prompt: 'Run pwd',
              params: null,
            },
          ],
        },
      })
    })

    test('preserves the background control on direct agent tool calls', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'editor',
        input: {
          prompt: 'Implement the change',
          background: true,
          // Stray deadline field from an older model habit: it is no longer part
          // of the spawn entry contract, so it must not be forwarded.
          timeout_seconds: 90,
        },
        spawnableAgents: ['openbuff/editor@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/editor@1.0.0',
              prompt: 'Implement the change',
              background: true,
            },
          ],
        },
      })
    })

    test('preserves explicit zero params on direct agent tool calls', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'basher',
        input: {
          prompt: 'Run pwd',
          params: 0,
        },
        spawnableAgents: ['openbuff/basher@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/basher@1.0.0',
              prompt: 'Run pwd',
              params: 0,
            },
          ],
        },
      })
    })

    test('preserves invalid direct agent handoff values for schema rejection', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'file_picker',
        input: {
          prompt: 'Find relevant files',
          handoff: 'not structured',
        },
        spawnableAgents: ['openbuff/file-picker@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'openbuff/file-picker@1.0.0',
              prompt: 'Find relevant files',
              handoff: 'not structured',
            },
          ],
        },
      })
    })
  })

  describe('ensureJsonSchemaCompatible in tools/prompts.ts', () => {
    test('buildToolDescription handles problematic schemas gracefully', () => {
      // z.promise() cannot be converted to JSON Schema
      const problematicSchema = z.promise(z.string())

      // Should not throw when building tool description
      const description = buildToolDescription({
        toolName: 'test_tool',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'A test tool',
        endsAgentStep: false,
      })

      expect(description).toContain('test_tool')
      expect(description).toContain('A test tool')
      // Should have Params section with fallback (either 'None' or empty object)
      expect(description).toContain('Params:')
    })

    test('buildToolDescription uses fallback for schemas that fail toJSONSchema', () => {
      // z.function() cannot be converted to JSON Schema
      const problematicSchema = z.function()

      const description = buildToolDescription({
        toolName: 'fallback_test',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'Testing fallback behavior',
        endsAgentStep: false,
      })

      // Should use fallback - verify the Params section exists and doesn't crash
      expect(description).toContain('### fallback_test')
      expect(description).toContain('Testing fallback behavior')
      // The fallback schema is z.object({}).passthrough() which has no properties
      // So it should show 'Params: None'
      expect(description).toContain('Params: None')
    })

    test('buildToolDescription handles valid schemas', () => {
      const validSchema = z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File content'),
      })

      const description = buildToolDescription({
        toolName: 'write_file',
        schema: validSchema,
        description: 'Write a file',
        endsAgentStep: false, // endsAgentStep=false to avoid schema combination issues
      })

      expect(description).toContain('write_file')
      expect(description).toContain('Write a file')
      // The schema properties should be in the JSON output
      expect(description).toContain('path')
      expect(description).toContain('content')
    })

    test('buildToolDescription preserves MCP params when schema is represented as allOf', () => {
      const mcpSchema = convertJsonSchemaToZod({
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      })

      const description = buildToolDescription({
        toolName: 'greet__greet',
        schema: mcpSchema,
        description: 'Call greet',
        endsAgentStep: true,
      })

      expect(description).toContain('greet__greet')
      expect(description).toContain('Params: {')
      expect(description).toContain('allOf')
      expect(description).toContain('name')
      expect(description).not.toContain('Params: None')
    })

    test('getToolSet binds spawn_agents provider schema to the live catalog', async () => {
      const toolSet = await getToolSet({
        toolNames: ['spawn_agents'],
        additionalToolDefinitions: async () => ({}),
        agentTools: {},
        skills: {},
        spawnableAgentTypes: ['file-picker', 'general-agent'],
      })

      const jsonSchema = (
        toolSet.spawn_agents.inputSchema as unknown as {
          jsonSchema: Record<string, unknown>
        }
      ).jsonSchema
      const schema = convertJsonSchemaToZod(jsonSchema)

      const parseAgentType = (agentType: string) =>
        schema.safeParse({
          agents: [{ agent_type: agentType, prompt: 'Find relevant files' }],
        })

      expect(parseAgentType('file-picker').success).toBe(true)
      expect(parseAgentType('file_picker').success).toBe(true)
      expect(parseAgentType('general-agent').success).toBe(true)
      expect(parseAgentType('file-explorer').success).toBe(false)
      expect(parseAgentType('read_files').success).toBe(false)
    })

    test('getToolSet handles custom tools with problematic schemas', async () => {
      // Create a custom tool definition with a schema that can't be converted
      const customToolDefs = {
        problematic_tool: {
          description: 'A problematic tool',
          inputSchema: z.function() as unknown as z.ZodType,
          endsAgentStep: true,
        },
      }

      const toolSet = await getToolSet({
        toolNames: [],
        additionalToolDefinitions: async () => customToolDefs,
        agentTools: {},
        skills: {},
      })

      // Should have the tool defined without throwing
      expect(toolSet['problematic_tool']).toBeDefined()
    })

    test('getToolSet compacts provider-facing builtin tool schemas', async () => {
      const rawLength = JSON.stringify(
        toolParams.edit_transaction.inputSchema,
      ).length

      const toolSet = await getToolSet({
        toolNames: ['edit_transaction'],
        additionalToolDefinitions: async () => ({}),
        agentTools: {},
        skills: {},
      })

      const compactLength = JSON.stringify(
        toolSet.edit_transaction.inputSchema,
      ).length
      const jsonSchema = (
        toolSet.edit_transaction.inputSchema as unknown as {
          jsonSchema: Record<string, unknown>
        }
      ).jsonSchema

      expect(compactLength).toBeLessThan(rawLength / 5)
      expect(jsonSchema).toMatchObject({
        type: 'object',
        properties: {
          edits: expect.any(Object),
        },
      })
    })

    test('compactToolInputSchemaForProvider preserves descriptions only when requested', () => {
      const schema = (toolParams.edit_transaction.providerInputSchema ??
        toolParams.edit_transaction.inputSchema) as z.ZodType

      const containsDescriptionKey = (value: unknown): boolean => {
        if (Array.isArray(value)) {
          return value.some(containsDescriptionKey)
        }
        if (!value || typeof value !== 'object') {
          return false
        }
        return Object.entries(value as Record<string, unknown>).some(
          ([key, child]) =>
            key === 'description' || containsDescriptionKey(child),
        )
      }
      const schemaJson = (tool: unknown): unknown =>
        (tool as { jsonSchema: unknown }).jsonSchema

      const preserved = compactToolInputSchemaForProvider(schema, {
        preserveDescriptions: true,
      })
      const stripped = compactToolInputSchemaForProvider(schema)
      const strippedOmitted = compactToolInputSchemaForProvider(schema, {
        preserveDescriptions: false,
      })

      expect(containsDescriptionKey(schemaJson(preserved))).toBe(true)
      expect(containsDescriptionKey(schemaJson(stripped))).toBe(false)
      expect(containsDescriptionKey(schemaJson(strippedOmitted))).toBe(false)
    })

    test('builtin descriptions advertise canonical transaction range anchors', () => {
      const description = toolDescriptions.edit_transaction

      expect(description).toContain('readCapability')
      expect(description).toContain('expectedHash')
      expect(description).toContain('startLine')
      expect(description).toContain('endLine')
    })

    test('ensureZodSchema converts JSON Schema to Zod schema', () => {
      const jsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      }

      const zodSchema = ensureZodSchema(jsonSchema)

      // Should be able to parse valid data
      const result = zodSchema.safeParse({ name: 'test', age: 25 })
      expect(result.success).toBe(true)
    })

    test('ensureZodSchema returns Zod schema unchanged', () => {
      const zodSchema = z.object({
        name: z.string(),
      })

      const result = ensureZodSchema(zodSchema)

      // Should return the same schema
      expect(result).toBe(zodSchema)
    })
  })

  describe('toJSONSchema error handling in lookup-agent-info.ts', () => {
    test('handles schemas that cannot be converted to JSON Schema', async () => {
      // Create an agent template with a problematic output schema
      const agentTemplate: AgentTemplate = {
        id: 'problematic-output-agent',
        displayName: 'Problematic Output Agent',
        spawnerPrompt: 'Test',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string(),
        },
        outputMode: 'structured_output',
        outputSchema: z.function() as unknown as z.ZodType, // This cannot be converted
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const localAgentTemplates = {
        'problematic-output-agent': agentTemplate,
      }

      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'problematic-output-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates,
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      // Should return a result without throwing
      expect(result.output).toBeDefined()

      // Parse the output to check the fallback
      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as {
          found: boolean
          agent?: { outputSchema?: unknown }
        }
        expect(parsed.found).toBe(true)
        // The outputSchema should be the fallback
        expect(parsed.agent?.outputSchema).toEqual({
          type: 'object',
          description: 'Schema unavailable',
        })
      }
    })

    test('handles valid schemas correctly', async () => {
      const agentTemplate: AgentTemplate = {
        id: 'valid-output-agent',
        displayName: 'Valid Output Agent',
        spawnerPrompt: 'Test',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('User prompt'),
          params: z.object({
            verbose: z.boolean().optional(),
          }),
        },
        outputMode: 'structured_output',
        outputSchema: z.object({
          result: z.string(),
          success: z.boolean(),
        }),
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['read_files'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const localAgentTemplates = {
        'valid-output-agent': agentTemplate,
      }

      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'valid-output-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates,
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as {
          found: boolean
          agent?: {
            outputSchema?: {
              type?: string
              properties?: Record<string, unknown>
            }
            inputSchema?: { prompt?: unknown; params?: unknown }
          }
        }
        expect(parsed.found).toBe(true)
        // Should have proper JSON Schema output
        expect(parsed.agent?.outputSchema?.type).toBe('object')
        expect(parsed.agent?.outputSchema?.properties).toHaveProperty('result')
        expect(parsed.agent?.outputSchema?.properties).toHaveProperty('success')
        // Input schema should also be converted
        expect(parsed.agent?.inputSchema?.prompt).toBeDefined()
        expect(parsed.agent?.inputSchema?.params).toBeDefined()
      }
    })

    test('returns not found for non-existent agent', async () => {
      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'non-existent-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates: {},
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as { found: boolean; error?: string }
        expect(parsed.found).toBe(false)
        expect(parsed.error).toContain('not found')
      }
    })
  })

  describe('Schema with endsAgentStep parameter', () => {
    test('toJsonSchemaSafe handles problematic schema with endsAgentStep', () => {
      // When endsAgentStep is true, the schema is combined with another schema
      // This tests that the combined schema also handles errors gracefully
      const problematicSchema = z.promise(z.string())

      const description = buildToolDescription({
        toolName: 'async_tool',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'An async tool',
        endsAgentStep: true,
      })

      // Should produce valid output without throwing
      expect(description).toContain('async_tool')
      expect(description).toContain('An async tool')
    })
  })

  describe('serializeAgentTemplatesForTransport (supervised spawn transport boundary)', () => {
    const makeTransportTemplate = (
      overrides: Record<string, unknown>,
    ): AgentTemplate =>
      ({
        id: 'transport-agent',
        displayName: 'Transport Agent',
        spawnerPrompt: 'Transport test prompt',
        model: 'gpt-4o-mini',
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
        ...overrides,
      }) as unknown as AgentTemplate

    test('converts live zod schema members to round-trip-safe JSON Schema', () => {
      const template = makeTransportTemplate({
        inputSchema: {
          prompt: z.string().describe('Task prompt'),
          params: z.object({ command: z.string() }),
        },
        outputSchema: z.object({ answer: z.string() }),
      })

      const transported = serializeAgentTemplatesForTransport({
        'transport-agent': template,
      })['transport-agent']

      const promptSchema = transported.inputSchema?.prompt as unknown as Record<
        string,
        unknown
      >
      expect(promptSchema).toMatchObject({
        type: 'string',
        description: 'Task prompt',
      })
      expect(promptSchema._zod).toBeUndefined()
      expect(typeof promptSchema.safeParse).not.toBe('function')

      const paramsSchema = transported.inputSchema?.params as unknown as Record<
        string,
        unknown
      >
      expect(paramsSchema).toMatchObject({
        type: 'object',
        properties: { command: { type: 'string' } },
      })

      const outputSchema = transported.outputSchema as unknown as Record<
        string,
        unknown
      >
      expect(outputSchema).toMatchObject({
        type: 'object',
        properties: { answer: { type: 'string' } },
      })

      // The serialized request file carries the schema structure, not the
      // empty husk JSON.stringify makes of a live zod instance.
      const serialized = JSON.stringify(
        serializeAgentTemplatesForTransport({ 'transport-agent': template }),
      )
      expect(serialized).toContain('"type":"object"')
      expect(serialized).toContain('"type":"string"')
    })

    test('stringifies function-valued handleSteps and passes strings through', () => {
      const handleStepsFn = function* () {
        yield
      }
      const functionTemplate = makeTransportTemplate({
        handleSteps: handleStepsFn as unknown as AgentTemplate['handleSteps'],
      })
      const transportedFn = serializeAgentTemplatesForTransport({
        'transport-agent': functionTemplate,
      })['transport-agent']

      expect(transportedFn.handleSteps).toBe(handleStepsFn.toString())
      expect(transportedFn.handleSteps as string).toContain('function*')

      const stringHandleSteps = 'function* (params) { yield }'
      const stringTemplate = makeTransportTemplate({
        handleSteps: stringHandleSteps,
      })
      const transportedString = serializeAgentTemplatesForTransport({
        'transport-agent': stringTemplate,
      })['transport-agent']

      expect(transportedString.handleSteps).toBe(stringHandleSteps)
    })

    test('returns the original template object when nothing needs conversion', () => {
      const plain = makeTransportTemplate({
        inputSchema: { prompt: { type: 'string' } },
        handleSteps: 'function* (params) { yield }',
      })

      const transported = serializeAgentTemplatesForTransport({
        'transport-agent': plain,
      })

      expect(transported['transport-agent']).toBe(plain)
    })

    test('output resolves back through ensureAgentTemplateZodSchemas in the child', () => {
      const template = makeTransportTemplate({
        inputSchema: {
          prompt: z.string(),
          params: z.object({ command: z.string() }),
        },
        outputSchema: z.object({ answer: z.string() }),
      })

      const transported = serializeAgentTemplatesForTransport({
        'transport-agent': template,
      })['transport-agent']
      const resolved = ensureAgentTemplateZodSchemas(transported)

      expect(typeof resolved.inputSchema?.prompt?.safeParse).toBe('function')
      expect(typeof resolved.inputSchema?.params?.safeParse).toBe('function')
      expect(typeof resolved.outputSchema?.safeParse).toBe('function')
      expect(resolved.inputSchema.prompt!.safeParse('hello').success).toBe(true)
      expect(
        resolved.inputSchema.params!.safeParse({ command: 'pwd' }).success,
      ).toBe(true)
      expect(resolved.outputSchema!.safeParse({ answer: 'ok' }).success).toBe(
        true,
      )
    })

    test('leaves non-JSON-expressible zod schemas untouched instead of throwing', () => {
      const problematicParams = z.function()
      const problematicOutput = z.function()
      const template = makeTransportTemplate({
        inputSchema: {
          params:
            problematicParams as unknown as AgentTemplate['inputSchema']['params'],
        },
        outputSchema:
          problematicOutput as unknown as AgentTemplate['outputSchema'],
      })

      const transported = serializeAgentTemplatesForTransport({
        'transport-agent': template,
      })

      // The try/catch fallback keeps the original member so behavior is
      // never worse than the status quo.
      expect(transported['transport-agent'].inputSchema?.params).toBe(
        problematicParams,
      )
      expect(transported['transport-agent'].outputSchema).toBe(
        problematicOutput,
      )
    })
  })
})
