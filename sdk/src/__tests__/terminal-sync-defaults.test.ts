/**
 * N06 (exec-jobs-01, exec-jobs-18): SYNC defaults with real child processes.
 * Default timeout, closed stdin, idle-output hint, and partial output on cancel.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { createDirectHostExecution } from '../host-execution'
import {
  DEFAULT_SYNC_TIMEOUT_SECONDS,
  resolveTerminalTimeout,
  runTerminalCommand,
} from '../tools/run-terminal-command'

const posix = process.platform !== 'win32'
let projectDir = ''
beforeAll(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-sync-defaults-')) })
afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

type Params = Parameters<typeof runTerminalCommand>[0]
async function runSync(params: Omit<Params, 'cwd' | 'process_type'> & { signal?: AbortSignal }) {
  const host = createDirectHostExecution({ cwd: projectDir, ...(params.signal ? { signal: params.signal } : {}) })
  if (!host.ok) throw new Error(host.cause)
  const started = Date.now()
  const result = await runTerminalCommand({
    ...params,
    process_type: 'SYNC',
    cwd: projectDir,
    executionContext: host.value.executionContext,
    terminalShell: host.value.hostServices.terminalShell,
    getTerminalLaunchMetadata: host.value.hostServices.getTerminalLaunchMetadata,
  })
  return { elapsedMs: Date.now() - started, value: result[0].value as Record<string, any> }
}

describe('resolveTerminalTimeout', () => {
  it('gives an omitted SYNC timeout a 120 s execution-time default and leaves BACKGROUND unbounded', () => {
    expect(DEFAULT_SYNC_TIMEOUT_SECONDS).toBe(120)
    expect(resolveTerminalTimeout(undefined, 'SYNC')).toEqual({ localSeconds: -1, defaultExecutionMs: 120_000 })
    expect(resolveTerminalTimeout(undefined, 'BACKGROUND')).toEqual({ localSeconds: -1 })
  })

  it('keeps explicit values, including -1, unless the host policy caps or forbids them', () => {
    expect(resolveTerminalTimeout(600, 'SYNC')).toEqual({ localSeconds: 600 })
    expect(resolveTerminalTimeout(-1, 'SYNC')).toEqual({ localSeconds: -1 })
    expect(resolveTerminalTimeout(-1, 'SYNC', { allowUnbounded: false })).toEqual({ localSeconds: -1, defaultExecutionMs: 120_000 })
    expect(resolveTerminalTimeout(-1, 'SYNC', { maxSeconds: 900 })).toEqual({ localSeconds: 900 })
    expect(resolveTerminalTimeout(3_600, 'BACKGROUND', { maxSeconds: 900 })).toEqual({ localSeconds: 900 })
    expect(resolveTerminalTimeout(undefined, 'SYNC', { maxSeconds: 30 })).toEqual({ localSeconds: -1, defaultExecutionMs: 30_000 })
    expect(resolveTerminalTimeout(undefined, 'SYNC', { defaultSyncSeconds: 5 })).toEqual({ localSeconds: -1, defaultExecutionMs: 5_000 })
  })
})

describe.skipIf(!posix)('SYNC defaults with real processes', () => {
  it('a prompt reading stdin gets EOF immediately instead of hanging', async () => {
    const { elapsedMs, value } = await runSync({ command: 'read x; echo "status=$? got=[$x]"' })
    expect(elapsedMs).toBeLessThan(1_000)
    expect(value.stdout).toContain('status=1 got=[]')
    expect(value.timedOut).toBeUndefined()
  })

  it('a silent sleep 200 hits the default SYNC timeout (shortened by host policy) and is stopped', async () => {
    const { elapsedMs, value } = await runSync({ command: 'printf started; sleep 200', timeoutPolicy: { defaultSyncSeconds: 0.5 } })
    expect(value.timedOut).toBe(true)
    expect(value.executionRefusal?.reason).toBe('deadline-exhausted')
    expect(value.errorMessage).toContain('default')
    expect(value.errorMessage).toContain('timeout_seconds')
    expect(value.stdout).toContain('started')
    expect(value.processCleanup?.status).toBe('complete')
    expect(elapsedMs).toBeGreaterThanOrEqual(450)
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it('an explicit -1 is not given the default timeout', async () => {
    const { value } = await runSync({ command: 'sleep 0.8; echo done', timeout_seconds: -1, timeoutPolicy: { defaultSyncSeconds: 0.3 } })
    expect(value.timedOut).toBeUndefined()
    expect(value.stdout).toContain('done')
  })

  it('a finite parent deadline still applies when the timeout is omitted', async () => {
    const host = createDirectHostExecution({ cwd: projectDir, limit: { kind: 'finite', durationMs: 400 } })
    if (!host.ok) throw new Error(host.cause)
    const result = await runTerminalCommand({
      command: 'sleep 200', process_type: 'SYNC', cwd: projectDir,
      executionContext: host.value.executionContext,
      terminalShell: host.value.hostServices.terminalShell,
      getTerminalLaunchMetadata: host.value.hostServices.getTerminalLaunchMetadata,
    })
    const value = result[0].value as Record<string, any>
    expect(value.timedOut).toBe(true)
    expect(value.executionRefusal?.reason).toBe('deadline-exhausted')
  })

  it('reports an idle-output hint after silence without killing the command', async () => {
    const hints: number[] = []
    const { value } = await runSync({
      command: 'printf a; sleep 0.6; printf b',
      idleOutputHintMs: 200,
      onIdleOutput: hint => hints.push(hint.idleMs),
    })
    expect(value.stdout).toBe('ab')
    expect(value.exitCode).toBe(0)
    expect(value.timedOut).toBeUndefined()
    expect(hints).toHaveLength(1)
    expect(hints[0]).toBeGreaterThanOrEqual(200)
    expect(value.idleOutputMs).toBeGreaterThanOrEqual(500)
    expect(value.idleOutputHint).toContain('stdin is closed')
  })

  it('omits the idle hint for a command that keeps printing', async () => {
    const { value } = await runSync({ command: 'for i in 1 2 3; do echo $i; sleep 0.05; done', idleOutputHintMs: 500 })
    expect(value.idleOutputHint).toBeUndefined()
    expect(value.idleOutputMs).toBeUndefined()
  })

  it('a cancelled `yes | head -c 1M` keeps its partial output', async () => {
    const controller = new AbortController()
    const pending = runSync({ command: 'yes | head -c 1000000; sleep 30', signal: controller.signal })
    setTimeout(() => controller.abort(new Error('user cancelled')), 700)
    const { elapsedMs, value } = await pending
    expect(elapsedMs).toBeLessThan(5_000)
    expect(value.executionRefusal?.reason).toBe('cancelled')
    expect(value.timedOut).toBeUndefined()
    expect(value.stdout.length).toBeGreaterThan(1_000)
    expect(value.stdout.startsWith('y\ny\n')).toBe(true)
    // The inline result is bounded; the full partial output is persisted.
    expect(typeof value.fullLogPath).toBe('string')
    const full = JSON.parse(fs.readFileSync(value.fullLogPath, 'utf8')) as { stdout?: string }
    expect(full.stdout?.length).toBe(1_000_000)
  }, 15_000)
})
