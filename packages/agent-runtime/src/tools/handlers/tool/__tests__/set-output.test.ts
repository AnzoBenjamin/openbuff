import { describe, expect, test } from 'bun:test'
import z from 'zod/v4'

import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'

import { mockFileContext } from '../../../../__tests__/test-utils'
import { buildChildAgentState } from '../../../../supervision/child-entry'
import {
  handleSetOutput,
  MAX_SET_OUTPUT_JSON_CHARS,
  RECEIPT_GUARD_ACK,
} from '../set-output'

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

  test('rejects an empty reviewer receipt from a supervised child', async () => {
    const template: AgentTemplate = {
      id: 'compatibility-reviewer',
      displayName: 'Compatibility Reviewer',
      spawnerPrompt: 'Review compatibility',
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
    const agentState = buildChildAgentState({
      agentType: template.id,
      prompt: 'Review the assigned file.',
      spawnParams: undefined,
      child: { agentId: 'supervised-reviewer-1' },
    })
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'empty-supervised-review-output',
      input: {},
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.agentType).toBe(template.id)
    expect(agentState.output).toBeUndefined()
    expect(output).toEqual([
      {
        type: 'json',
        value: { message: expect.stringContaining('verdict') },
      },
    ])
  })

  test('accepts truncated stringified full reviewer receipt and fail-closes to BLOCKING', async () => {
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
      verdict: 'BLOCKING',
      snapshotFingerprint:
        'v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6',
      reviewedFiles: [
        'sdk/src/tools/terminal-command-policy.ts',
        'sdk/src/__tests__/terminal-command-policy.test.ts',
      ],
      findings: [],
      coverage: 'covered',
      requirementCoverage: [
        {
          requirement: 'requirementCoverage',
          status: 'uncertain',
          evidence: ['recovered-from-truncated-receipt'],
        },
      ],
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

  test('records a schema-validation rejection on agentState.lastSetOutputError', async () => {
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
    expect(typeof agentState.lastSetOutputError).toBe('string')
    expect(agentState.lastSetOutputError).toContain('Output validation error')
    // The recorded error must be exactly the message handed back to the model,
    // so the loop's retry nudge and the tool result cannot drift apart.
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('clears lastSetOutputError once a later set_output succeeds', async () => {
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

    // Drive a rejecting call first so the error field is populated.
    const rejectingCall = {
      toolName: 'set_output',
      toolCallId: 'invalid-review-output',
      input: { reviewedFiles: 'not-json' },
    } as unknown as CodebuffToolCall<'set_output'>

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: rejectingCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.lastSetOutputError).toBeDefined()

    // A subsequent successful call on the SAME agentState must supersede the
    // earlier rejection: a stale rejection must never leak into a later
    // missing-output retry message.
    const validCall = {
      toolName: 'set_output',
      toolCallId: 'valid-review-output',
      input: { reviewedFiles: ['src/a.ts'] },
    } as unknown as CodebuffToolCall<'set_output'>

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: validCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.lastSetOutputError).toBeUndefined()
    expect(agentState.output).toEqual({ reviewedFiles: ['src/a.ts'] })
  })

  test('records a malformed-JSON rejection on agentState.lastSetOutputError', async () => {
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

    await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.lastSetOutputError).toContain(
      'malformed or incomplete JSON text',
    )
    expect(agentState.output).toBeUndefined()
  })

  // Shared minimal template for rejection-path tests: these payloads are
  // rejected before decoding, so the output schema shape is irrelevant.
  const rejectionTemplate = (id: string): AgentTemplate => ({
    id,
    displayName: 'Rejection Test',
    spawnerPrompt: 'Produce output',
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
  })

  test('fails closed when the declared agent type has no resolvable template', async () => {
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    // Truthy agentType with NO resolvable template (no local template matches
    // and the runtime's fetchAgentFromDatabase returns null): the output schema
    // is unknown, so the payload must NOT be stored unvalidated.
    agentState.agentType = 'unregistered-agent-template'
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'unresolvable-template-set-output',
      input: { message: 'must not be stored without a schema' },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: {},
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    expect(message).toContain('could not be resolved')
    expect(message).toContain('NOT stored')
    // Recorded so the loop's missing-output retry can surface it, exactly like
    // the sibling rejection paths.
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('keeps passthrough when the resolved template declares no outputSchema', async () => {
    const template: AgentTemplate = {
      ...rejectionTemplate('passthrough-no-schema-agent'),
      outputSchema: undefined,
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'passthrough-no-schema-set-output',
      input: { message: 'legitimate passthrough' },
    } as unknown as CodebuffToolCall<'set_output'>

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    // A RESOLVED template without an outputSchema is legitimate: passthrough
    // stays exactly as before (this is not the fail-closed case).
    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({ message: 'legitimate passthrough' })
    expect(agentState.lastSetOutputError).toBeUndefined()
  })

  test('rejects an oversized string data payload before decoding with explicit split guidance', async () => {
    const template = rejectionTemplate('reviewer-oversized-test')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const oversized = 'x'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'oversized-set-output',
      input: { data: oversized },
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
    // The limit and the actual length must both be explicit.
    expect(message).toContain(String(MAX_SET_OUTPUT_JSON_CHARS))
    expect(message).toContain(String(oversized.length))
    // Recovery guidance: chunk into smaller calls or persist to a file.
    expect(message).toContain('split')
    expect(message).toContain('file')
    expect(typeof agentState.lastSetOutputError).toBe('string')
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('reports likely transport truncation when malformed JSON ends mid-structure', async () => {
    const template = rejectionTemplate('reviewer-truncation-test')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'transport-truncated-set-output',
      input: { data: '{"a": {"b": [1,2' },
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
    expect(message).toContain('truncated in transport')
    expect(message).toContain('split')
    expect(typeof agentState.lastSetOutputError).toBe('string')
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('keeps the plain malformed-JSON wording for a non-truncated garbage string', async () => {
    const template = rejectionTemplate('reviewer-garbage-test')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'garbage-string-set-output',
      input: { data: 'not json' },
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
    expect(message).toContain('malformed or incomplete JSON text')
    // 'not json' ends outside any structure: no truncation claim.
    expect(message).not.toContain('truncated')
    expect(typeof agentState.lastSetOutputError).toBe('string')
    expect(agentState.lastSetOutputError).toBe(message)
  })

  describe('jsonKey envelope handling', () => {
    const reviewTemplate = (id: string): AgentTemplate => ({
      id,
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
      }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    })

    const validReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:review-test-fingerprint',
      reviewedFiles: ['packages/agent-runtime/src/tools/handlers/tool/set-output.ts'],
      findings: [],
      coverage: 'covered',
    }

    const setupEnvelopeState = async (
      id: string,
      input: Record<string, unknown>,
    ) => {
      const template = reviewTemplate(id)
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = id
      const toolCall = {
        toolName: 'set_output',
        toolCallId: `jsonKey-envelope-${id}`,
        input,
      } as unknown as CodebuffToolCall<'set_output'>
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])
      return { agentState, output }
    }

    test('sets agentState.output from a stringified receipt inside a jsonKey envelope', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-reviewer',
        { jsonKey: 'output', value: JSON.stringify(validReceipt) },
      )

      expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('sets agentState.output from a native receipt object inside a jsonKey envelope', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-native-reviewer',
        { jsonKey: 'output', value: validReceipt },
      )

      expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('does not set agentState.output when the jsonKey envelope contains malformed JSON', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-bad-reviewer',
        { jsonKey: 'output', value: '{"verdict":"LOOKS_GOOD",' },
      )

      expect(agentState.output).toBeUndefined()
      expect(typeof agentState.lastSetOutputError).toBe('string')
      const message =
        output[0]?.type === 'json' ? output[0].value.message : ''
      expect(message).toContain('Output validation error')
    })

    test('accepts a native non-envelope reviewer object exactly like before', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-non-envelope-reviewer',
        validReceipt,
      )

      expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('sets agentState.output from a receipt under ANY envelope key name (e.g. jsonValue)', async () => {
      // Content-addressed recovery does not key on the field name: the same
      // receipt under `jsonValue` (or any other invented label) must settle
      // identically — models keep inventing new envelope names.
      const { agentState, output } = await setupEnvelopeState(
        'jsonValue-envelope-reviewer',
        { jsonValue: JSON.stringify(validReceipt) },
      )

      expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('sets agentState.output from a receipt under a wholly arbitrary envelope key name', async () => {
      // Another invented label: the unwrap keys on CONTENT (verdict +
      // snapshotFingerprint), never on the field name.
      const { agentState, output } = await setupEnvelopeState(
        'arbitrary-envelope-reviewer',
        { someRandomKey: JSON.stringify(validReceipt) },
      )

      expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('leaves an envelope whose string decodes to a NON-receipt object untouched (schema validation paths)', async () => {
      // A plain `{ message: 'hello' }` must NOT be promoted; the existing
      // no-schema path decides what to do with it, as before.
      const { agentState, output } = await setupEnvelopeState(
        'non-receipt-envelope-reviewer',
        { jsonKey: 'greeting', value: JSON.stringify({ message: 'hello' }) },
      )

      // The keyless envelope is NOT a receipt: it falls through to the
      // schema-validation path, which will fail (the review schema does not
      // accept {jsonKey,value}), leaving lastSetOutputError set and
      // agentState.output undefined — the ORIGINAL behavior for a
      // non-envelope payload.
      expect(agentState.output).toBeUndefined()
      expect(typeof agentState.lastSetOutputError).toBe('string')
      const message =
        output[0]?.type === 'json' ? output[0].value.message : ''
      expect(message).toContain('Output validation error')
    })
  })

  describe('receipt-overwrite guard', () => {
    const reviewTemplate = (
      id: string,
      outputSchema?: AgentTemplate['outputSchema'],
    ): AgentTemplate => ({
      id,
      displayName: 'Receipt Guard Reviewer',
      spawnerPrompt: 'Review code',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      outputSchema:
        outputSchema ??
        z.object({
          schemaVersion: z.number(),
          verdict: z.enum(['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING']),
          snapshotFingerprint: z.string(),
          reviewedFiles: z.array(z.string()),
          findings: z.array(z.string()),
          coverage: z.enum(['covered', 'missing', 'n/a']),
        }),
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
    })

    const validReceipt = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:guard-test-fingerprint',
      reviewedFiles: ['packages/agent-runtime/src/tools/handlers/tool/set-output.ts'],
      findings: [],
      coverage: 'covered',
    }

    const makeCall = (
      id: string,
      input: Record<string, unknown>,
    ): CodebuffToolCall<'set_output'> =>
      ({
        toolName: 'set_output',
        toolCallId: `guard-${id}`,
        input,
      }) as unknown as CodebuffToolCall<'set_output'>

    const callSetOutput = async (
      id: string,
      agentState: ReturnType<
        typeof getInitialSessionState
      >['mainAgentState'],
      input: Record<string, unknown>,
      outputSchema?: AgentTemplate['outputSchema'],
    ) => {
      const template = reviewTemplate(id, outputSchema)
      return await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: makeCall(id, input),
        agentState,
        apiKey: 'test-api-key',
        // Register the template under BOTH the call id and the agent state's
        // declared agentType: set_output now fails closed when a truthy
        // agentType cannot be resolved, and these cases intentionally vary the
        // call id while reusing one agentState.
        localAgentTemplates: {
          [template.id]: template,
          ...(agentState.agentType ? { [agentState.agentType]: template } : {}),
        },
      } as unknown as Parameters<typeof handleSetOutput>[0])
    }

    test('ignores a degenerate ACK-echo retry after a valid receipt was published', async () => {
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = 'receipt-guard-reviewer'

      const first = await callSetOutput(
        'receipt-guard-reviewer',
        agentState,
        validReceipt,
      )
      expect(first.output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual(validReceipt)

      // Degenerate retry: the model echoes the tool ACK back as a payload.
      const second = await callSetOutput(
        'receipt-guard-reviewer-echo',
        agentState,
        { message: 'Output set' },
      )

      // Output must still be the ORIGINAL receipt, unchanged.
      expect(agentState.output).toEqual(validReceipt)
      // Guard ack (not the plain 'Output set') so the model learns why.
      expect(second.output).toEqual([
        { type: 'json', value: { message: RECEIPT_GUARD_ACK } },
      ])
      // A repeated bogus call must not resurrect a stale error.
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('still replaces the receipt when a corrected FULL receipt is emitted', async () => {
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = 'receipt-guard-correction-reviewer'

      await callSetOutput(
        'receipt-guard-correction-reviewer',
        agentState,
        validReceipt,
      )

      const correctedReceipt = {
        ...validReceipt,
        verdict: 'NON_BLOCKING',
        findings: ['Minor doc inconsistency'],
      }
      const second = await callSetOutput(
        'receipt-guard-correction-reviewer-replacement',
        agentState,
        correctedReceipt,
      )

      expect(second.output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual(correctedReceipt)
      expect(
        (agentState.output as Record<string, unknown>).verdict,
      ).toBe('NON_BLOCKING')
    })

    test('keeps replace-always behavior for a non-reviewer agent', async () => {
      const plainSchema = z.object({ note: z.string() })
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = 'receipt-guard-plain-agent'

      await callSetOutput(
        'receipt-guard-plain-agent',
        agentState,
        { note: 'output A' },
        plainSchema,
      )
      expect(agentState.output).toEqual({ note: 'output A' })

      const second = await callSetOutput(
        'receipt-guard-plain-agent-replacement',
        agentState,
        { note: 'output B' },
        plainSchema,
      )

      expect(second.output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      // B replaces A: no receipt guard on non-reviewer agents.
      expect(agentState.output).toEqual({ note: 'output B' })
    })

    test('Phase 1 intact: first-call jsonKey envelope with stringified receipt still sets output', async () => {
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = 'receipt-guard-envelope-reviewer'

      const { output } = await callSetOutput(
        'receipt-guard-envelope-reviewer',
        agentState,
        { jsonKey: 'output', value: JSON.stringify(validReceipt) },
      )

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })
  })
})

describe('handleSetOutput enum-prose repair', () => {
  const enumTemplate = (
    outputSchema: z.ZodTypeAny,
    id = 'enum-prose-reviewer',
  ): AgentTemplate => ({
    id,
    displayName: 'Enum Prose Reviewer',
    spawnerPrompt: 'Review',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    outputSchema,
    includeMessageHistory: false,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['set_output'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  })

  const runHandler = async (template: AgentTemplate, data: unknown) => {
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const toolCall = {
      toolName: 'set_output',
      toolCallId: 'enum-prose-receipt',
      input: { data: JSON.stringify(data) },
    } as unknown as CodebuffToolCall<'set_output'>
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])
    return { output, agentState }
  }

  test('repairs an enum field whose value carries justification prose', async () => {
    // The dominant observed failure: the model submits "pass: <prose>" where
    // the schema wants the BARE enum. The repair strips to the bare value and
    // accepts the receipt instead of burning a retry turn.
    const template = enumTemplate(
      z.object({
        dimensions: z.object({
          correctness: z.enum(['pass', 'warning', 'block', 'not_applicable']),
        }),
        evidence: z.array(z.string()).optional(),
      }),
    )
    const { agentState, output } = await runHandler(template, {
      dimensions: {
        correctness: 'pass: no logic errors found in the diff under review',
      },
      evidence: ['src/a.ts:10'],
    })

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({
      dimensions: { correctness: 'pass' },
      evidence: ['src/a.ts:10'],
    })
  })

  test('leaves a bare valid enum untouched and accepts it directly', async () => {
    const template = enumTemplate(
      z.object({ verdict: z.enum(['pass', 'block']) }),
    )
    const { agentState, output } = await runHandler(template, {
      verdict: 'pass',
    })

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({ verdict: 'pass' })
  })

  test('still fails, with the bare-value hint, when the value matches no allowed enum', async () => {
    const template = enumTemplate(
      z.object({ verdict: z.enum(['pass', 'block']) }),
    )
    const { agentState, output } = await runHandler(template, {
      verdict: 'everything looks fine to me',
    })

    expect(agentState.output).toBeUndefined()
    const message = (output as Array<{ type: string; value: { message: string } }>)[0]
      .value.message
    expect(message).toContain('Output validation error')
    expect(message).toContain('BARE value only')
  })

  test('repair keeps nested paths intact and does not mutate the original object', async () => {
    const template = enumTemplate(
      z.object({
        coverage: z.object({
          dimensions: z.object({
            risk: z.enum(['pass', 'warning', 'block']),
          }),
        }),
      }),
    )
    const submitted = {
      coverage: { dimensions: { risk: 'warning — thin evidence for claim 2' } },
    }
    const { agentState, output } = await runHandler(template, submitted)

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({
      coverage: { dimensions: { risk: 'warning' } },
    })
    // The caller's object is untouched: repair works on a clone.
    expect(submitted.coverage.dimensions.risk).toBe(
      'warning — thin evidence for claim 2',
    )
  })
})
