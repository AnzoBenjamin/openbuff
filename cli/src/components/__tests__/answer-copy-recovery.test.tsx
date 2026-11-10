import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import type { Renderable } from '@opentui/core'
import { CopyButton } from '../copy-button'
import { MessageFooter, getAnswerCopyText } from '../message-footer'
import { initializeThemeStore } from '../../hooks/use-theme'
import type { ContentBlock } from '../../types/chat'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
async function mount(node: React.ReactNode) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, {
      width: 80,
      height: 24,
      exitOnCtrlC: false,
    })
  })
  await React.act(async () => setup.flush())
  return setup
}
function firstFocusable(node: Renderable): Renderable | undefined {
  if (node.focusable) return node
  for (const child of node.getChildren()) {
    const found = firstFocusable(child as Renderable)
    if (found) return found
  }
  return undefined
}

test('answer copy uses canonical text blocks once, excludes reasoning and preserves exact whitespace', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', textType: 'reasoning', content: 'private reasoning' },
    { type: 'text', content: '  answer first\n' },
    { type: 'text', content: '\nanswer second  ' },
  ]
  expect(getAnswerCopyText('duplicated legacy answer', blocks)).toBe(
    '  answer first\n\n\n\nanswer second  ',
  )
  expect(getAnswerCopyText('  legacy\n\n  ', [])).toBe('  legacy\n\n  ')
  expect(getAnswerCopyText('private reasoning', [blocks[0]])).toBe('')
})

renderTest(
  'copy failure stays visible and keyboard retry confirms only the captured scope',
  async () => {
    let attempts = 0,
      copied = ''
    const setup = await mount(
      <CopyButton
        textToCopy={'  exact answer\n'}
        label="Copy answer"
        copy={async (text) => {
          attempts++
          if (attempts === 1) throw new Error('Clipboard unavailable')
          copied = text
        }}
      />,
    )
    try {
      await React.act(async () => firstFocusable(setup.renderer.root)!.focus())
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Copy failed')
      expect(setup.captureCharFrame()).not.toContain('Copied answer')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(copied).toBe('  exact answer\n')
      expect(setup.captureCharFrame()).toContain('Copied answer')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'dragging selectable prose does not copy the whole source; a completed button click does',
  async () => {
    let calls = 0
    const setup = await mount(
      <CopyButton
        textToCopy="Complete source for explicit copy"
        copy={async () => {
          calls++
        }}
        leadingSpace={false}
      >
        <span>Selectable prose remains readable</span>
      </CopyButton>,
    )
    try {
      await React.act(async () => setup.mockMouse.drag(1, 0, 7, 0))
      await setup.renderOnce()
      expect(calls).toBe(0)
      expect(setup.renderer.getSelection()?.getSelectedText()).toContain(
        'elect',
      )
      const control = firstFocusable(setup.renderer.root)!
      await React.act(async () =>
        setup.mockMouse.pressDown(control.x, control.y),
      )
      expect(calls).toBe(0)
      await React.act(async () => setup.mockMouse.release(control.x, control.y))
      expect(calls).toBe(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  '500 footer revisions never materialize 100KB copy data before activation and cache identical copy source',
  async () => {
    let setRevision!: (value: number) => void
    let reads = 0,
      copied = ''
    const bytes = '  Captured answer\n'.repeat(6400)
    const block = {
      type: 'text' as const,
      textType: 'text' as const,
      get content() {
        reads++
        return bytes
      },
    }
    const blocks: ContentBlock[] = [block]
    function Host() {
      const [revision, update] = useState(0)
      setRevision = update
      return (
        <MessageFooter
          messageId="fixture"
          content={bytes}
          blocks={blocks}
          isLoading={revision < 500}
          isComplete={revision >= 500}
          timerStartTime={null}
          copy={async (text) => {
            copied = text
          }}
        />
      )
    }
    const setup = await mount(<Host />)
    try {
      const started = performance.now()
      for (let revision = 1; revision <= 500; revision++)
        await React.act(async () => setRevision(revision))
      await setup.renderOnce()
      expect(reads).toBe(0)
      await React.act(async () => firstFocusable(setup.renderer.root)!.focus())
      await React.act(async () => setup.mockInput.pressEnter())
      expect(reads).toBe(1)
      expect(copied).toBe(bytes)
      await React.act(async () => setup.mockInput.pressEnter())
      expect(reads).toBe(1)
      console.log(
        JSON.stringify({
          fixture: 'footer-500-revisions',
          bytes: bytes.length,
          elapsedMs: performance.now() - started,
          materializationsBeforeActivation: 0,
          materializationsAfterTwoActivations: reads,
          scope:
            'Native footer-only fixture; elapsed time includes React updates and copy activation.',
        }),
      )
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'whitespace-only and retained partial text remain explicitly copyable',
  async () => {
    let copied = ''
    const setup = await mount(
      <MessageFooter
        messageId="partial"
        content={' \n\t '}
        isLoading={false}
        isComplete={false}
        timerStartTime={null}
        copy={async (text) => {
          copied = text
        }}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('Copy partial answer')
      await React.act(async () => firstFocusable(setup.renderer.root)!.focus())
      await React.act(async () => setup.mockInput.pressEnter())
      expect(copied).toBe(' \n\t ')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
