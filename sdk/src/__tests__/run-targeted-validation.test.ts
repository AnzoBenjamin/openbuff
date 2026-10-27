import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getChangeReviewBundle } from '../tools/get-change-review-bundle'
import { runGitBounded } from '../tools/git-status'
import { runTargetedValidation } from '../tools/run-targeted-validation'
import {
  advanceWorkspaceState,
  createInitialWorkspaceState,
} from '@codebuff/common/types/workspace-state'

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
    const bundle = await getChangeReviewBundle({
      cwd,
      workspaceState: initialWorkspace,
    })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const result = await runTargetedValidation({
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

  test('rejects evidence with the drift summary for a genuine worktree change', async () => {
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
    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }
    const notes = path.join(cwd, 'notes.txt')
    try {
      const result = await runTargetedValidation({
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

  test('rejects evidence for worktree drift entirely past the porcelain spawn cap', async () => {
    // Regression (correctness: porcelain-total-bytes-not-hashed): the
    // before/after drift check compares snapshotIds derived from a CAPPED
    // `git status --porcelain -uall` listing, so drift confined to files
    // whose porcelain lines fall past MAX_SNAPSHOT_ID_DIFF_BYTES was
    // invisible — the ids aliased and the evidence was accepted. The
    // status-length term now moves the id, so the drift arm fails closed.
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
    const capped = await runGitBounded(
      ['status', '--porcelain', '-uall'],
      cwd,
      undefined,
      { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 },
    )
    expect(capped.exitCode).toBe(0)
    expect(capped.stdoutTotalBytes).toBeGreaterThan(4 * 1024 * 1024)

    const bundle = await getChangeReviewBundle({ cwd })
    const bundleValue = bundle[0]?.type === 'json' ? bundle[0].value : undefined
    if (!bundleValue || !('snapshotId' in bundleValue)) {
      throw new Error('Expected a change review bundle')
    }

    const result = await runTargetedValidation({
      cwd,
      snapshotId: bundleValue.snapshotId,
      files: ['README.md'],
      runHooks: async () => {
        // REAL drift entirely past the 4MB retained prefix: the retained
        // identity lines, the files list, the diff, and HEAD are
        // byte-identical, so only the untruncated porcelain byte total can
        // catch it.
        fs.rmSync(
          path.join(
            cwd,
            deepDir,
            `f-${String(fileCount - 1).padStart(4, '0')}.txt`,
          ),
          { force: true },
        )
        return [{ type: 'json', value: [] }]
      },
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { status: 'failed', assurance: 'none' },
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    // The failure is attributed to the worktree drift, not to a failed
    // re-attestation.
    expect((value as { summary: string }).summary).toContain(
      'worktree changed during validation',
    )
  })
})
