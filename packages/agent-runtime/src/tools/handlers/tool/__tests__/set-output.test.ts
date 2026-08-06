import { describe, expect, test } from 'bun:test'
import z from 'zod/v4'

import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'

import { mockFileContext } from '../../../../__tests__/test-utils'
import { handleSetOutput } from '../set-output'

import type { AgentTemplate } from '../../../../templates/types'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'

describe('handleSetOutput', () => {
  test('returns a recoverable result without setting output for non-recoverable garbage JSON data', async () => {
    const template: AgentTemplate = {
      id: 'reviewer-test',
      displayName: 'Reviewer Test',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({ verdict: z.string() }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'incomplete-review-output',
      input: { data: '{"foo":' },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    expect(output).toEqual([
      {
        type: 'json',
        value: {
          message: expect.stringContaining('malformed or incomplete JSON text'),
        },
      },
    ])
  })

  test('accepts truncated stringified full reviewer receipt and sets output', async () => {
    const template: AgentTemplate = {
      id: 'code-reviewer',
      displayName: 'Code Reviewer',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({
        schemaVersion: z.number(),
        verdict: z.enum(['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING']),
        snapshotFingerprint: z.string(),
        reviewedFiles: z.array(z.string()),
        findings: z.array(z.string()),
        coverage: z.enum(['covered', 'missing', 'n/a']),
        dimensions: z.object({
          correctness: z.string(),
          security: z.string(),
          tests: z.string(),
          apiCompatibility: z.string(),
          performance: z.string(),
        }),
        requirementCoverage: z.array(
          z.object({
            requirement: z.string(),
            status: z.enum(['satisfied', 'missing', 'uncertain']),
            evidence: z.array(z.string()),
          }),
        ),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const truncated =
      '{"schemaVersion":1,"verdict":"LOOKS_GOOD","snapshotFingerprint":"v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6","reviewedFiles":["sdk/src/tools/terminal-command-policy.ts","sdk/src/__tests__/terminal-command-policy.test.ts"],"findings":[],"coverage":"covered","dimensions":{"correctness":"Single-evaluator policy with layered guards that go on forever without closing'
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'truncated-review-output',
      input: { data: truncated },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toMatchObject({
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint:
        'v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6',
      reviewedFiles: [
        'sdk/src/tools/terminal-command-policy.ts',
        'sdk/src/__tests__/terminal-command-policy.test.ts',
      ],
      findings: [],
      coverage: 'covered',
      requirementCoverage: [],
    })
    expect(agentState.output?.dimensions).toEqual({
      correctness: 'recovered-from-truncated-receipt',
      security: 'recovered-from-truncated-receipt',
      tests: 'recovered-from-truncated-receipt',
      apiCompatibility: 'recovered-from-truncated-receipt',
      performance: 'recovered-from-truncated-receipt',
    })
  })

  test('still fails closed for incomplete JSON that recovers only partial gate fields', async () => {
    const template: AgentTemplate = {
      id: 'reviewer-partial-test',
      displayName: 'Reviewer Partial Test',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({
        schemaVersion: z.number(),
        verdict: z.string(),
        snapshotFingerprint: z.string(),
        reviewedFiles: z.array(z.string()),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'partial-only-verdict',
      input: { data: '{"verdict":"LOOKS_GOOD"' },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    // Recovery may yield { verdict } so malformed-text is avoided; schema validation fails instead.
    expect(message).toContain('Output validation error')
    expect(message).not.toContain('malformed or incomplete JSON text')
  })

  test('normalizes individually stringified structured fields before validation', async () => {
    const template: AgentTemplate = {
      id: 'reviewer-normalization-test',
      displayName: 'Reviewer Normalization Test',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({
        schemaVersion: z.number(),
        verdict: z.enum(['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING']),
        snapshotFingerprint: z.string(),
        reviewedFiles: z.array(z.string()),
        findings: z.array(z.string()),
        coverage: z.enum(['covered', 'missing', 'n/a']),
        dimensions: z.object({ correctness: z.string() }),
        requirementCoverage: z.array(
          z.object({
            requirement: z.string(),
            status: z.enum(['satisfied', 'missing', 'uncertain']),
            evidence: z.array(z.string()),
          }),
        ),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'stringified-review-output',
      input: {
        schemaVersion: '1',
        verdict: 'NON_BLOCKING',
        snapshotFingerprint: 'v3:test',
        reviewedFiles: '["src/a.ts"]',
        findings: '["Minor documentation inconsistency"]',
        coverage: 'n/a',
        dimensions: '{"correctness":"pass"}',
        requirementCoverage:
          '[{"requirement":"Review files","status":"satisfied","evidence":["src/a.ts"]}]',
      },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({
      schemaVersion: 1,
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: 'v3:test',
      reviewedFiles: ['src/a.ts'],
      findings: ['Minor documentation inconsistency'],
      coverage: 'n/a',
      dimensions: { correctness: 'pass' },
      requirementCoverage: [
        {
          requirement: 'Review files',
          status: 'satisfied',
          evidence: ['src/a.ts'],
        },
      ],
    })
  })

  test('reports top-level field errors instead of an absent data-field error', async () => {
    const template: AgentTemplate = {
      id: 'reviewer-error-test',
      displayName: 'Reviewer Error Test',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({ reviewedFiles: z.array(z.string()) }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'invalid-review-output',
      input: { reviewedFiles: 'not-json' },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    expect(message).toContain('reviewedFiles')
    expect(message).not.toContain('found inside the `data` field')
    expect(agentState.output).toBeUndefined()
  })

  test('preserves JSON-looking text for fields whose schema expects prose', async () => {
    const template: AgentTemplate = {
      id: 'structured-prose-test',
      displayName: 'Structured Prose Test',
      spawnerPrompt: 'Return prose',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({ results: z.string() }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'json-looking-prose',
      input: { results: '{"example":true}' },
    } as unknown as CodebuffToolCall<'set_output'>

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toEqual({ results: '{"example":true}' })
  })

  test('keeps a valid reviewer schemaVersion string when the schema expects a string', async () => {
    const template: AgentTemplate = {
      id: 'string-version-reviewer',
      displayName: 'String Version Reviewer',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({ schemaVersion: z.string() }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'string-schema-version',
      input: { schemaVersion: '1' },
    } as unknown as CodebuffToolCall<'set_output'>

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toEqual({ schemaVersion: '1' })
  })

  test('recovers data-wrapped reviewer-family output for specialist agent ids', async () => {
    const template: AgentTemplate = {
      id: 'evaluator',
      displayName: 'Evaluator',
      spawnerPrompt: 'Evaluate changes',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({
        family: z.literal('reviewer'),
        schemaVersion: z.number(),
        reviewedFiles: z.array(z.string()),
        findings: z.array(z.string()),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'wrapped-specialist-review',
      input: {
        data: {
          family: 'reviewer',
          schemaVersion: '1',
          reviewedFiles: '["src/a.ts"]',
          findings: '[]',
        },
      },
    } as unknown as CodebuffToolCall<'set_output'>

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toEqual({
      family: 'reviewer',
      schemaVersion: 1,
      reviewedFiles: ['src/a.ts'],
      findings: [],
    })
  })

  test('recovers truncated non-reviewer output without injecting review-receipt keys', async () => {
    const template: AgentTemplate = {
      id: 'checkpoint-agent',
      displayName: 'Checkpoint Agent',
      spawnerPrompt: 'Check progress',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      // Strict schema: any injected reviewer-only dimensions/
      // requirementCoverage keys would fail validation as unrecognized keys.
      outputSchema: z.strictObject({
        schemaVersion: z.number(),
        verdict: z.string(),
        snapshotFingerprint: z.string(),
        reviewedFiles: z.array(z.string()),
        findings: z.array(z.string()),
        coverage: z.string(),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const truncated =
      '{"schemaVersion":1,"verdict":"approved","snapshotFingerprint":"v3:abc","reviewedFiles":["src/a.ts"],"findings":[],"coverage":"full","notes":"a truncated essay that never clo'
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'non-reviewer-strict-schema',
      input: { data: truncated },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({
      schemaVersion: 1,
      verdict: 'approved',
      snapshotFingerprint: 'v3:abc',
      reviewedFiles: ['src/a.ts'],
      findings: [],
      coverage: 'full',
    })
  })

  test('unwraps nested editor output envelope for schema validation', async () => {
    const template: AgentTemplate = {
      id: 'repair-editor',
      displayName: 'Repair Editor',
      spawnerPrompt: 'Repair findings',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema: z.object({
        status: z.enum(['completed', 'partial', 'blocked']),
        messages: z.array(z.any()),
        changedFiles: z.array(z.string()),
        requirementsAddressed: z.array(z.string()),
        acceptanceCriteriaAddressed: z.array(z.string()),
        findingsAddressed: z.array(z.string()),
        unresolved: z.array(z.string()),
        requestedValidation: z.array(z.string()),
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const inner = {
      status: 'blocked' as const,
      messages: [],
      changedFiles: [],
      requirementsAddressed: [],
      acceptanceCriteriaAddressed: [],
      findingsAddressed: [],
      unresolved: [],
      requestedValidation: [],
    }
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'nested-editor-output',
      input: { output: inner },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual(inner)
  })
})
