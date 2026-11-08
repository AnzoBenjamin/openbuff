/**
 * Unit tests for runGitBounded — the bounded, deadline-carrying git spawn the
 * snapshot-identity path uses. A real host authority controls admission;
 * injected fake child events are deterministic DI controls.
 */
import { createMockChildProcess } from '@codebuff/common/testing/mocks'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { runGitBounded } from '../tools/get-change-review-bundle'
import { createTerminalExecutionFixture } from './fixtures/b19-terminal-execution'

import type { MockChildProcess } from '@codebuff/common/testing/mocks'
import type { ChildProcess } from 'node:child_process'

describe('runGitBounded', () => {
  let mockSpawn: ReturnType<typeof mock>
  let mockProcess: MockChildProcess
  let respond: ((child: MockChildProcess) => void) | undefined
  let host: ReturnType<typeof createTerminalExecutionFixture>

  beforeEach(() => {
    mockProcess = createMockChildProcess()
    mockProcess.pid = 42_424_001
    respond = undefined
    mockSpawn = mock(() => {
      const child = mockProcess
      const response = respond
      setImmediate(() => { child.emit('spawn'); response?.(child) })
      return child as unknown as ChildProcess
    })
    host = createTerminalExecutionFixture({ projectRoot: '/repo', spawn: mockSpawn })
  })

  afterEach(() => {
    mock.restore()
    host.dispose()
  })

  test('counts every stdout byte while retaining only the cap', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'a')
    respond = child => {
      child.stdout.emit('data', chunk)
      child.stdout.emit('data', chunk)
      child.stdout.emit('data', chunk)
      child.emit('close', 0)
    }
    const result = await runGitBounded(
      ['diff', '--binary', 'HEAD'],
      '/repo',
      undefined,
      { timeoutMs: 1_000, maxOutputBytes: 4_096, executionContext: host.context, branchId: 'fixture.git.diff' },
    )
    // Only the first 4 KiB are retained (the unbounded runGit shape would
    // have buffered all 3 MiB into the stdout string), but the untruncated
    // byte total is still reported so the identity hash can mix it in.
    expect(result.stdoutTotalBytes).toBe(3 * 1024 * 1024)
    expect(result.stdout).toBe('a'.repeat(4_096))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutComplete).toBe(true)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdoutSha256).toBe(
      createHash('sha256')
        .update(chunk)
        .update(chunk)
        .update(chunk)
        .digest('hex'),
    )
  })

  test('equal-length tails beyond retained stdout change its full digest', async () => {
    const prefix = Buffer.alloc(4_096, 'a')
    const run = async (tail: string) => {
      mockProcess = createMockChildProcess()
      mockProcess.pid = 42_424_001
      respond = child => {
        child.stdout.emit('data', prefix)
        child.stdout.emit('data', Buffer.from(tail))
        child.emit('close', 0)
      }
      const pending = runGitBounded(['diff'], '/repo', undefined, {
        timeoutMs: 1_000,
        maxOutputBytes: prefix.length,
        executionContext: host.context,
        branchId: 'fixture.git.tail-digest',
      })
      return await pending
    }
    const first = await run('tail-one')
    const second = await run('tail-two')
    expect(second.stdout).toBe(first.stdout)
    expect(second.stdoutTotalBytes).toBe(first.stdoutTotalBytes)
    expect(second.stdoutSha256).not.toBe(first.stdoutSha256)
  })

  test('kills a wedged git at the wall-clock deadline and fails closed', async () => {
    // No close/error event: the mocked git hangs forever, as a wedged git
    // would. runGitBounded must resolve at the deadline instead of hanging.
    const result = await runGitBounded(
      ['diff', '--binary', 'HEAD'],
      '/repo',
      undefined,
      { timeoutMs: 50, maxOutputBytes: 4_096, executionContext: host.context, branchId: 'fixture.git.deadline' },
    )
    expect(result.exitCode).toBe(-1)
    expect(result.executionRefusal).toMatchObject({ reason: 'deadline-exhausted' })
    expect(result.stdoutComplete).toBe(false)
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(mockProcess.kill).toHaveBeenCalledTimes(1)
    expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM')
  })

  test('returns immediately without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const result = await runGitBounded(['status'], '/repo', controller.signal, {
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
      executionContext: host.context,
      branchId: 'fixture.git.cancelled',
    })
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('caller cancelled')
    expect(result.stdoutTotalBytes).toBe(0)
    expect(result.stdoutComplete).toBe(false)
  })

  test('missing execution context never invokes the injected spawn', async () => {
    const result = await runGitBounded(['status'], '/repo', undefined, {
      timeoutMs: 1_000, maxOutputBytes: 4_096, branchId: 'fixture.git.missing',
    })
    expect(result.executionRefusal).toMatchObject({ reason: 'unavailable' })
    expect(result.stdoutComplete).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  test('a close without a spawn event and valid PID is incomplete', async () => {
    mockSpawn.mockImplementation(() => {
      setImmediate(() => mockProcess.emit('close', 0))
      return mockProcess as unknown as ChildProcess
    })
    const result = await runGitBounded(['diff'], '/repo', undefined, {
      timeoutMs: 1_000, maxOutputBytes: 4_096, executionContext: host.context, branchId: 'fixture.git.no-start',
    })
    expect(result.stdoutComplete).toBe(false)
    expect(result.executionRefusal).toMatchObject({ reason: 'unavailable' })
  })

  test('decodes split UTF-8 once while hashing every raw byte', async () => {
    const bytes = Buffer.from('snowman: ☃, café\n')
    respond = child => {
      for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]))
      child.emit('close', 0)
    }
    const result = await runGitBounded(['diff'], '/repo', undefined, {
      timeoutMs: 1_000, maxOutputBytes: bytes.length, executionContext: host.context, branchId: 'fixture.git.utf8',
    })
    expect(result.stdout).toBe(bytes.toString('utf8'))
    expect(result.stdoutTotalBytes).toBe(bytes.length)
    expect(result.stdoutSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.stdoutComplete).toBe(true)
  })
})
