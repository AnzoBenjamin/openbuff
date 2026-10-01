import { describe, expect, test } from 'bun:test'

import { runHeadlessCommand } from '../commands/run-command'

import type { RunCommandArgs, RunHeadlessDeps } from '../commands/run-command'
import type { OpenbuffClient, PrintModeEvent } from '@openbuff/sdk'

/**
 * Fully hermetic: every dependency of runHeadlessCommand is injected, so no
 * real client, provider, or stdio is touched. The fake client's `run` drives
 * the injected handleEvent with the scripted events (or throws), so each test
 * asserts on the captured stdout/stderr and the returned exit code.
 */
function makeHarness(options?: {
  events?: PrintModeEvent[]
  throwMessage?: string
  args?: Partial<RunCommandArgs>
  deps?: Partial<RunHeadlessDeps>
}) {
  const stdoutChunks: string[] = []
  const stderrLines: string[] = []
  const runCalls: Array<Record<string, unknown>> = []

  const clientStub = {
    run: async (opts: Record<string, unknown>) => {
      runCalls.push(opts)
      if (options?.throwMessage) {
        throw new Error(options.throwMessage)
      }
      const handleEvent = opts.handleEvent as
        | ((event: PrintModeEvent) => void | Promise<void>)
        | undefined
      for (const event of options?.events ?? []) {
        await handleEvent?.(event)
      }
      return { output: { type: 'message' } }
    },
  }

  const deps: RunHeadlessDeps = {
    getClient: async () => clientStub as unknown as OpenbuffClient,
    writeStdout: (chunk) => stdoutChunks.push(chunk),
    writeStderr: (line) => stderrLines.push(line),
    projectRoot: '/injected/project',
    ...options?.deps,
  }

  const args: RunCommandArgs = {
    prompt: 'do the thing',
    json: true,
    ...options?.args,
  }

  return { args, deps, stdoutChunks, stderrLines, runCalls }
}

describe('runHeadlessCommand', () => {
  test('--json emits one ndjson line per event and returns 0', async () => {
    const events: PrintModeEvent[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    const h = makeHarness({ events, args: { json: true } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(0)
    // stdout carries ONLY ndjson: exactly one JSON.stringify(event) + '\n'
    // line per event, and each line round-trips through JSON.parse.
    expect(h.stdoutChunks).toEqual(
      events.map((event) => JSON.stringify(event) + '\n'),
    )
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(events.length)
    expect(lines.map((line) => JSON.parse(line))).toEqual(events)
    // Human/diagnostic text goes to stderr only.
    expect(h.stderrLines.length).toBeGreaterThan(0)
  })

  test('non-json writes only text event content to stdout', async () => {
    const events: PrintModeEvent[] = [
      { type: 'text', text: 'hello ' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_files',
        input: {},
      } as unknown as PrintModeEvent,
      { type: 'text', text: 'world' },
    ]
    const h = makeHarness({ events, args: { json: false } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(0)
    expect(h.stdoutChunks.join('')).toBe('hello world')
  })

  test('a throwing client returns 1 and writes an error ndjson line (json)', async () => {
    const h = makeHarness({ throwMessage: 'boom', args: { json: true } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(1)
    expect(h.stdoutChunks).toEqual([
      JSON.stringify({ type: 'error', message: 'boom' }) + '\n',
    ])
    expect(JSON.parse(h.stdoutChunks.join('').trim())).toEqual({
      type: 'error',
      message: 'boom',
    })
    expect(h.stderrLines.some((l) => l.includes('boom'))).toBe(true)
  })

  test('a throwing client returns 1 and writes the error to stderr (non-json)', async () => {
    const h = makeHarness({ throwMessage: 'boom', args: { json: false } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(1)
    expect(h.stdoutChunks).toEqual([])
    expect(h.stderrLines.some((l) => l.includes('boom'))).toBe(true)
  })

  test('threads prompt and agentId into client.run (defaulting agent to base)', async () => {
    const h = makeHarness({ args: { prompt: 'fix it', agentId: 'reviewer' } })
    await runHeadlessCommand(h.args, h.deps)
    expect(h.runCalls[0].agent).toBe('reviewer')
    expect(h.runCalls[0].prompt).toBe('fix it')
    expect(h.runCalls[0].cwd).toBe('/injected/project')

    const def = makeHarness({ args: { prompt: 'hi' } })
    await runHeadlessCommand(def.args, def.deps)
    expect(def.runCalls[0].agent).toBe('base')
  })
})
