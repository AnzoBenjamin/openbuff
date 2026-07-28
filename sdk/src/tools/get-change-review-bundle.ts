import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { LocalHarnessStore } from '../services/local-harness-store'
import { resolveWorkspaceIdentity } from '../services/repository-identity'
import { gitStatus, runGit } from './git-status'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'

const normalizeFile = (file: string) =>
  file.replace(/\\/g, '/').replace(/^\.\//, '')

const isSessionArtifactPath = (file: string): boolean => {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized.startsWith('.agents/sessions/')
}

async function buildSnapshotId(params: {
  cwd: string
  headCommit: string
  status: string
  files: string[]
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
}): Promise<string> {
  // Presentation diffs are intentionally bounded. Snapshot identity must not
  // be: hash the complete tracked diff plus the bytes of untracked files.
  const fullDiff = await runGit(
    ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agents/sessions/**'],
    params.cwd,
    params.signal,
  )
  if (fullDiff.exitCode !== 0 && fullDiff.exitCode !== 1) {
    throw new Error(
      fullDiff.stderr.trim() ||
        `git diff exited with code ${fullDiff.exitCode}.`,
    )
  }
  const hash = createHash('sha256')
    .update(
      `${params.headCommit}\0${params.status}\0${params.workspaceState?.revision ?? 'unknown'}\0${params.workspaceState?.snapshotId ?? 'unknown'}\0`,
    )
    .update(fullDiff.stdout)
  for (const file of [...params.files].sort()) {
    const absolute = path.join(params.cwd, file)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue
    // Tracked content is already represented by the complete diff. Adding all
    // current bytes also binds untracked files and protects against parsing
    // omissions in porcelain status output.
    hash.update(`\0${file}\0`).update(fs.readFileSync(absolute))
  }
  return hash.digest('hex')
}

export async function getChangeReviewBundle(params: {
  cwd: string
  stateDir?: string
  max_chars?: number
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
}): Promise<CodebuffToolOutput<'get_change_review_bundle'>> {
  const [git, head, workspace] = await Promise.all([
    gitStatus({
      cwd: params.cwd,
      include_diff: true,
      max_chars: params.max_chars ?? 80_000,
      signal: params.signal,
    }),
    runGit(['rev-parse', 'HEAD'], params.cwd, params.signal),
    resolveWorkspaceIdentity({ cwd: params.cwd, signal: params.signal }),
  ])
  const value = git[0]?.type === 'json' ? git[0].value : undefined
  if (!value || 'errorMessage' in value || head.exitCode !== 0) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            (value && 'errorMessage' in value
              ? value.errorMessage
              : undefined) ??
            head.stderr.trim() ??
            'Unable to build change review bundle.',
        },
      },
    ]
  }
  const headCommit = head.stdout.trim()
  const status = value.status
  let diff = value.diff ?? ''
  // Derive `files` and the identity status from an uncollapsed porcelain
  // listing. `gitStatus` runs `git status --short --branch`, which collapses a
  // fully untracked directory into a single shallow entry (e.g. `?? .agents/`)
  // that would slip past `isSessionArtifactPath`. `-uall` lists every untracked
  // file individually so session artifacts are matched and filtered reliably.
  const porcelain = await runGit(
    ['status', '--porcelain', '-uall'],
    params.cwd,
    params.signal,
  )
  if (porcelain.exitCode !== 0) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            porcelain.stderr.trim() ||
            `git status exited with code ${porcelain.exitCode}.`,
        },
      },
    ]
  }
  const identityLines = porcelain.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
  let files = identityLines
    .map((line) => line.slice(3).split(' -> ').at(-1)?.trim() ?? '')
    .filter(Boolean)
  // Fallback: when the worktree is clean (changes already committed), review
  // the last commit's diff so committed changes still get reviewed instead of
  // producing an empty bundle that reviewers cannot attest to.
  if (files.length === 0 && diff.trim() === '') {
    const parentCheck = await runGit(
      ['rev-parse', 'HEAD~1'],
      params.cwd,
      params.signal,
    )
    if (parentCheck.exitCode === 0) {
      const committedDiff = await runGit(
        ['diff', '--no-color', 'HEAD~1', 'HEAD', '--'],
        params.cwd,
        params.signal,
      )
      if (committedDiff.exitCode === 0 || committedDiff.exitCode === 1) {
        diff = committedDiff.stdout
        const committedFiles = new Set<string>()
        for (const line of diff.split('\n')) {
          const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
          if (match) committedFiles.add(match[1])
        }
        files = [...committedFiles]
      }
    }
  }
  // Session plan artifacts under `.agents/sessions/**` are written mid-review
  // and must not drift the snapshot identity or leak into the reviewed files.
  files = files.filter((f) => !isSessionArtifactPath(f))
  // Drop session-artifact lines from the porcelain status used for identity
  // while still returning the real, unfiltered status for display/debugging.
  const identityStatus = identityLines
    .filter((line) => {
      const p = line.slice(3).split(' -> ').at(-1)?.trim() ?? ''
      return p ? !isSessionArtifactPath(p) : true
    })
    .join('\n')
  let snapshotId: string
  try {
    snapshotId = await buildSnapshotId({
      cwd: params.cwd,
      headCommit,
      status: identityStatus,
      files,
      workspaceState: params.workspaceState,
      signal: params.signal,
    })
  } catch (error) {
    return [
      {
        type: 'json',
        value: {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      },
    ]
  }
  let ownership: Record<string, unknown>[] = []
  let validation: Record<string, unknown>[] = []
  let findings: Record<string, unknown>[] = []
  if (params.stateDir) {
    const store = new LocalHarnessStore(params.stateDir)
    const changedFiles = new Set(files.map(normalizeFile))
    const inScope = (record: Record<string, unknown>, recordFiles: string[]) =>
      record.repositoryId === workspace.repositoryId &&
      record.workspaceId === workspace.workspaceId &&
      record.snapshotId === snapshotId &&
      recordFiles.some((file) => changedFiles.has(normalizeFile(file)))
    ownership = store
      .list(workspace.repositoryId, 'ownership')
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.changes)
            ? record.changes.flatMap((change) =>
                typeof change === 'object' &&
                change &&
                'path' in change &&
                typeof change.path === 'string'
                  ? [change.path]
                  : [],
              )
            : [],
        ),
      )
    validation = store
      .list(workspace.repositoryId, 'validation')
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.files)
            ? record.files.filter(
                (file): file is string => typeof file === 'string',
              )
            : [],
        ),
      )
    findings = store
      .list(workspace.repositoryId, 'findings')
      .filter(
        (record) =>
          record.status !== 'resolved' && record.status !== 'invalidated',
      )
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.files)
            ? record.files.filter(
                (file): file is string => typeof file === 'string',
              )
            : [],
        ),
      )
  }
  return [
    {
      type: 'json',
      value: {
        snapshotId,
        repositoryId: workspace.repositoryId,
        workspaceId: workspace.workspaceId,
        workspaceRevision: params.workspaceState?.revision,
        workspaceSnapshotId: params.workspaceState?.snapshotId,
        headCommit,
        status,
        files,
        diff,
        truncated: value.truncated ?? false,
        ownership,
        validation,
        findings,
      },
    },
  ]
}
