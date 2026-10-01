import { describe, test, expect } from 'bun:test'

import {
  computeWindow,
  estimateMessageHeight,
} from '../hooks/use-viewport-window'

import type { ChatMessage, ContentBlock, ToolContentBlock } from '../types/chat'

const WIDTH = 80

const makeMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  variant: 'user',
  content: '',
  timestamp: '00:00',
  ...overrides,
})

const textBlock = (content: string): ContentBlock => ({
  type: 'text',
  content,
})

describe('estimateMessageHeight', () => {
  test('user message with short content wraps to a small height', () => {
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: 'hello world' }),
      WIDTH,
    )
    // 2 base rows + 1 content row
    expect(h).toBe(3)
  })

  test('long user content wraps to additional lines', () => {
    const longLine = 'a'.repeat(200) // ~200 wide -> ceil(200/(80-4)) = 3 lines
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: longLine }),
      WIDTH,
    )
    expect(h).toBe(2 + 3)
  })

  test('collapsed agent message has a fixed small height', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'agent',
        content: 'x'.repeat(500),
        metadata: { isCollapsed: true },
      }),
      WIDTH,
    )
    expect(h).toBe(2)
  })

  test('mode-divider single-block message is one row', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'ai',
        blocks: [{ type: 'mode-divider', mode: 'default' }],
      }),
      WIDTH,
    )
    expect(h).toBe(1)
  })

  test('ai message sums block estimates and includes footer base', () => {
    const h = estimateMessageHeight(
      makeMessage({
        variant: 'ai',
        blocks: [textBlock('short')],
      }),
      WIDTH,
    )
    // 2 base rows + 1 text line
    expect(h).toBe(3)
  })

  test('ai message with many tool blocks grows the estimate', () => {
    const blocks: ContentBlock[] = Array.from(
      { length: 5 },
      (_, i): ToolContentBlock => ({
        type: 'tool',
        toolCallId: `t${i}`,
        toolName: 'read_file' as ToolContentBlock['toolName'],
        input: {},
      }),
    )
    const h = estimateMessageHeight(
      makeMessage({ variant: 'ai', blocks }),
      WIDTH,
    )
    // 2 base + 5 * 3 tool rows
    expect(h).toBe(2 + 15)
  })

  test('estimate is clamped to a sane minimum', () => {
    const h = estimateMessageHeight(
      makeMessage({ variant: 'user', content: '' }),
      WIDTH,
    )
    expect(h).toBeGreaterThanOrEqual(1)
  })
})

describe('computeWindow', () => {
  // Build 100 messages each 10 rows tall, stacked after a 2-row header.
  const COUNT = 100
  const HEIGHT = 10
  const HEADER = 2
  const heights = Array.from({ length: COUNT }, () => HEIGHT)
  const offsets = Array.from(
    { length: COUNT },
    (_, i) => HEADER + i * HEIGHT,
  )
  const totalHeight = HEADER + COUNT * HEIGHT

  test('windows only the intersecting subset for a mid-scroll viewport', () => {
    const { startIndex, endIndex } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: 500,
      viewportHeight: 100,
      overscanPx: 20,
    })
    // windowStart=480 -> message 47 ([472,482)); windowEnd=620 -> message 61.
    expect(startIndex).toBeGreaterThan(0)
    expect(endIndex).toBeLessThan(COUNT - 1)
    expect(endIndex).toBeGreaterThan(startIndex)
    // Mounted subset is far smaller than the full list.
    expect(endIndex - startIndex + 1).toBeLessThan(COUNT / 2)
  })

  test('at the top the window starts at index 0 with no top spacer', () => {
    const { startIndex, topSpacerHeight } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(startIndex).toBe(0)
    expect(topSpacerHeight).toBe(HEADER)
  })

  test('top and bottom spacers sum with the window to the total height', () => {
    const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } =
      computeWindow({
        offsets,
        heights,
        totalHeight,
        scrollTop: 500,
        viewportHeight: 100,
        overscanPx: 20,
      })
    const windowedHeight =
      offsets[endIndex] + heights[endIndex] - offsets[startIndex]
    expect(topSpacerHeight + windowedHeight + bottomSpacerHeight).toBe(
      totalHeight,
    )
  })

  test('empty message list produces an empty window', () => {
    const result = computeWindow({
      offsets: [],
      heights: [],
      totalHeight: 0,
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(result).toEqual({
      startIndex: 0,
      endIndex: -1,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    })
  })

  test('scrolling to the bottom includes the last message', () => {
    const { endIndex } = computeWindow({
      offsets,
      heights,
      totalHeight,
      scrollTop: totalHeight - 100,
      viewportHeight: 100,
      overscanPx: 20,
    })
    expect(endIndex).toBe(COUNT - 1)
  })
})
