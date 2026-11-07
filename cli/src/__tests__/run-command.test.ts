import { describe, expect, test } from 'bun:test'

import { runHeadlessCommand } from '../commands/run-command'

import type { RunCommandArgs, RunHeadlessDeps } from '../commands/run-command'
import type { OpenbuffClient, PrintModeEvent, RunState } from '@openbuff/sdk'

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
  result?: RunState
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
      return options?.result ?? { output: { type: 'lastMessage', value: [] } }
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
  test('resolved failed, exhausted and rejected outcomes fail without an error event', async () => {
    const results: RunState[] = [
      {
        output: { type: 'lastMessage', value: [] },
        runOutcome: {
          termination: 'failed',
          cause: { code: 'failed', message: '' },
        },
      },
      { output: { type: 'error', message: '   ' } },
      {
        output: { type: 'lastMessage', value: [] },
        runOutcome: { termination: 'budget_exhausted' },
      },
      {
        output: { type: 'lastMessage', value: [] },
        runOutcome: { termination: 'step_exhausted' },
      },
      {
        output: { type: 'lastMessage', value: [] },
        runOutcome: { termination: 'cancelled' },
      },
      {
        output: { type: 'lastMessage', value: [] },
        runOutcome: { termination: 'completed' },
        taskAcceptance: { status: 'rejected', oracle: 'fixture' },
      },
    ]
    for (const result of results) {
      const h = makeHarness({
        result,
        deps: { openRunJournal: () => undefined },
      })
      expect(await runHeadlessCommand(h.args, h.deps)).toBe(1)
      const error = JSON.parse(h.stdoutChunks.join('').trim())
      expect(error.type).toBe('error')
      expect(error.message.trim().length).toBeGreaterThan(0)
      if (result.taskAcceptance?.status === 'rejected') {
        expect(error.runOutcome.termination).toBe('completed')
        expect(error.taskAcceptance.status).toBe('rejected')
      }
    }
  })

  test('an accepted recovery succeeds while its failed action stays recorded', async () => {
    const result: RunState = {
      output: { type: 'lastMessage', value: [] },
      runOutcome: { termination: 'completed' },
      taskAcceptance: { status: 'accepted', oracle: 'fixture' },
      actionOutcomes: [
        {
          actionId: 'failed-action',
          attemptId: 'attempt',
          runId: 'run',
          toolName: 'custom',
          basis: { inputHash: 'sha256:fixture' },
          outcome: 'failed',
          effect: { status: 'unobserved', receiptIds: [], confirmedPaths: [] },
        },
      ],
    }
    const h = makeHarness({ result, deps: { openRunJournal: () => undefined } })
    expect(await runHeadlessCommand(h.args, h.deps)).toBe(0)
    expect(result.actionOutcomes?.[0].outcome).toBe('failed')
  })

  test('short human text flushes before a deferred run completes', async () => {
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const deferred = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = makeHarness({
      args: { json: false },
      deps: {
        openRunJournal: () => undefined,
        getClient: async () =>
          ({
            run: async (options: {
              handleEvent: (event: PrintModeEvent) => void
            }) => {
              options.handleEvent({ type: 'text', text: 'first text' })
              started()
              await deferred
              return { output: { type: 'lastMessage', value: [] } }
            },
          }) as unknown as OpenbuffClient,
      },
    })
    const running = runHeadlessCommand(h.args, h.deps)
    await ready
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.stdoutChunks.join('')).toBe('first text')
    finish()
    expect(await running).toBe(0)
    expect(h.stdoutChunks.join('')).toBe('first text')
  })
  test('--json emits one ndjson line per event and returns 0', async () => {
    const events: PrintModeEvent[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    const h = makeHarness({ events, args: { json: true } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(0)
    // stdout carries ONLY ndjson: exactly one JSON.stringify(event) + '\n'
    // line per event (writes are BATCHED, so assert on the JOINED stream),
    // and each line round-trips through JSON.parse.
    expect(h.stdoutChunks.join('')).toEqual(
      events.map((event) => JSON.stringify(event) + '\n').join(''),
    )
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(events.length)
    expect(lines.map((line) => JSON.parse(line))).toEqual(events)
    // Human/diagnostic text goes to stderr only.
    expect(h.stderrLines.length).toBeGreaterThan(0)
  })

  test('batches stdout writes without breaking ndjson line integrity', async () => {
    const events: PrintModeEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'text' as const,
      text: `event-${i}`,
    }))
    const h = makeHarness({ events, args: { json: true } })

    const code = await runHeadlessCommand(h.args, h.deps)

    expect(code).toBe(0)
    // Flushed every 32 events plus the final drain: far fewer write calls
    // than events, but never zero.
    expect(h.stdoutChunks.length).toBeGreaterThan(0)
    expect(h.stdoutChunks.length).toBeLessThan(events.length)
    // Content and ordering are unchanged: every ndjson line round-trips.
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(events.length)
    expect(lines.map((line) => JSON.parse(line))).toEqual(events)
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
    expect(h.stdoutChunks).toHaveLength(1)
    expect(JSON.parse(h.stdoutChunks.join('').trim())).toMatchObject({
      type: 'error',
      message: 'boom',
      runOutcome: { termination: 'failed' },
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

  describe('P2-T7 live run journal wiring', () => {
    /**
     * A minimal fake journal with the P2-T7 runIds dash extension and the
     * slice-4 hardening members (forceFlush/recentEvents/eventsOfType), so it
     * satisfies CreatedRunJournal structurally.
     */
    const fakeJournal = () => ({
      append: () => undefined,
      lastEvent: () => undefined,
      events: () => [],
      toolResultFor: () => undefined,
      toolResultForInput: () => undefined,
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
      pruneRuns: () => undefined,
      maintain: () => ({ prunedRunCount: 0, vacuumed: false }),
      runIds: () => [],
      runSummaries: () => [],
      forceFlush: async () => {},
      recentEvents: () => [],
      eventsOfType: () => [],
    })

    test('the opened journal is threaded as BOTH journalWriter and journalReader, then closed', async () => {
      const journal = fakeJournal()
      const openedPaths: string[] = []
      let closeCount = 0
      const h = makeHarness({
        deps: {
          openRunJournal: (journalPath) => {
            openedPaths.push(journalPath)
            return journal as unknown as ReturnType<typeof fakeJournal>
          },
          journalPath: '/injected/run-journal.db',
        },
      })
      // Track close via the object the opener returned.
      const originalClose = (journal as { close: () => Promise<void> }).close
      ;(journal as { close: () => Promise<void> }).close = () => {
        closeCount += 1
        return originalClose()
      }

      const code = await runHeadlessCommand(h.args, h.deps)

      expect(code).toBe(0)
      expect(openedPaths).toEqual(['/injected/run-journal.db'])
      // The SAME object identity serves both sides of the SDK journal seam.
      expect(h.runCalls[0].journalWriter).toBe(journal)
      expect(h.runCalls[0].journalReader).toBe(journal)
      // The run's promise-chain end is the cleanup seam.
      expect(closeCount).toBe(1)
    })

    test('a fail-open opener (undefined) runs WITHOUT journaling and never throws', async () => {
      const h = makeHarness({
        deps: {
          openRunJournal: () => undefined,
          journalPath: '/unopenable/run-journal.db',
        },
      })

      const code = await runHeadlessCommand(h.args, h.deps)

      // Fail-open: the run still completes 0 and carries NO journal fields.
      expect(code).toBe(0)
      expect('journalWriter' in h.runCalls[0]).toBe(false)
      expect('journalReader' in h.runCalls[0]).toBe(false)
      expect(h.stderrLines.join('')).toContain('continuing without journaling')
    })

    test('an opener that throws is contained: fail-open, never crash the run', async () => {
      // Even a throwing opener (a custom seam) must never crash the run:
      // the command catches, warns once, and proceeds WITHOUT journaling.
      const h = makeHarness({
        deps: {
          openRunJournal: () => {
            throw new Error('boom')
          },
          journalPath: '/x/run-journal.db',
        },
      })
      const code = await runHeadlessCommand(h.args, h.deps)
      expect(code).toBe(0)
      expect('journalWriter' in h.runCalls[0]).toBe(false)
      expect('journalReader' in h.runCalls[0]).toBe(false)
      expect(h.stderrLines.join('')).toContain('continuing without journaling')
      expect(h.stderrLines.join('')).toContain('boom')
    })
  })

  describe('timeout (--timeout)', () => {
    /**
     * A client stub whose run hangs forever until its signal aborts, then
     * rejects with the abort reason — the shape a real SDK run has when the
     * deadline (or an external signal) cancels it.
     */
    const hangingClient = {
      run: async (opts: Record<string, unknown>) => {
        return new Promise<never>((_resolve, reject) => {
          const signal = opts.signal as AbortSignal | undefined
          signal?.addEventListener('abort', () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(String(signal.reason ?? 'aborted')),
            )
          })
        })
      },
    }

    const makeTimeoutHarness = (deps: Partial<RunHeadlessDeps> = {}) => {
      const stdoutChunks: string[] = []
      const stderrLines: string[] = []
      const runCalls: Array<Record<string, unknown>> = []
      return {
        stdoutChunks,
        stderrLines,
        runCalls,
        deps: {
          getClient: async () => {
            return {
              run: async (opts: Record<string, unknown>) => {
                runCalls.push(opts)
                return hangingClient.run(opts)
              },
            } as unknown as OpenbuffClient
          },
          writeStdout: (chunk: string) => {
            stdoutChunks.push(chunk)
          },
          writeStderr: (line: string) => {
            stderrLines.push(line)
          },
          projectRoot: '/injected/project',
          ...deps,
        },
      }
    }

    test('aborts a hung run after the deadline: exit 1 with a clean ndjson error event', async () => {
      // The parser restricts --timeout to whole seconds, but the command
      // accepts any positive number of seconds, so tests use a fractional
      // 0.05s deadline to keep the suite fast.
      const t = makeTimeoutHarness()

      const code = await runHeadlessCommand(
        { prompt: 'hang', json: true, timeout: 0.05 },
        t.deps,
      )

      expect(code).toBe(1)
      // stdout stays strictly ndjson: exactly one error line.
      const lines = t.stdoutChunks.join('').split('\n').filter(Boolean)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({
        type: 'error',
        message: expect.stringContaining('timed out'),
        runOutcome: { termination: 'deadline_exhausted' },
      })
      expect(t.stderrLines.join('')).toContain('timed out')
    })

    test('non-json mode reports the timeout on stderr only', async () => {
      const t = makeTimeoutHarness()

      const code = await runHeadlessCommand(
        { prompt: 'hang', json: false, timeout: 0.05 },
        t.deps,
      )

      expect(code).toBe(1)
      expect(t.stdoutChunks).toEqual([])
      expect(t.stderrLines.join('')).toContain('timed out')
    })

    test('a run finishing before the deadline still succeeds', async () => {
      const h = makeHarness({
        events: [{ type: 'text', text: 'done' }],
        args: { json: true, timeout: 30 },
      })

      const code = await runHeadlessCommand(h.args, h.deps)

      expect(code).toBe(0)
      expect(JSON.parse(h.stdoutChunks.join('').trim())).toEqual({
        type: 'text',
        text: 'done',
      })
    })

    test('the run receives a signal when a timeout is set (none before this change)', async () => {
      const h = makeHarness({ args: { prompt: 'hi' } })
      await runHeadlessCommand(h.args, h.deps)
      expect(h.runCalls[0].signal).toBeUndefined()

      const t = makeTimeoutHarness()
      // Fractional deadline (the suite's fast-deadline pattern): a whole-second
      // 30 would outlive bun's 5s test timeout on a hanging client.
      await runHeadlessCommand(
        { prompt: 'hi', json: false, timeout: 0.05 },
        t.deps,
      )
      expect(t.runCalls[0].signal).toBeInstanceOf(AbortSignal)
    })

    test('an injected deps.signal still aborts the run when a timeout is also set', async () => {
      const external = new AbortController()
      const t = makeTimeoutHarness({ signal: external.signal })

      const pending = runHeadlessCommand(
        { prompt: 'hang', json: true, timeout: 30 },
        t.deps,
      )
      // Let the run start, then cancel from the external signal.
      await new Promise((resolve) => setTimeout(resolve, 10))
      external.abort(new Error('client hangup'))
      const code = await pending

      expect(code).toBe(1)
      const lines = t.stdoutChunks.join('').split('\n').filter(Boolean)
      expect(JSON.parse(lines[lines.length - 1])).toMatchObject({
        type: 'error',
        message: 'client hangup',
        runOutcome: { termination: 'cancelled' },
      })
    })
  })
})
