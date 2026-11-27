import { describe, expect, test } from 'bun:test'
import { buildMessageTree } from '../message-tree-utils'
import type { ChatMessage } from '../../types/chat'

const message = (id: string, parentId?: string): ChatMessage => ({
  id,
  parentId,
  variant: parentId ? 'agent' : 'ai',
  content: '',
  timestamp: '00:00',
})

describe('message tree streaming updates', () => {
  test('retains root and unaffected child arrays when one agent streams', () => {
    const messages = [
      message('root'),
      message('a', 'root'),
      message('b', 'root'),
      message('child', 'a'),
    ]
    const first = buildMessageTree(messages)
    const updated = { ...messages[3], content: 'new streamed text' }
    const next = buildMessageTree([...messages.slice(0, 3), updated], first)
    expect(next.topLevelMessages).toBe(first.topLevelMessages)
    expect(next.tree.get('root')).toBe(first.tree.get('root'))
    expect(next.tree.get('a')).not.toBe(first.tree.get('a'))
    expect(next.tree.get('a')?.[0]).toBe(updated)
    expect(first.tree.get('a')?.[0].content).toBe('')
  })

  test('updates membership and ordering without changing the previous tree', () => {
    const root = message('root')
    const a = message('a', 'root')
    const b = message('b', 'root')
    const first = buildMessageTree([root, a, b])
    const reordered = buildMessageTree([root, b, a], first)
    expect(reordered.tree.get('root')).toEqual([b, a])
    expect(reordered.tree.get('root')).not.toBe(first.tree.get('root'))
    const removed = buildMessageTree([root], reordered)
    expect(removed.tree.has('root')).toBe(false)
    expect(first.tree.get('root')).toEqual([a, b])
  })
})
