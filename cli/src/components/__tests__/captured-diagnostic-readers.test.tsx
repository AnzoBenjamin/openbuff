import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { capturedDiagnosticDocument } from '../../utils/captured-diagnostic-document'
import { MemoryBox } from '../renderers/memory-box'
import { IndexStatusBox } from '../renderers/index-status-box'
import { ContextBox } from '../renderers/context-box'
import { UserErrorBanner } from '../user-error-banner'
import { ValidationErrorPopover } from '../validation-error-popover'
import type { MemoryContentBlock } from '../../types/chat'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => useOutputReaderStore.getState().close())
const memory = (): Extract<MemoryContentBlock, { state: 'status' }> => ({
  type: 'memory',
  state: 'status',
  revision: 2,
  updatedAt: 1_700_000_000_000,
  goal: 'Retained goal',
  goalPreview: 'Retained goal',
  isGoalTruncated: false,
  counts: {
    decisions: 0,
    requirements: 0,
    editsMade: 0,
    validationResults: 0,
    blockers: 0,
    nextActions: 0,
  },
  evidence: { fresh: 1, stale: 0, total: 1 },
  stalePaths: Array.from({ length: 20 }, (_, i) => `retained/path-${i + 1}.ts`),
  totalStaleCount: 20,
  memoryV2Status: 'unavailable',
})

test('combined memory health does not promote fresh V1 with unavailable or missing V2 to healthy', () => {
  expect(renderToStaticMarkup(<MemoryBox block={memory()} />)).toContain(
    'partial/degraded',
  )
  expect(
    renderToStaticMarkup(
      <MemoryBox block={{ ...memory(), memoryV2Status: undefined }} />,
    ),
  ).toContain('health not captured')
  expect(
    renderToStaticMarkup(
      <ContextBox
        block={{ type: 'context', ledgerText: '', gateBudgetsText: '' }}
      />,
    ),
  ).toContain('were not captured')
})
test('retained diagnostic identities preserve revisions across redisclosure and distinguish different blocks', () => {
  const source = memory()
  const first = capturedDiagnosticDocument('memory', 'Captured memory', source)
  expect(capturedDiagnosticDocument('memory', 'Captured memory', source)).toBe(
    first,
  )
  expect(
    capturedDiagnosticDocument('memory', 'Captured memory', memory()).id,
  ).not.toBe(first.id)
  expect(first.find('path-20.ts', { line: 0, character: 0 }, 1)).not.toBeNull()
})

renderTest(
  'memory/index/validation/error native previews remain bounded and inspect retained details',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const cases = [
      {
        component: <MemoryBox block={memory()} />,
        action: 'Inspect captured memory',
        find: 'path-20.ts',
      },
      {
        component: (
          <IndexStatusBox
            block={{
              type: 'index-status',
              statusLine: 'Index ready',
              messageLine: '',
              corpusLine: '',
              ageLine: '',
              vectorLine: '',
              hintLine: '',
              lines: [],
              diagnosticsLines: [
                'Diagnostics: 12 parser issues.',
                ...Array.from(
                  { length: 12 },
                  (_, i) => `captured issue ${i + 1}`,
                ),
              ],
            }}
          />
        ),
        action: 'Inspect captured diagnostics',
        find: 'issue 12',
      },
      {
        component: (
          <ValidationErrorPopover
            agentEntries={[]}
            errors={Array.from({ length: 10 }, (_, i) => ({
              id: `fixture-${i + 1}`,
              message: JSON.stringify([
                { path: ['first'], message: `brief ${i + 1}` },
                {
                  path: ['nested', 'second'],
                  message: `retained nested detail ${i + 1}`,
                },
              ]),
            }))}
          />
        ),
        action: 'Inspect all captured errors',
        find: 'retained nested detail 10',
      },
      {
        component: (
          <UserErrorBanner
            error={Array.from(
              { length: 100 },
              (_, i) => `retained failure ${i + 1}`,
            ).join('\n')}
          />
        ),
        action: 'Inspect captured error',
        find: 'failure 100',
      },
    ]
    for (const fixture of cases) {
      const setup = await testRender(fixture.component, {
        width: 80,
        height: 24,
      })
      try {
        await React.act(async () => setup.renderOnce())
        const rows = setup.captureCharFrame().split('\n')
        const y = rows.findIndex((row) => row.includes(fixture.action))
        expect(y).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(rows[y]!.indexOf(fixture.action) + 2, y),
        )
        const document = useOutputReaderStore.getState().request?.document
        expect(document).toBeDefined()
        expect(
          document!.find(fixture.find, { line: 0, character: 0 }, 1),
        ).not.toBeNull()
        useOutputReaderStore.getState().close()
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)
