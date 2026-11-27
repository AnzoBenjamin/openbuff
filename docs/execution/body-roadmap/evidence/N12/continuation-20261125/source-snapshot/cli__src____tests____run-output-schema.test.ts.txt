import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCliArgs } from '../cli-args'
import { runHeadlessCommand } from '../commands/run-command'
import type { OpenbuffClient } from '@openbuff/sdk'

let root: string, file: string
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-output-schema-'))
  file = path.join(root, 'schema.json')
  fs.writeFileSync(file, JSON.stringify(schema))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function setup(json: boolean, output: unknown, selectedFile = file) {
  const stdout: string[] = [],
    stderr: string[] = [],
    calls: Record<string, unknown>[] = []
  let journals = 0
  const run = async (args: Record<string, unknown>) => {
    calls.push(args)
    const emit = args.handleEvent as (event: unknown) => void
    emit({ type: 'text', text: 'not-final-prose' })
    return {
      output,
      runOutcome: { termination: 'completed' },
      taskAcceptance: { status: 'unknown' },
    }
  }
  return {
    stdout,
    stderr,
    calls,
    journalCount: () => journals,
    invoke: () =>
      runHeadlessCommand(
        { prompt: 'Return an answer', json, outputSchema: selectedFile },
        {
          projectRoot: root,
          writeStdout: (chunk) => stdout.push(chunk),
          writeStderr: (line) => stderr.push(line),
          getClient: async () => ({ run }) as unknown as OpenbuffClient,
          openRunJournal: () => {
            journals++
            return undefined
          },
        },
      ),
  }
}
describe('headless schema delivery', () => {
  test('parser accepts --output-schema alongside stdin/model selection', () => {
    const args = parseCliArgs(
      [
        'bun',
        'openbuff',
        'run',
        '--output-schema',
        file,
        '--model',
        'provider/model',
      ],
      { version: 'test', exitOverride: true },
    )
    expect(args.run).toMatchObject({
      outputSchema: file,
      model: 'provider/model',
      readFromStdin: true,
    })
  })
  for (const value of ['', ' '])
    test('parser refuses an empty schema path', () => {
      expect(() =>
        parseCliArgs(
          ['bun', 'openbuff', 'run', '--output-schema', value, '-p', 'answer'],
          { version: 'test', exitOverride: true },
        ),
      ).toThrow()
    })
  test('plain schema mode prints only the validated final JSON, not intermediate prose', async () => {
    const h = setup(false, {
      type: 'structuredOutput',
      value: { answer: 'confirmed' },
    })
    expect(await h.invoke()).toBe(0)
    expect(h.calls[0].outputSchema).toEqual(schema)
    expect(JSON.parse(h.stdout.join(''))).toEqual({ answer: 'confirmed' })
    expect(h.stdout.join('')).not.toContain('not-final-prose')
  })
  test('JSON event mode delivers one explicit final result after streamed events', async () => {
    const h = setup(true, {
      type: 'structuredOutput',
      value: { answer: 'confirmed' },
    })
    expect(await h.invoke()).toBe(0)
    const events = h.stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      output: { answer: 'confirmed' },
    })
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1)
  })
  for (const output of [
    { type: 'lastMessage', value: [] },
    { type: 'structuredOutput', value: { wrong: 3 } },
    { type: 'structuredOutput', value: null },
  ])
    test('unconfirmed or mismatched final output is refused, not printed as valid JSON', async () => {
      const h = setup(false, output)
      expect(await h.invoke()).toBe(1)
      expect(h.stdout).toEqual([])
      expect(h.stderr.join('')).toMatch(/schema|structured|output/i)
    })
  test('schema file symlinks and nonregular inputs are refused before admission', async () => {
    const link = path.join(root, 'schema-link.json')
    fs.symlinkSync(file, link)
    for (const selected of [link, root]) {
      const h = setup(
        true,
        { type: 'structuredOutput', value: { answer: 'confirmed' } },
        selected,
      )
      expect(await h.invoke()).toBe(1)
      expect(h.calls).toHaveLength(0)
      expect(h.journalCount()).toBe(0)
    }
  })

  for (const content of [
    '{',
    JSON.stringify({ type: 'array' }),
    JSON.stringify({ type: 'object', $ref: 'https://never-fetch.invalid' }),
    ' '.repeat(70_000),
  ])
    test('bad schema input is refused before journal/client admission', async () => {
      fs.writeFileSync(file, content)
      const h = setup(true, {
        type: 'structuredOutput',
        value: { answer: 'confirmed' },
      })
      expect(await h.invoke()).toBe(1)
      expect(h.calls).toHaveLength(0)
      expect(h.journalCount()).toBe(0)
    })
})
