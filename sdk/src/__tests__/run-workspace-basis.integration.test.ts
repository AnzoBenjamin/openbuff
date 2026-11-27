import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { handleToolCall } from '../run'
import { createActionWorkspaceBasis } from '../services/action-workspace-basis'
import { captureNodeTarget } from '../services/execution-launch'
import { createLanguageIntelligence } from '../services/language-intelligence'
import { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { ChildProcess } from 'node:child_process'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { LaunchEvent, Refusal } from '@codebuff/common/types/contracts/execution-context'

const roots: string[] = [], children: ChildProcess[] = [], stops: AbortController[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('confirmed mutation admission before document synchronization', () => {
  test.each([false, true])('trusted transition callback=%s controls same-action post-commit launch', async authorizeTransition => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-basis-sync-')); roots.push(root)
    const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd)
    const config = path.join(cwd, 'openbuff.json'); fs.writeFileSync(config, '{}')
    const snapshot = loadHostConfigSnapshot({ fs: nodeConfigReadFs, inputs: {
      environment: { PATH: '/usr/bin:/bin' }, platform: 'linux', invocationCwd: cwd, projectRoot: cwd,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    } })
    if (snapshot.status !== 'complete') throw new Error(snapshot.cause)
    const boundary = captureRootDeadline({ clock: executionClock, limit: { kind: 'unbounded' } })
    if (!boundary.ok) throw new Error(boundary.cause)
    const stop = new AbortController(); stops.push(stop)
    let workspace = createInitialWorkspaceState(1)
    const input = { path: 'new.ts', content: 'export const value = 1\n', instructions: 'Create a file' }
    const basisInput = { inputHash: hashActionInput('write_file', input), workspaceRevision: workspace.revision }
    const identity: ToolExecutionIdentity = { runId: 'run', rootRunId: 'run', agentId: 'agent', actionId: 'write-action', attemptId: 'attempt',
      basis: basisInput, workspaceSnapshotId: workspace.snapshotId,
      basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis: basisInput, workspaceSnapshotId: workspace.snapshotId }) }
    const originalIdentity = JSON.stringify(identity)
    const basis = createActionWorkspaceBasis(identity, workspace)
    const events: LaunchEvent[] = []
    const host = createHostExecutionServices({ snapshot: snapshot.snapshot, boundary: boundary.value,
      childInheritanceEnvironment: {}, signal: stop.signal, approvalMode: 'allow-all',
      profile: { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false },
      record: event => { events.push(event) },
      isCurrentBasis: correlation => correlation.kind !== 'action' || basis.isCurrent(correlation.basisId, workspace),
    })
    if (!host.ok) throw new Error(host.cause)
    const owner = { clientSessionId: 'session', rootRunId: 'run', parentRunId: 'run', parentAgentId: 'agent' }
    const scope = host.value.registerRun(owner)
    if (!scope.ok) throw new Error(scope.cause)
    const context = scope.value.action({ actionId: identity.actionId, attemptId: identity.attemptId, basisId: identity.basisId })
    if (!context.ok) throw new Error(context.cause)
    const broker = await WorkspaceMutationBroker.create({ cwd, stateDir: path.join(root, 'state'), executionContext: host.value.bootstrap })
    const fileSystem = createNodeFileSystem({ mutationBroker: broker })
    let syncRefusal: Refusal | undefined, syncedOutput: string | undefined
    const language = { ...createLanguageIntelligence({ cwd, fs: fileSystem, readPolicy: snapshot.snapshot.readPolicy }),
      syncMutatedFiles: async (files: string[], _options?: unknown, request?: { execution: typeof context.value.execution }) => {
        expect(files).toEqual(['new.ts'])
        expect(request?.execution).toBe(context.value.execution)
        const target = captureNodeTarget({ executionContext: context.value, executable: '/usr/bin/printf', argv: ['synchronized'], cwd,
          branchId: 'test.post-commit-sync', family: 'lsp', adapterOptions: { stdio: 'pipe' } })
        if (!target.ok) throw new Error(target.cause)
        const launch = request!.execution.prepareTarget({ target: target.value })
        if (!launch.ok) { syncRefusal = launch; return }
        const admission = await launch.value.admit()
        if (!admission.ok) { syncRefusal = admission; return }
        const dispatched = launch.value.dispatchNow(admission.value.permit, (exact, observer) => {
          const child = spawn(exact.executable, [...exact.argv], { cwd: exact.cwd, env: exact.env, signal: exact.resourceSignal, stdio: 'pipe' })
          children.push(child)
          child.once('spawn', () => observer.spawnObserved({ source: 'node-spawn-event', pid: child.pid! }))
          child.on('error', error => observer.failure({ source: 'node-error-event', cause: error.message }))
          return child
        })
        if (!dispatched.ok) throw new Error(dispatched.cause)
        let stdout = ''
        dispatched.value.handle.stdout!.on('data', chunk => { stdout += String(chunk) })
        await new Promise<void>((resolve, reject) => {
          dispatched.value.handle.once('error', reject)
          dispatched.value.handle.once('close', code => code === 0 ? resolve() : reject(new Error(`Sync fixture exited ${code}`)))
        })
        syncedOutput = stdout
      } }
    const result = await handleToolCall({ action: { type: 'tool-call-request', requestId: identity.actionId, userInputId: 'user', toolName: 'write_file', input: { ...input, type: 'file' } },
      overrides: {}, customToolDefinitions: {}, cwd, fs: fileSystem, trustedJobOwner: owner, approvalReceiptIds: [], approvalMode: 'allow-all',
      executionContext: context.value, getWorkspaceState: () => workspace, setWorkspaceState: value => { workspace = value },
      getLanguageIntelligence: () => language,
      ...(authorizeTransition ? { onConfirmedWorkspaceTransition: transition => { expect(basis.confirmTransition(transition)).toBe(true) } } : {}),
    })
    if (!result.canonicalReceipt) throw new Error(`Mutation did not return an authority receipt: ${JSON.stringify(result.output)}`)
    expect(fs.readFileSync(path.join(cwd, 'new.ts'), 'utf8')).toBe(input.content)
    expect(result.canonicalReceipt?.status).toBe('committed')
    expect(workspace.revision).toBe(1)
    expect(JSON.stringify(identity)).toBe(originalIdentity)
    const syncStarts = events.filter((event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
      event.phase === 'spawn-observed' && event.facts.branchId === 'test.post-commit-sync')
    if (authorizeTransition) {
      expect(syncRefusal).toBeUndefined(); expect(syncedOutput).toBe('synchronized'); expect(syncStarts).toHaveLength(1)
      expect(syncStarts[0].facts.correlation).toMatchObject({ kind: 'action', actionId: identity.actionId, basisId: identity.basisId })
    } else {
      expect(syncRefusal?.reason).toBe('stale-authority'); expect(syncStarts).toHaveLength(0); expect(syncedOutput).toBeUndefined()
    }
  }, 10_000)
})
