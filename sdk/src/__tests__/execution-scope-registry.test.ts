import { describe, expect, test } from 'bun:test'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createExecutionScopeRegistry } from '../services/execution-scope-registry'
import type { Result } from '@codebuff/common/types/contracts/execution-context'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function fixture() {
  const root = '/virtual/execution-scope'
  const captured = loadHostConfigSnapshot({ inputs: {
    environment: {}, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  let now = 0
  const clock = { domainId: 'scope-registry-test', nowMs: () => now }
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: {} }))
  const scope = value(host.registerRun({ clientSessionId: 'session', rootRunId: 'root', parentRunId: 'root', parentAgentId: 'agent' }))
  const context = value(scope.action({ actionId: 'action', attemptId: 'attempt', basisId: 'basis' }))
  const registry = createExecutionScopeRegistry(host.execution)
  return { host, scope, context, registry, setTime: (time: number) => { now = time } }
}

describe('B19 authenticated execution scope resolution', () => {
  test('authentic derived action and internal-operation ports resolve their registered owner', () => {
    const f = fixture()
    value(f.registry.register(f.context.execution, f.scope))
    const derived = value(f.context.execution.derive({ memoKey: 'lsp-request', limit: { kind: 'finite', durationMs: 100 } }))
    expect(derived).not.toBe(f.context.execution)
    expect(value(f.registry.resolve(derived))).toBe(f.scope)
    const operation = value(f.scope.operation())
    value(f.registry.register(operation.execution, f.scope))
    const derivedOperation = value(operation.execution.derive({ memoKey: 'lsp-operation', limit: { kind: 'unbounded' } }))
    expect(value(f.registry.resolve(derivedOperation))).toBe(f.scope)
  })

  test('copied, foreign and unregistered ports cannot resolve or overwrite an owner', () => {
    const f = fixture(), foreign = fixture()
    value(f.registry.register(f.context.execution, f.scope))
    expect(f.registry.resolve({ ...f.context.execution })).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(f.registry.resolve(foreign.context.execution)).toMatchObject({ ok: false, reason: 'stale-authority' })
    const other = value(f.host.registerRun({ clientSessionId: 'session', rootRunId: 'root', parentRunId: 'child', parentAgentId: 'child-agent' }))
    expect(f.registry.register(f.context.execution, other)).toMatchObject({ ok: false, reason: 'stale-authority' })
    const unregistered = value(f.scope.action({ actionId: 'other-action', attemptId: 'attempt', basisId: 'basis' }))
    expect(f.registry.resolve(unregistered.execution)).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(value(f.registry.resolve(f.context.execution))).toBe(f.scope)
  })

  test('resolution preserves the derived request cancellation and deadline', () => {
    const f = fixture(), stop = new AbortController()
    value(f.registry.register(f.context.execution, f.scope))
    const cancelledAction = value(f.scope.action({ actionId: 'cancelled-action', attemptId: 'attempt', basisId: 'basis', signal: stop.signal }))
    value(f.registry.register(cancelledAction.execution, f.scope))
    const cancelled = value(cancelledAction.execution.derive({ memoKey: 'cancelled-lsp', limit: { kind: 'unbounded' } }))
    stop.abort(new Error('request cancelled'))
    expect(f.registry.resolve(cancelled)).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(value(f.registry.resolve(f.context.execution))).toBe(f.scope)
    const finite = value(f.context.execution.derive({ memoKey: 'finite-lsp', limit: { kind: 'finite', durationMs: 100 } }))
    f.setTime(100)
    expect(f.registry.resolve(finite)).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(value(f.registry.resolve(f.context.execution))).toBe(f.scope)
  })
})
