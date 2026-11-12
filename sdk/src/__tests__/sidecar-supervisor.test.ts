import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { createNodeProcessScope } from '@codebuff/common/util/node-process-scope'
import {
  parseProcStat,
  readLinuxProcessIdentity,
} from '@codebuff/common/util/linux-process-scope'
import type { ChildProcess, spawn } from 'node:child_process'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'

import {
  SidecarHandshakeError,
  SidecarRequestError,
  SidecarSupervisor,
} from '../services/sidecar-supervisor'
import type {
  SidecarSupervisorEvent,
  SidecarSupervisorOptions,
} from '../services/sidecar-supervisor'

const nodeExecutable = Bun.which('node')
if (!nodeExecutable)
  throw new Error('The real sidecar fixture requires Node on PATH')
const descendantFixture = new URL(
  './fixtures/b20-sidecar-descendants.mjs',
  import.meta.url,
).pathname

function injectedChild(autoHandshake = true, ignoreKills = false) {
  const messages: Array<{ id: number; method: string }> = []
  const kills: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    stdout,
    stderr,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk))
        messages.push(message)
        callback()
        if (message.method === 'initialize' && autoHandshake) {
          queueMicrotask(() =>
            stdout.write(
              `${JSON.stringify({ id: message.id, result: { protocolVersion: '1.0.0' } })}\n`,
            ),
          )
        }
      },
    }),
    kill(signal: string) {
      kills.push(signal)
      if (!ignoreKills) die()
      return !ignoreKills
    },
  })
  const die = () => {
    if (child.exitCode !== null) return
    child.exitCode = 0
    child.stdin.end()
    stdout.end()
    stderr.end()
    child.emit('exit', 0, null)
    setImmediate(() => child.emit('close', 0, null))
  }
  return {
    child: child as unknown as ChildProcess,
    stdout,
    stderr,
    messages,
    kills,
    die,
    reply(id: number, result: unknown) {
      stdout.write(`${JSON.stringify({ id, result })}\n`)
    },
    lateReply(id: number, result: unknown) {
      stdout.emit('data', Buffer.from(`${JSON.stringify({ id, result })}\n`))
    },
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const until = performance.now() + timeoutMs
  while (!predicate() && performance.now() < until) await Bun.sleep(5)
  if (!predicate())
    throw new Error('Timed out waiting for supervised fixture observation')
}

function living(pid: number): boolean {
  try {
    return !['Z', 'X', 'x'].includes(
      parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).state,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function retainReceipt(name: string, receipt: unknown): void {
  const directory = process.env.B20_SUPERVISION_EVIDENCE_DIR
  if (directory)
    writeFileSync(
      path.join(directory, `${name}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
}

// A dependency-free fake sidecar: line-delimited JSON-RPC over stdio. It
// negotiates the protocol version from FAKE_SIDECAR_PROTOCOL_VERSION, echoes
// `ping` -> `pong`, and supports the test-only commands `exit-crash`,
// `exit-clean`, and `hang`. When FAKE_SIDECAR_CRASH_FILE exists it exits
// during `initialize`, which is how tests force repeated restart failures.
const FAKE_SIDECAR_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'

const protocolVersion = process.env.FAKE_SIDECAR_PROTOCOL_VERSION || '1.0.0'
const crashFile = process.env.FAKE_SIDECAR_CRASH_FILE || ''
// Keep the process alive while a deliberately hung request is under test.
setInterval(() => {}, 1000)
if (process.env.FAKE_SIDECAR_SLOW_STOP) {
  process.on('SIGTERM', () => writeFileSync(process.env.FAKE_SIDECAR_SLOW_STOP, String(process.pid)))
  setInterval(() => {}, 1000)
}
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
      sidecarPath: nodeExecutable!,
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
    await supervisor.stop()
    expect(supervisor.cleanup?.status).toBe('complete')
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
    expect(restartEvent).toMatchObject({
      kind: 'restart',
      attempt: 1,
      delayMs: 10,
    })

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
    await expect(supervisor.request('ping')).rejects.toThrow(
      SidecarRequestError,
    )
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
    await expect(supervisor.request('ping')).rejects.toThrow(
      SidecarRequestError,
    )
  })

  test('each start and stop controls the current child', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      onEvent: (event) => events.push(event),
    })
    for (let cycle = 0; cycle < 3; cycle++) {
      const started = await supervisor.start()
      expect(await supervisor.request('ping')).toBe('pong')
      await Promise.all([supervisor.stop(), supervisor.stop()])
      expect(supervisor.state).toBe('stopped')
      expect(() => process.kill(started.pid!, 0)).toThrow()
    }
    expect(events.filter((event) => event.kind === 'stopped')).toHaveLength(3)
  })

  test('a stopped restart loop cannot take over a later generation', async () => {
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      restartBackoffMs: 100,
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()
    await expect(supervisor.request('exit-crash')).rejects.toThrow()
    await waitForEvent(events, (event) => event.kind === 'restart')
    await supervisor.stop()
    const current = await supervisor.start()
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    expect(supervisor.state).toBe('running')
    expect(await supervisor.request('ping')).toBe('pong')
    await supervisor.stop()
    expect(() => process.kill(current.pid!, 0)).toThrow()
    expect(events.filter((event) => event.kind === 'handshake')).toHaveLength(2)
  })

  test('stopping during startup prevents that startup from becoming running', async () => {
    const supervisor = makeSupervisor({ protocolVersion: '1.0.0' })
    const starting = supervisor.start()
    starting.catch(() => undefined)
    await supervisor.stop()
    await expect(starting).rejects.toThrow()
    const next = await supervisor.start()
    expect(await supervisor.request('ping')).toBe('pong')
    await supervisor.stop()
    expect(() => process.kill(next.pid!, 0)).toThrow()
  })

  test.skipIf(process.platform === 'win32')(
    'stop joins an already failing startup cleanup',
    async () => {
      const termFile = path.join(fakeDir, 'failed-start-term')
      const supervisor = makeSupervisor({
        protocolVersion: '1.0.0',
        env: {
          FAKE_SIDECAR_PROTOCOL_VERSION: '0.0.9',
          FAKE_SIDECAR_SLOW_STOP: termFile,
        },
      })
      const starting = supervisor.start()
      starting.catch(() => undefined)
      const deadline = Date.now() + 2_000
      while (!existsSync(termFile) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      expect(existsSync(termFile)).toBe(true)
      const pid = Number(await Bun.file(termFile).text())
      const stopping = supervisor.stop()
      await expect(supervisor.start()).rejects.toThrow(
        /start\(\) cannot be called/,
      )
      await stopping
      expect(() => process.kill(pid, 0)).toThrow()
      await expect(starting).rejects.toThrow(SidecarHandshakeError)
      expect(supervisor.state).toBe('stopped')
    },
  )

  test('unconfirmed cleanup remains stopping and blocks another start', async () => {
    const fixture = injectedChild(true, true)
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      spawn: (() => fixture.child) as typeof spawn,
      createProcessScope: (child, options) =>
        createNodeProcessScope(child, { ...options, detached: false }),
      cleanupPolicy: { termGraceMs: 10, killGraceMs: 10, observationMs: 30 },
    })
    await supervisor.start()
    await expect(supervisor.stop()).rejects.toThrow(
      /could not confirm process exit/,
    )
    expect(supervisor.state).toBe('stopping')
    expect(supervisor.cleanup?.cleanupAuthorityRetained).toBe(true)
    await expect(supervisor.start()).rejects.toThrow(
      /start\(\) cannot be called/,
    )
    fixture.die()
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
  }, 5_000)

  test('stop while idle leaves an immediate first start available', async () => {
    const supervisor = makeSupervisor({ protocolVersion: '1.0.0' })
    const idle = supervisor.stop()
    const started = supervisor.start()
    await idle
    await started
    expect(await supervisor.request('ping')).toBe('pong')
    await supervisor.stop()
    expect(supervisor.cleanup?.status).toBe('complete')
  })

  test('an incomplete stdout close cannot credit complete output or lose raw drop counters', async () => {
    const fixture = injectedChild()
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      spawn: (() => fixture.child) as typeof spawn,
      createProcessScope: (child, options) =>
        createNodeProcessScope(child, { ...options, detached: false }),
    })
    await supervisor.start()
    const partial = Buffer.from('{"partial":')
    const stderr = Buffer.from('€'.repeat(5_000))
    fixture.stdout.write(partial)
    fixture.stderr.write(stderr)
    const closed = new Promise<void>((resolve) =>
      fixture.child.stdout!.once('close', resolve),
    )
    fixture.child.stdout!.destroy()
    await closed
    await supervisor.stop()
    const cleanup = supervisor.cleanup!
    expect(cleanup.status).toBe('complete')
    expect(cleanup.finalObservation.streams.stdout).toBe('closed-incomplete')
    expect(cleanup.output.complete).toBe(false)
    expect(cleanup.output.stdoutSeenBytes).toBeGreaterThan(partial.length)
    expect(cleanup.output.stderrSeenBytes).toBe(stderr.length)
    expect(cleanup.output.retainedBytes).toBe(partial.length + 4_096)
    expect(cleanup.output.droppedBytes).toBe(
      cleanup.output.stdoutSeenBytes +
        cleanup.output.stderrSeenBytes -
        cleanup.output.retainedBytes,
    )
    retainReceipt('sidecar-incomplete-output', {
      cleanup,
      source: 'injected-node-child',
      realProcessEvidence: false,
      oraclePass: true,
    })
  })

  test('adapter error during startup TERM forwards force before joining cleanup', async () => {
    const fixture = injectedChild(false, true)
    Object.assign(fixture.child, { pid: 2_147_483_646 })
    fixture.child.kill = (signal) => {
      fixture.kills.push(String(signal))
      if (signal === 'SIGKILL') fixture.die()
      return true
    }
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      spawn: (() => fixture.child) as typeof spawn,
      createProcessScope: (child, options) =>
        createNodeProcessScope(child, { ...options, detached: false }),
      cleanupPolicy: { termGraceMs: 500, killGraceMs: 20, observationMs: 50 },
    })
    const starting = supervisor.start()
    starting.catch(() => undefined)
    fixture.reply(1, { protocolVersion: '0.0.9' })
    await waitUntil(() => fixture.kills.includes('SIGTERM'))
    const forceAtMs = performance.now()
    fixture.child.emit('error', new Error('adapter failed during TERM cleanup'))
    const killSentSynchronously = fixture.kills.includes('SIGKILL')
    expect(killSentSynchronously).toBe(true)
    await expect(starting).rejects.toThrow(SidecarHandshakeError)
    const cleanup = supervisor.cleanup!
    expect(cleanup.status).toBe('complete')
    expect(cleanup.signals.map((signal) => signal.signal)).toEqual([
      'SIGTERM',
      'SIGKILL',
    ])
    expect(cleanup.killAtMs - cleanup.firstStopAtMs).toBeCloseTo(500, 6)
    expect(
      cleanup.signals.find((signal) => signal.signal === 'SIGKILL')!.atMs,
    ).toBeLessThan(cleanup.killAtMs)
    expect(supervisor.state).toBe('stopped')
    retainReceipt('sidecar-forced-startup-cleanup', {
      cleanup,
      forceAtMs,
      killSentSynchronously,
      source: 'injected-node-child',
      realProcessEvidence: false,
      oraclePass: true,
    })
  })

  test('old frames and exit/error events cannot resolve a new handshake with the reused id', async () => {
    const first = injectedChild()
    const second = injectedChild(false)
    const children = [first, second]
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      spawn: (() => children.shift()!.child) as typeof spawn,
      createProcessScope: (child, options) =>
        createNodeProcessScope(child, { ...options, detached: false }),
    })
    await supervisor.start()
    const pending = supervisor.request('hang')
    pending.catch(() => undefined)
    await supervisor.stop()
    await expect(pending).rejects.toThrow(/stopped/)
    const starting = supervisor.start()
    starting.catch(() => undefined)
    let settled = false
    void starting.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    first.lateReply(1, { protocolVersion: '0.0.9' })
    first.child.emit('exit', 1, null)
    first.child.emit('error', new Error('late predecessor error'))
    await Bun.sleep(10)
    expect(settled).toBe(false)
    expect(supervisor.state).toBe('starting')
    second.reply(1, { protocolVersion: '1.0.0' })
    expect((await starting).protocolVersion).toBe('1.0.0')
    const request = supervisor.request('held')
    first.lateReply(2, 'stale result')
    second.reply(2, 'current result')
    expect(await request).toBe('current result')
    await supervisor.stop()
  })

  test('stop during a restart handshake rejects it before the next generation starts', async () => {
    const first = injectedChild()
    const second = injectedChild(false)
    const third = injectedChild()
    const children = [first, second, third]
    const events: SidecarSupervisorEvent[] = []
    const supervisor = makeSupervisor({
      protocolVersion: '1.0.0',
      restartBackoffMs: 5,
      spawn: (() => children.shift()!.child) as typeof spawn,
      createProcessScope: (child, options) =>
        createNodeProcessScope(child, { ...options, detached: false }),
      onEvent: (event) => events.push(event),
    })
    await supervisor.start()
    first.die()
    await waitUntil(() =>
      second.messages.some((message) => message.method === 'initialize'),
    )
    await supervisor.stop()
    await supervisor.start()
    second.lateReply(1, { protocolVersion: '0.0.9' })
    second.child.emit('exit', 1, null)
    await Bun.sleep(20)
    expect(supervisor.state).toBe('running')
    expect(events.filter((event) => event.kind === 'handshake')).toHaveLength(2)
    await supervisor.stop()
  })

  test.skipIf(process.platform !== 'linux')(
    'stop retains escalation after leader close with a redirected TERM-resistant writer',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'b20-sidecar-group-'),
      )
      tempDirs.push(directory)
      const supervisor = new SidecarSupervisor({
        sidecarPath: nodeExecutable!,
        args: [descendantFixture, 'ready', directory],
        protocolVersion: '1.0.0',
      })
      supervisors.push(supervisor)
      const receipt: Record<string, unknown> = {
        branch: 'generic-sidecar',
        tier: 'posix-owned-group',
        trigger: 'owner-shutdown',
      }
      let writerPid: number | undefined
      try {
        const started = await supervisor.start()
        writerPid = Number(
          readFileSync(path.join(directory, 'writer.pid'), 'utf8'),
        )
        const initial = readLinuxProcessIdentity(writerPid)
        receipt.initial = {
          leader: started.pid,
          writer: initial,
          living: living(writerPid),
        }
        expect(initial.pgid).toBe(started.pid!)
        expect(initial.sid).toBe(started.pid!)
        expect(living(writerPid)).toBe(true)
        const pending = supervisor.request('hang')
        pending.catch(() => undefined)
        const stopAtMs = performance.now()
        const stopping = supervisor.stop()
        let cleanupDone = false
        void stopping.then(
          () => {
            cleanupDone = true
          },
          () => {
            cleanupDone = true
          },
        )
        await expect(pending).rejects.toThrow(/stopped/)
        receipt.pendingRejectedBeforeCleanup = !cleanupDone
        expect(cleanupDone).toBe(false)
        await waitUntil(
          () =>
            existsSync(path.join(directory, 'leader-exit.json')) &&
            existsSync(path.join(directory, 'writer-term.json')),
        )
        receipt.afterLeaderClose = {
          leaderLiving: living(started.pid!),
          writerLiving: living(writerPid),
          atMs: performance.now(),
        }
        expect(living(started.pid!)).toBe(false)
        expect(living(writerPid)).toBe(true)
        await expect(supervisor.start()).rejects.toThrow(
          /start\(\) cannot be called/,
        )
        await stopping
        receipt.cleanup = supervisor.cleanup
        receipt.elapsedMs = performance.now() - stopAtMs
        receipt.writerLivingAtOracle = living(writerPid)
        expect(supervisor.cleanup?.status).toBe('complete')
        expect(
          supervisor.cleanup?.signals.map((signal) => signal.signal),
        ).toEqual(['SIGTERM', 'SIGKILL'])
        expect(supervisor.cleanup?.finalObservation.leader).toBe(
          'exited-reaped',
        )
        expect(supervisor.cleanup?.output.complete).toBe(true)
        expect(living(writerPid)).toBe(false)
        expect(performance.now() - stopAtMs).toBeLessThan(1_400 + 100)
        receipt.oraclePass = true
      } finally {
        // Preserve the observation before emergency teardown can change it.
        retainReceipt('sidecar-resistant-descendant', receipt)
        if (writerPid && living(writerPid)) {
          try {
            process.kill(writerPid, 'SIGKILL')
          } catch {}
        }
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'automatic restart awaits the previous normal-exit writer scope',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'b20-sidecar-restart-group-'),
      )
      tempDirs.push(directory)
      const events: SidecarSupervisorEvent[] = []
      let cleanupBeforeRestart: CleanupResult | undefined
      const supervisor = new SidecarSupervisor({
        sidecarPath: nodeExecutable!,
        args: [descendantFixture, 'ready', directory],
        protocolVersion: '1.0.0',
        restartBackoffMs: 5,
        onEvent(event) {
          events.push(event)
          if (event.kind === 'restart')
            cleanupBeforeRestart = supervisor.cleanup
        },
      })
      supervisors.push(supervisor)
      const receipt: Record<string, unknown> = {
        branch: 'generic-sidecar',
        trigger: 'normal-leader-exit',
      }
      let firstWriter: number | undefined
      try {
        const first = await supervisor.start()
        firstWriter = Number(
          readFileSync(path.join(directory, 'writer.pid'), 'utf8'),
        )
        receipt.initial = {
          leader: first.pid,
          writer: readLinuxProcessIdentity(firstWriter),
          living: living(firstWriter),
        }
        expect(living(firstWriter)).toBe(true)
        await expect(supervisor.request('exit-clean')).rejects.toThrow(
          /process died/,
        )
        await waitUntil(() =>
          existsSync(path.join(directory, 'writer-term.json')),
        )
        receipt.afterLeaderClose = {
          writerLiving: living(firstWriter),
          restartEvents: events.filter((event) => event.kind === 'restart')
            .length,
        }
        expect(living(firstWriter)).toBe(true)
        expect(events.filter((event) => event.kind === 'restart')).toHaveLength(
          0,
        )
        await waitForEvent(
          events,
          (event) => event.kind === 'handshake' && event.attempt === 2,
        )
        receipt.cleanupBeforeRestart = cleanupBeforeRestart
        receipt.firstWriterLivingAtOracle = living(firstWriter)
        expect(cleanupBeforeRestart?.status).toBe('complete')
        expect(living(firstWriter)).toBe(false)
        expect(await supervisor.request('ping')).toBe('pong')
        await supervisor.stop()
        receipt.replacementCleanup = supervisor.cleanup
        expect(supervisor.cleanup?.status).toBe('complete')
        receipt.oraclePass = true
      } finally {
        retainReceipt('sidecar-normal-leader-restart', receipt)
        if (firstWriter && living(firstWriter)) {
          try {
            process.kill(firstWriter, 'SIGKILL')
          } catch {}
        }
      }
    },
  )

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
