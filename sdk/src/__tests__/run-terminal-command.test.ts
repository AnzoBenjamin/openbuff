import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { jobRegistry } from '@codebuff/common/util/job-registry'
import { getOwnedTempRoots } from '@codebuff/common/util/project-path-containment'

import {
  __clearJobsForTest,
  getBackgroundJob,
  killBackgroundJob,
  startBackgroundJob,
} from '../tools/background-jobs'
import {
  findWindowsBash,
  runTerminalCommand,
} from '../tools/run-terminal-command'

describe('Windows bash prerequisite', () => {
  it('honors the Openbuff-specific Git Bash override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-bash-'))
    const bashPath = path.join(dir, 'bash.exe')
    fs.writeFileSync(bashPath, '')
    try {
      expect(findWindowsBash({ OPENBUFF_GIT_BASH_PATH: bashPath })).toBe(
        bashPath,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runTerminalCommand cwd containment', () => {
  it('requires approval authorization before a high-impact assistant command', async () => {
    let classifiedAction: string | undefined
    const result = await runTerminalCommand({
      command: 'git push -u origin feature/safe',
      process_type: 'SYNC',
      mode: 'assistant',
      permission_profile: 'git-commit',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 5,
      authorizeHighImpactAction: async (action) => {
        classifiedAction = action.action
        return {
          allowed: false,
          approvalRequired: true,
          reason: 'No matching receipt.',
        }
      },
    })

    expect(classifiedAction).toBe('push')
    expect(result[0].value).toMatchObject({
      permissionDenied: true,
      approvalRequired: true,
      harnessAction: 'push',
    })
  })

  it('returns a structured timeout result with partial output', async () => {
    const result = await runTerminalCommand({
      command: 'printf started; sleep 30',
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 0.05,
    })
    const value = result[0].value as {
      timedOut?: boolean
      errorMessage?: string
      stdout?: string
    }

    expect(value.timedOut).toBe(true)
    expect(value.errorMessage).toContain('timed out')
    expect(value.stdout).toContain('started')
  })

  it('cancels an owned background job when the request aborts', async () => {
    const controller = new AbortController()
    const owner = {
      clientSessionId: 'session-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-1',
      parentAgentId: 'agent-1',
    }
    let value: { jobId?: string; detached?: boolean } | undefined
    try {
      const result = await runTerminalCommand({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeout_seconds: 5,
        signal: controller.signal,
        owner,
      })
      value = result[0].value as { jobId?: string; detached?: boolean }
      expect(value.detached).toBe(false)
      expect(value.jobId).toBeDefined()

      const runningJob = getBackgroundJob(value.jobId!)
      expect(runningJob?.owner).toEqual(owner)
      expect(
        JSON.parse(fs.readFileSync(runningJob!.metadataFile, 'utf8')).owner,
      ).toEqual(owner)

      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const job = getBackgroundJob(value.jobId!)
      // An abort-initiated kill is an intentional stop, recorded as 'stopped'
      // (distinct from an error/non-zero natural exit).
      expect(job?.status).toBe('stopped')
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
    }
  })

  it('terminates a background job that exceeds the bounded log quota', async () => {
    let value: { jobId?: string } | undefined
    try {
      const result = await runTerminalCommand({
        command: 'yes x | head -c 12000000; sleep 30',
        process_type: 'BACKGROUND',
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeout_seconds: 5,
      })
      value = result[0].value as { jobId?: string }
      expect(value.jobId).toBeDefined()

      const deadline = Date.now() + 5_000
      let job = getBackgroundJob(value.jobId!)
      while (job?.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        job = getBackgroundJob(value.jobId!)
      }

      expect(job?.status).toBe('error')
      expect(fs.statSync(job!.logFile).size).toBeLessThanOrEqual(10 * 1024 * 1024)
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
    }
  })

  it('accepts the project root itself as cwd', async () => {
    const result = await runTerminalCommand({
      command: 'pwd',
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; stdout?: string }
    expect(value.errorMessage).toBeUndefined()
    expect(value.stdout).toContain(process.cwd())
  })

  it('rejects an absolute cwd outside the project with a structured error', async () => {
    const result = await runTerminalCommand({
      command: 'echo hello',
      process_type: 'SYNC',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; command?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('/etc')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a parent-traversal cwd with a structured error', async () => {
    const result = await runTerminalCommand({
      command: 'echo hello',
      process_type: 'SYNC',
      cwd: '../../outside',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a BACKGROUND process whose cwd escapes the project', async () => {
    const result = await runTerminalCommand({
      command: 'echo hello',
      process_type: 'BACKGROUND',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a BACKGROUND process whose cwd escapes the explicit project root', async () => {
    const result = await runTerminalCommand({
      command: 'echo hello',
      process_type: 'BACKGROUND',
      cwd: '/etc',
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects an openbuff-owned temp directory as cwd without running the command', async () => {
    // The owned-temp exception lets tools READ openbuff's own artifacts; it
    // must never host a child process. `resolvedCwd.scope === 'owned-temp'`
    // is what refuses this, so the directory is created for real (an existing
    // path that a bad implementation could actually spawn in).
    const ownedTempDir = fs.mkdtempSync(
      path.join(getOwnedTempRoots()[0], 'openbuff-terminal-cwd-'),
    )
    const sentinel = path.join(ownedTempDir, 'executed.txt')
    try {
      const result = await runTerminalCommand({
        command: `printf executed > '${sentinel}'`,
        process_type: 'SYNC',
        cwd: ownedTempDir,
        projectRoot: process.cwd(),
        timeout_seconds: 5,
      })
      const value = result[0].value as {
        errorMessage?: string
        stdout?: string
        exitCode?: number
      }

      expect(value.errorMessage).toContain('outside the project directory')
      // Nothing ran: no captured output, no exit code, no side effect on disk.
      expect(value.stdout).toBeUndefined()
      expect(value.exitCode).toBeUndefined()
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      fs.rmSync(ownedTempDir, { recursive: true, force: true })
    }
  })

  it('preserves the command field in the error result for debugging', async () => {
    const result = await runTerminalCommand({
      command: 'rm -rf /',
      process_type: 'SYNC',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; command?: string }
    expect(value.command).toBe('rm -rf /')
  })

  it('runs inside the dereferenced target of an in-project cwd symlink', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-root-'))
    try {
      const realDirectory = path.join(projectRoot, 'real')
      fs.mkdirSync(realDirectory)
      fs.symlinkSync(realDirectory, path.join(projectRoot, 'link'))

      const result = await runTerminalCommand({
        command: 'pwd -P',
        process_type: 'SYNC',
        cwd: 'link',
        projectRoot,
        timeout_seconds: 5,
      })
      const value = result[0].value as {
        errorMessage?: string
        stdout?: string
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.stdout?.trim()).toBe(fs.realpathSync(realDirectory))
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a cwd symlink that resolves outside the project root', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-root-'))
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-outside-'),
    )
    try {
      fs.symlinkSync(outsideRoot, path.join(projectRoot, 'escape'))

      const result = await runTerminalCommand({
        command: 'pwd',
        process_type: 'SYNC',
        cwd: 'escape',
        projectRoot,
        timeout_seconds: 5,
      })
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain('outside the project directory')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})

function initTempGitRepo(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
  expect(run(['init']).status).toBe(0)
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  // Optional initial commit keeps porcelain stable across git versions.
  fs.writeFileSync(path.join(projectRoot, 'README'), 'seed\n')
  run(['add', 'README'])
  run(['commit', '-m', 'seed'])
  return projectRoot
}

describe('runTerminalCommand SYNC dirty-delta touchedPaths', () => {
  it('reports newly created project files in touchedPaths', async () => {
    const projectRoot = initTempGitRepo('terminal-dirty-')
    try {
      // Pre-existing dirt must not appear in the delta.
      fs.writeFileSync(path.join(projectRoot, 'already-dirty.txt'), 'old\n')

      const result = await runTerminalCommand({
        command: 'printf new > created-by-sync.txt',
        process_type: 'SYNC',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
        exitCode?: number
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toContain('created-by-sync.txt')
      expect(value.touchedPaths).not.toContain('already-dirty.txt')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('attributes paths relative to projectRoot when cwd is a subdirectory', async () => {
    const projectRoot = initTempGitRepo('terminal-dirty-')
    try {
      const sub = path.join(projectRoot, 'pkg')
      fs.mkdirSync(sub)

      const result = await runTerminalCommand({
        command: 'printf nested > from-sub.txt',
        process_type: 'SYNC',
        cwd: 'pkg',
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toContain('pkg/from-sub.txt')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('omits touchedPaths when the project is not a git repo', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-nongit-'),
    )
    try {
      const result = await runTerminalCommand({
        command: 'printf x > bare.txt',
        process_type: 'SYNC',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('runTerminalCommand BACKGROUND dirty snapshot at start', () => {
  it('stores pre-start dirty snapshot on the job without emitting touchedPaths', async () => {
    const projectRoot = initTempGitRepo('terminal-bg-dirty-')
    let value: {
      jobId?: string
      touchedPaths?: string[]
      backgroundProcessStatus?: string
    } | undefined
    try {
      fs.writeFileSync(path.join(projectRoot, 'already-dirty.txt'), 'old\n')

      const result = await runTerminalCommand({
        command: 'printf new > created-by-bg.txt; sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      })
      value = result[0].value as {
        jobId?: string
        touchedPaths?: string[]
        backgroundProcessStatus?: string
      }

      expect(value.jobId).toBeDefined()
      expect(value.backgroundProcessStatus).toBe('running')
      // Start must never credit settlement dirt.
      expect(value.touchedPaths).toBeUndefined()

      const job = getBackgroundJob(value.jobId!)
      expect(job?.projectRoot).toBe(projectRoot)
      expect(job?.dirtyBeforePaths).toContain('already-dirty.txt')
      expect(job?.dirtyBeforePaths).not.toContain('created-by-bg.txt')
      expect(job?.settlementTouchedPaths).toBeUndefined()
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('omits dirtyBeforePaths when the project is not a git repo', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-bg-nongit-'),
    )
    let value: { jobId?: string; touchedPaths?: string[] } | undefined
    try {
      const result = await runTerminalCommand({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      })
      value = result[0].value as {
        jobId?: string
        touchedPaths?: string[]
      }
      expect(value.jobId).toBeDefined()
      expect(value.touchedPaths).toBeUndefined()

      const job = getBackgroundJob(value.jobId!)
      expect(job?.projectRoot).toBe(projectRoot)
      expect(job?.dirtyBeforePaths).toBeUndefined()
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('startBackgroundJob failed-spawn log file preservation', () => {
  const FORCED_ID = 'job-test-forced-eexist'
  const FOREIGN_CONTENT = 'foreign log data that must survive\n'
  let foreignLogFile: string | undefined
  let createSpy: { mockRestore(): void } | undefined

  afterEach(() => {
    createSpy?.mockRestore()
    createSpy = undefined
    if (foreignLogFile !== undefined) {
      fs.rmSync(foreignLogFile, { force: true })
      foreignLogFile = undefined
    }
    __clearJobsForTest()
  })

  it('preserves a pre-existing foreign log when creation hits EEXIST', () => {
    foreignLogFile = path.join(os.tmpdir(), `openbuff-${FORCED_ID}.log`)
    fs.writeFileSync(foreignLogFile, FOREIGN_CONTENT)

    // Force the registry to allocate exactly the id whose log file already
    // exists, so safeCreateJobLogFile's O_EXCL create fails with EEXIST and
    // the catch block runs before spawn is ever reached.
    const realCreate = jobRegistry.create.bind(jobRegistry)
    const spy = spyOn(jobRegistry, 'create').mockImplementation((opts) => {
      realCreate({ ...opts, jobId: FORCED_ID })
      return jobRegistry.get(FORCED_ID)!
    })
    createSpy = spy

    try {
      expect(() =>
        startBackgroundJob({
          command: 'sleep 30',
          shell: 'sh',
          shellArgs: ['-c'],
          cwd: process.cwd(),
          env: { ...process.env },
          owner: {
            clientSessionId: 'session-eexist',
            rootRunId: 'root-eexist',
            parentRunId: 'parent-eexist',
            parentAgentId: 'agent-eexist',
          },
        }),
      ).toThrow()
    } finally {
      spy.mockRestore()
      createSpy = undefined
    }

    // The failed-spawn cleanup must not delete a pre-existing/foreign log
    // file this spawn never created (logFileCreatedByThisSpawn guard).
    expect(fs.existsSync(foreignLogFile)).toBe(true)
    expect(fs.readFileSync(foreignLogFile, 'utf8')).toBe(FOREIGN_CONTENT)
  })
})
