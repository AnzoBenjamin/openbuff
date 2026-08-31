import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { CompletionSummaryBox } from '../renderers/completion-summary-box'

import type { CompletionSummary } from '../../utils/completion-summary'
import type { CompletionSummaryContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

/** Icons the tightened box must never render again. */
const REMOVED_ICONS = ['✅', '❌', '⚠️', '⚠', '🔴', '🟡', '🟢']

function makeSummary(overrides: Partial<CompletionSummary>): CompletionSummary {
  return {
    filesEdited: 0,
    filesFailed: 0,
    filesUnconfirmed: 0,
    filesRolledBack: 0,
    rollbackIncomplete: 0,
    reviewVerdict: null,
    testPassed: 0,
    testFailed: 0,
    hooksPassed: 0,
    hooksFailed: 0,
    hooksSkipped: 0,
    auxiliaryCompleted: 0,
    auxiliaryFailed: 0,
    errors: 0,
    ...overrides,
  }
}

function renderSummary(summary: CompletionSummary): string {
  const block: CompletionSummaryContentBlock = {
    type: 'completion-summary',
    summary,
  }
  return renderToStaticMarkup(<CompletionSummaryBox block={block} />)
}

describe('CompletionSummaryBox deriveTone', () => {
  test('(1) filesFailed>0 => error tone', () => {
    const markup = renderSummary(makeSummary({ filesFailed: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('(2) hasUnconfirmed => error tone', () => {
    const markup = renderSummary(makeSummary({ filesUnconfirmed: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('(3) rollbackIncomplete => error tone', () => {
    const markup = renderSummary(makeSummary({ rollbackIncomplete: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('(4) BLOCKING verdict => error tone', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'BLOCKING' }))
    expect(markup).toContain(theme.error)
  })

  test('(4b) NEEDS_WORK verdict => error tone', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'NEEDS_WORK' }))
    expect(markup).toContain(theme.error)
  })

  test('(4c) errors>0 => error tone', () => {
    const markup = renderSummary(makeSummary({ errors: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('(5) hasRolledBack alone => warning tone', () => {
    const markup = renderSummary(makeSummary({ filesRolledBack: 1 }))
    expect(markup).toContain(theme.warning)
    expect(markup).not.toContain(theme.error)
  })

  test('(6) NON_BLOCKING alone => warning tone', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'NON_BLOCKING' }))
    expect(markup).toContain(theme.warning)
    expect(markup).not.toContain(theme.error)
  })

  test('(7) success case => success tone', () => {
    const markup = renderSummary(makeSummary({ filesEdited: 1 }))
    expect(markup).toContain(theme.success)
    expect(markup).not.toContain(theme.error)
    expect(markup).not.toContain(theme.warning)
  })

  test('(7b) LOOKS_GOOD verdict alone => success tone', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'LOOKS_GOOD' }))
    expect(markup).toContain(theme.success)
  })

  test('(8) empty => secondary tone', () => {
    const markup = renderSummary(makeSummary({}))
    expect(markup).toContain(theme.secondary)
    expect(markup).not.toContain(theme.error)
    expect(markup).not.toContain(theme.warning)
    expect(markup).not.toContain(theme.success)
  })

  test('error takes precedence over warning (failed + rolled back)', () => {
    const markup = renderSummary(
      makeSummary({ filesFailed: 1, filesRolledBack: 1 }),
    )
    expect(markup).toContain(theme.error)
  })

  test('error takes precedence over success (failed + edited)', () => {
    const markup = renderSummary(
      makeSummary({ filesFailed: 1, filesEdited: 2 }),
    )
    expect(markup).toContain(theme.error)
  })

  test('testFailed => error tone', () => {
    const markup = renderSummary(makeSummary({ testFailed: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('hooksFailed => error tone', () => {
    const markup = renderSummary(makeSummary({ hooksFailed: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('auxiliaryFailed => error tone', () => {
    const markup = renderSummary(makeSummary({ auxiliaryFailed: 1 }))
    expect(markup).toContain(theme.error)
  })

  test('errors >0 with no other activity => error tone', () => {
    const markup = renderSummary(makeSummary({ errors: 3 }))
    expect(markup).toContain(theme.error)
  })

  test('testPassed alone => success tone', () => {
    const markup = renderSummary(makeSummary({ testPassed: 5 }))
    expect(markup).toContain(theme.success)
    expect(markup).not.toContain(theme.error)
    expect(markup).not.toContain(theme.warning)
  })

  test('hooksPassed alone => success tone', () => {
    const markup = renderSummary(makeSummary({ hooksPassed: 2 }))
    expect(markup).toContain(theme.success)
  })

  test('auxiliaryCompleted alone => success tone', () => {
    const markup = renderSummary(makeSummary({ auxiliaryCompleted: 1 }))
    expect(markup).toContain(theme.success)
  })

  test('APPROVED verdict alone => success tone', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'APPROVED' }))
    expect(markup).toContain(theme.success)
  })

  test('warning overrides success (rolledBack + edited)', () => {
    const markup = renderSummary(
      makeSummary({ filesRolledBack: 1, filesEdited: 2 }),
    )
    expect(markup).toContain(theme.warning)
    expect(markup).not.toContain(theme.error)
  })

  test('renders files section with warning tone when filesRolledBack', () => {
    const markup = renderSummary(makeSummary({ filesRolledBack: 1 }))
    expect(markup).toContain('rolled back')
    expect(markup).toContain(theme.warning)
  })

  test('renders hooks section', () => {
    const markup = renderSummary(
      makeSummary({ hooksPassed: 1, hooksFailed: 1 }),
    )
    expect(markup).toContain('Hooks')
    expect(markup).toContain('passed')
    expect(markup).toContain('failed')
  })

  test('renders tests section', () => {
    const markup = renderSummary(makeSummary({ testPassed: 5, testFailed: 1 }))
    expect(markup).toContain('Tests')
    expect(markup).toContain('5 passed')
    expect(markup).toContain('1 failed')
  })

  test('renders auxiliary section under the Agents label', () => {
    const markup = renderSummary(
      makeSummary({ auxiliaryCompleted: 2, auxiliaryFailed: 1 }),
    )
    expect(markup).toContain('Agents')
    expect(markup).toContain('2 completed')
    expect(markup).toContain('1 failed')
  })

  test('renders errors section with error color', () => {
    const markup = renderSummary(makeSummary({ errors: 2 }))
    expect(markup).toContain('2 errors')
    expect(markup).toContain(theme.error)
  })

  test('renders BLOCKING in the error tone, without an icon', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'BLOCKING' }))
    expect(markup).toContain('BLOCKING')
    expect(markup).toContain(theme.error)
  })

  test('renders NON_BLOCKING in the warning tone, without an icon', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'NON_BLOCKING' }))
    expect(markup).toContain('NON_BLOCKING')
    expect(markup).toContain(theme.warning)
  })

  test('renders LOOKS_GOOD in the success tone, without an icon', () => {
    const markup = renderSummary(makeSummary({ reviewVerdict: 'LOOKS_GOOD' }))
    expect(markup).toContain('LOOKS_GOOD')
    expect(markup).toContain(theme.success)
  })

  test('titles the box and emits none of the removed status emoji', () => {
    const markup = renderSummary(
      makeSummary({
        filesEdited: 2,
        filesRolledBack: 1,
        hooksPassed: 1,
        hooksSkipped: 2,
        reviewVerdict: 'NON_BLOCKING',
        testPassed: 5,
        testFailed: 1,
        auxiliaryCompleted: 3,
        auxiliaryFailed: 1,
        errors: 2,
      }),
    )

    expect(markup).toContain('Run summary')
    for (const icon of REMOVED_ICONS) {
      expect(markup).not.toContain(icon)
    }
    // Meaning still survives without color: the state words are in the values.
    expect(markup).toContain('rolled back')
    expect(markup).toContain('2 skipped')
  })

  test('pads the label column so every row value starts at the same offset', () => {
    const markup = renderSummary(
      makeSummary({ filesEdited: 2, reviewVerdict: 'LOOKS_GOOD' }),
    )
    // One row per <text>; strip the inline spans to get the rendered line.
    const rows = [...markup.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(
      (match) => match[1].replace(/<[^>]*>/g, ''),
    )
    const filesRow = rows.find((row) => row.startsWith('Files'))
    const reviewRow = rows.find((row) => row.startsWith('Review'))

    expect(filesRow).toBeDefined()
    expect(reviewRow).toBeDefined()
    // 'Files' is a column shorter than 'Review', so equal value offsets can
    // only come from the shared padded label column.
    expect(filesRow?.indexOf('2 edited')).toBe(reviewRow?.indexOf('LOOKS_GOOD'))
  })
})
