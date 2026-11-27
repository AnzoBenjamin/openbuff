import { spyOn } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { WebSocketServer } from 'ws'
import { z } from 'zod/v4'

import * as commonExecution from '@codebuff/common/util/execution-context'
import { OpenbuffClient } from '../../client'
import { getCustomToolDefinition } from '../../custom-tool'
import { nodeConfigReadFs } from '../../host-config'
import * as hostModule from '../../host-execution'
import * as browserModule from '../../tools/browser-logs'
import { createNodeFileSystem } from '../../tools/node-filesystem'

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  AbsoluteDeadline, Clock, Correlation, HostAuthority, LaunchEvent, PolicyInput, RootDeadlineSeed, Scheduler,
} from '@codebuff/common/types/contracts/execution-context'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export const SDK_CHROME_BRANCHES = ['chrome.probe', 'chrome.pipe', 'chrome.port-fallback'] as const
export const SDK_CHROME_CONTROLS = [
  'happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero', 'delayed-authorizer-cancellation',
] as const
export type SdkChromeBranch = typeof SDK_CHROME_BRANCHES[number]
export type SdkChromeControl = typeof SDK_CHROME_CONTROLS[number] | 'exhausted-before-later-branch'

// Advance one original monotonic domain. No deadline, action, or request is
// replaced. Only the exhaustion cases substitute the clock/scheduler inputs.
function exhaustionClock(base: Clock) {
  let offset = 0, nextId = 0
  const tasks = new Map<number, { expiresAt: number; callback(): void }>()
  const clock: Clock = { domainId: base.domainId, nowMs: () => base.nowMs() + offset }
  const scheduler: Scheduler = {
    set(delay, callback) { const id = ++nextId; tasks.set(id, { expiresAt: clock.nowMs() + delay, callback }); return id },
    clear(id) { tasks.delete(id as number) },
  }
  return { clock, scheduler, exhaust(deadline: AbsoluteDeadline) {
    if (deadline.kind !== 'finite') throw new Error('Chrome control requires the original finite root deadline')
    offset += Math.max(0, deadline.expiresAtMs - clock.nowMs()) + 1
    for (;;) {
      const due = [...tasks].find(([, task]) => task.expiresAt <= clock.nowMs())
      if (!due) break
      tasks.delete(due[0]); due[1].callback()
    }
  } }
}

type BrowserEntry = {
  action: string
  owner: browserModule.BrowserSessionOwner | string
  executablePath?: string
  projectRoot?: string
  resourceFactoryPresent: boolean
  registered: boolean
  correlation?: Correlation
  initialActionDeadline?: AbsoluteDeadline
  signalAbortedAtEntry?: boolean
  result?: unknown
  error?: unknown
}

/**
 * Real OpenbuffClient.run -> B02 action -> runtime callback -> browser_logs ->
 * getBrowserExecution -> launchChrome. Only selected policy decisions/time and
 * the Node Chrome process boundary are controlled. All other policies delegate.
 */
export async function runSdkChromeControl(branch: SdkChromeBranch, control: SdkChromeControl) {
  const root = mkdtempSync(path.join(tmpdir(), 'b19-sdk-chrome-'))
  const executable = path.join(root, 'captured-chrome')
  const mutatedExecutable = path.join(root, 'mutated-chrome')
  const configFile = path.join(root, 'openbuff.json')
  writeFileSync(executable, 'owned synthetic Chrome executable marker\n')
  writeFileSync(mutatedExecutable, 'must never be selected\n')
  writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  const environment = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), CHROME_PATH: executable,
    PROJECT_VALUE: 'sdk-chrome-captured-public', OPENAI_API_KEY: 'sdk-chrome-canonical-sentinel',
    CUSTOM_PROVIDER_KEY: 'sdk-chrome-configured-sentinel', OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  const stop = new AbortController()
  const events: LaunchEvent[] = [], policyInputs: PolicyInput[] = [], targetPolicies: PolicyInput[] = []
  const printEvents: PrintModeEvent[] = [], entries: BrowserEntry[] = []
  const hosts: hostModule.RunHostServices[] = [], authorities: HostAuthority[] = []
  const hostCaptures: Array<{ snapshotId: string; boundary: RootDeadlineSeed }> = []
  const boundaryCalls: Array<{ branch?: string; family: string; launchId?: string; executable: string; argv: readonly string[];
    cwd?: string; env: NodeJS.ProcessEnv; signalPresent: boolean; signalEqualsPublicRequest: boolean;
    signalAbortedAtSpawn: boolean | undefined }> = []
  const peerMessages: Array<{ branch: string; method: string | undefined }> = []
  const transitionControls: Array<{ point: string; earlierChromeCalls: number; earlierHelperCalls: number;
    originalRootDeadline: AbsoluteDeadline | undefined; beforeMs: number; afterMs: number; rootAborted: boolean }> = []
  const chromeChildren: ChildProcess[] = [], helpers: ChildProcess[] = [], helperExits: Promise<unknown>[] = []
  const browserCompletions: Promise<unknown>[] = []
  const clocks: ReturnType<typeof exhaustionClock>[] = []
  let checkpointEntered = false, networkAttempts = 0, selectedPolicyCompleted = false, probeTransitionArmed = false
  let entered!: () => void, release!: () => void, finishPolicy!: () => void
  const policyEntered = new Promise<void>(resolve => { entered = resolve })
  const policyReleased = new Promise<void>(resolve => { release = resolve })
  const policyCompleted = new Promise<void>(resolve => { finishPolicy = resolve })
  let server: WebSocketServer | undefined, endpoint = ''
  const restorers: Array<() => void> = []

  function armAfterProbe() {
    if (probeTransitionArmed || branch === 'chrome.probe') return
    probeTransitionArmed = true
    if (control !== 'pre-aborted' && control !== 'exhausted-before-later-branch') return
    const beforeMs = clocks[0]?.clock.nowMs() ?? hostModule.executionClock.nowMs()
    if (control === 'pre-aborted') stop.abort(new Error('Cancelled after probe and before selected Chrome startup'))
    if (control === 'exhausted-before-later-branch') {
      const boundary = hostCaptures[0]?.boundary
      if (!boundary || !clocks[0]) throw new Error('Missing original SDK root budget')
      clocks[0].exhaust(boundary.deadline)
    }
    transitionControls.push({ point: 'probe-child-cleanup-before-session-launch',
      earlierChromeCalls: boundaryCalls.filter(call => call.family === 'chrome').length,
      earlierHelperCalls: boundaryCalls.filter(call => call.family !== 'chrome').length,
      originalRootDeadline: hostCaptures[0]?.boundary.deadline, beforeMs,
      afterMs: clocks[0]?.clock.nowMs() ?? hostModule.executionClock.nowMs(), rootAborted: hosts[0]?.rootSignal.aborted ?? false })
  }

  function reply(message: { id?: number; method?: string }, actualBranch: string) {
    peerMessages.push({ branch: actualBranch, method: message.method })
    const unsupportedProbe = branch === 'chrome.port-fallback' && actualBranch === 'chrome.probe'
    const result = message.method === 'Target.getTargets'
      ? { targetInfos: unsupportedProbe ? [] : [{ targetId: 'page', type: 'page', url: 'about:blank' }] }
      : message.method === 'Target.attachToTarget' ? { sessionId: 'attached' }
        : message.method === 'Runtime.evaluate'
          ? { result: { value: { title: 'sdk-chrome-fixture', url: 'about:blank', text: 'sdk-chrome-fixture', elements: [] } } } : {}
    return { id: message.id, result }
  }

  function chromeChild(actualBranch: string): ChildProcess {
    const child = new EventEmitter() as ChildProcess
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    Object.assign(child, { pid: 61919 + chromeChildren.length, stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
      exitCode: null, signalCode: null, killed: false,
      kill: () => {
        if (child.exitCode !== null) return true
        Object.assign(child, { exitCode: 0, killed: true })
        child.emit('exit', 0); child.emit('close', 0)
        if (actualBranch === 'chrome.probe') armAfterProbe()
        return true
      } })
    if (actualBranch !== 'chrome.port-fallback') {
      const readable = new PassThrough()
      let buffered = ''
      const writable = new Writable({ write(chunk, _encoding, done) {
        buffered += chunk.toString()
        let delimiter: number
        while ((delimiter = buffered.indexOf('\0')) >= 0) {
          const data = buffered.slice(0, delimiter); buffered = buffered.slice(delimiter + 1)
          if (!data) continue
          const response = reply(JSON.parse(data), actualBranch)
          queueMicrotask(() => readable.write(JSON.stringify(response) + '\0'))
        }
        done()
      } })
      Object.assign(child, { stdio: [stdin, stdout, stderr, writable, readable] })
    }
    chromeChildren.push(child)
    queueMicrotask(() => {
      child.emit('spawn')
      if (actualBranch === 'chrome.port-fallback')
        setImmediate(() => stderr.write(`DevTools listening on ${endpoint}\n`))
    })
    return child
  }

  const spawn: CodebuffSpawn = (command, argv, options) => {
    const dispatched = [...events].reverse().find(event => event.phase === 'dispatched')
    const facts = dispatched && 'facts' in dispatched ? dispatched.facts : undefined
    const input = policyInputs.find(candidate => candidate.facts.launchId === facts?.launchId)
    const isChrome = command === executable || command === mutatedExecutable
    boundaryCalls.push({ family: isChrome ? 'chrome' : 'sdk-startup-helper', branch: facts?.branchId,
      launchId: input?.target.executable === command ? facts?.launchId : undefined,
      executable: command, argv: [...argv ?? []], cwd: options?.cwd?.toString(), env: { ...options?.env },
      signalPresent: !!options?.signal, signalEqualsPublicRequest: options?.signal === stop.signal,
      signalAbortedAtSpawn: options?.signal?.aborted })
    if (isChrome) {
      if (!facts || facts.family !== 'chrome' || !input) throw new Error('Chrome boundary lacks genuine dispatch authority')
      return chromeChild(facts.branchId)
    }
    const child = nodeSpawn(command, [...argv ?? []], options ?? {})
    helpers.push(child); helperExits.push(new Promise(resolve => child.once('close', resolve)))
    return child
  }

  const checkpoint = getCustomToolDefinition({ toolName: 'b19_chrome_checkpoint',
    description: 'Mark serialized program entry and mutate the original caller inputs after SDK capture',
    inputSchema: z.object({}), execute: async () => {
      checkpointEntered = true
      environment.CHROME_PATH = mutatedExecutable
      environment.PROJECT_VALUE = 'caller-mutated-after-capture'
      return [{ type: 'json', value: { checkpoint: 'captured-host-inputs-mutated' } }]
    } })
  const program: AgentDefinition = {
    id: 'b19-chrome-sdk-branch', displayName: 'B19 actual SDK Chrome branch', model: 'fixture-model',
    toolNames: ['browser_logs', 'b19_chrome_checkpoint', 'set_output'], outputMode: 'structured_output',
    handleSteps: function* () {
      // validateSingleAgent serializes this generator; its only references
      // are local variables and built-in tool names. Host closures live above.
      yield { toolName: 'b19_chrome_checkpoint', input: {} } as unknown as ToolCall
      const { toolResult } = yield { toolName: 'browser_logs', input: { type: 'snapshot',
        _browserOwner: { clientSessionId: 'forged-client', rootRunId: 'forged-root', parentRunId: 'forged-parent', parentAgentId: 'forged-agent' },
      } } as unknown as ToolCall
      yield { toolName: 'set_output', input: { browser: toolResult } }
    },
  }
  let result: Awaited<ReturnType<OpenbuffClient['run']>> | undefined, error: unknown
  let pending: Promise<Awaited<ReturnType<OpenbuffClient['run']>>> | undefined
  try {
    const createAuthority = commonExecution.createHostAuthority
    const authoritySpy = spyOn(commonExecution, 'createHostAuthority').mockImplementation(inputs => {
      const clock = control === 'exhausted-before-later-branch' ? exhaustionClock(inputs.clock) : undefined
      if (clock) clocks.push(clock)
      const authority = createAuthority({ ...inputs, ...(clock ? { clock: clock.clock, scheduler: clock.scheduler } : {}),
        authorizeAsync: async input => {
          policyInputs.push(input)
          if (input.facts.family !== 'chrome' || input.facts.branchId !== branch) return inputs.authorizeAsync(input)
          targetPolicies.push(input)
          if (control === 'denied' || control === 'unavailable')
            return { ok: false, reason: control, cause: `Selected SDK Chrome ${branch} ${control}` }
          if (control === 'exhausted-before-later-branch' && branch === 'chrome.probe') {
            const boundary = hostCaptures[0]?.boundary
            if (!boundary || !clock) throw new Error('Missing positive SDK parent budget for probe control')
            const beforeMs = clock.clock.nowMs()
            clock.exhaust(boundary.deadline)
            transitionControls.push({ point: 'probe-authorization-before-first-browser-dispatch',
              earlierChromeCalls: boundaryCalls.filter(call => call.family === 'chrome').length,
              earlierHelperCalls: boundaryCalls.filter(call => call.family !== 'chrome').length,
              originalRootDeadline: boundary.deadline, beforeMs, afterMs: clock.clock.nowMs(),
              rootAborted: hosts[0]?.rootSignal.aborted ?? false })
          }
          if (control === 'delayed-authorizer-cancellation') {
            entered(); await policyReleased
            try { return await inputs.authorizeAsync(input) }
            finally { selectedPolicyCompleted = true; finishPolicy() }
          }
          return inputs.authorizeAsync(input)
        },
        authorizeSync: input => {
          policyInputs.push(input)
          return inputs.authorizeSync?.(input) ?? { ok: false, reason: 'unavailable', cause: 'Original synchronous policy absent' }
        },
      })
      authorities.push(authority)
      return authority
    })
    restorers.push(() => authoritySpy.mockRestore())
    const createHost = hostModule.createHostExecutionServices
    const hostSpy = spyOn(hostModule, 'createHostExecutionServices').mockImplementation(options => {
      hostCaptures.push({ snapshotId: options.snapshot.snapshotId, boundary: options.boundary })
      const created = createHost(options)
      if (created.ok) hosts.push(created.value)
      return created
    })
    restorers.push(() => hostSpy.mockRestore())
    const browserLogs = browserModule.browserLogs
    const browserSpy = spyOn(browserModule, 'browserLogs').mockImplementation(async (action, owner, context) => {
      const registered = context && hosts[0]?.execution.actionRegistration(context.execution)
      const entry: BrowserEntry = { action: action.type, owner: typeof owner === 'object' ? { ...owner } : owner ?? 'missing-owner',
        executablePath: context?.executablePath, projectRoot: context?.projectRoot,
        resourceFactoryPresent: typeof context?.resources === 'function', registered: registered?.ok === true,
        correlation: registered?.ok ? registered.value.correlation : undefined,
        initialActionDeadline: registered?.ok ? hosts[0]!.execution.deadline(registered.value.budget) : undefined,
        signalAbortedAtEntry: context?.signal?.aborted }
      entries.push(entry)
      const completion = browserLogs(action, owner, context)
      browserCompletions.push(completion)
      try { return entry.result = await completion }
      catch (caught) { entry.error = caught; throw caught }
    })
    restorers.push(() => browserSpy.mockRestore())
    const forbid = () => { networkAttempts++; throw new Error('Provider/network fetch forbidden in actual SDK Chrome controls') }
    const networkSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbid(), { preconnect: forbid }))
    restorers.push(() => networkSpy.mockRestore())
    if (branch === 'chrome.port-fallback' && control === 'happy') {
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing local CDP websocket port')
      endpoint = `ws://127.0.0.1:${address.port}/devtools/browser/sdk-fixture`
      server.on('connection', socket => socket.on('message', data => socket.send(JSON.stringify(reply(JSON.parse(data.toString()), 'chrome.port-fallback')))))
    }
    const client = new OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, 'harness'),
      hostConfiguration: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
        home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false } },
      configReadFs: nodeConfigReadFs, spawnSource: spawn, fsSource: createNodeFileSystem(), approvalMode: 'allow-all',
      recordExecution: event => events.push(event), handleEvent: event => { printEvents.push(event) },
      customToolDefinitions: [checkpoint] })
    if (branch === 'chrome.probe' && control === 'pre-aborted') stop.abort(new Error('SDK intake is already aborted'))
    pending = client.run({ agent: program, prompt: JSON.stringify({ branch, control }),
      signal: stop.signal, runTimeoutMs: control === 'deadline-zero' ? 0 : 60_000 })
    if (control === 'delayed-authorizer-cancellation') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([policyEntered, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Selected Chrome authorizer not reached: ${branch}`)), 5000)
        })])
        stop.abort(new Error('SDK root cancelled while selected Chrome approval is delayed'))
      } finally { if (timer) clearTimeout(timer); release() }
      await policyCompleted
    }
    result = await pending
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  } catch (caught) { error = caught }
  finally {
    release()
    stop.abort(new Error('SDK Chrome fixture cleanup'))
    if (pending) await pending.catch(() => undefined)
    await Promise.allSettled(browserCompletions)
    for (const child of chromeChildren) child.kill()
    for (const child of helpers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled(helperExits)
    if (server) { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    for (const restore of restorers.reverse()) restore()
    rmSync(root, { recursive: true, force: true })
  }
  return { branch, control, root, executable, mutatedExecutable, runTimeoutMs: control === 'deadline-zero' ? 0 : 60_000,
    result, error, checkpointEntered, networkAttempts, hostCaptures, hostCount: hosts.length, authorityCount: authorities.length,
    events, policyInputs, targetPolicies, entries, printEvents, boundaryCalls, peerMessages, transitionControls,
    selectedPolicyCompleted, syntheticChromeChildren: chromeChildren.length,
    syntheticChromeChildrenClosed: chromeChildren.filter(child => child.exitCode !== null).length }
}
