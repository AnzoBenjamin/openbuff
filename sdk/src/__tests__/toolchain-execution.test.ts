import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'bun:test'

import { clearHarnessToolsCache, inspectHarnessEnvironment } from '../services/harness-intelligence'
import { resolveOwningTargets, resolveOwningTargetsAsync } from '../services/build-graph'
import { runSemgrepBaseline } from '../services/semgrep-baseline'
import { observeNodeChild, runToolchainNode, runToolchainSync, ToolchainExecutionError } from '../services/toolchain-execution'
import { executionFixture } from './toolchain-execution-fixture'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { Refusal } from '@codebuff/common/types/contracts/execution-context'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const value = mkdtempSync(join(tmpdir(), 'openbuff-b19-unit-')); roots.push(value); return value }

function capturedSpawn(output: (command: string) => string, calls: Array<{ command: string; args: readonly string[]; options: unknown }>): CodebuffSpawn {
  return (command, args = [], options) => {
    calls.push({ command, args: [...args], options })
    const child = new EventEmitter() as ReturnType<CodebuffSpawn>
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    queueMicrotask(() => { child.stdout!.emit('data', Buffer.from(output(command))); child.emit('close', 0) })
    // This fake intentionally emits no spawn event and offers no PID.
    return child
  }
}

describe('toolchain execution adapters', () => {
  for (const reason of ['denied', 'unavailable', 'cancelled', 'deadline-exhausted', 'stale-authority'] as const) {
    test(`${reason} launches no async or sync target`, async () => {
      const fixture = executionFixture({ refusal: { ok: false, reason, cause: reason } satisfies Refusal })
      let launches = 0
      fixture.context = { ...fixture.context, spawn: () => { launches++; throw new Error('must not spawn') } }
      const input = { context: fixture.context, branchId: 'build.async-production.cargo', argv: [process.execPath, '-e', 'process.exit(99)'], cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 1024 }
      await expect(runToolchainNode(input)).rejects.toBeInstanceOf(ToolchainExecutionError)
      expect(() => runToolchainSync(input)).toThrow(ToolchainExecutionError)
      expect(launches).toBe(0)
      expect(fixture.dispatches).toBe(0)
    })
  }

  test('captures exact argv before deferred admission and never observes a fake PID', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const fixture = executionFixture({ wait, env: { B19_ALLOWED: 'captured' } })
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
    const context = { ...fixture.context, spawn: capturedSpawn(() => 'ok', calls) }
    const argv = ['fixture-tool', 'a b', '$(never-execute)']
    const result = runToolchainNode({ context, branchId: 'version.node', argv, cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 16 })
    argv[1] = 'mutated'
    release()
    expect((await result).stdout).toBe('ok')
    expect(calls[0].args).toEqual(['a b', '$(never-execute)'])
    expect(calls[0].options).toMatchObject({ env: { B19_ALLOWED: 'captured' } })
    expect(fixture.observations).toEqual([])
  })

  test('cancelling an admission wait never dispatches after its policy completes', async () => {
    let release!: () => void
    const fixture = executionFixture({ wait: new Promise<void>(resolve => { release = resolve }) })
    const controller = new AbortController()
    const pending = runToolchainNode({ context: { ...fixture.context, signal: controller.signal },
      branchId: 'version.node', argv: [process.execPath, '-e', 'process.exit(99)'], cwd: process.cwd(), timeoutMs: 1000, maxBufferBytes: 1024 })
    const checked = pending.then(() => undefined, error => error as Error)
    controller.abort(new Error('request cancelled'))
    const error = await checked
    expect(error).toBeInstanceOf(ToolchainExecutionError)
    expect(error?.message).toBe('request cancelled')
    expect((error as ToolchainExecutionError).refusal).toMatchObject({ reason: 'cancelled', cause: 'request cancelled' })
    release()
    await Promise.resolve()
    expect(fixture.dispatches).toBe(0)
  })

  test('real async runtime output and start observation stay distinct from ENOENT', async () => {
    const fixture = executionFixture({ env: { B19_ALLOWED: 'captured' } })
    const result = await runToolchainNode({ context: fixture.context, branchId: 'version.node', argv: [process.execPath, '--no-env-file', '-e', 'process.stdout.write(process.env.B19_ALLOWED)'], cwd: process.cwd(), timeoutMs: 2_000, maxBufferBytes: 1024 })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'captured' })
    expect(fixture.observations.some(value => value.phase === 'spawn-observed' && Number.isInteger(value.pid) && Number(value.pid) > 0)).toBe(true)
    const missing = executionFixture()
    const absent = await runToolchainNode({ context: missing.context, branchId: 'version.node', argv: ['/openbuff-b19-missing-executable'], cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 1024 })
    expect(absent.exitCode).toBe(-1)
    expect(missing.observations.some(value => value.phase === 'spawn-observed')).toBe(false)
    expect(missing.observations.some(value => value.phase === 'dispatch-failed')).toBe(true)
  })

  test('real spawnSync records a returned PID and exact replacement environment', () => {
    const fixture = executionFixture({ env: { B19_ALLOWED: 'sync' } })
    const result = runToolchainSync({ context: fixture.context, branchId: 'build.sync-legacy.cargo', argv: [process.execPath, '--no-env-file', '-e', 'process.stdout.write(process.env.B19_ALLOWED)'], cwd: process.cwd(), timeoutMs: 2_000, maxBufferBytes: 1024 })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'sync' })
    expect(fixture.observations.some(value => value.source === 'spawn-sync-result' && Number(value.pid) > 0)).toBe(true)
  })

  test('a Node error after observed start preserves both observations', () => {
    const fixture = executionFixture()
    const prepared = fixture.context.execution.prepareTarget({ target: { executable: 'fixture', argv: [], cwd: '/', projectRoot: '/', allowedPaths: ['/'], mode: 'assistant', processType: 'SYNC', profile: fixture.context.profile, family: 'diagnostic-build-version-scip', branchId: 'version.node', adapterOptions: { runtime: 'node' } } })
    if (!prepared.ok) throw new Error('fixture preparation failed')
    const admitted = prepared.value.admitSync()
    if (!admitted.ok) throw new Error('fixture admission failed')
    prepared.value.dispatchNow(admitted.value.permit, (_input, observer) => {
      const child = new EventEmitter() as ReturnType<CodebuffSpawn>
      Object.assign(child, { pid: 42 })
      observeNodeChild(child, observer)
      child.emit('spawn')
      child.emit('error', Object.assign(new Error('injected adapter error'), { code: 'EIO' }))
    })
    expect(fixture.observations.map(value => value.phase)).toEqual(['spawn-observed', 'dispatch-failed'])
    // This is injected ordering evidence, never a claim that PID 42 was real.
  })

  test('environment inspection reaches all fourteen exact command vectors', async () => {
    const cwd = root()
    const fixture = executionFixture()
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
    const context = { ...fixture.context, projectRoot: cwd, allowedPaths: [cwd], spawn: capturedSpawn(() => 'fixture-version', calls) }
    const result = await inspectHarnessEnvironment(cwd, undefined, context)
    expect(calls.map(call => [call.command, ...call.args])).toEqual([
      ['git', '--version'], ['bun', '--version'], ['node', '--version'], ['python3', '--version'],
      ['rustc', '--version'], ['go', 'version'], ['k6', '--version'], ['cargo', '--version'],
      ['uv', '--version'], ['poetry', '--version'], ['mvn', '--version'], ['gradle', '--version'],
      ['dotnet', '--version'], ['blender', '--version'],
    ])
    expect(Object.keys(result.tools)).toHaveLength(14)
    expect(fixture.targets.map(target => target.branchId)).toEqual(calls.map(call => `version.${call.command}`))
    expect(fixture.observations).toEqual([])
  })

  test('production owning-target discovery reaches async Cargo and Go adapters', async () => {
    const cwd = root()
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname="fixture"\n')
    writeFileSync(join(cwd, 'go.mod'), 'module example.test/fixture\n')
    const fixture = executionFixture()
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
    const context = { ...fixture.context, projectRoot: cwd, allowedPaths: [cwd], spawn: capturedSpawn(command => command === 'cargo' ? JSON.stringify({ packages: [] }) : JSON.stringify({ ImportPath: 'example.test/fixture', Dir: cwd }), calls) }
    await resolveOwningTargetsAsync({ cwd, files: ['file.go'], executionContext: context })
    expect(calls.map(call => [call.command, ...call.args])).toEqual([['cargo', 'metadata', '--no-deps', '--format-version', '1'], ['go', 'list', '-json', './...']])
    expect(fixture.targets.map(target => target.branchId)).toEqual(['build.async-production.cargo', 'build.async-production.go'])
  })

  test('legacy owning-target discovery mediates both real sync Cargo and Go fixtures', () => {
    const cwd = root()
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname="fixture"\n')
    writeFileSync(join(cwd, 'go.mod'), 'module example.test/fixture\n')
    writeFileSync(join(cwd, 'cargo'), '#!/bin/sh\nprintf \'%s\' \'{"packages":[]}\'\n', { mode: 0o755 })
    writeFileSync(join(cwd, 'go'), '#!/bin/sh\nprintf \'%s\' \'{}\'\n', { mode: 0o755 })
    const fixture = executionFixture({ env: { PATH: cwd } })
    resolveOwningTargets({ cwd, files: ['file.go'], executionContext: { ...fixture.context, projectRoot: cwd, allowedPaths: [cwd] } })
    expect(fixture.targets.map(target => target.branchId)).toEqual(['build.sync-legacy.cargo', 'build.sync-legacy.go'])
    expect(fixture.observations.filter(value => value.phase === 'spawn-observed')).toHaveLength(2)
    expect(fixture.dispatches).toBe(2)
  })

  test('Semgrep version and scan each admit an exact launch using a real fixture binary', async () => {
    const cwd = root()
    writeFileSync(join(cwd, 'semgrep'), `#!/bin/sh
if [ "$1" = --version ]; then printf '%s' '1.0.0'; else printf '%s' '{"version":"2.1.0","runs":[]}'; fi
`, { mode: 0o755 })
    const fixture = executionFixture({ env: { PATH: cwd } })
    const context = { ...fixture.context, projectRoot: cwd, allowedPaths: [cwd] }
    const result = await runSemgrepBaseline({ cwd, baselineCommit: 'abc1234', files: ['file.py'], executionContext: context })
    expect(result.status).toBe('ok')
    expect(fixture.targets.map(target => target.branchId)).toEqual(['semgrep.version', 'semgrep.scan'])
    expect(fixture.targets[0].argv).toEqual(['--version'])
    expect(fixture.targets[1].argv).toEqual(['scan', '--baseline-commit=abc1234', '--sarif', '--quiet', '--metrics=off', '--no-git-ignore', '--include', 'file.py'])
    expect(fixture.observations.filter(value => value.phase === 'spawn-observed')).toHaveLength(2)
    expect((await runSemgrepBaseline({ cwd, baselineCommit: 'abc1234', files: ['file.py'], executionContext: context })).status).toBe('ok')
    expect(fixture.targets.map(target => target.branchId)).toEqual(['semgrep.version', 'semgrep.scan', 'semgrep.scan'])
  })

  test('Semgrep preserves scan admission refusal after a successful version probe', async () => {
    const cwd = root()
    const fixture = executionFixture({ refusalFor: target => target.branchId === 'semgrep.scan' ? { ok: false, reason: 'deadline-exhausted', cause: 'scan expired' } : undefined })
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
    const result = await runSemgrepBaseline({ cwd, baselineCommit: 'abc1234', files: ['file.py'], executionContext: { ...fixture.context, spawn: capturedSpawn(() => '1.0.0', calls) } })
    expect(result).toMatchObject({ status: 'error', executionRefusal: { reason: 'deadline-exhausted' } })
    expect(calls).toHaveLength(1)
  })

  test('Semgrep pre-cancelled requests start no availability probe', async () => {
    const fixture = executionFixture()
    const controller = new AbortController(); controller.abort()
    const result = await runSemgrepBaseline({ cwd: root(), baselineCommit: 'abc1234', files: ['file.py'], executionContext: fixture.context, signal: controller.signal })
    expect(result).toMatchObject({ status: 'error', executionRefusal: { reason: 'cancelled' } })
    expect(fixture.targets).toHaveLength(0)
  })

  test('version results share a settled TTL only within the same captured context', async () => {
    const cwd = root()
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
    const fixture = executionFixture()
    const context = { ...fixture.context, projectRoot: cwd, allowedPaths: [cwd], spawn: capturedSpawn(() => 'fixture-version', calls) }
    const first = await inspectHarnessEnvironment(cwd, undefined, context)
    const again = await inspectHarnessEnvironment(cwd, undefined, context)
    expect(again.tools).toBe(first.tools)
    expect(calls).toHaveLength(14)
    const foreign = { ...context, profile: { ...context.profile, policy: 'workspace-write' as const } }
    await inspectHarnessEnvironment(cwd, undefined, foreign)
    expect(calls).toHaveLength(28)
    clearHarnessToolsCache()
    await inspectHarnessEnvironment(cwd, undefined, context)
    expect(calls).toHaveLength(42)
  })
})
