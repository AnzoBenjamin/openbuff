import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { GateStateBox } from '../renderers/gate-state-box'

import type { GateStateContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeBlock = (
  overrides: Partial<GateStateContentBlock> = {},
): GateStateContentBlock => ({
  type: 'gate-state',
  gate: 'validation/reviewer',
  gateStatus: 'passed',
  ...overrides,
})

describe('GateStateBox', () => {
  test('renders passed status with checkmark icon and PASSED label', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'passed' })} />,
    )

    expect(markup).toContain('✓')
    expect(markup).toContain('PASSED')
    expect(markup).toContain('validation/reviewer')
  })

  test('renders failed status with cross icon', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'failed' })} />,
    )

    expect(markup).toContain('✗')
    expect(markup).toContain('FAILED')
  })

  test('renders pending status with ellipsis icon', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'pending' })} />,
    )

    expect(markup).toContain('…')
    expect(markup).toContain('PENDING')
  })

  test('renders skipped status with dash icon', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'skipped' })} />,
    )

    expect(markup).toContain('–')
    expect(markup).toContain('SKIPPED')
  })

  test('renders origin label when provided', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({ gateStatus: 'passed', origin: 'Promotion' })}
      />,
    )

    expect(markup).toContain('Promotion')
  })

  test('defaults origin to "Gate" when not provided', () => {
    const block = makeBlock({ gateStatus: 'passed' })
    delete (block as Partial<GateStateContentBlock>).origin
    const markup = renderToStaticMarkup(<GateStateBox block={block} />)

    expect(markup).toContain('Gate')
  })

  test('renders details when provided', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({
          gateStatus: 'failed',
          details: 'hooks failed: typecheck exit 1',
        })}
      />,
    )

    expect(markup).toContain('hooks failed: typecheck exit 1')
  })

  test('omits details section when not provided', () => {
    const block = makeBlock({ gateStatus: 'passed' })
    delete block.details
    const markup = renderToStaticMarkup(<GateStateBox block={block} />)

    expect(markup).toContain('validation/reviewer')
    expect(markup).not.toContain('undefined')
  })

  test('renders advisories below the details when provided', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({
          gateStatus: 'passed',
          details: 'no blockers',
          advisories: ['consider a regression test', 'naming nit in helper'],
        })}
      />,
    )

    expect(markup).toContain('Advisory (non-blocking)')
    expect(markup).toContain('consider a regression test')
    expect(markup).toContain('naming nit in helper')
    expect(markup.indexOf('no blockers')).toBeLessThan(
      markup.indexOf('Advisory (non-blocking)'),
    )
    expect(markup).toContain(theme.secondary)
  })

  // Delimiter safety: after the parser unescapes the payload, advisory text may
  // legitimately contain the literal `</gate-state>` closing delimiter.
  test('renders advisory text containing the gate-state closing delimiter', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({
          gateStatus: 'passed',
          advisories: [
            'advisory quoting </gate-state> from the persisted format',
          ],
        })}
      />,
    )

    expect(markup).toContain('Advisory (non-blocking)')
    expect(markup).toContain('advisory quoting')
    // The delimiter text reaches the rendered output (React escapes `<`/`>` in
    // text children, so accept either form rather than pinning the escaping).
    expect(markup).toMatch(/(&lt;|<)\/gate-state(&gt;|>)/)
  })

  // Render contract: the parser only admits advisory lists within the
  // producer's bound (8 entries), and every admitted entry is rendered.
  test('renders every advisory of a list at the producer cap', () => {
    const advisories = Array.from(
      { length: 8 },
      (_, index) => `advisory ${index}`,
    )
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'passed', advisories })} />,
    )

    expect(markup).toContain('Advisory (non-blocking)')
    for (const advisory of advisories) {
      expect(markup).toContain(advisory)
    }
  })

  test('renders no advisory text when the field is absent', () => {
    const block = makeBlock({ gateStatus: 'passed', details: 'no blockers' })
    delete block.advisories
    const markup = renderToStaticMarkup(<GateStateBox block={block} />)

    expect(markup).toContain('no blockers')
    expect(markup).not.toContain('Advisory')
  })

  test('renders no advisory text for an empty advisories array', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({ gateStatus: 'passed', advisories: [] })}
      />,
    )

    expect(markup).not.toContain('Advisory')
  })

  // Declared work remaining while the gate passed is a caution, not an error,
  // so both lines render in the warning tone between details and advisories.
  test('renders both declared-workflow lines when workflow progress is present', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox
        block={makeBlock({
          gateStatus: 'passed',
          details: 'no blockers',
          workflow: {
            completedCount: 1,
            totalCount: 3,
            nextWorkflowAction: 'Implement wave 2 of the refactor',
          },
          advisories: ['naming nit in helper'],
        })}
      />,
    )

    expect(markup).toContain('Declared workflow: 1/3 complete')
    expect(markup).toContain('2 remaining')
    expect(markup).toContain('Next: Implement wave 2 of the refactor')
    expect(markup).toContain(theme.warning)
    // Ordering: after details, before the advisories section.
    expect(markup.indexOf('no blockers')).toBeLessThan(
      markup.indexOf('Declared workflow'),
    )
    expect(markup.indexOf('Declared workflow')).toBeLessThan(
      markup.indexOf('Advisory (non-blocking)'),
    )
  })

  test('renders no declared-workflow lines when workflow is absent', () => {
    const block = makeBlock({ gateStatus: 'passed', details: 'no blockers' })
    delete block.workflow
    const markup = renderToStaticMarkup(<GateStateBox block={block} />)

    expect(markup).toContain('no blockers')
    expect(markup).not.toContain('Declared workflow')
    expect(markup).not.toContain('Next:')
  })

  test('uses error color for failed status', () => {
    const failedMarkup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'failed' })} />,
    )

    // The theme error color should appear as a foreground attribute
    expect(failedMarkup).toContain(theme.error)
  })

  test('uses success color for passed status', () => {
    const passedMarkup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'passed' })} />,
    )

    expect(passedMarkup).toContain(theme.success)
  })

  test('uses warning color for pending status', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'pending' })} />,
    )

    expect(markup).toContain(theme.warning)
  })

  test('uses secondary color for skipped status', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'skipped' })} />,
    )

    expect(markup).toContain(theme.secondary)
  })

  test('skipped uses secondary not warning', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'skipped' })} />,
    )

    expect(markup).toContain(theme.secondary)
    expect(markup).not.toContain(theme.warning)
  })

  test('pending uses warning not secondary', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'pending' })} />,
    )

    expect(markup).toContain(theme.warning)
    expect(markup).not.toContain(theme.secondary)
  })

  test('skipped hint text is rendered', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'skipped' })} />,
    )

    expect(markup).toContain('SKIPPED — gate intentionally not run')
  })

  test('maps all gate statuses to correct tones via border color', () => {
    const cases: Array<{
      status: GateStateContentBlock['gateStatus']
      expectedColor: string
    }> = [
      { status: 'passed', expectedColor: theme.success },
      { status: 'failed', expectedColor: theme.error },
      { status: 'pending', expectedColor: theme.warning },
      { status: 'skipped', expectedColor: theme.secondary },
    ]
    for (const { status, expectedColor } of cases) {
      const markup = renderToStaticMarkup(
        <GateStateBox block={makeBlock({ gateStatus: status })} />,
      )
      expect(markup).toContain(expectedColor)
    }
  })

  test('passed does not use error', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'passed' })} />,
    )
    expect(markup).toContain(theme.success)
    expect(markup).not.toContain(theme.error)
  })

  test('failed does not use success', () => {
    const markup = renderToStaticMarkup(
      <GateStateBox block={makeBlock({ gateStatus: 'failed' })} />,
    )
    expect(markup).toContain(theme.error)
    expect(markup).not.toContain(theme.success)
  })
})
