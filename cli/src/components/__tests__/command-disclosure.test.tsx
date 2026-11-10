import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { useMessageBlockStore } from '../../state/message-block-store'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { createCommandDiagnosticDocument } from '../../utils/captured-diagnostic-document'
import { collectOutputEntries } from '../../utils/output-catalog'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { SingleBlock } from '../blocks/single-block'
import type { ContentBlock, DoctorContentBlock } from '../../types/chat'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => {
  useOutputReaderStore.getState().close()
  useMessageBlockStore.getState().reset()
})

const doctor = (): DoctorContentBlock => ({
  type: 'doctor',
  projectRoot: '/captured/project',
  agentsTrusted: true,
  skillsTrusted: true,
  skillCount: 2,
  mcpCount: 1,
  diagnostics: Array.from({ length: 13 }, (_, i) => ({
    filePath: `source-${i + 1}.ts`,
    message: `Diagnostic ${i + 1}`,
  })),
  providerStatus: 'Provider: local\nModel: local/model',
})

test('doctor reader presents multiline status and preserves raw field access', () => {
  const source = doctor()
  const document = createCommandDiagnosticDocument('doctor', 'Doctor', source)!
  expect(document.kind).toBe('text')
  expect(document.text).toContain(
    'Providers & models\nProvider: local\nModel: local/model',
  )
  expect(document.text).toContain('source-13.ts: Diagnostic 13')
  expect(document.text).not.toContain('providerStatus')
  const raw = document.detail!(document.lineCount - 1)!
  expect(raw.kind).toBe('json')
  expect(raw.text).toContain('providerStatus')
  expect(raw.find('Diagnostic 13', { line: 0, character: 0 }, 1)).not.toBeNull()

  const catalog = collectOutputEntries([
    {
      id: 'doctor-message',
      variant: 'ai',
      timestamp: '2026-11-10T00:00:00Z',
      content: '',
      blocks: [source],
    },
  ])
  expect(catalog[0].read().kind).toBe('text')
  expect(catalog[0].read().text).toContain('Model: local/model')
})

renderTest(
  'command reports reveal retained rows inline with mouse and keyboard',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const cases: Array<{
      block: ContentBlock
      action: string
      hidden: string
    }> = [
      {
        block: doctor(),
        action: 'Show more · 3 diagnostics hidden',
        hidden: 'source-13.ts',
      },
      {
        block: {
          type: 'index-status',
          statusLine: 'Index status: ready.',
          messageLine: '',
          corpusLine: '',
          ageLine: '',
          vectorLine: '',
          hintLine: '',
          lines: [],
          diagnosticsLines: Array.from(
            { length: 8 },
            (_, i) => `Parser diagnostic ${i + 1}`,
          ),
        },
        action: 'Show more · 3 diagnostics hidden',
        hidden: 'Parser diagnostic 8',
      },
      {
        block: {
          type: 'memory',
          state: 'report',
          title: 'Memory query',
          tone: 'secondary',
          lines: Array.from({ length: 11 }, (_, i) => `Observation ${i + 1}`),
        },
        action: 'Show more · 3 report lines hidden',
        hidden: 'Observation 11',
      },
      {
        block: {
          type: 'context',
          ledgerText: Array.from(
            { length: 11 },
            (_, i) => `Budget entry ${i + 1}`,
          ).join('\n'),
          gateBudgetsText: '',
        },
        action: 'Show more · 3 ledger rows hidden',
        hidden: 'Budget entry 11',
      },
      {
        block: {
          type: 'plan',
          content: 'Plan body',
          metadata: {
            sessionPath: '.agents/sessions/demo',
            specPath: '.agents/sessions/demo/SPEC.md',
            planPath: '.agents/sessions/demo/PLAN.md',
            executeCommand: '/mode:execute_plan Execute this plan',
            lessonsCommand: '/lessons .agents/sessions/demo',
          },
        },
        action: 'Show more · 1 command hidden',
        hidden: '/lessons .agents/sessions/demo',
      },
    ]
    for (const [index, fixture] of cases.entries()) {
      const setup = await testRender(
        <SingleBlock
          block={fixture.block}
          idx={index}
          messageId={`command-${index}`}
          isLoading={false}
          isComplete
          isUser={false}
          textColor={chatThemes.dark.foreground}
          availableWidth={80}
          markdownPalette={createMarkdownPalette(chatThemes.dark)}
          onToggleCollapsed={() => {}}
          onBuildFast={() => {}}
          onInsertCommand={() => {}}
        />,
        { width: 80, height: 60 },
      )
      try {
        await React.act(async () => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain(fixture.hidden)
        const rows = setup.captureCharFrame().split('\n')
        const y = rows.findIndex((row) => row.includes(fixture.action))
        expect(y).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(rows[y].indexOf(fixture.action) + 1, y),
        )
        await React.act(async () => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain(fixture.hidden)
        expect(setup.captureCharFrame()).toContain('Show less')
        await React.act(async () => setup.mockInput.pressKey(' '))
        await React.act(async () => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain(fixture.hidden)
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)
