import { describe, expect, it } from 'bun:test'

import {
  deriveExpectedFacts,
  verifyExtractionCoverage,
} from '../compaction-verification'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const readCall = (callId: string, path: string): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'read_files',
      input: { paths: [path] },
    },
  ],
})
const commandCall = (callId: string, command: string): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'run_terminal_command',
      input: { command },
    },
  ],
})

describe('deriveExpectedFacts', () => {
  it('derives paths from read/write calls and truncates commands', () => {
    const pre: Message[] = [
      readCall('c1', 'src/keystone.ts'),
      commandCall('c2', 'bun test --coverage --verbose src/keystone.test.ts'),
    ]
    const facts = deriveExpectedFacts(pre)
    expect(facts).toContain('src/keystone.ts')
    expect(facts.some((f) => f.startsWith('bun test --coverage'))).toBe(true)
  })

  it('ignores non-path-like and malformed inputs', () => {
    const pre: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'read_files',
            input: { paths: ['justtext', '/absolute/path', '../up.ts', 42] },
          },
        ],
      },
    ]
    expect(deriveExpectedFacts(pre)).toEqual([])
  })
})

describe('verifyExtractionCoverage', () => {
  const pre: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    readCall('c1', 'src/kept.ts'),
    readCall('c2', 'src/dropped.ts'),
  ]

  it('reports a fact retained in post-compaction history as covered', () => {
    const post: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<knowledge_memory>Files inspected: src/kept.ts</knowledge_memory>',
          },
        ],
      },
    ]
    const result = verifyExtractionCoverage({
      preMessages: pre,
      postMessages: post,
    })
    expect(result.expected).toBe(2)
    expect(result.missing).toEqual(['src/dropped.ts'])
  })

  it('accepts task memory as a covering surface', () => {
    const post: Message[] = []
    const result = verifyExtractionCoverage({
      preMessages: pre,
      postMessages: post,
      taskMemory: {
        filesInspected: ['read:src/dropped.ts', 'src/kept.ts'],
      } as never,
    })
    expect(result.missing).toEqual([])
  })

  it('bounds the missing list so recovery guidance stays readable', () => {
    const many: Message[] = []
    for (let i = 0; i < 30; i++) many.push(readCall(`c${i}`, `src/gone-${i}.ts`))
    const result = verifyExtractionCoverage({
      preMessages: many,
      postMessages: [],
    })
    expect(result.expected).toBe(30)
    expect(result.missing.length).toBeLessThanOrEqual(12)
  })
})
