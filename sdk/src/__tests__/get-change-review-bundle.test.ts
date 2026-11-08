import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  committedDiffFiles,
  computeWorktreeSnapshotIdentity,
  getChangeReviewBundle,
  hashIdentityFileBytes,
  runGitBounded,
} from '../tools/get-change-review-bundle'
import { gitStatus } from '../tools/git-status'
import { resolveWorkspaceIdentity } from '../services/repository-identity'
import { LocalHarnessStore } from '../services/local-harness-store'
import {
  advanceWorkspaceState,
  createInitialWorkspaceState,
} from '@codebuff/common/types/workspace-state'
import { getChangeReviewBundleParams } from '@codebuff/common/tools/params/tool/get-change-review-bundle'

import type { SemgrepRunner } from '../services/semgrep-baseline'


import { createExecutionProcessRecorder, createRealExecutionProcessRecorder, createTerminalExecutionFixture } from './fixtures/b19-terminal-execution'

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
function computeMediatedIdentity(params: Parameters<typeof computeWorktreeSnapshotIdentity>[0]) {
  return computeWorktreeSnapshotIdentity({ ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal) })
}
function mediatedGitStatus(params: Parameters<typeof gitStatus>[0]) {
  return gitStatus({ ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal) })
}
function resolveMediatedWorkspace(params: Parameters<typeof resolveWorkspaceIdentity>[0]) {
  return resolveWorkspaceIdentity({ ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal) })
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

    const first = await getMediatedBundle({ cwd })
    const second = await getMediatedBundle({ cwd })
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

  test('carries the evidence-only snapshotIdUsage warning in the success payload', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-usage-'))
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

    const result = await getMediatedBundle({ cwd })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as { snapshotIdUsage?: string }
    expect(typeof bundle.snapshotIdUsage).toBe('string')
    expect(bundle.snapshotIdUsage).toContain('evidence-only')
    expect(bundle.snapshotIdUsage).toContain(
      'content-keyed worktree identity (files/diff/HEAD) for drift checks only',
    )
    expect(bundle.snapshotIdUsage).toContain(
      'NEVER pass it (or any bare hex) as params.snapshot_id or params.snapshot_fingerprint',
    )
    expect(bundle.snapshotIdUsage).toContain('v3:')
  })

  test('parses success payloads with and without the additive snapshotIdUsage field', () => {
    const base = {
      snapshotId: 'a'.repeat(64),
      repositoryId: 'repo',
      workspaceId: 'workspace',
      headCommit: 'b'.repeat(40),
      status: '',
      files: [] as string[],
      diff: '',
      truncated: false,
      ownership: [] as Record<string, unknown>[],
      validation: [] as Record<string, unknown>[],
      findings: [] as Record<string, unknown>[],
    }
    const parse = (value: unknown) =>
      getChangeReviewBundleParams.outputSchema.safeParse([
        { type: 'json', value },
      ])
    // Additive optional: a legacy payload without the field still parses.
    expect(parse(base).success).toBe(true)
    expect(
      parse({
        ...base,
        snapshotIdUsage:
          "evidence-only: the bare-hex snapshotId is content-keyed worktree identity (files/diff/HEAD) for drift checks only. NEVER pass it (or any bare hex) as params.snapshot_id or params.snapshot_fingerprint — gate/specialist attestation uses the parent gate's opaque v3:<64-hex> token.",
      }).success,
    ).toBe(true)
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

    const small = await getMediatedBundle({ cwd, max_chars: 500 })
    const large = await getMediatedBundle({ cwd, max_chars: 20_000 })
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
    const after = await getMediatedBundle({ cwd, max_chars: 500 })
    const afterValue = (after[0]!.type === 'json' ? after[0]!.value : {}) as {
      snapshotId: string
    }
    expect(afterValue.snapshotId).not.toBe(before)
  })

  test('snapshot identity is content-keyed and independent of the workspace journal', async () => {
    // The bare-hex snapshotId is evidence-only content identity: it must be
    // keyed to worktree content (files/diff/HEAD), NOT to the harness
    // workspace journal. That journal advances on every confirmed edit and
    // conservatively on every run_terminal_command / run_file_change_hooks /
    // run_targeted_validation / custom-tool call, so mixing it in made
    // concurrent reviewer bundle reads in one gate cycle disagree with zero
    // file changes. A journal-only bump must keep the id stable while the
    // payload still echoes the passed journal coordinates, and real content
    // drift must still move it.
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
    // advanceWorkspaceState bumps revision/snapshotId with NO file change.
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
    expect(advancedWorkspace.revision).not.toBe(initialWorkspace.revision)

    const first = await getMediatedBundle({
      cwd,
      workspaceState: initialWorkspace,
    })
    const second = await getMediatedBundle({
      cwd,
      workspaceState: advancedWorkspace,
    })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    // Same worktree content + a journal-only bump => identical bare id.
    expect((secondValue as { snapshotId: string }).snapshotId).toBe(
      (firstValue as { snapshotId: string }).snapshotId,
    )
    // A bundle read with no workspace journal at all agrees too: the id is
    // keyed to content, not to the journal's presence or coordinates.
    const unbound = await getMediatedBundle({ cwd })
    const unboundValue =
      unbound[0]?.type === 'json' ? unbound[0].value : undefined
    expect(unboundValue).not.toHaveProperty('errorMessage')
    expect((unboundValue as { snapshotId: string }).snapshotId).toBe(
      (firstValue as { snapshotId: string }).snapshotId,
    )
    // The journal coordinates are still echoed from the passed workspaceState.
    expect(firstValue).toMatchObject({
      workspaceRevision: initialWorkspace.revision,
      workspaceSnapshotId: initialWorkspace.snapshotId,
    })
    expect(secondValue).toMatchObject({
      workspaceRevision: advancedWorkspace.revision,
      workspaceSnapshotId: advancedWorkspace.snapshotId,
    })

    // Real worktree content drift still changes the content-keyed id.
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'changed again\n')
    const drifted = await getMediatedBundle({
      cwd,
      workspaceState: advancedWorkspace,
    })
    const driftedValue =
      drifted[0]?.type === 'json' ? drifted[0].value : undefined
    expect(driftedValue).not.toHaveProperty('errorMessage')
    expect((driftedValue as { snapshotId: string }).snapshotId).not.toBe(
      (secondValue as { snapshotId: string }).snapshotId,
    )
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
    const initial = await getMediatedBundle({ cwd, stateDir })
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
    const result = await getMediatedBundle({ cwd, stateDir })
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

    const result = await getMediatedBundle({ cwd })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as { files: string[]; diff: string }
    expect(bundle.files).toEqual(['file.txt'])
    expect(bundle.diff.length).toBeGreaterThan(0)
  })

  test('committedDiffFiles decodes git-quoted UTF-8 paths from the committed diff', () => {
    // Git C-quotes non-ASCII paths as octal-escaped raw bytes (é -> \303\251),
    // so the committed-diff fallback used to decode each octal byte separately
    // into a lone char, mangling multi-byte UTF-8 filenames. The decoder must
    // join consecutive octal bytes and decode them as UTF-8.
    // committedDiffFiles is exported for test coverage; module-private in
    // production usage.
    const fileName = 'caféæøå.txt'
    const octalEscaped = Array.from(Buffer.from(fileName, 'utf8'))
      .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
      .join('')
    const diff = [
      `diff --git a/"${octalEscaped}" b/"${octalEscaped}"`,
      'index 1111111..2222222 100644',
      `--- a/"${octalEscaped}"`,
      `+++ b/"${octalEscaped}"`,
    ].join('\n')
    expect(committedDiffFiles(diff)).toEqual([fileName])

    // An already-literal quoted non-ASCII path (no octal escapes) also maps
    // to its unquoted spelling.
    const literal = `diff --git a/"${fileName}" b/"${fileName}"\n`
    expect(committedDiffFiles(literal)).toEqual([fileName])

    // Ordinary unquoted ASCII paths pass through unchanged.
    expect(committedDiffFiles('diff --git a/plain.txt b/plain.txt\n')).toEqual([
      'plain.txt',
    ])
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

    const before = await getMediatedBundle({ cwd })
    const beforeValue = (
      before[0]!.type === 'json' ? before[0]!.value : {}
    ) as { snapshotId: string; files: string[] }

    // (a) creating a session plan artifact must not change the snapshot id —
    // including through the status-length identity term: the porcelain
    // spawn excludes .agents/sessions/** at the pathspec, so artifact bytes
    // never reach the untruncated byte total (correctness:
    // porcelain-total-bytes-not-hashed).
    const sessionDir = path.join(cwd, '.agents', 'sessions', 'my-slug')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'PLAN.md'), '# plan\n')
    const afterCreate = await getMediatedBundle({ cwd })
    const afterCreateValue = (
      afterCreate[0]!.type === 'json' ? afterCreate[0]!.value : {}
    ) as { snapshotId: string; files: string[] }
    expect(afterCreateValue.snapshotId).toBe(beforeValue.snapshotId)

    // Modifying an existing session artifact also must not change the id.
    fs.writeFileSync(path.join(sessionDir, 'PLAN.md'), '# plan updated\n')
    const afterModify = await getMediatedBundle({ cwd })
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
    const afterSource = await getMediatedBundle({ cwd })
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

    const result = await getMediatedBundle({ cwd })
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
    // These are local fixture refs; merge-base requires no remote connection.
    expect(git('update-ref', 'refs/remotes/origin/main', 'HEAD~1').status).toBe(0)
    expect(git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main').status).toBe(0)
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

    const processes = createRealExecutionProcessRecorder()
    const executionHost = createTerminalExecutionFixture({ projectRoot: cwd, spawn: processes.spawn })
    executionHosts.push(executionHost)
    const result = await getMediatedBundle({
      cwd,
      securityScanRunner: runner,
      executionContext: executionHost.context,
    })
    const baselineInput = executionHost.policyInputs.find(input => input.facts.branchId === 'bundle.security-merge-base')!
    expect(baselineInput).toBeDefined()
    expect(baselineInput.target.argv).toEqual(['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
      'merge-base', 'HEAD', 'origin/main'])
    expect(baselineInput.target.adapterOptions.phase).toBe('security-baseline')
    const baselineCall = processes.calls.find(call => JSON.stringify(call.argv) === JSON.stringify(baselineInput.target.argv))!
    expect(baselineCall.spawnObserved).toBe(true)
    expect(baselineCall.argv).toEqual(baselineInput.target.argv)
    expect(baselineCall.options.env?.OPENAI_API_KEY).toBeUndefined()
    expect(baselineCall.options.env?.CUSTOM_PROVIDER_KEY).toBeUndefined()
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
    const result = await getMediatedBundle({
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
    const result = await getMediatedBundle({
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

  test('equal-length untracked tails beyond 1 MiB have distinct full identities', async () => {
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
    // Prefix, path, Git status, Git diff and length are identical. Only the
    // full file digest can distinguish these equal-length untracked tails.
    const shared = 'a'.repeat(1024 * 1024)
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${shared}tail-one\n`)
    const first = await getMediatedBundle({ cwd })
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${shared}tail-two\n`)
    const second = await getMediatedBundle({ cwd })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(firstValue).not.toHaveProperty('errorMessage')
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect((secondValue as { snapshotId: string }).snapshotId).not.toBe(
      (firstValue as { snapshotId: string }).snapshotId,
    )
  })

  test('full Git diff tails change independently of retained presentation bytes', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-git-tail-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    const file = path.join(cwd, 'z-tail.txt')
    fs.writeFileSync(file, 'seed\n')
    fs.writeFileSync(path.join(cwd, 'a-prefix.txt'), 'seed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    const prefix = 'x'.repeat(5 * 1024 * 1024)
    fs.writeFileSync(path.join(cwd, 'a-prefix.txt'), `${prefix}\n`)
    const observe = async (tail: string) => {
      fs.writeFileSync(file, `${tail}\n`)
      const raw = await runMediatedGitBounded(
        ['diff', '--binary', 'HEAD'],
        cwd,
        undefined,
        {
          timeoutMs: 10_000,
          maxOutputBytes: 4 * 1024 * 1024,
        },
      )
      const reference = spawnSync('git', ['diff', '--binary', 'HEAD'], {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
      })
      expect(reference.status).toBe(0)
      expect(raw.stdoutSha256).toBe(
        createHash('sha256').update(reference.stdout).digest('hex'),
      )
      expect(raw.stdoutComplete).toBe(true)
      expect(raw.stdoutTruncated).toBe(true)
      return raw
    }
    const first = await observe('one')
    const second = await observe('two')
    expect(second.stdout).toBe(first.stdout)
    expect(second.stdoutTotalBytes).toBe(first.stdoutTotalBytes)
    expect(second.stdoutSha256).not.toBe(first.stdoutSha256)
  })

  test('canonical status membership retains whitespace, arrows and quoted UTF-8 names', async () => {
    if (process.platform === 'win32') return
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-paths-'))
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'seed'), 'seed')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    const files = [
      ' leading.txt',
      'trailing.txt ',
      'left -> right.txt',
      'café\nfile.txt',
    ]
    for (const file of files) fs.writeFileSync(path.join(cwd, file), 'one')
    const first = (await getMediatedBundle({ cwd }))[0]
    expect(first).toMatchObject({
      type: 'json',
      value: { files: [...files].sort() },
    })
    fs.writeFileSync(path.join(cwd, 'café\nfile.txt'), 'two')
    const second = (await getMediatedBundle({ cwd }))[0]
    if (
      first?.type !== 'json' ||
      !('snapshotId' in first.value) ||
      second?.type !== 'json' ||
      !('snapshotId' in second.value)
    ) {
      throw new Error('Expected complete path identities')
    }
    expect(second.value.snapshotId).not.toBe(first.value.snapshotId)
  })

  test('quarantined open finding evidence keeps subsequent bundles unavailable', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-corrupt-'),
    )
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-store-'),
    )
    temporaryRoots.push(cwd, stateDir)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'seed'), 'seed')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'seed'), 'changed')
    const initial = (await getMediatedBundle({ cwd, stateDir }))[0]
    if (initial?.type !== 'json' || !('snapshotId' in initial.value))
      throw new Error('Expected initial bundle')
    const record = {
      schemaVersion: 1 as const,
      id: 'open',
      revision: 0,
      repositoryId: initial.value.repositoryId,
      workspaceId: initial.value.workspaceId,
      snapshotId: initial.value.snapshotId,
      runId: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'open',
      files: ['seed'],
    }
    const store = new LocalHarnessStore(stateDir)
    store.put('findings', record)
    const healthy = (await getMediatedBundle({ cwd, stateDir }))[0]
    expect(healthy).toMatchObject({
      type: 'json',
      value: { findings: [record] },
    })
    fs.writeFileSync(
      path.join(stateDir, record.repositoryId, 'findings', 'open.json'),
      '{broken',
    )
    expect(
      store.listWithDiagnostics(record.repositoryId, 'findings').diagnostics,
    ).toHaveLength(1)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await getMediatedBundle({ cwd, stateDir }))[0]).toMatchObject(
        {
          type: 'json',
          value: {
            errorMessage:
              'Finding evidence unavailable: 1 corrupt or quarantined finding record(s) require repair.',
          },
        },
      )
    }
  })

  test('refuses incomplete path membership when porcelain exceeds retention', async () => {
    // A status digest alone cannot enumerate missing untracked content.
    // The bundle and identity-only path must refuse an overflowing listing.
    // POSIX-only: the deep paths below exceed Windows MAX_PATH.
    if (process.platform === 'win32') return
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-porcelain-cap-'),
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
    // One deep directory (a single recursive mkdir) stretches every
    // porcelain line to ~790 bytes, so 5500 untracked files push the
    // listing past the 4MB spawn cap while every file stays cheap to
    // create and every path stays under the common 1024-byte PATH_MAX.
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
    // Pin the regime: the listing exceeds the production spawn cap
    // (MAX_SNAPSHOT_ID_DIFF_BYTES), so files past the cap are dropped from
    // the retained identity lines.
    const capped = await runMediatedGitBounded(
      ['status', '--porcelain', '-uall'],
      cwd,
      undefined,
      { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 },
    )
    expect(capped.exitCode).toBe(0)
    expect(capped.stdoutTotalBytes).toBeGreaterThan(4 * 1024 * 1024)

    const first = await getMediatedBundle({ cwd })
    expect(first[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage:
          'Git status exceeds identity membership limit; complete review files are unavailable.',
      },
    })
    expect(await computeMediatedIdentity({ cwd })).toHaveProperty(
      'errorMessage',
    )
    // Same-length tail content changes cannot make an incomplete state usable.
    fs.writeFileSync(path.join(cwd, deepDir, `f-${fileCount - 1}.txt`), 'y\n')
    expect((await getMediatedBundle({ cwd }))[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage:
          'Git status exceeds identity membership limit; complete review files are unavailable.',
      },
    })
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
    const first = await getMediatedBundle({ cwd })
    const second = await getMediatedBundle({ cwd })
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

  test('windowed identity reads match a serial full-file digest reference', async () => {
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
      serial.update(
        `${JSON.stringify(file)}:mode:${stats.mode}:size:${stats.size}\0file:${createHash(
          'sha256',
        )
          .update(fs.readFileSync(path.join(cwd, file)))
          .digest('hex')}\0`,
      )
    }
    const windowed = createHash('sha256')
    await hashIdentityFileBytes(windowed, cwd, files)
    expect(windowed.digest('hex')).toBe(serial.digest('hex'))
  })

  test('rejects an in-place write during a full file read using stable metadata', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-unstable-'),
    )
    temporaryRoots.push(cwd)
    const file = path.join(cwd, 'moving.bin')
    const fd = fs.openSync(file, 'w+')
    const size = 128 * 1024 * 1024
    fs.ftruncateSync(fd, size)
    let writes = 0
    let bytesRead = 0
    const originalOpen = fsPromises.open
    const opening = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] !== file) return handle
      const originalRead = handle.read
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(originalRead, handle, readArgs)
        bytesRead += result.bytesRead
        // Mutate only after the initial stat check and the first real read.
        if (writes === 0 && result.bytesRead > 0) {
          fs.writeSync(fd, Buffer.from([1]), 0, 1, size - 1)
          writes++
        }
        return result
      }) as typeof handle.read
      return handle
    })
    try {
      await expect(
        hashIdentityFileBytes(createHash('sha256'), cwd, ['moving.bin']),
      ).rejects.toThrow('File changed while hashing identity')
      expect(bytesRead).toBe(size)
      expect(writes).toBe(1)
    } finally {
      opening.mockRestore()
      fs.closeSync(fd)
    }
  })

  test('full file hashing observes cancellation and its own deadline', async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-cancel-'),
    )
    temporaryRoots.push(cwd)
    const file = path.join(cwd, 'large.bin')
    const fd = fs.openSync(file, 'w')
    fs.ftruncateSync(fd, 128 * 1024 * 1024)
    fs.closeSync(fd)
    const controller = new AbortController()
    const cancelled = hashIdentityFileBytes(
      createHash('sha256'),
      cwd,
      ['large.bin'],
      { signal: controller.signal },
    )
    controller.abort(new Error('cancel full identity'))
    await expect(cancelled).rejects.toThrow('cancel full identity')
    await expect(
      hashIdentityFileBytes(createHash('sha256'), cwd, ['large.bin'], {
        timeoutMs: 1,
      }),
    ).rejects.toThrow('File identity timed out')
  })

  test('drains the identity read window before failing closed so sibling rejections are never unhandled', async () => {
    // Regression (reliability:
    // hash-identity-fanout-abandoned-rejections): the bounded read window
    // used to abandon its in-flight reads when the oldest awaited read
    // rejected, leaving up to SNAPSHOT_ID_READ_CONCURRENCY-1 rejecting
    // promises unobserved (unhandled promise rejections) while the error
    // propagated. The window is now drained (allSettled) before the throw,
    // so the call still fails closed on the ORIGINAL error and no sibling
    // rejection escapes the window.
    // POSIX-only (chmod is a real permission gate there); skipped when the
    // test runs as root, which opens mode-000 files regardless.
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-review-drain-'))
    temporaryRoots.push(cwd)
    // More files than the 8-wide read window, so sibling reads are still in
    // flight when the oldest one rejects. stat succeeds on a mode-000 file;
    // open('r') then rejects EACCES.
    const fileCount = 24
    const files: string[] = []
    for (let i = 0; i < fileCount; i++) {
      const name = `f-${i}.txt`
      fs.writeFileSync(path.join(cwd, name), `body-${i}\n`)
      fs.chmodSync(path.join(cwd, name), 0o000)
      files.push(name)
    }
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const hash = createHash('sha256')
      await expect(hashIdentityFileBytes(hash, cwd, files)).rejects.toThrow(
        'EACCES',
      )
      // Let the event loop settle: an abandoned sibling rejection would be
      // reported here. Only sibling read rejections are in scope, so a
      // stray rejection from the surrounding process cannot false-fail this
      // test.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(
        unhandled.filter((reason) => String(reason).includes('EACCES')),
      ).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
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
    const previousPath = capturedChildEnvironment.PATH
    capturedChildEnvironment.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    try {
      const controller = new AbortController()
      const resultPromise = runMediatedGitBounded(['status'], dir, controller.signal, {
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
      capturedChildEnvironment.PATH = previousPath
    }
  })

  test('abort with a SIGTERM-honoring git child settles immediately and leaves no escalation error', async () => {
    // The abort path settles (exitCode -1) BEFORE arming the SIGKILL
    // escalation, so when the child honors the SIGTERM and dies, only its
    // close handler can disarm the armed escalation — settle has already
    // run and early-returns. Honest limitation: under the repo runtime (Bun)
    // kill-after-reap is a silent no-op — no throw, no 'error' event — so a
    // stray escalation firing on the reaped child has no external observable.
    // This test pins the honors-SIGTERM abort path end-to-end (immediate -1
    // settle, child reaped, nothing surfacing past the grace); the
    // source-invariant test below pins the disarm itself.
    // POSIX-only (shebang shim + signals); skipped on Windows.
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-git-term-'))
    temporaryRoots.push(dir)
    const pidFile = path.join(dir, 'shim.pid')
    fs.writeFileSync(
      path.join(dir, 'git'),
      [
        '#!/bin/sh',
        `echo $$ > ${JSON.stringify(pidFile)}`,
        // No `trap '' TERM` line, unlike the SIGTERM-ignoring shim above:
        // this child dies on the default SIGTERM.
        'while :; do :; done',
      ].join('\n'),
    )
    fs.chmodSync(path.join(dir, 'git'), 0o755)
    const previousPath = capturedChildEnvironment.PATH
    capturedChildEnvironment.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const controller = new AbortController()
      const resultPromise = runMediatedGitBounded(['status'], dir, controller.signal, {
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
      // The runner settles at the abort: an honored SIGTERM must never
      // delay the caller.
      expect(result.exitCode).toBe(-1)
      const goneDeadline = Date.now() + 3_000
      let gone = false
      while (!gone && Date.now() < goneDeadline) {
        try {
          process.kill(pid, 0)
        } catch {
          gone = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(gone).toBe(true)
      // The child is reaped; wait past the grace (150ms) so a surviving
      // escalation would have fired on the reaped child by now. Anything it
      // surfaced would appear on the unhandledRejection seam the drain test
      // uses — none may fire.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      capturedChildEnvironment.PATH = previousPath
    }
  })

  test.each([false, true])('Git cancellation escalation stops only after observed close: %s', async closes => {
    const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
    const abort = new AbortController()
    const host = createTerminalExecutionFixture({ projectRoot: '/repo', signal: abort.signal, spawn: processes.spawn })
    executionHosts.push(host)
    const pending = runGitBounded(['status'], '/repo', abort.signal, {
      timeoutMs: 1_000, sigtermGraceMs: 10, maxOutputBytes: 4_096,
      executionContext: host.context, branchId: 'fixture.git.escalation-close',
    })
    for (let turn = 0; processes.calls.length === 0 && turn < 50; turn++) await new Promise(resolve => setImmediate(resolve))
    expect(processes.calls).toHaveLength(1)
    const actual = processes.calls[0]
    abort.abort(new Error('cancelled Git observation'))
    expect((await pending).executionRefusal).toMatchObject({ reason: 'cancelled' })
    if (closes) {
      // Leave fake exitCode/signalCode untouched: the real close event itself
      // must disarm the lifetime, independently of stale child fields.
      actual.child.emit('close', 0)
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(actual.signals).toEqual(closes ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL'])
    actual.finish()
  })

  test('gitStatus with timeoutMs fails closed on a wedged git', async () => {
    // (reliability: bundle-rev-parse-head-unbounded) the bundle prelude's
    // status observation runs under the identity deadline via the new
    // timeoutMs seam. The seam is tested behaviorally here with a small
    // deadline; the bundle's 10s wiring is pinned at source level below.
    // POSIX-only (shebang shim); skipped on Windows.
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-git-status-deadline-'),
    )
    temporaryRoots.push(dir)
    fs.writeFileSync(
      path.join(dir, 'git'),
      ['#!/bin/sh', 'while :; do :; done'].join('\n'),
    )
    fs.chmodSync(path.join(dir, 'git'), 0o755)
    const previousPath = capturedChildEnvironment.PATH
    capturedChildEnvironment.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    try {
      const startedAt = Date.now()
      const parts = await mediatedGitStatus({ cwd: dir, timeoutMs: 250 })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      const first = parts[0]
      expect(first?.type).toBe('json')
      const value = first?.type === 'json' ? first.value : undefined
      expect(
        value && 'errorMessage' in value
          ? value.errorMessage
          : 'expected an errorMessage part',
      ).toContain('deadline exhausted')
    } finally {
      capturedChildEnvironment.PATH = previousPath
    }
  })

  test('resolveWorkspaceIdentity with timeoutMs rejects bounded on a wedged git', async () => {
    // (reliability: bundle-rev-parse-head-unbounded) the bundle prelude's
    // workspace-identity resolution runs under the same deadline; a timeout
    // resolves exitCode -1 and the existing throw fires — bounded latency,
    // unchanged contract.
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-identity-deadline-'),
    )
    temporaryRoots.push(dir)
    fs.writeFileSync(
      path.join(dir, 'git'),
      ['#!/bin/sh', 'while :; do :; done'].join('\n'),
    )
    fs.chmodSync(path.join(dir, 'git'), 0o755)
    const previousPath = capturedChildEnvironment.PATH
    capturedChildEnvironment.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    try {
      const startedAt = Date.now()
      let rejected: Error | undefined
      try {
        await resolveMediatedWorkspace({ cwd: dir, timeoutMs: 250 })
      } catch (error) {
        rejected = error instanceof Error ? error : new Error(String(error))
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(rejected?.message).toContain('deadline exhausted')
    } finally {
      capturedChildEnvironment.PATH = previousPath
    }
  })

  test('reports the documented fallback when rev-parse HEAD fails with empty stderr', async () => {
    // Regression (reliability: head-failure-empty-error-message): the
    // fail-closed head arm ended `?? head.stderr.trim() ?? fallback`, and
    // nullish coalescing does not fall through on an EMPTY string — a
    // silent non-zero `rev-parse HEAD` exit (the normal-close settle path,
    // which carries no stderrNote) surfaced `errorMessage: ''` while the
    // documented fallback stayed unreachable. The head term now uses the
    // `||` shape every sibling failure mapping uses, so the bundle still
    // fails closed but never with an empty diagnostic.
    // POSIX-only (shebang shim); skipped on Windows.
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-headfail-'),
    )
    temporaryRoots.push(dir)
    // Exactly guarded `rev-parse HEAD` dies silently (non-zero exit, no stderr);
    // Identity queries return valid paths, while other observations exit 0.
    // HEAD resolution is the only failure.
    fs.writeFileSync(
      path.join(dir, 'git'),
      [
        '#!/bin/sh',
        'if [ "$*" = "--no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false rev-parse HEAD" ]; then',
        '  exit 7',
        'fi',
        'if [ "$*" = "rev-parse --show-toplevel" ]; then',
        '  pwd',
        'fi',
        'if [ "$*" = "rev-parse --git-common-dir" ]; then',
        '  printf ".git\\n"',
        'fi',
        'exit 0',
      ].join('\n'),
    )
    fs.chmodSync(path.join(dir, 'git'), 0o755)
    const previousPath = capturedChildEnvironment.PATH
    capturedChildEnvironment.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
    try {
      const result = await getMediatedBundle({ cwd: dir })
      const value = result[0]?.type === 'json' ? result[0].value : undefined
      expect(
        value && 'errorMessage' in value
          ? value.errorMessage
          : 'expected an errorMessage part',
      ).toBe('Unable to build change review bundle.')
    } finally {
      capturedChildEnvironment.PATH = previousPath
    }
  })

  test('bundle prelude and scan-baseline git spawns carry the identity deadline', () => {
    // Source-level wiring pin (the escalation-disarm precedent above): the
    // bundle's 10s SNAPSHOT_ID_GIT_TIMEOUT_MS is too slow for a behavioral
    // test, so the wiring is pinned at source level while the two
    // parameterized seams (gitStatus.timeoutMs,
    // resolveWorkspaceIdentity.timeoutMs) are tested behaviorally above.
    const bundleSource = fs.readFileSync(
      path.join(import.meta.dir, '..', 'tools', 'get-change-review-bundle.ts'),
      'utf8',
    )
    // (i)+(ii) the prelude routes every spawn under the deadline.
    const preludeStart = bundleSource.indexOf(
      'const [git, head, workspace] = await Promise.all([',
    )
    expect(preludeStart).toBeGreaterThanOrEqual(0)
    const preludeEnd = bundleSource.indexOf('  ])', preludeStart)
    expect(preludeEnd).toBeGreaterThan(preludeStart)
    const prelude = bundleSource.slice(preludeStart, preludeEnd)
    expect(prelude).toContain("runGitBounded(['rev-parse', 'HEAD']")
    expect(prelude).toContain('timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS')
    expect(prelude).toContain('resolveWorkspaceIdentity({')
    // (iii) the scan-baseline resolution carries the deadline and contains
    // no bare unbounded runGit call.
    const baselineStart = bundleSource.indexOf(
      'async function resolveSecurityScanBaseline(',
    )
    expect(baselineStart).toBeGreaterThanOrEqual(0)
    const baselineEnd = bundleSource.indexOf(
      'async function resolveSecurityScan(',
      baselineStart,
    )
    expect(baselineEnd).toBeGreaterThan(baselineStart)
    const baseline = bundleSource.slice(baselineStart, baselineEnd)
    expect(baseline).not.toMatch(/\brunGit\(/)
    expect(baseline).toContain('runGitBounded(')
    expect(baseline).toContain('timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS')
    // (iv) runGitBounded lives in and is exported from git-status.ts, and
    // the bundle re-exports it so the historical import path keeps working.
    const gitStatusSource = fs.readFileSync(
      path.join(import.meta.dir, '..', 'tools', 'git-status.ts'),
      'utf8',
    )
    expect(gitStatusSource).toContain('export async function runGitBounded(')
    expect(bundleSource).toContain('export { runGitBounded }')
  })

  test('defaults the diff budget to the schema max (200k) so a realistic multi-file review is whole', async () => {
    // The bundle used to default max_chars to 80_000, which clipped a
    // realistic multi-file review mid-diff with no way for the caller to tell
    // what was cut. The default is now the schema's own max; a ~150k diff —
    // previously clipped at 80k — must arrive whole and untruncated.
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-budget-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'big.txt'), 'seed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    const changedLine = 'x'.repeat(150_000)
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${changedLine}\n`)

    const result = await getMediatedBundle({ cwd })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).not.toHaveProperty('errorMessage')
    const bundle = value as { diff: string; truncated: boolean }
    expect(bundle.diff.length).toBeGreaterThan(80_000)
    expect(bundle.diff).toContain(changedLine)
    expect(bundle.truncated).toBe(false)
  })

  test('marks a clipped diff with a self-describing, resumable elision marker', async () => {
    // When the diff IS still clipped, the marker must state the resume offset
    // and total so the orchestrator can request the rest, and the truncation
    // must surface on the OUTER bundle shape (never a plain success).
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-review-marker-'),
    )
    temporaryRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(git('init').status).toBe(0)
    expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(git('config', 'user.name', 'Openbuff Test').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'seed\n')
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-m', 'initial').status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'changed.txt'), `${'y'.repeat(4_000)}\n`)

    const parts = await mediatedGitStatus({
      cwd,
      include_diff: true,
      max_chars: 500,
    })
    const statusValue = parts[0]?.type === 'json' ? parts[0].value : undefined
    expect(
      statusValue && 'diff' in statusValue ? statusValue.diff : '',
    ).toContain('[...truncated ')
    expect(
      statusValue && 'diff' in statusValue ? statusValue.diff : '',
    ).toContain('chars at offset 500 of ')
    expect(
      statusValue && 'diff' in statusValue ? statusValue.diff : '',
    ).toContain('read individual files with read_files')
    expect(
      statusValue && 'truncated' in statusValue
        ? statusValue.truncated
        : undefined,
    ).toBe(true)

    const bundleResult = await getMediatedBundle({ cwd, max_chars: 500 })
    const bundleValue =
      bundleResult[0]?.type === 'json' ? bundleResult[0].value : undefined
    expect(bundleValue).not.toHaveProperty('errorMessage')
    const bundle = bundleValue as { diff: string; truncated: boolean }
    // Outer shape, not only the nested git payload: a clipped diff is never
    // reported as an untruncated success.
    expect(bundle.truncated).toBe(true)
    expect(bundle.diff).toContain('[...truncated ')
    expect(bundle.diff).toContain('read individual files with read_files')
  })
})
