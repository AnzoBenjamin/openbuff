import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getProjectRoot, setProjectRoot } from '../../project-files'
import { parseCliArgs } from '../../cli-args'
import { runLocalCommandOperation } from '../local-operation'
import {
  listPlanSessionsAsync,
  readBoundedArtifact,
  readPlanArtifactPage,
  MAX_ARTIFACT_BYTES,
} from '../plan-artifacts'
import { parsePlanTimelineArgs } from '../plan-timeline'
import { buildUpdateStatus, compareUpdateVersions } from '../update-command'
import { memoryRecoveryGuidance } from '../memory-command'
import type { RouterParams } from '../command-registry'
import type { ChatMessage } from '../../types/chat'

describe('secondary command contracts', () => {
  test('structured memory failures give distinct safe recovery actions', () => {
    expect(memoryRecoveryGuidance('unavailable')).toContain(
      'check local storage access',
    )
    expect(memoryRecoveryGuidance(undefined, 'integrity-mismatch')).toContain(
      'preserve the canonical source',
    )
    expect(memoryRecoveryGuidance('invalid-path')).toContain(
      'contained project-relative path',
    )
    expect(memoryRecoveryGuidance(undefined, 'busy')).toContain(
      'wait for the current memory operation',
    )
  })
  test('deferred local operation exposes pending state and preserves later draft', async () => {
    let messages: ChatMessage[] = []
    let input = '/index rebuild'
    let resolve!: (value: string) => void
    const operation = new Promise<string>((done) => {
      resolve = done
    })
    const params = {
      saveToHistory: () => {},
      setInputValue: (value: { text: string }) => {
        input = value.text
      },
      setMessages: (update: (prior: ChatMessage[]) => ChatMessage[]) => {
        messages = update(messages)
      },
    } as unknown as RouterParams
    const pending = runLocalCommandOperation(
      params,
      input,
      'Index',
      () => operation,
    )
    expect(input).toBe('')
    expect(messages[1]?.content).toContain('running local operation')
    const operationId = messages[1]!.id
    input = 'new draft while rebuilding'
    resolve('Index ready')
    await pending
    expect(input).toBe('new draft while rebuilding')
    expect(messages).toHaveLength(2)
    expect(messages[1]?.id).toBe(operationId)
    expect(messages[1]?.content).toBe('Index ready')
  })
  test('overflowing numeric args fail before startup and timer boundary is accepted', () => {
    const parse = (args: string[]) =>
      parseCliArgs(['node', 'openbuff', ...args], {
        version: 'test',
        exitOverride: true,
      })
    for (const args of [
      ['run', '--timeout', '9'.repeat(400), 'hello'],
      ['run', '--timeout', '2147484', 'hello'],
      ['replay', 'run', '--from-step', '9'.repeat(400)],
      ['replay', 'run', '--to-step', '9'.repeat(400)],
    ])
      expect(() => parse(args)).toThrow()
    expect(parse(['run', '--timeout', '2147483', 'hello']).run?.timeout).toBe(
      2147483,
    )
    expect(
      parse(['replay', 'run', '--from-step', String(Number.MAX_SAFE_INTEGER)])
        .replay?.fromStep,
    ).toBe(Number.MAX_SAFE_INTEGER)
  })
  test('invalid timeline filters do not silently broaden the selected scope', () => {
    expect(parsePlanTimelineArgs('plan --kind invalid')).toBeNull()
    expect(parsePlanTimelineArgs('plan --kind')).toBeNull()
    expect(parsePlanTimelineArgs('plan --typo x')).toBeNull()
    expect(parsePlanTimelineArgs('plan --kind task_update')).toEqual({
      slug: 'plan',
      kind: 'task_update',
    })
  })
  test('unknown update freshness never implies current registry status', () => {
    const deps = {
      env: {},
      homeDir: '/fixture',
      existsSync: () => false,
      cliVersion: '1.0.0',
    }
    const unknown = buildUpdateStatus(deps).lines.join('\n')
    expect(buildUpdateStatus(deps).status).toBe('unavailable')
    expect(unknown).toContain('Registry freshness unknown')
    expect(unknown).not.toContain('up to date')
    const known = buildUpdateStatus({
      ...deps,
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          version: '1.0.0',
          updateCheck: {
            checkedAt: '2026-11-03T10:00:00Z',
            latestVersion: '1.0.0',
            source: 'npm registry',
            lastFailureAt: '2026-11-03T11:00:00Z',
          },
        }),
    }).lines.join('\n')
    expect(known).toContain(
      'Last successful npm registry check: 2026-11-03T10:00:00Z',
    )
    expect(known).toContain('A newer check failed')
    expect(compareUpdateVersions('1.0.0-alpha-1', '1.0.0-alpha-2')).toBe(-1)
  })
  test('500 legacy plan summaries yield to the event loop and cap selected artifact reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openbuff-plan-summary-'))
    const oldRoot = (() => {
      try {
        return getProjectRoot()
      } catch {
        return process.cwd()
      }
    })()
    let ticks = 0
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const sessions = path.join(root, '.agents', 'sessions')
      for (let start = 0; start < 500; start += 25)
        await Promise.all(
          Array.from({ length: 25 }, async (_, index) => {
            const dir = path.join(sessions, `session-${start + index}`)
            await mkdir(dir, { recursive: true })
            await writeFile(
              path.join(dir, 'PLAN.md'),
              '- [x] A completed task\n',
            )
          }),
        )
      const artifact = path.join(sessions, 'session-0', 'PLAN.md')
      await writeFile(path.join(sessions, 'session-1', 'STATE.json'), '{}')
      await writeFile(
        path.join(sessions, 'session-2', 'STATE.json'),
        JSON.stringify({ status: 'completed', updatedAt: 'not-a-time' }),
      )
      await writeFile(
        artifact,
        '- [x] Visible task\n' + 'x'.repeat(MAX_ARTIFACT_BYTES * 32),
      )
      setProjectRoot(root)
      timer = setInterval(() => {
        ticks++
      }, 1)
      const listed = await listPlanSessionsAsync()
      expect(listed).toHaveLength(500)
      expect(ticks).toBeGreaterThan(0)
      expect(
        listed.every(
          (session) =>
            session.status === 'unknown' && session.updatedAt === null,
        ),
      ).toBe(true)
      expect(
        listed.find((session) => session.slug === 'session-0')?.progressPartial,
      ).toBe(true)
      const selected = await readBoundedArtifact(artifact)
      expect(selected.bytesRead).toBe(MAX_ARTIFACT_BYTES)
      expect(selected.text.length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES)
      expect(selected.truncated).toBe(true)
      const secondPage = await readPlanArtifactPage('session-0', 'PLAN.md', 2)
      expect(secondPage).toContain('Page 2/33')
      expect(secondPage).toContain('Current local artifact')
      expect(secondPage).toContain('captured bytes 65536')
    } finally {
      if (timer) clearInterval(timer)
      setProjectRoot(oldRoot)
      await rm(root, { recursive: true, force: true })
    }
  })
})
