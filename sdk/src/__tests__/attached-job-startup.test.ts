import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const SOURCE = path.join(import.meta.dir, 'fixtures', 'attached-job-startup-child.ts')
const NODE = process.env.BODY_NODE || 'node'
let root = ''
let compiled = ''
const hosts = new Set<ReturnType<typeof spawn>>()
const jobs = new Set<number>()

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-startup-'))
  compiled = path.join(root, 'host.cjs')
  const result = await Bun.build({ entrypoints: [SOURCE], target: 'node', format: 'cjs', outdir: root, naming: 'host.cjs' })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
})

afterAll(() => {
  for (const host of hosts) { try { host.kill('SIGKILL') } catch { /* exited */ } }
  for (const pid of jobs) { try { process.kill(-pid, 'SIGKILL') } catch { /* reaped */ } }
  fs.rmSync(root, { recursive: true, force: true })
})

type Entry = { at: number } & (
  | { event: 'PENDING'; detail: { pid: number; mode: string } }
  | { event: 'START_ERROR' | 'HOST_ERROR'; detail: string }
  | { event: 'REAPED'; detail: { code: number | null; signal: NodeJS.Signals | null } }
  | { event: 'READY' | 'STOP'; detail: null }
)

async function run(mode: 'natural' | 'signal' | 'reject') {
  const child = spawn(NODE, [compiled, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  hosts.add(child)
  let stdout = ''
  let stderr = ''
  let signalled = false
  child.stdout!.on('data', chunk => {
    stdout += String(chunk)
    const pending = stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as Entry).find(entry => entry.event === 'PENDING')
    if (pending) jobs.add(pending.detail.pid)
    if (mode === 'signal' && pending && !signalled) {
      signalled = true
      child.kill('SIGTERM')
    }
  })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const startedAt = Date.now()
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
    // This timer belongs to the outer Bun test, never the Node host fixture.
    const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'SIGKILL', timedOut: true }) }, 5_000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal, timedOut: false }) })
  })
  hosts.delete(child)
  const entries: Entry[] = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  console.log(JSON.stringify({ mode, node: NODE, exit, elapsedMs: Date.now() - startedAt, entries, stderr }))
  return { exit, entries, stderr }
}

function assertReaped(entries: Entry[]) {
  const pid = entries.find(entry => entry.event === 'PENDING')!.detail.pid as number
  expect(entries.some(entry => entry.event === 'REAPED')).toBe(true)
  let alive = false
  try { process.kill(-pid, 0); alive = true } catch { /* no process group */ }
  expect(alive).toBe(false)
  jobs.delete(pid)
}

describe.skipIf(process.platform === 'win32')('attached Node startup owns event-loop references', () => {
  it('awaits delayed fd3 readiness before natural exit stops and reaps the child', async () => {
    const { exit, entries, stderr } = await run('natural')
    expect(exit.timedOut).toBe(false)
    expect(stderr).toBe('')
    expect(exit.code).toBe(0)
    expect(entries.map(entry => entry.event)).toEqual(['PENDING', 'READY', 'STOP', 'REAPED'])
    assertReaped(entries)
  }, 8_000)

  it('SIGTERM during pending startup still stops and reaps the owned child', async () => {
    const { exit, entries } = await run('signal')
    expect(exit.timedOut).toBe(false)
    expect(exit.code).toBe(143)
    expect(entries.some(entry => entry.event === 'READY')).toBe(false)
    expect(entries.some(entry => entry.event === 'STOP')).toBe(true)
    assertReaped(entries)
  }, 8_000)

  it('releases startup references after rejection so natural exit can clean up', async () => {
    const { exit, entries } = await run('reject')
    expect(exit.timedOut).toBe(false)
    expect(exit.code).toBe(2)
    expect(entries.find(entry => entry.event === 'START_ERROR')?.detail).toBe('handshake refused')
    expect(entries.map(entry => entry.event)).toEqual(['PENDING', 'START_ERROR', 'STOP', 'REAPED'])
    assertReaped(entries)
  }, 8_000)
})
