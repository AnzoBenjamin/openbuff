import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { executionFixture } from '../../../sdk/src/__tests__/toolchain-execution-fixture'
import { defaultAsyncScipRunner, defaultScipRunner, detectAvailableScipIndexers, detectAvailableScipIndexersAsync, runScipIngest, ScipExecutionError, SCIP_INDEXER_COMMANDS } from './scip-runner'
import type { Refusal } from '@codebuff/common/types/contracts/execution-context'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function binaries(options: Parameters<typeof executionFixture>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-b19-scip-')); roots.push(root)
  const record = join(root, 'launches')
  for (const entry of SCIP_INDEXER_COMMANDS) writeFileSync(join(root, entry.bin), `#!/bin/sh
printf '%s|%s|%s\\n' "$0" "$1" "$B19_SCIP_ALLOWED" >> "$B19_SCIP_RECORD"
if [ "$1" = index ]; then printf '%s' '{"documents":[]}' > "$3"; fi
`, { mode: 0o755 })
  const fixture = executionFixture({ ...options, env: { PATH: root, B19_SCIP_RECORD: record, B19_SCIP_ALLOWED: 'captured' } })
  const context = { ...fixture.context, projectRoot: root, allowedPaths: [root] }
  return { root, record, fixture, context }
}

for (const runtime of ['async', 'sync'] as const) test(`SCIP ${runtime} detect/index routes all eight exact binary vectors through admission`, async () => {
  const { root, record, fixture, context } = binaries()
  const available = runtime === 'sync'
    ? detectAvailableScipIndexers(root, { executionContext: context })
    : await detectAvailableScipIndexersAsync(root, { executionContext: context })
  expect(available).toEqual(SCIP_INDEXER_COMMANDS.map(entry => entry.id))
  const result = await runScipIngest(root, { executionContext: context, ...(runtime === 'sync' ? { runner: defaultScipRunner } : {}) })
  expect(result.results.map(entry => entry.status)).toEqual(Array(8).fill('ok'))
  expect(fixture.targets.map(target => target.branchId).sort()).toEqual(SCIP_INDEXER_COMMANDS.flatMap(entry => [`scip.${runtime}.detect.${entry.id}`, `scip.${runtime}.index.${entry.id}`]).sort())
  expect(fixture.targets.every(target => target.adapterOptions.runtime === (runtime === 'sync' ? 'spawn-sync' : 'node'))).toBe(true)
  expect(fixture.targets.filter(target => target.branchId.includes('.detect.')).every(target => JSON.stringify(target.argv) === '["--version"]')).toBe(true)
  expect(fixture.targets.filter(target => target.branchId.includes('.index.')).every(target => target.argv[0] === 'index' && target.argv[1] === '--output' && target.cwd === root)).toBe(true)
  const observed = readFileSync(record, 'utf8').trim().split('\n')
  expect(observed).toHaveLength(16)
  expect(observed.every(line => line.endsWith('|captured'))).toBe(true)
  expect(fixture.observations.filter(value => value.phase === 'spawn-observed')).toHaveLength(16)
  expect(fixture.dispatches).toBe(16)
})

for (const reason of ['denied', 'unavailable', 'cancelled', 'deadline-exhausted', 'stale-authority'] as const) test(`SCIP ${reason} remains a refusal and launches nothing`, async () => {
  const refusal = { ok: false, reason, cause: 'injected admission result' } satisfies Refusal
  const { root, fixture, context } = binaries({ refusal })
  const result = await runScipIngest(root, { executionContext: context, indexers: ['typescript'] })
  expect(result.results[0].executionRefusal).toEqual(refusal)
  expect(result.results[0].error).not.toContain('not available (detection exit')
  expect(() => detectAvailableScipIndexers(root, { executionContext: context })).toThrow(ScipExecutionError)
  expect(fixture.dispatches).toBe(0)
})

test('SCIP refuses index after successful detection when authority expires', async () => {
  const { root, fixture, context } = binaries({ refusalFor: target => target.branchId.includes('.index.') ? { ok: false, reason: 'deadline-exhausted', cause: 'expired between detect and index' } : undefined })
  const result = await runScipIngest(root, { executionContext: context, indexers: ['typescript'] })
  expect(result.results[0]).toMatchObject({ status: 'error', executionRefusal: { reason: 'deadline-exhausted' } })
  expect(fixture.dispatches).toBe(1)
})

test('SCIP refusal is retried rather than cached as a missing binary', async () => {
  let denied = true
  const { root, fixture, context } = binaries({ refusalFor: () => denied ? { ok: false, reason: 'denied', cause: 'temporary test denial' } : undefined })
  await expect(detectAvailableScipIndexersAsync(root, { executionContext: context })).rejects.toBeInstanceOf(ScipExecutionError)
  denied = false
  expect(await detectAvailableScipIndexersAsync(root, { executionContext: context })).toHaveLength(8)
  expect(fixture.dispatches).toBe(8)
})

test('SCIP default runners require an execution context', async () => {
  const invocation = { command: process.execPath, argv: ['-e', 'process.exit(99)'], cwd: process.cwd(), timeoutMs: 100, maxBufferBytes: 100 }
  expect(() => defaultScipRunner(invocation)).toThrow(ScipExecutionError)
  await expect(defaultAsyncScipRunner(invocation)).rejects.toBeInstanceOf(ScipExecutionError)
})

test('SCIP caller cancellation while admission waits dispatches nothing', async () => {
  let release!: () => void
  const state = binaries({ wait: new Promise<void>(resolve => { release = resolve }) })
  const controller = new AbortController()
  const pending = defaultAsyncScipRunner({ command: 'scip-typescript', argv: ['--version'], cwd: state.root,
    timeoutMs: 1000, maxBufferBytes: 1024, executionContext: { ...state.context, signal: controller.signal } })
  const checked = pending.then(() => undefined, error => error)
  controller.abort()
  expect(await checked).toBeInstanceOf(ScipExecutionError)
  release()
  await Promise.resolve()
  expect(state.fixture.dispatches).toBe(0)
})
