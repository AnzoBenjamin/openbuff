import { describe, test, expect } from 'bun:test'

import filePicker, {
  createFilePicker,
  extractErrorMessage,
} from '../file-explorer/file-picker'

import type { AgentState, ToolCall, StepText } from '../types/agent-definition'

describe('file-picker agent', () => {
  const createMockAgentState = (): AgentState => ({
    agentId: 'file-picker-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory: [],
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  const createMockLogger = () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  })

  describe('definition', () => {
    test('has correct id', () => {
      expect(filePicker.id).toBe('file-picker')
    })

    test('has display name', () => {
      expect(filePicker.displayName).toBe('Fletcher the File Fetcher')
    })

    test('has structured file output', () => {
      expect(filePicker.outputMode).toBe('structured_output')
      expect(filePicker.outputSchema).toBeDefined()
    })

    test('does not include message history', () => {
      expect(filePicker.includeMessageHistory).toBe(false)
    })

    test('has spawn_agents tool', () => {
      expect(filePicker.toolNames).toContain('spawn_agents')
      expect(filePicker.toolNames).toContain('set_output')
      expect(filePicker.programmaticToolNames ?? []).not.toContain('read_files')
    })

    test('can spawn file-lister agent', () => {
      expect(filePicker.spawnableAgents).toContain('file-lister')
    })

    test('has disabled reasoning', () => {
      expect(filePicker.reasoningOptions?.enabled).toBe(false)
    })
  })

  describe('createFilePicker', () => {
    test('uses flash-lite model', () => {
      const picker = createFilePicker()
      expect(picker.model).toBeUndefined()
    })

    test('spawns single file-lister', () => {
      const picker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = picker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      const result = generator.next()

      const toolCall = result.value as ToolCall<'spawn_agents'>
      expect(toolCall.toolName).toBe('spawn_agents')
      expect(toolCall.input.agents).toHaveLength(1)
      expect(toolCall.input.agents[0].agent_type).toBe('file-lister')
    })
  })

  describe('input schema', () => {
    test('has prompt parameter', () => {
      expect(filePicker.inputSchema?.prompt?.type).toBe('string')
    })

    test('has optional directories parameter', () => {
      const dirSchema = filePicker.inputSchema?.params?.properties?.directories
      const dirSchemaObj =
        dirSchema && typeof dirSchema === 'object' && !Array.isArray(dirSchema)
          ? dirSchema
          : undefined
      expect(dirSchemaObj?.type).toBe('array')
      expect(filePicker.inputSchema?.params?.required).toHaveLength(0)
    })

    test('directories is array of strings', () => {
      const dirSchema = filePicker.inputSchema?.params?.properties?.directories
      const dirSchemaObj =
        dirSchema && typeof dirSchema === 'object' && !Array.isArray(dirSchema)
          ? dirSchema
          : undefined
      const itemsSchema = dirSchemaObj?.items
      const itemsSchemaObj =
        itemsSchema &&
        typeof itemsSchema === 'object' &&
        !Array.isArray(itemsSchema)
          ? (itemsSchema as { type?: string })
          : undefined
      expect(itemsSchemaObj?.type).toBe('string')
    })
  })

  describe('handleStepsDefault', () => {
    test('yields spawn_agents with file-lister', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        prompt: 'Find auth files',
        params: {},
      })

      const result = generator.next()

      const toolCall = result.value as ToolCall<'spawn_agents'>
      expect(toolCall.toolName).toBe('spawn_agents')
      expect(toolCall.input.agents[0].prompt).toBe('Find auth files')
    })

    test('passes params to file-lister', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        prompt: 'Find files',
        params: { directories: ['src', 'lib'] },
      })

      const result = generator.next()

      const toolCall = result.value as ToolCall<'spawn_agents'>
      expect(toolCall.input.agents[0].params).toEqual({
        directories: ['src', 'lib'],
      })
    })

    test('handles empty tool result gracefully', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      // First yield is spawn_agents
      generator.next()

      // Return empty result
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [] as ToolResultOutput[],
        stepsComplete: true,
      })

      const stepText = result.value as StepText
      expect(stepText.type).toBe('STEP_TEXT')
      expect(stepText.text).toContain('Error')
    })

    test('yields set_output with extracted paths from lastMessage format', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      // First yield is spawn_agents
      generator.next()

      // Mock spawn_agents result - wrapped in toolResult object with production structure
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        { type: 'text', text: 'src/auth.ts\nsrc/login.ts' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toContain('src/auth.ts')
      expect(paths).toContain('src/login.ts')
    })

    test('yields set_output with extracted paths from allMessages format', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'allMessages',
                  value: [
                    {
                      role: 'user',
                      content: [{ type: 'text', text: 'find files' }],
                    },
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'src/user.ts\nsrc/config.ts' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toContain('src/user.ts')
      expect(paths).toContain('src/config.ts')
    })

    test('yields set_output with extracted paths from structuredOutput format', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'structuredOutput',
                  value: { message: 'src/foo.ts\nsrc/bar.ts' },
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toContain('src/foo.ts')
      expect(paths).toContain('src/bar.ts')
    })

    test('deduplicates paths from results', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      // Result with duplicate paths - wrapped in toolResult with production structure
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'src/file.ts\nsrc/file.ts\nsrc/other.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      // Should deduplicate
      const toolCall = result.value as ToolCall<'set_output'>
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toHaveLength(2)
      expect(paths).toContain('src/file.ts')
      expect(paths).toContain('src/other.ts')
    })

    test('yields set_output without read_files', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'src/file.ts' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)
      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.includeToolCall).toBe(false)
      expect(toolCall.input.files).toEqual([
        { path: 'src/file.ts', summary: 'file.ts' },
      ])
      expect(result.done).toBe(false)
      expect(generator.next().done).toBe(true)
    })

    test('handles error results from spawned agents', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      // Result with error - wrapped in toolResult with production structure
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'error',
                  message: 'File lister failed',
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const stepText = result.value as StepText
      expect(stepText.type).toBe('STEP_TEXT')
      expect(stepText.text).toContain('Error from file-lister')
      expect(stepText.text).toContain('File lister failed')
    })

    test('keeps valid paths when neighboring file-lister lines are malformed', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: {},
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'Files:\n- `src/a.ts`\nhttps://example.com\n2. src/b.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      })
      expect(
        (result.value as ToolCall<'set_output'>).input.files.map(
          (file: { path: string }) => file.path,
        ),
      ).toEqual(['src/a.ts', 'src/b.ts'])
    })

    test('rejects unsafe directory prefixes instead of rewriting them to project-relative scope', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: { directories: ['src', '/etc'] },
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'src/a.ts\netc/passwd.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      })
      expect(
        (result.value as ToolCall<'set_output'>).input.files.map(
          (file: { path: string }) => file.path,
        ),
      ).toEqual(['src/a.ts'])
    })

    test('enforces requested directory scope on returned candidates', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: { directories: ['packages/sdk'] },
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'packages/sdk/a.ts\ncli/src/outside.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      })
      expect(
        (result.value as ToolCall<'set_output'>).input.files.map(
          (file: { path: string }) => file.path,
        ),
      ).toEqual(['packages/sdk/a.ts'])
    })

    test('uses a scope-specific message when every safe path is outside requested directories', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: { directories: ['packages/sdk'] },
      })
      generator.next()
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'cli/src/outside.ts\nweb/app.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      })
      const stepText = result.value as StepText
      expect(stepText.type).toBe('STEP_TEXT')
      expect(stepText.text).toBe(
        'No file paths were found within the requested directories.',
      )
      expect(stepText.text).not.toContain('No safe project-relative file paths')
    })

    const spawnFileListResult = (text: string) => ({
      agentState: createMockAgentState(),
      toolResult: [
        {
          type: 'json' as const,
          value: [
            {
              agentName: 'File Lister',
              agentType: 'file-lister',
              value: {
                type: 'lastMessage',
                value: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text }],
                  },
                ],
              },
            },
          ],
        },
      ],
      stepsComplete: true,
    })

    // C1.9: reject path traversal and absolute-outside-cwd before set_output.
    test('keeps filenames that contain adjacent dots but not a .. path segment', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: {},
      })
      generator.next()
      const result = generator.next(
        spawnFileListResult('src/foo..bar.ts\nsrc/ok.ts'),
      )
      expect(
        (result.value as ToolCall<'set_output'>).input.files.map(
          (file: { path: string }) => file.path,
        ),
      ).toEqual(['src/foo..bar.ts', 'src/ok.ts'])
    })

    test('rejects ../ traversal paths and keeps sibling project files', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: {},
      })
      generator.next()
      const result = generator.next(
        spawnFileListResult('src/safe.ts\n../secret.ts\nsrc/also-safe.ts'),
      )
      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toEqual(['src/safe.ts', 'src/also-safe.ts'])
      expect(paths).not.toContain('../secret.ts')
    })

    test('rejects absolute paths outside the project cwd', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: {},
      })
      generator.next()
      const result = generator.next(
        spawnFileListResult('src/ok.ts\n/tmp/outside-cwd.ts\n/etc/passwd.ts'),
      )
      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      expect(paths).toEqual(['src/ok.ts'])
      expect(paths).not.toContain('/tmp/outside-cwd.ts')
      expect(paths).not.toContain('/etc/passwd.ts')
    })

    test('yields STEP_TEXT and skips set_output when every path is unsafe', () => {
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: createMockLogger() as any,
        params: {},
      })
      generator.next()
      const result = generator.next(
        spawnFileListResult('../secret.ts\n/tmp/outside-cwd.ts\n../../etc/hosts.ts'),
      )
      const stepText = result.value as StepText
      expect(stepText.type).toBe('STEP_TEXT')
      expect(stepText.text).toContain('No safe project-relative file paths')
      expect((result.value as { toolName?: string }).toolName).not.toBe(
        'set_output',
      )
    })

    test('traversal drop log counts only unsafe paths, not directory-scope drops', () => {
      const debugMessages: string[] = []
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: {
          debug: (message: string) => {
            debugMessages.push(message)
          },
          info: () => {},
          warn: () => {},
          error: () => {},
        } as any,
        params: { directories: ['src'] },
      })
      generator.next()
      const result = generator.next(
        spawnFileListResult('src/in-scope.ts\nlib/out-of-scope.ts\n../escape.ts'),
      )
      expect(
        (result.value as ToolCall<'set_output'>).input.files.map(
          (file: { path: string }) => file.path,
        ),
      ).toEqual(['src/in-scope.ts'])
      const traversalLogs = debugMessages.filter((message) =>
        message.includes('outside project root or containing traversal'),
      )
      expect(traversalLogs).toEqual([
        'file-picker: dropped 1 path(s) outside project root or containing traversal',
      ])
    })

    test('does not log traversal drops when only directory-scope paths are filtered', () => {
      const debugMessages: string[] = []
      const generator = createFilePicker().handleSteps!({
        agentState: createMockAgentState(),
        logger: {
          debug: (message: string) => {
            debugMessages.push(message)
          },
          info: () => {},
          warn: () => {},
          error: () => {},
        } as any,
        params: { directories: ['src'] },
      })
      generator.next()
      generator.next(
        spawnFileListResult('src/in-scope.ts\nlib/out-of-scope.ts'),
      )
      expect(
        debugMessages.some((message) =>
          message.includes('outside project root or containing traversal'),
        ),
      ).toBe(false)
    })

    // M2.2: relevance scoring orders paths by prompt-keyword matches, and caps
    // to the top 8 (matching the spawner prompt's advertised limit).
    test('orders paths by prompt-keyword relevance', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        prompt: 'Find auth files',
        params: {},
      })

      generator.next()

      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'text',
                          text: 'src/unrelated.ts\nsrc/auth/login.ts\nsrc/auth/session.ts\nsrc/utils/helpers.ts',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      const paths = toolCall.input.files.map((file: { path: string }) => file.path)
      // auth-bearing paths score higher than unrelated/utils paths.
      expect(paths[0]).toBe('src/auth/login.ts')
      expect(paths[1]).toBe('src/auth/session.ts')
      // The two non-auth files retain the file-lister's upstream rank.
      expect(paths).toContain('src/unrelated.ts')
      expect(paths).toContain('src/utils/helpers.ts')
      expect(paths).toHaveLength(4)
    })

    test('caps to top 8 paths when more candidates are returned', () => {
      const defaultPicker = createFilePicker()
      const mockAgentState = createMockAgentState()
      const mockLogger = createMockLogger()

      const generator = defaultPicker.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        prompt: 'search',
        params: {},
      })

      generator.next()

      // 15 candidate paths — should be capped to 8.
      const fifteenPaths = Array.from(
        { length: 15 },
        (_, i) => `src/file${i}.ts`,
      ).join('\n')
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                agentName: 'File Lister',
                agentType: 'file-lister',
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: fifteenPaths }],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      }

      const result = generator.next(mockToolResult)

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.files).toHaveLength(8)
    })
  })

  describe('serialization', () => {
    test('handleSteps can be serialized for default mode', () => {
      const defaultPicker = createFilePicker()
      const handleStepsString = defaultPicker.handleSteps!.toString()

      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      const isolatedFunction = new Function(`return (${handleStepsString})`)()
      expect(typeof isolatedFunction).toBe('function')
    })

    test('serialized default handleSteps does not reference closure helpers', () => {
      const defaultPicker = createFilePicker()
      const isolatedFunction = new Function(
        `return (${defaultPicker.handleSteps!.toString()})`,
      )()
      const generator = isolatedFunction({
        agentState: createMockAgentState(),
        logger: createMockLogger(),
        params: {},
      })

      generator.next()
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: [
              {
                value: {
                  type: 'lastMessage',
                  value: [
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'src/isolated.ts' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
        stepsComplete: true,
      })

      const toolCall = result.value as ToolCall<'set_output'>
      expect(toolCall.toolName).toBe('set_output')
      expect(
        toolCall.input.files.map((file: { path: string }) => file.path),
      ).toEqual(['src/isolated.ts'])
    })
  })

  describe('system prompt', () => {
    test('contains file tree placeholder', () => {
      expect(filePicker.systemPrompt).toContain('{CODEBUFF_FILE_TREE_PROMPT}')
    })

    test('describes file finding purpose', () => {
      expect(filePicker.systemPrompt).toContain('finding')
    })
  })

  describe('instructions prompt', () => {
    test('asks for short report', () => {
      expect(filePicker.instructionsPrompt).toContain('short report')
    })

    test('requests full paths', () => {
      expect(filePicker.instructionsPrompt).toContain('full path')
    })

    test('instructs not to use tools', () => {
      expect(filePicker.instructionsPrompt).toContain('Do not use')
      expect(filePicker.instructionsPrompt).toContain('set_output')
      expect(filePicker.instructionsPrompt).toContain('files')
    })
  })

  describe('spawner prompt', () => {
    test('mentions finding relevant files', () => {
      expect(filePicker.spawnerPrompt).toContain('relevant files')
    })

    test('mentions up to 8 file paths', () => {
      expect(filePicker.spawnerPrompt).toContain('8')
    })

    test('mentions fuzzy search', () => {
      expect(filePicker.spawnerPrompt).toContain('fuzzy')
    })
  })

  describe('extractErrorMessage', () => {
    test('extracts message from error result', () => {
      expect(
        extractErrorMessage({ type: 'error', message: 'Something failed' }),
      ).toBe('Something failed')
    })

    test('falls back to value if no message', () => {
      expect(extractErrorMessage({ type: 'error', value: 'Error value' })).toBe(
        'Error value',
      )
    })

    test('returns null for non-error types', () => {
      expect(extractErrorMessage({ type: 'lastMessage', value: [] })).toBeNull()
    })

    test('returns null for null input', () => {
      expect(extractErrorMessage(null)).toBeNull()
    })
  })

})
