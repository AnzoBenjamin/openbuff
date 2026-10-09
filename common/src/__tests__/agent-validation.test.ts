import { beforeEach, describe, expect, it, test } from 'bun:test'

import { z } from 'zod/v4'

import {
  coerceJsonSchemaMember,
  isDegradedZodHusk,
  isRepresentableZodSchema,
  serializeSchemaMemberForTransport,
  validateAgents,
} from '../templates/agent-validation'
import { DynamicAgentDefinitionSchema } from '../types/dynamic-agent-template'
import { getStubProjectFileContext } from '../util/file'

import type { DynamicAgentTemplate } from '../types/dynamic-agent-template'
import type { AgentState } from '../types/session-state'
import type { ProjectFileContext } from '../util/file'
import type { Logger } from '@codebuff/common/types/contracts/logger'

describe('Agent Validation', () => {
  let mockFileContext: ProjectFileContext
  let mockAgentTemplate: DynamicAgentTemplate
  const logger: Logger = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }

  beforeEach(() => {
    mockFileContext = getStubProjectFileContext()

    mockAgentTemplate = {
      id: 'test-agent',
      version: '1.0.0',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      outputMode: 'structured_output' as const,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgentToolMode: 'direct',
      spawnableAgents: [],
      includeMessageHistory: true,
      includeReasoningInMessageHistory: false,
      inheritParentSystemPrompt: false,
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
    }
  })

  describe('Dynamic Agent Loading', () => {
    it('should load valid dynamic agent template', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'brainstormer.ts': {
            id: 'brainstormer',
            version: '1.0.0',
            displayName: 'Brainy',
            spawnerPrompt: 'Creative thought partner',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'You are a creative brainstormer.',
            instructionsPrompt: 'Help brainstorm ideas.',
            stepPrompt: 'Continue brainstorming.',
            toolNames: ['end_turn', 'spawn_agents'],
            spawnableAgents: ['thinker', 'researcher'],
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates).toHaveProperty('brainstormer')
      expect(result.templates.brainstormer.displayName).toBe('Brainy')
      expect(result.templates.brainstormer.id).toBe('brainstormer')
    })

    it('should merge static and dynamic templates', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'custom.ts': {
            id: 'custom-agent',
            version: '1.0.0',
            displayName: 'Custom',
            spawnerPrompt: 'Custom agent',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'Custom system prompt',
            instructionsPrompt: 'Custom user prompt',
            stepPrompt: 'Custom step prompt',
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn'],
            spawnableAgents: [],
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      // Should have dynamic templates
      expect(result.templates).toHaveProperty('custom-agent') // Dynamic
    })

    it('should handle agents with JSON schemas', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'schema-agent.ts': {
            id: 'schema-agent',
            version: '1.0.0',
            displayName: 'Schema Agent',
            spawnerPrompt: 'Agent with JSON schemas',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'Test system prompt',
            instructionsPrompt: 'Test user prompt',
            stepPrompt: 'Test step prompt',
            inputSchema: {
              prompt: {
                type: 'string',
                description: 'A test prompt',
              },
              params: {
                type: 'object',
                properties: {
                  temperature: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn'],
            spawnableAgents: [],
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates).toHaveProperty('schema-agent')
      expect(result.templates['schema-agent'].inputSchema.prompt).toBeDefined()
      expect(result.templates['schema-agent'].inputSchema.params).toBeDefined()
    })

    it('should return validation errors for invalid schemas', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'invalid-schema-agent.ts': {
            id: 'invalid-schema-agent',
            version: '1.0.0',
            displayName: 'Invalid Schema Agent',
            spawnerPrompt: 'Agent with invalid schemas',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'Test system prompt',
            instructionsPrompt: 'Test user prompt',
            stepPrompt: 'Test step prompt',
            inputSchema: {
              prompt: {} as Record<string, never>, // invalid prompt schema
            },
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn'],
            spawnableAgents: [],
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(1)
      expect(result.validationErrors[0].message).toContain(
        'Schema validation failed',
      )
      expect(result.templates).not.toHaveProperty('invalid-schema-agent')
    })

    it('should handle missing override field as non-override template', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'no-override-field.ts': {
            id: 'no-override-agent',
            version: '1.0.0',
            // No override field - should be treated as non-override
            displayName: 'No Override Agent',
            spawnerPrompt: 'Agent without override field',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'Test system prompt',
            instructionsPrompt: 'Test user prompt',
            stepPrompt: 'Test step prompt',
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn'],
            spawnableAgents: [],
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates).toHaveProperty('no-override-agent')
    })

    it('should validate spawnable agents including dynamic agents from first pass', async () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'git-committer.ts': {
            id: 'codebuffai-git-committer',
            version: '0.0.1',
            displayName: 'Git Committer',
            spawnerPrompt: 'A git committer agent',
            model: 'google/gemini-2.5-pro',
            systemPrompt: 'You are an expert software developer.',
            instructionsPrompt: 'Create a commit message.',
            stepPrompt: 'Make sure to end your response.',
            spawnableAgents: [], // No spawnable agents
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn'],
          },
          'spawner.ts': {
            id: 'spawner-agent',
            version: '1.0.0',
            displayName: 'Spawner Agent',
            spawnerPrompt: 'Agent that can spawn git-committer',
            model: 'anthropic/claude-4-sonnet-20250522',
            systemPrompt: 'Test system prompt',
            instructionsPrompt: 'Test user prompt',
            stepPrompt: 'Test step prompt',
            spawnableAgents: ['codebuffai-git-committer'], // Should be valid after first pass
            outputMode: 'last_message',
            includeMessageHistory: true,
            inheritParentSystemPrompt: false,
            toolNames: ['end_turn', 'spawn_agents'],
          },
        },
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates).toHaveProperty('codebuffai-git-committer')
      expect(result.templates).toHaveProperty('spawner-agent')
      expect(result.templates['spawner-agent'].spawnableAgents).toContain(
        'codebuffai-git-committer', // Full agent ID with prefix
      )
    })
  })

  describe('Schema Validation', () => {
    describe('Default Schema Behavior', () => {
      it('should have no prompt schema when no inputSchema provided', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'no-prompt-schema.ts': {
              id: 'no-prompt-schema-agent',
              version: '1.0.0',
              displayName: 'No Prompt Schema Agent',
              spawnerPrompt: 'Test agent without prompt schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
              // No inputSchema
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('no-prompt-schema-agent')
        expect(
          result.templates['no-prompt-schema-agent'].inputSchema.prompt,
        ).toBeUndefined()
      })

      it('should not have params schema when no paramsSchema provided', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'no-params-schema.ts': {
              id: 'no-params-schema-agent',
              version: '1.0.0',
              displayName: 'No Params Schema Agent',
              spawnerPrompt: 'Test agent without params schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
              // No paramsSchema
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('no-params-schema-agent')
        expect(
          result.templates['no-params-schema-agent'].inputSchema.params,
        ).toBeUndefined()
      })
    })

    describe('Complex Schema Scenarios', () => {
      it('should handle both inputSchema prompt and params together', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'both-schemas.ts': {
              id: 'both-schemas-agent',
              version: '1.0.0',
              displayName: 'Both Schemas Agent',
              spawnerPrompt: 'Test agent with both schemas',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: {
                  type: 'string',
                  minLength: 1,
                  description: 'A required prompt',
                },
                params: {
                  type: 'object',
                  properties: {
                    mode: {
                      type: 'string',
                      enum: ['fast', 'thorough'],
                    },
                    iterations: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 10,
                      default: 3,
                    },
                  },
                  required: ['mode'],
                },
              },
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('both-schemas-agent')

        const template = result.templates['both-schemas-agent']
        expect(template.inputSchema.prompt).toBeDefined()
        expect(template.inputSchema.params).toBeDefined()

        const inputPromptSchema = template.inputSchema.prompt!
        const paramsSchema = template.inputSchema.params!

        // Test prompt schema
        expect(inputPromptSchema.safeParse('valid prompt').success).toBe(true)
        expect(inputPromptSchema.safeParse('').success).toBe(false) // Too short

        // Test params schema
        expect(
          paramsSchema.safeParse({ mode: 'fast', iterations: 5 }).success,
        ).toBe(true)
        expect(paramsSchema.safeParse({ mode: 'invalid' }).success).toBe(false) // Invalid enum
        expect(paramsSchema.safeParse({ iterations: 5 }).success).toBe(false) // Missing required field
      })

      it('should handle schema with nested objects and arrays', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'complex-schema.ts': {
              id: 'complex-schema-agent',
              version: '1.0.0',
              displayName: 'Complex Schema Agent',
              spawnerPrompt: 'Test agent with complex nested schema',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                params: {
                  type: 'object',
                  properties: {
                    config: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        settings: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              key: { type: 'string' },
                              value: { type: 'string' },
                            },
                            required: ['key', 'value'],
                          },
                        },
                      },
                      required: ['name'],
                    },
                  },
                  required: ['config'],
                },
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('complex-schema-agent')

        const paramsSchema =
          result.templates['complex-schema-agent'].inputSchema.params!

        // Test valid complex object
        const validParams = {
          config: {
            name: 'test config',
            settings: [
              { key: 'setting1', value: 'value1' },
              { key: 'setting2', value: 'value2' },
            ],
          },
        }
        expect(paramsSchema.safeParse(validParams).success).toBe(true)

        // Test invalid nested structure
        const invalidParams = {
          config: {
            name: 'test config',
            settings: [
              { key: 'setting1' }, // Missing required 'value' field
            ],
          },
        }
        expect(paramsSchema.safeParse(invalidParams).success).toBe(false)
      })
    })

    describe('Error Message Quality', () => {
      it('should include file path in error messages', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'error-context.ts': {
              id: 'error-context-agent',
              version: '1.0.0',
              displayName: 'Error Context Agent',
              spawnerPrompt: 'Test agent for error context',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: 10 as unknown as Record<string, never>, // Invalid - number schema
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(1)
        expect(result.validationErrors[0].message).toContain(
          'Schema validation failed',
        )
        expect(result.validationErrors[0].filePath).toBe('error-context.ts')
      })
    })

    describe('Edge Cases', () => {
      it('should handle git-committer agent schema correctly', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'git-committer.ts': {
              id: 'codebuffai-git-committer',
              version: '0.0.1',
              displayName: 'Git Committer',
              spawnerPrompt:
                'A git committer agent specialized to commit current changes with an appropriate commit message.',
              model: 'google/gemini-2.5-pro',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              inputSchema: {
                prompt: {
                  type: 'string',
                  description: 'What changes to commit',
                },
                params: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                    },
                  },
                  required: ['message'],
                },
              },
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('codebuffai-git-committer')

        const template = result.templates['codebuffai-git-committer']
        const paramsSchema = template.inputSchema.params!

        expect(paramsSchema.safeParse('').success).toBe(false) // Too short
        expect(template.inputSchema.params).toBeDefined()
        // Test that the params schema properly validates the message property
        // This should succeed with a message property
        const validResult = paramsSchema.safeParse({
          message: 'test commit message',
        })
        expect(validResult.success).toBe(true)

        // This should fail without the required message property
        const invalidResult = paramsSchema.safeParse({})
        expect(invalidResult.success).toBe(false)
      })

      it('should handle empty inputSchema object', async () => {
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'empty-schema.ts': {
              id: 'empty-schema-agent',
              version: '1.0.0',
              displayName: 'Empty Schema Agent',
              model: 'anthropic/claude-4-sonnet-20250522',
              systemPrompt: 'Test system prompt',
              instructionsPrompt: 'Test user prompt',
              stepPrompt: 'Test step prompt',
              spawnerPrompt: 'Test agent with empty schema',
              inputSchema: {},
              outputMode: 'last_message',
              includeMessageHistory: true,
              inheritParentSystemPrompt: false,
              toolNames: ['end_turn'],
              spawnableAgents: [],
            },
          },
        }

        const result = validateAgents({
          agentTemplates: fileContext.agentTemplates || {},
          logger,
        })

        expect(result.validationErrors).toHaveLength(0)
        expect(result.templates).toHaveProperty('empty-schema-agent')

        // Empty schemas should have no prompt schema
        expect(
          result.templates['empty-schema-agent'].inputSchema.prompt,
        ).toBeUndefined()
      })
    })
  })

  describe('HandleSteps Parsing', () => {
    test('should validate agent config with handleSteps function', () => {
      const agentConfig = {
        id: 'test-agent',
        version: '1.0.0',
        displayName: 'Test Agent',
        spawnerPrompt: 'Testing handleSteps',
        model: 'claude-3-5-sonnet-20241022',
        outputMode: 'structured_output' as const,
        toolNames: ['set_output'],
        systemPrompt: 'You are a test agent',
        instructionsPrompt: 'Process: {prompt}',
        stepPrompt: 'Continue processing',
        handleSteps: function* ({
          agentState,
          prompt,
          params,
        }: {
          agentState: AgentState
          prompt?: string
          params?: any
        }) {
          yield {
            toolName: 'set_output',
            input: { message: 'Test completed' },
          }
        },
      }

      const result = DynamicAgentDefinitionSchema.safeParse(agentConfig)
      expect(result.success).toBe(true)

      if (result.success) {
        expect(typeof result.data.handleSteps).toBe('function')
      }
    })

    test('should convert handleSteps function to string', async () => {
      const handleStepsFunction = function* ({
        agentState,
        prompt,
        params,
      }: {
        agentState: AgentState
        prompt?: string
        params?: any
      }) {
        yield {
          toolName: 'set_output',
          input: { message: 'Hello from generator' },
        }
      }

      const agentTemplates = {
        'test-agent.ts': {
          ...mockAgentTemplate,
          handleSteps: handleStepsFunction.toString(),
        },
      }

      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates,
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates['test-agent']).toBeDefined()
      expect(typeof result.templates['test-agent'].handleSteps).toBe('string')
    })

    // Note: The validation that required set_output tool for structured_output mode was
    // intentionally disabled to allow handleSteps to use set_output while the LLM does not
    // have access to the set_output tool.
    test('should allow structured_output mode without set_output tool in toolNames', () => {
      const {
        DynamicAgentTemplateSchema,
      } = require('../types/dynamic-agent-template')

      const agentConfig = {
        id: 'test-agent',
        version: '1.0.0',
        displayName: 'Test Agent',
        spawnerPrompt: 'Testing',
        model: 'claude-3-5-sonnet-20241022',
        outputMode: 'structured_output' as const,
        systemPrompt: 'Test',
        instructionsPrompt: 'Test',
        stepPrompt: 'Test',
        toolNames: ['end_turn'], // Missing set_output - now allowed
        spawnableAgents: [],
        handleSteps:
          'function* () { yield { toolName: "set_output", input: {} } }',
      }

      const result = DynamicAgentTemplateSchema.safeParse(agentConfig)
      expect(result.success).toBe(true)
    })

    // Note: The validation that rejected set_output without structured_output mode was
    // intentionally disabled to allow parent agents to have set_output tool with 'last_message'
    // outputMode while their subagents use 'structured_output' (preserves prompt caching).
    test('should allow set_output tool without structured_output mode', () => {
      const {
        DynamicAgentTemplateSchema,
      } = require('../types/dynamic-agent-template')

      const agentConfig = {
        id: 'test-agent',
        version: '1.0.0',
        displayName: 'Test Agent',
        spawnerPrompt: 'Testing',
        model: 'claude-3-5-sonnet-20241022',
        outputMode: 'last_message' as const, // Not structured_output
        toolNames: ['end_turn', 'set_output'], // Has set_output - now allowed
        spawnableAgents: [],
        systemPrompt: 'Test',
        instructionsPrompt: 'Test',
        stepPrompt: 'Test',
      }

      const result = DynamicAgentTemplateSchema.safeParse(agentConfig)
      expect(result.success).toBe(true)
    })

    test('should validate that handleSteps is a generator function', async () => {
      const agentTemplates = {
        'test-agent.ts': {
          ...mockAgentTemplate,
          handleSteps: 'function () { return "not a generator" }', // Missing *
        },
      }

      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates,
      }

      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      expect(result.validationErrors.length).toBeGreaterThan(0)
      expect(result.validationErrors[0].message).toContain('generator function')
      expect(result.validationErrors[0].message).toContain('function*')
    })
    test('should verify loaded template handleSteps matches original function toString', async () => {
      // Create a generator function
      const originalFunction = function* ({
        agentState,
        prompt,
        params,
      }: {
        agentState: AgentState
        prompt?: string
        params?: any
      }) {
        yield {
          toolName: 'set_output',
          input: { message: 'Test output', data: params },
        }
      }

      // Get the string representation
      const expectedStringified = originalFunction.toString()

      // Create agent templates with the function
      const agentTemplates = {
        'test-agent.ts': {
          ...mockAgentTemplate,
          handleSteps: expectedStringified,
        },
      }

      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates,
      }

      // Load agents through the service
      const result = validateAgents({
        agentTemplates: fileContext.agentTemplates || {},
        logger,
      })

      // Verify no validation errors
      expect(result.validationErrors).toHaveLength(0)
      expect(result.templates['test-agent']).toBeDefined()

      // Verify the loaded template's handleSteps field matches the original toString
      expect(result.templates['test-agent'].handleSteps).toBe(
        expectedStringified,
      )
      expect(typeof result.templates['test-agent'].handleSteps).toBe('string')
    })
  })
})

// Crash-hardening coverage for the agent-template schema-member transport
// boundary (P2-T8 supervision bridge + bundled prebuilt agents). These
// members cross JSON.stringify in both directions and must survive as live
// zod schemas whose z.toJSONSchema does not throw — the empirical proxy for
// the AI SDK's asSchema compatibility.
describe('agent-template schema-member coercion (JSON spawn boundary)', () => {
  it('serializes a live zod member over the JSON boundary and coerces it back to a live zod schema', () => {
    const live = z.object({ name: z.string() })
    const transported = serializeSchemaMemberForTransport(live, 'input')
    // The transported form must be plain JSON (the spawn request file's wire
    // format): stringify → parse round-trips byte-identically.
    const json = JSON.parse(JSON.stringify(transported)) as unknown
    const coerced = coerceJsonSchemaMember(json)
    expect(typeof (coerced as { safeParse?: unknown }).safeParse).toBe(
      'function',
    )
    expect(
      (coerced as z.ZodType).safeParse({ name: 'x' }).success,
    ).toBe(true)
    expect(
      (coerced as z.ZodType).safeParse({ name: 42 }).success,
    ).toBe(false)
  })

  it('isDegradedZodHusk detects a ~standard-only husk and rejects plain JSON Schema', () => {
    // zod-v4's serialized wire form carries the ~standard interface marker
    // but no live internals (_zod/safeParse) — the crash shape for asSchema.
    expect(isDegradedZodHusk({ '~standard': { validate: () => {} } })).toBe(
      true,
    )
    // Plain JSON Schema never carries ~standard (it is not a JSON-Schema
    // keyword), so it must NOT be classified as a husk.
    expect(isDegradedZodHusk({ type: 'string' })).toBe(false)
    expect(isDegradedZodHusk({ type: 'object', properties: {} })).toBe(false)
    // A live zod member (real internals present) is not a husk either.
    expect(isDegradedZodHusk({ '~standard': {}, _zod: {} })).toBe(false)
    expect(
      isDegradedZodHusk({ '~standard': {}, safeParse: () => ({}) }),
    ).toBe(false)
    // Non-objects are never husks.
    expect(isDegradedZodHusk(null)).toBe(false)
    expect(isDegradedZodHusk('string')).toBe(false)
    expect(isDegradedZodHusk([])).toBe(false)
  })

  it('coerceJsonSchemaMember degrades an unrepresentable/degenerate {type:object} member to the native loose-object fallback', () => {
    const coerced = coerceJsonSchemaMember({ type: 'object' }) as z.ZodType
    // The result is a live zod schema regardless of the degenerate input.
    expect(typeof coerced.safeParse).toBe('function')
    // And it is REPRESENTABLE: z.toJSONSchema must not throw (asSchema's
    // exact crash condition).
    expect(() => z.toJSONSchema(coerced, { io: 'input' })).not.toThrow()
    // Loose object semantics: objectness is still enforced.
    expect(coerced.safeParse({ a: 1 }).success).toBe(true)
    expect(coerced.safeParse('not an object').success).toBe(false)
    // A husk input (zod's degraded wire form) also lands on a live,
    // representable result — it must never reach asSchema as a husk.
    const husk = {
      '~standard': { validate: () => undefined },
    } as unknown
    const huskCoerced = coerceJsonSchemaMember(husk) as z.ZodType
    expect(typeof huskCoerced.safeParse).toBe('function')
    expect(() =>
      z.toJSONSchema(huskCoerced, { io: 'input' }),
    ).not.toThrow()
  })

  it('serializeSchemaMemberForTransport falls back to {type:object} for a live member even unrepresentable-any cannot express', () => {
    // A _zod-marked fake satisfies isLiveZodSchema but z.toJSONSchema reads
    // its internals and throws — the last-resort branch of the serializer.
    const fake = { _zod: {}, safeParse: () => ({ success: true }) }
    const transported = serializeSchemaMemberForTransport(fake, 'input')
    expect(transported).toEqual({ type: 'object' })
    // The fallback must survive the JSON boundary it exists for.
    expect(() => JSON.stringify(transported)).not.toThrow()
    // And the child re-coercion lands on a live, representable zod schema.
    const coerced = coerceJsonSchemaMember(transported) as z.ZodType
    expect(typeof coerced.safeParse).toBe('function')
    expect(() => z.toJSONSchema(coerced, { io: 'input' })).not.toThrow()
  })

  it("degrades a live member whose 'any' emission is not round-trip coercible to {type:object}", () => {
    // z.never() is the verified degrade case: its 'any' emission fails the
    // serialize-side round-trip verification (the JSON round-tripped emission
    // does not re-convert to a schema that is representable under BOTH io
    // modes), so the serializer transports the permissive fallback instead of
    // an unverified emission the child could not coerce back to zod.
    expect(serializeSchemaMemberForTransport(z.never(), 'input')).toEqual({
      type: 'object',
    })
    // Contrast: formerly-gap shapes like z.record(z.string(), z.date()) and
    // z.map now emit degenerate-but-round-trippable schemas — the round-trip
    // verification PASSES for them, so they transport verbatim (with
    // structure) rather than collapsing to the fallback. Degrading them would
    // silently lose member-specific validation strictness.
    const record = z.record(z.string(), z.date()) as unknown
    const recordOut = serializeSchemaMemberForTransport(record, 'input') as {
      type?: string
      propertyNames?: unknown
    }
    expect(recordOut.type).toBe('object')
    expect(recordOut.propertyNames).toBeDefined()
    expect(recordOut).not.toEqual({ type: 'object' })
    const map = z.map(z.string(), z.string()) as unknown
    expect(
      serializeSchemaMemberForTransport(map, 'input'),
    ).not.toEqual({ type: 'object' })
    // The degraded form is the established fallback the child re-coerces
    // into a live, representable loose-object schema — the spawn survives.
    const fallback = coerceJsonSchemaMember({ type: 'object' }) as z.ZodType
    expect(typeof fallback.safeParse).toBe('function')
    expect(() => z.toJSONSchema(fallback, { io: 'input' })).not.toThrow()
  })

  it("keeps a representable live member's full structure", () => {
    const transported = serializeSchemaMemberForTransport(
      z.object({ name: z.string() }),
      'input',
    ) as { properties?: { name?: { type?: string } } }
    // Containment (not deep-equal): zod's exact emission details (required,
    // additionalProperties, ...) must not make this brittle — the point is
    // that a representable member does NOT degrade to { type: 'object' }.
    expect(transported.properties?.name?.type).toBe('string')
    expect(transported).not.toEqual({ type: 'object' })
  })

  it('isRepresentableZodSchema requires BOTH io modes to succeed', () => {
    // z.string().transform(...) is the canonical dual-mode divergence: the
    // input side is a plain string, but the output side is a Date, which zod
    // cannot represent in JSON Schema. The inline probes document the
    // divergence the assertion relies on — the AI SDK consumes coerced
    // members in both modes (tool inputSchema input-mode;
    // set_output/structuredOutput output-mode), so an input-only probe
    // would let this shape through and crash later in output mode.
    const transformSchema = z.string().transform((s) => new Date(s))
    expect(() =>
      z.toJSONSchema(transformSchema, { io: 'input' }),
    ).not.toThrow()
    expect(() => z.toJSONSchema(transformSchema, { io: 'output' })).toThrow()
    expect(isRepresentableZodSchema(transformSchema)).toBe(false)
    // A schema representable in both modes passes the probe.
    expect(isRepresentableZodSchema(z.object({ name: z.string() }))).toBe(
      true,
    )
    // z.map already throws in input mode, so the dual-mode probe rejects it
    // as well.
    expect(isRepresentableZodSchema(z.map(z.string(), z.string()))).toBe(
      false,
    )
  })
})
