import { expect, test } from 'bun:test'

import { processFileBlock } from '../process-file-block'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

test('whole-file rewrites preserve the existing BOM and dominant line ending', async () => {
  const result = await processFileBlock({
    path: 'src/notes.txt',
    initialContentPromise: Promise.resolve('\uFEFFbefore\r\nafter\r\n'),
    newContent: 'updated\nafter\n',
    logger,
  })

  expect(result.aborted).toBe(false)
  if (result.aborted) throw new Error('expected write result')
  expect(result.value).toMatchObject({
    tool: 'write_file',
    content: '\uFEFFupdated\r\nafter\r\n',
  })
})

test('whole-file rewrites honor explicit BOM and line-ending changes', async () => {
  const result = await processFileBlock({
    path: 'src/notes.txt',
    initialContentPromise: Promise.resolve('\uFEFFbefore\r\nafter\r\n'),
    newContent: '\uFEFFupdated\r\nafter\r\n',
    instructions: 'Remove the UTF-8 BOM and convert line endings to LF.',
    logger,
  })

  expect(result.aborted).toBe(false)
  if (result.aborted) throw new Error('expected write result')
  expect(result.value).toMatchObject({
    tool: 'write_file',
    content: 'updated\nafter\n',
  })
})
