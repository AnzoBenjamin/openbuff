import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureMcpConfig,
  closeMCPClient,
  getMCPClientCapacity,
  getMCPClient,
  getMCPClientGeneration,
  getPendingMCPClientCleanupCount,
  getMediatedMCPClient,
  listMCPToolCatalog,
  retryMCPClientCleanup,
} from '../client'
import { executionFixture, value } from './execution-fixture'
import type { CodebuffSpawn } from '../../types/spawn'
import {
  CompatibilityStdioTransport,
  McpStdioCleanupError,
  McpStdioFrameLimitError,
  OwnedStdioTransport,
} from '../stdio-transport'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { parseProcStat } from '../../util/linux-process-scope'
import { createNodeProcessScope } from '../../util/node-process-scope'
import { isExecutionDeadlineSignal } from '../../util/execution-context'

function recordEvidence(name: string, value: unknown): void {
  const directory = process.env.B20_MCP_EVIDENCE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate() && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

function living(pid: number): boolean {
  try {
    const { state } = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    return state !== 'Z' && state !== 'X'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const server = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 if (m.method === 'tools/call' && m.params.name === 'exit') { process.exit(0); return; }
 let result;
 if (m.method === 'initialize') result = {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 else if (m.method === 'tools/list') result = {tools:[{name:'record',description:'local recorder',inputSchema:{type:'object'}}]};
 else result = {content:[{type:'text',text:JSON.stringify({pid:process.pid,value:process.env.PROJECT_VALUE,canonical:!!process.env.OPENAI_API_KEY,configured:!!process.env.CUSTOM_PROVIDER_KEY})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`

function fixtureTarget(
  context: ReturnType<ReturnType<typeof executionFixture>['context']>,
  args: string[],
  overlay = {},
  detached = process.platform === 'linux',
) {
  return {
    executable: process.execPath,
    argv: args,
    cwd: process.cwd(),
    projectRoot: context.projectRoot,
    allowedPaths: context.allowedPaths,
    mode: context.mode,
    processType: 'BACKGROUND' as const,
    profile: context.profile,
    family: 'mcp-stdio' as const,
    branchId: 'mcp.discovery-start',
    environmentOverlay: overlay,
    adapterOptions: {
      runtime: 'node',
      detached,
      scopeTier: detached ? 'posix-owned-group' : 'direct-child',
      shell: false,
      stdio: 'pipe,pipe,ignore',
      windowsHide: false,
    },
  }
}

describe('owned MCP actual stdio boundary', () => {
  test('an exited MCP child requires a newly admitted resource generation', async () => {
    const fixture = executionFixture()
    const context = fixture.context()
    const args = ['--no-env-file', '-e', server]
    const captured = captureMcpConfig(
      { type: 'stdio', command: process.execPath, args, env: {} },
      { origin: 'project', environment: {} },
    )
    const resource = value(fixture.resources(fixtureTarget(context, args)))
    let clientId: string | undefined
    try {
      const first = await getMediatedMCPClient(captured, {
        resource,
        execution: context.execution,
      })
      const oldId = first.id
      await expect(
        first.callTool({ name: 'exit', arguments: {} }),
      ).rejects.toThrow()
      first.release()
      const second = await getMediatedMCPClient(captured, {
        resource,
        execution: fixture.context().execution,
      })
      clientId = second.id
      try {
        expect((await second.listToolCatalog()).complete).toBe(true)
        expect(second.id).not.toBe(oldId)
        const observed = fixture.events.filter(
          (event) => event.phase === 'spawn-observed',
        )
        expect(observed).toHaveLength(2)
        expect(observed[0].facts.resourceGeneration).not.toBe(
          observed[1].facts.resourceGeneration,
        )
      } finally {
        second.release()
      }
    } finally {
      if (clientId) await closeMCPClient(clientId)
      fixture.close()
    }
  }, 10_000)

  test('close while admission waits cannot dispatch a child later', async () => {
    let allow: (() => void) | undefined
    const fixture = executionFixture({
      authorizeAsync: async () => {
        await new Promise<void>((resolve) => {
          allow = resolve
        })
        return { ok: true, basis: 'explicit-policy', decisionId: 'deferred' }
      },
    })
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, [], {}, false))).request(
        context.execution,
      ),
    )
    let launches = 0
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      spawn: () => {
        launches++
        throw new Error('must not launch')
      },
    })
    try {
      const pending = transport.start()
      await transport.close()
      allow?.()
      await expect(pending).rejects.toThrow('closed before dispatch')
      expect(launches).toBe(0)
    } finally {
      access.release()
      fixture.close()
    }
  })

  test('a child lacking an actual runtime PID cannot activate the resource', async () => {
    const fixture = executionFixture()
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, [], {}, false))).request(
        context.execution,
      ),
    )
    let terminations = 0
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      spawn: () => {
        const child = new EventEmitter() as ChildProcess
        child.kill = () => {
          terminations++
          queueMicrotask(() => child.emit('close', 0, null))
          return true
        }
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    try {
      await expect(transport.start()).rejects.toThrow('no valid runtime PID')
      await transport.close()
      expect(terminations).toBe(1)
      expect(
        fixture.events.some((event) => event.phase === 'spawn-observed'),
      ).toBe(false)
    } finally {
      await transport.close()
      access.release()
      fixture.close()
    }
  })

  test('a bounded failed cleanup stays cached until an explicit force retry observes exit', async () => {
    const fixture = executionFixture()
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, [], {}, false))).request(
        context.execution,
      ),
    )
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, 'pid', { value: 12345 })
    let attempts = 0
    let recoveryAllowed = false
    child.kill = () => {
      attempts++
      if (!recoveryAllowed) {
        if (attempts === 1)
          throw Object.assign(new Error('kill failed'), { code: 'EPERM' })
        return false
      }
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    }
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      cleanupPolicy: {
        termGraceMs: 20,
        killGraceMs: 20,
        observationMs: 40,
        pollMs: 5,
      },
      spawn: () => {
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    let closeEvents = 0
    transport.onclose = () => closeEvents++
    try {
      await transport.start()
      const closing = transport.close()
      expect(transport.close()).toBe(closing)
      await expect(closing).rejects.toBeInstanceOf(McpStdioCleanupError)
      expect(transport.pid).toBe(12345)
      const failed = transport.currentCleanup()!
      const failedSnapshot = JSON.parse(JSON.stringify(failed))
      const failedAttempts = attempts
      expect(failed.status).toBe('failed')
      expect(failed.cleanupAuthorityRetained).toBe(true)
      expect(failedAttempts).toBeGreaterThanOrEqual(2)
      expect(failed.signals).toHaveLength(failedAttempts)
      expect(failed.signals[0]).toMatchObject({
        signal: 'SIGTERM',
        result: 'unknown',
        errorCode: 'EPERM',
      })
      expect(
        failed.signals
          .slice(1)
          .every(
            (signal) =>
              signal.signal === 'SIGKILL' && signal.result === 'unknown',
          ),
      ).toBe(true)
      expect(failed.observeUntilMs - failed.firstStopAtMs).toBeCloseTo(80, 6)
      await expect(transport.close()).rejects.toBeInstanceOf(
        McpStdioCleanupError,
      )
      expect(attempts).toBe(failedAttempts)
      expect(transport.currentCleanup()).toBe(failed)
      expect(closeEvents).toBe(1)
      recoveryAllowed = true
      await transport.retryCleanup()
      expect(attempts).toBe(failedAttempts + 1)
      expect(transport.pid).toBeNull()
      expect(closeEvents).toBe(1)
      expect(failed.status).toBe('failed')
      expect(failed).toEqual(failedSnapshot)
      const recovered = transport.currentCleanup()!
      expect(recovered.status).toBe('complete')
      expect(recovered.attemptId).not.toBe(failed.attemptId)
      expect(recovered.signals.map((signal) => signal.signal)).toEqual([
        'SIGKILL',
      ])
      recordEvidence('bounded-failed-cleanup-recovery', {
        tier: 'injected-direct-child',
        failed,
        recovered,
        failedAttempts,
        recoveryAttempts: attempts - failedAttempts,
        failedResultUnchanged:
          JSON.stringify(failed) === JSON.stringify(failedSnapshot),
      })
    } finally {
      child.emit('close', 0, null)
      await transport.retryCleanup()
      access.release()
      fixture.close()
    }
  })

  test('a registered deadline abort keeps its cause while the captured remaining bridge is still positive', async () => {
    let hostNow = 1000
    let nextTimerId = 0
    const timers = new Map<number, { dueAt: number; callback: () => void }>()
    const fixture = executionFixture(
      {
        clock: {
          domainId: 'mcp-deadline-marker-control',
          nowMs: () => hostNow,
        },
        scheduler: {
          set: (delay, callback) => {
            const id = ++nextTimerId
            timers.set(id, { dueAt: hostNow + delay, callback })
            return id
          },
          clear: (id) => {
            timers.delete(id as number)
          },
        },
      },
      { kind: 'finite', durationMs: 250 },
    )
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, [], {}, false))).request(
        context.execution,
      ),
    )
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, 'pid', { value: 12345 })
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    }
    let remainingMs: (() => number | null) | undefined
    let remainingAtAbort: number | null | undefined
    let registeredDeadlineAtAbort = false
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      createScope: (ownedChild, options) => {
        remainingMs = options.remainingMs
        return createNodeProcessScope(ownedChild, options)
      },
      spawn: (_command, _args, options) => {
        // Model Node's native abort/error listener being installed by spawn,
        // before the process scope subscribes to that same admitted signal.
        options?.signal?.addEventListener(
          'abort',
          () => {
            remainingAtAbort = remainingMs?.()
            registeredDeadlineAtAbort = isExecutionDeadlineSignal(
              options.signal!,
            )
            child.emit(
              'error',
              Object.assign(new Error('native abort control'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
              }),
            )
          },
          { once: true },
        )
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    try {
      await transport.start()
      hostNow = 1250
      for (const [id, timer] of [...timers]) {
        if (timer.dueAt > hostNow || !timers.has(id)) continue
        timers.delete(id)
        timer.callback()
      }
      await waitUntil(() => transport.currentCleanup() !== undefined)
      const result = transport.currentCleanup()!
      recordEvidence('registered-deadline-positive-bridge', {
        control: 'injected-child-with-registered-host-authority',
        remainingAtAbort,
        registeredDeadlineAtAbort,
        result,
      })
      expect(registeredDeadlineAtAbort).toBe(true)
      expect(remainingAtAbort).toBeGreaterThan(0)
      expect(result.trigger).toBe('deadline')
      expect(result.status).toBe('complete')
      expect(result.originalDeadline).toMatchObject({
        kind: 'finite',
        domainId: 'mcp-deadline-marker-control',
        expiresAtMs: 1250,
      })
      await transport.close()
    } finally {
      child.emit('close', 0, null)
      await transport.retryCleanup().catch(() => {})
      access.release()
      fixture.close()
    }
  })

  test('a real TERM-resistant child escalates to KILL and close joins physical cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-term-resistant-'))
    const ready = join(directory, 'ready')
    const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)`
    const args = ['--no-env-file', '-e', script, ready]
    const fixture = executionFixture()
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, args))).request(
        context.execution,
      ),
    )
    let child: ChildProcess | undefined
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      spawn: (command, argv, options) => {
        child = spawn(command, argv ?? [], options ?? {})
        return child
      },
    })
    try {
      await transport.start()
      const deadline = performance.now() + 5000
      while (!existsSync(ready) && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(ready)).toBe(true)
      const pid = transport.pid!
      const closing = transport.close()
      expect(transport.close()).toBe(closing)
      await closing
      expect(transport.pid).toBeNull()
      const result = transport.currentCleanup()!
      expect(result.status).toBe('complete')
      expect(result.finalObservation.leader).toBe('exited-reaped')
      expect(result.signals.map((signal) => signal.signal)).toEqual([
        'SIGTERM',
        'SIGKILL',
      ])
      expect(result.cleanupAuthorityRetained).toBe(false)
      recordEvidence('resistant-leader', { pid, result })
    } finally {
      child?.kill('SIGKILL')
      access.release()
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)

  test('a real failed direct-child cleanup retains registry capacity until an explicit retry recovers it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-client-resistant-'))
    const ready = join(directory, 'ready')
    const args = [
      '--no-env-file',
      '-e',
      `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('node:fs').writeFileSync(process.argv[1], 'ready'); ${server}`,
      ready,
    ]
    const fixture = executionFixture()
    const context = fixture.context()
    const captured = captureMcpConfig(
      { type: 'stdio', command: process.execPath, args, env: {} },
      { origin: 'project', environment: {} },
    )
    let child: ChildProcess | undefined
    let originalKill: ChildProcess['kill'] | undefined
    let attempts = 0
    let clientId: string | undefined
    try {
      const request = await getMediatedMCPClient(captured, {
        resource: value(
          fixture.resources(fixtureTarget(context, args, {}, false)),
        ),
        execution: context.execution,
        spawn: (command, argv, options) => {
          child = spawn(command, argv ?? [], options ?? {})
          originalKill = child.kill.bind(child)
          child.kill = () => {
            attempts++
            return false
          }
          return child
        },
      })
      clientId = request.id
      expect(existsSync(ready)).toBe(true)
      request.release()
      await expect(closeMCPClient(clientId)).rejects.toThrow(
        'cleanup unconfirmed',
      )
      expect(getPendingMCPClientCleanupCount(clientId)).toBe(1)
      expect(getMCPClientCapacity()).toMatchObject({
        occupied: 1,
        cleanupFailed: 1,
      })
      expect(() => process.kill(child!.pid!, 0)).not.toThrow()
      const failedAttempts = attempts
      await expect(closeMCPClient(clientId)).rejects.toThrow(
        'cleanup unconfirmed',
      )
      expect(attempts).toBe(failedAttempts)
      recordEvidence('failed-client-before-recovery', {
        pid: child!.pid,
        attempts,
        cleanupOwners: getPendingMCPClientCleanupCount(clientId),
        capacity: getMCPClientCapacity(),
        launched: fixture.events.some(
          (event) => event.phase === 'spawn-observed',
        ),
        aliveAtFailure: true,
      })
      child!.kill = originalKill!
      await retryMCPClientCleanup(clientId)
      expect(getPendingMCPClientCleanupCount(clientId)).toBe(0)
      expect(getMCPClientCapacity().occupied).toBe(0)
    } finally {
      originalKill?.('SIGKILL')
      if (clientId) await retryMCPClientCleanup(clientId).catch(() => {})
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)

  test('captured env reaches a real child; a fresh request reuses its observed process', async () => {
    const fixture = executionFixture()
    const controller = new AbortController()
    const firstContext = fixture.context(controller.signal)
    const config = {
      type: 'stdio' as const,
      command: process.execPath,
      args: ['--no-env-file', '-e', server],
      env: { PROJECT_VALUE: '$CHOICE' },
    }
    const environment = { CHOICE: 'captured' }
    const captured = captureMcpConfig(config, {
      origin: 'project',
      environment,
    })
    environment.CHOICE = 'changed'
    config.env.PROJECT_VALUE = 'changed-again'
    const resource = value(
      fixture.resources({
        ...fixtureTarget(
          firstContext,
          config.args,
          captured.resolved.type === 'stdio' ? captured.resolved.env : {},
        ),
        branchId: 'mcp.call-start',
      }),
    )
    let launches = 0
    const recorder: CodebuffSpawn = (command, args, options) => {
      launches++
      return spawn(command, args ?? [], options ?? {})
    }
    let clientId: string | undefined
    try {
      const first = await getMediatedMCPClient(captured, {
        resource,
        execution: firstContext.execution,
        signal: controller.signal,
        spawn: recorder,
      })
      clientId = first.id
      const output = await first.callTool({ name: 'record', arguments: {} })
      expect((await first.listToolCatalog()).complete).toBe(true)
      expect(() => listMCPToolCatalog(first.id)).toThrow(
        'current request lease',
      )
      expect(output[0]?.type).toBe('json')
      if (output[0]?.type !== 'json') throw new Error('Missing fixture output')
      const envelope = output[0].value as { content: { text: string }[] }
      expect(JSON.parse(envelope.content[0].text)).toMatchObject({
        value: 'captured',
        canonical: false,
        configured: false,
      })
      first.release()
      controller.abort()
      const secondContext = fixture.context()
      const second = await getMediatedMCPClient(captured, {
        resource,
        execution: secondContext.execution,
        spawn: recorder,
      })
      try {
        expect((await second.listToolCatalog()).complete).toBe(true)
        expect(launches).toBe(1)
        expect(
          fixture.events.filter((e) => e.phase === 'spawn-observed'),
        ).toHaveLength(1)
        expect(fixture.events.some((e) => e.phase === 'resource-reused')).toBe(
          true,
        )
      } finally {
        second.release()
      }
    } finally {
      if (clientId) await closeMCPClient(clientId)
      fixture.close()
    }
  }, 10_000)

  test.each(['mcp.discovery-start', 'mcp.call-start'])(
    'denied %s invokes no actual spawn',
    async (branchId) => {
      const fixture = executionFixture({
        authorizeAsync: async () => ({
          ok: false,
          reason: 'denied',
          cause: 'fixture denial',
        }),
      })
      const context = fixture.context()
      const args = ['--no-env-file', '-e', server]
      const captured = captureMcpConfig(
        { type: 'stdio', command: process.execPath, args, env: {} },
        { origin: 'project', environment: {} },
      )
      const resource = value(
        fixture.resources({ ...fixtureTarget(context, args), branchId }),
      )
      let launches = 0
      try {
        await expect(
          getMediatedMCPClient(captured, {
            resource,
            execution: context.execution,
            spawn: () => {
              launches++
              throw new Error('must not spawn')
            },
          }),
        ).rejects.toThrow('fixture denial')
        expect(launches).toBe(0)
        expect(fixture.events.some((e) => e.phase === 'no-launch')).toBe(true)
        expect(fixture.events.some((e) => e.phase === 'spawn-observed')).toBe(
          false,
        )
      } finally {
        fixture.close()
      }
    },
  )

  test('the compatibility launcher waits for direct-child cleanup and retains safe default environment behavior', async () => {
    const transport = new CompatibilityStdioTransport({
      command: process.execPath,
      args: [
        '--no-env-file',
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      env: {},
    })
    try {
      await transport.start()
      const closing = transport.close()
      expect(transport.close()).toBe(closing)
      await closing
      expect(transport.currentCleanup()).toMatchObject({
        status: 'complete',
        selectedTier: 'direct-child',
        cleanupAuthorityRetained: false,
      })
      expect(transport.currentCleanup()!.launchFacts).toBeUndefined()
      expect(transport.pid).toBeNull()
    } finally {
      await transport.retryCleanup()
    }
  })

  test('a continuing writer over the frame quota drains through KILL without unbounded protocol retention', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-frame-quota-'))
    const ready = join(directory, 'ready')
    const fixture = executionFixture()
    const context = fixture.context()
    const script =
      "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => process.stdout.write('x'.repeat(65536)), 10)"
    const args = ['--no-env-file', '-e', script, ready]
    const access = value(
      value(fixture.resources(fixtureTarget(context, args))).request(
        context.execution,
      ),
    )
    const errors: Error[] = []
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      maxMessageBytes: 4096,
    })
    transport.onerror = (error) => errors.push(error)
    try {
      await transport.start()
      await waitUntil(() => existsSync(ready))
      await waitUntil(() => transport.currentCleanup() !== undefined)
      const result = transport.currentCleanup()!
      const buffer = transport.bufferUsage()
      recordEvidence('frame-quota', { result, buffer })
      expect(
        errors.some((error) => error instanceof McpStdioFrameLimitError),
      ).toBe(true)
      expect(buffer.highWaterBytes).toBeLessThanOrEqual(4096)
      expect(buffer.bufferedBytes).toBe(0)
      expect(result.status).toBe('complete')
      expect(result.trigger).toBe('output-limit')
      expect(result.output.stdoutSeenBytes).toBeGreaterThan(4096)
      expect(result.output.droppedBytes).toBeGreaterThan(4096)
      expect(result.output.complete).toBe(false)
      expect(result.signals.map((signal) => signal.signal)).toEqual([
        'SIGTERM',
        'SIGKILL',
      ])
      await transport.close()
    } finally {
      await transport.retryCleanup().catch(() => {})
      access.release()
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)

  if (process.platform === 'linux') {
    for (const mode of ['redirected', 'inherited-pipe']) {
      test(`physical stdio close retains escalation after early leader exit with a TERM-resistant ${mode} descendant`, async () => {
        const directory = mkdtempSync(join(tmpdir(), `mcp-${mode}-scope-`))
        const fixture = executionFixture()
        const context = fixture.context()
        const args = [
          '--no-env-file',
          join(import.meta.dir, 'fixtures/mcp-scope-server.mjs'),
          mode,
          directory,
        ]
        const access = value(
          value(fixture.resources(fixtureTarget(context, args))).request(
            context.execution,
          ),
        )
        const transport = new OwnedStdioTransport({
          prepareLaunch: () => access.prepareLaunch(),
        })
        try {
          await transport.start()
          await waitUntil(() =>
            existsSync(join(directory, 'leader-ready.json')),
          )
          const started = JSON.parse(
            readFileSync(join(directory, 'leader-ready.json'), 'utf8'),
          )
          expect(living(started.pid)).toBe(true)
          expect(living(started.descendantPid)).toBe(true)
          const closing = transport.close()
          expect(transport.close()).toBe(closing)
          await waitUntil(() => existsSync(join(directory, 'leader-exited')))
          const afterLeaderExit = await transport.observeScope()
          recordEvidence(`${mode}-leader-exited-before-cleanup`, {
            started,
            afterLeaderExit,
            cleanup: transport.currentCleanup(),
          })
          expect(afterLeaderExit!.leader).toBe('exited-reaped')
          expect(afterLeaderExit!.scopePresence).toBe('living')
          expect(
            afterLeaderExit!.members.some(
              (member) =>
                member.identity.pid === started.descendantPid &&
                member.disposition === 'living',
            ),
          ).toBe(true)
          expect(transport.pid).toBe(started.pid)
          await closing
          const result = transport.currentCleanup()!
          recordEvidence(`${mode}-descendant-cleanup`, {
            started,
            afterLeaderExit,
            result,
            events: readFileSync(join(directory, 'events.jsonl'), 'utf8'),
          })
          expect(result.status).toBe('complete')
          expect(result.selectedTier).toBe('posix-owned-group')
          expect(
            result.finalObservation.members.some(
              (member) => member.disposition === 'living',
            ),
          ).toBe(false)
          expect(result.finalObservation.leader).toBe('exited-reaped')
          expect(result.signals.map((signal) => signal.signal)).toEqual([
            'SIGTERM',
            'SIGKILL',
          ])
          expect(living(started.descendantPid)).toBe(false)
          expect(transport.pid).toBeNull()
          expect(
            readFileSync(join(directory, 'events.jsonl'), 'utf8'),
          ).toContain('descendant-ignored-term')
        } finally {
          await transport.retryCleanup().catch(() => {})
          access.release()
          fixture.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }, 10_000)
    }

    test('an ordinary untransferred leader exit reconciles its surviving redirected descendant', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mcp-normal-exit-scope-'))
      const fixture = executionFixture()
      const context = fixture.context()
      const args = [
        '--no-env-file',
        join(import.meta.dir, 'fixtures/mcp-scope-server.mjs'),
        'redirected',
        directory,
      ]
      const access = value(
        value(fixture.resources(fixtureTarget(context, args))).request(
          context.execution,
        ),
      )
      const transport = new OwnedStdioTransport({
        prepareLaunch: () => access.prepareLaunch(),
      })
      try {
        await transport.start()
        await waitUntil(() => existsSync(join(directory, 'leader-ready.json')))
        const started = JSON.parse(
          readFileSync(join(directory, 'leader-ready.json'), 'utf8'),
        )
        expect(living(started.descendantPid)).toBe(true)
        await transport.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'exit-leader' },
        })
        await waitUntil(() => transport.currentCleanup() !== undefined)
        const result = transport.currentCleanup()!
        recordEvidence('normal-leader-exit', {
          started,
          result,
          events: readFileSync(join(directory, 'events.jsonl'), 'utf8'),
        })
        expect(result.status).toBe('complete')
        expect(result.trigger).toBe('normal-leader-exit')
        expect(living(started.descendantPid)).toBe(false)
        await transport.close()
      } finally {
        await transport.retryCleanup().catch(() => {})
        access.release()
        fixture.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }, 10_000)

    for (const trigger of ['deadline', 'cancel'] as const) {
      test(`a real inherited-pipe descendant respects original D=250 after ${trigger}`, async () => {
        const directory = mkdtempSync(join(tmpdir(), `mcp-${trigger}-scope-`))
        const selectedAt = performance.now()
        const fixture = executionFixture(
          {},
          { kind: 'finite', durationMs: 250 },
        )
        const context = fixture.context()
        const args = [
          '--no-env-file',
          join(import.meta.dir, 'fixtures/mcp-scope-server.mjs'),
          'inherited-pipe',
          directory,
        ]
        const access = value(
          value(fixture.resources(fixtureTarget(context, args))).request(
            context.execution,
          ),
        )
        const transport = new OwnedStdioTransport({
          prepareLaunch: () => access.prepareLaunch(),
        })
        try {
          await transport.start()
          await waitUntil(() =>
            existsSync(join(directory, 'leader-ready.json')),
          )
          const started = JSON.parse(
            readFileSync(join(directory, 'leader-ready.json'), 'utf8'),
          )
          expect(
            fixture.events.some((event) => event.phase === 'spawn-observed'),
          ).toBe(true)
          expect(living(started.pid)).toBe(true)
          expect(living(started.descendantPid)).toBe(true)
          const cancelAt = trigger === 'cancel' ? performance.now() : null
          if (trigger === 'cancel') fixture.close()
          await waitUntil(() => transport.currentCleanup() !== undefined)
          const result = transport.currentCleanup()!
          const elapsedMs = performance.now() - selectedAt
          const launch = fixture.events.find(
            (event) => event.phase === 'spawn-observed',
          )!
          recordEvidence(`original-250-${trigger}`, {
            selectedAt,
            cancelAt,
            elapsedMs,
            selected: {
              deadlineMs: 250,
              termGraceMs: 200,
              killGraceMs: 200,
              observationMs: 1000,
              boundMs: 1650,
            },
            started,
            result,
            launch,
          })
          expect(result.status).toBe('complete')
          expect(result.trigger).toBe(
            trigger === 'deadline' ? 'deadline' : 'owner-cancel',
          )
          expect(result.originalDeadline).toEqual(
            launch.facts.deadlines.resourceLifetime,
          )
          expect(result.selectedLimitSatisfied).toBe(true)
          expect(elapsedMs).toBeLessThan(1650)
          expect(living(started.descendantPid)).toBe(false)
          await transport.close()
        } finally {
          await transport.retryCleanup().catch(() => {})
          access.release()
          fixture.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }, 10_000)
    }

    test('a real held lease and release during a call protect its process under physical capacity pressure', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mcp-real-lease-scope-'))
      const fixture = executionFixture()
      const context = fixture.context()
      const args = [
        '--no-env-file',
        join(import.meta.dir, 'fixtures/mcp-scope-server.mjs'),
        'inherited-pipe',
        directory,
      ]
      const captured = captureMcpConfig(
        { type: 'stdio', command: process.execPath, args, env: {} },
        { origin: 'project', environment: {} },
      )
      const active: string[] = []
      let request: Awaited<ReturnType<typeof getMediatedMCPClient>> | undefined
      const open = async (index: number) => {
        const id = await getMCPClient(
          {
            type: 'stdio',
            command: process.execPath,
            args: [join(import.meta.dir, 'fixtures/mcp-empty-server.mjs')],
            env: { OPENBUFF_MCP_LEASE_FIXTURE_ID: `${directory}-${index}` },
          },
          { origin: 'project' },
        )
        active.push(id)
        return id
      }
      try {
        request = await getMediatedMCPClient(captured, {
          resource: value(fixture.resources(fixtureTarget(context, args))),
          execution: context.execution,
        })
        active.push(request.id)
        const started = JSON.parse(
          readFileSync(join(directory, 'leader-ready.json'), 'utf8'),
        )
        expect((await request.listToolCatalog()).complete).toBe(true)
        for (let index = 0; index < 63; index++) await open(index)
        await open(63)
        expect(request.generation).toBeDefined()
        expect(getMCPClientGeneration(active[1])).toBeUndefined()
        expect(living(started.pid)).toBe(true)
        expect(living(started.descendantPid)).toBe(true)
        const call = request.callTool({ name: 'hold' })
        const outcome = call.then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        await waitUntil(() =>
          readFileSync(join(directory, 'events.jsonl'), 'utf8').includes(
            'call-started',
          ),
        )
        request.release()
        await open(64)
        const protectedDuringUse = {
          generation: request.generation,
          leaderLiving: living(started.pid),
          descendantLiving: living(started.descendantPid),
          capacity: getMCPClientCapacity(),
        }
        recordEvidence('real-held-lease-during-call', {
          started,
          protectedDuringUse,
        })
        expect(protectedDuringUse.generation).toBeDefined()
        expect(protectedDuringUse.leaderLiving).toBe(true)
        expect(protectedDuringUse.descendantLiving).toBe(true)
        expect(protectedDuringUse.capacity.occupied).toBe(64)
        writeFileSync(join(directory, 'release-call'), '')
        const result = await outcome
        expect('error' in result ? result.error : undefined).toBeUndefined()
        await open(65)
        const afterRelease = {
          generation: request.generation,
          descendantLiving: living(started.descendantPid),
          cleanupOwners: getPendingMCPClientCleanupCount(request.id),
          capacity: getMCPClientCapacity(),
        }
        recordEvidence('real-held-lease-after-call', {
          started,
          protectedDuringUse,
          afterRelease,
        })
        expect(afterRelease.generation).toBeUndefined()
        expect(afterRelease.descendantLiving).toBe(false)
        expect(afterRelease.cleanupOwners).toBe(0)
        expect(afterRelease.capacity.occupied).toBe(64)
      } finally {
        writeFileSync(join(directory, 'release-call'), '')
        request?.release()
        await Promise.allSettled(active.map((id) => closeMCPClient(id)))
        fixture.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }, 30_000)
  }
})
