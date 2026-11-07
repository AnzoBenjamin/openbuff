import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  SidecarHandshakeError,
  SidecarRequestError,
  SidecarSupervisor,
} from '../services/sidecar-supervisor'
import type {
  SidecarSupervisorEvent,
  SidecarSupervisorOptions,
} from '../services/sidecar-supervisor'

// A dependency-free fake sidecar: line-delimited JSON-RPC over stdio. It
// negotiates the protocol version from FAKE_SIDECAR_PROTOCOL_VERSION, echoes
// `ping` -> `pong`, and supports the test-only commands `exit-crash`,
// `exit-clean`, and `hang`. When FAKE_SIDECAR_CRASH_FILE exists it exits
// during `initialize`, which is how tests force repeated restart failures.
const FAKE_SIDECAR_SOURCE = `
import { existsSync } from 'node:fs'
import readline from 'node:readline'

const protocolVersion = process.env.FAKE_SIDECAR_PROTOCOL_VERSION || '1.0.0'
const crashFile = process.env.FAKE_SIDECAR_CRASH_FILE || ''
let hang = false

function respond(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

const reader = readline.createInterface({ input: process.stdin, terminal: false })
reader.on('line', (line) => {
  if (hang) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    if (crashFile && existsSync(crashFile)) {
      process.exit(1)
    }
    respond({ jsonrpc: '2.0', id: message.id, result: { protocolVersion } })
    return
  }
  if (message.method === 'ping') {
    respond({ jsonrpc: '2.0', id: message.id, result: 'pong' })
    return
  }
  if (message.method === 'exit-crash') {
    process.exit(1)
    return
  }
  if (message.method === 'exit-clean') {
    process.exit(0)
    return
  }
  if (message.method === 'hang') {
    hang = true
  }
  if (message.method === 'garbage') {
    // Several MiB of newline-free stdout flood, then a terminating newline
    // and a normal response: exercises the supervisor's bounded stdout
    // reassembly buffer and its resync on the next real line.
    process.stdout.write('x'.repeat(3 * 1024 * 1024) + '\\n')
    respond({ jsonrpc: '2.0', id: message.id, result: 'pong' })
    return
  }
})
`

const tempDirs: string[] = []
const supervisors: SidecarSupervisor[] = []
let fakeDir = ''

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

afterEach(async () => {
  // Kill every leftover child so the suite can never hang CI.
  await Promise.allSettled(supervisors.splice(0).map((child) => child.stop()))
})

async function waitForEvent(
  events: SidecarSupervisorEvent[],
  predicate: (event: SidecarSupervisorEvent) => boolean,
  timeoutMs = 5_000,
): Promise<SidecarSupervisorEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = events.find(predicate)
    if (match) return match
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(
    `Timed out waiting for sidecar event; observed: ${JSON.stringify(events)}`,
  )
}

describe('SidecarSupervisor', () => {
  beforeAll(async () => {
    fakeDir = await mkdtemp(path.join(os.tmpdir(), 'openbuff-sidecar-fake-'))
    tempDirs.push(fakeDir)
    // mode 0o755 keeps the fixture spawnable regardless of how the runtime
    // invokes it (direct exec or `bun <script>`), per the X5-FAIL checklist.
    await writeFile(
      path.join(fakeDir, 'fake-sidecar.mjs'),
      FAKE_SIDECAR_SOURCE,
      { mode: 0o755 },
    )
  })

  function makeSupervisor(
    options: Omit<SidecarSupervisorOptions, 'sidecarPath' | 'args'>,
  ): SidecarSupervisor {
    const supervisor = new SidecarSupervisor({
      ...options,
      sidecarPath: process.execPath,
      args: [path.join(fakeDir, 'fake-sidecar.mjs')],
    })
    supervisors.push(supervisor)
    return supervisor
  }

  test('starts, handshakes, and answers ping with pong', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      onEvent: (event) => events.push(event),
    })

    const started = await supervisor.start()
    expect(started.protocolVersion).toBe('1.0.0')
    expect(typeof started.pid).toBe('number')
    expect(supervisor.state).toBe('running')
    expect(await supervisor.request('ping')).toBe('pong')
    expect(events).toContainEqual({
      kind: 'handshake',
      protocolVersion: '1.0.0',
      attempt: 1,
    })
  })

  test('fails the handshake with SidecarHandshakeError on a version mismatch', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      env: { FAKE_SIDECAR_PROTOCOL_VERSION: '0.0.9' },
      onEvent: (event) => events.push(event),
    })

    const started = supervisor.start()
    await expect(started).rejects.toThrow(SidecarHandshakeError)
    await expect(started).rejects.toThrow(/0\.0\.9/)
    expect(supervisor.state).toBe('stopped')
    expect(events.some((event) => event.kind === 'handshake')).toBe(false)
  })

  test('restarts with backoff after a crash and serves requests again', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      restartBackoffMs: 10,
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()

    let crashFailure: unknown
    try {
      await supervisor.request('exit-crash')
    } catch (error) {
      crashFailure = error
    }
    expect(crashFailure).toBeInstanceOf(SidecarRequestError)
    expect((crashFailure as SidecarRequestError).reason).toBe('child-exited')

    const restartEvent = await waitForEvent(
      events,
      (event) => event.kind === 'restart',
    )
    expect(restartEvent).toMatchObject({ kind: 'restart', attempt: 1, delayMs: 10 })

    await waitForEvent(
      events,
      (event) => event.kind === 'handshake' && event.attempt === 2,
    )
    expect(supervisor.state).toBe('running')
    expect(await supervisor.request('ping')).toBe('pong')
  })

  test('gives up after max restart attempts, rejects pending work, and stops looping', async () => {
    const events: SidecarSupervisorEvent[] = []
    const crashFile = path.join(fakeDir, 'crash-flag-gave-up')
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      restartBackoffMs: 10,
      maxRestartAttempts: 2,
      env: { FAKE_SIDECAR_CRASH_FILE: crashFile },
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()

    // Every restart handshake now crashes immediately: bounded, fast gave-up.
    writeFileSync(crashFile, 'crash')
    let crashFailure: unknown
    try {
      await supervisor.request('exit-crash')
    } catch (error) {
      crashFailure = error
    }
    expect(crashFailure).toBeInstanceOf(SidecarRequestError)
    expect((crashFailure as SidecarRequestError).reason).toBe('child-exited')

    const gaveUp = await waitForEvent(
      events,
      (event) => event.kind === 'gave-up',
    )
    expect(gaveUp).toMatchObject({ kind: 'gave-up', attempts: 2 })
    expect(supervisor.state).toBe('stopped')
    expect(events.filter((event) => event.kind === 'restart')).toHaveLength(2)
    await expect(supervisor.request('ping')).rejects.toThrow(SidecarRequestError)
  })

  test('rejects requests issued while restarting instead of queueing them', async () => {
    const events: SidecarSupervisorEvent[] = []
    const crashFile = path.join(fakeDir, 'crash-flag-restarting')
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      restartBackoffMs: 250,
      maxRestartAttempts: 1,
      env: { FAKE_SIDECAR_CRASH_FILE: crashFile },
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()
    writeFileSync(crashFile, 'crash')

    await expect(supervisor.request('exit-crash')).rejects.toThrow(
      SidecarRequestError,
    )
    // Still inside the restart backoff window: rejected, not queued.
    let restartingFailure: unknown
    try {
      await supervisor.request('ping')
    } catch (error) {
      restartingFailure = error
    }
    expect(restartingFailure).toBeInstanceOf(SidecarRequestError)
    expect((restartingFailure as SidecarRequestError).reason).toBe('restarting')

    await waitForEvent(events, (event) => event.kind === 'gave-up')
    expect(supervisor.state).toBe('stopped')
    expect(events.filter((event) => event.kind === 'restart')).toHaveLength(1)
  })

  test('stop() rejects in-flight requests and reports the stopped event', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()

    const hung = supervisor.request('hang')
    // Attach a no-op handler up front so the rejection that stop() triggers
    // synchronously is never observed as an unhandled rejection before the
    // assertion below awaits it; the assertion itself is unchanged.
    hung.catch(() => undefined)
    await supervisor.stop()
    await expect(hung).rejects.toThrow(SidecarRequestError)
    expect(supervisor.state).toBe('stopped')
    expect(events).toContainEqual({ kind: 'stopped' })
    await expect(supervisor.request('ping')).rejects.toThrow(SidecarRequestError)
  })

  test('caps the stdout reassembly buffer on a newline-free flood and keeps serving', async () => {
    const supervisor = makeSupervisor({ protocolVersion: '1.0.0' })
    await supervisor.start()

    // 3MiB of newline-free garbage is several times the 1MiB reassembly cap:
    // the bounded buffer must discard the overflow (drop counter >= 1)
    // instead of accumulating it without bound, resync on the terminating
    // newline, and keep serving newline-delimited messages.
    expect(await supervisor.request('garbage')).toBe('pong')
    expect(supervisor.stdoutBufferDrops).toBeGreaterThanOrEqual(1)
    expect(await supervisor.request('ping')).toBe('pong')
    expect(supervisor.state).toBe('running')
  })
})
