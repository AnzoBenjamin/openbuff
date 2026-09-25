import { describe, expect, test } from 'bun:test'

import {
  countInProgressDraftAnswers,
  nextEscapeAction,
} from '../../ask-user/skip-guard'

import type { AccordionAnswer } from '../../ask-user/components/accordion-question'

/**
 * Pins the Esc/skip-guard decision used by MultipleChoiceForm (shard-cli-tui
 * finding: ask-user Esc data-loss — one stray Esc discarded every answered
 * question with no confirmation). The component's useKeyboard handler calls
 * exactly these helpers, so pinning them pins the skip-preservation behavior
 * without an OpenTUI render.
 */

describe('countInProgressDraftAnswers', () => {
  test('an empty answers map counts zero drafts', () => {
    expect(countInProgressDraftAnswers(new Map())).toBe(0)
  })

  test('each answered question counts once', () => {
    const answers = new Map<number, AccordionAnswer>([
      [0, { selectedIndex: 1 }],
      [1, { selectedIndices: new Set([0, 2]) }],
      [2, { isCustom: true, customText: 'my custom note' }],
    ])

    expect(countInProgressDraftAnswers(answers)).toBe(3)
  })

  test('blank custom text and unset selections are not drafts', () => {
    const answers = new Map<number, AccordionAnswer>([
      [0, { isCustom: true, customText: '   ' }],
      [1, { isCustom: true }],
      [2, {}],
      [3, { selectedIndices: new Set() }],
    ])

    expect(countInProgressDraftAnswers(answers)).toBe(0)
  })
})

describe('nextEscapeAction', () => {
  test('skips immediately when the form is untouched', () => {
    expect(nextEscapeAction(0, false)).toBe('skip')
  })

  test('warns instead of discarding when a draft exists', () => {
    expect(nextEscapeAction(2, false)).toBe('warn')
  })

  test('a second Esc with a draft present commits the skip', () => {
    expect(nextEscapeAction(2, true)).toBe('skip')
  })
})
