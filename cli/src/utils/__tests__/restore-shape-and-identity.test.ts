import { expect, test } from 'bun:test'
import { validatePersistedMessages } from '../run-state-storage'
import { collectOutputEntries } from '../output-catalog'

const message = (blocks: unknown = []) => ({
  id: 'saved',
  variant: 'ai',
  timestamp: '2026-11-03T00:00:00Z',
  content: 'Retained answer',
  blocks,
})

test('saved content and nested blocks fail closed before native rendering', () => {
  for (const invalid of [
    { ...message(), content: { broken: true } },
    message([{ type: 'text', content: null }]),
    message([{ type: 'tool', toolName: {}, toolCallId: 'tool' }]),
    message([
      {
        type: 'agent',
        agentId: 'child',
        agentName: 'Child',
        agentType: 'fixture',
        content: '',
        blocks: [null],
      },
    ]),
    message([{ type: 'image', image: 42, mediaType: 'image/png' }]),
  ])
    expect(validatePersistedMessages([invalid])).toBeNull()
  expect(
    validatePersistedMessages([
      message([{ type: 'text', content: 'Exact bytes  \n' }]),
    ])?.[0].content,
  ).toBe('Retained answer')
})

test('restored legacy thinking IDs retain fragments while isolating groups and nested agents', () => {
  const thought = (content: string) => ({
    type: 'text',
    content,
    thinkingId: 'thinking-1',
    textType: 'reasoning',
    thinkingOpen: false,
  })
  const saved = validatePersistedMessages([
    message([
      thought('first '),
      thought('fragment'),
      { type: 'text', content: 'answer' },
      thought('second'),
    ]),
    {
      ...message([
        {
          type: 'agent',
          agentId: 'child',
          agentName: 'Child',
          agentType: 'fixture',
          content: '',
          blocks: [thought('nested')],
        },
      ]),
      id: 'next',
    },
  ])!
  const blocks = saved[0].blocks! as any[]
  expect(blocks[0].thinkingId).toBe(blocks[1].thinkingId)
  expect(blocks[0].thinkingId).not.toBe(blocks[3].thinkingId)
  expect(blocks[0].thinkingId).not.toBe(
    (saved[1].blocks![0] as any).blocks[0].thinkingId,
  )
  expect(blocks.map((block) => block.content).join('')).toBe(
    'first fragmentanswersecond',
  )
})

test('malformed secondary blocks fail closed and direct diagnostic inspection preserves raw evidence', () => {
  for (const block of [
    {
      type: 'doctor',
      projectRoot: '/project',
      providerStatus: 'Unknown',
      diagnostics: null,
    },
    { type: 'memory', state: 'status', counts: null, evidence: null },
    { type: 'completion-summary', summary: null },
    { type: 'update', lines: { length: 10 } },
    { type: 'agent-list', agents: [null] },
    { type: 'ask-user', toolCallId: 'question', questions: [null] },
  ])
    expect(validatePersistedMessages([message([block])])).toBeNull()
  const retained = collectOutputEntries([
    message([{ type: 'doctor', diagnostics: null, providerStatus: 'Unknown' }]),
  ] as never)[0].read()
  expect(retained.text).toContain('diagnostics')
  expect(retained.notice).toContain('Diagnostic list unavailable')
})
