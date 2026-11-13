import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { computeWorktreeSnapshotIdentity, getChangeReviewBundle } from '../tools/get-change-review-bundle'
import { runGitBounded } from '../tools/git-status'
import { runTargetedValidation } from '../tools/run-targeted-validation'
import {
  advanceWorkspaceState,
  createInitialWorkspaceState,
} from '@codebuff/common/types/workspace-state'

import type { SemgrepRunner } from '../services/semgrep-baseline'


import {
  createControlledExecutionClock,
  createExecutionProcessRecorder,
  createTerminalExecutionFixture,
  executionDeadlineMs,
} from './fixtures/b19-terminal-execution'
import { executionRefusal } from '../services/execution-launch'
import type { AsyncDecision } from '@codebuff/common/types/contracts/execution-context'

const executionHosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
const capturedChildEnvironment: Record<string, string | undefined> = { PATH: '/usr/bin:/bin' }
afterEach(() => { for (const host of executionHosts.splice(0)) host.dispose() })
function capturedExecution(cwd: string, signal?: AbortSignal) {
  const host = createTerminalExecutionFixture({ projectRoot: cwd, signal, environment: capturedChildEnvironment })
  executionHosts.push(host)
  return host.context
}

function getMediatedBundle(params: Parameters<typeof getChangeReviewBundle>[0]) {
  return getChangeReviewBundle({ ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal) })
}
function runMediatedValidation(params: Parameters<typeof runTargetedValidation>[0]) {
  return runTargetedValidation({
    ...params,
    executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal),
    capturedConfiguration: params.capturedConfiguration ?? { autoFileChangeHooks: false, fileChangeHooks: [] },
  })
}

function runMediatedGitBounded(
  args: Parameters<typeof runGitBounded>[0], cwd: string, signal: AbortSignal | undefined,
  options: Parameters<typeof runGitBounded>[3],
) {
  return runGitBounded(args, cwd, signal, {
    ...options, executionContext: options.executionContext ?? capturedExecution(cwd, signal),
    branchId: options.branchId ?? 'fixture.snapshot.raw',
  })
}

describe('B19 targeted validation execution controls', () => {
  function recorder() {
    return createExecutionProcessRecorder({ reply: (executable, argv) => {
      if (executable !== 'git') throw new Error('Unexpected validation fixture executable')
      if (argv[0] === 'rev-parse' && argv[1] === 'HEAD~1') return { exitCode: 128, stderr: 'initial commit has no parent' }
      if (argv[0] === 'rev-parse') return { stdout: `${'a'.repeat(40)}\n` }
      return { stdout: '' }
    } })
  }

  function host(options: Parameters<typeof createTerminalExecutionFixture>[0]) {
    const result = createTerminalExecutionFixture({ projectRoot: '/repo', ...options })
    executionHosts.push(result)
    return result
  }

  async function seedSnapshot(captured: ReturnType<typeof createTerminalExecutionFixture>) {
    const result = await computeWorktreeSnapshotIdentity({ cwd: '/repo', executionContext: captured.context, phase: 'seed' })
    if ('errorMessage' in result) throw new Error(result.errorMessage)
    return result.snapshotId
  }

  test('before and after snapshot caps are separate and both retain the original action cap', async () => {
    const manual = createControlledExecutionClock()
    const processes = recorder()
    const captured = host({
      ...manual, spawn: processes.spawn, actionLimit: { kind: 'finite', durationMs: 20_000 },
      authorize: input => {
        if (input.facts.branchId === 'bundle.snapshot-head' && input.target.adapterOptions.phase === 'before') manual.advance(9_000)
        return { ok: true, basis: 'explicit-policy', decisionId: 'validation-cap-control' }
      },
    })
    const snapshotId = await seedSnapshot(captured)
    const output = await runTargetedValidation({
      cwd: '/repo', snapshotId, files: ['README.md'], executionContext: captured.context,
      capturedConfiguration: { fileChangeHooks: [] },
      runHooks: async () => {
        manual.advance(2_000)
        return [{ type: 'json', value: [{ command: 'fixture validation', hookName: 'fixture', exitCode: 0 }] }]
      },
    })
    expect(output[0].value).toMatchObject({ status: 'passed', assurance: 'full' })
    const heads = captured.policyInputs.filter(input => input.facts.branchId === 'bundle.snapshot-head')
    const before = heads.find(input => input.target.adapterOptions.phase === 'before')!
    const after = heads.find(input => input.target.adapterOptions.phase === 'after')!
    expect(executionDeadlineMs(before.facts.deadlines.resourceLifetime)).toBe(10_100)
    expect(executionDeadlineMs(after.facts.deadlines.resourceLifetime)).toBe(20_100)
    expect(before.facts.deadlines.resourceLifetime.limitId).not.toBe(after.facts.deadlines.resourceLifetime.limitId)
    expect(before.facts.correlation).toEqual(after.facts.correlation)
    expect(executionDeadlineMs(after.facts.deadlines.resourceLifetime)! - manual.clock.nowMs()).toBe(9_000)
  })

  test('validation scope, hook config, env and shell are captured before the first snapshot await', async () => {
    const processes = recorder()
    let entered!: () => void
    let allow!: (decision: AsyncDecision) => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<AsyncDecision>(resolve => { allow = resolve })
    const captured = host({ spawn: processes.spawn, authorize: input => {
      if (input.facts.branchId === 'bundle.snapshot-head' && input.target.adapterOptions.phase === 'before') {
        entered()
        return gate
      }
      return { ok: true, basis: 'explicit-policy', decisionId: 'validation-scope-control' }
    } })
    const snapshotId = await seedSnapshot(captured)
    let seen: Parameters<typeof runTargetedValidation>[0] | undefined
    const files = ['README.md']
    const artifactKinds = ['documentation']
    const env = { PROJECT_VALUE: 'before-snapshot' }
    const capturedConfiguration = { autoFileChangeHooks: false, fileChangeHooks: [{ command: 'printf original' }] }
    const terminalShell = { executable: '/bin/bash', args: ['-c'] }
    const input: Parameters<typeof runTargetedValidation>[0] = {
      cwd: '/repo', snapshotId, files, artifactKinds, env, capturedConfiguration, terminalShell,
      executionContext: captured.context,
      runHooks: async hookInput => { seen = { ...hookInput, snapshotId }; return [{ type: 'json', value: [{ command: 'fixture validation', hookName: 'fixture', exitCode: 0 }] }] },
    }
    const pending = runTargetedValidation(input)
    await waiting
    input.cwd = '/late-root'
    input.snapshotId = 'late-snapshot'
    files[0] = 'late.py'
    artifactKinds[0] = 'late-kind'
    env.PROJECT_VALUE = 'after-snapshot'
    capturedConfiguration.fileChangeHooks[0].command = 'printf late'
    capturedConfiguration.autoFileChangeHooks = true
    terminalShell.executable = '/missing-shell'
    terminalShell.args[0] = '--late'
    allow({ ok: true, basis: 'explicit-policy', decisionId: 'validation-scope-allow' })
    const output = await pending
    expect(output[0].value).toMatchObject({ snapshotId, files: ['README.md'], artifactKinds: ['documentation'], status: 'passed' })
    expect(seen).toMatchObject({
      cwd: '/repo', files: ['README.md'], env: { PROJECT_VALUE: 'before-snapshot' },
      capturedConfiguration: { autoFileChangeHooks: false, fileChangeHooks: [{ command: 'printf original' }] },
      terminalShell: { executable: '/bin/bash', args: ['-c'] },
    })
    expect(Object.isFrozen(seen?.capturedConfiguration?.fileChangeHooks[0])).toBe(true)
    for (const actual of processes.calls) expect(actual.options.cwd).toBe('/repo')
  })

  test('missing execution context refuses before hooks with no process', async () => {
    const processes = recorder()
    let hookCalls = 0
    const output = await runTargetedValidation({
      cwd: '/repo', snapshotId: 'unavailable', files: ['README.md'],
      runHooks: async () => { hookCalls++; return [{ type: 'json', value: [{ command: 'fixture validation', hookName: 'fixture', exitCode: 0 }] }] },
    })
    expect(output[0].value).toMatchObject({ status: 'failed', assurance: 'none', executionRefusal: { reason: 'unavailable' } })
    expect(hookCalls).toBe(0)
    expect(processes.calls).toHaveLength(0)
  })

  test.each(['denied', 'deadline-exhausted'] as const)('after snapshot preserves %s refusal and rejects passing hooks', async reason => {
    const manual = createControlledExecutionClock()
    const processes = recorder()
    const captured = host({
      ...manual, spawn: processes.spawn, actionLimit: { kind: 'finite', durationMs: 200 },
      authorize: input => input.target.adapterOptions.phase === 'after' && reason === 'denied'
        ? executionRefusal('denied', 'after snapshot denied')
        : { ok: true, basis: 'explicit-policy', decisionId: 'validation-refusal-control' },
    })
    const snapshotId = await seedSnapshot(captured)
    const output = await runTargetedValidation({
      cwd: '/repo', snapshotId, files: ['README.md'], executionContext: captured.context,
      runHooks: async () => {
        if (reason === 'deadline-exhausted') manual.advance(200)
        return [{ type: 'json', value: [{ command: 'fixture validation', hookName: 'fixture', exitCode: 0 }] }]
      },
    })
    expect(output[0].value).toMatchObject({ status: 'failed', assurance: 'none', executionRefusal: { reason } })
    expect(output[0].value).toHaveProperty('summary', expect.stringContaining('could not be re-attested'))
    expect(captured.events.filter(event => event.phase === 'dispatched' && event.facts.branchId === 'bundle.snapshot-head')).toHaveLength(2)
  })
})

describe('runTargetedValidation', () => {
  const temporaryRoots: string[] = []

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  const createRepository = (): string => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-targeted-validation-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'README.md'), '# Test\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    return cwd
  }

  test('fails closed for a stale snapshot', async () => {
    const cwd = createRepository()
    const result = await runMediatedValidation({
      cwd,
      snapshotId: 'stale-snapshot',
      files: ['README.md'],
      artifactKinds: ['documentation'],
    })
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { status: 'failed', assurance: 'none' },
    })
  })

  test('returns scoped evidence for the current snapshot', async () => {
    const cwd = createRepository()
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      artifactKinds: ['documentation'],
    })
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        schemaVersion: 1,
        snapshotId: bundleValue.snapshotId,
        files: ['README.md'],
        artifactKinds: ['documentation'],
      },
    })
  })

  test('accepts validation across a workspace-journal advance with no file change', async () => {
    // The snapshotId is content-keyed: a journal-only advance between the
    // bundle read and the validation call (the journal bumps on every
    // confirmed edit and conservatively on validation/hooks/terminal/
    // custom-tool calls) must NOT refuse the evidence — only real worktree
    // drift may.
    const cwd = createRepository()
    const initialWorkspace = createInitialWorkspaceState()
    const advancedWorkspace = advanceWorkspaceState(initialWorkspace, {
      source: 'test',
      actions: [
        {
          action: 'update',
          path: 'README.md',
          beforeHash: 'before',
          afterHash: 'after',
        },
      ],
    })
    const bundle = await getMediatedBundle({
      cwd,
      workspaceState: initialWorkspace,
    })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      artifactKinds: ['documentation'],
      workspaceState: advancedWorkspace,
      runHooks: async () => [{ type: 'json', value: [] }],
    })
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        snapshotId: bundleValue.snapshotId,
        workspaceRevision: advancedWorkspace.revision,
        workspaceSnapshotId: advancedWorkspace.snapshotId,
        status: 'skipped',
        assurance: 'reduced',
      },
    })
  })

  test('fails closed when a validation hook returns an execution error', async () => {
    const cwd = createRepository()
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      runHooks: async () => [
        {
          type: 'json',
          value: [{ errorMessage: 'validator executable was unavailable' }],
        },
      ],
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        status: 'failed',
        assurance: 'none',
        summary: 'One or more targeted validation checks failed.',
      },
    })
  })

  test('forwards the diagnosticDelta injector to the hook executor', async () => {
    const cwd = createRepository()
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    let forwarded: unknown
    const diagnosticDelta = async () => ({ rejected: false as const })
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      runHooks: async (hookParams) => {
        forwarded = hookParams.diagnosticDelta
        return [{ type: 'json', value: [] }]
      },
      diagnosticDelta,
    })
    expect(forwarded).toBe(diagnosticDelta)
    // An empty hook result classifies as skipped/reduced (the honest gate
    // semantics for zero executed checks), so the injector did not disturb
    // the existing status/assurance classification.
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { status: 'skipped', assurance: 'reduced' },
    })
  })

  test('fails closed when the diagnostic-delta preflight rejects', async () => {
    const cwd = createRepository()
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    // The diagnostic_delta_rejected hook-result arm carries no
    // exitCode/errorMessage/permissionDenied — only the validationStatus — so
    // the failure predicate must match on the status itself.
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['src/index.ts'],
      runHooks: async () => [
        {
          type: 'json',
          value: [
            {
              hookName: 'diagnostic-delta',
              validationStatus: 'diagnostic_delta_rejected',
              newDiagnostics: [
                {
                  file: 'src/index.ts',
                  range: null,
                  severity: 'error',
                  code: '2304',
                  message: "Cannot find name 'foo'.",
                  command: 'tsc --noEmit',
                  source: 'typecheck',
                },
              ],
              fixIts: [],
            },
          ],
        },
      ],
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        status: 'failed',
        assurance: 'none',
        summary: 'One or more targeted validation checks failed.',
      },
    })
  })

  test('skips the after-bundle semgrep rescan when a securityScanRunner is provided', async () => {
    const cwd = createRepository()
    // A scannable source file with a baseline commit is required so the
    // before-bundle actually runs the semgrep scan (otherwise it is skipped
    // for no-source-files / no-baseline-commit and the assertion is vacuous).
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("one")\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'add app').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("two")\n')
    // A real scan already ran inside the before-bundle (through the injected
    // hermetic runner); the after-bundle must not re-run it (snapshot-drift
    // detection only consults the snapshotId).
    let scanCalls = 0
    const securityScanRunner: SemgrepRunner = async (argv) => {
      scanCalls += 1
      if (argv[0] === '--version') {
        return { exitCode: 0, stdout: '1.45.0\n', stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          version: '2.1.0',
          runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
        }),
        stderr: '',
      }
    }
    const bundle = await getMediatedBundle({ cwd, securityScanRunner })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const runnerCallsAfterPreBundle = scanCalls
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['app.py'],
      runHooks: async () => [{ type: 'json', value: [] }],
    })
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { status: 'skipped', assurance: 'reduced' },
    })
    // The after-bundle semgrep rescan was skipped: no runner invocations
    // beyond the pre-bundle call's own probe + scan (a re-scan would add at
    // least one more invocation, since the probe is cached per cwd).
    expect(scanCalls).toBe(runnerCallsAfterPreBundle)
  })

  test('rejects evidence with the drift summary for a genuine worktree change', async () => {
    const cwd = createRepository()
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      runHooks: async () => {
        // REAL drift: a new untracked file changes the content-keyed
        // identity, so the drift arm — not the re-attestation arm — fires.
        fs.writeFileSync(path.join(cwd, 'drift.txt'), 'drift\n')
        return [{ type: 'json', value: [] }]
      },
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        status: 'failed',
        assurance: 'none',
        snapshotId: bundleValue.snapshotId,
        summary:
          'Validation evidence rejected because the worktree changed during validation.',
      },
    })
  })

  test('reports a post-validation identity failure as a re-attestation error, not drift', async () => {
    // (reliability: after-identity-error-reported-as-drift) The after-pass
    // identity recomputation can fail with NO worktree change — e.g. an
    // unreadable identity-listed file rejecting inside hashIdentityFileBytes
    // — and must not be reported as a worktree mutation. chmod-ing a mode-000
    // UNTRACKED file keeps every git spawn healthy (status never reads
    // untracked bytes), so only the identity read fails. POSIX-only (chmod is
    // a real permission gate there); skipped when running as root, which
    // opens mode-000 files regardless.
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const cwd = createRepository()
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'notes\n')
    const bundle = await getMediatedBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const notes = path.join(cwd, 'notes.txt')
    try {
      const result = await runMediatedValidation({
        cwd,
        snapshotId: bundleValue.snapshotId,
        files: ['notes.txt'],
        runHooks: async () => {
          // Between the before/after identity passes: make the identity file
          // unreadable without touching any tracked content, so the after
          // recomputation fails over a byte-identical worktree.
          fs.chmodSync(notes, 0o000)
          return [{ type: 'json', value: [] }]
        },
      })
      const value = result[0]?.type === 'json' ? result[0].value : undefined
      expect(value).toMatchObject({
        status: 'failed',
        assurance: 'none',
        snapshotId: bundleValue.snapshotId,
      })
      const summary = (value as { summary: string }).summary
      // The failure is attributed to the failed re-attestation with the
      // reason surfaced — never to a worktree mutation that did not happen.
      expect(summary).toContain('could not be re-attested')
      expect(summary).toContain('EACCES')
      expect(summary).not.toContain('worktree changed')
    } finally {
      fs.chmodSync(notes, 0o644)
    }
  })

  test('rejects passing hook evidence after an equal-length untracked tail edit', async () => {
    const cwd = createRepository()
    const file = path.join(cwd, 'tail.txt')
    const prefix = 'x'.repeat(1024 * 1024 + 128)
    fs.writeFileSync(file, `${prefix}before\n`)
    const bundle = (await getMediatedBundle({ cwd }))[0]
    if (bundle?.type !== 'json' || !('snapshotId' in bundle.value)) {
      throw new Error('Expected complete before snapshot')
    }
    const beforeSize = fs.statSync(file).size
    let hooksRan = false
    const result = await runMediatedValidation({
      cwd,
      snapshotId: bundle.value.snapshotId,
      files: ['tail.txt'],
      runHooks: async () => {
        hooksRan = true
        fs.writeFileSync(file, `${prefix}after!\n`)
        return [
          {
            type: 'json',
            value: [{ exitCode: 0, command: 'true', hookName: 'test' }],
          },
        ]
      },
    })
    expect(hooksRan).toBe(true)
    expect(fs.statSync(file).size).toBe(beforeSize)
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        status: 'failed',
        assurance: 'none',
        summary:
          'Validation evidence rejected because the worktree changed during validation.',
        results: [{ exitCode: 0, command: 'true', hookName: 'test' }],
      },
    })
  })

  test('refuses validation before hooks when status membership overflows', async () => {
    // Overflow is unavailable evidence, rather than a partial snapshot ID.
    // POSIX-only: the deep paths below exceed Windows MAX_PATH.
    if (process.platform === 'win32') return
    const cwd = createRepository()
    // One deep directory (a single recursive mkdir) stretches every
    // porcelain line to ~790 bytes, so 5500 untracked files push the
    // listing past the 4MB spawn cap while every path stays under the
    // common 1024-byte PATH_MAX.
    const deepDir = Array.from(
      { length: 4 },
      (_, i) => `d${'x'.repeat(190)}${i}`,
    ).join('/')
    fs.mkdirSync(path.join(cwd, deepDir), { recursive: true })
    const fileCount = 5500
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(
        path.join(cwd, deepDir, `f-${String(i).padStart(4, '0')}.txt`),
        'x\n',
      )
    }
    // Pin the regime: the listing exceeds the production spawn cap, so the
    // file deleted below falls past the retained identity prefix.
    const capped = await runMediatedGitBounded(
      ['status', '--porcelain', '-uall'],
      cwd,
      undefined,
      { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 },
    )
    expect(capped.exitCode).toBe(0)
    expect(capped.stdoutTotalBytes).toBeGreaterThan(4 * 1024 * 1024)

    expect((await getMediatedBundle({ cwd }))[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage:
          'Git status exceeds identity membership limit; complete review files are unavailable.',
      },
    })
    let hooksRan = false
    const result = await runMediatedValidation({
      cwd,
      snapshotId: 'unavailable',
      files: ['README.md'],
      runHooks: async () => {
        hooksRan = true
        return [{ type: 'json', value: [] }]
      },
    })
    expect(hooksRan).toBe(false)
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { status: 'failed', assurance: 'none' },
    })
  })
})
