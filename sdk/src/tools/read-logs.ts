import * as fs from 'fs'
import * as path from 'path'

import { jobRegistry } from '@codebuff/common/util/job-registry'

import { getBackgroundJob, safeOpenJobLogForRead } from './background-jobs'
import { resolveFilePathForOperation } from './path-utils'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const DEFAULT_LINES = 200
const DEFAULT_MAX_CHARS = 20_000
const READ_CHUNK_BYTES = 64 * 1024
/**
 * Exact file shape produced by `getBackgroundJobFilePath`
 * (`openbuff-<jobId>.log` / `.json` in the OS temp dir). The path branch can
 * legally reach these through the openbuff-owned temp namespace exception, so
 * they must pass the same ownership gate as the jobId branch.
 */
const BACKGROUND_JOB_FILE_PATTERN = /^openbuff-(.+)\.(log|json)$/

/** Registry-side id backing this adapter job (recovered jobs are remapped). */
function registryIdFor(job: { jobId: string; registryJobId?: string }): string {
  return job.registryJobId ?? job.jobId
}

type ReadLogsParams = {
  cwd: string
  path?: string
  jobId?: string
  lines?: number
  max_chars?: number
  /**
   * REQUIRED trusted owner, injected from run/session state by the caller
   * (never from model/tool input). Only consulted on the jobId branch.
   */
  owner: BackgroundJobOwner
}

export async function readLogs(
  params: ReadLogsParams,
): Promise<CodebuffToolOutput<'read_logs'>> {
  const lines = Math.min(2_000, Math.max(1, params.lines ?? DEFAULT_LINES))
  const maxChars = Math.min(
    100_000,
    Math.max(100, params.max_chars ?? DEFAULT_MAX_CHARS),
  )

  if (params.jobId) {
    // Cross-session recovery re-stamps the registry record with the trusted
    // owner before the ownership assertion below.
    const job = getBackgroundJob(params.jobId, { restampOwner: params.owner })
    if (!job) {
      return [
        {
          type: 'json',
          value: {
            path: params.path ?? '',
            jobId: params.jobId,
            errorMessage: `No background job found with id "${params.jobId}".`,
          },
        },
      ]
    }

    // Ownership gate before serving the log tail: a foreign job is refused
    // with the same generic not_found error as an unknown id.
    const ownership = jobRegistry.assertOwned(registryIdFor(job), params.owner)
    if (!ownership.ok) {
      return [
        {
          type: 'json',
          value: {
            path: params.path ?? '',
            jobId: params.jobId,
            errorMessage: `No background job found with id "${params.jobId}".`,
          },
        },
      ]
    }

    const tail = readTail(job.logFile, lines, maxChars)
    if ('errorMessage' in tail) {
      return [
        {
          type: 'json',
          value: {
            path: job.logFile,
            jobId: job.jobId,
            errorMessage: tail.errorMessage,
          },
        },
      ]
    }

    return [
      {
        type: 'json',
        value: {
          path: job.logFile,
          resolvedPath: job.logFile,
          jobId: job.jobId,
          status: job.status,
          ...tail,
        },
      },
    ]
  }

  if (!params.path) {
    return [
      {
        type: 'json',
        value: {
          path: '',
          errorMessage: 'Either path or jobId is required.',
        },
      },
    ]
  }

  const requested = params.path
  // Canonical containment check: in-project paths (including openbuff-owned
  // OS temp namespaces such as background-job logs and tmux captures) pass;
  // traversal, sibling-prefix and escaping-symlink paths are refused.
  const resolved = resolveFilePathForOperation(params.cwd, requested)
  if (!resolved) {
    return [
      {
        type: 'json',
        value: {
          path: requested,
          errorMessage: `Path is outside the project directory: ${requested}`,
        },
      },
    ]
  }

  // Ownership gate for the owned-temp exception: a resolved path that names a
  // background-job log/metadata file exposes another session's output, owner
  // record and full command line, so it must clear the SAME authorization the
  // jobId branch enforces. Deliberately no `restampOwner`: a path lookup must
  // never upgrade ownership. A foreign job is refused with the jobId branch's
  // generic not_found text so this branch is not an existence oracle either.
  // Names unknown to this process are unrelated `openbuff-` artifacts (e.g. a
  // basher full log) and stay readable.
  const jobFileMatch = path
    .basename(resolved.operationPath)
    .match(BACKGROUND_JOB_FILE_PATTERN)
  if (jobFileMatch) {
    const jobId = jobFileMatch[1]
    const job = getBackgroundJob(jobId)
    if (job && !jobRegistry.assertOwned(registryIdFor(job), params.owner).ok) {
      return [
        {
          type: 'json',
          value: {
            path: requested,
            jobId,
            errorMessage: `No background job found with id "${jobId}".`,
          },
        },
      ]
    }
  }

  const tail = readTail(resolved.operationPath, lines, maxChars)
  if ('errorMessage' in tail) {
    return [
      {
        type: 'json',
        value: {
          path: requested,
          errorMessage: tail.errorMessage,
        },
      },
    ]
  }

  return [
    {
      type: 'json',
      value: {
        path: requested,
        resolvedPath: resolved.operationPath,
        ...tail,
      },
    },
  ]
}

function readTail(
  filePath: string,
  lines: number,
  maxChars: number,
):
  | { lines: number; content: string; truncated?: boolean }
  | { lines: number; content: string; errorMessage: string } {
  const opened = safeOpenJobLogForRead(filePath)
  if ('errorMessage' in opened) {
    return {
      lines: 0,
      content: '',
      errorMessage: opened.errorMessage,
    }
  }

  const { fd, size } = opened
  try {
    let collected = ''
    let lineCount = 0
    let offset = size
    while (offset > 0 && lineCount <= lines) {
      const length = Math.min(READ_CHUNK_BYTES, offset)
      offset -= length
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, offset)
      const chunk = buf.toString('utf8')
      collected = chunk + collected
      lineCount = (collected.match(/\n/g) ?? []).length
    }

    const endsWithNewline = collected.endsWith('\n')
    const allLines = collected.split('\n')
    if (endsWithNewline) {
      allLines.pop()
    }
    const selectedLines = allLines.slice(-lines)
    const tail =
      selectedLines.join('\n') +
      (endsWithNewline && selectedLines.length > 0 ? '\n' : '')
    let truncated = false
    let content = tail
    if (content.length > maxChars) {
      content = content.slice(content.length - maxChars)
      truncated = true
    }

    return {
      lines: Math.min(lines, allLines.length),
      content,
      ...(truncated ? { truncated: true } : {}),
    }
  } finally {
    fs.closeSync(fd)
  }
}
