import { expect, test } from 'bun:test'
import React from 'react'
import { MultipleChoiceForm } from '../ask-user'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import type { StructuredFormAnswer } from '../ask-user/utils/structured-answer'
import type { testRender } from '@opentui/react/test-utils'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
type Setup = Awaited<ReturnType<typeof testRender>>

async function mount(node: React.ReactNode) {
  useChatStore.getState().reset()
  const { testRender } = await import('@opentui/react/test-utils')
  return testRender(node, { width: 80, height: 24, exitOnCtrlC: false })
}
async function custom(setup: Setup, text: string) {
  await React.act(async () => setup.mockInput.pressArrow('down'))
  await React.act(async () => setup.mockInput.pressEnter())
  await React.act(async () => setup.mockInput.typeText(text))
  await React.act(async () => setup.mockInput.pressTab())
}
async function click(setup: Setup, label: string) {
  await setup.renderOnce()
  const rows = setup.captureCharFrame().split('\n')
  const y = rows.findIndex((row) => row.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  await React.act(async () =>
    setup.mockMouse.click(rows[y].indexOf(label) + 1, y),
  )
}
async function waitUntil(ready: () => boolean) {
  const deadline = performance.now() + 2000
  while (!ready()) {
    if (performance.now() >= deadline)
      throw new Error('Question submission did not settle')
    await React.act(async () => Bun.sleep(10))
  }
}

renderTest(
  'worker-backed validation accepts exactly one same-batch Submit',
  async () => {
    const submitted: StructuredFormAnswer[][] = []
    const setup = await mount(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Choose',
            options: ['Preset'],
            validation: { pattern: '^alpha$' },
          },
        ]}
        onSubmit={(answers) => submitted.push(answers)}
        onSkip={() => {}}
      />,
    )
    try {
      await custom(setup, 'alpha')
      await React.act(async () => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      await waitUntil(() => submitted.length > 0)
      expect(submitted).toEqual([[{ questionIndex: 0, otherText: 'alpha' }]])
      await React.act(async () => setup.mockInput.pressEnter())
      expect(submitted).toHaveLength(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'Stop stays responsive during a hung pattern and cancellation preserves the custom answer',
  async () => {
    let stopped = 0,
      submitted = 0
    const setup = await mount(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Choose',
            options: ['Preset'],
            validation: { pattern: '(a|aa)+$' },
          },
        ]}
        onSubmit={() => submitted++}
        onSkip={() => {}}
        onStop={() => stopped++}
      />,
    )
    try {
      await custom(setup, 'a'.repeat(200) + '!')
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => setup.mockInput.pressKey('c', { ctrl: true }))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Stop current run and discard 1 draft answer',
      )
      expect(stopped).toBe(0)
      await React.act(async () => setup.mockInput.pressKey('n'))
      await React.act(async () => Bun.sleep(300))
      await setup.renderOnce()
      expect(submitted).toBe(0)
      expect(setup.captureCharFrame()).not.toContain('timed out')
      expect(setup.captureCharFrame()).toContain('aaaaaaaa')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'changing an answer revokes pending validation before a newer submission',
  async () => {
    const submitted: StructuredFormAnswer[][] = []
    const setup = await mount(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Choose',
            options: ['Preset'],
            validation: { pattern: '(a|aa)+$' },
          },
        ]}
        onSubmit={(answers) => submitted.push(answers)}
        onSkip={() => {}}
      />,
    )
    try {
      await custom(setup, 'a'.repeat(200) + '!')
      await React.act(async () => setup.mockInput.pressEnter())
      await click(setup, 'Preset')
      await click(setup, 'Submit')
      await React.act(async () => Bun.sleep(300))
      expect(submitted).toEqual([
        [{ questionIndex: 0, selectedOption: 'Preset' }],
      ])
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain('timed out')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'a replaced question request cannot receive validation from an unmounted form',
  async () => {
    const submitted: string[] = []
    let replace!: () => void
    function Host() {
      const [request, setRequest] = React.useState(1)
      replace = () => setRequest(2)
      return (
        <MultipleChoiceForm
          key={request}
          questions={[
            {
              question: `Request ${request}`,
              options: ['Preset'],
              validation: { pattern: '(a|aa)+$' },
            },
          ]}
          onSubmit={() => submitted.push(String(request))}
          onSkip={() => {}}
        />
      )
    }
    const setup = await mount(<Host />)
    try {
      await custom(setup, 'a'.repeat(200) + '!')
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => replace())
      await React.act(async () => Bun.sleep(300))
      await setup.renderOnce()
      expect(submitted).toEqual([])
      expect(setup.captureCharFrame()).toContain('Request 2')
      expect(setup.captureCharFrame()).not.toContain('aaaaaaaa')
      expect(setup.captureCharFrame()).not.toContain('timed out')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
