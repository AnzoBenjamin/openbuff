import { describe, expect, test } from 'bun:test'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import type { Result, TargetDescription } from '@codebuff/common/types/contracts/execution-context'
import type { HostExecutionOptions } from '../host-execution'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function fixture(policy: 'balanced' | 'allow-all' | 'custom' = 'balanced') {
  const root = '/virtual/bootstrap-project'
  const captured = loadHostConfigSnapshot({ inputs: {
    environment: {}, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const clock = { domainId: 'bootstrap-guard-test', nowMs: () => 0 }
  let asyncCalls = 0, syncCalls = 0
  const authorizers: Partial<HostExecutionOptions> = policy === 'custom' ? {
    authorizeAsync: async () => { asyncCalls++; return { ok: true, basis: 'explicit-policy', decisionId: 'custom-allow' } },
    authorizeSync: () => { syncCalls++; return { ok: true, basis: 'explicit-sync-policy', decisionId: 'custom-allow' } },
  } : {}
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: {},
    approvalMode: policy === 'custom' ? 'allow-all' : policy, ...authorizers }))
  function prepare(extra: Partial<TargetDescription> = {}, direct = false) {
    const context = direct ? value(host.directOperation()).executionContext : host.bootstrap
    return value(context.execution.prepareTarget({ target: {
      executable: 'git', argv: ['rev-parse', '--show-toplevel'], cwd: root, projectRoot: root, allowedPaths: [root],
      profile: context.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell', branchId: 'bootstrap.guard-control',
      adapterOptions: { runtime: 'node', shell: false, stdio: 'ignore-pipe-pipe' }, ...extra,
    } }))
  }
  return { host, root, prepare, policyCalls: () => ({ asyncCalls, syncCalls }) }
}

describe('B19 fixed repository bootstrap authority', () => {
  const unrelated: Partial<TargetDescription>[] = [
    { executable: '/bin/sh', argv: ['-c', 'printf unrelated'] },
    { argv: ['branch', 'bootstrap-mutation'] },
    { argv: ['rev-parse', '--show-toplevel', 'HEAD'] },
    { executable: '/foreign/git' },
    { cwd: '/foreign/project' },
    { environmentOverlay: { GIT_DIR: '/foreign/.git' } },
    { shellCommandBytes: 'git rev-parse --show-toplevel' },
    { adapterOptions: { runtime: 'node', shell: true } },
    { processType: 'BACKGROUND' },
    { projectRoot: '/foreign/project' },
    { allowedPaths: ['/virtual/bootstrap-project', '/foreign/project'] },
  ]

  test.each(['balanced', 'allow-all', 'custom'] as const)('rejects unrelated targets before async/sync policy under %s', async policy => {
    const f = fixture(policy)
    for (const extra of unrelated) {
      for (const mode of ['assistant', 'user'] as const) {
        const asyncLaunch = f.prepare({ ...extra, mode })
        expect(await asyncLaunch.admit()).toMatchObject({ ok: false, reason: 'denied' })
        const syncLaunch = f.prepare({ ...extra, mode })
        expect(syncLaunch.admitSync()).toMatchObject({ ok: false, reason: 'denied' })
      }
    }
    expect(f.policyCalls()).toEqual({ asyncCalls: 0, syncCalls: 0 })
    expect(f.host.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  test.each(['balanced', 'allow-all', 'custom'] as const)('admits both exact identity queries under %s', async policy => {
    const f = fixture(policy)
    for (const query of ['--show-toplevel', '--git-common-dir']) {
      expect((await f.prepare({ argv: ['rev-parse', query] }).admit()).ok).toBe(true)
      expect(f.prepare({ argv: ['rev-parse', query] }).admitSync().ok).toBe(true)
    }
    expect(f.policyCalls()).toEqual(policy === 'custom' ? { asyncCalls: 2, syncCalls: 2 } : { asyncCalls: 0, syncCalls: 0 })
  })

  test('ordinary explicit direct operations keep their own policy', async () => {
    const f = fixture('custom')
    expect((await f.prepare({ executable: '/bin/sh', argv: ['-c', 'printf ordinary'] }, true).admit()).ok).toBe(true)
    expect(f.prepare({ executable: 'git', argv: ['branch', 'direct-selection'] }, true).admitSync().ok).toBe(true)
    expect(f.policyCalls()).toEqual({ asyncCalls: 1, syncCalls: 1 })
  })
})
