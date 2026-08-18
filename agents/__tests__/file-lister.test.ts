import { describe, expect, test } from 'bun:test'

import { createFileLister } from '../file-explorer/file-lister'

import type { AgentState, StepText, ToolCall } from '../types/agent-definition'
import type { ToolResultOutput } from '../types/util-types'

const createMockAgentState = (): AgentState => ({
  agentId: 'file-lister-test',
  runId: 'test-run',
  parentId: undefined,
  messageHistory: [],
  output: undefined,
  systemPrompt: '',
  toolDefinitions: {},
  contextTokenCount: 0,
})

const nextResult = (toolResult?: ToolResultOutput[]) => ({
  agentState: createMockAgentState(),
  toolResult,
  stepsComplete: true,
})

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('file-lister agent', () => {
  test('returns deterministic paths only from requested directories', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find React component files',
      params: { directories: ['frontend'] },
    })

    const queryCall = generator.next().value as ToolCall
    expect(queryCall.toolName).toBe('query_index')
    expect(queryCall.input).toMatchObject({
      pathPrefixes: ['frontend'],
    })
    expect(
      (generator.next(nextResult([])).value as ToolCall).toolName,
    ).toBe('read_subtree')

    const result = generator.next(
      nextResult([
        {
          type: 'json',
          value: [
            {
              path: 'frontend',
              type: 'directory',
              printedTree:
                'frontend/\n src/\n  App.tsx\n   App render\n  components/\n   Button.tsx\n    Button\nbackend/\n src/\n  server.ts\n',
            },
          ],
        },
      ]),
    )
    const output = result.value as StepText

    expect(output.type).toBe('STEP_TEXT')
    expect(output.text).toContain('frontend/src/App.tsx')
    expect(output.text).toContain('frontend/src/components/Button.tsx')
    expect(output.text).not.toContain('backend')
  })

  test('ranks project files from the subtree when directories are omitted', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find files related to user authentication and user management',
    })

    expect((generator.next().value as ToolCall).toolName).toBe('query_index')
    expect(
      (generator.next(nextResult([])).value as ToolCall).toolName,
    ).toBe('read_subtree')

    const result = generator.next(
      nextResult([
        {
          type: 'json',
          value: [
            {
              path: '.',
              type: 'directory',
              printedTree:
                'src/\n services/\n  user-service.ts\n   getUser\n  auth-service.ts\n   login\n  billing-service.ts\n types/\n  user.ts\n  invoice.ts\n utils/\n  logger.ts\nindex.ts\npackage.json\nREADME.md\ndocs/\n guide.md\n',
            },
          ],
        },
      ]),
    )
    const output = result.value as StepText
    const rankedPaths = output.text.split('\n')

    expect(output.type).toBe('STEP_TEXT')
    expect(rankedPaths).toContain('src/services/user-service.ts')
    expect(rankedPaths).toContain('src/services/auth-service.ts')
    expect(rankedPaths).toContain('src/types/user.ts')
    expect(rankedPaths.indexOf('src/services/user-service.ts')).toBeLessThan(
      rankedPaths.indexOf('src/services/billing-service.ts'),
    )
    expect(rankedPaths.indexOf('src/types/user.ts')).toBeLessThan(
      rankedPaths.indexOf('src/services/billing-service.ts'),
    )
  })

  test('uses query_index results as candidates when the subtree is unusable', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find files related to user authentication and user management',
    })

    expect((generator.next().value as ToolCall).toolName).toBe('query_index')
    expect(
      (
        generator.next(
          nextResult([
            {
              type: 'json',
              value: {
                kind: 'query_index_result',
                results: [
                  {
                    path: 'src/services/user-service.ts',
                    relatedFiles: [
                      { path: 'src/services/auth-service.ts' },
                      { path: 'src/types/user.ts' },
                    ],
                  },
                ],
              },
            },
          ]),
        ).value as ToolCall
      ).toolName,
    ).toBe('read_subtree')

    const result = generator.next(
      nextResult([{ type: 'json', value: { errorMessage: 'read failed' } }]),
    )
    const output = result.value as StepText

    expect(output.type).toBe('STEP_TEXT')
    expect(output.text).toContain('src/services/user-service.ts')
    expect(output.text).toContain('src/services/auth-service.ts')
    expect(output.text).toContain('src/types/user.ts')
  })

  test('falls back to model ranking when index and subtree output are malformed', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find React component files',
      params: { directories: ['frontend'] },
    })

    generator.next()
    generator.next(nextResult([]))
    const result = generator.next(
      nextResult([{ type: 'json', value: { errorMessage: 'read failed' } }]),
    )

    expect(result.value).toBe('STEP')
  })

  test('parses a 2-space-indented printedTree when directories are omitted', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find user service files',
    })

    expect((generator.next().value as ToolCall).toolName).toBe('query_index')
    expect(
      (generator.next(nextResult([])).value as ToolCall).toolName,
    ).toBe('read_subtree')

    const result = generator.next(
      nextResult([
        {
          type: 'json',
          value: [
            {
              path: '.',
              type: 'directory',
              printedTree:
                'src/\n  services/\n    user-service.ts\n      getUser\n    auth-service.ts\n',
            },
          ],
        },
      ]),
    )
    const output = result.value as StepText

    expect(output.type).toBe('STEP_TEXT')
    expect(output.text).toContain('src/services/user-service.ts')
  })

  test('rejects invalid directories without calling query_index or read_subtree', () => {
    const definition = createFileLister()
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find React component files',
      params: {
        directories: ['/abs/path', '../escape', 'src/**', 'foo*'],
      },
    })

    const result = generator.next()
    const output = result.value as StepText

    expect(output.type).toBe('STEP_TEXT')
    expect(output.text).toBe(
      'No valid project-relative directory scope was provided.',
    )
    expect((result.value as { toolName?: string }).toolName).toBeUndefined()
    expect(result.done).toBe(false)
    expect(generator.next().done).toBe(true)
  })

  test('uses at most 8 valid directories and ignores extras', () => {
    const definition = createFileLister()
    const directories = [
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
      'd8',
      'd9',
    ]
    const generator = definition.handleSteps!({
      agentState: createMockAgentState(),
      logger,
      prompt: 'Find files',
      params: { directories },
    })

    const queryCall = generator.next().value as ToolCall
    expect(queryCall.toolName).toBe('query_index')
    expect(queryCall.input).toMatchObject({
      pathPrefixes: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'],
    })
    expect(
      (definition.inputSchema?.params?.properties?.directories as {
        description?: string
      })?.description,
    ).toContain('extra entries are ignored')
  })
})
