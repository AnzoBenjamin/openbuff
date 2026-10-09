/**
 * Unit tests for runGitBounded — the bounded, deadline-carrying git spawn the
 * snapshot-identity path uses
 * (perf: snapshot-identity-diff-capture-unbounded,
 * identity-git-spawns-no-deadline). The child process is mocked so the
 * deadline and retention-cap behavior are deterministic and hermetic.
 */
import {
  clearMockedModules,
  mockModule,
} from '@codebuff/common/testing/mock-modules'
import { createMockChildProcess } from '@codebuff/common/testing/mocks'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { runGitBounded } from '../tools/get-change-review-bundle'

import type { MockChildProcess } from '@codebuff/common/testing/mocks'

describe('runGitBounded', () => {
  let mockSpawn: ReturnType<typeof mock>
  let mockProcess: MockChildProcess

  beforeEach(async () => {
    mockProcess = createMockChildProcess()
    mockSpawn = mock(() => mockProcess)
    await mockModule('child_process', () => ({
      spawn: mockSpawn,
    }))
  })

  afterEach(() => {
    mock.restore()
    clearMockedModules()
  })

  test('counts every stdout byte while retaining only the cap', async () => {
    const promise = runGitBounded(
      ['diff', '--binary', 'HEAD'],
      '/repo',
      undefined,
      { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    )
    // The mocked git emits 3 MiB total after the listeners are attached.
    const chunk = Buffer.alloc(1024 * 1024, 'a')
    mockProcess.stdout.emit('data', chunk)
    mockProcess.stdout.emit('data', chunk)
    mockProcess.stdout.emit('data', chunk)
    mockProcess.emit('close', 0)
    const result = await promise
    // Only the first 4 KiB are retained (the unbounded runGit shape would
    // have buffered all 3 MiB into the stdout string), but the untruncated
    // byte total is still reported so the identity hash can mix it in.
    expect(result.stdoutTotalBytes).toBe(3 * 1024 * 1024)
    expect(result.stdout).toBe('a'.repeat(4_096))
    expect(result.exitCode).toBe(0)
  })

  test('kills a wedged git at the wall-clock deadline and fails closed', async () => {
    // No close/error event: the mocked git hangs forever, as a wedged git
    // would. runGitBounded must resolve at the deadline instead of hanging.
    const result = await runGitBounded(
      ['diff', '--binary', 'HEAD'],
      '/repo',
      undefined,
      { timeoutMs: 50, maxOutputBytes: 4_096 },
    )
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('timed out')
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('returns immediately without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const result = await runGitBounded(
      ['status'],
      '/repo',
      controller.signal,
      { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    )
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('caller cancelled')
    expect(result.stdoutTotalBytes).toBe(0)
  })
})
