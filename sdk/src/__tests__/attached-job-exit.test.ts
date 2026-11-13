/**
 * N06 (exec-jobs-09, exec-jobs-01): real-process ports of the product-audit
 * probes `verification/probes/runtime/p1-bg.ts` and `p2-stdin.ts`.
 *
 * Each case starts a separate Bun SDK host (fixtures/attached-job-exit-child.ts)
 * that launches a real shell job through createDirectHostExecution and
 * runTerminalCommand, ends that host through one exit path, and then checks the
 * operating system for surviving job processes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const CHILD = path.join(import.meta.dir, 'fixtures', 'attached-job-exit-child.ts')
const posix = process.platform !== 'win32'
let projectDir = ''
const leftovers = new Set<number>()

beforeAll(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-job-exit-')) })
afterAll(() => {
  for (const pid of leftovers) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  fs.rmSync(projectDir, { recursive: true, force: true })
})

type Host = { child: ChildProcess; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> }

function startHost(args: string[]): Host {
  let out = ''
  const started = Date.now()
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', chunk => { out += String(chunk) })
  child.stderr!.on('data', chunk => { out += String(chunk) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - started })))
  return { child, output: () => out, exited }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return predicate()
}

/** True while any member of the job's process group is alive. */
function alive(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch { return false }
}

function resultOf(host: Host): { elapsedMs: number; value: Record<string, unknown> } {
  const line = host.output().split('\n').find(entry => entry.startsWith('RESULT '))
  if (!line) throw new Error(`host printed no result:\n${host.output()}`)
  return JSON.parse(line.slice('RESULT '.length))
}

async function jobPid(host: Host): Promise<number> {
  await until(() => host.output().includes('RESULT '), 15_000)
  const value = resultOf(host).value
  expect(value.backgroundProcessStatus).toBe('running')
  const pid = value.processId as number
  expect(pid).toBeGreaterThan(0)
  leftovers.add(pid)
  return pid
}

const uniqueSleep = () => `sleep ${300 + Math.floor(Math.random() * 600)}.${process.pid}`

describe.skipIf(!posix)('attached BACKGROUND jobs end with their SDK host (p1 probe)', () => {
  it('natural end of the host script exits promptly and stops the job', async () => {
    const host = startHost(['bg', projectDir, uniqueSleep(), 'natural'])
    const pid = await jobPid(host)
    const exit = await Promise.race([host.exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))])
    if (!exit) host.child.kill('SIGKILL')
    expect(exit).not.toBeNull()
    expect(exit!.code).toBe(0)
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)

  it('process.exit(0) stops the job through the synchronous exit hook', async () => {
    const host = startHost(['bg', projectDir, uniqueSleep(), 'exit'])
    const pid = await jobPid(host)
    const exit = await host.exited
    expect(exit.code).toBe(0)
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)

  it('process.exit(0) SIGKILLs a job group that ignores SIGTERM', async () => {
    const host = startHost(['bg', projectDir, `trap '' TERM; ${uniqueSleep()}`, 'exit'])
    const pid = await jobPid(host)
    const exit = await host.exited
    expect(exit.code).toBe(0)
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('%s ends the host promptly and stops the job', async (signal, expectedCode) => {
    const host = startHost(['bg', projectDir, uniqueSleep(), 'wait'])
    const pid = await jobPid(host)
    expect(await until(() => host.output().includes('READY'), 5_000)).toBe(true)
    expect(alive(pid)).toBe(true)
    host.child.kill(signal)
    const exit = await Promise.race([host.exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000))])
    if (!exit) host.child.kill('SIGKILL')
    expect(exit).not.toBeNull()
    expect(exit!.code).toBe(expectedCode)
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)

  it('a host-owned SIGTERM handler keeps control of exit, and the exit hook still stops the job (CLI model)', async () => {
    const host = startHost(['bg', projectDir, uniqueSleep(), 'host-handler'])
    const pid = await jobPid(host)
    expect(await until(() => host.output().includes('READY'), 5_000)).toBe(true)
    host.child.kill('SIGTERM')
    const exit = await host.exited
    expect(host.output()).toContain('HOST_HANDLER')
    expect(exit.code).toBe(7)
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)

  it('a transferred (detach: true) job survives host exit as designed', async () => {
    const host = startHost(['detach', projectDir, uniqueSleep(), 'exit'])
    const pid = await jobPid(host)
    expect(resultOf(host).value.detached).toBe(true)
    const exit = await host.exited
    expect(exit.code).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(true)
    process.kill(-pid, 'SIGKILL')
    expect(await until(() => !alive(pid), 2_000)).toBe(true)
  }, 20_000)
})

describe.skipIf(!posix)('SYNC stdin is closed (p2 probe)', () => {
  it('`read x` with the default timeout gets EOF within 1 s', async () => {
    const host = startHost(['sync', projectDir, 'read x; echo "status=$? got=[$x]"', 'exit'])
    const exit = await Promise.race([host.exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))])
    if (!exit) host.child.kill('SIGKILL')
    expect(exit).not.toBeNull()
    const result = resultOf(host)
    expect(result.elapsedMs).toBeLessThan(1_000)
    expect(result.value.stdout).toContain('status=1 got=[]')
    expect(result.value.timedOut).toBeUndefined()
  }, 20_000)
})
