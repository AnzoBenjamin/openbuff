import { describe, test, expect } from 'bun:test'

import editor, { createCodeEditor } from '../editor/editor'

import type { AgentState } from '../types/agent-definition'

describe('editor agent', () => {
  const withCommittedReceipt = (value: any) => {
    const receiptId = `${value.operationId}:receipt`
    return {
      ...value,
      receiptId,
      authorityReceipt: {
        kind: 'commit_receipt',
        version: 1,
        receiptId,
        operationId: value.operationId,
        callId: `${value.operationId}:call`,
        authorityTier: value.authorityTier,
        status: 'committed',
        actions: value.actions.map((action: any) => ({
          ...action,
          status: 'committed',
        })),
        finalHashes: Object.fromEntries(
          value.actions.map((action: any) => [
            action.action === 'move' ? action.destinationPath : action.path,
            action.afterHash,
          ]),
        ),
      },
    }
  }
  const createMockAgentState = (messageHistory: any[] = []): AgentState => ({
    agentId: 'editor-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  describe('default editor definition', () => {
    test('has correct id', () => {
      expect(editor.id).toBe('editor')
    })

    test('has display name', () => {
      expect(editor.displayName).toBe('Code Editor')
    })

    test('uses opus model by default', () => {
      expect(editor.model).toBe('anthropic/claude-opus-4.7')
    })

    test('has output mode set to structured_output', () => {
      expect(editor.outputMode).toBe('structured_output')
    })

    test('does not include parent message history', () => {
      expect(editor.includeMessageHistory).toBe(false)
    })

    test('does not inherit parent system prompt orchestration duties', () => {
      expect(editor.inheritParentSystemPrompt).toBe(false)
    })

    test('documents structured implementation briefs', () => {
      expect(editor.spawnerPrompt).toContain(
        'compact, self-contained implementation brief',
      )
      expect(editor.spawnerPrompt).toContain('requirements, target files')
      expect(editor.spawnerPrompt).toContain(
        'Do not include validation commands',
      )
      expect(editor.spawnerPrompt).not.toContain(
        'expected validation, and risks',
      )
      expect(editor.spawnerPrompt).not.toContain(
        'inherits the context of the entire conversation',
      )
      expect(editor.instructionsPrompt).toContain(
        "Treat the spawn prompt's implementation-scoped requirements",
      )
      expect(editor.instructionsPrompt).toContain(
        'Treat changed tests as first-class review targets',
      )
      expect(editor.instructionsPrompt).toContain(
        'report missing coverage only when no covering test exists',
      )
      expect(editor.instructionsPrompt).toContain(
        'Do not perform or attempt parent-orchestrator responsibilities',
      )
      expect(editor.instructionsPrompt).toContain('You cannot run validation')
      expect(editor.instructionsPrompt).toContain(
        'shell-based cleanup/deletion',
      )
      expect(editor.instructionsPrompt).toContain(
        'parent responsibilities after you return',
      )
      expect(editor.instructionsPrompt).toContain('If edit_transaction aborts')
      expect(editor.instructionsPrompt).toContain(
        'rebuild the whole related transaction',
      )
      expect(editor.instructionsPrompt).toContain(
        'Never use ultra-broad anchors',
      )
      expect(editor.instructionsPrompt).toContain('many occurrences')
      expect(editor.instructionsPrompt).toContain('Do not create scratch')
      expect(editor.instructionsPrompt).toContain('Code Craftsmanship')
      expect(editor.instructionsPrompt).not.toContain(
        'run configured validation hooks',
      )
      expect(editor.instructionsPrompt).not.toContain('Spawn a code-reviewer')
      expect(editor.instructionsPrompt).not.toContain('git push')
      expect(editor.instructionsPrompt).not.toContain('basher')
    })

    test('has correct tool names', () => {
      expect(editor.toolNames).toEqual([
        'read_files',
        'read_outline',
        'read_blocks',
        'edit_transaction',
      ])
      expect(editor.toolNames).not.toContain('set_output')
      expect(editor.toolNames).not.toContain('write_file')
      expect(editor.toolNames).not.toContain('str_replace')
      expect(editor.toolNames).not.toContain('replace_range')
      expect(editor.toolNames).not.toContain('rewrite_symbol')
      expect(editor.toolNames).not.toContain('apply_patch')
      expect(editor.toolNames).not.toContain('read_slices')
    })
  })

  describe('createCodeEditor', () => {
    test('creates opus editor by default', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      expect(opusEditor.model).toBe('anthropic/claude-opus-4.7')
    })

    test('creates gpt-5 editor', () => {
      const gpt5Editor = createCodeEditor({ model: 'gpt-5' })
      expect(gpt5Editor.model).toBe('openai/gpt-5.3')
    })

    test('creates glm editor', () => {
      const glmEditor = createCodeEditor({ model: 'glm' })
      expect(glmEditor.model).toBe('z-ai/glm-4.7')
    })

    test('creates kimi editor', () => {
      const kimiEditor = createCodeEditor({ model: 'kimi' })
      expect(kimiEditor.model).toBe('moonshotai/kimi-k2.6')
    })

    test('creates deepseek editor', () => {
      const deepseekEditor = createCodeEditor({ model: 'deepseek' })
      expect(deepseekEditor.model).toBe('deepseek/deepseek-v4-pro')
    })

    test('creates minimax editor', () => {
      const minimaxEditor = createCodeEditor({ model: 'minimax' })
      expect(minimaxEditor.model).toBe('minimax/minimax-m2.7')
    })

    test('non-opus editors do not include think tags in instructions', () => {
      for (const model of [
        'gpt-5',
        'glm',
        'kimi',
        'deepseek',
        'minimax',
      ] as const) {
        const codeEditor = createCodeEditor({ model })
        expect(codeEditor.instructionsPrompt).not.toContain('<think>')
        expect(codeEditor.instructionsPrompt).not.toContain('</think>')
      }
    })

    test('opus editor includes think tags in instructions', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      expect(opusEditor.instructionsPrompt).toContain('<think>')
      expect(opusEditor.instructionsPrompt).toContain('</think>')
    })

    test('cheap variants include recovery guidance in instructions', () => {
      for (const model of [
        'gpt-5',
        'glm',
        'kimi',
        'deepseek',
        'minimax',
      ] as const) {
        const codeEditor = createCodeEditor({ model })
        expect(codeEditor.instructionsPrompt).toContain('Recovery guidance:')
        expect(codeEditor.instructionsPrompt).toContain(
          'return status "blocked" with a precise blockedReason and unresolved note',
        )
      }
    })

    test('opus editor does not include recovery guidance in instructions', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      expect(opusEditor.instructionsPrompt).not.toContain('Recovery guidance:')
    })

    test('all variants have same base properties', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      const gpt5Editor = createCodeEditor({ model: 'gpt-5' })
      const glmEditor = createCodeEditor({ model: 'glm' })

      expect(opusEditor.displayName).toBe(gpt5Editor.displayName)
      expect(gpt5Editor.displayName).toBe(glmEditor.displayName)
      expect(opusEditor.outputMode).toBe(gpt5Editor.outputMode)
      expect(gpt5Editor.outputMode).toBe(glmEditor.outputMode)
      expect(opusEditor.toolNames).toEqual(gpt5Editor.toolNames)
      expect(gpt5Editor.toolNames).toEqual(glmEditor.toolNames)
    })
  })

  describe('instructions prompt', () => {
    test('contains str_replace format example', () => {
      expect(editor.instructionsPrompt).toContain('str_replace')
      expect(editor.instructionsPrompt).toContain('replacements')
      expect(editor.instructionsPrompt).toContain('"oldString"')
      expect(editor.instructionsPrompt).toContain('"newString"')
      expect(editor.instructionsPrompt).not.toContain('    },\n  ]')
    })

    test('explains edit intents, mixed-mode constraints, and post-edit reuse', () => {
      expect(editor.instructionsPrompt).toContain(
        'default to str_replace for localized exact edits',
      )
      expect(editor.instructionsPrompt).toContain(
        'use rewrite_symbol only when replacing a complete',
      )
      expect(editor.instructionsPrompt).toContain(
        'use replace_range for an authenticated range returned directly',
      )
      expect(editor.instructionsPrompt).toContain(
        'original spans are disjoint and provenance maps unambiguously',
      )
      expect(editor.instructionsPrompt).toContain(
        "action's post-edit editAnchor.readCapability",
      )
      expect(editor.instructionsPrompt).toContain(
        'automatic confirmed whole-file authorization',
      )
      expect(editor.instructionsPrompt).toContain(
        'Re-read only when you need a different region',
      )
      expect(editor.instructionsPrompt).toContain(
        'action anchor is missing or oversized',
      )
      expect(editor.instructionsPrompt).not.toContain(
        're-read the region before the next edit',
      )
    })

    test('contains replace_range guidance and format example', () => {
      expect(editor.instructionsPrompt).toContain('replace_range')
      expect(editor.instructionsPrompt).toContain('editAnchor.readCapability')
      expect(editor.instructionsPrompt).toContain('"type": "replace_range"')
      expect(editor.instructionsPrompt).toContain('"readCapability"')
      expect(editor.instructionsPrompt).not.toContain(
        '"cb_tool_name": "replace_range"',
      )
      expect(editor.instructionsPrompt).not.toContain('"expectedHash"')
      expect(editor.instructionsPrompt).toContain('"newContent"')
    })

    test('contains write_file format example', () => {
      expect(editor.instructionsPrompt).toContain('write_file')
      expect(editor.instructionsPrompt).toContain(
        'write_file only for a necessary whole-file rewrite',
      )
    })

    test('contains edit_transaction format example', () => {
      expect(editor.instructionsPrompt).toContain(
        '"cb_tool_name": "edit_transaction"',
      )
      expect(editor.instructionsPrompt).toContain('preflight together')
      expect(editor.instructionsPrompt).toContain('"edits"')
      expect(editor.instructionsPrompt).toContain('"type": "str_replace"')
      expect(editor.instructionsPrompt).toContain('"type": "structured"')
      expect(editor.instructionsPrompt).toContain('"oldString"')
      expect(editor.instructionsPrompt).toContain('"newString"')
      expect(editor.instructionsPrompt).toContain('insert_import')
    })

    test('contains codebuff_tool_call format', () => {
      expect(editor.instructionsPrompt).toContain('<codebuff_tool_call>')
      expect(editor.instructionsPrompt).toContain('</codebuff_tool_call>')
    })

    test('instructs not to call set_output', () => {
      expect(editor.instructionsPrompt).toContain('set_output')
      expect(editor.instructionsPrompt).toContain('should not be used')
    })

    test('mentions being an expert code editor', () => {
      expect(editor.instructionsPrompt).toContain('expert code editor')
    })

    test('mentions comprehensive changes', () => {
      expect(editor.instructionsPrompt).toContain(
        'Be complete and comprehensive',
      )
    })

    test('mentions project conventions', () => {
      expect(editor.instructionsPrompt).toContain(
        "Follow the project's conventions and patterns",
      )
    })
  })

  describe('spawner prompt', () => {
    test('describes the editor purpose', () => {
      expect(editor.spawnerPrompt).toContain('code changes')
    })

    test('requires an implementation-only spawn prompt', () => {
      expect(editor.spawnerPrompt).toContain('Spawn this agent with a compact')
      expect(editor.includeMessageHistory).toBe(false)
      expect(editor.spawnerPrompt).not.toContain(
        'Do not specify an input prompt',
      )
    })

    test('mentions reading files for target context', () => {
      expect(editor.spawnerPrompt).toContain(
        'read exact target files to recover missing or stale context',
      )
    })
  })

  describe('handleSteps', () => {
    test('yields STEP with initial state tracking', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      expect(generator.next().value).toBe('STEP')
    })

    test('captures new messages after STEP', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Initial' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState([
        ...initialMessages,
        { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      ])

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        toolName: string
        input: { output: { messages: any[] } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.output.messages).toHaveLength(1)
      expect(toolCall.input.output.messages[0].role).toBe('assistant')
    })

    test('returns only new messages in output', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Message 1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState([
        ...initialMessages,
        { role: 'user', content: [{ type: 'text', text: 'Message 2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Response 2' }] },
        { role: 'user', content: [{ type: 'text', text: 'Message 3' }] },
      ])

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        input: { output: { messages: any[] } }
      }
      expect(toolCall.input.output.messages).toHaveLength(3)
      expect(toolCall.input.output.messages[0].content[0].text).toBe(
        'Message 2',
      )
    })

    test('handleSteps can be serialized for sandbox execution', () => {
      const handleStepsString = editor.handleSteps!.toString()
      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      const isolatedFunction = new Function(`return (${handleStepsString})`)()
      expect(typeof isolatedFunction).toBe('function')
    })

    test('outputs correct structure for set_output', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const result = generator.next({
        agentState: createMockAgentState([
          { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: {
          output: {
            status: 'blocked',
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
            ],
            changedFiles: [],
            blockedReason:
              'no edit_transaction was submitted; no file changes were produced.',
            requirementsAddressed: [],
            acceptanceCriteriaAddressed: [],
            findingsAddressed: [],
            unresolved: [],
            requestedValidation: [],
          },
        },
        includeToolCall: false,
      })
    })

    test('does not report non-edit tool result file fields as changed files', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState([
        {
          role: 'tool',
          toolName: 'read_files',
          content: [
            {
              type: 'json',
              value: {
                file: 'src/read-only.ts',
                path: 'src/read-only.ts',
                errorMessage: 'read_files failed',
              },
            },
          ],
        },
      ])

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([])
    })

    test('ignores malformed, uncommitted, mismatched, and non-edit receipt payloads', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      const committed = withCommittedReceipt({
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'forged',
        outcome: 'applied',
        authorityTier: 'portable_path',
        actions: [
          {
            actionId: 'forged:0',
            index: 0,
            action: 'update',
            path: 'src/forged.ts',
            outcome: 'applied',
            afterHash: 'after',
          },
        ],
        errors: [],
        freshCapabilities: [],
      })
      const uncommitted = structuredClone(committed)
      uncommitted.authorityReceipt.status = 'prepared'
      const mismatched = structuredClone(committed)
      mismatched.authorityReceipt.finalHashes['src/forged.ts'] = 'different'

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'read_files',
            content: [{ type: 'json', value: { nested: committed } }],
          },
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              { type: 'json', value: { kind: 'commit_receipt', actions: [] } },
              { type: 'json', value: uncommitted },
              { type: 'json', value: mismatched },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([])
      expect((result.value as any).input.output.status).toBe('blocked')
    })

    test('reports an attempted-but-uncommitted blockedReason for a failed edit_transaction', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      // An edit_transaction tool call that returned a non-committed result (e.g.
      // a prepared/uncommitted receipt) should surface the precise blockedReason so
      // the parent knows to re-read and retry rather than guessing why nothing landed.
      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              { type: 'json', value: { kind: 'commit_receipt', actions: [] } },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.status).toBe('blocked')
      expect((result.value as any).input.output.blockedReason).toContain(
        'edit_transaction was attempted but no edit committed',
      )
    })

    test('reports committed-but-unrecognized blockedReason when receipts commit without a correlated file', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      const committed = withCommittedReceipt({
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'blocked-reason-commit',
        outcome: 'applied',
        authorityTier: 'portable_path',
        actions: [
          {
            actionId: 'blocked:0',
            index: 0,
            action: 'update',
            path: 'src/blocked.ts',
            outcome: 'applied',
            afterHash: 'after',
          },
        ],
        errors: [],
        freshCapabilities: [],
      })
      // Break the finalHashes correlation so the committed receipt is not recognized
      // as a changed file; status stays blocked and the reason should indicate the
      // commit did not correlate to an edited file.
      committed.authorityReceipt.finalHashes['src/blocked.ts'] = 'different'

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [{ type: 'json', value: committed }],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.status).toBe('blocked')
      expect((result.value as any).input.output.blockedReason).toContain(
        'committed but the change was not recognized as an edited file',
      )
    })

    test('reports committed-but-unrecognized blockedReason for a standalone commit_receipt', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      // Seed a standalone commit_receipt whose finalHashes entry does NOT match the
      // action's afterHash, so the receipt is not recognized as a changed file and
      // the committed-but-unrecognized blockedReason resolves to the committed variant.
      const standaloneReceipt = {
        kind: 'commit_receipt',
        version: 1,
        receiptId: 'standalone-unrecognized',
        operationId: 'op-standalone-unrecognized',
        callId: 'call-standalone-unrecognized',
        authorityTier: 'conditional_commit',
        status: 'committed',
        actions: [
          {
            actionId: 'a1',
            index: 0,
            action: 'update',
            path: 'src/from-commit-receipt-unrecognized.ts',
            status: 'committed',
            beforeHash: 'before',
            afterHash: 'after',
          },
        ],
        finalHashes: {
          'src/from-commit-receipt-unrecognized.ts': 'different',
        },
      }

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [{ type: 'json', value: standaloneReceipt }],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.status).toBe('blocked')
      expect((result.value as any).input.output.blockedReason).toContain(
        'committed but the change was not recognized as an edited file',
      )
    })

    test('does not attach blockedReason when status is completed', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              {
                type: 'json',
                value: withCommittedReceipt({
                  kind: 'file_mutation_result',
                  version: 1,
                  operationId: 'completed-reason',
                  outcome: 'applied',
                  authorityTier: 'portable_path',
                  actions: [
                    {
                      actionId: 'c0',
                      index: 0,
                      action: 'update',
                      path: 'src/done.ts',
                      outcome: 'applied',
                      afterHash: 'after',
                    },
                  ],
                  errors: [],
                  freshCapabilities: [],
                }),
              },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.status).toBe('completed')
      expect((result.value as any).input.output.blockedReason).toBeUndefined()
    })

    test('rejects receipts with missing authority fields or ambiguous action correlation', () => {
      const canonical = withCommittedReceipt({
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'adversarial',
        outcome: 'applied',
        authorityTier: 'portable_path',
        actions: [
          {
            actionId: 'adversarial:0',
            index: 0,
            action: 'update',
            path: 'src/adversarial.ts',
            outcome: 'applied',
            afterHash: 'after',
          },
        ],
        errors: [],
        freshCapabilities: [],
      })
      const missingCallId = structuredClone(canonical)
      delete missingCallId.authorityReceipt.callId
      const missingAuthorityTier = structuredClone(canonical)
      delete missingAuthorityTier.authorityReceipt.authorityTier
      const duplicateIndex = structuredClone(canonical)
      duplicateIndex.authorityReceipt.actions.push({
        ...duplicateIndex.authorityReceipt.actions[0],
        actionId: 'adversarial:conflicting-index',
      })
      const duplicateActionId = structuredClone(canonical)
      duplicateActionId.authorityReceipt.actions.push({
        ...duplicateActionId.authorityReceipt.actions[0],
        index: 1,
      })

      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              { type: 'json', value: missingCallId },
              { type: 'json', value: missingAuthorityTier },
              { type: 'json', value: duplicateIndex },
              { type: 'json', value: duplicateActionId },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([])
      expect((result.value as any).input.output.status).toBe('blocked')
    })

    test('reports every updated path from a multi-action edit_transaction receipt', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState([
        {
          role: 'tool',
          toolName: 'edit_transaction',
          content: [
            {
              type: 'json',
              value: withCommittedReceipt({
                kind: 'file_mutation_result',
                version: 1,
                operationId: 'editor-multi',
                outcome: 'applied',
                authorityTier: 'portable_path',
                actions: [
                  {
                    actionId: 'a',
                    index: 0,
                    action: 'update',
                    path: 'src/from-apply-patch.ts',
                    outcome: 'applied',
                    beforeHash: 'before',
                    afterHash: 'after',
                  },
                  {
                    actionId: 'b',
                    index: 1,
                    action: 'update',
                    path: 'src/from-smart-patch.ts',
                    outcome: 'applied',
                    beforeHash: 'before',
                    afterHash: 'after',
                  },
                ],
                errors: [],
                freshCapabilities: [],
              }),
            },
          ],
        },
      ])

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([
        'src/from-apply-patch.ts',
        'src/from-smart-patch.ts',
      ])
    })

    test('reports changed files from a standalone commit_receipt artifact', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const updatedState = createMockAgentState([
        {
          role: 'tool',
          toolName: 'edit_transaction',
          content: [
            {
              type: 'json',
              value: {
                kind: 'commit_receipt',
                version: 1,
                receiptId: 'standalone-commit',
                operationId: 'op-standalone',
                callId: 'call-standalone',
                authorityTier: 'conditional_commit',
                status: 'committed',
                actions: [
                  {
                    actionId: 'a1',
                    index: 0,
                    action: 'update',
                    path: 'src/from-commit-receipt.ts',
                    status: 'committed',
                    beforeHash: 'before',
                    afterHash: 'after',
                  },
                ],
                finalHashes: {
                  'src/from-commit-receipt.ts': 'after',
                },
              },
            },
          ],
        },
      ])

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([
        'src/from-commit-receipt.ts',
      ])
      expect((result.value as any).input.output.status).toBe('completed')
    })

    test('reports the destination from a committed move receipt', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              {
                type: 'json',
                value: withCommittedReceipt({
                  kind: 'file_mutation_result',
                  version: 1,
                  operationId: 'editor-move',
                  outcome: 'applied',
                  authorityTier: 'portable_path',
                  actions: [
                    {
                      actionId: 'move',
                      index: 0,
                      action: 'move',
                      path: 'src/old-name.ts',
                      destinationPath: 'src/new-name.ts',
                      outcome: 'applied',
                      beforeHash: 'before',
                      afterHash: 'after',
                    },
                  ],
                  errors: [],
                  freshCapabilities: [],
                }),
              },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([
        'src/new-name.ts',
      ])
      expect((result.value as any).input.output.status).toBe('completed')
    })

    test('rejects move evidence with action or destination receipt mismatches', () => {
      const makeMoveResult = (operationId: string) =>
        withCommittedReceipt({
          kind: 'file_mutation_result',
          version: 1,
          operationId,
          outcome: 'applied',
          authorityTier: 'portable_path',
          actions: [
            {
              actionId: `${operationId}:0`,
              index: 0,
              action: 'move',
              path: `src/${operationId}-old.ts`,
              destinationPath: `src/${operationId}-new.ts`,
              outcome: 'applied',
              beforeHash: 'before',
              afterHash: 'after',
            },
          ],
          errors: [],
          freshCapabilities: [],
        })
      const actionMismatch = makeMoveResult('action-mismatch')
      actionMismatch.authorityReceipt.actions[0].action = 'update'
      const destinationMismatch = makeMoveResult('destination-mismatch')
      destinationMismatch.authorityReceipt.actions[0].destinationPath =
        'src/unauthorized-destination.ts'

      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              { type: 'json', value: actionMismatch },
              { type: 'json', value: destinationMismatch },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([])
      expect((result.value as any).input.output.status).toBe('blocked')
    })

    test('does not attest findings from committed edits covering every finding file', () => {
      const generator = editor.handleSteps!({
        agentState: createMockAgentState([]),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {
          handoff: {
            findings: [
              {
                id: 'review-finding',
                files: ['src/finding.ts', 'src/finding.test.ts'],
              },
            ],
          },
        },
      } as any)
      generator.next()

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              {
                type: 'json',
                value: withCommittedReceipt({
                  kind: 'file_mutation_result',
                  version: 1,
                  operationId: 'unrelated-all-files',
                  outcome: 'applied',
                  authorityTier: 'portable_path',
                  actions: [
                    {
                      actionId: 'source',
                      index: 0,
                      action: 'update',
                      path: 'src/finding.ts',
                      outcome: 'applied',
                      afterHash: 'source-after',
                    },
                    {
                      actionId: 'test',
                      index: 1,
                      action: 'update',
                      path: 'src/finding.test.ts',
                      outcome: 'applied',
                      afterHash: 'test-after',
                    },
                  ],
                  errors: [],
                  freshCapabilities: [],
                }),
              },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([
        'src/finding.ts',
        'src/finding.test.ts',
      ])
      expect((result.value as any).input.output.findingsAddressed).toEqual([])
    })

    test('works with empty initial message history', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First response' }],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        input: { output: { messages: any[] } }
      }
      expect(toolCall.input.output.messages).toHaveLength(1)
    })

    test('excludes automatic target pre-read messages from output', () => {
      const initialState = createMockAgentState([])
      const generator = editor.handleSteps!({
        agentState: initialState,
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
        prompt: ['Target files:', '- src/target.ts'].join('\n'),
      } as any)

      expect(generator.next().value).toEqual({
        toolName: 'read_files',
        input: { paths: ['src/target.ts'] },
      })

      const preReadMessages = [
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'automatic-pre-read',
              toolName: 'read_files',
              input: { paths: ['src/target.ts'] },
            },
          ],
        },
        {
          role: 'tool' as const,
          toolCallId: 'automatic-pre-read',
          toolName: 'read_files',
          content: [
            {
              type: 'json' as const,
              value: { path: 'src/target.ts', content: 'entire source file' },
            },
          ],
        },
      ]
      const preReadState = createMockAgentState(preReadMessages)
      expect(
        generator.next({
          agentState: preReadState,
          toolResult: undefined,
          stepsComplete: false,
        }).value,
      ).toBe('STEP')

      const editorMessage = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Subsequent editor activity' }],
      }
      const result = generator.next({
        agentState: createMockAgentState([...preReadMessages, editorMessage]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.messages).toEqual([editorMessage])
    })

    test('reports target file progress when one target remains unchanged', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
        prompt: [
          'Implement the requested change.',
          '',
          'Target files:',
          '- agents/base2/base2.ts',
          '- agents/__tests__/base2.test.ts',
        ].join('\n'),
      } as any)

      expect(generator.next().value).toEqual({
        toolName: 'read_files',
        input: {
          paths: ['agents/base2/base2.ts', 'agents/__tests__/base2.test.ts'],
        },
      })

      expect(
        generator.next({
          agentState: mockAgentState,
          toolResult: undefined,
          stepsComplete: false,
        }).value,
      ).toBe('STEP')

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              {
                type: 'json',
                value: withCommittedReceipt({
                  kind: 'file_mutation_result',
                  version: 1,
                  operationId: 'editor-progress',
                  outcome: 'applied',
                  authorityTier: 'portable_path',
                  actions: [
                    {
                      actionId: 'edit',
                      index: 0,
                      action: 'update',
                      path: 'agents/base2/base2.ts',
                      outcome: 'applied',
                      beforeHash: 'before',
                      afterHash: 'after',
                    },
                  ],
                  errors: [],
                  freshCapabilities: [],
                }),
              },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.changedFiles).toEqual([
        'agents/base2/base2.ts',
      ])
      expect((result.value as any).input.output.targetFileProgress).toEqual({
        targetFiles: [
          'agents/base2/base2.ts',
          'agents/__tests__/base2.test.ts',
        ],
        changedTargetFiles: ['agents/base2/base2.ts'],
        pendingTargetFiles: ['agents/__tests__/base2.test.ts'],
      })
    })

    test('ignores backticked non-target references outside the target section', () => {
      const mockAgentState = createMockAgentState([])
      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
        prompt: [
          'Target files:',
          '- `src/target.ts`',
          'Relevant pattern:',
          '- Follow `src/reference.ts`.',
        ].join('\n'),
      } as any)

      expect(generator.next().value).toEqual({
        toolName: 'read_files',
        input: { paths: ['src/target.ts'] },
      })
      expect(
        generator.next({
          agentState: mockAgentState,
          toolResult: undefined,
          stepsComplete: false,
        }).value,
      ).toBe('STEP')

      const result = generator.next({
        agentState: createMockAgentState([
          {
            role: 'tool',
            toolName: 'edit_transaction',
            content: [
              {
                type: 'json',
                value: withCommittedReceipt({
                  kind: 'file_mutation_result',
                  version: 1,
                  operationId: 'target-only',
                  outcome: 'applied',
                  authorityTier: 'portable_path',
                  actions: [
                    {
                      actionId: 'target',
                      index: 0,
                      action: 'update',
                      path: 'src/target.ts',
                      outcome: 'applied',
                      afterHash: 'after',
                    },
                  ],
                  errors: [],
                  freshCapabilities: [],
                }),
              },
            ],
          },
        ]),
        toolResult: undefined,
        stepsComplete: true,
      })

      expect((result.value as any).input.output.targetFileProgress).toEqual({
        targetFiles: ['src/target.ts'],
        changedTargetFiles: ['src/target.ts'],
        pendingTargetFiles: [],
      })
      expect((result.value as any).input.output.status).toBe('completed')
    })

    test('pre-reads targets from Markdown heading briefs without colons', () => {
      const mockAgentState = createMockAgentState([])
      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        params: {},
        prompt: [
          '## Requirements',
          '- Implement the change.',
          '## Target files',
          '- server/src/db/elastic.ts',
          '- server/src/db/elastic.test.ts',
          '## Constraints/non-goals',
          '- Preserve the existing API.',
        ].join('\n'),
      } as any)

      expect(generator.next().value).toEqual({
        toolName: 'read_files',
        input: {
          paths: ['server/src/db/elastic.ts', 'server/src/db/elastic.test.ts'],
        },
      })
    })
  })

  describe('style notes in instructions', () => {
    test('mentions try/catch blocks', () => {
      expect(editor.instructionsPrompt).toContain('try/catch')
    })

    test('uses language-idiomatic argument conventions', () => {
      expect(editor.instructionsPrompt).toContain(
        'defaults, optionals, builders, or overloads',
      )
    })

    test('mentions new components in new files', () => {
      expect(editor.instructionsPrompt).toContain('new file')
    })

    test('recovery guidance is not added to the default editor', () => {
      expect(editor.instructionsPrompt).not.toContain('Recovery guidance:')
    })
  })
})
