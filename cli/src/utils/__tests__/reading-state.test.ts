import { expect, test } from 'bun:test'
import { createTextDocument } from '../output-document'
import { readDocumentRows } from '../reading-state'

test('wrapped paging advances within long paragraphs and keeps source anchors through resize', () => {
  const document = createTextDocument({
    id: 'long',
    title: 'Paragraph',
    text: '界'.repeat(2000) + '\nnext line',
  })
  const first = readDocumentRows(
    document,
    { line: 0, character: 0 },
    80,
    10,
    true,
  )
  expect(first).toHaveLength(10)
  expect(first[0].text).toBe('界'.repeat(40))
  const anchor = first.at(-1)!.next
  expect(anchor).toEqual({ line: 0, character: 400 })
  const narrow = readDocumentRows(document, anchor, 60, 10, true)
  expect(narrow[0].location).toEqual(anchor)
  expect(narrow[0].text).toBe('界'.repeat(30))
  expect(
    readDocumentRows(document, { line: 1, character: 0 }, 80, 10, true)[0].text,
  ).toBe('next line')
})

test('horizontal view preserves captured lines and exposes hidden columns', () => {
  const document = createTextDocument({
    id: 'table',
    title: 'Columns',
    text: 'name    duration    exact evidence',
  })
  expect(
    readDocumentRows(document, { line: 0, character: 0 }, 14, 5, false, 20)[0]
      .text,
  ).toBe('exact evidence')
})
