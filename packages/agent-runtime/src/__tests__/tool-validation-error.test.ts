import z from 'zod/v4'

import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  buildReadFilesResultV1,
  fileMutationResultV1Schema,
} from '@codebuff/common/tools/results/filesystem'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { beforeEach, describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { processStream } from '../tools/stream-parser'
import {
  markEditRequiresFreshRead,
  strictEditAuthorizationError,
} from '../tools/handlers/tool/edit-read-state'
import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import {
  buildSpawnAgentsHandlerFailureOutput,
  buildUnavailableToolMessage,
  executeToolCall,
  normalizeNativeToolOutput,
  parseRawCustomToolCall,
  parseRawToolCall,
} from '../tools/tool-executor'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type {
  AssistantMessage,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

describe('tool validation error handling', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
  })

  it('builds terminal spawn reports when validation fails after publication', () => {
    // MIGRATION: the spawn-failure `errorMessage` contract changed. It no
    // longer interpolates the underlying handler error message (the retired
    // format was `Agent spawn failed: <error message>`); it is now the static,
    // leak-safe string asserted below. The underlying error is still logged
    // via logger.warn in executeToolCall. See the migration note on
    // buildSpawnAgentsHandlerFailureOutput in tool-executor.ts.
    const output = buildSpawnAgentsHandlerFailureOutput(
      { agents: [{ agent_type: 'editor' }] },
      new Error('Editor brief is incomplete'),
    )

    expect(output[0]).toMatchObject({
      type: 'json',
      value: [
        {
          agentType: 'editor',
          agentName: 'editor',
          value: {
            errorMessage:
              'Agent spawn failed because the handler could not validate the request.',
          },
        },
      ],
    })
    // The underlying handler error message must NOT leak into the
    // agent-visible output (regression guard for the retired format).
    expect(JSON.stringify(output)).not.toContain('Editor brief is incomplete')
  })

  const testAgentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['spawn_agents', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  it('preserves canonical output, translates legacy mutations, and rejects malformed output', () => {
    const validOutput = jsonToolResult(
      fileMutationResultV1Schema.parse({
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'valid-operation',
        outcome: 'unconfirmed',
        actions: [],
        authorityTier: null,
        errors: [],
        freshCapabilities: [],
      }),
    )
    const valid = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'call-valid',
      output: validOutput,
    })
    expect(valid).toEqual({ valid: true, output: validOutput, issues: [] })

    const legacy = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'call-legacy',
      output: jsonToolResult({
        file: 'src/a.ts',
        message: 'Updated src/a.ts',
      }),
    })
    expect(legacy.valid).toBe(true)
    expect(legacy.output[0]).toEqual(
      expect.objectContaining({
        type: 'json',
        value: expect.objectContaining({
          kind: 'file_mutation_result',
          outcome: 'unconfirmed',
          actions: [expect.objectContaining({ path: 'src/a.ts' })],
        }),
      }),
    )

    const malformed = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'call-malformed',
      output: jsonToolResult({
        file: 'secret/path.ts',
        message: 42,
        content: 'must not leak',
      }) as never,
    })
    expect(malformed.valid).toBe(false)
    expect(malformed.output[0]).toEqual(
      expect.objectContaining({
        type: 'json',
        value: expect.objectContaining({
          kind: 'native_tool_result_error',
          toolName: 'write_file',
          lifecycle: expect.objectContaining({ state: 'failed' }),
        }),
      }),
    )
    expect(JSON.stringify(malformed.output)).not.toContain('secret/path.ts')
    expect(JSON.stringify(malformed.output)).not.toContain('must not leak')

    const canonicalReceipt = {
      kind: 'commit_receipt' as const,
      version: 1 as const,
      receiptId: 'receipt-id',
      operationId: 'receipt-operation',
      callId: 'call-receipt',
      authorityTier: 'portable_path' as const,
      status: 'committed' as const,
      actions: [
        {
          actionId: 'receipt-operation:0',
          index: 0,
          action: 'update' as const,
          path: 'src/recovered.ts',
          status: 'committed' as const,
          beforeHash: 'before',
          afterHash: 'after',
        },
      ],
      finalHashes: { 'src/recovered.ts': 'after' },
    }
    const malformedReceiptOutput = jsonToolResult({
      kind: 'file_mutation_result',
      version: 2,
      operationId: 'receipt-operation',
      outcome: 'applied',
      actions: 'malformed',
      authorityTier: 'portable_path',
      receiptId: 'receipt-id',
      errors: [],
      freshCapabilities: [],
      authorityReceipt: canonicalReceipt,
    }) as never

    const forgedOnly = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'call-receipt',
      output: malformedReceiptOutput,
    })
    expect(forgedOnly.valid).toBe(false)
    expect(forgedOnly.output[0]).toMatchObject({
      type: 'json',
      value: { kind: 'native_tool_result_error' },
    })

    const recovered = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'call-receipt',
      output: malformedReceiptOutput,
      canonicalReceipt,
    })
    expect(recovered.valid).toBe(false)
    expect(recovered.output[0]).toMatchObject({
      type: 'json',
      value: {
        kind: 'file_mutation_result',
        outcome: 'applied',
        actions: [
          expect.objectContaining({
            path: 'src/recovered.ts',
            outcome: 'applied',
          }),
        ],
      },
    })

    const mismatchedCall = normalizeNativeToolOutput({
      toolName: 'write_file',
      toolCallId: 'active-call',
      output: jsonToolResult(
        fileMutationResultV1Schema.parse({
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'other-operation',
          outcome: 'applied',
          actions: [
            {
              actionId: 'other-operation:0',
              index: 0,
              action: 'update',
              path: 'src/other.ts',
              outcome: 'applied',
              beforeHash: 'before',
              afterHash: 'after',
            },
          ],
          authorityTier: 'portable_path',
          receiptId: 'other-receipt',
          authorityReceipt: {
            kind: 'commit_receipt',
            version: 1,
            receiptId: 'other-receipt',
            operationId: 'other-operation',
            callId: 'different-call',
            authorityTier: 'portable_path',
            status: 'committed',
            actions: [
              {
                actionId: 'other-operation:0',
                index: 0,
                action: 'update',
                path: 'src/other.ts',
                status: 'committed',
                beforeHash: 'before',
                afterHash: 'after',
              },
            ],
            finalHashes: { 'src/other.ts': 'after' },
          },
          errors: [],
          freshCapabilities: [],
        }),
      ),
      canonicalReceipt: {
        ...canonicalReceipt,
        receiptId: 'other-receipt',
        operationId: 'other-operation',
        callId: 'different-call',
        actions: [
          {
            ...canonicalReceipt.actions[0],
            actionId: 'other-operation:0',
            path: 'src/other.ts',
          },
        ],
        finalHashes: { 'src/other.ts': 'after' },
      },
    })
    expect(mismatchedCall.valid).toBe(false)
    expect(mismatchedCall.output[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'unconfirmed' },
    })
  })

  it('should parse repeatedly stringified native tool input before validation', () => {
    const input = {
      path: 'test.ts',
      instructions: 'Writes a test file',
      content: 'console.log("test")\n',
    }

    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'double-stringified-tool-call-id',
        input: JSON.stringify(JSON.stringify(input)),
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual(input)
    }
  })

  it('repairs duplicate JSON separators in stringified read_files input', () => {
    const input = {
      paths: ['src/components/garden/GardenCanvas.tsx'],
      ranges: [
        {
          path: 'src/components/garden/GardenCanvas.tsx',
          startLine: 250,
          endLine: 348,
        },
      ],
    }
    const malformed = JSON.stringify(input).replace(
      '],"ranges"',
      '],, "ranges"',
    )

    for (const encoded of [malformed, JSON.stringify(malformed)]) {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'read_files',
          toolCallId: 'duplicate-json-separator-tool-call-id',
          input: encoded,
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input).toEqual(input)
      }
    }
  })

  it('repairs duplicate separators for custom and MCP tool inputs', () => {
    for (const toolName of ['custom_search', 'server__search']) {
      const result = parseRawCustomToolCall({
        customToolDefs: {
          [toolName]: {
            description: 'Search',
            endsAgentStep: false,
            inputSchema: z.object({
              query: z.string(),
              note: z.string(),
            }),
          },
        },
        rawToolCall: {
          toolName,
          toolCallId: `${toolName}-duplicate-separator`,
          input: '{"query":"garden",,"note":"keep,,literal"}',
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input).toEqual({
          query: 'garden',
          note: 'keep,,literal',
        })
      }
    }
  })

  it('does not alter duplicate commas inside JSON string values', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'code_search',
        toolCallId: 'literal-duplicate-comma-tool-call-id',
        input: '{"pattern":"alpha,,beta"}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ pattern: 'alpha,,beta', maxResults: 15 })
    }
  })

  it('still rejects truncated JSON containing duplicate separators', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'read_files',
        toolCallId: 'truncated-duplicate-separator-tool-call-id',
        input: '{"paths":["src/a.ts"],, "ranges":[',
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Parsing as JSON failed:')
    }
  })

  it('should preserve provider options from parsed native tool calls', () => {
    const providerOptions = {
      openaiCompatible: {
        extra_content: {
          google: {
            thought_signature: 'sig-123',
          },
        },
      },
    }

    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'read_files',
        toolCallId: 'provider-metadata-tool-call-id',
        input: { paths: ['test.ts'] },
        providerOptions,
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.providerOptions).toEqual(providerOptions)
    }
  })

  it('should repair bare path values for list_directory string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'list_directory',
        toolCallId: 'bare-path-tool-call-id',
        input: '{"path": app/src/api/agents}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ path: 'app/src/api/agents' })
    }
  })

  it('should repair bare pattern values for glob string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'glob',
        toolCallId: 'bare-pattern-tool-call-id',
        input: '{"pattern": backend/src/templates/agents/git-committer.ts}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({
        pattern: 'backend/src/templates/agents/git-committer.ts',
      })
    }
  })

  it('should repair bare paths values for read_files string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'read_files',
        toolCallId: 'bare-paths-tool-call-id',
        input: '{"paths": sdk/src/client.ts}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ paths: ['sdk/src/client.ts'] })
    }
  })

  it('should repair a singular path alias for read_files object input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'read_files',
        toolCallId: 'singular-path-alias-tool-call-id',
        input: { path: 'src/components/garden/scenes/LivingOrganism.tsx' },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({
        paths: ['src/components/garden/scenes/LivingOrganism.tsx'],
      })
    }
  })

  it('should not repair bare path values for unrelated tools', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'unrelated-bare-path-tool-call-id',
        input: '{"path": app/src/api/agents}',
      },
    })

    expect('error' in result).toBe(true)
  })

  it('should hint that atomic must be a boolean when str_replace receives a string (Fix D)', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'str-replace-atomic-string-tool-call-id',
        input: { path: 'f.ts', atomic: 'yes', replacements: [] },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('`atomic` must be a boolean')
    }
  })

  it('should hint that basedOnRead must be a cap.v3 token when str_replace receives a wrong shape (Fix D)', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'str-replace-basedonread-shape-tool-call-id',
        input: {
          path: 'f.ts',
          replacements: [
            {
              oldString: 'a',
              newString: 'b',
              allowMultiple: false,
              // Object forms are rejected; callers must copy the cap.v3 token.
              basedOnRead: { $text: 'cap.something' },
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('authenticated cap.v3 readCapability')
      expect(result.error).toContain('Object-form anchors')
      expect(result.error).not.toContain('OR an object')
    }
  })

  it('should hint that occurrenceIndex must be a positive integer when str_replace receives a string (Fix D)', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'str-replace-occurrenceindex-string-tool-call-id',
        input: {
          path: 'f.ts',
          replacements: [
            {
              oldString: 'a',
              newString: 'b',
              allowMultiple: false,
              occurrenceIndex: '0',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('`occurrenceIndex` must be')
    }
  })

  it('gives actionable recovery when get_build_targets receives no changed files', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'get_build_targets',
        toolCallId: 'get-build-targets-empty-files-tool-call-id',
        input: { files: [] },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Raw validation issues:')
      expect(result.error).toContain('"code": "too_small"')
      expect(result.error).toContain(
        '`files` must be a non-empty array of changed project-relative file paths',
      )
      expect(result.error).toContain(
        '{ "files": ["packages/agent-runtime/src/tools/tool-executor.ts"] }',
      )
      expect(result.error).toContain(
        'do not call `get_build_targets`; skip build-target discovery until a concrete changed-file list exists',
      )
      expect(result.formattedInput).toContain('<root>:')
      expect(result.formattedInput).toContain('"files": []')
    }
  })

  it('should parse stringified params for spawn_agents entries', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-stringified-params-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'basher',
              prompt: 'Run tests',
              params: '{"command":"bun test"}',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({ command: 'bun test' })
    }
  })

  it('should repair provider-tagged Basher params before validation', () => {
    const command =
      'ls -la /tmp/garden-rose-evidence/ 2>/dev/null; echo "---"; ls -la assets/garden/ 2>/dev/null; echo "---"; ls -la public/models/ 2>/dev/null'
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-tagged-basher-params-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'basher',
              params: `command</arg_key><arg_value>${command}`,
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({ command })
    }
  })

  it('should move an explicit top-level Basher command into params', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-top-level-command-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'basher',
              command: 'bun test',
              params: {},
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({ command: 'bun test' })
    }
  })

  it('should recover an explicitly labelled specialist snapshot after compaction', () => {
    const snapshot = 'v3:' + 'e'.repeat(64)
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-specialist-snapshot-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'compatibility-reviewer',
              prompt: `Perform the routed review.\nSnapshot ID to verify: ${snapshot}`,
              params: { timeout_seconds: 300 },
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({
        timeout_seconds: 300,
        snapshot_id: snapshot,
      })
    }
  })

  it('does not recover bare hex labelled Snapshot ID after compaction', () => {
    const bareHex = 'e'.repeat(64)
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-bare-hex-snapshot-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'compatibility-reviewer',
              prompt: `Perform the routed review.\nSnapshot ID to verify: ${bareHex}`,
              params: { timeout_seconds: 300 },
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({
        timeout_seconds: 300,
      })
    }
  })

  it('repairs double-stringified spawn_agents lists and stringified entries', () => {
    const entry = {
      agent_type: 'basher',
      prompt: 'Run tests',
      params: { command: 'bun test' },
    }
    for (const agents of [
      JSON.stringify(JSON.stringify([entry])),
      [JSON.stringify(entry)],
    ]) {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'spawn_agents',
          toolCallId: 'spawn-agents-deep-string-tool-call-id',
          input: { agents },
        },
      })
      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.agents).toEqual([entry])
      }
    }
  })

  it('gives actionable recovery for a validation issue at agents.0.handoff', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-incomplete-handoff-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'repair-editor',
              handoff: {
                schemaVersion: 1,
                truncatedEvidence: 'authority-bearing-secret-fragment',
              },
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('agents[0].handoff')
      expect(result.error).toContain('"handoff"?: object')
      expect(result.error).toContain(
        'one complete compact canonical `AgentHandoff` object',
      )
      for (const field of [
        'schemaVersion',
        'taskId',
        'objective',
        'role',
        'requirements',
        'acceptanceCriteria',
        'context',
        'nonGoals',
        'findings',
        'permissions',
      ]) {
        expect(result.error).toContain(`\`${field}\``)
      }
      expect(result.error).toContain(
        'Truncated handoffs cannot be repaired safely',
      )
      expect(result.error).toContain('Keep evidence compact')
      expect(result.formattedInput).toContain(
        'invalid handoff payload omitted',
      )
      expect(result.formattedInput).not.toContain(
        'authority-bearing-secret-fragment',
      )
    }
  })

  it('rejects mis-braced serialized spawn payloads with field-placement guidance', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-misbraced-tool-call-id',
        // Two agent entries with a stray top-level `prompt`: it is ambiguous
        // which agent the sibling belongs to, so this stays fail-closed and
        // is not auto-repaired (unlike the single-agent fold case below).
        input:
          '{"agents":[{"agent_type":"thinker"},{"agent_type":"file-picker"}],"prompt":"outside-agent"}',
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        '`prompt`, `params`, and `handoff` must be inside each agent object',
      )
      expect(result.error).toContain('check every brace and bracket')
      expect(result.error).toContain('ambiguous brace nesting')
    }
  })

  it('repairs a single-agent stray-sibling spawn payload by folding prompt into the entry', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-single-agent-fold-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'code-searcher',
              params: { searchQueries: [{ pattern: 'x' }] },
            },
          ],
          prompt: 'find x',
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].prompt).toBe('find x')
      expect(result.input.agents[0].params).toEqual({
        searchQueries: [{ pattern: 'x' }],
      })
    }
  })

  it('still rejects a multi-entry spawn array with stray sibling fields', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-multi-entry-stray-sibling-tool-call-id',
        input: {
          agents: [{ agent_type: 'a' }, { agent_type: 'b' }],
          prompt: 'x',
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        '`prompt`, `params`, and `handoff` must be inside each agent object',
      )
    }
  })

  it('does not overwrite an existing in-entry prompt when folding a single-agent stray sibling', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-single-agent-no-overwrite-tool-call-id',
        input: {
          agents: [{ agent_type: 'code-searcher', prompt: 'inner' }],
          prompt: 'outer',
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].prompt).toBe('inner')
    }
  })

  it('shows the corrected spawn shape inline when agents is an invalid JSON string', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-corrected-shape-hint-tool-call-id',
        input: { agents: 'not valid json {' },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Corrected example:')
      expect(result.error).toContain('INSIDE each agent object')
    }
  })

  it('rejects the original stringified agents array with a mis-braced prompt and points at the corrected shape', () => {
    // Reproduces the exact real-world failure: the whole `agents` value was
    // emitted as a JSON string, and inside it a stray `"prompt": "..."` pair
    // floats as a sibling *array element* rather than a key inside the first
    // agent object. That inner text is not valid JSON, so it cannot be
    // auto-repaired and must fail closed with corrected-shape guidance.
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-stringified-misbraced-prompt-tool-call-id',
        input: {
          agents:
            '[{"agent_type": "code-searcher", "params": {"searchQueries": [{"pattern": "serialized handleSteps", "flags": "-g *.ts"}]}}, "prompt": "Find the test in the agents test suite."}]',
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Corrected example:')
      expect(result.error).toContain('INSIDE each agent object')
    }
  })

  it('gives spawn-specific recovery for truncated agent JSON', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-truncated-tool-call-id',
        input: { agents: '[{"agent_type":' },
      },
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Pass agents as an array of objects')
      expect(result.error).toContain('truncated JSON')
      expect(result.error).toContain('"handoff"?: object')
      expect(result.error).not.toContain('canonical `AgentHandoff`')
    }
  })

  it('recovers a comma-split fragment array for spawn_agents', () => {
    const agents = [
      {
        agent_type: 'basher',
        prompt: 'Run tests',
        params: { command: 'bun test' },
      },
      { agent_type: 'thinker', prompt: 'Think about architecture' },
    ]
    // Simulate a transport that stringified the array then split on commas.
    const fragments = JSON.stringify(agents).split(',')
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-comma-split-recovery-tool-call-id',
        input: { agents: fragments },
      },
    })
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents).toEqual(agents)
    }
  })

  it('produces a single field-level error for unrecoverable comma-split fragments', () => {
    // 130+ comma-split fragments of a truncated stringified array.
    const fragments = JSON.stringify([
      {
        agent_type: 'file-picker',
        prompt:
          'Find files about authentication, sessions, tokens, cookies, JWT, OAuth, security, middleware, hashing, encryption, passwords, secrets, keys, vaults, crypto',
      },
    ])
      .slice(0, -2)
      .split(',')
    expect(fragments.length).toBeGreaterThan(10) // sanity: enough to be noisy
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-comma-split-unrecoverable-tool-call-id',
        input: { agents: fragments },
      },
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      // Must contain the actionable hint, not 130+ per-element issues.
      expect(result.error).toContain('Pass agents as an array of objects')
      // Must NOT contain per-element diagnostics (the whole point of the fix).
      expect(result.error).not.toContain('agents[0]')
      expect(result.error).not.toContain('agents[1]')
      expect(result.error).not.toContain('agents[10]')
      expect(result.error).not.toContain('expected object, received string')
    }
  })

  it('should parse stringified params for spawn_agent_inline', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agent_inline',
        toolCallId: 'spawn-agent-inline-stringified-params-tool-call-id',
        input: {
          agent_type: 'basher',
          prompt: 'Run tests',
          params: '{"command":"bun test"}',
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.params).toEqual({ command: 'bun test' })
    }
  })

  it('should summarize missing native tool fields clearly', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'run_terminal_command',
        toolCallId: 'missing-command-tool-call-id',
        input: {},
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Missing required: command')
    }
  })

  describe('run_terminal_command scalar coercion', () => {
    it('coerces string "false"/"60" to boolean/number before validation', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-coerce-scalars-tool-call-id',
          input: {
            command: 'echo hi',
            detach: 'false',
            timeout_seconds: '60',
            process_type: 'SYNC',
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.detach).toBe(false)
        expect(result.input.timeout_seconds).toBe(60)
      }
    })

    it('coerces string "true" detach to boolean true', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-coerce-detach-true-tool-call-id',
          input: { command: 'echo hi', detach: 'true' },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.detach).toBe(true)
      }
    })

    it('leaves already-correct scalar types untouched', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-correct-types-tool-call-id',
          input: { command: 'echo hi', detach: true, timeout_seconds: -1 },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.detach).toBe(true)
        expect(result.input.timeout_seconds).toBe(-1)
      }
    })

    it('fails closed and hints when timeout_seconds cannot be coerced', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-uncoercible-timeout-tool-call-id',
          input: { command: 'echo hi', timeout_seconds: 'soon' },
        },
      })

      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('timeout_seconds')
        // The ambiguous string is never silently turned into a number.
        expect(result.error).not.toContain('timeout_seconds": 0')
      }
    })

    it('fails closed for an ambiguous detach string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-ambiguous-detach-tool-call-id',
          input: { command: 'echo hi', detach: 'yes' },
        },
      })

      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('detach')
      }
    })

    it('coerces a negative timeout_seconds string via the tool-specific repair', () => {
      // Pins the documented gap on coerceInputScalarsBySchema: the generic
      // schema walk only coerces non-negative integer strings (/^\d+$/), so a
      // negative "-1" is intentionally NOT coerced there. Negative timeouts are
      // instead handled by repairTerminalCommandScalars (which allows a leading
      // minus), exactly as the comment on coerceInputScalarsBySchema states.
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'run_terminal_command',
          toolCallId: 'terminal-negative-timeout-tool-call-id',
          input: { command: 'echo hi', timeout_seconds: '-1' },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.timeout_seconds).toBe(-1)
      }
    })
  })

  describe('edit_transaction scalar coercion', () => {
    it('coerces stringified replacement scalars before validation', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'edit_transaction',
          toolCallId: 'transaction-coerce-scalars-tool-call-id',
          input: {
            edits: [
              {
                type: 'str_replace',
                path: 'src/a.ts',
                replacements: [
                  {
                    oldString: 'a',
                    newString: 'b',
                    allowMultiple: 'false',
                    occurrenceIndex: '1',
                  },
                ],
              },
            ],
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        const edit = result.input.edits[0]
        expect(edit.type).toBe('str_replace')
        if (edit.type === 'str_replace') {
          expect(edit.replacements[0].allowMultiple).toBe(false)
          expect(edit.replacements[0].occurrenceIndex).toBe(1)
        }
      }
    })

    it('fails closed for an ambiguous allowMultiple string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'edit_transaction',
          toolCallId: 'transaction-ambiguous-allowmultiple-tool-call-id',
          input: {
            edits: [
              {
                type: 'str_replace',
                path: 'src/a.ts',
                replacements: [
                  {
                    oldString: 'a',
                    newString: 'b',
                    allowMultiple: 'yes',
                  },
                ],
              },
            ],
          },
        },
      })

      expect('error' in result).toBe(true)
    })
  })

  describe('str_replace scalar coercion', () => {
    it('coerces stringified atomic and per-replacement scalars before validation', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'str_replace',
          toolCallId: 'str-replace-coerce-scalars-tool-call-id',
          input: {
            path: 'src/a.ts',
            atomic: 'true',
            replacements: [
              {
                oldString: 'a',
                newString: 'b',
                allowMultiple: 'false',
                occurrenceIndex: '1',
              },
              {
                oldString: 'c',
                newString: '',
                skipIfMissing: 'true',
              },
            ],
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.atomic).toBe(true)
        expect(result.input.replacements[0].allowMultiple).toBe(false)
        expect(result.input.replacements[0].occurrenceIndex).toBe(1)
        expect(result.input.replacements[1].skipIfMissing).toBe(true)
      }
    })

    it('fails closed for an ambiguous atomic string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'str_replace',
          toolCallId: 'str-replace-ambiguous-atomic-tool-call-id',
          input: {
            path: 'src/a.ts',
            atomic: 'yes',
            replacements: [{ oldString: 'a', newString: 'b' }],
          },
        },
      })

      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('atomic')
      }
    })

    it('fails closed for a zero occurrenceIndex string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'str_replace',
          toolCallId: 'str-replace-zero-occurrenceindex-tool-call-id',
          input: {
            path: 'src/a.ts',
            replacements: [
              { oldString: 'a', newString: 'b', occurrenceIndex: '0' },
            ],
          },
        },
      })

      expect('error' in result).toBe(true)
    })

    it('never coerces content-bearing strings', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'str_replace',
          toolCallId: 'str-replace-content-untouched-tool-call-id',
          input: {
            path: 'src/a.ts',
            replacements: [{ oldString: 'true', newString: 'false' }],
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.replacements[0].oldString).toBe('true')
        expect(result.input.replacements[0].newString).toBe('false')
      }
    })
  })

  describe('replace_range scalar coercion', () => {
    const hash = getContentHash('line')
    const readCapability = encodeReadCapabilityToken({
      startLine: 100,
      endLine: 156,
      hash,
      scope: {
        projectId: mockFileContext.projectRoot,
        path: 'src/a.ts',
        runId: 'test-run-id',
      },
    })

    it('coerces stringified startLine/endLine before validation', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'replace_range',
          toolCallId: 'replace-range-coerce-lines-tool-call-id',
          input: {
            path: 'src/a.ts',
            readCapability,
            startLine: '105',
            endLine: '110',
            newContent: 'replacement',
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.startLine).toBe(105)
        expect(result.input.endLine).toBe(110)
      }
    })

    it('coerces stringified occurrence.occurrence before validation', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'replace_range',
          toolCallId: 'replace-range-coerce-occurrence-tool-call-id',
          input: {
            path: 'src/a.ts',
            readCapability,
            occurrence: { match: 'literal block', occurrence: '2' },
            newContent: 'replacement',
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.occurrence?.occurrence).toBe(2)
      }
    })

    it('fails closed for a non-integer startLine string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'replace_range',
          toolCallId: 'replace-range-ambiguous-startline-tool-call-id',
          input: {
            path: 'src/a.ts',
            readCapability,
            startLine: '1.5',
            endLine: '110',
            newContent: 'replacement',
          },
        },
      })

      expect('error' in result).toBe(true)
    })

    it('never coerces occurrence.match', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'replace_range',
          toolCallId: 'replace-range-match-untouched-tool-call-id',
          input: {
            path: 'src/a.ts',
            readCapability,
            occurrence: { match: '123', occurrence: '1' },
            newContent: 'replacement',
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.occurrence?.match).toBe('123')
        expect(result.input.occurrence?.occurrence).toBe(1)
      }
    })
  })

  describe('generic schema-driven scalar coercion', () => {
    it('coerces a stringified integer limit for query_index', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'query_index',
          toolCallId: 'generic-coerce-limit-tool-call-id',
          input: { query: 'authentication', limit: '10' },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.limit).toBe(10)
      }
    })

    it('coerces stringified integer startLine/endLine in read_files ranges', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'read_files',
          toolCallId: 'generic-coerce-range-lines-tool-call-id',
          input: {
            ranges: [{ path: 'a.ts', startLine: '5', endLine: '10' }],
          },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        const range = result.input.ranges![0]
        expect(range.startLine).toBe(5)
        expect(range.endLine).toBe(10)
      }
    })

    it('fails closed for an uncoercible integer string', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'query_index',
          toolCallId: 'generic-coerce-fail-closed-tool-call-id',
          input: { query: 'authentication', limit: 'soon' },
        },
      })

      expect('error' in result).toBe(true)
    })

    it('never coerces string-typed fields that look numeric', () => {
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'glob',
          toolCallId: 'generic-coerce-string-untouched-tool-call-id',
          input: { pattern: '123' },
        },
      })

      expect('error' in result).toBe(false)
      if (!('error' in result)) {
        expect(result.input.pattern).toBe('123')
      }
    })

    it('leaves negative integer strings uncoerced on the generic path (fail closed)', () => {
      // Companion to the run_terminal_command negative-timeout test: the generic
      // schema-driven coercion (coerceIntString, /^\d+$/) intentionally skips
      // negative integer strings, and query_index has no tool-specific negative
      // repair. A "-1" limit string is therefore left untouched and fails closed
      // (the field's positive bound also rejects a coerced -1) rather than being
      // silently guessed into a number.
      const result = parseRawToolCall({
        rawToolCall: {
          toolName: 'query_index',
          toolCallId: 'generic-negative-int-tool-call-id',
          input: { query: 'authentication', limit: '-1' },
        },
      })

      expect('error' in result).toBe(true)
    })
  })

  it('should accept old_str/new_str aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old_str: 'before',
              new_str: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should accept old/new aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'short-alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old: 'before',
              new: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should accept old_string/new_string aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'long-alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old_string: 'before',
              new_string: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should discard a trailing operation-less str_replace placeholder', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'trailing-placeholder-tool-call-id',
        input: {
          path: 'server/src/services/ip.ts',
          atomic: false,
          replacements: [
            { oldString: 'before one', newString: 'after one' },
            { oldString: 'before two', newString: 'after two' },
            {},
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        {
          oldString: 'before one',
          newString: 'after one',
          allowMultiple: false,
        },
        {
          oldString: 'before two',
          newString: 'after two',
          allowMultiple: false,
        },
      ])
    }
  })

  it('should parse a JSON-stringified edit_transaction edits array', () => {
    const edits = [
      {
        id: 'sanitize-ip-package-filename',
        path: 'server/src/http/fileRoutes.ts',
        type: 'str_replace',
        replacements: [
          {
            oldString: 'const downloadName = title',
            newString: 'const downloadName = sanitize(title)',
          },
        ],
      },
    ]
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'stringified-transaction-edits-tool-call-id',
        input: { edits: JSON.stringify(edits) },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.edits).toMatchObject(edits)
    }
  })

  it('recovers a comma-split serialized edit_transaction array', () => {
    const edits = [
      {
        id: 'update-helper',
        path: 'src/helper.ts',
        type: 'str_replace',
        replacements: [
          {
            oldString: 'const value = 1',
            newString: 'const value = 2',
          },
        ],
      },
    ]
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'comma-split-transaction-edits-tool-call-id',
        input: { edits: JSON.stringify(edits).split(',') },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.edits).toMatchObject(edits)
    }
  })

  it('should infer str_replace for an edit_transaction entry with replacements and no type', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'missing-transaction-type-tool-call-id',
        input: {
          edits: [
            {
              id: 'upload-imports',
              path: 'client/src/routes/dashboard.upload.tsx',
              replacements: [
                {
                  oldString: 'import { Upload } from "lucide-react";',
                  newString: 'import { Upload, Info } from "lucide-react";',
                },
              ],
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.edits[0]).toMatchObject({
        id: 'upload-imports',
        path: 'client/src/routes/dashboard.upload.tsx',
        type: 'str_replace',
      })
    }
  })

  it('gives field-level recovery for a truncated serialized edit_transaction array', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'truncated-transaction-edits-tool-call-id',
        input: {
          edits:
            '[{"id":"fix-tooltip","path":"Tooltip.tsx","type":"str_replace","replacements":[',
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('edits: Invalid input: expected array')
      expect(result.error).not.toContain('edits[0]')
      expect(result.error).toContain(
        'Pass `edits` as an actual array of objects',
      )
      expect(result.error).toContain('cannot be reconstructed')
    }
  })

  it('gives capability-specific transaction recovery and preserves the failing edit excerpt', () => {
    const hash = getContentHash('line')
    const readCapability = encodeReadCapabilityToken({
      startLine: 100,
      endLine: 156,
      hash,
      scope: {
        projectId: mockFileContext.projectRoot,
        path: 'agents/base2/base2.ts',
        runId: 'test-run-id',
      },
    })
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'mixed-range-target',
        input: {
          edits: [
            {
              type: 'replace_range',
              path: 'agents/base2/base2.ts',
              readCapability,
              startLine: 105,
              endLine: 105,
              expectedHash: hash,
              newContent: "      'run_targeted_validation',",
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Unrecognized key: "expectedHash"')
      expect(result.error).toContain(
        'provide both to target a contained sub-range',
      )
      expect(result.error).toContain('Never pass expectedHash')
      expect(result.error).not.toContain('re-read the exact target lines first')
      expect(result.error).not.toContain(
        'Pass `edits` as an actual array of objects',
      )
      expect(result.formattedInput).toContain('agents/base2/base2.ts')
      expect(result.formattedInput).toContain('run_targeted_validation')
    }
  })

  it('gives deletion-specific recovery for transaction skipIfMissing misuse', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'non-deletion-skip',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: 'src/a.ts',
              replacements: [
                {
                  oldString: 'before',
                  newString: 'after',
                  skipIfMissing: true,
                },
              ],
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('deletion-only')
      expect(result.error).not.toContain(
        'Pass `edits` as an actual array of objects',
      )
      expect(result.formattedInput).toContain('"newString": "after"')
    }
  })

  it('should not infer ambiguous content-only edit_transaction types', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'ambiguous-transaction-type-tool-call-id',
        input: {
          edits: [{ path: 'src/new.ts', content: 'export const value = 1' }],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('edits[0].type')
      expect(result.error).toContain('No matching discriminator')
      expect(result.error).toContain('Valid types:')
      expect(result.error).toContain('set `type` explicitly')
    }
  })

  it('names the offending edit type in the edit_transaction discriminator hint', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'edit_transaction',
        toolCallId: 'named-bad-transaction-type-tool-call-id',
        input: {
          edits: [
            {
              path: 'src/x.ts',
              type: 'totally_wrong',
              content: 'export const v = 1',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('edits[0].type')
      expect(result.error).toContain('"totally_wrong"')
      expect(result.error).toContain('is not a valid edit type')
      expect(result.error).toContain('Valid types:')
    }
  })

  it('should summarize missing replacement fields without implying deletion', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'missing-new-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            { oldString: 'before', newString: 'after' },
            { oldString: 'delete me' },
            { oldString: 'delete me too' },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Missing required replacement fields:')
      expect(result.error).toContain('- replacements[1].newString')
      expect(result.error).toContain('- replacements[2].newString')
      expect(result.error).toContain(
        'If the intent is deletion, set "newString": "" explicitly.',
      )
      expect(result.error).toContain('Raw validation issues:')
      expect(result.error).toContain(
        're-read the exact current lines with read_files',
      )
    }
  })

  it('rejects explicit edit placeholders before handler execution', () => {
    for (const rawToolCall of [
      {
        toolName: 'str_replace' as const,
        toolCallId: 'placeholder-str-replace',
        input: {
          path: 'src/a.ts',
          replacements: [
            { oldString: '[see patch above]', newString: 'const a = 1' },
          ],
        },
      },
      {
        toolName: 'edit_transaction' as const,
        toolCallId: 'placeholder-edit-transaction',
        input: {
          edits: [
            {
              type: 'str_replace' as const,
              path: 'src/a.ts',
              replacements: [
                { oldString: '[see patch above]', newString: 'const a = 1' },
              ],
            },
          ],
        },
      },
    ]) {
      const result = parseRawToolCall({ rawToolCall })
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('explicit placeholder')
        expect(result.error).toContain('exact current')
      }
    }
  })

  it('should include failed-edit recovery guidance for invalid replacement shapes', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'invalid-replacement-shape-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [{ oldString: 'before' }],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'stop retrying from memory: re-read the exact current lines with read_files',
      )
    }
  })

  it('should include JSON parse details for incomplete stringified input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'incomplete-stringified-tool-call-id',
        input:
          '{"path": ".agents/deep-thinkers/meta-coordinator.ts", "instructions": "Creates a meta-coordinator"',
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'expected the tool arguments to be an object, but received a string',
      )
      expect(result.error).toContain('Parsing as JSON failed:')
      expect(result.error).toContain(
        'The arguments may be malformed or incomplete',
      )
    }
  })

  it('gives set_output-specific recovery for incomplete stringified input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'set_output',
        toolCallId: 'incomplete-set-output-tool-call-id',
        input: '{"data":{"schemaVersion":3,"findings":[',
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Pass the result as an object directly')
      expect(result.error).toContain('Do not JSON.stringify')
      expect(result.error).toContain('Keep findings and evidence compact')
    }
  })

  it('publishes set_output when data contains incomplete JSON so the handler can request a retry', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'set_output',
        toolCallId: 'string-data-set-output-tool-call-id',
        input: { data: '{"schemaVersion":3,"findings":[' },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input as unknown).toEqual({
        data: '{"schemaVersion":3,"findings":[',
      })
    }
  })

  it('returns a tool result instead of an error event for incomplete set_output data', async () => {
    const reviewer: AgentTemplate = {
      ...testAgentTemplate,
      id: 'reviewer-test',
      toolNames: ['set_output'],
      outputSchema: z.object({ verdict: z.string() }),
    }
    // Unrecoverable incomplete JSON that remains a string after decode (product
    // recovery may complete `{"verdict":"LOOKS_GOOD"` into a valid object).
    const invalidOutput: StreamChunk = {
      type: 'tool-call',
      toolName: 'set_output',
      toolCallId: 'incomplete-set-output-tool-call-id',
      input: { data: '{"verdict":' },
    }
    async function* mockStream() {
      yield invalidOutput
      return promptSuccess('mock-message-id')
    }
    const responseChunks: (string | PrintModeEvent)[] = []
    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.agentType = reviewer.id

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'test-step-id',
      agentTemplate: reviewer,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { [reviewer.id]: reviewer },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const events = responseChunks.filter(
      (chunk): chunk is PrintModeEvent => typeof chunk !== 'string',
    )
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolName: 'set_output',
      toolCallId: 'incomplete-set-output-tool-call-id',
      output: [
        {
          type: 'json',
          value: {
            message: expect.stringContaining(
              'malformed or incomplete JSON text',
            ),
          },
        },
      ],
    })
    expect(sessionState.mainAgentState.output).toBeUndefined()
  })

  it('repairs a complete JSON-stringified set_output data object', () => {
    const data = {
      schemaVersion: 3,
      family: 'reviewer',
      verdict: 'NON_BLOCKING',
    }
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'set_output',
        toolCallId: 'string-data-set-output-tool-call-id',
        input: { data: JSON.stringify(data) },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ data })
    }
  })

  it('should explain when parsed tool input remains a string', () => {
    const input = JSON.stringify(
      JSON.stringify(
        JSON.stringify(
          JSON.stringify({
            path: 'test.ts',
            instructions: 'Writes a test file',
            content: 'console.log("test")\n',
          }),
        ),
      ),
    )

    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'over-encoded-tool-call-id',
        input,
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'expected the tool arguments to be an object, but received a string',
      )
      expect(result.error).toContain(
        'Parsing succeeded, but the parsed value was still a string',
      )
      expect(result.error).not.toContain('malformed or incomplete')
    }
  })

  it('should emit error event instead of tool result when spawn_agents receives invalid parameters', async () => {
    // This simulates what happens when the LLM passes a string instead of an array to spawn_agents
    // The error from Anthropic was: "Invalid parameters for spawn_agents: expected array, received string"
    const invalidToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName: 'spawn_agents',
      toolCallId: 'test-tool-call-id',
      input: {
        agents: 'this should be an array not a string', // Invalid - should be array
      },
    }

    async function* mockStream() {
      yield invalidToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: testAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': testAgentTemplate },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    // Verify an error event was emitted (not a tool result)
    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      'Invalid parameters for spawn_agents',
    )
    expect(errorEvents[0].message).toContain('Relevant invalid input excerpts:')
    expect(errorEvents[0].message).toContain(
      'this should be an array not a string',
    )

    // The agent keeps the full detailed `message`; the concise `userMessage`
    // is a calm one-liner for the CLI banner that never carries the raw
    // validation wall.
    expect(typeof errorEvents[0].userMessage).toBe('string')
    expect((errorEvents[0].userMessage ?? '').length).toBeGreaterThan(0)
    expect(errorEvents[0].userMessage).not.toContain('Raw validation issues')

    // Verify hadToolCallError is true so the agent loop continues
    expect(result.hadToolCallError).toBe(true)

    // Verify NO tool_call event was emitted (since validation failed before that point)
    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(0)

    // Verify NO tool_result event was emitted
    const toolResultEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_result' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_result',
    )
    expect(toolResultEvents.length).toBe(0)

    // Verify the message history doesn't contain orphan tool results
    // It should NOT have any tool messages since no tool call was made
    const toolMessages = agentState.messageHistory.filter(
      (m) => m.role === 'tool',
    )
    const assistantToolCalls = agentState.messageHistory.filter(
      (m) =>
        m.role === 'assistant' && m.content.some((c) => c.type === 'tool-call'),
    )

    // There should be no tool messages at all (the key fix!)
    expect(toolMessages.length).toBe(0)
    // And no assistant tool calls either
    expect(assistantToolCalls.length).toBe(0)

    // Verify error message was added to message history for the LLM to see
    const userMessages = agentState.messageHistory.filter(
      (m) => m.role === 'user',
    )
    const errorUserMessage = userMessages.find((m) => {
      const contentStr = Array.isArray(m.content)
        ? m.content.map((p) => ('text' in p ? p.text : '')).join('')
        : typeof m.content === 'string'
          ? m.content
          : ''
      return (
        contentStr.includes('Error during tool call') &&
        contentStr.includes('Invalid parameters for spawn_agents')
      )
    })
    expect(errorUserMessage).toBeDefined()
  })

  it('should summarize missing spawned agent params clearly', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const agentTemplate = {
      ...testAgentTemplate,
      inputSchema: {
        params: z.object({ command: z.string() }),
      },
    }

    expect(() =>
      validateAgentInput(agentTemplate, 'basher', undefined, {}),
    ).toThrow('Missing required: command')
  })

  it('includes the exact declared params contract for a generic child', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const agentTemplate = {
      ...testAgentTemplate,
      id: 'generic-child',
      inputSchema: {
        params: z.object({
          source_path: z.string(),
          retry_count: z.number().int().optional(),
        }),
      },
    }

    let message = ''
    try {
      validateAgentInput(agentTemplate, 'generic-child', undefined, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Exact params contract (from the child agent schema)')
    expect(message).toContain('"required":["source_path"]')
    expect(message).toContain('"source_path":{"type":"string"}')
    expect(message).toContain('"retry_count":{"type":"integer"')
    expect(message).toContain('Preserve params field names exactly.')
  })

  it('gives reliability-reviewer snapshot_id recovery with its normalized ID', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const reliabilityReviewer = {
      ...testAgentTemplate,
      id: 'reliability-reviewer',
      inputSchema: {
        params: z.object({ snapshot_id: z.string() }),
      },
    }

    let message = ''
    try {
      validateAgentInput(
        reliabilityReviewer,
        'reliability-reviewer',
        undefined,
        {},
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Missing required: snapshot_id')
    expect(message).toContain('params.snapshot_id')
    expect(message).toContain('"agent_type": "reliability-reviewer"')
    expect(message).toContain('"snapshot_id": "v3:<64-hex>"')
    expect(message).toContain('gate-assigned opaque v3:')
    expect(message).toContain('specialistCreditFingerprint')
    expect(message).toContain('evidence-only')
    expect(message).toContain('will fail attestation')
    // Must not tell the caller to source the attestation token from the bare
    // bundle snapshotId (evidence-only).
    expect(message).not.toMatch(
      /fingerprint from get_change_review_bundle/i,
    )
  })

  it('validateAgentInput accepts attestable v3 snapshot_id and rejects bare hex', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const attestableSnapshotId = z
      .string()
      .regex(/^v3:[a-f0-9]{64}$/)
    const v3Snapshot = 'v3:' + 'a'.repeat(64)
    const bareHex = 'a'.repeat(64)

    for (const id of ['reliability-reviewer', 'compatibility-reviewer'] as const) {
      const agentTemplate = {
        ...testAgentTemplate,
        id,
        inputSchema: {
          params: z.object({ snapshot_id: attestableSnapshotId }),
        },
      }

      expect(() =>
        validateAgentInput(agentTemplate, id, undefined, {
          snapshot_id: v3Snapshot,
        }),
      ).not.toThrow()

      expect(() =>
        validateAgentInput(agentTemplate, id, undefined, {
          snapshot_id: bareHex,
        }),
      ).toThrow()
    }
  })

  it('gives dependency-manager canonical manager and operation recovery', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const dependencyManager = {
      ...testAgentTemplate,
      id: 'dependency-manager',
      inputSchema: {
        params: z.object({
          manager: z.string(),
          operation: z.enum(['add', 'remove', 'sync', 'restore', 'update']),
        }),
      },
    }

    let message = ''
    try {
      validateAgentInput(dependencyManager, 'dependency-manager', undefined, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('manager:')
    expect(message).toContain('operation:')
    expect(message).toContain('"required":["manager","operation"]')
    expect(message).toContain('"manager": "npm"')
    expect(message).toContain('"operation": "add"')
    expect(message).toContain('repository manifest/environment evidence')
    expect(message).toContain('add, remove, sync, restore, or update')
    expect(message).toContain(
      'Do not infer dependency mutation authorization from a validation failure.',
    )
  })

  it('gives librarian canonical repoUrl recovery on empty params', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const librarian = {
      ...testAgentTemplate,
      id: 'librarian',
      inputSchema: {
        params: z.object({ repoUrl: z.string().url() }),
      },
    }

    let message = ''
    try {
      validateAgentInput(librarian, 'librarian', undefined, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Missing required: repoUrl')
    expect(message).toContain('params.repoUrl')
    expect(message).toContain('"repoUrl": "https://github.com/<owner>/<repo>"')
    expect(message).toContain('a URL only in prompt prose is not used')
  })

  it('rejects security-reviewer snapshot_id with canonical params recovery', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const securityReviewer = {
      ...testAgentTemplate,
      id: 'security-reviewer',
      inputSchema: {
        params: z
          .object({
            changed_files: z.array(z.string()),
            snapshot_fingerprint: z.string(),
          })
          .strict(),
      },
    }

    let message = ''
    try {
      validateAgentInput(securityReviewer, 'security-reviewer', undefined, {
        changed_files: ['src/auth.ts'],
        snapshot_id: 'wrong-alias',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('snapshot_fingerprint')
    expect(message).toContain(
      '"required":["changed_files","snapshot_fingerprint"]',
    )
    expect(message).toContain('Exact params contract (from the child agent schema)')
    expect(message).toContain('replace params.snapshot_id with params.snapshot_fingerprint')
    expect(message).toContain('Retain params.changed_files')
    expect(message).toContain('Preserve params field names exactly.')
  })

  it('gives code-searcher a searchQueries recovery hint on empty params', async () => {
    const { validateAgentInput } =
      await import('../tools/handlers/tool/spawn-agent-utils')
    const codeSearcher = {
      ...testAgentTemplate,
      id: 'code-searcher',
      inputSchema: {
        params: z.object({
          searchQueries: z.array(z.object({ pattern: z.string() })),
        }),
      },
    }

    let message = ''
    try {
      validateAgentInput(codeSearcher, 'code-searcher', undefined, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Missing required: searchQueries')
    expect(message).toContain('spawn code-searcher with')
    expect(message).toContain('"searchQueries"')
    expect(message).toContain('required array of objects')
    expect(message).toContain('Preserve params field names exactly.')
  })

  it('publishes a structured failure result when Basher is missing command', async () => {
    const parent: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['spawn_agents', 'end_turn'],
      spawnableAgents: ['basher'],
    }
    const basher: AgentTemplate = {
      ...testAgentTemplate,
      id: 'basher',
      inputSchema: { params: z.object({ command: z.string().min(1) }) },
      toolNames: ['run_terminal_command'],
      spawnableAgents: [],
    }
    const invalidSpawn: StreamChunk = {
      type: 'tool-call',
      toolName: 'spawn_agents',
      toolCallId: 'basher-missing-command-tool-call-id',
      input: { agents: [{ agent_type: 'basher', params: {} }] },
    }
    async function* mockStream() {
      yield invalidSpawn
      return promptSuccess('mock-message-id')
    }
    const responseChunks: (string | PrintModeEvent)[] = []
    const sessionState = getInitialSessionState(mockFileContext)

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'test-step-id',
      agentTemplate: parent,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': parent, basher },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const events = responseChunks.filter(
      (chunk): chunk is PrintModeEvent => typeof chunk !== 'string',
    )
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      type: 'tool_call',
      toolName: 'spawn_agents',
      toolCallId: 'basher-missing-command-tool-call-id',
    })
    const toolResultEvent = events.find(
      (event) => event.type === 'tool_result',
    )
    expect(toolResultEvent).toMatchObject({
      type: 'tool_result',
      toolName: 'spawn_agents',
      toolCallId: 'basher-missing-command-tool-call-id',
      output: [
        {
          type: 'json',
          value: expect.arrayContaining([
            expect.objectContaining({
              agentType: 'basher',
              value: {
                // Spawn-failure errorMessage is the static, leak-safe contract
                // (no interpolation of the underlying validation error); the
                // detailed error is logged via logger.warn instead.
                errorMessage:
                  'Agent spawn failed because the handler could not validate the request.',
              },
            }),
          ]),
        },
      ],
    })
    // The underlying validation error must not leak into the agent-visible
    // failure output (regression guard for the retired interpolated format).
    expect(JSON.stringify(toolResultEvent)).not.toContain(
      'Missing required: command',
    )
  })

  it('repairs a single-agent mis-braced spawn payload and publishes it to the handler', async () => {
    const parent: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['spawn_agents', 'end_turn'],
      spawnableAgents: ['basher'],
    }
    const basher: AgentTemplate = {
      ...testAgentTemplate,
      id: 'basher',
      inputSchema: { params: z.object({ command: z.string().min(1) }) },
      toolNames: ['run_terminal_command'],
      spawnableAgents: [],
    }
    const misbracedSpawn: StreamChunk = {
      type: 'tool-call',
      toolName: 'spawn_agents',
      toolCallId: 'basher-misbraced-fold-tool-call-id',
      input: {
        agents: [{ agent_type: 'basher', params: { command: 'bun test' } }],
        prompt: 'Run the tests',
      },
    }
    async function* mockStream() {
      yield misbracedSpawn
      return promptSuccess('mock-message-id')
    }
    const responseChunks: (string | PrintModeEvent)[] = []
    const sessionState = getInitialSessionState(mockFileContext)

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'test-step-id',
      agentTemplate: parent,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': parent, basher },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const events = responseChunks.filter(
      (chunk): chunk is PrintModeEvent => typeof chunk !== 'string',
    )
    // The payload was repaired (folded), not rejected, so no error event.
    expect(events.some((event) => event.type === 'error')).toBe(false)
    // A tool_call for spawn_agents was published to the handler.
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      type: 'tool_call',
      toolName: 'spawn_agents',
      toolCallId: 'basher-misbraced-fold-tool-call-id',
    })
  })

  it('should still emit tool_call and tool_result for valid tool calls', async () => {
    // Create an agent that has read_files tool
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const validToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName: 'read_files',
      toolCallId: 'valid-tool-call-id',
      input: {
        paths: ['test.ts'], // Valid array parameter
      },
      providerOptions: {
        openaiCompatible: {
          extra_content: {
            google: {
              thought_signature: 'sig-456',
            },
          },
        },
      },
    }

    async function* mockStream() {
      yield validToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Mock requestFiles to return a file
    agentRuntimeImpl.requestFiles = async () =>
      buildReadFilesResultV1([
        {
          selector: 'file',
          requestIndex: 0,
          path: 'test.ts',
          status: 'ok',
          content: 'console.log("test")',
          complete: true,
          template: false,
        },
      ])

    const responseChunks: (string | PrintModeEvent)[] = []

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    // Verify tool_call event was emitted
    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(1)
    expect(toolCallEvents[0].toolName).toBe('read_files')

    // Verify tool_result event was emitted
    const toolResultEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_result' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_result',
    )
    expect(toolResultEvents.length).toBe(1)

    const assistantToolCallMessage = agentState.messageHistory.find(
      (message): message is AssistantMessage =>
        message.role === 'assistant' &&
        message.content.some((part) => part.type === 'tool-call'),
    )
    const assistantToolCallPart = assistantToolCallMessage?.content.find(
      (part) => part.type === 'tool-call',
    )
    expect(assistantToolCallPart?.providerOptions).toEqual(
      validToolCallChunk.providerOptions,
    )

    // Verify NO error events
    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(0)
  })

  it('emits a terminal tool_result when a published native handler rejects', async () => {
    const agentWithTerminal: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['run_terminal_command', 'end_turn'],
    }
    const toolCall: StreamChunk = {
      type: 'tool-call',
      toolName: 'run_terminal_command',
      toolCallId: 'rejecting-terminal-tool-call-id',
      input: { command: 'bun test' },
    }
    async function* mockStream() {
      yield toolCall
      return promptSuccess('mock-message-id')
    }

    agentRuntimeImpl.requestToolCall = async () => {
      throw new Error('terminal bridge disconnected')
    }
    const sessionState = getInitialSessionState(mockFileContext)
    const responseChunks: (string | PrintModeEvent)[] = []

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithTerminal,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithTerminal },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const events = responseChunks.filter(
      (chunk): chunk is PrintModeEvent => typeof chunk !== 'string',
    )
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    const results = events.filter(
      (event): event is Extract<PrintModeEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result',
    )
    expect(results).toHaveLength(1)
    expect(results[0].output[0]).toMatchObject({
      type: 'json',
      value: {
        kind: 'native_tool_result_error',
        lifecycle: { state: 'failed' },
        error: { message: expect.stringContaining('bridge disconnected') },
      },
    })
  })

  it('should repair malformed JSON string input from AI SDK before validation', async () => {
    // The AI SDK can emit tool-call chunks with `input` as a raw JSON string
    // when upstream schema validation fails and the repair function returns
    // the original tool call unchanged. The stream parser preserves malformed
    // strings so the shared executor can repair them before validation.
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const stringInputToolCallChunk = {
      type: 'tool-call' as const,
      toolName: 'read_files',
      toolCallId: 'string-input-tool-call-id',
      input: '{"paths":["test.ts"],,}' as any,
    }

    async function* mockStream() {
      yield stringInputToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    agentRuntimeImpl.requestFiles = async () =>
      buildReadFilesResultV1([
        {
          selector: 'file',
          requestIndex: 0,
          path: 'test.ts',
          status: 'ok',
          content: 'console.log("test")',
          complete: true,
          template: false,
        },
      ])

    const responseChunks: (string | PrintModeEvent)[] = []

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(1)
    expect(toolCallEvents[0].toolName).toBe('read_files')
    expect(toolCallEvents[0].input).toEqual({ paths: ['test.ts'] })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(0)
  })

  it('should emit a clear error when tool input is an unparseable string', async () => {
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const invalidStringToolCallChunk = {
      type: 'tool-call' as const,
      toolName: 'read_files',
      toolCallId: 'invalid-string-tool-call-id',
      input: '{"paths": ["test.ts"' as any, // truncated/malformed JSON
    }

    async function* mockStream() {
      yield invalidStringToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      'expected the tool arguments to be an object, but received a string',
    )
    expect(errorEvents[0].message).toContain('Parsing as JSON failed:')
    expect(errorEvents[0].message).toContain('Original tool call input:')

    expect(result.hadToolCallError).toBe(true)

    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(0)
  })

  it('should preserve tool_call/tool_result ordering when custom tool setup is async', async () => {
    const toolName = 'delayed_custom_tool'
    const agentWithCustomTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: [toolName, 'end_turn'],
    }

    const delayedToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName,
      toolCallId: 'delayed-custom-tool-call-id',
      input: {
        query: 'test',
      },
    }

    async function* mockStream() {
      yield delayedToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const fileContextWithCustomTool = {
      ...mockFileContext,
      customToolDefinitions: {
        [toolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A delayed custom tool for ordering tests',
        },
      },
    }

    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const agentState = sessionState.mainAgentState

    agentRuntimeImpl.requestMcpToolData = async () => {
      // Force an async gap so tool_call emission happens after stream completion.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return []
    }
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    agentRuntimeImpl.requestToolCall = async ({ signal }) => {
      observedSignal = signal
      return {
        output: jsonToolResult({ ok: true }),
      }
    }

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: controller.signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: () => {},
    })

    expect(observedSignal).toBe(controller.signal)

    const assistantToolCallMessages = agentState.messageHistory.filter(
      (m): m is AssistantMessage =>
        m.role === 'assistant' &&
        m.content.some(
          (c) => c.type === 'tool-call' && c.toolName === toolName,
        ),
    )
    const toolMessages = agentState.messageHistory.filter(
      (m): m is ToolMessage => m.role === 'tool' && m.toolName === toolName,
    )

    expect(assistantToolCallMessages.length).toBe(1)
    expect(toolMessages.length).toBe(1)

    const assistantToolCallPart = assistantToolCallMessages[0].content.find(
      (
        c,
      ): c is Extract<
        AssistantMessage['content'][number],
        { type: 'tool-call' }
      > => c.type === 'tool-call' && c.toolName === toolName,
    )
    expect(assistantToolCallPart).toBeDefined()
    expect(toolMessages[0].toolCallId).toBe(assistantToolCallPart!.toolCallId)

    const assistantIndex = agentState.messageHistory.indexOf(
      assistantToolCallMessages[0],
    )
    const toolResultIndex = agentState.messageHistory.indexOf(toolMessages[0])
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(assistantIndex)

    const assistantToolCallIds = new Set(
      agentState.messageHistory.flatMap((message) => {
        if (message.role !== 'assistant') {
          return []
        }
        return message.content.flatMap((part) =>
          part.type === 'tool-call' ? [part.toolCallId] : [],
        )
      }),
    )
    const orphanToolResults = agentState.messageHistory.filter(
      (message): message is ToolMessage =>
        message.role === 'tool' &&
        !assistantToolCallIds.has(message.toolCallId),
    )
    expect(orphanToolResults.length).toBe(0)
  })

  it('emits a concise userMessage on the error event when a custom tool call fails validation', async () => {
    // Covers the `userMessage` emission branch in executeCustomToolCall: a
    // granted custom tool that fails input validation publishes an error event
    // whose concise `userMessage` is a calm CLI-banner one-liner that never
    // carries the raw validation wall (mirrors the native-tool branch covered
    // by the spawn_agents test above).
    const toolName = 'custom_search'
    const agentWithCustomTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: [toolName, 'end_turn'],
    }

    const invalidToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName,
      toolCallId: 'invalid-custom-tool-call-id',
      input: {}, // missing required `query`
    }

    async function* mockStream() {
      yield invalidToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const fileContextWithCustomTool = {
      ...mockFileContext,
      customToolDefinitions: {
        [toolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A custom tool for userMessage coverage',
        },
      },
    }

    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const agentState = sessionState.mainAgentState
    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      `Invalid parameters for ${toolName}`,
    )
    // The concise `userMessage` is a calm one-liner for the CLI banner that
    // never carries the raw validation details.
    expect(typeof errorEvents[0].userMessage).toBe('string')
    expect((errorEvents[0].userMessage ?? '').length).toBeGreaterThan(0)
    expect(errorEvents[0].userMessage).toContain(toolName)

    // The agent loop continues and no tool_call/tool_result was published.
    expect(result.hadToolCallError).toBe(true)
    const toolEvents = responseChunks.filter(
      (chunk): chunk is PrintModeEvent =>
        typeof chunk !== 'string' &&
        (chunk.type === 'tool_call' || chunk.type === 'tool_result'),
    )
    expect(toolEvents.length).toBe(0)
  })
})

describe('custom tool project-root escape backstop', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
  })

  const escapeTestAgentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['custom_fs', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  const fsToolName = 'custom_fs'

  function buildFileContextWithFsTool() {
    return {
      ...mockFileContext,
      customToolDefinitions: {
        [fsToolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              metadata: {
                type: 'object',
                properties: {
                  requestedPath: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A custom filesystem tool for escape-backstop tests',
        },
      },
    }
  }

  async function runCustomFsTool(input: Record<string, unknown>) {
    const agentWithCustomTool: AgentTemplate = {
      ...escapeTestAgentTemplate,
      toolNames: [fsToolName, 'end_turn'],
    }

    const toolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName: fsToolName,
      toolCallId: 'custom-fs-escape-tool-call-id',
      input,
    }

    async function* mockStream() {
      yield toolCallChunk
      return promptSuccess('mock-message-id')
    }

    const fileContextWithCustomTool = buildFileContextWithFsTool()
    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const responseChunks: (string | PrintModeEvent)[] = []

    // A no-op handler so a legitimate in-project call can proceed to publish
    // its tool_call/tool_result without needing a real bridge.
    agentRuntimeImpl.requestToolCall = async () => ({
      output: jsonToolResult({ ok: true }),
    })

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    })

    return responseChunks.filter(
      (chunk): chunk is PrintModeEvent => typeof chunk !== 'string',
    )
  }

  it('hard-blocks a custom tool whose input contains a ../ escaping path', async () => {
    const events = await runCustomFsTool({ path: '../escape.txt' })

    const errorEvents = events.filter(
      (event): event is Extract<PrintModeEvent, { type: 'error' }> =>
        event.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain('outside the project root')

    expect(events.some((event) => event.type === 'tool_call')).toBe(false)
    expect(events.some((event) => event.type === 'tool_result')).toBe(false)
  })

  it('hard-blocks a custom tool whose input contains an absolute path', async () => {
    const events = await runCustomFsTool({ path: '/etc/passwd' })

    const errorEvents = events.filter(
      (event): event is Extract<PrintModeEvent, { type: 'error' }> =>
        event.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain('outside the project root')

    expect(events.some((event) => event.type === 'tool_call')).toBe(false)
    expect(events.some((event) => event.type === 'tool_result')).toBe(false)
  })

  it('never echoes secret custom input values in containment errors', async () => {
    const secret = 'super-secret-token-should-never-appear'
    const events = await runCustomFsTool({ path: '../escape.txt', metadata: { requestedPath: secret } })
    const error = events.find(
      (event): event is Extract<PrintModeEvent, { type: 'error' }> =>
        event.type === 'error',
    )

    expect(error).toBeDefined()
    expect(error!.message).toContain('outside the project root')
    expect(error!.message).not.toContain(secret)
    expect(error!.message).not.toContain('../escape.txt')
  })

  it('blocks nested custom values that resemble escaping paths', async () => {
    const events = await runCustomFsTool({
      path: 'src/a.ts',
      metadata: { requestedPath: '../nested-escape.txt' },
    })

    expect(events.some((event) => event.type === 'error')).toBe(true)
    expect(events.some((event) => event.type === 'tool_call')).toBe(false)
  })

  it('does not block a legitimate in-project relative path', async () => {
    const events = await runCustomFsTool({ path: 'src/a.ts' })

    const outsideRootErrors = events.filter(
      (event) =>
        event.type === 'error' &&
        event.message.includes('outside the project root'),
    )
    expect(outsideRootErrors.length).toBe(0)

    expect(events.some((event) => event.type === 'tool_call')).toBe(true)
  })
})

describe('buildUnavailableToolMessage', () => {
  it('explains a known-but-ungranted tool without suggesting a near match', () => {
    const message = buildUnavailableToolMessage({
      toolName: 'run_terminal_command',
      agentId: 'base2',
      availableTools: ['query_index', 'read_files', 'glob'],
    })

    expect(message).toContain('is a registered tool but is not granted')
    expect(message).toContain('is not available for agent `base2`')
  })

  it('prefers direct code_search when that tool is already available', () => {
    for (const toolName of ['code_search', 'find_files_matching_content']) {
      const message = buildUnavailableToolMessage({
        toolName,
        agentId: 'base2',
        availableTools: ['read_files', 'code_search'],
        input: { pattern: 'alpha' },
      })

      expect(message).toContain('Use the granted `code_search` tool directly')
      expect(message).toContain('params.searchQueries')
      expect(message).not.toContain('"pattern": "alpha"')
    }
  })

  it('gives concrete code-searcher recovery when code_search is unavailable', () => {
    for (const toolName of ['code_search', 'find_files_matching_content']) {
      const message = buildUnavailableToolMessage({
        toolName,
        agentId: 'base2',
        availableTools: ['read_files'],
      })

      expect(message).toContain('code-searcher')
      expect(message).toContain('searchQueries')
      expect(message).toContain('"pattern": "<regex>"')
    }
  })

  it('inlines an explicit input pattern into the code-searcher spawn recipe', () => {
    const message = buildUnavailableToolMessage({
      toolName: 'code_search',
      agentId: 'base2',
      availableTools: ['read_files'],
      input: { pattern: 'normalizeSpawnAgentList' },
    })

    expect(message).toContain('code-searcher')
    expect(message).toContain('"pattern": "normalizeSpawnAgentList"')
    expect(message).not.toContain('"pattern": "<regex>"')
  })

  it('suggests the closest granted tool for a likely typo', () => {
    const message = buildUnavailableToolMessage({
      toolName: 'read_file',
      agentId: 'base2',
      availableTools: ['read_files', 'query_index'],
    })

    expect(message).toContain('Did you mean `read_files`?')
  })

  it('omits suggestions for an unknown tool with no near match', () => {
    const message = buildUnavailableToolMessage({
      toolName: 'zzzzzzzzzz',
      agentId: 'base2',
      availableTools: ['query_index'],
    })

    expect(message).not.toContain('Did you mean')
    expect(message).not.toContain('is a registered tool')
  })

  it('suggests a match for a single-substitution typo', () => {
    // Regression coverage for the two-row DP levenshtein helper: a substitution
    // (not just a trailing insertion) must still rank the granted tool closest.
    const message = buildUnavailableToolMessage({
      toolName: 'read_filex',
      agentId: 'base2',
      availableTools: ['read_files', 'query_index'],
    })

    expect(message).toContain('Did you mean `read_files`?')
  })

  it('suggests a match for a two-edit transposition typo within threshold', () => {
    // 'read_flies' is edit-distance 2 from 'read_files' (an adjacent
    // transposition counts as two edits in plain Levenshtein). The two-row DP
    // must still rank it closest and within the length-scaled threshold.
    const message = buildUnavailableToolMessage({
      toolName: 'read_flies',
      agentId: 'base2',
      availableTools: ['read_files'],
    })

    expect(message).toContain('Did you mean `read_files`?')
  })

  it('offers no suggestion when the available-tool list is empty', () => {
    const message = buildUnavailableToolMessage({
      toolName: 'read_file',
      agentId: 'base2',
      availableTools: [],
    })

    expect(message).toContain('(none)')
    expect(message).not.toContain('Did you mean')
  })
})

describe('executeToolCall queued → running transition', () => {
  const queuedAgentTemplate: AgentTemplate = {
    id: 'queued-test-agent',
    displayName: 'Queued Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['set_output', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  function buildQueuedParams(overrides: {
    queued?: boolean
    previousToolCallFinished: Promise<void>
    onResponseChunk: (chunk: unknown) => void
  }): Parameters<typeof executeToolCall>[0] {
    const agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
    const sessionState = getInitialSessionState(mockFileContext)
    return {
      ...agentRuntimeImpl,
      toolName: 'set_output',
      input: { message: 'queued output' },
      agentContext: {},
      agentState: sessionState.mainAgentState,
      agentStepId: 'queued-step-id',
      ancestorRunIds: [],
      agentTemplate: queuedAgentTemplate,
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fileProcessingState: { failedEditRequiresReadByPath: {} },
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { [queuedAgentTemplate.id]: queuedAgentTemplate },
      previousToolCallFinished: overrides.previousToolCallFinished,
      ...(overrides.queued !== undefined && { queued: overrides.queued }),
      prompt: undefined,
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      system: 'test system',
      tools: {},
      toolCallId: 'queued-tool-call-id',
      toolCalls: [],
      toolCallsToAddToMessageHistory: [],
      toolResults: [],
      toolResultsToAddToMessageHistory: [],
      userId: 'test-user',
      userInputId: 'test-input-id',
      fetch: globalThis.fetch,
      onCostCalculated: async () => {},
      onResponseChunk: overrides.onResponseChunk,
    } as unknown as Parameters<typeof executeToolCall>[0]
  }

  it('flags the tool_call as queued and emits tool_start only after the barrier resolves', async () => {
    const chunks: unknown[] = []
    let resolveBarrier!: () => void
    const previousToolCallFinished = new Promise<void>((resolve) => {
      resolveBarrier = resolve
    })

    const promise = executeToolCall(
      buildQueuedParams({
        queued: true,
        previousToolCallFinished,
        onResponseChunk: (chunk) => chunks.push(chunk),
      }),
    )
    promise.catch(() => {})

    // The tool_call is published synchronously and carries the queued flag...
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'queued-tool-call-id',
        queued: true,
      }),
    )
    // ...but the queued→running tool_start transition has NOT fired while the
    // prior-write barrier is still pending.
    expect(
      chunks.some(
        (chunk) => (chunk as { type?: string }).type === 'tool_start',
      ),
    ).toBe(false)

    resolveBarrier()
    await promise

    // Once the dependency resolves, the tool_start transition fires with the
    // same toolCallId so the CLI can flip the block from queued to pending.
    const startIdx = chunks.findIndex(
      (chunk) => (chunk as { type?: string }).type === 'tool_start',
    )
    expect(startIdx).toBeGreaterThan(-1)
    expect(chunks[startIdx]).toMatchObject({
      type: 'tool_start',
      toolCallId: 'queued-tool-call-id',
    })

    // The transition is ordered after the tool_call and before the tool_result.
    const callIdx = chunks.findIndex(
      (chunk) => (chunk as { type?: string }).type === 'tool_call',
    )
    expect(callIdx).toBeLessThan(startIdx)
    const resultIdx = chunks.findIndex(
      (chunk) => (chunk as { type?: string }).type === 'tool_result',
    )
    expect(resultIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeLessThan(resultIdx)
  })

  it('does not emit a tool_start transition for a non-queued call', async () => {
    const chunks: unknown[] = []
    let resolveBarrier!: () => void
    const previousToolCallFinished = new Promise<void>((resolve) => {
      resolveBarrier = resolve
    })

    const promise = executeToolCall(
      buildQueuedParams({
        previousToolCallFinished,
        onResponseChunk: (chunk) => chunks.push(chunk),
      }),
    )
    promise.catch(() => {})

    // A non-queued tool_call carries no queued flag...
    const toolCall = chunks.find(
      (chunk) => (chunk as { type?: string }).type === 'tool_call',
    ) as Record<string, unknown> | undefined
    expect(toolCall).toBeDefined()
    expect('queued' in (toolCall ?? {})).toBe(false)

    resolveBarrier()
    await promise

    // ...and never emits a tool_start transition.
    expect(
      chunks.some(
        (chunk) => (chunk as { type?: string }).type === 'tool_start',
      ),
    ).toBe(false)
  })
})

describe('getToolSet provider schema compaction', () => {
  it('preserves schema descriptions for mutation tools and strips them for read-only tools', async () => {
    const { getToolSet } = await import('../tools/prompts')

    const toolSet = await getToolSet({
      toolNames: ['edit_transaction', 'read_files'],
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })

    const schemaJson = (toolName: string): string => {
      const inputSchema = (toolSet[toolName] as { inputSchema?: unknown })
        .inputSchema as { jsonSchema?: unknown } | undefined
      return JSON.stringify(inputSchema?.jsonSchema ?? inputSchema)
    }

    // Mutation tools (edit_transaction) keep per-field descriptions so the
    // model still sees guidance for the bare discriminated union; this asserts
    // the mutation-keyed `preserveDescriptions` wiring end-to-end via getToolSet.
    expect(schemaJson('edit_transaction')).toContain('description')
    // Read-only tools stay fully compacted: no description annotations survive.
    expect(schemaJson('read_files')).not.toContain('description')
  })
})

describe('edit-read-state focused unit cases', () => {
  function createFileProcessingState(): FileProcessingState {
    return {
      promisesByPath: {},
      allPromises: [],
      fileChangeErrors: [],
      fileChanges: [],
      firstFileProcessed: false,
      failedEditRequiresReadByPath: {},
      consecutiveStrReplaceFailuresByPath: {},
    }
  }

  it('markEditRequiresFreshRead does not downgrade context_compacted to a weaker reason', () => {
    const path = 'src/compacted.ts'
    const fileProcessingState = createFileProcessingState()
    markEditRequiresFreshRead({
      fileProcessingState,
      path,
      reason: 'context_compacted',
      sourceTool: 'compaction',
    })
    expect(fileProcessingState.editRereadRequirementsByPath?.[path]).toEqual({
      reason: 'context_compacted',
      sourceTool: 'compaction',
    })

    markEditRequiresFreshRead({
      fileProcessingState,
      path,
      reason: 'preflight_failed',
      sourceTool: 'str_replace',
    })
    expect(fileProcessingState.editRereadRequirementsByPath?.[path]).toEqual({
      reason: 'context_compacted',
      sourceTool: 'compaction',
    })
    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
  })

  it('strictEditAuthorizationError uses capability-first basedOnRead recovery when a token is present', () => {
    const path = 'src/auth-miss.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    const capability =
      'cap.v3.1.1.test-whole-file-capability-token-for-recovery-message'

    const withCap = strictEditAuthorizationError({
      fileProcessingState,
      path,
      toolName: 'write_file',
      hasFreshWholeFileAuthorization: false,
      freshReadCapability: capability,
    })
    expect(withCap).toBeDefined()
    expect(String(withCap?.errorMessage)).toContain(
      'Next: retry with basedOnRead',
    )
    expect(String(withCap?.errorMessage)).toContain(
      `basedOnRead="${capability}"`,
    )
    expect(String(withCap?.errorMessage)).not.toMatch(/Next: call read_files/)
    // Primary machine-readable signal is preferredStrategy + basedOnRead;
    // tool remains the documented fallback only.
    expect(withCap?.recovery.preferredStrategy).toBe('basedOnRead')
    expect(withCap?.recovery.basedOnRead).toBe(capability)
    expect(withCap?.recovery.tool).toBe('read_files')

    const withoutCap = strictEditAuthorizationError({
      fileProcessingState,
      path,
      toolName: 'write_file',
      hasFreshWholeFileAuthorization: false,
    })
    expect(String(withoutCap?.errorMessage)).toContain('Next: call read_files')
    expect(withoutCap?.recovery.preferredStrategy).toBe('read_files')
    expect(withoutCap?.recovery.basedOnRead).toBeUndefined()
    expect(withoutCap?.recovery.tool).toBe('read_files')
  })
})
