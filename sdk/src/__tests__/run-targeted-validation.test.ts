import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getChangeReviewBundle } from '../tools/get-change-review-bundle'
import { runTargetedValidation } from '../tools/run-targeted-validation'

import type { SemgrepRunner } from '../services/semgrep-baseline'

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
    const result = await runTargetedValidation({
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
    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const result = await runTargetedValidation({
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

  test('fails closed when a validation hook returns an execution error', async () => {
    const cwd = createRepository()
    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    const result = await runTargetedValidation({
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
    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    let forwarded: unknown
    const diagnosticDelta = async () => ({ rejected: false as const })
    const result = await runTargetedValidation({
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
    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    // The diagnostic_delta_rejected hook-result arm carries no
    // exitCode/errorMessage/permissionDenied — only the validationStatus — so
    // the failure predicate must match on the status itself.
    const result = await runTargetedValidation({
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
    const bundle = await getChangeReviewBundle({ cwd, securityScanRunner })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const runnerCallsAfterPreBundle = scanCalls
    const result = await runTargetedValidation({
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
})
