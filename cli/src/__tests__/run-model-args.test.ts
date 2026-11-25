import { describe, expect, test } from 'bun:test'
import { parseCliArgs } from '../cli-args'
import { runHeadlessCommand } from '../commands/run-command'
import type { OpenbuffClient } from '@openbuff/sdk'

describe('headless model override intake', () => {
  test('parses --model with -p or stdin and preserves the explicit choice', () => {
    for (const prompt of [[], ['-p', 'Inspect this']]) {
      const args = parseCliArgs(
        ['bun', 'openbuff', 'run', '--model', 'provider/selected', ...prompt],
        { version: 'test', exitOverride: true },
      )
      expect(args.run?.model).toBe('provider/selected')
      expect(args.run?.readFromStdin).toBe(prompt.length ? undefined : true)
    }
  })
  for (const model of ['', ' ', 'provider/selected\n'])
    test(`refuses an invalid --model value ${JSON.stringify(model)}`, () => {
      expect(() =>
        parseCliArgs(
          ['bun', 'openbuff', 'run', '--model', model, '-p', 'Inspect this'],
          { version: 'test', exitOverride: true },
        ),
      ).toThrow()
    })
  test('forwards model to the actual SDK run boundary without changing agent or prompt', async () => {
    const requests: Record<string, unknown>[] = []
    const code = await runHeadlessCommand(
      { prompt: 'Inspect this', json: true, model: 'provider/selected' },
      {
        projectRoot: '/owned/project',
        writeStdout() {},
        writeStderr() {},
        openRunJournal: () => undefined,
        getClient: async () =>
          ({
            run: async (input: Record<string, unknown>) => {
              requests.push(input)
              return { output: { type: 'lastMessage', value: [] } }
            },
          }) as unknown as OpenbuffClient,
      },
    )
    expect(code).toBe(0)
    expect(requests[0]).toMatchObject({
      model: 'provider/selected',
      prompt: 'Inspect this',
    })
  })
})
