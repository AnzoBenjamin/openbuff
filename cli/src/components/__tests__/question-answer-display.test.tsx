import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { MultipleChoiceForm } from '../ask-user'
import { AskUserBranch } from '../blocks/ask-user-branch'
import { answerDisplayLines } from '../ask-user/utils/structured-answer'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import type { AskUserContentBlock } from '../../types/chat'
import type { testRender } from '@opentui/react/test-utils'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
type Setup = Awaited<ReturnType<typeof testRender>>
afterEach(() => useOutputReaderStore.getState().close())
async function mount(node: React.ReactNode, width = 120, height = 40) {
  const { testRender } = await import('@opentui/react/test-utils')
  return testRender(node, { width, height })
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

test('mixed answer display retains every comma/newline/literal-Skipped value separately', () => {
  expect(
    answerDisplayLines({
      selectedOptions: ['A, B', 'Skipped'],
      otherText: 'C,\nD',
    }),
  ).toEqual(['Selected: A, B', 'Selected: Skipped', 'Custom: C,\nD'])
})

renderTest(
  'mixed current choices and Custom stay visible in preview and exactly inspectable',
  async () => {
    const setup = await mount(
      <MultipleChoiceForm
        questions={[
          {
            question: 'CHOOSE_VALUES',
            options: ['A, B', 'Skipped'],
            multiSelect: true,
          },
        ]}
        onSubmit={() => {}}
        onSkip={() => {}}
      />,
    )
    try {
      await click(setup, 'A, B')
      await click(setup, 'Skipped')
      await click(setup, 'Custom')
      await React.act(async () => setup.mockInput.typeText('C, D'))
      await click(setup, 'CHOOSE_VALUES')
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('3 choices')
      expect(frame).toContain('Selected: A, B')
      expect(frame).toContain('Selected: Skipped')
      expect(frame).toContain('Custom: C, D')
      await click(setup, 'Inspect (I)')
      const document = useOutputReaderStore.getState().request!.document!
      const selection = document.find(
        '["answer"]["selectedOptions"]',
        { line: 0, character: 0 },
        1,
      )!
      const first = document.find('A, B', selection, 1)!
      expect(document.copyLine(first.line)).toBe('A, B')
      const custom = document.find('["otherText"]', first, 1)!
      expect(document.copyLine(custom.line)).toBe('C, D')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'mixed submitted choices remain separate in transcript and full captured inspection',
  async () => {
    const block: AskUserContentBlock = {
      type: 'ask-user',
      toolCallId: 'mixed',
      questions: [
        {
          question: 'CHOOSE_VALUES',
          options: [{ label: 'A, B' }, { label: 'Skipped' }],
          multiSelect: true,
        },
      ],
      answers: [
        {
          questionIndex: 0,
          selectedOptions: ['A, B', 'Skipped'],
          otherText: 'C,\nD',
        },
      ],
    }
    const setup = await mount(
      <AskUserBranch block={block} availableWidth={120} />,
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Selected: A, B')
      expect(frame).toContain('Selected: Skipped')
      expect(frame).toContain('Custom: C, D')
      await click(setup, 'Inspect all answers')
      const document = useOutputReaderStore.getState().request!.document!
      const custom = document.find(
        '["otherText"]',
        { line: 0, character: 0 },
        1,
      )!
      expect(document.copyLine(custom.line)).toBe('C,\nD')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'large captured answer sets keep compact preview bounded and every answer retained',
  async () => {
    const block: AskUserContentBlock = {
      type: 'ask-user',
      toolCallId: 'many',
      questions: Array.from({ length: 10 }, (_, index) => ({
        question: `Question ${index + 1}`,
        options: [{ label: 'A' }, { label: 'B' }],
      })),
      answers: Array.from({ length: 10 }, (_, questionIndex) => ({
        questionIndex,
        selectedOptions: Array.from(
          { length: 20 },
          (_, index) => `Choice ${index + 1}`,
        ),
        otherText: `Custom answer ${questionIndex + 1}`,
      })),
    }
    const setup = await mount(
      <AskUserBranch block={block} availableWidth={60} />,
      60,
      18,
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Showing 3 of 21 captured answer values',
      )
      expect(setup.captureCharFrame()).toContain(
        'Showing 1 of 10 captured questions',
      )
      await click(setup, 'Inspect all answers')
      const document = useOutputReaderStore.getState().request!.document!
      expect(
        document.find('Custom answer 10', { line: 0, character: 0 }, 1),
      ).not.toBeNull()
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
