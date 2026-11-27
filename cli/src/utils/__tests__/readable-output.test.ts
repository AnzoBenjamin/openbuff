import { expect, test } from 'bun:test'
import { createJsonDocument } from '../output-document'
import { readableOutput } from '../readable-output'

test('readable capture keeps full raw source, exact copy and complete multiline details', () => {
  const raw = createJsonDocument('fields', 'Fields', {
    agentResult: {
      fullText: 'First line\nsecond exact match\nLast line',
      passedTests: 42,
    },
  })
  const view = readableOutput(raw)
  expect(view.text).toBe(raw.text)
  expect(view.lineCount).toBe(raw.lineCount)
  expect(view.line(1)).toBe('agent result · object fields')
  const found = view.find('second exact match', { line: 0, character: 0 }, 1)!
  expect(found).toEqual({ line: 2, character: 0 })
  expect(view.copyLine(found.line)).toBe(
    'First line\nsecond exact match\nLast line',
  )
  expect(view.detail!(found.line)!.text).toBe(view.copyLine(found.line))
  expect(view.range(-2, 2)).toEqual([view.line(0), view.line(1)])
})

test('escaped and hostile keys remain one row, and equal leaf names retain distinct identities', () => {
  const raw = createJsonDocument('hostile', 'Hostile', {
    'a"]\n\u001b[31m': { sameValue: 'one' },
    another: { sameValue: 'two' },
  })
  const view = readableOutput(raw)
  expect(view.line(1)).not.toContain('\n')
  expect(view.line(1)).not.toContain('\u001b')
  expect(view.row!(2)!.id).not.toBe(view.row!(4)!.id)
  expect(view.copyLine(2)).toBe('one')
  expect(view.copyLine(4)).toBe('two')
})

test('multiple exact matches in an ordinary scalar keep their navigation offsets', () => {
  const raw = createJsonDocument('find', 'Find', {
    aVeryLongFieldName: 'match gap match end',
  })
  const view = readableOutput(raw)
  const first = view.find('match', { line: 0, character: 0 }, 1)!
  const second = view.find(
    'match',
    { line: first.line, character: first.character + 1 },
    1,
  )!
  expect(second.line).toBe(first.line)
  expect(second.character).toBe(first.character + 10)
  expect(
    view.find(
      'match',
      { line: second.line, character: second.character - 1 },
      -1,
    ),
  ).toEqual(first)
})
