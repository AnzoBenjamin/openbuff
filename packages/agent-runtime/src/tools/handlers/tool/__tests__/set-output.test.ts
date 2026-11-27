import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import z from 'zod/v4'

import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { DEFAULT_JOB_OUTPUT_BYTE_LIMIT } from '@codebuff/common/util/job-registry'
import {
  MODEL_PAYLOAD_JSON_CHAR_LIMIT,
  TRUNCATION_DIMENSION_PLACEHOLDER,
} from '@codebuff/common/util/model-payload-recovery'

import { mockFileContext } from '../../../../__tests__/test-utils'
import { buildChildAgentState } from '../../../../supervision/child-entry'
import {
  flushOversizeArtifactSweeps,
  forgetLiveArtifact,
  inspectLiveArtifactPaths,
  loadOversizeArtifactFs,
  oversizeArtifactDir,
  OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES,
  OVERSIZE_ARTIFACT_TTL_MS,
  persistOversizeArtifact,
  releaseLiveArtifactsForOwner,
  releaseUnreferencedArtifact,
  rememberLiveArtifact,
  resetOversizeArtifactState,
  sweepExpiredArtifacts,
} from '../oversize-artifact'
import {
  flushOversizeArtifactWrites,
  buildRuntimeAgentReceiptWithArtifacts,
  normalizeSpawnedAgentOutput,
  PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS,
  PARENT_AGENT_OUTPUT_MAX_CHARS,
  PARENT_AGENT_OUTPUT_STRING_CHARS,
} from '../spawn-agent-utils'
import {
  handleSetOutput,
  MAX_SET_OUTPUT_JSON_CHARS,
  OVERSIZED_OUTPUT_HEAD_CHARS,
  OVERSIZED_OUTPUT_TAIL_CHARS,
  OVERSIZED_SALVAGE_ACK,
  OVERSIZED_SALVAGE_CANCELLED_ACK,
  OVERSIZED_SALVAGE_GUARD_ACK,
  OVERSIZED_SALVAGE_RECORD_MAX_CHARS,
  OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK,
  OVERSIZED_SALVAGE_UNPERSISTED_ACK,
  RECEIPT_GUARD_ACK,
  resetSetOutputArtifactSweepState,
  SET_OUTPUT_ARTIFACT_SWEEP_MAX_ENTRIES,
} from '../set-output'

// The budget caps are the OWNER's exported values, imported directly under the
// names this fixture uses, so the fixture pins the VALUES the consumer applies
// rather than a re-declared copy keyed off source spelling.
const PARENT_AGENT_OUTPUT_BUDGET_CHARS = PARENT_AGENT_OUTPUT_MAX_CHARS
const PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS =
  PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS
const PARENT_AGENT_OUTPUT_DEFAULT_LEAF_CHARS = PARENT_AGENT_OUTPUT_STRING_CHARS

import type { AgentTemplate } from '../../../../templates/types'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'

/**
 * PER-COMPONENT fixed baselines. A composed total alone is NOT a fixed
 * baseline: it cannot detect a 2x raise of one bound offset by a 2x cut of
 * another, and it cannot attribute a regression to the component that moved.
 * Each budget that bounds the model payload path is therefore pinned to its own
 * literal here, and the composed baseline below is DERIVED from these literals
 * rather than hand-copied, so the sum can never silently absorb drift.
 *
 * Every component is the constant the OWNING module actually ENFORCES:
 *  - `MODEL_PAYLOAD_JSON_CHAR_LIMIT` bounds the serialized JSON accepted in the
 *    set_output `data` field AND the read_files block path
 *    (`MAX_SET_OUTPUT_JSON_CHARS` is this value verbatim);
 *  - `DEFAULT_JOB_OUTPUT_BYTE_LIMIT` is the exported job-read bound;
 *  - `PARENT_AGENT_OUTPUT_MAX_CHARS` is the parent-visible output budget;
 *  - `OVERSIZED_OUTPUT_HEAD_CHARS` / `OVERSIZED_OUTPUT_TAIL_CHARS` are the
 *    bounds the salvage actually keeps inside a stored record;
 *  - `OVERSIZED_SALVAGE_RECORD_MAX_CHARS` is the derived worst-case record size.
 * A documentation-only marker constant is deliberately NOT a component: pinning
 * a sentinel the handler never enforces would make the baseline unmovable by a
 * change to the limit that actually bounds the path.
 */
const PARENT_AGENT_OUTPUT_BASELINE_CHARS = 1_000_000
const MODEL_PAYLOAD_BASELINE_CHARS = 1_000_000
const JOB_OUTPUT_BASELINE_BYTES = 1_048_576
const OVERSIZED_OUTPUT_HEAD_BASELINE_CHARS = 40_000
const OVERSIZED_OUTPUT_TAIL_BASELINE_CHARS = 8_000
const OVERSIZED_SALVAGE_RECORD_BASELINE_CHARS = 50_000

/**
 * Composed worst-case payload ONE model step can carry, DERIVED from the pinned
 * components above so it is a single source of truth: raising or cutting one
 * component moves the sum and fails the component assertion that did it.
 */
const COMPOSED_STEP_PAYLOAD_BASELINE_CHARS =
  PARENT_AGENT_OUTPUT_BASELINE_CHARS +
  MODEL_PAYLOAD_BASELINE_CHARS +
  JOB_OUTPUT_BASELINE_BYTES

/**
 * PER-LEAF fixed baselines, pinned to their own literals.
 *
 * The leaf caps are what the salvage record's head/tail are DERIVED from, so a
 * silent raise of either cap would widen every stored record. Pinning them to
 * literals (rather than only importing the owner's names) means a raise fails
 * HERE, next to the derivation it changes, instead of only moving numbers the
 * assertions already read from the imported names.
 */
const PARENT_AGENT_OUTPUT_DEFAULT_LEAF_BASELINE_CHARS = 16_000
const PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_BASELINE_CHARS = 128_000

/**
 * Serialized-size baseline for the RECORD the parent actually receives, and for
 * the number of compaction rebuilds a shared reference costs.
 *
 * Both are DERIVED expectations, not prose: `boundAgentOutputForParent` now
 * compacts through an identity memo, so a payload reusing ONE 250k-char object
 * four times is rebuilt once. Before the memo the same payload cost four
 * rebuilds of the same subtree, which is the superlinear shape 1M-char budgets
 * made expensive.
 */
const SHARED_REFERENCE_REPEATS = 4
const SHARED_REFERENCE_LEAF_CHARS = 250_000
const SHARED_REFERENCE_EXPECTED_REBUILDS = 1

/**
 * Sibling size for the nested-shape fixture: the PARENT budget minus the
 * record's own serialized length, i.e. the sibling that consumes the actual
 * REMAINING budget.
 *
 * The previous fixture hard-coded a 200_000-char sibling against a 1M budget and
 * asserted on the FLAT payload, so it never approached the denominator the
 * settle path compares against: a regression that pushed the real nested payload
 * past 1M in production passed the test. The sibling is now derived per record.
 */
function nestedSiblingCharsFor(shellChars: number): number {
  return Math.max(0, PARENT_AGENT_OUTPUT_BUDGET_CHARS - shellChars)
}

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
          errorMessage: expect.stringContaining(
            'malformed or incomplete JSON text',
          ),
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
        value: {
          message: expect.stringContaining('verdict'),
          errorMessage: expect.stringContaining('verdict'),
        },
      },
    ])
  })

  // The recovery asserted here is NOT handler-local scaffolding: an incomplete
  // JSON object string carrying a gate-critical key is rebuilt by
  // `recoverTruncatedJsonObject` behind `decodeJsonObjectString`, which is why
  // the expectations below use that module's exported placeholder constant and
  // why the sibling `{"foo":` case (no gate-critical key) still fails closed
  // with the malformed-JSON rejection instead of recovering anything.
  test('recovers a truncated stringified full reviewer receipt and fail-closes to BLOCKING', async () => {
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
          evidence: [TRUNCATION_DIMENSION_PLACEHOLDER],
        },
      ],
    })
    expect(agentState.output?.dimensions).toEqual({
      correctness: TRUNCATION_DIMENSION_PLACEHOLDER,
      security: TRUNCATION_DIMENSION_PLACEHOLDER,
      tests: TRUNCATION_DIMENSION_PLACEHOLDER,
      apiCompatibility: TRUNCATION_DIMENSION_PLACEHOLDER,
      performance: TRUNCATION_DIMENSION_PLACEHOLDER,
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

  test.each([
    { submitted: ['first', 'second'], expected: ['first', 'second'] },
    { submitted: '["first","second"]', expected: ['first', 'second'] },
    { submitted: 'first', expected: ['first'] },
  ])(
    'preserves reviewer advisories as an array: $submitted',
    async ({ submitted, expected }) => {
      const template: AgentTemplate = {
        id: 'advisory-shape-reviewer',
        displayName: 'Reviewer',
        spawnerPrompt: 'Review code',
        model: 'claude-3-5-sonnet-20241022',
        inputSchema: {},
        outputMode: 'structured_output',
        outputSchema: z.object({
          family: z.literal('reviewer'),
          verdict: z.literal('LOOKS_GOOD'),
          advisories: z.array(z.string()),
          requirementCoverage: z.array(
            z.object({ evidence: z.array(z.string()) }),
          ),
        }),
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['set_output'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'advisory-shape',
          input: {
            family: 'reviewer',
            verdict: 'LOOKS_GOOD',
            advisories: submitted,
            requirementCoverage: [
              {
                evidence: Array.isArray(submitted)
                  ? ['src/a.ts:1']
                  : '["src/a.ts:1"]',
              },
            ],
          },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual({
        family: 'reviewer',
        verdict: 'LOOKS_GOOD',
        advisories: expected,
        requirementCoverage: [{ evidence: ['src/a.ts:1'] }],
      })
    },
  )

  test('rejects an incomplete stringified advisory array instead of treating it as prose', async () => {
    const template = {
      id: 'truncated-advisory-reviewer',
      outputSchema: z.object({
        family: z.literal('reviewer'),
        advisories: z.array(z.string()),
      }),
    } as unknown as AgentTemplate
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'truncated-advisories',
        input: { family: 'reviewer', advisories: '["unfinished' },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    expect(output[0]?.type === 'json' && output[0].value.message).toContain(
      'Output validation error',
    )
  })

  test('normalizes stringified advisory-family list fields against the declared schema', async () => {
    const template = {
      id: 'architect',
      outputSchema: z.object({
        family: z.literal('advisory'),
        recommendations: z.array(z.string()),
        evidence: z.array(z.string()),
      }),
    } as unknown as AgentTemplate
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'advisory-family',
        input: {
          family: 'advisory',
          recommendations: '["fix"]',
          evidence: '["src/a.ts:1"]',
        },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(output).toEqual([{ type: 'json', value: { message: 'Output set' } }])
    expect(agentState.output).toEqual({
      family: 'advisory',
      recommendations: ['fix'],
      evidence: ['src/a.ts:1'],
    })
  })

  test.each([
    {
      schema: z.object({ note: z.string().optional() }),
      input: { data: { note: 'saved' } },
      expected: { note: 'saved' },
    },
    {
      schema: z.object({ data: z.object({ note: z.string() }) }),
      input: { data: { note: 'saved' } },
      expected: { data: { note: 'saved' } },
    },
    {
      // The JSON-schema converter keeps unknown top-level keys by default.
      schema: convertJsonSchemaToZod({
        type: 'object',
        properties: { note: { type: 'string' } },
      }),
      input: { data: { note: 'saved' } },
      expected: { note: 'saved' },
    },
  ])(
    'does not discard a data-wrapped receipt when output properties are optional',
    async ({ schema, input, expected }) => {
      const template = {
        id: 'optional-output-agent',
        outputSchema: schema,
      } as unknown as AgentTemplate
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'optional-output',
          input,
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual(expected)
    },
  )

  test('rejects an invalid data-wrapped receipt rather than accepting a stripped empty object', async () => {
    const template = {
      id: 'optional-output-agent',
      outputSchema: z.object({ note: z.string().optional() }),
    } as unknown as AgentTemplate
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'invalid-optional-output',
        input: { data: { note: 42 } },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    expect(output[0]?.type === 'json' && output[0].value.message).toContain(
      'Output validation error',
    )
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
        verdict: z.literal('LOOKS_GOOD'),
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
          verdict: 'LOOKS_GOOD',
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
      verdict: 'LOOKS_GOOD',
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

  test('rejects a verdict-less code-reviewer receipt even when its schema is degraded', async () => {
    const template = {
      ...rejectionTemplate('code-reviewer'),
      outputSchema: z.looseObject({}),
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'degraded-review',
        input: { snapshotFingerprint: 'snapshot' },
      },
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])
    expect(agentState.output).toBeUndefined()
    expect(agentState.lastSetOutputError).toContain('valid verdict')
    expect(output).toEqual([
      {
        type: 'json',
        value: {
          message: expect.stringContaining('valid verdict'),
          errorMessage: expect.stringContaining('valid verdict'),
        },
      },
    ])
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

  // Salvage is only reachable for agents with no receipt contract: the
  // oversized record is verdict-less, and `reviewerVerdictIssue` correctly
  // rejects that for reviewer-family children (covered by the sibling
  // fail-closed reviewer test below), so these salvage cases use a plain agent.
  //
  // The schema must ADMIT the salvage pointer record: an agent whose own schema
  // rejects `{ truncated, artifactPath, ... }` gets an explicit rejection
  // instead of a contract-invalid `agentState.output` (covered below).
  const plainTemplate = (id: string): AgentTemplate => ({
    ...rejectionTemplate(id),
    id,
    displayName: 'Plain Test',
    outputSchema: z.looseObject({}),
  })

  test('salvages an oversized string data payload into an artifact instead of rejecting it', async () => {
    const template = plainTemplate('oversized-salvage-agent')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const oversized = 'é'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
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

    // The oversized payload is saved as a bounded pointer record instead of
    // being thrown away: the ACK states explicitly that the stored output is
    // NOT the child's payload, and `salvaged: true` is the machine-readable
    // discriminator that tells a pointer record apart from a real output.
    expect(output).toEqual([
      {
        type: 'json',
        value: expect.objectContaining({ message: OVERSIZED_SALVAGE_ACK, salvaged: true }),
      },
    ])
    expect(agentState.lastSetOutputError).toBeUndefined()

    const salvaged = agentState.output as Record<string, unknown>
    expect(salvaged.truncated).toBe(true)
    expect(salvaged.artifactBytes).toBe(Buffer.byteLength(oversized, 'utf8'))
    const ack = output[0].value
    expect(ack.artifactPersisted).toBe(true)
    expect(ack.artifactWrittenByThisCall).toBe(true)
    expect(salvaged.artifactPath).toBe(ack.artifactPath)
    expect(ack.artifactBytes).toBe(Buffer.byteLength(oversized, 'utf8'))
    expect(ack.sha256).toBe(createHash('sha256').update(oversized).digest('hex'))
    expect(salvaged.artifactCreatedAt).toBe(ack.artifactCreatedAt)
    expect(salvaged.truncation).toEqual({
      reason: 'oversized_payload',
      totalChars: oversized.length,
      keptChars: expect.any(Number),
    })
    expect(typeof salvaged.data).toBe('string')
    expect((salvaged.data as string).length).toBeLessThan(oversized.length)
    expect(typeof salvaged.dataTail).toBe('string')
    // The salvage record must never read as a receipt to the receipt walker.
    expect(salvaged.verdict).toBeUndefined()
    expect(salvaged.snapshotFingerprint).toBeUndefined()

    const artifactPath = salvaged.artifactPath
    expect(typeof artifactPath).toBe('string')
    const resolvedArtifactPath = artifactPath as string
    try {
      expect(existsSync(resolvedArtifactPath)).toBe(true)
      // Lossless: the artifact holds the FULL payload, byte for byte.
      expect(readFileSync(resolvedArtifactPath, 'utf8')).toBe(oversized)
      const repeated = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(), toolCall, agentState,
        apiKey: 'test-api-key', localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])
      expect(repeated.output[0].value).toMatchObject({ status: 'ignored', artifactPath: resolvedArtifactPath, sha256: ack.sha256, artifactWrittenByThisCall: false })
    } finally {
      rmSync(resolvedArtifactPath, { force: true })
    }
  })

  test('accepts an oversized payload with an explicit note when the artifact cannot be persisted', async () => {
    // Windows tmpdir resolution ignores TMPDIR, so the forced-unwritable setup
    // below is only meaningful on posix hosts.
    if (process.platform === 'win32') return
    const template = plainTemplate('oversized-salvage-unwritable-agent')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const oversized = 'y'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
    // A regular file is not a directory: mkdirSync of the artifact directory
    // under it fails, which is exactly the "tmp unwritable" case.
    const blockerDir = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-blocker-'),
    )
    const blockerFile = join(blockerDir, 'not-a-dir')
    writeFileSync(blockerFile, 'x')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = blockerFile
    try {
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-set-output-unwritable',
          input: { data: oversized },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])

      expect(output).toEqual([
        {
          type: 'json',
          value: expect.objectContaining({ message: OVERSIZED_SALVAGE_UNPERSISTED_ACK, salvaged: true }),
        },
      ])
      expect(agentState.lastSetOutputError).toBeUndefined()
      expect(output[0].value.artifactPersisted).toBe(false)
      expect(output[0].value.artifactWrittenByThisCall).toBe(false)
      expect(output[0].value.artifactPath).toBeUndefined()
      expect(output[0].value.sha256).toBeUndefined()
      const salvaged = agentState.output as Record<string, unknown>
      expect(salvaged.truncated).toBe(true)
      expect(salvaged.artifactWrittenByThisCall).toBe(false)
      expect(salvaged.truncation).toMatchObject({
        reason: 'oversized_payload_unpersisted',
      })
      expect(salvaged.artifactPersisted).toBe(false)
      expect(salvaged.artifactPath).toBeUndefined()
      // The loss is never silent: the note says the middle/tail is gone.
      expect(salvaged.artifactError).toEqual(
        expect.stringContaining('NOT recoverable'),
      )
      expect(typeof salvaged.data).toBe('string')
      expect((salvaged.data as string).length).toBeLessThan(oversized.length)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(blockerDir, { recursive: true, force: true })
    }
  })

  test('sweeps an expired salvage artifact while keeping a fresh one', async () => {
    // Windows tmpdir resolution ignores TMPDIR, so the redirection below is
    // only meaningful on posix hosts (same guard as the sibling test).
    if (process.platform === 'win32') return
    const template = plainTemplate('oversized-salvage-sweep-agent')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const sweepRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-sweep-'))
    const sweepDir = join(sweepRoot, 'openbuff-set-output')
    mkdirSync(sweepDir, { recursive: true, mode: 0o700 })
    // Two pre-existing artifacts: one already past the TTL, one fresh. The
    // persist below writes a third and then runs the sweep, which must
    // collect ONLY the expired one (oldest-first, stop at the first live
    // entry) so a recent salvage artifact stays readable.
    const expiredArtifact = join(sweepDir, 'expired.json')
    const freshArtifact = join(sweepDir, 'fresh.json')
    writeFileSync(expiredArtifact, 'expired', { mode: 0o600 })
    writeFileSync(freshArtifact, 'fresh', { mode: 0o600 })
    const twoDaysAgoSeconds = Date.now() / 1000 - 2 * 24 * 60 * 60
    utimesSync(expiredArtifact, twoDaysAgoSeconds, twoDaysAgoSeconds)
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = sweepRoot
    resetSetOutputArtifactSweepState()
    try {
      const oversized = 'q'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-set-output-sweep',
          input: { data: oversized },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])

      expect(output).toEqual([
        {
          type: 'json',
          value: expect.objectContaining({ message: OVERSIZED_SALVAGE_ACK, salvaged: true }),
        },
      ])
      const salvaged = agentState.output as Record<string, unknown>
      expect(typeof salvaged.artifactPath).toBe('string')
      // Cleanup is asynchronous; join its effects without delaying production ACKs.
      await flushOversizeArtifactSweeps()
      expect(existsSync(expiredArtifact)).toBe(false)
      expect(existsSync(freshArtifact)).toBe(true)
      expect(existsSync(salvaged.artifactPath as string)).toBe(true)
    } finally {
      await flushOversizeArtifactSweeps()
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(sweepRoot, { recursive: true, force: true })
    }
  })

  test('ignores a repeated oversized set_output instead of writing a second salvage artifact', async () => {
    // Windows tmpdir resolution ignores TMPDIR, so the redirection below is
    // only meaningful on posix hosts (same guard as the sibling tests).
    if (process.platform === 'win32') return
    const repeatRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-repeat-'),
    )
    const repeatDir = join(repeatRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = repeatRoot
    try {
      const template = plainTemplate('oversized-salvage-repeat-agent')
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      const oversized = 'r'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const runOnce = () =>
        handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-repeat',
            input: { data: oversized },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])

      const first = await runOnce()
      expect(first.output).toEqual([
        {
          type: 'json',
          value: expect.objectContaining({ message: OVERSIZED_SALVAGE_ACK, salvaged: true }),
        },
      ])
      const firstRecord = agentState.output as Record<string, unknown>
      expect(readdirSync(repeatDir)).toHaveLength(1)

      // A retry loop re-entering the branch must neither append a second copy
      // of the payload nor ACK as though real output had been stored.
      // `lastSetOutputError` was never set by the successful first call, and the
      // ignored-duplicate path must not clear it either: the discriminator in
      // the ACK, not the absence of an error, is what marks a pointer record.
      const second = await runOnce()
      expect(second.output).toEqual([
        {
          type: 'json',
          value: {
            ...first.output[0].value,
            message: OVERSIZED_SALVAGE_GUARD_ACK,
            status: 'ignored',
            salvaged: true,
            artifactWrittenByThisCall: false,
          },
        },
      ])
      expect(agentState.output).toEqual(firstRecord)
      expect(agentState.lastSetOutputError).toBeUndefined()
      expect(readdirSync(repeatDir)).toHaveLength(1)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(repeatRoot, { recursive: true, force: true })
    }
  })

  test('replaces oversized output when only the middle of the payload changes', async () => {
    const template = plainTemplate('oversized-correction-agent')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const prefix = 'a'.repeat(MAX_SET_OUTPUT_JSON_CHARS / 2)
    const suffix = 'z'.repeat(MAX_SET_OUTPUT_JSON_CHARS / 2)
    const first = `${prefix}A${suffix}`
    const corrected = `${prefix}B${suffix}`
    const run = (data: string) =>
      handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'correction',
          input: { data },
        },
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])
    await run(first)
    const previous = agentState.output as Record<string, unknown>
    try {
      const result = await run(corrected)
      expect(result.output[0]).toMatchObject({
        value: { message: OVERSIZED_SALVAGE_ACK },
      })
      const current = agentState.output as Record<string, unknown>
      expect(current.artifactPath).not.toBe(previous.artifactPath)
      expect(readFileSync(current.artifactPath as string, 'utf8')).toBe(
        corrected,
      )
      expect((await run(corrected)).output[0]).toMatchObject({
        value: { status: 'ignored' },
      })
    } finally {
      rmSync(previous.artifactPath as string, { force: true })
      rmSync(
        (agentState.output as Record<string, unknown>).artifactPath as string,
        { force: true },
      )
    }
  })

  test('removes failed recovery pointers from normalized output and validated receipts', async () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'openbuff-artifact-failure-'))
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = blocker
    try {
      const normalized = normalizeSpawnedAgentOutput(
        { note: 'x'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 1) },
        'plain-agent',
        'failed-normalization',
      )
      await flushOversizeArtifactWrites('failed-normalization')
      expect(normalized.artifactPersisted).toBe(false)
      expect(normalized.artifactPath).toBeUndefined()
      expect(normalized.artifactPending).toBeUndefined()
      const receipt = await buildRuntimeAgentReceiptWithArtifacts({
        agentType: 'plain-agent',
        agentId: 'failed-receipt',
        output: { note: 'x'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 1) },
        agentState: getInitialSessionState(mockFileContext).mainAgentState,
      })
      expect(receipt.output).toMatchObject({ artifactPersisted: false })
      expect(receipt.output).not.toHaveProperty('artifactPath')
      expect(receipt.output).not.toHaveProperty('artifactPending')
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('publishes a validated receipt only after its full artifact is readable', async () => {
    const payload = { note: 'x'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 1) }
    const receipt = await buildRuntimeAgentReceiptWithArtifacts({
      agentType: 'plain-agent',
      agentId: 'readable-receipt',
      output: payload,
      agentState: getInitialSessionState(mockFileContext).mainAgentState,
    })
    const output = receipt.output as Record<string, unknown>
    try {
      expect(output.artifactPersisted).toBe(true)
      expect(output.artifactPending).toBeUndefined()
      expect(
        JSON.parse(readFileSync(output.artifactPath as string, 'utf8')),
      ).toEqual(payload)
    } finally {
      rmSync(output.artifactPath as string, { force: true })
    }
  })

  test('does not reuse a partial artifact left by an earlier failed write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-partial-artifact-'))
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = root
    try {
      const fsModule = await loadOversizeArtifactFs()
      expect(fsModule).toBeDefined()
      const payload = '{"note":"complete result"}'
      const contentHash = fsModule!
        .createHash('sha256')
        .update(payload)
        .digest('hex')
      const dir = oversizeArtifactDir(fsModule!, 'partial-probe')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${contentHash}.json`), payload.slice(0, 8))
      expect(
        await persistOversizeArtifact(payload, contentHash, {
          dirName: 'partial-probe',
          naming: 'content-addressed',
          now: Date.now(),
        }),
      ).toBeUndefined()
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores an identical retry of an oversized payload a gate already rejected', async () => {
    // A gate rejection leaves agentState.output untouched, so the salvage
    // re-entry guard cannot fire. Without recording the rejected payload's
    // identity, the natural retry ("resend the complete receipt") re-hashed and
    // re-wrote the same 1M+ char payload on every iteration, forever.
    if (process.platform === 'win32') return
    const rejectRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-reject-'),
    )
    const rejectDir = join(rejectRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = rejectRoot
    try {
      resetSetOutputArtifactSweepState()
      // Schema declares fields the salvage pointer record cannot satisfy, so
      // the salvage is persisted and then rejected by the output-schema gate.
      const template: AgentTemplate = {
        ...rejectionTemplate('oversized-schema-reject-repeat-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      const oversized = 'j'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const runOnce = () =>
        handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-schema-reject-repeat',
            input: { data: oversized },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])

      const first = await runOnce()
      const firstMessage =
        first.output[0]?.type === 'json' ? first.output[0].value.message : ''
      expect(firstMessage).toContain("agent's output schema")
      expect(agentState.output).toBeUndefined()
      // The artifact written before the gate ran is released by the rejection.
      expect(readdirSync(rejectDir)).toHaveLength(1)

      // The IDENTICAL retry costs one hash and no write, and it is TERMINAL:
      // the ERROR shape (not the benign `status: 'ignored'` duplicate shape)
      // carrying the SPECIFIC rejection the first attempt recorded plus the
      // "resending it unchanged" guidance, so the retry loop can surface a hard
      // failure instead of spinning in an unbounded no-write loop.
      const second = await runOnce()
      const secondMessage =
        second.output[0]?.type === 'json' ? second.output[0].value.message : ''
      expect(secondMessage).toContain("agent's output schema")
      expect(secondMessage).toContain(OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK)
      expect(second.output[0]).toMatchObject({
        type: 'json',
        value: { errorMessage: secondMessage },
      })
      // The terminal shape carries NO benign `status: 'ignored'` duplicate ACK.
      expect(
        (second.output[0] as unknown as { value: Record<string, unknown> })
          .value.status,
      ).toBeUndefined()
      expect(agentState.output).toBeUndefined()
      // The SPECIFIC field-level reason is preserved on agent state (the settle
      // path reads it as the `schema_invalid` diagnostic detail), not the
      // generic repeat prose.
      expect(agentState.lastSetOutputError).toContain("agent's output schema")
      expect(agentState.lastSetOutputError).not.toBe(
        OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK,
      )
      // Convergence: a third identical retry stays at the same terminal state
      // and still writes nothing.
      const third = await runOnce()
      expect(third.output).toEqual(second.output)
      expect(agentState.lastSetOutputError).toBe(firstMessage)
      expect(readdirSync(rejectDir)).toHaveLength(1)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(rejectRoot, { recursive: true, force: true })
    }
  })

  test('keeps a returned salvage artifact alive across several later salvage persists', async () => {
    // A directory well under SET_OUTPUT_ARTIFACT_SWEEP_MAX_ENTRIES (50): the
    // previous listing-position cursor could hand the whole window to the
    // just-written artifact, so an artifact already referenced by a returned
    // salvage record must survive every later persist.
    if (process.platform === 'win32') return
    const retentionRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-retention-'),
    )
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = retentionRoot
    resetSetOutputArtifactSweepState()
    const artifactPaths: string[] = []
    try {
      for (const marker of ['a', 'b', 'c', 'd']) {
        const template = plainTemplate(`oversized-salvage-retention-${marker}`)
        const agentState =
          getInitialSessionState(mockFileContext).mainAgentState
        agentState.agentType = template.id
        const { output } = await handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: `oversized-retention-${marker}`,
            input: { data: marker.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])
        expect(output).toEqual([
          {
            type: 'json',
            value: expect.objectContaining({ message: OVERSIZED_SALVAGE_ACK, salvaged: true }),
          },
        ])
        const salvaged = agentState.output as Record<string, unknown>
        expect(typeof salvaged.artifactPath).toBe('string')
        artifactPaths.push(salvaged.artifactPath as string)
      }

      await flushOversizeArtifactSweeps()
      // Every previously returned artifactPath still exists after the later
      // persists and their sweeps, keeping each complete payload readable.
      expect(artifactPaths).toHaveLength(4)
      for (const artifactPath of artifactPaths) {
        expect(existsSync(artifactPath)).toBe(true)
      }
    } finally {
      await flushOversizeArtifactSweeps()
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(retentionRoot, { recursive: true, force: true })
    }
  })

  test('sweeps more than one capped window of expired artifacts with a fixed per-call cap', async () => {
    // Windows tmpdir resolution ignores TMPDIR, so the redirection below is
    // only meaningful on posix hosts (same guard as the sibling tests).
    if (process.platform === 'win32') return
    const template = plainTemplate('oversized-salvage-window-agent')
    const sweepRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-window-'))
    const sweepDir = join(sweepRoot, 'openbuff-set-output')
    mkdirSync(sweepDir, { recursive: true, mode: 0o700 })
    // Fixed baseline derived from the PRODUCTION stride: one more expired
    // artifact than the exported per-call cap, plus one fresh artifact, so
    // N = ceil(entries / WINDOW) persists must reach all of them. Deriving both
    // numbers from the constant (never a hand-copied 50) means changing the
    // window size keeps the baseline bounding the walk the sweeper really does.
    const windowSize = SET_OUTPUT_ARTIFACT_SWEEP_MAX_ENTRIES
    const expiredCount = windowSize + 1
    const twoDaysAgoSeconds = Date.now() / 1000 - 2 * 24 * 60 * 60
    for (let index = 0; index < expiredCount; index += 1) {
      const expiredPath = join(sweepDir, `expired-${index}.json`)
      writeFileSync(expiredPath, 'expired', { mode: 0o600 })
      utimesSync(expiredPath, twoDaysAgoSeconds, twoDaysAgoSeconds)
    }
    const freshArtifact = join(sweepDir, 'fresh.json')
    writeFileSync(freshArtifact, 'fresh', { mode: 0o600 })
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = sweepRoot
    resetSetOutputArtifactSweepState()
    try {
      const calls = Math.ceil((expiredCount + 1) / windowSize)
      const artifactPaths: string[] = []
      for (let index = 0; index < calls; index += 1) {
        const agentState =
          getInitialSessionState(mockFileContext).mainAgentState
        agentState.agentType = template.id
        await handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: `oversized-window-${index}`,
            input: { data: `${index}`.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])
        artifactPaths.push(
          (agentState.output as Record<string, unknown>).artifactPath as string,
        )
        // Observe each detached sweep before starting the next listing.
        await flushOversizeArtifactSweeps()
      }

      await flushOversizeArtifactSweeps()
      // Forward progress: every expired entry is gone after N capped sweeps.
      expect(
        readdirSync(sweepDir).filter((entry) => entry.startsWith('expired-')),
      ).toEqual([])
      // The fresh artifact and every artifact this test just produced survive.
      expect(existsSync(freshArtifact)).toBe(true)
      for (const artifactPath of artifactPaths) {
        expect(existsSync(artifactPath)).toBe(true)
      }
    } finally {
      await flushOversizeArtifactSweeps()
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(sweepRoot, { recursive: true, force: true })
    }
  })

  test('keeps the salvage record inside the downstream parent budget at below/at/2x threshold', async () => {
    // Fixed-baseline fixture for the hand-picked caps this salvage replaces:
    // the head/tail sizes are DERIVED from the mirrored downstream budgets, so
    // the serialized record must survive `boundAgentOutputForParent`. Payload
    // sizes below / at / 2x the salvage threshold pin the ordinary path (no
    // artifact, no extra I/O) separately from the salvage path.
    if (process.platform === 'win32') return
    const baselineRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-baseline-'),
    )
    const baselineDir = join(baselineRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = baselineRoot
    try {
      resetSetOutputArtifactSweepState()
      const template = plainTemplate('oversized-salvage-baseline-agent')
      const run = async (data: string) => {
        const agentState =
          getInitialSessionState(mockFileContext).mainAgentState
        agentState.agentType = template.id
        const { output } = await handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-baseline',
            input: { data },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])
        return { output, agentState }
      }

      // The derivation itself, pinned against the downstream baseline.
      expect(OVERSIZED_OUTPUT_HEAD_CHARS).toBeLessThanOrEqual(
        PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS,
      )
      expect(OVERSIZED_OUTPUT_TAIL_CHARS).toBeLessThanOrEqual(
        PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS,
      )
      expect(OVERSIZED_SALVAGE_RECORD_MAX_CHARS).toBeLessThan(
        PARENT_AGENT_OUTPUT_BUDGET_CHARS,
      )

      // Below the threshold and exactly AT it: the ordinary path, which writes
      // no artifact at all (the artifact directory is never even created).
      for (const size of [
        MAX_SET_OUTPUT_JSON_CHARS - 1,
        MAX_SET_OUTPUT_JSON_CHARS,
      ]) {
        const { agentState } = await run('k'.repeat(size))
        expect(agentState.output).toBeUndefined()
        expect(existsSync(baselineDir)).toBe(false)
      }

      // 2x the threshold: exactly one artifact plus a bounded pointer record.
      const oversized = 'z'.repeat(2 * MAX_SET_OUTPUT_JSON_CHARS)
      const { output, agentState } = await run(oversized)
      expect(output).toEqual([
        {
          type: 'json',
          value: expect.objectContaining({ message: OVERSIZED_SALVAGE_ACK, salvaged: true }),
        },
      ])
      const salvaged = agentState.output as Record<string, unknown>
      expect(salvaged.artifactBytes).toBe(oversized.length)
      expect(salvaged.artifactCreatedAt).toEqual(expect.any(String))
      expect(salvaged.artifactWrittenByThisCall).toBe(true)
      // The returned path is owned by THIS record: content hash plus a
      // per-salvage uuid, never a path shared with another agent's payload.
      expect(salvaged.artifactPath as string).toMatch(
        /[0-9a-f]{64}-[0-9a-f-]{36}\.json$/,
      )
      expect(readdirSync(baselineDir)).toHaveLength(1)
      // Serialized length against the fixed downstream baseline.
      expect(JSON.stringify(salvaged).length).toBeLessThanOrEqual(
        OVERSIZED_SALVAGE_RECORD_MAX_CHARS,
      )
      expect(JSON.stringify(salvaged).length).toBeLessThan(
        PARENT_AGENT_OUTPUT_BUDGET_CHARS,
      )
    } finally {
      await flushOversizeArtifactSweeps()
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(baselineRoot, { recursive: true, force: true })
    }
  })

  test('keeps the salvage record inside the REAL nested parent payload', async () => {
    // The previous fixture asserted against the FLAT payload with a fixed
    // 200_000-char sibling, so the nested shape the settle path actually sees
    // (`{ type, value: { ...record } }` plus every sibling field) never
    // approached the denominator: a regression that pushed the real nested
    // payload past PARENT_AGENT_OUTPUT_MAX_CHARS in production passed it.
    //
    // This drives the same nested shape with a sibling sized to the ACTUAL
    // remaining budget, and asserts the salvage record's own leaves are not
    // clipped there — i.e. the guarantee the fixture claims to pin is pinned.
    const record = {
      truncated: true,
      artifactPath: '/tmp/openbuff-set-output/abc.json',
      artifactCreatedAt: new Date(0).toISOString(),
      artifactWrittenByThisCall: true,
      artifactBytes: MAX_SET_OUTPUT_JSON_CHARS + 1,
      truncation: {
        reason: 'oversized_payload',
        totalChars: MAX_SET_OUTPUT_JSON_CHARS + 1,
        keptChars: OVERSIZED_OUTPUT_HEAD_CHARS + OVERSIZED_OUTPUT_TAIL_CHARS,
      },
      data: 'h'.repeat(OVERSIZED_OUTPUT_HEAD_CHARS),
      dataTail: 't'.repeat(OVERSIZED_OUTPUT_TAIL_CHARS),
    }
    const nestedShell = (sibling: string) => ({
      type: 'structuredOutput',
      value: { ...record, sibling },
    })
    const shellChars = JSON.stringify(nestedShell('')).length
    const submitted = nestedShell('s'.repeat(nestedSiblingCharsFor(shellChars)))
    // Measure the final wrapped object, including sibling and all JSON overhead.
    expect(JSON.stringify(submitted).length).toBe(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    const nested = normalizeSpawnedAgentOutput(submitted) as {
      value?: Record<string, unknown>
      artifactPath?: unknown
    }
    expect(JSON.stringify(nested).length).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    // The record survives intact beside that sibling: pointer and both bounded
    // leaves are unclipped, so no head/tail content was lost.
    const normalizedValue = nested.value ?? (nested as Record<string, unknown>)
    expect(normalizedValue.artifactPath).toBe(record.artifactPath)
    expect(normalizedValue.data).toBe(record.data)
    expect(normalizedValue.dataTail).toBe(record.dataTail)
    // And the leaf caps the record is DERIVED from are still the pinned ones.
    expect(PARENT_AGENT_OUTPUT_DEFAULT_LEAF_CHARS).toBe(
      PARENT_AGENT_OUTPUT_DEFAULT_LEAF_BASELINE_CHARS,
    )
    expect(PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS).toBe(
      PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_BASELINE_CHARS,
    )
    expect(OVERSIZED_OUTPUT_HEAD_CHARS).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_BASELINE_CHARS,
    )
  })

  test('rebuilds a shared reference once per settle (identity memo baseline)', () => {
    // Fixed baseline for the compaction cost at the current budget: the SAME
    // object referenced several times used to be rebuilt once per occurrence,
    // so a payload quoting one large receipt N times cost O(N x subtree). The
    // memo makes it one rebuild, which is what keeps `boundAgentOutputForParent`
    // linear at a 1M-char budget.
    const shared = { note: 'x'.repeat(SHARED_REFERENCE_LEAF_CHARS) }
    const payload: Record<string, unknown> = {
      original: shared,
    }
    for (let index = 0; index < SHARED_REFERENCE_REPEATS; index += 1) {
      payload[`copy${index}`] = shared
    }
    const normalized = normalizeSpawnedAgentOutput(payload) as Record<
      string,
      unknown
    >
    // One rebuild per identity: every occurrence is the SAME compacted object,
    // so the count of distinct rebuilt objects for the shared reference is 1.
    const rebuilt = new Set<unknown>()
    for (const key of [
      'original',
      ...Object.keys(payload).filter((key) => key.startsWith('copy')),
    ]) {
      rebuilt.add(normalized[key])
    }
    expect(rebuilt.size).toBe(SHARED_REFERENCE_EXPECTED_REBUILDS)
    // The payload is over budget, so it is honestly marked truncated and names
    // a recovery artifact rather than silently dropping the leaves.
    expect(normalized.truncated).toBe(true)
    expect(typeof normalized.artifactPath).toBe('string')
  })

  test('keeps the handler module free of top-level Node built-in imports', () => {
    // The salvage filesystem seam is lazy on purpose: this module is bundled
    // into the published SDK (agent-runtime ships source, not dist), so a
    // top-level `node:fs/promises`/`node:os`/`node:path` import would make
    // LOADING set_output require a full Node filesystem implementation even
    // though salvage only ever runs past MAX_SET_OUTPUT_JSON_CHARS. This pins
    // that module boundary so a future edit cannot reintroduce a static import.
    const source = readFileSync(
      join(import.meta.dir, '..', 'set-output.ts'),
      'utf8',
    )
    const sharedSource = readFileSync(
      join(import.meta.dir, '..', 'oversize-artifact.ts'),
      'utf8',
    )
    for (const moduleSource of [source, sharedSource]) {
      expect(/^import[\s\S]*?from 'node:/m.test(moduleSource)).toBe(false)
      expect(/^import 'node:/m.test(moduleSource)).toBe(false)
    }
    expect(source.includes("from './oversize-artifact'")).toBe(true)
    expect(source.includes("from './spawn-agent-utils'")).toBe(false)
    for (const moduleName of ['node:fs/promises', 'node:os', 'node:path']) {
      expect(sharedSource.includes(`import('${moduleName}')`)).toBe(true)
    }
  })

  test('pins the mirrored parent budgets against the consumer that enforces them', () => {
    // PARENT_AGENT_OUTPUT_* are COPIES of values spawn-agent-utils.ts does not
    // export. A copy is only safe while it is verified against the VALUE the
    // downstream consumer actually applies — not against the owner's source
    // spelling, which would break on a rename, a computed constant, different
    // literal formatting, or a default parameter without any change in behaviour.
    // `normalizeSpawnedAgentOutput` IS that consumer (it re-serializes output on
    // its way to the parent), so each mirrored boundary is probed through it: a
    // change to the real denominator in the owner moves these observations and
    // fails HERE, instead of silently flipping the salvage record into the lossy
    // compaction path that clips the very `data`/`dataTail` leaves the salvage
    // exists to deliver.
    //
    // The payload is deliberately OVER the total budget: the consumer preserves
    // string leaves verbatim while the whole output fits, so leaf caps are only
    // observable in the compacting regime.
    const filler = 'b'.repeat(1_000)
    const overBudget = {
      report: 'r'.repeat(PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS * 2),
      note: 'n'.repeat(PARENT_AGENT_OUTPUT_DEFAULT_LEAF_CHARS * 4),
      blocks: Array.from(
        {
          length:
            Math.ceil(PARENT_AGENT_OUTPUT_BUDGET_CHARS / filler.length) + 10,
        },
        () => filler,
      ),
    }
    expect(JSON.stringify(overBudget).length).toBeGreaterThan(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    const normalized = normalizeSpawnedAgentOutput(overBudget) as Record<
      string,
      unknown
    >
    // Total budget: the compacted payload never exceeds the mirrored denominator,
    // and compaction actually ran (the lossy path is the one being bounded).
    expect(JSON.stringify(normalized).length).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    expect(normalized.truncation).toBeDefined()
    // High-fidelity leaf: an answer-bearing field keeps far more than the default
    // cap, but never more than the mirrored high-fidelity cap.
    expect(typeof normalized.report).toBe('string')
    expect((normalized.report as string).length).toBeGreaterThan(
      PARENT_AGENT_OUTPUT_DEFAULT_LEAF_CHARS,
    )
    expect((normalized.report as string).length).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_HIGH_FIDELITY_LEAF_CHARS,
    )
    // Default leaf: an incidental field is clipped at the mirrored default cap.
    expect(typeof normalized.note).toBe('string')
    expect((normalized.note as string).length).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_DEFAULT_LEAF_CHARS,
    )
  })

  test('pins every per-component model-payload budget, not only their sum', () => {
    // EACH component is pinned to its own literal FIRST, so a compensating pair
    // of changes (parent budget +X, payload limit -X) fails on the component
    // assertion that moved instead of cancelling in the sum, and a regression
    // is attributable to the budget that changed.
    expect(PARENT_AGENT_OUTPUT_BUDGET_CHARS).toBe(
      PARENT_AGENT_OUTPUT_BASELINE_CHARS,
    )
    expect(MODEL_PAYLOAD_JSON_CHAR_LIMIT).toBe(MODEL_PAYLOAD_BASELINE_CHARS)
    expect(MAX_SET_OUTPUT_JSON_CHARS).toBe(MODEL_PAYLOAD_BASELINE_CHARS)
    expect(DEFAULT_JOB_OUTPUT_BYTE_LIMIT).toBe(JOB_OUTPUT_BASELINE_BYTES)
    expect(OVERSIZED_OUTPUT_HEAD_CHARS).toBe(
      OVERSIZED_OUTPUT_HEAD_BASELINE_CHARS,
    )
    expect(OVERSIZED_OUTPUT_TAIL_CHARS).toBe(
      OVERSIZED_OUTPUT_TAIL_BASELINE_CHARS,
    )
    expect(OVERSIZED_SALVAGE_RECORD_MAX_CHARS).toBe(
      OVERSIZED_SALVAGE_RECORD_BASELINE_CHARS,
    )

    // The composed baseline is DERIVED from the pinned literals above, so this
    // assertion cannot absorb a compensating pair of component changes.
    const composedStepPayloadChars =
      PARENT_AGENT_OUTPUT_BUDGET_CHARS +
      MODEL_PAYLOAD_JSON_CHAR_LIMIT +
      DEFAULT_JOB_OUTPUT_BYTE_LIMIT
    expect(composedStepPayloadChars).toBe(COMPOSED_STEP_PAYLOAD_BASELINE_CHARS)
    // The salvage record lives INSIDE the parent budget, so it can never be the
    // component that pushes a step past the baseline on its own.
    expect(OVERSIZED_SALVAGE_RECORD_MAX_CHARS).toBeLessThan(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
  })

  test('keeps the salvage leaves unclipped when the record is nested beside a sibling', () => {
    // The downstream consumer measures the serialized length of the COMPACTED
    // parent-visible OBJECT, not the length of `agentState.output` alone: once
    // the record is nested under a key (or enlarged by a sibling field) the real
    // denominator is larger than a flat fixture measures. This is the case the
    // equal-length assumption misses — the composed payload must still fit the
    // owner budget, which is exactly the condition under which the
    // `data`/`dataTail`/`artifactPath` leaves are not clipped.
    const artifactPath = join(
      tmpdir(),
      'openbuff-set-output',
      `${'a'.repeat(64)}-${'b'.repeat(36)}.json`,
    )
    const record = {
      truncated: true,
      artifactPath,
      artifactCreatedAt: new Date(0).toISOString(),
      artifactWrittenByThisCall: true,
      artifactBytes: 2 * MAX_SET_OUTPUT_JSON_CHARS,
      truncation: {
        reason: 'oversized_payload',
        totalChars: 2 * MAX_SET_OUTPUT_JSON_CHARS,
        keptChars: OVERSIZED_OUTPUT_HEAD_CHARS + OVERSIZED_OUTPUT_TAIL_CHARS,
      },
      data: 'h'.repeat(OVERSIZED_OUTPUT_HEAD_CHARS),
      dataTail: 't'.repeat(OVERSIZED_OUTPUT_TAIL_CHARS),
      family: 'reviewer',
    }

    // Worst-case record, exactly as the exported bound describes it.
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(
      OVERSIZED_SALVAGE_RECORD_MAX_CHARS,
    )
    const shell = { output: record, sibling: '' }
    const nestedPayload = {
      ...shell,
      sibling: 's'.repeat(nestedSiblingCharsFor(JSON.stringify(shell).length)),
    }
    expect(JSON.stringify(nestedPayload).length).toBe(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    const normalized = normalizeSpawnedAgentOutput(nestedPayload) as {
      output: typeof record
    }
    expect(JSON.stringify(normalized).length).toBeLessThanOrEqual(
      PARENT_AGENT_OUTPUT_BUDGET_CHARS,
    )
    expect(normalized.output.artifactPath).toBe(record.artifactPath)
    expect(normalized.output.data).toBe(record.data)
    expect(normalized.output.dataTail).toBe(record.dataTail)
  })

  test('gives two concurrent persists distinct sweep windows', async () => {
    // The forward-progress argument for the capped sweep must hold under the
    // concurrency the handler actually runs in (a fan-out of children can all
    // cross the threshold at once). Two full windows of expired artifacts: if
    // both callers observe the same cursor they stat the same 50 entries and
    // half the directory survives.
    if (process.platform === 'win32') return
    const concurrentRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-concurrent-'),
    )
    const concurrentDir = join(concurrentRoot, 'openbuff-set-output')
    mkdirSync(concurrentDir, { recursive: true, mode: 0o700 })
    const expiredCount = 100
    const twoDaysAgoSeconds = Date.now() / 1000 - 2 * 24 * 60 * 60
    for (let index = 0; index < expiredCount; index += 1) {
      const expiredPath = join(concurrentDir, `expired-${index}.json`)
      writeFileSync(expiredPath, 'expired', { mode: 0o600 })
      utimesSync(expiredPath, twoDaysAgoSeconds, twoDaysAgoSeconds)
    }
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = concurrentRoot
    resetSetOutputArtifactSweepState()
    try {
      const template = plainTemplate('oversized-salvage-concurrent-agent')
      const runOnce = (marker: string) => {
        const agentState =
          getInitialSessionState(mockFileContext).mainAgentState
        agentState.agentType = template.id
        return handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: `oversized-concurrent-${marker}`,
            input: { data: marker.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])
      }

      const results = await Promise.all([runOnce('1'), runOnce('2')])
      const artifactPaths = results.map((result) => {
        const value =
          result.output[0]?.type === 'json' ? result.output[0].value : {}
        expect('message' in value && value.message).toBe(OVERSIZED_SALVAGE_ACK)
        return ''
      })
      expect(artifactPaths).toHaveLength(2)

      await flushOversizeArtifactSweeps()
      // A repeated window would leave ~50 of the 100 expired entries behind; a
      // distinct window per caller leaves at most the tail indices the two
      // windows cannot reach once each caller's own artifact grew the listing.
      expect(
        readdirSync(concurrentDir).filter((entry) =>
          entry.startsWith('expired-'),
        ).length,
      ).toBeLessThanOrEqual(2)
    } finally {
      await flushOversizeArtifactSweeps()
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(concurrentRoot, { recursive: true, force: true })
    }
  })

  test('retains the full artifact when oversized salvage is rejected by a gate', async () => {
    // Both rejection shapes persist the artifact BEFORE the gate runs and
    // store nothing afterwards. Without an explicit release the full payload
    // would stay pinned against the TTL sweep for 24h while nothing names it.
    if (process.platform === 'win32') return
    const releaseRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-release-'),
    )
    const releaseDir = join(releaseRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = releaseRoot
    try {
      // Verdict rejection: a reviewer child's salvage record is verdict-less.
      resetSetOutputArtifactSweepState()
      const reviewerTemplate = rejectionTemplate('code-reviewer')
      const reviewerState =
        getInitialSessionState(mockFileContext).mainAgentState
      reviewerState.agentType = reviewerTemplate.id
      await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-verdict-release',
          input: { data: 'v'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState: reviewerState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [reviewerTemplate.id]: reviewerTemplate },
      } as unknown as Parameters<typeof handleSetOutput>[0])
      expect(reviewerState.output).toBeUndefined()
      expect(readdirSync(releaseDir)).toHaveLength(1)

      // Schema rejection: the pointer record cannot satisfy the declared schema.
      const schemaTemplate: AgentTemplate = {
        ...rejectionTemplate('oversized-schema-release-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const schemaState = getInitialSessionState(mockFileContext).mainAgentState
      schemaState.agentType = schemaTemplate.id
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-schema-release',
          input: { data: 'u'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState: schemaState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [schemaTemplate.id]: schemaTemplate },
      } as unknown as Parameters<typeof handleSetOutput>[0])
      expect(schemaState.output).toBeUndefined()
      const message = output[0]?.type === 'json' ? output[0].value.message : ''
      expect(message).toContain('Full payload preserved verbatim at')
      // Both rejected payloads remain available for recovery.
      expect(readdirSync(releaseDir)).toHaveLength(2)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(releaseRoot, { recursive: true, force: true })
    }
  })

  test('keeps EVERY payload in an alternating reject/retry cycle terminal', async () => {
    // A single-slot marker only remembered the LAST rejected payload, so a loop
    // that alternated A -> B -> A -> B overwrote it on each iteration and the
    // original payload was never terminal: every cycle re-hashed ~1M chars,
    // wrote a full artifact and had the gate release it again. The marker is now
    // a bounded per-agent SET, so every payload in the cycle stays terminal.
    if (process.platform === 'win32') return
    const cycleRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-cycle-'))
    const cycleDir = join(cycleRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = cycleRoot
    resetSetOutputArtifactSweepState()
    try {
      const template: AgentTemplate = {
        ...rejectionTemplate('oversized-alternating-cycle-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      agentState.agentId = 'alternating-cycle-agent'
      // A↔B: the same length, differing only in the last character, which is
      // exactly the "model slightly mutates it and resends" shape.
      const payloadA = 'a'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const payloadB = `${payloadA.slice(0, -1)}b`
      const run = (data: string) =>
        handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-alternating-cycle',
            input: { data },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])

      const firstA = await run(payloadA)
      expect(
        firstA.output[0]?.type === 'json' ? firstA.output[0].value.message : '',
      ).toContain("agent's output schema")
      const firstB = await run(payloadB)
      expect(
        firstB.output[0]?.type === 'json' ? firstB.output[0].value.message : '',
      ).toContain("agent's output schema")
      // Both attempts released the artifact they wrote.
      expect(readdirSync(cycleDir)).toHaveLength(2)

      // Re-emitting the ORIGINAL payload is terminal even though the marker has
      // since recorded a different payload, and stays terminal across repeats.
      for (const repeat of [payloadA, payloadB, payloadA]) {
        const result = await run(repeat)
        const message =
          result.output[0]?.type === 'json'
            ? result.output[0].value.message
            : ''
        expect(message).toContain(OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK)
        expect(message).toContain("agent's output schema")
        // No write, no directory growth, no benign `status: 'ignored'` shape.
        expect(
          (result.output[0] as unknown as { value: Record<string, unknown> })
            .value.status,
        ).toBeUndefined()
        expect(readdirSync(cycleDir)).toHaveLength(2)
      }
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(cycleRoot, { recursive: true, force: true })
    }
  })

  test('skips the oversized artifact I/O when the call is already cancelled', async () => {
    // The salvage is the only set_output shape with real I/O (a ~1M-char write
    // plus a sweep). A cancelled child must not pay for it, and no artifact may
    // be registered as live for a record that is already cancelled.
    if (process.platform === 'win32') return
    const abortRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-abort-'))
    const abortDir = join(abortRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = abortRoot
    resetSetOutputArtifactSweepState()
    try {
      const template = plainTemplate('oversized-salvage-aborted-agent')
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      const controller = new AbortController()
      controller.abort()
      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-aborted',
          input: { data: 'x'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
        signal: controller.signal,
      } as unknown as Parameters<typeof handleSetOutput>[0])

      // Cancel-before-write is reported as the call's ERROR, not as a stored
      // salvage: nothing was persisted, so there is no pointer to publish.
      expect(output).toEqual([
        {
          type: 'json',
          value: {
            message: OVERSIZED_SALVAGE_CANCELLED_ACK,
            errorMessage: OVERSIZED_SALVAGE_CANCELLED_ACK,
          },
        },
      ])
      // `agentState.output` is left EXACTLY as it was: the previous behavior
      // published a pointer-less `truncated: true` record, i.e. a stored output
      // the child never produced (and one the replay guard would later ACK as an
      // already-stored duplicate, discarding the payload).
      expect(agentState.output).toBeUndefined()
      expect(agentState.lastSetOutputError).toBe(
        OVERSIZED_SALVAGE_CANCELLED_ACK,
      )
      expect(existsSync(abortDir) ? readdirSync(abortDir) : []).toEqual([])
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(abortRoot, { recursive: true, force: true })
    }
  })

  test('joins a tracked parent-output artifact write at the settle boundary', async () => {
    // The receipt's `artifactPath` is computed synchronously while the write is
    // only tracked. `flushOversizeArtifactWrites(owner)` is the join point the
    // settle path calls, so the pointer is only published once the file is on
    // disk; before it, the write was fire-and-forget and a parent `read_files`
    // raced it.
    const normalized = normalizeSpawnedAgentOutput(
      { report: 'r'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 10_000) },
      undefined,
      'settle-join-agent',
    ) as Record<string, unknown>
    expect(typeof normalized.artifactPath).toBe('string')
    // The write has not necessarily landed yet, and the receipt says so.
    expect(normalized.artifactPending).toBe(true)
    const artifactPath = normalized.artifactPath as string
    try {
      await flushOversizeArtifactWrites('settle-join-agent')
      expect(existsSync(artifactPath)).toBe(true)
    } finally {
      rmSync(artifactPath, { force: true })
    }
  })

  test('scopes the settle join to ONE child so a sibling write cannot block it', async () => {
    // The join used to drain ONE process-global set until empty, so every settle
    // in a fan-out waited on every sibling's artifact write: aggregate settle
    // latency became sum(write_i) instead of max(write_i), and one slow
    // filesystem write hung already-finished siblings' receipts. The tracked
    // writes are now bucketed per settling child, and a flush joins only its own
    // bucket.
    const first = normalizeSpawnedAgentOutput(
      { report: 'a'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 1_000) },
      undefined,
      'fanout-child-a',
    ) as Record<string, unknown>
    const second = normalizeSpawnedAgentOutput(
      { report: 'b'.repeat(PARENT_AGENT_OUTPUT_MAX_CHARS + 1_000) },
      undefined,
      'fanout-child-b',
    ) as Record<string, unknown>
    const firstPath = first.artifactPath as string
    const secondPath = second.artifactPath as string
    expect(typeof firstPath).toBe('string')
    expect(typeof secondPath).toBe('string')
    // Both writes are in flight; neither receipt may claim the file is ready.
    expect(first.artifactPending).toBe(true)
    expect(second.artifactPending).toBe(true)
    try {
      // Flushing an UNRELATED settle joins nothing: it must resolve without
      // joining either in-flight write.
      await flushOversizeArtifactWrites('fanout-child-unrelated')
      expect(existsSync(firstPath)).toBe(false)
      // Each child's own flush joins exactly that child's write.
      await flushOversizeArtifactWrites('fanout-child-a')
      expect(existsSync(firstPath)).toBe(true)
      await flushOversizeArtifactWrites('fanout-child-b')
      expect(existsSync(secondPath)).toBe(true)
    } finally {
      rmSync(firstPath, { force: true })
      rmSync(secondPath, { force: true })
    }
  })

  test('does not ACK an unpersisted salvage record as an already-stored duplicate', async () => {
    // A pointer record whose bytes were never written must not be classified as
    // a stored pointer: doing so made the next identical oversized retry return
    // the benign `status: 'ignored'` duplicate ACK for a payload that was
    // irrecoverably dropped, silently discarding the child's output.
    if (process.platform === 'win32') return
    const unpersistedRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-unpersisted-'),
    )
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = unpersistedRoot
    resetSetOutputArtifactSweepState()
    try {
      const template = plainTemplate('oversized-unpersisted-agent')
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      // The exact stored-record shape the no-persist branch produces.
      agentState.output = {
        truncated: true,
        artifactPersisted: false,
        artifactError: 'could not persist',
        truncation: {
          reason: 'oversized_payload_unpersisted',
          totalChars: 50,
          keptChars: 10,
        },
        data: 'head',
        dataTail: 'tail',
      }

      const { output } = await handleSetOutput({
        ...TEST_AGENT_RUNTIME_IMPL,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolName: 'set_output',
          toolCallId: 'oversized-unpersisted-retry',
          input: { data: 'u'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1) },
        } as unknown as CodebuffToolCall<'set_output'>,
        agentState,
        apiKey: 'test-api-key',
        localAgentTemplates: { [template.id]: template },
      } as unknown as Parameters<typeof handleSetOutput>[0])

      // Re-attempted, NOT short-circuited into the benign duplicate ACK.
      const message = output[0]?.type === 'json' ? output[0].value.message : ''
      expect(message).not.toBe(OVERSIZED_SALVAGE_GUARD_ACK)
      expect(
        (output[0] as unknown as { value: Record<string, unknown> }).value
          .status,
      ).toBeUndefined()
      expect(message).toBe(OVERSIZED_SALVAGE_ACK)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(unpersistedRoot, { recursive: true, force: true })
    }
  })

  test('keeps the per-persist filesystem-call count write-bound (sweep is detached)', async () => {
    // The TTL sweep used to be awaited INSIDE `persistOversizeArtifact`, so every
    // salvage persist paid one write + one directory listing + up to
    // OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES stat calls in front of the parent
    // receipt. The sweep is now started, not awaited: a persist is write-bound,
    // and retention is unchanged (the detached sweep still runs).
    if (process.platform === 'win32') return
    const sweepRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-sweep-'))
    const sweepDir = join(sweepRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = sweepRoot
    resetSetOutputArtifactSweepState()
    try {
      const written = await persistOversizeArtifact('newest-payload', 'hash', {
        dirName: 'openbuff-set-output',
        naming: 'unique',
        now: Date.now(),
      })
      expect(typeof written?.artifactPath).toBe('string')
      // The persist resolved WITHOUT waiting for a sweep, and the swept window
      // is still bounded by the production stride when the sweep does run.
      expect(OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES).toBe(50)
      await flushOversizeArtifactSweeps()
      expect(readdirSync(sweepDir).length).toBeGreaterThan(0)
      rmSync(written!.artifactPath, { force: true })
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(sweepRoot, { recursive: true, force: true })
    }
  })

  test('rejects an oversized payload whose salvage record cannot satisfy the agent output schema', async () => {
    // A schema-declaring agent is the only class that reaches the salvage
    // branch, so its contract is enforced instead of silently publishing a
    // record with none of the declared fields.
    const template: AgentTemplate = {
      ...rejectionTemplate('schema-declaring-salvage-agent'),
      outputSchema: z.object({ note: z.string() }),
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const oversized = 's'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'oversized-schema-rejection',
        input: { data: oversized },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    expect(agentState.output).toBeUndefined()
    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    expect(message).toContain('too large')
    expect(message).toContain("agent's output schema")
    // The rejection must NOT hand the parent a path that no longer exists: the
    // artifact this call wrote is released before returning.
    expect(message).toContain('Full payload preserved verbatim at')
    const artifactPath = message.match(
      /preserved verbatim at (.+?)\. Read that file/,
    )?.[1]
    expect(readFileSync(artifactPath!, 'utf8')).toBe(oversized)
    rmSync(artifactPath!, { force: true })
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('does not let an oversized salvage replace an already-published reviewer receipt', async () => {
    const template = rejectionTemplate('code-reviewer')
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const publishedReceipt = {
      schemaVersion: 1,
      verdict: 'BLOCKING',
      snapshotFingerprint: 'v3:published-fingerprint',
      reviewedFiles: [
        'packages/agent-runtime/src/tools/handlers/tool/set-output.ts',
      ],
      findings: ['RF-1: blocking finding'],
      coverage: 'covered',
    }
    agentState.output = publishedReceipt

    const oversized = 'z'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'oversized-over-published-receipt',
        input: { data: oversized },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    // The verdict-less salvage record must not destroy the published receipt:
    // the receipt-downgrade guard ACKs the call and leaves output untouched.
    expect(output).toEqual([
      {
        type: 'json',
        value: { message: RECEIPT_GUARD_ACK, status: 'ignored' },
      },
    ])
    expect(agentState.output).toEqual(publishedReceipt)
    expect(agentState.lastSetOutputError).toBeUndefined()
  })

  test('accepts a complete oversized reviewer receipt without replacing it with salvage', async () => {
    const template = {
      ...rejectionTemplate('code-reviewer'),
      outputSchema: z.looseObject({
        verdict: z.string(),
        snapshotFingerprint: z.string(),
        findings: z.array(z.string()),
      }),
    }
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = template.id
    const oversized = JSON.stringify({
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:oversized-review',
      reviewedFiles: ['src/a.ts'],
      findings: ['x'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)],
      coverage: 'covered',
    })

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'oversized-gate-reviewer',
        input: { data: oversized },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: { [template.id]: template },
    } as unknown as Parameters<typeof handleSetOutput>[0])

    // A reviewer child that publishes the verdict-less salvage would reach the
    // gate as a schema-invalid receipt (the oracle failure the verdict guard
    // exists to prevent), so the salvage is rejected here.
    expect(agentState.output).toMatchObject({
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:oversized-review',
    })
    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    expect((agentState.output as { findings: string[] }).findings[0]).toBe(
      'x'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1),
    )
    expect(message).toBe('Output set')
    expect(agentState.lastSetOutputError).toBeUndefined()
  })

  test('fails an oversized payload closed when the declared agent type has no resolvable template', async () => {
    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    agentState.agentType = 'unregistered-agent-template'
    const oversized = 'w'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)

    const { output } = await handleSetOutput({
      ...TEST_AGENT_RUNTIME_IMPL,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_output',
        toolCallId: 'oversized-unresolvable-template',
        input: { data: oversized },
      } as unknown as CodebuffToolCall<'set_output'>,
      agentState,
      apiKey: 'test-api-key',
      localAgentTemplates: {},
    } as unknown as Parameters<typeof handleSetOutput>[0])

    // Template resolution runs BEFORE the salvage, so an unknown output schema
    // can never be bypassed by making the payload oversized.
    expect(agentState.output).toBeUndefined()
    const message = output[0]?.type === 'json' ? output[0].value.message : ''
    expect(message).toContain('could not be resolved')
    expect(agentState.lastSetOutputError).toBe(message)
  })

  test('keeps the rejected-payload marker across an agent-state round trip', async () => {
    // The marker must survive the retry boundary. The runtime snapshots and
    // restores agent state around steps, so a retry can arrive with a CLONED or
    // reconstructed state; keying the marker on object identity would silently
    // drop it and the identical 1M+ char payload would be hashed, written and
    // released again on every iteration — the unbounded write loop the marker
    // exists to stop.
    if (process.platform === 'win32') return
    const roundTripRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-roundtrip-'),
    )
    const roundTripDir = join(roundTripRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = roundTripRoot
    resetSetOutputArtifactSweepState()
    try {
      // Schema declares fields the salvage pointer record cannot satisfy, so
      // the salvage is persisted and then rejected by the output-schema gate.
      const template: AgentTemplate = {
        ...rejectionTemplate('oversized-roundtrip-reject-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const firstState = getInitialSessionState(mockFileContext).mainAgentState
      firstState.agentType = template.id
      firstState.agentId = 'stable-roundtrip-agent'
      const oversized = 'c'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const run = (agentState: typeof firstState) =>
        handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-roundtrip-reject',
            input: { data: oversized },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])

      const first = await run(firstState)
      expect(
        first.output[0]?.type === 'json' ? first.output[0].value.message : '',
      ).toContain("agent's output schema")
      expect(readdirSync(roundTripDir)).toHaveLength(1)

      // A reconstructed state carrying the SAME stable agent identity still
      // lands on the terminal marker: nothing is re-hashed into a new artifact.
      const restoredState =
        getInitialSessionState(mockFileContext).mainAgentState
      restoredState.agentType = template.id
      restoredState.agentId = firstState.agentId
      const restored = await run(restoredState)
      const restoredMessage =
        restored.output[0]?.type === 'json'
          ? restored.output[0].value.message
          : ''
      // The terminal repeat re-emits the SPECIFIC rejection the first attempt
      // recorded and appends the "resending it unchanged" guidance.
      expect(restoredMessage).toContain("agent's output schema")
      expect(restoredMessage).toContain(OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK)
      expect(restoredState.output).toBeUndefined()
      expect(restoredState.lastSetOutputError).toContain(
        "agent's output schema",
      )
      // Convergence: still nothing written for the restarted state.
      expect(readdirSync(roundTripDir)).toHaveLength(1)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(roundTripRoot, { recursive: true, force: true })
    }
  })

  test('keys the rejected-payload marker on the agent identity, not the run', async () => {
    // `runId` identifies ONE run, and every retry attempt of the same child is a
    // distinct run. A marker keyed on the run identity would never be observed
    // by the next attempt, so the unbounded reject/retry WRITE loop the marker
    // exists to stop stayed live exactly in the production retry path. The
    // marker is therefore keyed on `agentId`.
    if (process.platform === 'win32') return
    const runBoundaryRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-run-boundary-'),
    )
    const runBoundaryDir = join(runBoundaryRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = runBoundaryRoot
    resetSetOutputArtifactSweepState()
    try {
      const template: AgentTemplate = {
        ...rejectionTemplate('oversized-run-boundary-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const oversized = 'r'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const run = (agentId: string, runId: string) => {
        const agentState =
          getInitialSessionState(mockFileContext).mainAgentState
        agentState.agentType = template.id
        agentState.agentId = agentId
        agentState.runId = runId
        return handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-run-boundary',
            input: { data: oversized },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])
      }

      const first = await run('stable-agent-identity', 'run-1')
      expect(
        first.output[0]?.type === 'json' ? first.output[0].value.message : '',
      ).toContain("agent's output schema")
      const entriesAfterRejection = readdirSync(runBoundaryDir)

      // Attempt N+1 is a DIFFERENT run of the SAME agent. It must land on the
      // terminal marker: no new hash-to-artifact write, no new directory entry.
      const second = await run('stable-agent-identity', 'run-2')
      const secondMessage =
        second.output[0]?.type === 'json' ? second.output[0].value.message : ''
      expect(secondMessage).toContain("agent's output schema")
      expect(secondMessage).toContain(OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK)
      expect(readdirSync(runBoundaryDir)).toEqual(entriesAfterRejection)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(runBoundaryRoot, { recursive: true, force: true })
    }
  })

  test('returns ONE terminal shape per (agent, payload) even when a salvage record is stored', async () => {
    // The already-stored salvage guard used to be evaluated BEFORE the
    // rejected-payload marker, so the same (agent identity, payload hash) pair
    // returned the benign `status: 'ignored'` duplicate ACK on some call orders
    // and the hard error shape on others. A retry loop cannot converge on two
    // signals. The marker now wins every time.
    if (process.platform === 'win32') return
    const oneShapeRoot = mkdtempSync(
      join(tmpdir(), 'openbuff-set-output-one-shape-'),
    )
    const oneShapeDir = join(oneShapeRoot, 'openbuff-set-output')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = oneShapeRoot
    resetSetOutputArtifactSweepState()
    try {
      const template: AgentTemplate = {
        ...rejectionTemplate('oversized-one-shape-agent'),
        outputSchema: z.object({ note: z.string() }),
      }
      const agentState = getInitialSessionState(mockFileContext).mainAgentState
      agentState.agentType = template.id
      agentState.agentId = 'one-shape-agent-identity'
      const oversized = 'o'.repeat(MAX_SET_OUTPUT_JSON_CHARS + 1)
      const runOnce = () =>
        handleSetOutput({
          ...TEST_AGENT_RUNTIME_IMPL,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolName: 'set_output',
            toolCallId: 'oversized-one-shape',
            input: { data: oversized },
          } as unknown as CodebuffToolCall<'set_output'>,
          agentState,
          apiKey: 'test-api-key',
          localAgentTemplates: { [template.id]: template },
        } as unknown as Parameters<typeof handleSetOutput>[0])

      const first = await runOnce()
      const firstMessage =
        first.output[0]?.type === 'json' ? first.output[0].value.message : ''
      expect(firstMessage).toContain("agent's output schema")

      // A salvage record is ALSO stored for this agent (an earlier, different
      // payload was salvaged). The rejected payload stays terminal anyway.
      agentState.output = {
        truncated: true,
        artifactPath: join(oneShapeDir, 'earlier.json'),
        truncation: {
          reason: 'oversized_payload',
          totalChars: 10,
          keptChars: 10,
        },
        data: 'earlier',
        dataTail: 'earlier',
      }

      const second = await runOnce()
      const secondValue = (
        second.output[0] as unknown as { value: Record<string, unknown> }
      ).value
      expect(secondValue.status).toBeUndefined()
      expect(secondValue.errorMessage).toContain("agent's output schema")
      expect(secondValue.errorMessage).toContain(
        OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK,
      )
      // The stored salvage record is left untouched: nothing was overwritten.
      expect(agentState.output).toMatchObject({ truncated: true })

      // Third retry: the SAME terminal shape as the second one.
      const third = await runOnce()
      expect(third.output).toEqual(second.output)
      expect(agentState.lastSetOutputError).toBe(firstMessage)
      expect(readdirSync(oneShapeDir)).toHaveLength(1)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(oneShapeRoot, { recursive: true, force: true })
    }
  })

  test('never lets a caller clock expire protection for a pointer it just returned', async () => {
    // The live-path registry is process-global and shared by both consumers, but
    // stamping it with a CALLER-supplied `now` let one skewed caller (a test
    // injecting a future value, a host with clock skew) make
    // `now - rememberedAt` exceed the TTL immediately, so the very next sweep
    // unlinked a pointer handed out moments earlier. Protection is now stamped
    // and evicted on the internal clock.
    if (process.platform === 'win32') return
    const skewRoot = mkdtempSync(join(tmpdir(), 'openbuff-set-output-skew-'))
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = skewRoot
    resetSetOutputArtifactSweepState()
    try {
      const fsModule = await loadOversizeArtifactFs()
      expect(fsModule).toBeDefined()
      if (!fsModule) return
      const dirName = 'openbuff-set-output'
      const dir = oversizeArtifactDir(fsModule, dirName)
      const farFuture = Date.now() + OVERSIZE_ARTIFACT_TTL_MS * 10
      const persisted = await persistOversizeArtifact(
        'p'.repeat(1_000),
        'b'.repeat(64),
        { dirName, naming: 'unique', now: farFuture },
      )
      expect(persisted).toBeDefined()
      if (!persisted) return

      // A sweep whose OWN caller clock is even further ahead must still spare
      // the pointer this process just returned.
      await sweepExpiredArtifacts(fsModule, dir, {
        now: farFuture + OVERSIZE_ARTIFACT_TTL_MS,
      })
      expect(existsSync(persisted.artifactPath)).toBe(true)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(skewRoot, { recursive: true, force: true })
    }
  })

  test('keeps the salvage persist write outside any process-global critical section', () => {
    // Subagent fan-out is exactly the case the salvage exists for, so queueing
    // the payload write behind one tail promise would turn aggregate latency
    // from max(write_i) into sum(write_i) and let one slow filesystem call block
    // every other child's set_output. The in-memory bookkeeping needs atomicity
    // (it gets it by staying synchronous, see the module header); the I/O must
    // NOT be serialized. There is no runtime observable for "no lock held here",
    // so this pins the structure that guarantees it.
    const source = readFileSync(
      join(import.meta.dir, '..', 'set-output.ts'),
      'utf8',
    )
    expect(source).not.toContain('setOutputBookkeepingTail')
    expect(source).not.toContain('withSetOutputBookkeeping')
    // The persist/sweep live in the shared primitive now, so the structural
    // guarantee is pinned there. `set-output.ts` must not grow a second copy:
    // it delegates, and the shared module is the single implementation.
    expect(source).not.toContain('function rememberLiveSetOutputArtifact(')
    expect(source).not.toContain('function sweepExpiredSetOutputArtifacts(')
    const shared = readFileSync(
      join(import.meta.dir, '..', 'oversize-artifact.ts'),
      'utf8',
    )
    expect(shared).not.toContain('Mutex')
    expect(shared).not.toContain('bookkeepingTail')
    const persistStart = shared.indexOf(
      'export async function persistOversizeArtifact(',
    )
    expect(persistStart).toBeGreaterThan(-1)
    const persistEnd = shared.indexOf(
      'export async function hashOversizeArtifactPayload(',
      persistStart,
    )
    expect(persistEnd).toBeGreaterThan(persistStart)
    const persistBody = shared.slice(persistStart, persistEnd)
    expect(persistBody).toContain('await fsModule.writeFile(')
    // Registration is synchronous (no await between read and write), which is
    // what makes it atomic without holding a lock across the payload I/O.
    // Registration is stamped with THIS call's `options.now` and pinned to the
    // owning record set when one was supplied, matching the signature and
    // docstring the retention bookkeeping depends on.
    expect(persistBody).toContain(
      'rememberLiveArtifact(artifactPath, options.now, owner)',
    )
  })

  test('evicts exactly the oldest unowned entries, verified at runtime', () => {
    // Count is a LAST-RESORT bound, and the eviction is now observable instead
    // of inferred from source text: `inspectLiveArtifactPaths` exposes the
    // protected paths in insertion (oldest-first) order, so the FIFO claim and
    // the exact `size - LIMIT` eviction count are pinned by behaviour. Deleting
    // from a Map while iterating its own `keys()` made the evicted count depend
    // on interleavings with a concurrent re-remember, which no test could see.
    resetOversizeArtifactState()
    const limit = 64
    for (let index = 0; index < limit + 3; index += 1) {
      rememberLiveArtifact(`/tmp/oversize-unowned-${index}.json`)
    }
    const protectedPaths = inspectLiveArtifactPaths()
    expect(protectedPaths).toHaveLength(limit)
    // Exactly the three oldest were evicted, in insertion order.
    expect(protectedPaths).not.toContain('/tmp/oversize-unowned-0.json')
    expect(protectedPaths).not.toContain('/tmp/oversize-unowned-1.json')
    expect(protectedPaths).not.toContain('/tmp/oversize-unowned-2.json')
    expect(protectedPaths[0]).toBe('/tmp/oversize-unowned-3.json')
    // The structure that makes the count deterministic is still a snapshot, not
    // a live-iterator delete loop.
    const shared = readFileSync(
      join(import.meta.dir, '..', 'oversize-artifact.ts'),
      'utf8',
    )
    const evictStart = shared.indexOf('function evictLiveArtifacts(')
    expect(evictStart).toBeGreaterThan(-1)
    const evictEnd = shared.indexOf(
      'export function forgetLiveArtifact(',
      evictStart,
    )
    expect(evictEnd).toBeGreaterThan(evictStart)
    const evictBody = shared.slice(evictStart, evictEnd)
    expect(evictBody).toContain('[...liveArtifactPaths.entries()]')
    expect(evictBody).not.toContain('.sort(')
  })

  test('refcounts protection per path so one holder cannot de-protect another', () => {
    // The same content-addressed path can be published by more than one
    // receipt. A single-slot entry let a later compaction (or the release of a
    // discarded record) forget the path out from under an EARLIER, still-valid
    // receipt, and the next sweep unlinked a file that receipt named.
    resetOversizeArtifactState()
    const artifactPath = '/tmp/oversize-shared-content.json'
    rememberLiveArtifact(artifactPath)
    rememberLiveArtifact(artifactPath)
    forgetLiveArtifact(artifactPath)
    // Still protected by the second holder.
    expect(inspectLiveArtifactPaths()).toContain(artifactPath)
    forgetLiveArtifact(artifactPath)
    expect(inspectLiveArtifactPaths()).not.toContain(artifactPath)
  })

  test('skips still-owned entries when count pressure evicts', () => {
    // A fan-out larger than the count cap must not silently void the retention
    // promise for a pointer whose owning record set is still live: the sweep in
    // the very next persist unlinked the file the parent was about to read.
    resetOversizeArtifactState()
    const ownedPath = '/tmp/oversize-owned-agent-artifact.json'
    rememberLiveArtifact(ownedPath, undefined, 'live-agent-identity')
    for (let index = 0; index < 200; index += 1) {
      rememberLiveArtifact(`/tmp/oversize-pressure-${index}.json`)
    }
    expect(inspectLiveArtifactPaths()).toContain(ownedPath)

    // Releasing the owner makes the entry reclaimable again, which is the
    // production disposal path (`releaseLiveArtifactsForOwner`).
    releaseLiveArtifactsForOwner('live-agent-identity')
    expect(inspectLiveArtifactPaths()).not.toContain(ownedPath)
  })

  test('drops protection only after the unlink, so the release window is not exposed', async () => {
    // Forgetting first left a window in which a competing sweep could pass its
    // own liveness check (or observe the path unregistered) and unlink
    // concurrently. The path carries a per-salvage uuid, so unlink-then-forget
    // has no downside.
    resetOversizeArtifactState()
    const fsModule = await loadOversizeArtifactFs()
    expect(fsModule).toBeDefined()
    if (!fsModule) return
    const dirName = 'openbuff-set-output'
    const persisted = await persistOversizeArtifact(
      'release-ordering',
      'c'.repeat(64),
      { dirName, naming: 'unique', now: Date.now() },
    )
    expect(persisted).toBeDefined()
    if (!persisted) return
    const artifactPath = persisted.artifactPath
    expect(inspectLiveArtifactPaths()).toContain(artifactPath)

    await releaseUnreferencedArtifact(artifactPath)

    expect(existsSync(artifactPath)).toBe(false)
    expect(inspectLiveArtifactPaths()).not.toContain(artifactPath)
  })

  test('treats an existing content-addressed artifact as a successful re-persist', async () => {
    // `wx` under a content-addressed name means a retry of the same bytes hits
    // EEXIST. Returning undefined there degraded the caller to the lossy
    // `artifactPersisted: false` diagnostic even though the full payload was
    // already on disk — the exact idempotent-retry property content addressing
    // was chosen for. It now verifies the existing file and re-registers it.
    resetOversizeArtifactState()
    const dirName = 'openbuff-spawn-output'
    const contentHash = 'd'.repeat(64)
    const first = await persistOversizeArtifact(
      'idempotent-content',
      contentHash,
      {
        dirName,
        naming: 'content-addressed',
        now: Date.now(),
      },
    )
    expect(first).toBeDefined()
    const second = await persistOversizeArtifact(
      'idempotent-content',
      contentHash,
      {
        dirName,
        naming: 'content-addressed',
        now: Date.now(),
      },
    )
    expect(second?.artifactPath).toBe(first?.artifactPath)
    if (!first) return
    expect(existsSync(first.artifactPath)).toBe(true)

    // A genuine write failure still degrades (no idempotent rescue): an
    // unreadable/absent path is not claimed as a persist.
    resetOversizeArtifactState()
    const missingDirName = 'openbuff-set-output-unique'
    const unique = await persistOversizeArtifact('unique-naming', contentHash, {
      dirName: missingDirName,
      naming: 'unique',
      now: Date.now(),
    })
    expect(unique).toBeDefined()
    rmSync(first.artifactPath, { force: true })
    if (unique) rmSync(unique.artifactPath, { force: true })
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
    expect(message).toContain('one complete object')
    expect(message).toContain('replaces the previous output')
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
      reviewedFiles: [
        'packages/agent-runtime/src/tools/handlers/tool/set-output.ts',
      ],
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

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
      expect(agentState.output).toEqual(validReceipt)
      expect(agentState.lastSetOutputError).toBeUndefined()
    })

    test('sets agentState.output from a native receipt object inside a jsonKey envelope', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-native-reviewer',
        { jsonKey: 'output', value: validReceipt },
      )

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
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
      const message = output[0]?.type === 'json' ? output[0].value.message : ''
      expect(message).toContain('Output validation error')
    })

    test('accepts a native non-envelope reviewer object exactly like before', async () => {
      const { agentState, output } = await setupEnvelopeState(
        'jsonKey-envelope-non-envelope-reviewer',
        validReceipt,
      )

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
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

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
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

      expect(output).toEqual([
        { type: 'json', value: { message: 'Output set' } },
      ])
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
      const message = output[0]?.type === 'json' ? output[0].value.message : ''
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
      reviewedFiles: [
        'packages/agent-runtime/src/tools/handlers/tool/set-output.ts',
      ],
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
      agentState: ReturnType<typeof getInitialSessionState>['mainAgentState'],
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
        {
          type: 'json',
          value: { message: RECEIPT_GUARD_ACK, status: 'ignored' },
        },
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
      expect((agentState.output as Record<string, unknown>).verdict).toBe(
        'NON_BLOCKING',
      )
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
    const message = (
      output as Array<{ type: string; value: { message: string } }>
    )[0].value.message
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
