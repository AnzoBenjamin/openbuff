import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import path from 'path'
import { promisify } from 'util'

import { getErrorObject } from '@codebuff/common/util/error'
import {
  captureEvaluationCommand,
  createEvaluationExecution,
  deriveEvaluationExecution,
  isExecutionRefusal,
  prepareEvaluationCommand,
} from '../buffbench/execution'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'

/**
 * Build the `git clone` invocation for a repo URL. `file://` URLs pointing at
 * a non-bare worktree fail with exit 128 under `git clone --depth 1` because
 * git refuses to shallow-copy a checked-out local repo; `--no-local` forces
 * the remote transport, which supports `--depth 1` against worktrees.
 */
const execFileAsync = promisify(execFile)

/** Discard setup output as before, and stop the command tree on cancellation. */
async function runInit(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  execution?: ExecutionAdapterContext,
): Promise<void> {
  const dispatch = await prepareEvaluationCommand(command, [], {
    cwd,
    env,
    signal,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    execution,
    branchId: 'supplemental.evaluator.setup.init',
  })
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'))
    const child = dispatch()
    const abort = () => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        /* The process may have exited already. */
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(signal.reason ?? new Error('Aborted'))
      else if (code === 0) resolve()
      else reject(new Error(`Init command exited with code ${code}`))
    })
  })
}

async function runSetupGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  execution: ExecutionAdapterContext | undefined,
  step: string,
): Promise<{ stdout: string; stderr: string }> {
  if (!execution) return execFileAsync('git', args, options)
  return captureEvaluationCommand('git', args, {
    ...options,
    execution,
    branchId: `supplemental.evaluator.setup.${step}`,
  })
}

function cloneArgs(repoUrl: string, repoDir: string): string[] {
  return [
    'clone',
    ...(repoUrl.startsWith('file://') ? ['--no-local'] : []),
    '--depth',
    '1',
    '--',
    repoUrl,
    repoDir,
  ]
}

/**
 * Helper function to manage test repository lifecycle
 * Sets up a test repo, runs a function with the repo cwd, then cleans up
 */
export const withTestRepo = async <T>(
  repoConfig: {
    repoUrl: string
    // The sha of the commit to checkout. If you have a commit with changes to replicate, you would check out the parent commit.
    parentSha: string
    initCommand?: string
    env?: Record<string, string>
    inheritEnv?: boolean
    signal?: AbortSignal
    execution?: ExecutionAdapterContext
  },
  fn: (cwd: string) => Promise<T>,
): Promise<T> => {
  const {
    repoUrl,
    parentSha,
    initCommand,
    env,
    signal,
    inheritEnv = true,
  } = repoConfig
  const execution = deriveEvaluationExecution(
    repoConfig.execution ??
      createEvaluationExecution({
        cwd: process.cwd(),
        env,
        inheritEnv,
        signal,
      }),
    'evaluator.setup',
  )
  const executionEnv = env

  // Create a temporary directory for the test repo
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    await runSetupGit(
      cloneArgs(repoUrl, repoDir),
      {
        cwd: tempDir,
        signal,
        env: executionEnv,
      },
      execution,
      'clone',
    )
    await runSetupGit(
      ['fetch', '--depth', '1', 'origin', parentSha],
      {
        cwd: repoDir,
        signal,
        env: executionEnv,
      },
      execution,
      'fetch',
    )
    await runSetupGit(
      ['checkout', parentSha],
      {
        cwd: repoDir,
        signal,
        env: executionEnv,
      },
      execution,
      'checkout',
    )

    if (initCommand) {
      console.log(`Running init command: ${initCommand}...`)
      try {
        await runInit(
          initCommand,
          repoDir,
          executionEnv ?? {},
          signal,
          execution,
        )
      } catch (error) {
        if (signal?.aborted || isExecutionRefusal(error)) throw error
        console.error(
          `Error running init command: ${getErrorObject(error).message}`,
        )
      }
    }

    // Run the provided function with the repo directory
    return await fn(repoDir)
  } finally {
    // Clean up the temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Failed to clean up temporary directory: ${error}`)
    }
  }
}

export const withTestRepoAndParent = async <T>(
  repoConfig: {
    repoUrl: string
    commitSha: string
    initCommand?: string
    signal?: AbortSignal
    env?: Record<string, string>
    inheritEnv?: boolean
    execution?: ExecutionAdapterContext
  },
  fn: (cwd: string, commitSha: string, parentSha: string) => Promise<T>,
): Promise<T | null> => {
  const { repoUrl, commitSha, initCommand, signal } = repoConfig
  const execution = deriveEvaluationExecution(
    repoConfig.execution ??
      createEvaluationExecution({
        cwd: process.cwd(),
        env: repoConfig.env,
        inheritEnv: repoConfig.inheritEnv,
        signal,
      }),
    'evaluator.setup-parent',
  )
  const executionEnv = repoConfig.env

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    await runSetupGit(
      cloneArgs(repoUrl, repoDir),
      { cwd: tempDir, signal, env: executionEnv },
      execution,
      'clone',
    )

    await runSetupGit(
      ['fetch', '--depth', '2', 'origin', commitSha],
      {
        cwd: repoDir,
        signal,
        env: executionEnv,
      },
      execution,
      'fetch-parent',
    )

    await runSetupGit(
      ['checkout', commitSha],
      {
        cwd: repoDir,
        signal,
        env: executionEnv,
      },
      execution,
      'checkout-commit',
    )

    let parentSha: string
    try {
      const { stdout } = await runSetupGit(
        ['log', '--pretty=%P', '-n', '1', commitSha],
        {
          cwd: repoDir,
          signal,
          env: executionEnv,
        },
        execution,
        'parent-log',
      )
      const parents = stdout.trim()

      if (!parents) {
        console.warn(
          `Commit ${commitSha.slice(0, 8)} has no parent (initial commit)`,
        )
        return null
      }

      const parentList = parents.split(' ')
      if (parentList.length > 1) {
        console.warn(
          `Commit ${commitSha.slice(0, 8)} is a merge commit (${parentList.length} parents)`,
        )
        return null
      }

      parentSha = parentList[0]
    } catch (error) {
      if (signal?.aborted || isExecutionRefusal(error)) throw error
      console.error(`Error getting parent for ${commitSha.slice(0, 8)}:`, error)
      return null
    }

    await runSetupGit(
      ['checkout', parentSha],
      {
        cwd: repoDir,
        signal,
        env: executionEnv,
      },
      execution,
      'checkout-parent',
    )

    if (initCommand) {
      console.log(`Running init command: ${initCommand}...`)
      await runInit(initCommand, repoDir, executionEnv ?? {}, signal, execution)
    }

    return await fn(repoDir, commitSha, parentSha)
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Failed to clean up temporary directory: ${error}`)
    }
  }
}
