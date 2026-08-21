import { describe, expect, test } from 'bun:test'

import { getToolMetadata } from '@codebuff/common/tools/metadata'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { getLegacyPatchOperations } from '../apply-patch'
import {
  getRegisteredToolNames,
  getToolRendererDisposition,
  renderToolComponent,
} from '../registry'

import type { PersistedToolBlock } from '../registry'

initializeThemeStore()

/**
 * Persisted chat blocks store `toolName` verbatim, so a restored session can
 * still contain the removed `apply_patch` tool. Rendering those blocks must not
 * dereference an undefined metadata record.
 */
const restoredLegacyBlock: PersistedToolBlock = {
  type: 'tool',
  toolName: 'apply_patch',
  toolCallId: 'restored-apply-patch',
  input: { input: [{ type: 'update_file', path: 'src/a.ts' }] },
  output: 'message: Updated file',
}

/**
 * The other persisted shape: the single `{ operation: { path, diff } }`
 * envelope the removed tools recorded. The surviving generic mutation-summary
 * helpers read only `input.path` / `input.content`, so the dedicated renderer
 * owns resolving this shape.
 */
const restoredOperationEnvelopeBlock: PersistedToolBlock = {
  type: 'tool',
  toolName: 'apply_patch',
  toolCallId: 'restored-apply-patch-envelope',
  input: {
    operation: {
      path: 'src/b.ts',
      diff: '@@ -1 +1 @@\n-before\n+after',
    },
  },
  output: 'message: Updated file',
}

describe('restored blocks with removed tool names', () => {
  test('metadata lookup stays total for removed tool names', () => {
    const metadata = getToolMetadata('apply_patch')
    expect(metadata.deprecated).toBe(true)
    expect(metadata.reachability).toBe('removed')
    expect(metadata.promptVisible).toBe(false)
    expect(metadata.renderer).toBe('fallback')
    // apply_patch was an edit tool, so restored histories keep counting it as a
    // mutation for diff/summary consumers.
    expect(metadata.kind).toBe('mutation')
    expect(metadata.includeInMutationSummary).toBe(true)
  })

  test('unknown persisted tool names resolve without being reported as removed', () => {
    expect(() => getToolMetadata('some_custom_tool')).not.toThrow()
    const metadata = getToolMetadata('some_custom_tool')
    // A live custom/MCP tool name is unrecognized here, not removed: reporting
    // it as removed/deprecated would misstate the public metadata contract.
    expect(metadata.reachability).toBe('unknown')
    expect(metadata.deprecated).toBe(false)
    expect(metadata.renderer).toBe('fallback')
    expect(metadata.includeInMutationSummary).toBe(false)
  })

  test('a registered legacy renderer enhances the fallback metadata floor', () => {
    // Metadata keeps `fallback` as the floor; registration may only enhance it,
    // so the resolved disposition is the dedicated legacy patch renderer.
    expect(getToolRendererDisposition('apply_patch')).toBe('custom')
    expect(getToolRendererDisposition('apply_smart_patch')).toBe('custom')
    // The accessor reports the removed names the registry actually stores, so a
    // consumer narrowing on the returned names cannot be silently wrong.
    expect(getRegisteredToolNames()).toContain('apply_patch')
    expect(getRegisteredToolNames()).toContain('apply_smart_patch')
  })

  test('rendering a restored apply_patch block resolves its recorded path', () => {
    const config = renderToolComponent(restoredLegacyBlock, chatThemes.dark, {
      availableWidth: 80,
      indentationOffset: 0,
      labelWidth: 0,
    })
    expect(config).toBeDefined()
    expect(config?.path).toBe('src/a.ts')
    expect(config?.collapsedPreview).toContain('Legacy patch')
  })

  test('the legacy operation envelope resolves both path and diff', () => {
    expect(getLegacyPatchOperations(restoredOperationEnvelopeBlock)).toEqual([
      { path: 'src/b.ts', diff: '@@ -1 +1 @@\n-before\n+after' },
    ])

    const config = renderToolComponent(
      restoredOperationEnvelopeBlock,
      chatThemes.dark,
      { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
    )
    expect(config?.path).toBe('src/b.ts')
  })

  test('a pending block is never presented as applied', () => {
    const block: PersistedToolBlock = {
      type: 'tool',
      toolName: 'apply_patch',
      toolCallId: 'pending-apply-patch',
      input: { operation: { path: 'src/p.ts', diff: '@@ -1 +1 @@\n-a\n+b' } },
    }

    const config = renderToolComponent(block, chatThemes.dark, {
      availableWidth: 80,
      indentationOffset: 0,
      labelWidth: 0,
    })
    expect(config?.path).toBe('src/p.ts')
    expect(config?.collapsedPreview).toContain('pending')
    expect(config?.collapsedPreview).toContain('not applied')
  })

  test('a queued block reports queued rather than applied', () => {
    const config = renderToolComponent(
      {
        type: 'tool',
        toolName: 'apply_patch',
        toolCallId: 'queued-apply-patch',
        input: { operation: { path: 'src/q.ts', diff: '@@ -1 +1 @@\n-a\n+b' } },
        queued: true,
      } as PersistedToolBlock,
      chatThemes.dark,
      { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
    )
    expect(config?.collapsedPreview).toContain('queued')
    expect(config?.collapsedPreview).toContain('not applied')
  })

  test('a cancelled block reports cancelled and not applied', () => {
    const config = renderToolComponent(
      {
        type: 'tool',
        toolName: 'apply_patch',
        toolCallId: 'cancelled-apply-patch',
        input: { operation: { path: 'src/c.ts', diff: '@@ -1 +1 @@\n-a\n+b' } },
        lifecycle: 'cancelled',
      } as PersistedToolBlock,
      chatThemes.dark,
      { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
    )
    expect(config?.collapsedPreview).toContain('cancelled')
    expect(config?.collapsedPreview).toContain('not applied')
  })

  test.each(['rolled_back', 'rollback_incomplete', 'not_applied'] as const)(
    'a canonical %s result is labeled not applied',
    (outcome) => {
      const config = renderToolComponent(
        {
          type: 'tool',
          toolName: 'apply_patch',
          toolCallId: `${outcome}-apply-patch`,
          input: {},
          outputRaw: [
            {
              type: 'json',
              value: {
                kind: 'file_mutation_result',
                version: 1,
                outcome,
                actions: [
                  {
                    action: 'update',
                    path: 'src/r.ts',
                    outcome,
                    diff: '@@ -1 +1 @@\n-a\n+b',
                  },
                ],
              },
            },
          ],
        } as PersistedToolBlock,
        chatThemes.dark,
        { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
      )
      expect(config?.path).toBe('src/r.ts')
      expect(config?.collapsedPreview).toContain('not applied')
      expect(config?.collapsedPreview).not.toContain('• applied')
    },
  )

  test('a canonical applied result is labeled applied', () => {
    const config = renderToolComponent(
      {
        type: 'tool',
        toolName: 'apply_patch',
        toolCallId: 'applied-apply-patch',
        input: {},
        outputRaw: [
          {
            type: 'json',
            value: {
              kind: 'file_mutation_result',
              version: 1,
              outcome: 'applied',
              actions: [
                {
                  action: 'update',
                  path: 'src/a.ts',
                  outcome: 'applied',
                  diff: '@@ -1 +1 @@\n-a\n+b',
                },
              ],
            },
          },
        ],
      } as PersistedToolBlock,
      chatThemes.dark,
      { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
    )
    expect(config?.path).toBe('src/a.ts')
    expect(config?.collapsedPreview).toContain('applied')
    expect(config?.collapsedPreview).not.toContain('not applied')
  })

  test('a restored block with only a string output stays applied', () => {
    const config = renderToolComponent(restoredLegacyBlock, chatThemes.dark, {
      availableWidth: 80,
      indentationOffset: 0,
      labelWidth: 0,
    })
    expect(config?.collapsedPreview).toContain('applied')
    expect(config?.collapsedPreview).not.toContain('not applied')
  })

  // The removed tools recorded failure prose as an ordinary string output, so
  // a non-empty output must not by itself resolve to `applied`.
  test.each([
    'Smart patch conflict. No changes were written.',
    'Patch was not applied successfully.',
    'No edits were applied.',
    'Nothing was applied.',
    'Failed to apply the patch.',
    'Unable to apply the patch.',
    'Could not apply the patch.',
  ])('failure prose output %p resolves as not applied', (output) => {
    const config = renderToolComponent(
      {
        type: 'tool',
        toolName: 'apply_patch',
        toolCallId: 'failure-prose-apply-patch',
        input: { operation: { path: 'src/f.ts', diff: '@@ -1 +1 @@\n-a\n+b' } },
        output,
      } as PersistedToolBlock,
      chatThemes.dark,
      { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
    )
    expect(config?.path).toBe('src/f.ts')
    expect(config?.collapsedPreview).toContain('not applied')
  })

  test.each(['Patch applied successfully.', 'File written successfully'])(
    'success prose output %p stays applied',
    (output) => {
      const config = renderToolComponent(
        {
          type: 'tool',
          toolName: 'apply_patch',
          toolCallId: 'success-prose-apply-patch',
          input: {
            operation: { path: 'src/s.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
          },
          output,
        } as PersistedToolBlock,
        chatThemes.dark,
        { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
      )
      expect(config?.path).toBe('src/s.ts')
      expect(config?.collapsedPreview).toContain('applied')
      expect(config?.collapsedPreview).not.toContain('not applied')
    },
  )

  test('a recorded diff on the result is used when the input carries none', () => {
    const block: PersistedToolBlock = {
      type: 'tool',
      toolName: 'apply_smart_patch',
      toolCallId: 'restored-smart-patch',
      input: { operation: { path: 'src/c.ts' } },
      outputRaw: [
        {
          type: 'json',
          value: { file: 'src/c.ts', unifiedDiff: '@@ -1 +1 @@\n-a\n+b' },
        },
      ],
    }

    expect(getLegacyPatchOperations(block)).toEqual([
      { path: 'src/c.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
    ])
  })
})
