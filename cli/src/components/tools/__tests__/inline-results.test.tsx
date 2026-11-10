import { afterEach, expect, test } from 'bun:test'
import React, { useState } from 'react'
import type { Renderable } from '@opentui/core'

import { initializeThemeStore, useTheme } from '../../../hooks/use-theme'
import { useMessageBlockStore } from '../../../state/message-block-store'
import { InlineResults, InlineResultScope } from '../inline-results'
import { CollapsibleGroup } from '../discovery-results'
import { ListJobsComponent } from '../list-jobs'
import { SetOutputComponent } from '../set-output'
import { CodeSearchComponent } from '../code-search'
import { QueryIndexComponent } from '../query-index'

import type { ToolBlock } from '../types'

initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => useMessageBlockStore.getState().reset())

async function mount(node: React.ReactNode, height = 80) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width: 100, height })
  })
  await setup.renderOnce()
  return setup
}

async function click(setup: Awaited<ReturnType<typeof mount>>, text: string) {
  await setup.renderOnce()
  const rows = setup.captureCharFrame().split('\n')
  const row = rows.findIndex((line) => line.includes(text))
  expect(row, setup.captureCharFrame()).toBeGreaterThanOrEqual(0)
  await React.act(async () =>
    setup.mockMouse.click(rows[row].indexOf(text) + 1, row),
  )
  await setup.renderOnce()
}

function firstFocusable(node: Renderable): Renderable | undefined {
  if (node.focusable) return node
  for (const child of node.getChildren()) {
    const found = firstFocusable(child as Renderable)
    if (found) return found
  }
  return undefined
}

for (const keyboardOnly of [false, true]) {
  nativeTest(
    `page boundaries retain usable focus after ${keyboardOnly ? 'keyboard' : 'mouse'} activation`,
    async () => {
      const list = (
        <InlineResults
          items={Array.from(
            { length: 51 },
            (_, index) => `ROW_${index + 1}_END`,
          )}
          renderItem={(item) => <text>{item}</text>}
        />
      )
      const setup = await mount(
        keyboardOnly ? (
          <InlineResultScope messageId="boundary-message" scope="tool:boundary">
            {list}
          </InlineResultScope>
        ) : (
          list
        ),
      )
      async function activateFirst(label: string) {
        if (keyboardOnly) {
          await React.act(async () =>
            firstFocusable(setup.renderer.root)!.focus(),
          )
          await React.act(async () => setup.mockInput.pressEnter())
          await setup.renderOnce()
        } else {
          await click(setup, label)
        }
      }
      async function collapseWithRetainedFocus() {
        expect(setup.renderer.currentFocusedRenderable).not.toBeNull()
        await React.act(async () => setup.mockInput.pressEnter())
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('Show more')
        expect(setup.captureCharFrame()).not.toContain('ROW_51_END')
      }
      try {
        await activateFirst('Show more')
        await activateFirst('Next results')
        expect(setup.captureCharFrame()).toContain('ROW_51_END')
        expect(setup.captureCharFrame()).not.toContain('Next results')
        await collapseWithRetainedFocus()

        await activateFirst('Show more')
        await activateFirst('Next results')
        await activateFirst('Previous results')
        expect(setup.captureCharFrame()).toContain('ROW_1_END')
        expect(setup.captureCharFrame()).not.toContain('Previous results')
        await collapseWithRetainedFocus()
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    },
  )
}

nativeTest(
  'grouped results expose hidden rows inline and keyboard collapse retains the group',
  async () => {
    const setup = await mount(
      <CollapsibleGroup
        label="src"
        count={8}
        entries={Array.from({ length: 8 }, (_, index) => (
          <text key={index}>file-{index + 1}.ts</text>
        ))}
      />,
    )
    try {
      expect(setup.captureCharFrame()).not.toContain('file-8.ts')
      expect(setup.captureCharFrame()).toContain('5 results hidden')
      await click(setup, 'Show more')
      expect(setup.captureCharFrame()).toContain('file-8.ts')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain('file-8.ts')
      expect(setup.captureCharFrame()).toContain('src (8)')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'search pagination reaches matches beyond the old display cap without hiding source limits',
  async () => {
    const block: ToolBlock & { toolName: 'code_search' } = {
      type: 'tool',
      toolCallId: 'large-search',
      toolName: 'code_search',
      lifecycle: 'succeeded',
      input: { pattern: 'MATCH' },
      outputRaw: [
        {
          type: 'json',
          value: {
            stdout:
              Array.from(
                { length: 301 },
                (_, index) => `src/file.ts:${index + 1}:MATCH_${index + 1}_END`,
              ).join('\n') + '\n[Global limit of 301 results reached.]',
          },
        },
      ],
    }
    function Host() {
      const theme = useTheme()
      return (
        <InlineResultScope messageId="search-message" scope="tool:search">
          {
            CodeSearchComponent.render(block, theme, {
              availableWidth: 100,
              indentationOffset: 0,
              labelWidth: 0,
            }).content
          }
        </InlineResultScope>
      )
    }
    const setup = await mount(<Host />)
    try {
      expect(setup.captureCharFrame()).not.toContain('MATCH_301_END')
      await click(setup, 'Show more')
      for (let page = 0; page < 6; page++) await click(setup, 'Next results')
      expect(setup.captureCharFrame()).toContain('MATCH_301_END')
      expect(setup.captureCharFrame()).toContain('Global limit of 301')
      expect(setup.captureCharFrame()).toContain('partial search')
      expect(setup.captureCharFrame()).not.toContain('Next results')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'index snippets, related files and diagnostics each reveal retained rows inline',
  async () => {
    const block: ToolBlock & { toolName: 'query_index' } = {
      type: 'tool',
      toolCallId: 'index',
      toolName: 'query_index',
      lifecycle: 'succeeded',
      input: { query: 'index' },
      outputRaw: [
        {
          type: 'json',
          value: {
            results: [
              {
                path: 'a.ts',
                matchedSnippets: ['FIRST_SNIPPET', 'SECOND_SNIPPET'],
                relatedFiles: [{ path: 'first.ts' }, { path: 'second.ts' }],
              },
            ],
            status: {
              state: 'ready',
              diagnostics: Array.from({ length: 7 }, (_, index) => ({
                filePath: `diag-${index + 1}.ts`,
                message: `DIAGNOSTIC_${index + 1}_END`,
              })),
            },
          },
        },
      ],
    }
    function Host() {
      const theme = useTheme()
      return (
        <InlineResultScope messageId="index-message" scope="tool:index">
          {
            QueryIndexComponent.render(block, theme, {
              availableWidth: 100,
              indentationOffset: 0,
              labelWidth: 0,
            }).content
          }
        </InlineResultScope>
      )
    }
    const setup = await mount(<Host />)
    try {
      expect(setup.captureCharFrame()).not.toContain('SECOND_SNIPPET')
      expect(setup.captureCharFrame()).not.toContain('second.ts')
      expect(setup.captureCharFrame()).not.toContain('DIAGNOSTIC_7_END')
      await click(setup, 'Show more · 1 snippet')
      expect(setup.captureCharFrame()).toContain('SECOND_SNIPPET')
      await click(setup, 'Show more · 1 related file')
      expect(setup.captureCharFrame()).toContain('second.ts')
      await click(setup, 'Show more · 2 diagnostics')
      expect(setup.captureCharFrame()).toContain('DIAGNOSTIC_7_END')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'paged results retain page and expansion through viewport remounts and prune with the message',
  async () => {
    const items = Array.from(
      { length: 120 },
      (_, index) => `ROW_${index + 1}_END`,
    )
    let setVisible!: (value: boolean) => void
    let setIdentity!: (value: string) => void
    function Host() {
      const [visible, updateVisible] = useState(true)
      const [identity, updateIdentity] = useState('message-1')
      setVisible = updateVisible
      setIdentity = updateIdentity
      return visible ? (
        <InlineResultScope messageId={identity} scope="tool:captured">
          <InlineResults
            items={items}
            previewCount={3}
            renderItem={(item) => <text>{item}</text>}
          />
        </InlineResultScope>
      ) : (
        <text>Outside viewport</text>
      )
    }
    const setup = await mount(<Host />)
    try {
      await click(setup, 'Show more')
      expect(setup.captureCharFrame()).toContain('Showing 1–50 of 120 captured')
      expect(setup.captureCharFrame()).not.toContain('ROW_51_END')
      await click(setup, 'Next results')
      expect(setup.captureCharFrame()).toContain('ROW_51_END')
      expect(setup.captureCharFrame()).not.toContain('ROW_1_END')
      await React.act(async () => setVisible(false))
      await setup.renderOnce()
      await React.act(async () => setVisible(true))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Showing 51–100 of 120 captured',
      )
      await click(setup, 'Next results')
      expect(setup.captureCharFrame()).toContain('ROW_120_END')
      expect(setup.captureCharFrame()).not.toContain('Next results')
      await click(setup, 'Previous results')
      expect(setup.captureCharFrame()).toContain('ROW_51_END')
      await React.act(async () => setIdentity('message-2'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain('ROW_51_END')
      expect(setup.captureCharFrame()).toContain('Show more')
      const state = useMessageBlockStore.getState()
      state.pruneViews(['message-2'])
      expect(
        useMessageBlockStore.getState().listViews['message-1'],
      ).toBeUndefined()
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'jobs expand every captured row while producer omissions remain explicit',
  async () => {
    const block: ToolBlock & { toolName: 'list_jobs' } = {
      type: 'tool',
      toolCallId: 'jobs',
      toolName: 'list_jobs',
      input: {},
      outputRaw: [
        {
          type: 'json',
          value: {
            jobs: Array.from({ length: 16 }, (_, index) => ({
              jobId: `JOB_${index + 1}_END`,
              status: 'running',
            })),
            truncatedCount: 4,
          },
        },
      ],
    }
    function Host() {
      const theme = useTheme()
      return (
        <>
          {
            ListJobsComponent.render(block, theme, {
              availableWidth: 100,
              indentationOffset: 0,
              labelWidth: 0,
            }).content
          }
        </>
      )
    }
    const setup = await mount(<Host />)
    try {
      expect(setup.captureCharFrame()).toContain('10 jobs hidden')
      expect(setup.captureCharFrame()).not.toContain('JOB_16_END')
      await click(setup, 'Show more')
      expect(setup.captureCharFrame()).toContain('JOB_16_END')
      expect(setup.captureCharFrame()).toContain('4 producer entries omitted')
      expect(setup.captureCharFrame()).not.toContain('JOB_17_END')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'review findings and advisories expand independently within the captured result',
  async () => {
    const block: ToolBlock & { toolName: 'set_output' } = {
      type: 'tool',
      toolCallId: 'review',
      toolName: 'set_output',
      input: {
        data: {
          verdict: 'BLOCKED',
          findings: Array.from(
            { length: 15 },
            (_, index) => `FINDING_${index + 1}_END`,
          ),
          advisories: Array.from(
            { length: 14 },
            (_, index) => `ADVISORY_${index + 1}_END`,
          ),
        },
      },
      outputRaw: [{ type: 'json', value: { message: 'Saved review' } }],
    }
    function Host() {
      const theme = useTheme()
      return (
        <InlineResultScope messageId="review-message" scope="tool:review">
          {
            SetOutputComponent.render(block, theme, {
              availableWidth: 100,
              indentationOffset: 0,
              labelWidth: 0,
            }).content
          }
        </InlineResultScope>
      )
    }
    const setup = await mount(<Host />)
    try {
      expect(setup.captureCharFrame()).not.toContain('FINDING_15_END')
      expect(setup.captureCharFrame()).not.toContain('ADVISORY_14_END')
      await click(setup, 'Show more · 3 findings')
      expect(setup.captureCharFrame()).toContain('FINDING_15_END')
      expect(setup.captureCharFrame()).not.toContain('ADVISORY_14_END')
      await click(setup, 'Show more · 2 advisories')
      expect(setup.captureCharFrame()).toContain('ADVISORY_14_END')
      expect(setup.captureCharFrame()).toContain('FINDING_15_END')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
