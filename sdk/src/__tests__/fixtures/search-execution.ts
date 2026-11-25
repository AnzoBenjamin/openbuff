import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMockChildProcess } from '@codebuff/common/testing/mocks'
import { registerInjectedNodeScopeDriver } from '@codebuff/common/util/node-process-scope'
import { processScopeClock } from '@codebuff/common/util/owned-process-scope'
import { nodeConfigReadFs } from '../../host-config'
import { createConfiguredDirectHostExecution } from '../../services/direct-host-execution'
import { retainedNodeScopes } from '../../services/execution-launch'

import type { ChildProcess } from 'node:child_process'
import type { MockChildProcess } from '@codebuff/common/testing/mocks'
import type { ScopeStreams } from '@codebuff/common/types/contracts/process-scope'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

const syntheticChildren = new WeakMap<ChildProcess, { closed: boolean }>()
let nextSyntheticPid = 70_000

/** Synthetic lifecycle observations only; this registration never signals an OS PID. */
export function createSearchMockChild(): MockChildProcess {
  const child = createMockChildProcess()
  const emit = child.emit.bind(child)
  // Node's close event always includes both the exit code and signal.
  child.emit = (event, ...args) =>
    event === 'close' && args.length === 1
      ? emit(event, args[0], null)
      : emit(event, ...args)
  child.pid = ++nextSyntheticPid
  const nodeChild = child as unknown as ChildProcess
  const state = { closed: false }
  syntheticChildren.set(nodeChild, state)
  let streamsAbandoned = false
  let resolveExit!: (value: 'exited-reaped') => void
  let resolveStreams!: (value: ScopeStreams) => void
  const leaderExited = new Promise<'exited-reaped'>((resolve) => {
    resolveExit = resolve
  })
  const streamsFinished = new Promise<ScopeStreams>((resolve) => {
    resolveStreams = resolve
  })
  const streams = (): ScopeStreams => ({
    stdin: 'closed',
    stdout: state.closed || streamsAbandoned ? 'closed-incomplete' : 'open',
    stderr: state.closed || streamsAbandoned ? 'closed-incomplete' : 'open',
  })
  child.once('close', (code: number, signal: NodeJS.Signals | null) => {
    state.closed = true
    Object.assign(child, { exitCode: code, signalCode: signal ?? null })
    resolveExit('exited-reaped')
    resolveStreams(streams())
  })
  registerInjectedNodeScopeDriver(nodeChild, {
    leaderExited,
    streamsFinished,
    async observe() {
      return {
        sampledAtMs: processScopeClock.nowMs(),
        clockDomainId: processScopeClock.domainId,
        leader: state.closed ? 'exited-reaped' : 'running',
        scopePresence: state.closed ? 'absent' : 'living',
        members: [],
        membershipComplete: true,
        identity: 'verified',
        streams: streams(),
      }
    },
    async signal(signal) {
      const atMs = processScopeClock.nowMs()
      return {
        signal,
        atMs,
        targetTier: 'injected',
        result: state.closed
          ? 'already-absent'
          : child.kill(signal)
            ? 'delivered'
            : 'unknown',
      }
    },
    closeInput() {},
    abandonStreams() {
      streamsAbandoned = true
      resolveStreams(streams())
    },
  })
  return child
}

export function searchMockChildClosed(child: MockChildProcess): boolean {
  return (
    syntheticChildren.get(child as unknown as ChildProcess)?.closed === true
  )
}

/** Real captured host authority with a test-owned configuration and exact env. */
export async function createSearchExecutionFixture(options: {
  projectPath: string
  environment?: Record<string, string | undefined>
  spawn?: CodebuffSpawn
}) {
  const configRoot = mkdtempSync(path.join(tmpdir(), 'search-host-fixture-'))
  const config = path.join(configRoot, 'openbuff.json')
  writeFileSync(config, JSON.stringify({ providers: {} }))
  const children = new Set<ChildProcess>()
  const removals: Array<() => void> = []
  const environment = options.environment ?? {
    PATH: '/usr/bin:/bin',
    SEARCH_FIXTURE: 'captured',
  }
  const created = await createConfiguredDirectHostExecution({
    cwd: options.projectPath,
    projectRoot: options.projectPath,
    hostConfiguration: {
      environment,
      platform: process.platform,
      invocationCwd: options.projectPath,
      projectRoot: options.projectPath,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    configReadFs: nodeConfigReadFs,
    mode: 'user',
    approvalMode: 'allow-all',
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    limit: { kind: 'finite', durationMs: 60_000 },
    ...(options.spawn
      ? {
          spawn: (command, argv, input) => {
            const child = options.spawn!(command, argv, input)
            if (!syntheticChildren.has(child))
              throw new Error(
                'Synthetic search child must have an injected scope driver before dispatch',
              )
            children.add(child)
            queueMicrotask(() => child.emit('spawn'))
            return child
          },
        }
      : {}),
  })
  if (!created.ok) {
    rmSync(configRoot, { recursive: true, force: true })
    throw new Error(created.cause)
  }
  const host = created.value
  return {
    context(signal?: AbortSignal) {
      // Mint the authentic request before forwarding an already-aborted caller.
      // This preserves pre-entry cancellation without forging an adapter signal.
      const bridge = new AbortController()
      const operation = host.hostServices.directOperation({
        mode: 'user',
        signal: bridge.signal,
      })
      if (!operation.ok) throw new Error(operation.cause)
      if (signal) {
        const abort = () => bridge.abort(signal.reason)
        if (signal.aborted) abort()
        else {
          signal.addEventListener('abort', abort, { once: true })
          removals.push(() => signal.removeEventListener('abort', abort))
        }
      }
      return operation.value.executionContext
    },
    async close() {
      for (const remove of removals.splice(0)) remove()
      // Explicit synthetic fixture teardown, after the tested observation.
      for (const child of children)
        if (!syntheticChildren.get(child)?.closed)
          child.emit('close', 137, 'SIGKILL')
      try {
        const event = host.hostServices.events[0]
        const hostContextId = event
          ? 'facts' in event
            ? event.facts.hostContextId
            : event.hostContextId
          : ''
        // A deliberately hung-child test can retain a failed cleanup receipt.
        // Once the fixture explicitly closes that child, retry cleanup under
        // the original owner; this grants no earlier deadline-success credit.
        for (const scope of retainedNodeScopes(hostContextId))
          await scope.retryCleanup(true)
        return await host.close()
      } finally {
        rmSync(configRoot, { recursive: true, force: true })
      }
    },
  }
}

/** Async policy admission must complete before tests drive the synthetic peer. */
export async function waitForSearchSpawn(ready: () => boolean) {
  const deadline = performance.now() + 1_000
  while (!ready()) {
    if (performance.now() >= deadline)
      throw new Error('Search did not reach the selected injected spawn')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  // Let the helper attach its output/error listeners after the awaited launch.
  await new Promise((resolve) => setTimeout(resolve, 0))
}
