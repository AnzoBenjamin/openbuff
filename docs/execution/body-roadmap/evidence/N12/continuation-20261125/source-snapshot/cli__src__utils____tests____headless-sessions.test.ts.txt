import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { createHeadlessSessionStore } from '../headless-sessions'
import type { RunState } from '@openbuff/sdk'

let root: string, project: string, configDir: string
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'headless-sessions-')),
  )
  project = path.join(root, 'project')
  configDir = path.join(root, 'config')
  fs.mkdirSync(project)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function state(text: string, count = 1): RunState {
  const sessionState = getInitialSessionState(
    {} as Parameters<typeof getInitialSessionState>[0],
  )
  sessionState.fileContext.cwd = project
  sessionState.fileContext.projectRoot = project
  sessionState.mainAgentState.messageHistory = Array.from(
    { length: count },
    (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: [{ type: 'text' as const, text: `${text}:${index}` }],
    }),
  )
  return {
    sessionState,
    output: { type: 'lastMessage', value: [] },
    runOutcome: { termination: 'completed' },
  }
}
const store = (maxBytes?: number) =>
  createHeadlessSessionStore({ projectRoot: project, configDir, maxBytes })

describe('private headless conversation store', () => {
  test('missing continuation fails without creating a store or a fresh conversation', async () => {
    await expect(store().acquire({ continue: true })).rejects.toThrow(
      /session|continu/i,
    )
    expect(fs.existsSync(configDir)).toBe(false)
  })

  test('a fresh process-equivalent store restores all 500 messages and exact text', async () => {
    const selected = store()
    const lease = await selected.acquire({})
    const original = state('first\n  value', 500)
    await lease.save(original, 'base2')
    await lease.close()
    const restored = await store().acquire({ continue: true })
    try {
      expect(restored.sessionId).toBe(lease.sessionId)
      expect(restored.agentId).toBe('base2')
      expect(
        restored.previousRun?.sessionState?.mainAgentState.messageHistory,
      ).toEqual(original.sessionState!.mainAgentState.messageHistory)
      expect(
        fs.statSync(
          path.join(selected.directory, lease.sessionId, 'state.json'),
        ).mode & 0o777,
      ).toBe(0o600)
      expect(
        fs.statSync(path.join(selected.directory, lease.sessionId)).mode &
          0o777,
      ).toBe(0o700)
    } finally {
      await restored.close()
    }
  })

  test('last means the last committed headless session; an explicit ID selects an earlier session', async () => {
    const first = await store().acquire({})
    await first.save(state('first'), 'reader')
    await first.close()
    const second = await store().acquire({})
    await second.save(state('second'), 'writer')
    await second.close()
    const latest = await store().acquire({ continue: true })
    expect(latest.sessionId).toBe(second.sessionId)
    await latest.close()
    const earlier = await store().acquire({
      continue: true,
      continueId: first.sessionId,
    })
    expect(earlier.agentId).toBe('reader')
    expect(JSON.stringify(earlier.previousRun)).toContain('first:0')
    await earlier.close()
  })

  test('sessions are scoped by canonical project identity', async () => {
    const first = await store().acquire({})
    await first.save(state('private-project'), 'base2')
    await first.close()
    const otherProject = path.join(root, 'other')
    fs.mkdirSync(otherProject)
    const other = createHeadlessSessionStore({
      projectRoot: otherProject,
      configDir,
    })
    await expect(
      other.acquire({ continue: true, continueId: first.sessionId }),
    ).rejects.toThrow()
    expect(fs.existsSync(other.directory)).toBe(false)
  })

  test('the same session cannot be continued concurrently and is usable after release', async () => {
    const first = await store().acquire({})
    await first.save(state('owned'), 'base2')
    const bytes = fs.readFileSync(
      path.join(store().directory, first.sessionId, 'state.json'),
    )
    await expect(
      store().acquire({ continue: true, continueId: first.sessionId }),
    ).rejects.toThrow(/busy|in use|running/i)
    expect(
      fs.readFileSync(
        path.join(store().directory, first.sessionId, 'state.json'),
      ),
    ).toEqual(bytes)
    await first.close()
    const next = await store().acquire({ continue: true })
    await next.close()
    expect(
      fs.existsSync(path.join(store().directory, first.sessionId, '.lock')),
    ).toBe(false)
  })

  test('corrupt selected state is not overwritten or replaced with an older session', async () => {
    const lease = await store().acquire({})
    await lease.save(state('original'), 'base2')
    await lease.close()
    const file = path.join(store().directory, lease.sessionId, 'state.json')
    fs.writeFileSync(file, '{ broken')
    await expect(store().acquire({ continue: true })).rejects.toThrow(
      /corrupt|invalid|unavailable/i,
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
    expect(
      fs.existsSync(path.join(store().directory, lease.sessionId, '.lock')),
    ).toBe(false)
  })

  test('content integrity detects valid JSON with changed retained conversation bytes', async () => {
    const lease = await store().acquire({})
    await lease.save(state('original'), 'base2')
    await lease.close()
    const file = path.join(store().directory, lease.sessionId, 'state.json')
    const altered = fs
      .readFileSync(file, 'utf8')
      .replace('original:0', 'modified:0')
    fs.writeFileSync(file, altered)
    await expect(store().acquire({ continue: true })).rejects.toThrow(
      /integrity|corrupt/i,
    )
    expect(fs.readFileSync(file, 'utf8')).toBe(altered)
  })

  for (const id of [
    '',
    '.',
    '..',
    '../outside',
    '/absolute',
    'a/b',
    'a\\b',
    ' a',
    'a\0b',
    'x'.repeat(129),
  ]) {
    test(`refuses unsafe session ID ${JSON.stringify(id)}`, async () => {
      await expect(
        store().acquire({ continue: true, continueId: id }),
      ).rejects.toThrow()
      expect(fs.existsSync(configDir)).toBe(false)
    })
  }

  test('symlinked session and snapshot files cannot supply outside conversation bytes', async () => {
    const selected = store()
    const lease = await selected.acquire({})
    await lease.save(state('original'), 'base2')
    await lease.close()
    const directory = path.join(selected.directory, lease.sessionId)
    const outside = path.join(root, 'outside')
    fs.renameSync(directory, outside)
    fs.symlinkSync(outside, directory)
    await expect(selected.acquire({ continue: true })).rejects.toThrow()
    fs.unlinkSync(directory)
    fs.renameSync(outside, directory)
    const file = path.join(directory, 'state.json')
    fs.renameSync(file, path.join(root, 'outside-state.json'))
    fs.symlinkSync(path.join(root, 'outside-state.json'), file)
    await expect(selected.acquire({ continue: true })).rejects.toThrow()
    expect(fs.existsSync(path.join(directory, '.lock'))).toBe(false)
  })

  test('hard-linked snapshot aliases are refused', async () => {
    const lease = await store().acquire({})
    await lease.save(state('original'), 'base2')
    await lease.close()
    fs.linkSync(
      path.join(store().directory, lease.sessionId, 'state.json'),
      path.join(root, 'alias.json'),
    )
    await expect(store().acquire({ continue: true })).rejects.toThrow()
  })

  test('failed and cancelled result states retain their outcome and history', async () => {
    for (const termination of ['failed', 'cancelled'] as const) {
      const lease = await store().acquire({})
      const result = {
        ...state(termination),
        output: { type: 'error' as const, message: termination },
        runOutcome: { termination },
      }
      await lease.save(result, 'base2')
      await lease.close()
      const restored = await store().acquire({ continue: true })
      expect(restored.previousRun?.runOutcome?.termination).toBe(termination)
      expect(JSON.stringify(restored.previousRun)).toContain(`${termination}:0`)
      await restored.close()
    }
  })

  test('explicit byte quota refuses a new snapshot without truncating or destroying the prior one', async () => {
    const normal = await store().acquire({})
    await normal.save(state('prior'), 'base2')
    await normal.close()
    const file = path.join(store().directory, normal.sessionId, 'state.json')
    const before = fs.readFileSync(file)
    const limited = await store(before.length + 32).acquire({ continue: true })
    await expect(
      limited.save(state('x'.repeat(20_000)), 'base2'),
    ).rejects.toThrow(/limit|quota|bytes/i)
    await limited.close()
    expect(fs.readFileSync(file)).toEqual(before)
  })

  test('an already aborted acquisition never creates state', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled selection'))
    await expect(
      store().acquire({ signal: controller.signal }),
    ).rejects.toThrow('cancelled selection')
    expect(fs.existsSync(configDir)).toBe(false)
  })

  test('release does not remove a foreign replacement lock', async () => {
    const lease = await store().acquire({})
    const lock = path.join(store().directory, lease.sessionId, '.lock')
    fs.renameSync(lock, lock + '.prior')
    fs.writeFileSync(lock, 'foreign-owner')
    await lease.close()
    expect(fs.readFileSync(lock, 'utf8')).toBe('foreign-owner')
  })
})
