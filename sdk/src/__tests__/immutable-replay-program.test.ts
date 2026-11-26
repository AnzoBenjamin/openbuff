import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runReplayableProgram } from '../services/replayable-program'
import { validateProgram } from '../services/immutable-replay-program'

const owned: string[] = []
afterEach(() => {
  for (const root of owned.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const input = {
  journalPath: '',
  program: {
    version: 1 as const,
    operations: [
      { id: 'hash', kind: 'sha256' as const, value: [{ input: 'message' }] },
    ],
  },
  inputs: { message: 'local data' },
  model: {
    endpoint: 'http://127.0.0.1:1/v1/chat/completions',
    name: 'fixture',
  },
}

describe('immutable program admission', () => {
  test('does not run proxies or getters when refusing unknown replay dependencies', async () => {
    if (process.platform !== 'linux') return
    const dir = mkdtempSync(path.join(tmpdir(), 'immutable-program-'))
    owned.push(dir)
    const real = { ...input, journalPath: path.join(dir, 'run.db') }
    let calls = 0
    const spy = () => {
      calls++
      throw new Error('reflective trap was invoked')
    }
    const fauxSignal = Object.create(
      new Proxy(AbortSignal.prototype, { getPrototypeOf: spy }),
    ) as AbortSignal
    const programs = [
      { ...real, signal: fauxSignal },
      new Proxy(real, { getPrototypeOf: spy, ownKeys: spy }),
      { ...real, inputs: new Proxy(real.inputs, { getPrototypeOf: spy }) },
      {
        ...real,
        program: {
          ...real.program,
          operations: new Proxy(real.program.operations, { ownKeys: spy }),
        },
      },
      {
        ...real,
        get model() {
          calls++
          return real.model
        },
      },
      Object.assign(
        { ...real },
        { callback: spy, resumeRunId: `local-program-${'0'.repeat(32)}` },
      ),
    ]
    for (const candidate of programs)
      expect((await runReplayableProgram(candidate)).status).not.toBe(
        'completed',
      )
    expect(calls).toBe(0)
    expect(existsSync(real.journalPath)).toBe(false)
  })

  test('unbuilt source cannot claim that its loaded dependency closure is immutable', async () => {
    if (process.platform !== 'linux') return
    const dir = mkdtempSync(path.join(tmpdir(), 'immutable-unbuilt-'))
    owned.push(dir)
    const journalPath = path.join(dir, 'run.db')
    const result = await runReplayableProgram({
      ...input,
      journalPath,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('built SDK'),
    })
    expect(existsSync(journalPath)).toBe(false)
  })

  test('rejects missing, later, and nontext inputs before a recipe runs', () => {
    expect(() => validateProgram(input.program, {})).toThrow('unbound')
    expect(() => validateProgram(input.program, { message: '\ud800' })).toThrow(
      /unsupported/i,
    )
    expect(() =>
      validateProgram(
        {
          version: 1,
          operations: [
            { id: 'first', kind: 'STEP', prompt: [{ result: 'first' }] },
          ],
        },
        {},
      ),
    ).toThrow('unbound')
  })
})
