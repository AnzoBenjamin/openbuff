import { expect, test } from 'bun:test'
import {
  appendTextToRootStream,
  appendTextToAgentBlock,
} from '../block-operations'
import { processBlocks } from '../block-processor'
import type { ContentBlock } from '../../types/chat'

const shape = (blocks: ContentBlock[]) =>
  blocks.map((block) =>
    block.type === 'text'
      ? {
          type: block.type,
          text: block.content,
          textType: block.textType,
          open: block.thinkingOpen,
        }
      : { type: block.type },
  )
const stream = (parts: string[]) =>
  parts.reduce(
    (blocks, text) => appendTextToRootStream(blocks, { type: 'text', text }),
    [] as ContentBlock[],
  )
const childStream = (parts: string[]) => {
  const initial: ContentBlock[] = [
    {
      type: 'agent',
      agentId: 'child',
      agentType: 'fixture',
      agentName: 'Fixture',
      content: '',
      blocks: [],
      status: 'running',
    },
  ]
  const [child] = parts.reduce(
    (blocks, text) => appendTextToAgentBlock(blocks, 'child', text),
    initial,
  )
  if (child?.type !== 'agent') throw new Error('expected retained child')
  return child.blocks ?? []
}

test('complete, unclosed and partial think delimiters preserve every reasoning/answer boundary across every split', () => {
  for (const text of [
    'before <think>inside</think> after',
    '<think>inside</think>',
    '<think></think>after',
    '<think>unclosed 👩🏽‍💻 é',
    'answer <thi',
    '<think>reason </thi',
    'literal </think> outside',
    '<think>nested <think> literal</think> answer',
    'a<think>one</think>b<think>two</think>c',
    '<think>one</think><think>two</think>',
  ]) {
    const whole = shape(stream([text]))
    for (let index = 0; index <= text.length; index++) {
      expect(shape(stream([text.slice(0, index), text.slice(index)]))).toEqual(
        whole,
      )
      expect(
        shape(childStream([text.slice(0, index), text.slice(index)])),
      ).toEqual(whole)
    }
    expect(shape(stream([...text]))).toEqual(whole)
    expect(shape(childStream([...text]))).toEqual(whole)
  }
  const complete = stream(['before <think>inside</think> after'])
  expect(
    complete
      .filter((block) => block.type === 'text')
      .map((block) => block.content),
  ).toEqual(['before ', 'inside', ' after'])
  expect(complete[1]).toMatchObject({
    textType: 'reasoning',
    thinkingOpen: false,
  })
  for (const blocks of [
    stream(['<think>one</think><think>two</think>']),
    childStream(['<think>one</think><think>two</think>']),
  ]) {
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      if (block.type !== 'text') throw new Error('expected reasoning')
      expect(block.thinkingOpen).toBe(false)
      expect(block.thinkingEndedAt).toBeGreaterThanOrEqual(
        block.thinkingStartedAt!,
      )
      expect(block.thinkingCollapseState).toBe('preview')
    }
  }
})
test('new native reasoning never appends to a closed reasoning record and ids remain distinct from persisted counters', () => {
  const source: ContentBlock[] = [
    {
      type: 'text',
      content: 'closed',
      textType: 'reasoning',
      thinkingOpen: false,
      thinkingId: 'thinking-1',
    },
  ]
  const updated = appendTextToRootStream(source, {
    type: 'reasoning',
    text: 'new',
  })
  expect(updated).toHaveLength(2)
  expect(updated[0]).toBe(source[0])
  expect(updated[1]).toMatchObject({ content: 'new', textType: 'reasoning' })
  const id = updated[1].type === 'text' ? updated[1].thinkingId : ''
  expect(id).toMatch(
    /^thinking-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(source[0]).toMatchObject({
    content: 'closed',
    thinkingId: 'thinking-1',
  })
})
test('the child producer preserves the same split-delimiter contract without changing source agent data', () => {
  const original: ContentBlock[] = [
    {
      type: 'agent',
      agentId: 'child',
      agentType: 'fixture',
      agentName: 'Fixture',
      content: '',
      blocks: [],
      status: 'running',
    },
  ]
  let children = original
  for (const text of ['before <thi', 'nk>inside</t', 'hink> after'])
    children = appendTextToAgentBlock(children, 'child', text)
  const agent = children[0]
  if (agent.type !== 'agent') throw new Error('expected retained child')
  expect(shape(agent.blocks ?? [])).toEqual(
    shape(stream(['before <think>inside</think> after'])),
  )
  expect(original[0]).toMatchObject({ content: '', blocks: [] })
})

test('CB04 reasoning groups retain their own identity, open/collapse state and duration', () => {
  const first = {
    type: 'text' as const,
    content: 'first ',
    textType: 'reasoning' as const,
    thinkingId: 'first',
    thinkingOpen: false,
    thinkingCollapseState: 'hidden' as const,
    thinkingStartedAt: 1000,
    thinkingEndedAt: 3000,
  }
  const blocks: ContentBlock[] = [
    first,
    { ...first, content: 'fragment' },
    {
      ...first,
      content: 'active',
      thinkingId: 'second',
      thinkingOpen: true,
      thinkingCollapseState: 'preview',
      thinkingStartedAt: 5000,
      thinkingEndedAt: undefined,
    },
  ]
  const groups: ContentBlock[][] = []
  processBlocks(blocks, {
    onReasoningGroup: (group) => {
      groups.push(group)
      return null
    },
    onToolGroup: () => null,
    onImplementorGroup: () => null,
    onAgentGroup: () => null,
    onSingleBlock: () => null,
  })
  expect(groups).toEqual([blocks.slice(0, 2), blocks.slice(2)])
  for (const change of [
    { thinkingOpen: true },
    { thinkingCollapseState: 'expanded' as const },
    { thinkingStartedAt: 4000 },
    { thinkingEndedAt: 6000 },
  ]) {
    groups.length = 0
    processBlocks([first, { ...first, ...change }], {
      onReasoningGroup: (group) => {
        groups.push(group)
        return null
      },
      onToolGroup: () => null,
      onImplementorGroup: () => null,
      onAgentGroup: () => null,
      onSingleBlock: () => null,
    })
    expect(groups).toHaveLength(2)
  }
})
