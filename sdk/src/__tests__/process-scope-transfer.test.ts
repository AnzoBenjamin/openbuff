import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { parseProcStat, readLinuxProcessIdentity } from '@codebuff/common/util/linux-process-scope'
import { captureNodeTarget, dispatchNodeLaunch } from '../services/execution-launch'
import { createRealExecutionProcessRecorder, createTerminalExecutionFixture, executionValue } from './fixtures/b19-terminal-execution'

import type { Limit, ResourceHandle } from '@codebuff/common/types/contracts/execution-context'
import type { NodeDispatchHandle } from '../services/execution-launch'

const node = Bun.which('node')
if (!node) throw new Error('B20 transfer controls require actual Node')
const repoRoot = path.resolve(import.meta.dir, '../../..')
const treeFixture = path.join(repoRoot, 'scripts/body-fixtures/b20-process-tree.mjs')
const evidence = process.env.B20_TRANSFER_EVIDENCE_DIR
const sourceFiles = [
  'common/src/types/contracts/execution-context.ts', 'common/src/types/contracts/process-scope.ts',
  'common/src/util/execution-context.ts', 'common/src/util/owned-process-scope.ts',
  'common/src/util/linux-process-scope.ts', 'common/src/util/node-process-scope.ts',
  'sdk/src/services/execution-launch.ts', 'sdk/src/__tests__/fixtures/b19-terminal-execution.ts',
  'sdk/src/__tests__/process-scope-transfer.test.ts', 'scripts/body-fixtures/b20-process-tree.mjs',
]
function sourceHashes() {
  return sourceFiles.map(file => {
    const bytes = fs.readFileSync(path.join(repoRoot, file))
    return { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }
  })
}
async function waitFor(predicate: () => boolean, timeout = 2_000) {
  const until = performance.now() + timeout
  while (!predicate() && performance.now() < until) await Bun.sleep(5)
  if (!predicate()) throw new Error('Real transfer control did not reach its declared observation within the bound')
}
function observedPid(pid: number) {
  try {
    const parsed = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
    return { pid, ...parsed, living: !['Z', 'X', 'x'].includes(parsed.state) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { pid, errorCode: code, living: code === 'ENOENT' || code === 'ESRCH' ? false : null }
  }
}
function readFixtureIdentity(directory: string, role: 'leader' | 'descendant') {
  const value = JSON.parse(fs.readFileSync(path.join(directory, `${role}.json`), 'utf8')) as { pid: number; stat: string }
  return { ...value, parsed: parseProcStat(value.stat) }
}

function ownerScope(host: ReturnType<typeof createTerminalExecutionFixture>, name: string, limit: Limit = { kind: 'unbounded' }) {
  const ownerAbort = new AbortController()
  const requestAbort = new AbortController()
  const capturedAtMs = performance.now()
  const boundary = executionValue(captureRootDeadline({ clock: host.clock, limit }))
  const lifetime = executionValue(host.authority.registerRootLifetime({ signal: ownerAbort.signal, boundary }))
  const jobOwner = {
    clientSessionId: `b20-transfer-${name}`, rootRunId: 'b20-transfer-run',
    parentRunId: 'b20-transfer-run', parentAgentId: name,
  }
  const registered = executionValue(host.authority.registerOwner({ description: { kind: 'run', owner: jobOwner }, lifetime }))
  const budget = executionValue(host.authority.registerAction({
    owner: registered.owner, parent: lifetime, limit: { kind: 'unbounded' },
    correlation: { kind: 'action', owner: jobOwner, actionId: randomUUID(), attemptId: 'b20-transfer-attempt', basisId: 'b20-transfer-basis' },
  }))
  const request = executionValue(host.authority.registerRequest({ budget, signal: requestAbort.signal }))
  const execution = executionValue(host.authority.bindAction({ owner: registered.owner, budget, request }))
  return { ...registered, ownerAbort, requestAbort, lifetime, budget, request, execution, boundary, capturedAtMs }
}

async function withRealLaunch(name: string, run: (control: {
  host: ReturnType<typeof createTerminalExecutionFixture>
  sender: ReturnType<typeof ownerScope>
  dispatch: NodeDispatchHandle
  resource: ResourceHandle
  senderResourceAbort: AbortController
  receipt: Record<string, unknown>
  registerReceiver: (limit?: Limit) => ReturnType<typeof ownerScope>
}) => Promise<void>, senderLimit: Limit = { kind: 'unbounded' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-postlaunch-transfer-'))
  const recorder = createRealExecutionProcessRecorder()
  const host = createTerminalExecutionFixture({ projectRoot: directory, spawn: recorder.spawn })
  const sender = ownerScope(host, 'sender', senderLimit)
  const senderResourceAbort = new AbortController()
  const receivers: ReturnType<typeof ownerScope>[] = []
  const receipt: Record<string, unknown> = {
    name, capturedAtUtc: new Date().toISOString(), proofTier: 'real-linux-sdk-node-dispatch-postlaunch-transfer',
    providerCalls: 0, sourceBefore: sourceHashes(), directory,
    senderBoundary: sender.boundary, senderCapturedAtMs: sender.capturedAtMs,
  }
  let dispatch: NodeDispatchHandle | undefined
  let failure: unknown
  try {
    const target = executionValue(captureNodeTarget({
      executionContext: { ...host.context, execution: sender.execution, signal: sender.execution.signal },
      executable: node!, argv: [treeFixture, directory, 'owner-cancel'], cwd: directory,
      family: 'sync-shell', processType: 'SYNC', branchId: 'b20.postlaunch-transfer',
      adapterOptions: { stdio: 'pipe', detached: true, shell: false, windowsHide: false },
    }))
    const destination = executionValue(host.authority.registerDestination({
      snapshotId: host.snapshotId, origin: 'host',
      resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} },
    }))
    const resource = executionValue(host.authority.registerResource({
      owner: sender.owner, lifetime: sender.lifetime, resourceSignal: senderResourceAbort.signal,
      destination, launchTemplate: target, reuse: 'none', restartPolicy: { kind: 'none' },
    }))
    const lease = executionValue(host.authority.acquireLease({ owner: sender.owner, resource, request: sender.request }))
    const launch = executionValue(host.authority.prepareLaunch({ budget: sender.budget, request: sender.request, resource, lease }))
    const permit = executionValue(await launch.admit()).permit
    dispatch = executionValue(dispatchNodeLaunch({ launch, permit }, input => recorder.spawn(input.executable, input.argv, {
      cwd: input.cwd, env: input.env, signal: input.resourceSignal,
      detached: input.adapterOptions.detached === true, shell: false, windowsHide: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })))
    const started = executionValue(await dispatch.started)
    await waitFor(() => {
      try { return Number.isSafeInteger(readFixtureIdentity(directory, 'descendant').pid) }
      catch { return false }
    })
    const leader = readFixtureIdentity(directory, 'leader')
    const descendant = readFixtureIdentity(directory, 'descendant')
    const leaderIdentity = readLinuxProcessIdentity(started.pid)
    const descendantIdentity = readLinuxProcessIdentity(descendant.pid)
    receipt.started = started
    receipt.launchFacts = dispatch.facts()
    receipt.dispatchResourceRemainingMs = dispatch.input.resourceRemainingMs
    receipt.leader = leader
    receipt.descendant = descendant
    receipt.initialIdentities = { leader: leaderIdentity, descendant: descendantIdentity }
    const initialObservation = await dispatch.scope.observe()
    receipt.initialObservation = initialObservation
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].spawnObserved).toBe(true)
    expect(dispatch.child.pid).toBe(started.pid)
    expect(leader.pid).toBe(started.pid)
    expect(leaderIdentity).toMatchObject({ pid: started.pid, pgid: started.pid, sid: started.pid })
    expect(descendantIdentity).toMatchObject({ pgid: started.pid, sid: started.pid, pidNamespace: leaderIdentity.pidNamespace })
    expect(observedPid(started.pid).living).toBe(true)
    expect(observedPid(descendant.pid).living).toBe(true)
    // Unrelated PIDs can disappear during the live /proc census. Preserve
    // its completeness observation and verify the actual owned members.
    expect(initialObservation).toMatchObject({ leader: 'running', scopePresence: 'living', identity: 'verified' })
    expect(typeof initialObservation.membershipComplete).toBe('boolean')
    expect(initialObservation.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: leaderIdentity, disposition: 'living' }),
      expect.objectContaining({ identity: descendantIdentity, disposition: 'living' }),
    ]))
    await run({ host, sender, dispatch, resource, senderResourceAbort, receipt,
      registerReceiver(limit) {
        const receiver = ownerScope(host, `receiver-${receivers.length}`, limit)
        receivers.push(receiver)
        return receiver
      },
    })
  } catch (error) {
    failure = error
    receipt.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }
  } finally {
    // Preserve all assertions' observations before teardown changes the scope.
    receipt.oracleBeforeTeardown = true
    receipt.passed = failure === undefined
    receipt.cleanup = dispatch?.scope.currentCleanup()
    receipt.finalObservation = dispatch ? await dispatch.scope.observe() : null
    receipt.independentFinalLeader = dispatch?.child.pid ? observedPid(dispatch.child.pid) : null
    try { receipt.independentFinalDescendant = observedPid(readFixtureIdentity(directory, 'descendant').pid) } catch { receipt.independentFinalDescendant = null }
    receipt.lateMarker = fs.existsSync(path.join(directory, 'late-marker'))
    receipt.events = [...host.events]
    receipt.dispatchCount = recorder.calls.length
    receipt.sourceAfter = sourceHashes()
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, `${name}-${Date.now()}-${randomUUID()}.json`), JSON.stringify(receipt, null, 2) + '\n')
    }
    try {
      if (dispatch) {
        const cleanup = await dispatch.scope.requestStop('owner-shutdown', true)
        if (cleanup.status !== 'complete') await dispatch.scope.retryCleanup(true)
      }
    } finally {
      sender.ownerAbort.abort(new Error('Transfer control teardown'))
      for (const receiver of receivers) receiver.ownerAbort.abort(new Error('Transfer receiver teardown'))
      host.dispose()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
  if (failure !== undefined) throw failure
}

describe.skipIf(process.platform !== 'linux')('real SDK NodeDispatch authenticated postlaunch transfer', () => {
  test.each(['receiver-cancel', 'receiver-deadline', 'original-deadline'] as const)('%s preserves physical scope and fences old sender cancellation', async mode => {
    await withRealLaunch(mode, async ({ host, sender, dispatch, resource, senderResourceAbort, receipt, registerReceiver }) => {
      const receiver = registerReceiver(mode === 'receiver-deadline' ? { kind: 'finite', durationMs: 250 } : { kind: 'unbounded' })
      const originalFacts = dispatch.facts()
      const originalPid = dispatch.child.pid!
      const originalScope = dispatch.scope
      const resourceSignal = dispatch.input.resourceSignal
      const offer = executionValue(host.authority.offerTransfer({ resource, sender: sender.owner, receiver: receiver.owner,
        request: sender.request, expectedGeneration: originalFacts.resourceGeneration }))
      const permit = executionValue(host.authority.acceptTransfer({ offer, receiver: receiver.receiver }))
      const transferred = executionValue(host.authority.commitTransfer(permit))
      const generation = executionValue(host.authority.resourceGeneration(transferred.resource))
      receipt.transfer = { transferId: transferred.transferId, previousGeneration: originalFacts.resourceGeneration, resourceGeneration: generation,
        originalResourceId: originalFacts.resourceId, physicalPid: originalPid, receiverBoundary: receiver.boundary,
        receiverCapturedAtMs: receiver.capturedAtMs }
      expect(generation).not.toBe(originalFacts.resourceGeneration)
      expect(dispatch.facts().resourceId).toBe(originalFacts.resourceId)
      expect(dispatch.child.pid).toBe(originalPid)
      expect(dispatch.scope).toBe(originalScope)
      expect(dispatch.input.resourceSignal).toBe(resourceSignal)
      const staleLease = host.authority.acquireLease({ owner: sender.owner, resource, request: sender.request })
      receipt.staleSenderLease = staleLease
      expect(staleLease).toMatchObject({ ok: false, reason: 'stale-authority' })

      sender.requestAbort.abort(new Error('Stale sender request abort'))
      senderResourceAbort.abort(new Error('Stale original resource signal abort'))
      sender.ownerAbort.abort(new Error('Stale sender owner abort'))
      await Bun.sleep(40)
      const receiverObservation = await dispatch.scope.observe()
      receipt.afterSenderAborts = { observation: receiverObservation, resourceSignalAborted: resourceSignal.aborted,
        currentCleanup: dispatch.scope.currentCleanup() ?? null, leader: observedPid(originalPid) }
      expect(resourceSignal.aborted).toBe(false)
      expect(dispatch.scope.currentCleanup()).toBeUndefined()
      expect(receiverObservation.scopePresence).toBe('living')
      expect(dispatch.child.exitCode).toBeNull()
      expect(dispatch.child.signalCode).toBeNull()
      const receiverLease = executionValue(host.authority.acquireLease({ owner: receiver.owner, resource: transferred.resource, request: receiver.request }))
      const use = executionValue(await host.authority.admitResourceUse({ resource: transferred.resource, request: receiver.request,
        lease: receiverLease, operationDigest: 'b20-same-physical-resource-receiver-read' }))
      const receiverPid = executionValue(host.authority.useResourceNow(use, () => dispatch.child.pid))
      receipt.receiverUsePid = receiverPid
      expect(receiverPid).toBe(originalPid)
      expect(host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)

      const cancelAtMs = performance.now()
      if (mode === 'receiver-cancel') receiver.ownerAbort.abort(new Error('Authentic receiver cancellation'))
      await waitFor(() => dispatch.scope.currentCleanup() !== undefined, 1_700)
      const cleanup = dispatch.scope.currentCleanup()!
      receipt.cleanupElapsedMs = performance.now() - (mode === 'original-deadline' ? sender.capturedAtMs
        : mode === 'receiver-deadline' ? receiver.capturedAtMs : cancelAtMs)
      receipt.cleanupObservedHostMs = host.clock.nowMs()
      receipt.receiverDeadline = host.authority.deadline(receiver.lifetime)
      receipt.cleanup = cleanup
      expect(cleanup.status).toBe('complete')
      expect(cleanup.trigger).toBe(mode === 'receiver-cancel' ? 'owner-cancel' : 'deadline')
      expect(cleanup.selectedTier).toBe('posix-owned-group')
      expect(cleanup.cleanupAuthorityRetained).toBe(false)
      expect(cleanup.finalObservation).toMatchObject({ leader: 'exited-reaped', membershipComplete: true, identity: 'verified',
        streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' } })
      expect(cleanup.finalObservation.members.some(member => member.disposition === 'living')).toBe(false)
      expect(cleanup.output.complete).toBe(true)
      expect(cleanup.selectedLimitSatisfied).toBe(true)
      expect(Number(receipt.cleanupElapsedMs)).toBeLessThan(1_650)
      const deadline = host.authority.deadline(receiver.lifetime)
      if (deadline.kind === 'finite') expect(host.clock.nowMs()).toBeLessThanOrEqual(deadline.expiresAtMs + 1_400)
      if (mode === 'original-deadline') {
        const original = sender.boundary.deadline
        const transferEvent = host.events.find(event => event.phase === 'resource-transferred')
        if (original.kind !== 'finite' || transferEvent?.phase !== 'resource-transferred' || transferEvent.resourceLifetime.kind !== 'finite') {
          throw new Error('Original finite cap was not recorded across real postlaunch transfer')
        }
        receipt.originalCap = { original, transferred: transferEvent.resourceLifetime,
          remainingAtDispatchMs: dispatch.input.resourceRemainingMs, observedCleanupHostMs: host.clock.nowMs() }
        expect(receiver.boundary.deadline.kind).toBe('unbounded')
        expect(transferEvent.resourceLifetime.expiresAtMs).toBe(original.expiresAtMs)
        expect(cleanup.originalDeadline).toEqual(originalFacts.deadlines.resourceLifetime)
        expect(host.clock.nowMs()).toBeLessThanOrEqual(original.expiresAtMs + 1_400)
        expect(dispatch.input.resourceRemainingMs).toBeGreaterThan(0)
        expect(dispatch.input.resourceRemainingMs).toBeLessThanOrEqual(250)
      }
      expect(resourceSignal.aborted).toBe(true)
      const descendant = receipt.descendant as ReturnType<typeof readFixtureIdentity>
      expect(observedPid(originalPid).living).toBe(false)
      expect(observedPid(descendant.pid).living).toBe(false)
      await Bun.sleep(700)
      expect(fs.existsSync(path.join(String(receipt.directory), 'late-marker'))).toBe(false)
    }, mode === 'original-deadline' ? { kind: 'finite', durationMs: 250 } : { kind: 'unbounded' })
  }, 10_000)

  test('an accepted transfer permit cannot commit after physical scope cleanup begins', async () => {
    await withRealLaunch('transfer-refused-after-stop', async ({ host, sender, dispatch, resource, receipt, registerReceiver }) => {
      const receiver = registerReceiver()
      const offer = executionValue(host.authority.offerTransfer({ resource, sender: sender.owner, receiver: receiver.owner,
        request: sender.request, expectedGeneration: dispatch.facts().resourceGeneration }))
      const permit = executionValue(host.authority.acceptTransfer({ offer, receiver: receiver.receiver }))
      const cleanupPromise = dispatch.scope.requestStop('job-kill')
      const refused = host.authority.commitTransfer(permit)
      receipt.refused = refused
      receipt.cleanupPublishedAtRefusal = dispatch.scope.currentCleanup() ?? null
      expect(refused).toMatchObject({ ok: false, reason: 'stale-authority', cause: 'Physical resource cleanup is committed' })
      expect(dispatch.scope.currentCleanup()).toBeUndefined()
      expect(host.events.some(event => event.phase === 'resource-transferred')).toBe(false)
      const cleanup = await cleanupPromise
      receipt.cleanup = cleanup
      expect(cleanup.status).toBe('complete')
      expect(cleanup.finalObservation.leader).toBe('exited-reaped')
      expect(cleanup.finalObservation.streams.stdout).toBe('drained')
      expect(cleanup.finalObservation.streams.stderr).toBe('drained')
      expect(cleanup.finalObservation.members.some(member => member.disposition === 'living')).toBe(false)
      const descendant = receipt.descendant as ReturnType<typeof readFixtureIdentity>
      expect(observedPid(dispatch.child.pid!).living).toBe(false)
      expect(observedPid(descendant.pid).living).toBe(false)
      await Bun.sleep(700)
      expect(fs.existsSync(path.join(String(receipt.directory), 'late-marker'))).toBe(false)
    })
  }, 10_000)
})
