import { expect, test } from 'bun:test'
import { formatStructuredAnswer } from '../utils/structured-answer'
import { validateOtherText } from '../utils/validation'

test('multi-select preserves commas, literal Skipped and custom text as separate typed values', () => {
  const question = {
    question: 'Choose',
    options: ['A, B', 'Skipped'],
    multiSelect: true,
  }
  expect(
    formatStructuredAnswer(
      question,
      { selectedIndices: new Set([0, 1]), isCustom: true, customText: 'C, D' },
      2,
    ),
  ).toEqual({
    questionIndex: 2,
    selectedOptions: ['A, B', 'Skipped'],
    otherText: 'C, D',
  })
})
test('literal Skipped is a valid single answer and missing answers have no fake string', () => {
  const question = { question: 'Choose', options: ['Skipped', 'Other'] }
  expect(formatStructuredAnswer(question, { selectedIndex: 0 }, 0)).toEqual({
    questionIndex: 0,
    selectedOption: 'Skipped',
  })
  expect(formatStructuredAnswer(question, undefined, 0)).toEqual({
    questionIndex: 0,
  })
})
test('newline option labels retain their exact typed identity', () => {
  const question = {
    question: 'Choose',
    options: ['A,\nB', 'Skipped'],
    multiSelect: true,
  }
  expect(
    formatStructuredAnswer(question, { selectedIndices: new Set([0, 1]) }, 0),
  ).toEqual({
    questionIndex: 0,
    selectedOptions: ['A,\nB', 'Skipped'],
  })
})
test('submission validation reports invalid patterns and zero-length bounds safely', async () => {
  expect((await validateOtherText('a', { maxLength: 0 })).isValid).toBe(false)
  expect((await validateOtherText('a', { pattern: '[' })).error).toContain(
    'invalid validation pattern',
  )
})
