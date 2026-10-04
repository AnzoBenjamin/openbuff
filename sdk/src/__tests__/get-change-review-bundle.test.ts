import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  getChangeReviewBundle,
  hashIdentityFileBytes,
  runGitBounded,
} from '../tools/get-change-review-bundle'
import { LocalHarnessStore } from '../services/local-harness-store'
import {
  advanceWorkspaceState,
  createInitialWorkspaceState,
} from '@codebuff/common/types/workspace-state'

import type { SemgrepRunner } from '../services/semgrep-baseline'

describe('getChangeReviewBundle', () => {
  const temporaryRoots: string[] = []

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('binds status and diff to a deterministic snapshot id', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-stable-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'initial\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'changed\n')

    const first = await getChangeReviewBundle({ cwd })
    const second = await getChangeReviewBundle({ cwd })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect((firstValue as { snapshotId: string }).snapshotId).toBe(
      (secondValue as { snapshotId: string }).snapshotId,
    )
    expect(Array.isArray((firstValue as { files: unknown }).files)).toBe(true)
    expect(typeof (firstValue as { diff: unknown }).diff).toBe('string')
  })

  test('snapshot identity is independent of display truncation and includes every changed file', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-'))
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'first.txt'), 'first\n')
    fs.writeFileSync(path.join(cwd, 'second.txt'), 'second\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'first.txt'), `${'x'.repeat(4_000)}\n`)
    fs.writeFileSync(path.join(cwd, 'second.txt'), 'changed\n')

    const small = await getChangeReviewBundle({ cwd, max_chars: 500 })
    const large = await getChangeReviewBundle({ cwd, max_chars: 20_000 })
    const smallValue = (small[0]!.type === 'json' ? small[0]!.value : {}) as {
      snapshotId: string
      files: string[]
    }
    const largeValue = (large[0]!.type === 'json' ? large[0]!.value : {}) as {
      snapshotId: string
    }
    expect(smallValue.snapshotId).toBe(largeValue.snapshotId)
    expect(smallValue.files).toEqual(['first.txt', 'second.txt'])

    const before = smallValue.snapshotId
    fs.writeFileSync(path.join(cwd, 'second.txt'), 'CHANGED\n')
    const after = await getChangeReviewBundle({ cwd, max_chars: 500 })
    const afterValue = (after[0]!.type === 'json' ? after[0]!.value : {}) as {
      snapshotId: string
    }
    expect(afterValue.snapshotId).not.toBe(before)
  })

  test('binds review snapshots to the monotonic workspace revision', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-rev-'))
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'initial\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'changed\n')
    const initialWorkspace = createInitialWorkspaceState()
    const advancedWorkspace = advanceWorkspaceState(initialWorkspace, {
      source: 'test',
      actions: [
        {
          action: 'update',
          path: 'changed.txt',
          beforeHash: 'before',
          afterHash: 'after',
        },
      ],
    })

    const first = await getChangeReviewBundle({
      cwd,
      workspaceState: initialWorkspace,
    })
    const second = await getChangeReviewBundle({
      cwd,
      workspaceState: advancedWorkspace,
    })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect((firstValue as { snapshotId: string }).snapshotId).not.toBe(
      (secondValue as { snapshotId: string }).snapshotId,
    )
    expect(secondValue).toMatchObject({
      workspaceRevision: advancedWorkspace.revision,
      workspaceSnapshotId: advancedWorkspace.snapshotId,
    })
  })

  test('returns only records bound to the current repository, workspace, snapshot, and changed files', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-state-'))
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-harness-state-'),
    )
    temporaryRoots.push(cwd, stateDir)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'first.txt'), 'first\n')
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'other\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'first.txt'), 'changed\n')
    const initial = await getChangeReviewBundle({ cwd, stateDir })
    const value =
      initial[0]!.type === 'json'
        ? (initial[0]!.value as unknown as {
            snapshotId: string
            repositoryId: string
            workspaceId: string
          })
        : undefined
    expect(value).toBeDefined()
    const now = new Date().toISOString()
    const base = {
      schemaVersion: 1 as const,
      revision: 0,
      repositoryId: value!.repositoryId,
      workspaceId: value!.workspaceId,
      runId: 'run',
      snapshotId: value!.snapshotId,
      createdAt: now,
      updatedAt: now,
    }
    const store = new LocalHarnessStore(stateDir)
    store.put('ownership', {
      ...base,
      id: 'owned',
      transactionId: 'tx',
      agentRole: 'editor',
      findingsAddressed: [],
      requirementsAddressed: [],
      changes: [{ path: 'first.txt', ownership: 'agent' }],
    })
    store.put('ownership', {
      ...base,
      id: 'unrelated',
      transactionId: 'tx2',
      agentRole: 'editor',
      findingsAddressed: [],
      requirementsAddressed: [],
      changes: [{ path: 'other.txt', ownership: 'agent' }],
    })
    store.put('validation', {
      ...base,
      id: 'valid',
      command: 'test',
      files: ['first.txt'],
      artifactKinds: [],
      status: 'passed',
      assurance: 'full',
      diagnostics: [],
    })
    store.put('findings', {
      ...base,
      id: 'open',
      reviewerId: 'reviewer',
      severity: 'high',
      text: 'issue',
      files: ['first.txt'],
      status: 'open',
    })
    store.put('findings', {
      ...base,
      id: 'resolved',
      reviewerId: 'reviewer',
      severity: 'low',
      text: 'old',
      files: ['first.txt'],
      status: 'resolved',
    })
    store.put('findings', {
      ...base,
      id: 'stale',
      snapshotId: 'old-snapshot',
      reviewerId: 'reviewer',
      severity: 'high',
      text: 'stale',
      files: ['first.txt'],
      status: 'open',
    })
    const result = await getChangeReviewBundle({ cwd, stateDir })
    const reviewed =
      result[0]!.type === 'json'
        ? (result[0]!.value as unknown as {
            ownership: Array<{ id: string }>
            validation: Array<{ id: string }>
            findings: Array<{ id: string }>
          })
        : undefined
    expect(reviewed!.ownership.map((record) => record.id)).toEqual(['owned'])
    expect(reviewed!.validation.map((record) => record.id)).toEqual(['valid'])
    expect(reviewed!.findings.map((record) => record.id)).toEqual(['open'])
  })

  test('falls back to the last commit diff when the worktree is clean', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-committed-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'initial\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'second').status).toBe(0)

    const result = await getChangeReviewBundle({ cwd })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as { files: string[]; diff: string }
    expect(bundle.files).toEqual(['file.txt'])
    expect(bundle.diff.length).toBeGreaterThan(0)
  })

  test('ignores .agents/sessions plan artifacts for snapshot identity and files', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-sessions-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'source.txt'), 'initial\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'source.txt'), 'changed\n')

    const before = await getChangeReviewBundle({ cwd })
    const beforeValue = (
      before[0]!.type === 'json' ? before[0]!.value : {}
    ) as { snapshotId: string; files: string[] }

    // (a) creating a session plan artifact must not change the snapshot id.
    const sessionDir = path.join(cwd, '.agents', 'sessions', 'my-slug')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'PLAN.md'), '# plan\n')
    const afterCreate = await getChangeReviewBundle({ cwd })
    const afterCreateValue = (
      afterCreate[0]!.type === 'json' ? afterCreate[0]!.value : {}
    ) as { snapshotId: string; files: string[] }
    expect(afterCreateValue.snapshotId).toBe(beforeValue.snapshotId)

    // Modifying an existing session artifact also must not change the id.
    fs.writeFileSync(path.join(sessionDir, 'PLAN.md'), '# plan updated\n')
    const afterModify = await getChangeReviewBundle({ cwd })
    const afterModifyValue = (
      afterModify[0]!.type === 'json' ? afterModify[0]!.value : {}
    ) as { snapshotId: string; files: string[] }
    expect(afterModifyValue.snapshotId).toBe(beforeValue.snapshotId)

    // (c) the returned files array omits the session artifact path.
    expect(
      afterModifyValue.files.some((f) => f.startsWith('.agents/sessions/')),
    ).toBe(false)
    expect(afterModifyValue.files).toEqual(['source.txt'])

    // (b) a real tracked source change still changes the snapshot id.
    fs.writeFileSync(path.join(cwd, 'source.txt'), 'changed again\n')
    const afterSource = await getChangeReviewBundle({ cwd })
    const afterSourceValue = (
      afterSource[0]!.type === 'json' ? afterSource[0]!.value : {}
    ) as { snapshotId: string }
    expect(afterSourceValue.snapshotId).not.toBe(beforeValue.snapshotId)
  })

  test('returns empty files when the worktree is clean and there is no parent commit', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-single-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'initial\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)

    const result = await getChangeReviewBundle({ cwd })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as { files: string[]; diff: string }
    expect(bundle.files).toEqual([])
    expect(bundle.diff).toBe('')
  })

  test('adds a securityScan field with parsed findings when semgrep is available', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-semgrep-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("one")\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("two")\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'second').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'exec(user_input)\n')

    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          results: [
            {
              ruleId: 'python.lang.security.audit.exec-detected',
              level: 'error',
              message: { text: 'Detected the use of exec().' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'app.py' },
                    region: {
                      startLine: 1,
                      startColumn: 1,
                      endLine: 1,
                      endColumn: 4,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    const seenArgv: string[][] = []
    const runner: SemgrepRunner = (argv) => {
      seenArgv.push(argv)
      if (argv[0] === '--version') {
        return { exitCode: 0, stdout: '1.45.0\n', stderr: '' }
      }
      return { exitCode: 0, stdout: sarif, stderr: '' }
    }

    const result = await getChangeReviewBundle({
      cwd,
      securityScanRunner: runner,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as {
      snapshotId: string
      files: string[]
      securityScan: {
        status: string
        findings: Array<Record<string, unknown>>
        toolVersion?: string
      }
    }
    expect(bundle.files).toEqual(['app.py'])
    expect(bundle.securityScan.status).toBe('ok')
    expect(bundle.securityScan.toolVersion).toBe('1.45.0')
    expect(bundle.securityScan.findings).toHaveLength(1)
    expect(bundle.securityScan.findings[0]).toMatchObject({
      file: 'app.py',
      severity: 'error',
      code: 'python.lang.security.audit.exec-detected',
      message: 'Detected the use of exec().',
      source: 'sarif',
    })
    const scanArgv = seenArgv.find((argv) => argv[0] === 'scan')
    expect(scanArgv).toBeDefined()
    expect(scanArgv![1]).toMatch(/^--baseline-commit=[0-9a-f]{40}$/)
    expect(scanArgv).toContain('--sarif')
    expect(scanArgv).toContain('--include')
    expect(scanArgv).toContain('app.py')
  })

  test('keeps the bundle intact with an unavailable securityScan when semgrep is missing', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-nosemgrep-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("one")\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'print("two")\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'second').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'app.py'), 'exec(user_input)\n')

    const runner: SemgrepRunner = () => ({
      exitCode: -1,
      stdout: '',
      stderr: 'spawn semgrep ENOENT',
    })
    const result = await getChangeReviewBundle({
      cwd,
      securityScanRunner: runner,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as {
      snapshotId: string
      files: string[]
      diff: string
      securityScan: { status: string; reason?: string; findings: unknown[] }
    }
    expect(bundle.securityScan.status).toBe('unavailable')
    expect(bundle.securityScan.reason).toBe('semgrep-not-found')
    expect(bundle.securityScan.findings).toEqual([])
    // The rest of the bundle is unchanged by the failed optional layer.
    expect(typeof bundle.snapshotId).toBe('string')
    expect(bundle.files).toEqual(['app.py'])
    expect(bundle.diff).toContain('exec(user_input)')
  })

  test('reports a skipped securityScan and never runs semgrep when no changed file is scannable', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-skipsemgrep-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'one\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'two\n')

    const runner: SemgrepRunner = () => {
      throw new Error('semgrep must not run when nothing is scannable')
    }
    const result = await getChangeReviewBundle({
      cwd,
      securityScanRunner: runner,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as {
      files: string[]
      securityScan: { status: string; reason?: string; findings: unknown[] }
    }
    expect(bundle.files).toEqual(['notes.txt'])
    expect(bundle.securityScan).toMatchObject({
      status: 'skipped',
      reason: 'no-source-files',
      findings: [],
    })
  })

  test('per-file identity byte cap cannot alias distinct worktree states', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-cap-'))
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    // Both states keep big.txt UNTRACKED, so the git diff contribution is
    // empty both times and identity rests entirely on the per-file bytes.
    // The hashed per-file byte prefix (1 MiB cap) is byte-identical across
    // the two states, so mixing the untruncated size into the hash is what
    // keeps the ids distinct — the cap boundary can never alias two states.
    const shared = 'a'.repeat(1024 * 1024)
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${shared}tail-one\n`)
    const first = await getChangeReviewBundle({ cwd })
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${shared}tail-two-longer\n`)
    const second = await getChangeReviewBundle({ cwd })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect((secondValue as { snapshotId: string }).snapshotId).not.toBe(
      (firstValue as { snapshotId: string }).snapshotId,
    )
  })

  test('identity reads stay order-stable across a file set larger than the read fan-out', async () => {
    // The per-file byte prefixes are read with bounded concurrency (perf:
    // snapshot-identity-serial-file-reads); the hash must still join the
    // contributions in sorted file order, so the snapshotId is identical
    // across repeated runs over more changed files than the fan-out width.
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-parallel-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    const fileCount = 24
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(
        path.join(cwd, `changed-${i}.txt`),
        `content-${i}\n${'x'.repeat(i * 512)}\n`,
      )
    }
    const first = await getChangeReviewBundle({ cwd })
    const second = await getChangeReviewBundle({ cwd })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect((secondValue as { snapshotId: string }).snapshotId).toBe(
      (firstValue as { snapshotId: string }).snapshotId,
    )
    const files = (firstValue as { files: string[] }).files
    // Only the 24 untracked files appear in identity: seed.txt is committed
    // and unchanged, so it never shows up in porcelain status output.
    expect(files).toHaveLength(fileCount)
    expect(files).toEqual([...files].sort())
  })

  test('windowed identity reads hash the identical byte stream the serial loop did', async () => {
    // The per-file reads run through a bounded read window (perf:
    // snapshot-identity-contributions-unbounded-retention); each settled
    // contribution is hashed in sorted order with its buffer released, so
    // the digest must stay byte-identical to the serial loop's over the
    // same changed-file list.
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-window-'),
    )
    temporaryRoots.push(cwd)
    const fileCount = 20
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(cwd, `f-${i}.txt`), `body-${i}\n`)
    }
    const files = Array.from({ length: fileCount }, (_, i) => `f-${i}.txt`)
    const serial = createHash('sha256')
    for (const file of [...files].sort()) {
      const stats = fs.statSync(path.join(cwd, file))
      serial.update(`\0${file}\0size:${stats.size}\0`)
      serial.update(fs.readFileSync(path.join(cwd, file)))
    }
    const windowed = createHash('sha256')
    await hashIdentityFileBytes(windowed, cwd, files)
    expect(windowed.digest('hex')).toBe(serial.digest('hex'))
  })

  test('abort escalates SIGTERM to SIGKILL for a git child that ignores SIGTERM', async () => {
    // perf: run-git-bounded-abort-no-sigkill-escalation — the abort path used
    // to send a bare SIGTERM with no escalation, so a git child that trapped
    // SIGTERM kept running with live piped stdio (the same leak shape the
    // semgrep and diagnostic runners fixed). A PATH shim `git` that ignores
    // SIGTERM proves the SIGKILL escalation reaps it shortly after abort.
    // POSIX-only (shebang shim + signal traps); skipped on Windows.
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-git-abort-'))
    temporaryRoots.push(dir)
    const pidFile = path.join(dir, 'shim.pid')
    fs.writeFileSync(
      path.join(dir, 'git'),
      [
        '#!/bin/sh',
        `echo $$ > ${JSON.stringify(pidFile)}`,
        `trap '' TERM`,
        'while :; do :; done',
      ].join('\n'),
    )
    fs.chmodSync(path.join(dir, 'git'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    try {
      const controller = new AbortController()
      const resultPromise = runGitBounded(['status'], dir, controller.signal, {
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
        sigtermGraceMs: 150,
      })
      // Wait until the shim is live, then cancel.
      const pidDeadline = Date.now() + 5_000
      let pid = -1
      while (pid === -1 && Date.now() < pidDeadline) {
        try {
          pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      expect(pid).toBeGreaterThan(0)
      controller.abort()
      const result = await resultPromise
      // The runner settles at the abort; the SIGKILL escalation reaps the
      // SIGTERM-ignoring child shortly after (grace 150ms), rather than the
      // child leaking forever with live piped stdio.
      expect(result.exitCode).toBe(-1)
      const goneDeadline = Date.now() + 3_000
      let gone = false
      while (Date.now() < goneDeadline) {
        try {
          process.kill(pid, 0)
        } catch {
          gone = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(gone).toBe(true)
    } finally {
      process.env.PATH = previousPath
    }
  })
})
