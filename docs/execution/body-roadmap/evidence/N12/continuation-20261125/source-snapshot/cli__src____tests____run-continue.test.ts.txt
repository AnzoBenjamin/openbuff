import { describe, expect, test } from 'bun:test'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { parseCliArgs } from '../cli-args'
import { runHeadlessCommand } from '../commands/run-command'
import type { RunHeadlessDeps } from '../commands/run-command'
import type { OpenbuffClient, RunState } from '@openbuff/sdk'

const parse = (...args: string[]) =>
  parseCliArgs(['bun', 'openbuff', 'run', ...args], {
    version: 'test',
    exitOverride: true,
  })
const prior: RunState = {
  sessionState: getInitialSessionState(
    {} as Parameters<typeof getInitialSessionState>[0],
  ),
  output: { type: 'lastMessage', value: [] },
  runOutcome: { termination: 'completed' },
}

function setup() {
  const calls: Record<string, unknown>[] = []
  const saved: Array<{ state: RunState; agentId: string }> = []
  const stdout: string[] = [],
    stderr: string[] = []
  let released = 0,
    acquired = 0,
    journals = 0
  const lease = {
    sessionId: 'fixture-session',
    agentId: 'reader',
    previousRun: prior,
    async save(state: RunState, agentId: string) {
      saved.push({ state, agentId })
    },
    async close() {
      released++
    },
  }
  const deps: RunHeadlessDeps = {
    projectRoot: '/injected/project',
    writeStdout: (chunk) => stdout.push(chunk),
    writeStderr: (line) => stderr.push(line),
    getClient: async () =>
      ({
        async run(options: Record<string, unknown>) {
          calls.push(options)
          return { ...prior, output: { type: 'lastMessage', value: [] } }
        },
      }) as unknown as OpenbuffClient,
    openRunJournal: () => {
      journals++
      return undefined
    },
    sessionStore: {
      directory: '/injected/sessions',
      async acquire() {
        acquired++
        return lease
      },
    },
    getProviderReadiness: () => ({ ok: true }),
  }
  return {
    deps,
    lease,
    saved,
    calls,
    stdout,
    stderr,
    released: () => released,
    acquired: () => acquired,
    journals: () => journals,
  }
}

describe('headless continuation admission', () => {
  test('parser supports the last session and an explicit ID independently from prompt/model', () => {
    expect(parse('--continue', '-p', 'next').run).toMatchObject({
      continue: true,
      prompt: 'next',
    })
    expect(
      parse('--continue', 'session-1', '--model', 'fixture/model', '-p', 'next')
        .run,
    ).toMatchObject({
      continue: true,
      continueId: 'session-1',
      model: 'fixture/model',
      prompt: 'next',
    })
    expect(parse('--continue', '--json').run).toMatchObject({
      continue: true,
      readFromStdin: true,
      json: true,
    })
  })

  for (const id of ['', '../outside', 'a/b', 'a\\b', '..', 'x'.repeat(129)])
    test('parser rejects unsafe explicit IDs', () =>
      expect(() => parse(`--continue=${id}`, '-p', 'next')).toThrow())

  test('continues the saved agent with previousRun but never enables interrupted effect replay', async () => {
    const h = setup()
    expect(
      await runHeadlessCommand(
        { prompt: 'new task', json: true, continue: true },
        h.deps,
      ),
    ).toBe(0)
    expect(h.calls[0]).toMatchObject({
      agent: 'reader',
      prompt: 'new task',
      previousRun: prior,
    })
    expect(h.calls[0].resumeInterruptedTurn).toBeUndefined()
    expect(h.saved[0].agentId).toBe('reader')
    expect(h.released()).toBe(1)
    expect(h.stderr.join('\n')).toContain('fixture-session')
  })

  test('explicit agent and model apply only to the new turn', async () => {
    const h = setup()
    expect(
      await runHeadlessCommand(
        {
          prompt: 'next',
          json: true,
          continue: true,
          agentId: 'base2',
          model: 'fixture/selected',
        },
        h.deps,
      ),
    ).toBe(0)
    expect(h.calls[0]).toMatchObject({
      agent: 'base2',
      model: 'fixture/selected',
      previousRun: prior,
    })
    expect(prior.sessionState?.mainAgentState.runOutcome).toBeUndefined()
  })

  test('missing or corrupt continuation fails before journal and provider dispatch, with no fresh-session fallback', async () => {
    const h = setup()
    h.deps.sessionStore!.acquire = async () => {
      throw new Error('selected session is corrupt')
    }
    expect(
      await runHeadlessCommand(
        { prompt: 'next', json: true, continue: true },
        h.deps,
      ),
    ).toBe(1)
    expect(h.calls).toHaveLength(0)
    expect(h.journals()).toBe(0)
    expect(JSON.parse(h.stdout.join('')).runOutcome.cause.code).toBe(
      'headless_session_unavailable',
    )
  })

  test('the shared readiness message is preserved, with no journal or fresh-session creation', async () => {
    const h = setup()
    h.deps.getProviderReadiness = () => ({
      ok: false,
      message: 'Shared TUI missing-key message',
    })
    expect(
      await runHeadlessCommand({ prompt: 'next', json: true }, h.deps),
    ).toBe(1)
    expect(h.calls).toHaveLength(0)
    expect(h.journals()).toBe(0)
    expect(h.acquired()).toBe(0)
    expect(JSON.parse(h.stdout.join('')).message).toBe(
      'Shared TUI missing-key message',
    )
  })

  test('a cancelled or failed run is saved before its lease is released', async () => {
    for (const termination of ['cancelled', 'failed'] as const) {
      const h = setup()
      const result: RunState = {
        ...prior,
        output: { type: 'error', message: termination },
        runOutcome: { termination },
      }
      h.deps.getClient = async () =>
        ({ run: async () => result }) as unknown as OpenbuffClient
      expect(
        await runHeadlessCommand(
          { prompt: 'next', json: true, continue: true },
          h.deps,
        ),
      ).toBe(1)
      expect(h.saved[0].state.runOutcome?.termination).toBe(termination)
      expect(h.released()).toBe(1)
    }
  })

  test('continuation persistence failure is visible rather than a successful lost update', async () => {
    const h = setup()
    h.lease.save = async () => {
      throw new Error('quota exceeded')
    }
    expect(
      await runHeadlessCommand(
        { prompt: 'next', json: true, continue: true },
        h.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(h.stdout.join('')).runOutcome.cause.code).toBe(
      'headless_session_persist_failed',
    )
    expect(h.released()).toBe(1)
  })

  test('a throwing client releases only its acquired session', async () => {
    const h = setup()
    h.deps.getClient = async () =>
      ({
        run: async () => {
          throw new Error('provider failed')
        },
      }) as unknown as OpenbuffClient
    expect(
      await runHeadlessCommand(
        { prompt: 'next', json: true, continue: true },
        h.deps,
      ),
    ).toBe(1)
    expect(h.saved).toHaveLength(0)
    expect(h.released()).toBe(1)
  })
})
