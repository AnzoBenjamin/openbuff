import { describe, expect, test } from 'bun:test'

import { runReplayCommand } from '../commands/replay-command'

import type { ReplayCommandArgs, RunReplayDeps } from '../commands/replay-command'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'

/**
 * Fully hermetic: every dependency of runReplayCommand is injected, so no real
 * journal, sqlite, or stdio is touched. The fake journal reader returns the
 * scripted events (or throws), so each test asserts on the captured
 * stdout/stderr and the returned exit code.
 */
function makeHarness(options?: {
  events?: Array<JournalEvent & { seq: number }>
  eventsError?: string
  openError?: string
  args?: Partial<ReplayCommandArgs>
  deps?: Partial<RunReplayDeps>
}) {
  const stdoutChunks: string[] = []
  const stderrLines: string[] = []
  let closed = false

  const reader = {
    lastEvent: () => undefined,
    events: (runId: string) => {
      if (options?.eventsError) throw new Error(options.eventsError)
      return (options?.events ?? []).filter(() => runId.length > 0)
    },
    toolResultFor: () => undefined,
    toolResultForInput: () => undefined,
    close: () => {
      closed = true
    },
  }

  const deps: RunReplayDeps = {
    openJournal: () => {
      if (options?.openError) throw new Error(options.openError)
      return reader
    },
    journalPath: '/injected/run-journal.db',
    writeStdout: (chunk) => stdoutChunks.push(chunk),
    writeStderr: (line) => stderrLines.push(line),
    ...options?.deps,
  }

  const args: ReplayCommandArgs = {
    runId: 'run-1',
    json: true,
    ...options?.args,
  }

  return {
    args,
    deps,
    stdoutChunks,
    stderrLines,
    isClosed: () => closed,
  }
}

const toolCall = (seq: number, step: number): JournalEvent & { seq: number } => ({
  seq,
  stepNumber: step,
  eventType: 'tool_call',
  correlation: `corr-${seq}`,
  payload: { toolName: 'read_files', input: { filePaths: ['a.ts'] } },
})

const toolResult = (
  seq: number,
  step: number,
): JournalEvent & { seq: number } => ({
  seq,
  stepNumber: step,
  eventType: 'tool_result',
  correlation: `corr-${seq}`,
  payload: { toolName: 'read_files', result: [{ type: 'json', value: 1 }] },
})

describe('runReplayCommand', () => {
  test('--json emits one ndjson line per mappable event and returns 0', async () => {
    const events = [toolCall(0, 0), toolResult(1, 0), toolCall(2, 1)]
    const h = makeHarness({ events, args: { json: true } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(0)
    // stdout carries ONLY ndjson: exactly one JSON.stringify(event) + '\n'
    // line per emitted PrintModeEvent, and each line round-trips JSON.parse.
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({
      type: 'tool_call',
      toolName: 'read_files',
    })
    expect(JSON.parse(lines[1])).toMatchObject({
      type: 'tool_result',
      toolName: 'read_files',
    })
    expect(JSON.parse(lines[2])).toMatchObject({
      type: 'tool_call',
      toolName: 'read_files',
    })
    // Human/diagnostic text goes to stderr only.
    expect(h.stderrLines.length).toBeGreaterThan(0)
    expect(h.isClosed()).toBe(true)
  })

  test('--from-step filters events below the boundary', async () => {
    const events = [toolCall(0, 0), toolCall(1, 1), toolCall(2, 2)]
    const h = makeHarness({ events, args: { json: true, fromStep: 1 } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(0)
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    // Only steps >= 1 remain (seq 1 and 2).
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ toolCallId: 'corr-1' })
    expect(JSON.parse(lines[1])).toMatchObject({ toolCallId: 'corr-2' })
  })

  test('structural events (step_boundary) are not emitted in --json', async () => {
    const events: Array<JournalEvent & { seq: number }> = [
      toolCall(0, 0),
      { seq: 1, stepNumber: 1, eventType: 'step_boundary', payload: {} },
      toolCall(2, 1),
    ]
    const h = makeHarness({ events, args: { json: true } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(0)
    const lines = h.stdoutChunks.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
  })

  test('non-json writes a human-readable trace to stdout', async () => {
    const events = [toolCall(0, 0), toolResult(1, 0)]
    const h = makeHarness({ events, args: { json: false } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(0)
    const out = h.stdoutChunks.join('')
    expect(out).toContain('replay run run-1')
    expect(out).toContain('tool_call')
    expect(out).toContain('tool_result')
  })

  test('unknown run id returns 1 and emits an error ndjson line (json)', async () => {
    const h = makeHarness({ events: [], args: { json: true } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(1)
    expect(h.stdoutChunks).toEqual([
      JSON.stringify({ type: 'error', message: 'unknown run id run-1' }) + '\n',
    ])
    expect(h.stderrLines.some((l) => l.includes('unknown run id'))).toBe(true)
  })

  test('journal unavailable returns 1 and writes the error to stderr', async () => {
    const h = makeHarness({ openError: 'no sqlite', args: { json: false } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(1)
    expect(h.stdoutChunks).toEqual([])
    expect(h.stderrLines.some((l) => l.includes('no sqlite'))).toBe(true)
  })

  test('a replay error returns 1 and emits an error ndjson line (json)', async () => {
    const h = makeHarness({ eventsError: 'corrupt', args: { json: true } })

    const code = await runReplayCommand(h.args, h.deps)

    expect(code).toBe(1)
    expect(JSON.parse(h.stdoutChunks.join('').trim())).toEqual({
      type: 'error',
      message: 'corrupt',
    })
    expect(h.stderrLines.some((l) => l.includes('corrupt'))).toBe(true)
  })
})
