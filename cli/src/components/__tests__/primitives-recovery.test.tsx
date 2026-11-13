import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import { TextAttributes, type BoxRenderable } from '@opentui/core'
import { Button } from '../button'
import { TerminalLink } from '../terminal-link'
import { ErrorBoundary } from '../error-boundary'
import { isolateBlock } from '../blocks/blocks-renderer'
import { OutputReaderScreen } from '../output-reader-screen'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { initializeThemeStore } from '../../hooks/use-theme'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'button preserves callback-ref cleanup when the native control unmounts',
  async () => {
    let calls = 0,
      cleanups = 0
    const setup = await mount(
      <Button
        ref={(node) => {
          if (node) {
            calls++
            return () => {
              cleanups++
            }
          }
          return undefined
        }}
        onClick={() => {}}
      >
        <text>Control</text>
      </Button>,
    )
    await React.act(async () => setup.renderer.destroy())
    expect(calls).toBe(1)
    expect(cleanups).toBe(1)
  },
)
async function mount(node: React.ReactNode) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, {
      width: 60,
      height: 18,
      exitOnCtrlC: false,
    })
  })
  await React.act(async () => setup.flush())
  return setup
}

renderTest(
  'native focus events underline one button without changing its width and activate once',
  async () => {
    const refs: Array<BoxRenderable | null> = [null, null]
    let activated = 0,
      focused = 0,
      blurred = 0
    const setup = await mount(
      <box>
        <Button
          ref={(node) => {
            refs[0] = node
          }}
          onFocused={() => focused++}
          onBlurred={() => blurred++}
          onClick={() => {
            activated++
          }}
        >
          <text>First</text>
        </Button>
        <Button
          ref={(node) => {
            refs[1] = node
          }}
          onClick={() => {
            activated++
          }}
        >
          <text>Second</text>
        </Button>
      </box>,
    )
    try {
      const width = refs[0]!.width
      await React.act(async () => refs[0]!.focus())
      await setup.renderOnce()
      expect(refs[0]!.width).toBe(width)
      const firstText = refs[0]!.getChildren()[0] as unknown as {
        attributes: number
      }
      expect(firstText.attributes & TextAttributes.UNDERLINE).toBeTruthy()
      await React.act(async () => setup.mockInput.pressEnter())
      expect(activated).toBe(1)
      await React.act(async () => refs[1]!.focus())
      await setup.renderOnce()
      expect(firstText.attributes & TextAttributes.UNDERLINE).toBe(0)
      expect(focused).toBe(1)
      expect(blurred).toBe(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'failed link exposes its destination, bounds repeated activation and retries visibly',
  async () => {
    let calls = 0
    let settle: (value: boolean) => void = () => {}
    const setup = await mount(
      <TerminalLink
        text="https://fixture.example/full-destination"
        onActivate={() => {
          calls++
          return calls === 1
            ? new Promise<boolean>((resolve) => {
                settle = resolve
              })
            : Promise.resolve(true)
        }}
      />,
    )
    const click = async () => React.act(async () => setup.mockMouse.click(2, 0))
    try {
      await click()
      await click()
      expect(calls).toBe(1)
      await React.act(async () => settle(false))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Could not open https://fixture.example/full-destination',
      )
      expect(setup.captureCharFrame()).toContain('manually')
      await click()
      await setup.renderOnce()
      expect(calls).toBe(2)
      expect(setup.captureCharFrame()).toContain('Opened in browser')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'a failed block keeps siblings available, opens retained text and retries without mutating source',
  async () => {
    const source = {
      type: 'text' as const,
      content: 'Exact retained output after a rendering failure',
    }
    let fail = true
    const Throw = () => {
      if (fail) throw new Error('fixture render failed')
      return <text>Recovered view</text>
    }
    function Host() {
      const request = useOutputReaderStore((state) => state.request)
      if (request?.document)
        return (
          <OutputReaderScreen
            messages={[]}
            initialDocument={request.document}
            onClose={() => useOutputReaderStore.getState().close()}
          />
        )
      return (
        <box style={{ flexDirection: 'column' }}>
          {isolateBlock('fixture', 'text', <Throw />, source)}
          <text>Healthy sibling and composer draft</text>
        </box>
      )
    }
    useOutputReaderStore.setState({ request: null, views: {} })
    const setup = await mount(<Host />)
    const clickText = async (text: string) => {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf(text) + 1, row),
      )
      await setup.renderOnce()
    }
    try {
      expect(setup.captureCharFrame()).toContain(
        'Healthy sibling and composer draft',
      )
      await clickText('Inspect retained source')
      expect(setup.captureCharFrame()).toContain(source.content)
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(120)
      })
      await setup.renderOnce()
      fail = false
      await clickText('Retry view')
      expect(setup.captureCharFrame()).toContain('Recovered view')
      expect(source.content).toBe(
        'Exact retained output after a rendering failure',
      )
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useOutputReaderStore.getState().close()
    }
  },
)

renderTest(
  'render retries stop at the configured limit instead of looping',
  async () => {
    let renders = 0
    const Throw = () => {
      renders++
      throw new Error('persistent fixture failure')
    }
    const setup = await mount(
      <ErrorBoundary
        componentName="Fixture"
        fallback={<text>Failed card</text>}
        allowRetry
        maxRetries={1}
      >
        <Throw />
      </ErrorBoundary>,
    )
    try {
      const before = renders
      await React.act(async () => setup.mockMouse.click(2, 2))
      await setup.renderOnce()
      expect(renders).toBeGreaterThan(before)
      const after = renders
      await setup.renderOnce()
      expect(renders).toBe(after)
      expect(setup.captureCharFrame()).toContain('Retry limit reached')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
