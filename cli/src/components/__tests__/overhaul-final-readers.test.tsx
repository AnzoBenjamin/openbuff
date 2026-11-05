import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { OutputReaderScreen } from '../output-reader-screen'
import { ChatGptConnectBanner } from '../chatgpt-connect-banner'
import { HelpBanner } from '../help-banner'
import { PlanBox } from '../renderers/plan-box'
import {
  createTableDocument,
  createTextDocument,
} from '../../utils/output-document'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => useOutputReaderStore.getState().close())
async function mount(node: React.ReactNode, width = 60, height = 18) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width, height, exitOnCtrlC: false })
  })
  await setup.renderOnce()
  return setup
}
async function clickLabel(
  setup: Awaited<ReturnType<typeof mount>>,
  label: string,
) {
  await setup.renderOnce()
  const rows = setup.captureCharFrame().split('\n')
  const y = rows.findIndex((row) => row.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  await React.act(async () =>
    setup.mockMouse.click(rows[y].indexOf(label) + 1, y),
  )
}

renderTest(
  'reader reaches a retained row beyond its projection cap by keyboard and returns to parent',
  async () => {
    const document = createTableDocument({
      id: 'capped-rows',
      title: 'Captured rows',
      rows: Array.from({ length: 100_002 }, (_, index) => ({
        value: index === 100_001 ? 'Beyond projection sentinel' : index,
      })),
      columns: [{ key: 'value', label: 'Value' }],
      label: (_value, index) => `Row ${index + 1}`,
    })
    expect(document.lineCount).toBeLessThan(document.rowCount!)
    const setup = await mount(
      <OutputReaderScreen
        messages={[]}
        initialDocument={document}
        onClose={() => {}}
      />,
    )
    try {
      await React.act(async () => setup.mockInput.pressKey('g'))
      await React.act(async () => {
        await setup.mockInput.pasteBracketedText('row 100002')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Beyond projection sentinel')
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(100)
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Captured rows')
      expect(setup.captureCharFrame()).toContain('Limited')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'narrow reader keeps availability visible and exposes the complete source notice',
  async () => {
    const document = createTextDocument({
      id: 'partial',
      title: 'Search results',
      text: 'Retained evidence',
      availability: 'limited',
      notice: 'Long notice '.repeat(30) + 'Only 50 matches were captured',
      provenance: {
        source: 'capture',
        freshness: 'stale',
        exact: false,
        identity: '/project/retained-file',
      },
    })
    const setup = await mount(
      <OutputReaderScreen
        messages={[]}
        initialDocument={document}
        onClose={() => {}}
      />,
      40,
      15,
    )
    try {
      expect(setup.captureCharFrame()).toContain('Limited · Stale source')
      await React.act(async () => setup.mockInput.pressKey('d'))
      await setup.renderOnce()
      await React.act(async () => setup.mockInput.pressKey('/'))
      await React.act(async () => {
        await setup.mockInput.typeText('Only 50')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Only 50 matches were captured',
      )
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'OAuth callback exchange has one owner for batched Enter and rejects a stale flow completion',
  async () => {
    let exchanges = 0
    let resolve!: (value: never) => void
    const setup = await mount(
      <ChatGptConnectBanner
        dependencies={{
          connect: () => ({
            authUrl: 'https://fixture.test',
            browserOpened: Promise.resolve(false),
            credentials: new Promise<never>(() => {}),
          }),
          exchange: async () => {
            exchanges++
            return new Promise((done) => {
              resolve = done
            })
          },
          status: () => ({ connected: false }) as never,
          stop: () => {},
          open: async () => false,
          hasCodexProvider: () => true,
        }}
      />,
      80,
      24,
    )
    try {
      await React.act(async () => {
        await setup.mockInput.typeText('captured-code')
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(exchanges).toBe(1)
      await React.act(async () => {
        resolve({} as never)
        await Bun.sleep(30)
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('ChatGPT connected')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'help stays bounded while its local reader retains every keyboard route',
  async () => {
    const setup = await mount(<HelpBanner />, 60, 18)
    try {
      expect(setup.captureCharFrame()).toContain('Inspect keyboard help')
      await clickLabel(setup, 'Inspect keyboard help')
      const document = useOutputReaderStore.getState().request?.document
      expect(document?.text).toContain('G: line number, or row <number>')
      expect(document?.text).toContain('Ctrl+T: collapse or expand agents')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'plan metadata preview is bounded and inspection keeps complete paths and commands',
  async () => {
    const metadata = {
      customArtifacts: Array.from({ length: 20 }, (_, index) => ({
        label: `Artifact ${index + 1}`,
        path: `/captured/${'deep/'.repeat(40)}file-${index + 1}.md`,
      })),
      customArtifactCommands: Array.from(
        { length: 20 },
        (_, index) =>
          `/open-captured-${index + 1} ${'long target '.repeat(20)}`,
      ),
    }
    const inserted: string[] = []
    const setup = await mount(
      <PlanBox
        planContent="Ready to review"
        metadata={metadata}
        availableWidth={60}
        markdownPalette={createMarkdownPalette(chatThemes.dark)}
        onBuildFast={() => {}}
        onInsertCommand={(command) => inserted.push(command)}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('2 of 20 artifacts')
      await clickLabel(setup, 'Inspect plan artifacts and commands')
      const document = useOutputReaderStore.getState().request?.document
      expect(
        document?.find('file-20.md', { line: 0, character: 0 }, 1),
      ).not.toBeNull()
      expect(
        document?.find('/open-captured-20', { line: 0, character: 0 }, 1),
      ).not.toBeNull()
      await clickLabel(setup, '/open-captured-1')
      expect(inserted).toEqual([metadata.customArtifactCommands[0]])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
