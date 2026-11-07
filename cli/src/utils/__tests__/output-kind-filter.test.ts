import { expect, test } from 'bun:test'
import {
  collectOutputEntries,
  filterOutputEntries,
  type OutputEntry,
} from '../output-catalog'
import { createTextDocument } from '../output-document'
import type { ChatMessage } from '../../types/chat'

test('Changes skips unrelated document projection while preserving legacy entries without metadata', () => {
  let unrelatedReads = 0
  const entries: OutputEntry[] = [
    {
      id: 'log',
      title: 'Large log',
      messageId: 'message',
      possibleKinds: ['log'],
      read: () => {
        unrelatedReads++
        throw new Error('Unrelated source must not be projected')
      },
    },
    {
      id: 'diff',
      title: 'Changes',
      messageId: 'message',
      possibleKinds: ['diff'],
      read: () =>
        createTextDocument({
          id: 'diff',
          title: 'Changes',
          text: 'retained change',
          kind: 'diff',
        }),
    },
    {
      id: 'legacy',
      title: 'Receipt',
      messageId: 'message',
      read: () =>
        createTextDocument({
          id: 'legacy',
          title: 'Receipt',
          text: 'retained receipt',
          kind: 'receipt',
        }),
    },
  ]
  expect(
    filterOutputEntries(entries, ['diff', 'receipt']).map((entry) => entry.id),
  ).toEqual(['diff', 'legacy'])
  expect(unrelatedReads).toBe(0)
})

test('captured kind metadata remains conservative for logs, reasoning, receipts and changes', () => {
  const messages = [
    {
      id: 'kinds',
      variant: 'ai',
      content: '',
      timestamp: '',
      blocks: [
        {
          type: 'text',
          content: 'Retained reasoning',
          textType: 'reasoning',
          thinkingId: 'thought',
        },
        {
          type: 'tool',
          toolCallId: 'log',
          toolName: 'run_terminal_command',
          input: { command: 'fixture' },
          outputRaw: [
            { type: 'json', value: { stdout: 'Retained log', exitCode: 1 } },
          ],
        },
        {
          type: 'tool',
          toolCallId: 'receipt',
          toolName: 'set_output',
          input: { output: { result: 'done' } },
          outputRaw: [{ type: 'json', value: { status: 'success' } }],
        },
        {
          type: 'tool',
          toolCallId: 'diff',
          toolName: 'git_status',
          input: {},
          outputRaw: [
            {
              type: 'json',
              value: { diff: 'diff --git a/a.ts b/a.ts\n-old\n+new' },
            },
          ],
        },
      ],
    },
  ] as ChatMessage[]
  const entries = collectOutputEntries(messages)
  for (const entry of entries)
    expect(entry.possibleKinds).toContain(entry.read().kind)
  const selected = filterOutputEntries(entries, ['diff', 'receipt'])
  expect(selected.some((entry) => entry.id === 'tool:receipt')).toBe(true)
  expect(selected.some((entry) => entry.id.endsWith(':diff'))).toBe(true)
  expect(selected.some((entry) => entry.id === 'tool:log')).toBe(false)
})
