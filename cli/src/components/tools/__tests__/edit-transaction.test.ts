import { describe, expect, test } from 'bun:test'

import {
  EditTransactionComponent,
  getTransactionRenderData,
} from '../edit-transaction'

import type { ToolBlock } from '../types'
import type { ChatTheme } from '../../../types/theme-system'

// The statically narrowed block type the render callback is declared over;
// existentially resolved from the render signature so the test suite stays
// compile-locked to the component contract instead of hand-narrowing.
type NarrowedRenderBlock = Parameters<
  typeof EditTransactionComponent.render
>[0]

const makeToolBlock = (toolCallId: string, outputRaw: unknown): ToolBlock =>
  ({
    type: 'tool',
    toolCallId,
    toolName: 'edit_transaction',
    input: {},
    outputRaw,
  }) as unknown as ToolBlock

const makePayload = (patch: string, path = 'src/a.ts'): unknown => ({
  files: [{ path, patch }],
})

const RENDER_OPTIONS = {
  availableWidth: 80,
  indentationOffset: 0,
  labelWidth: 0,
}

describe('EditTransaction render-data memoization', () => {
  test('re-render with the SAME outputRaw reuses the cached parse (no re-walk)', () => {
    const block = makeToolBlock('call-cache-hit', makePayload('-old\n+new\n'))
    const first = getTransactionRenderData(block)
    const second = getTransactionRenderData(block)
    // Same derived object by reference: the payload was not re-walked.
    expect(second).toBe(first)
    expect(second.files).toBe(first.files)
    expect(second.diffStats).toEqual({ added: 1, removed: 1 })
  })

  test('re-render with a DIFFERENT outputRaw invalidates and recomputes', () => {
    const block = makeToolBlock(
      'call-invalidate',
      makePayload('-old\n+new\n'),
    )
    const first = getTransactionRenderData(block)
    const replaced = makeToolBlock(
      'call-invalidate',
      makePayload('-aa\n+bb\n+cc\n'),
    )
    const second = getTransactionRenderData(replaced)
    expect(second.payloadKey).not.toBe(first.payloadKey)
    expect(second.files[0]?.diff).toBe('-aa\n+bb\n+cc\n')
    expect(second.diffStats).toEqual({ added: 2, removed: 1 })
  })

  test('an outputRaw MUTATED in place between renders invalidates (streaming append)', () => {
    // The same block object the whole time, as streaming handlers mutate a
    // block's outputRaw in place; only the payload body changed.
    const outputRaw = makePayload('-x\n+y\n', 'src/m.ts')
    const block = makeToolBlock('call-mutate', outputRaw)
    const first = getTransactionRenderData(block)

    const files = (outputRaw as { files: unknown[] }).files
    files.push({ path: 'src/n.ts', patch: '-p\n+q\n' })

    const second = getTransactionRenderData(block)
    expect(second).not.toBe(first)
    expect(second.files).toHaveLength(2)
    expect(second.diffStats).toEqual({ added: 2, removed: 2 })
  })

  test('no cross-instance leakage: another toolCallId gets its own parse', () => {
    const sharedPayload = makePayload('-old\n+new\n')
    const first = getTransactionRenderData(makeToolBlock('call-a', sharedPayload))
    const second = getTransactionRenderData(makeToolBlock('call-b', sharedPayload))
    // Distinct derivation per block even for byte-identical payloads.
    expect(second).not.toBe(first)
    expect(second.diffStats).toEqual(first.diffStats)
  })

  test('render output is unchanged by the memo layer (size suffix collapses to preview)', () => {
    const fakeTheme = {} as unknown as ChatTheme
    const config = EditTransactionComponent.render(
      makeToolBlock('call-render', makePayload('-old\n+new\n')) as unknown as NarrowedRenderBlock,
      fakeTheme,
      RENDER_OPTIONS,
    )
    expect(config.collapsedPreview).toBe('Edit transaction • 1 file (+1 -1)')
  })

  test('render output is unchanged for the error path (redaction intact)', () => {
    const fakeTheme = {} as unknown as ChatTheme
    const config = EditTransactionComponent.render(
      makeToolBlock('call-error', {
        errorMessage: 'boom cap.v3.1.2.abcdef',
      }) as unknown as NarrowedRenderBlock,
      fakeTheme,
      RENDER_OPTIONS,
    )
    expect(config.collapsedPreview).toBe('boom [REDACTED]')
  })
})
