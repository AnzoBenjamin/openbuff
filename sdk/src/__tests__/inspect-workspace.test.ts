import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { inspectWorkspace } from '../tools/inspect-workspace'
import { NotGitRepositoryError, resolveWorkspaceIdentity } from '../services/repository-identity'
import { ExecutionRefusalError, executionRefusal } from '../services/execution-launch'


import {
  createControlledExecutionClock,
  createExecutionProcessRecorder,
  createTerminalExecutionFixture,
} from './fixtures/b19-terminal-execution'
import type { ChildProcess } from 'node:child_process'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

const executionHosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
const capturedChildEnvironment: Record<string, string | undefined> = { PATH: '/usr/bin:/bin' }
afterEach(() => { for (const host of executionHosts.splice(0)) host.dispose() })
function capturedExecution(cwd: string, signal?: AbortSignal) {
  const host = createTerminalExecutionFixture({ projectRoot: cwd, signal, environment: capturedChildEnvironment })
  executionHosts.push(host)
  return host.context
}

function inspectMediatedWorkspace(params: Parameters<typeof inspectWorkspace>[0]) {
  return inspectWorkspace({ ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal) })
}

describe('inspectWorkspace', () => {
  test('reports the current repository and worktree without mutation', async () => {
    const result = await inspectMediatedWorkspace({ cwd: process.cwd() })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).toBeDefined()
    expect(value).not.toHaveProperty('errorMessage')
    expect(value).toMatchObject({
      workingDirectory: process.cwd(),
    })
    expect(typeof (value as { repositoryRoot?: unknown }).repositoryRoot).toBe(
      'string',
    )
    expect(typeof (value as { headCommit?: unknown }).headCommit).toBe('string')
    expect(typeof (value as { dirty?: unknown }).dirty).toBe('boolean')
    expect(typeof (value as { repositoryId?: unknown }).repositoryId).toBe(
      'string',
    )
    expect(typeof (value as { workspaceId?: unknown }).workspaceId).toBe(
      'string',
    )
  })

  test('shares repository identity across linked worktrees while keeping workspace identity distinct', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-worktree-'))
    const linked = `${root}-linked`
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    try {
      expect(git('init').status).toBe(0)
      expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
      expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
      fs.writeFileSync(path.join(root, 'file.txt'), 'one\n')
      expect(git('add', '.').status).toBe(0)
      expect(git('commit', '-m', 'initial').status).toBe(0)
      expect(git('worktree', 'add', linked, '-b', 'linked-test').status).toBe(0)
      const main = (await inspectMediatedWorkspace({ cwd: root }))[0]!
      const worktree = (await inspectMediatedWorkspace({ cwd: linked }))[0]!
      const mainValue = main.type === 'json' ? main.value : undefined
      const linkedValue = worktree.type === 'json' ? worktree.value : undefined
      expect(mainValue).toBeDefined()
      expect(linkedValue).toBeDefined()
      if (!mainValue || !linkedValue)
        throw new Error('Missing workspace result')
      const mainIdentity = mainValue as unknown as {
        repositoryId: string
        workspaceId: string
      }
      const linkedIdentity = linkedValue as unknown as {
        repositoryId: string
        workspaceId: string
      }
      expect(mainIdentity.repositoryId).toBe(linkedIdentity.repositoryId)
      expect(mainIdentity.workspaceId).not.toBe(linkedIdentity.workspaceId)
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: root })
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(linked, { recursive: true, force: true })
    }
  })
})

describe('B19 repository identity failure provenance', () => {
  function host(options: Parameters<typeof createTerminalExecutionFixture>[0]) {
    const captured = createTerminalExecutionFixture(options)
    executionHosts.push(captured)
    return captured
  }

  async function waitForCalls(processes: ReturnType<typeof createExecutionProcessRecorder>, count: number) {
    for (let turn = 0; processes.calls.length < count && turn < 50; turn++) await new Promise(resolve => setImmediate(resolve))
    expect(processes.calls).toHaveLength(count)
  }

  for (const timeoutMs of [undefined, 1_000]) {
    const route = timeoutMs === undefined ? 'legacy' : 'bounded'
    test(`${route} real Git not-repository observation supplies the typed fallback condition`, async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-identity-nongit-'))
      try {
        const captured = host({ projectRoot: cwd })
        await expect(resolveWorkspaceIdentity({ cwd, timeoutMs, executionContext: captured.context })).rejects.toBeInstanceOf(NotGitRepositoryError)
        const observations = captured.events.filter(event => event.phase === 'spawn-observed')
        expect(observations).toHaveLength(2)
        expect(observations.map(event => event.facts.branchId).sort()).toEqual([`identity.${route}.common-dir`, `identity.${route}.root`])
      } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
    })

    test.each(['missing', 'denied', 'expired'] as const)(`${route} %s observation never becomes a non-Git fallback`, async kind => {
      const manual = createControlledExecutionClock()
      const processes = createExecutionProcessRecorder()
      const captured = host({
        ...manual, projectRoot: '/repo', spawn: processes.spawn,
        actionLimit: { kind: 'finite', durationMs: 50 },
        ...(kind === 'denied' ? { authorize: () => executionRefusal('denied', 'identity denied') } : {}),
      })
      if (kind === 'expired') manual.advance(50)
      const result = await resolveWorkspaceIdentity({
        cwd: '/repo', timeoutMs, executionContext: kind === 'missing' ? undefined : captured.context,
      }).catch(error => error)
      expect(result).toBeInstanceOf(ExecutionRefusalError)
      expect(result).not.toBeInstanceOf(NotGitRepositoryError)
      expect(result.refusal.reason).toBe(kind === 'missing' ? 'unavailable' : kind === 'expired' ? 'deadline-exhausted' : 'denied')
      expect(processes.calls).toHaveLength(0)
    })

    test(`${route} mixed Git failures retain their failure instead of a fallback tag`, async () => {
      const processes = createExecutionProcessRecorder({ reply: (_executable, argv) => ({
        exitCode: 128,
        stderr: argv[1] === '--show-toplevel'
          ? 'fatal: not a git repository (or any of the parent directories): .git\n'
          : 'fatal: cannot access repository: Permission denied\n',
      }) })
      const captured = host({ projectRoot: '/repo', spawn: processes.spawn })
      const result = await resolveWorkspaceIdentity({ cwd: '/repo', timeoutMs, executionContext: captured.context }).catch(error => error)
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(NotGitRepositoryError)
      expect(result).not.toBeInstanceOf(ExecutionRefusalError)
    })

    test(`${route} in-flight deadline overrides partial not-repository text`, async () => {
      const manual = createControlledExecutionClock()
      const processes = createExecutionProcessRecorder({ autoClose: false })
      const captured = host({
        ...manual, projectRoot: '/repo', spawn: processes.spawn,
        actionLimit: { kind: 'finite', durationMs: 50 },
      })
      const pending = resolveWorkspaceIdentity({ cwd: '/repo', timeoutMs, executionContext: captured.context }).catch(error => error)
      await waitForCalls(processes, 2)
      for (const actual of processes.calls) actual.child.stderr?.emit('data', Buffer.from('fatal: not a git repository\n'))
      manual.advance(50)
      const result = await pending
      expect(result).toBeInstanceOf(ExecutionRefusalError)
      expect(result).not.toBeInstanceOf(NotGitRepositoryError)
      expect(result.refusal.reason).toBe('deadline-exhausted')
      for (const actual of processes.calls) expect(actual.signals).toEqual(['SIGKILL'])
    })

    test(`${route} empty successful identity responses stay unavailable evidence`, async () => {
      const processes = createExecutionProcessRecorder()
      const captured = host({ projectRoot: '/repo', spawn: processes.spawn })
      const result = await resolveWorkspaceIdentity({ cwd: '/repo', timeoutMs, executionContext: captured.context }).catch(error => error)
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(NotGitRepositoryError)
      expect(result.message).toContain('response is empty')
    })

    test(`${route} not-repository stderr without a spawn observation supplies no fallback`, async () => {
      const spawn: CodebuffSpawn = () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
        }) as unknown as ChildProcess
        queueMicrotask(() => {
          child.stderr?.emit('data', Buffer.from('fatal: not a git repository\n'))
          child.emit('close', 128)
        })
        return child
      }
      const captured = host({ projectRoot: '/repo', spawn })
      const result = await resolveWorkspaceIdentity({ cwd: '/repo', timeoutMs, executionContext: captured.context }).catch(error => error)
      expect(result).toBeInstanceOf(ExecutionRefusalError)
      expect(result).not.toBeInstanceOf(NotGitRepositoryError)
      expect(captured.events.some(event => event.phase === 'spawn-observed')).toBe(false)
    })
  }

  test('identity path and context are captured before awaiting Git responses', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const captured = host({ projectRoot: '/repo', spawn: processes.spawn })
    const input: Parameters<typeof resolveWorkspaceIdentity>[0] = { cwd: '/repo', executionContext: captured.context }
    const pending = resolveWorkspaceIdentity(input)
    await waitForCalls(processes, 2)
    input.cwd = '/late-root'
    input.executionContext = undefined
    for (const actual of processes.calls) {
      actual.child.stdout?.emit('data', Buffer.from(actual.argv[1] === '--show-toplevel' ? '/repo\n' : '.git\n'))
      actual.finish()
    }
    expect(await pending).toMatchObject({ repositoryRoot: '/repo', gitCommonDir: '/repo/.git' })
  })

  test('workspace observation retains the original context through its later identity queries', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const captured = host({ projectRoot: '/repo', spawn: processes.spawn })
    const input: Parameters<typeof inspectWorkspace>[0] = { cwd: '/repo', executionContext: captured.context }
    const pending = inspectWorkspace(input)
    await waitForCalls(processes, 5)
    input.cwd = '/late-root'
    input.executionContext = undefined
    for (const actual of processes.calls.slice(0, 5)) {
      const query = actual.argv[0] === '--no-pager' ? actual.argv.slice(5) : actual.argv
      const text = query[0] === 'status' ? '## main\n'
        : query[1] === 'HEAD' ? `${'a'.repeat(40)}\n` : 'main\n'
      actual.child.stdout?.emit('data', Buffer.from(text))
      actual.finish()
    }
    await waitForCalls(processes, 7)
    for (const actual of processes.calls.slice(5)) {
      actual.child.stdout?.emit('data', Buffer.from(actual.argv[1] === '--show-toplevel' ? '/repo\n' : '.git\n'))
      actual.finish()
    }
    expect((await pending)[0].value).toMatchObject({ repositoryRoot: '/repo', workingDirectory: '/repo' })
    for (const actual of processes.calls) expect(actual.options.cwd).toBe('/repo')
  })
})
