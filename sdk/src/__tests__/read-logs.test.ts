import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  configureExternalReadRoots,
  isOwnedTempPath,
  resetExternalReadRootsForTesting,
  resolveProjectPath,
  resolveProjectPathForFileSystem,
} from '@codebuff/common/util/project-path-containment'

import {
  __clearJobsForTest,
  __registerJobForTest,
  type BackgroundJob,
} from '../tools/background-jobs'
import { resolveFilePathForFileSystemOperation } from '../tools/path-utils'
import { readLogs } from '../tools/read-logs'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

const tempDirs: string[] = []
const tempFiles: string[] = []

/** Trusted owner injected into readLogs by the run/session layer in tests. */
const TRUSTED_OWNER = {
  clientSessionId: 'session-1',
  rootRunId: 'root-1',
  parentRunId: 'parent-1',
  parentAgentId: 'agent-1',
}
const FOREIGN_OWNER = {
  clientSessionId: 'session-2',
  rootRunId: 'root-2',
  parentRunId: 'parent-2',
  parentAgentId: 'agent-2',
}

const makeTempDir = () => {
  // Deliberately NOT an `openbuff-` prefix: that is an openbuff-owned temp
  // namespace which the containment boundary allows by design, so these
  // fixtures must use a neutral prefix to stand in for ordinary
  // outside-the-project locations.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obtest-read-logs-'))
  tempDirs.push(dir)
  return dir
}

/** Absolute temp file path removed in afterEach; unique per run. */
const tempFilePath = (name: string) => {
  const file = path.join(
    os.tmpdir(),
    `${name}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.log`,
  )
  tempFiles.push(file)
  return file
}

/**
 * Shape of the `read_logs` JSON output value. Declared here (rather than
 * accepting `any`) so a shape regression fails at typecheck instead of
 * silently satisfying a `toBeUndefined()` assertion.
 */
type ReadLogsValue = {
  jobId?: string
  status?: string
  resolvedPath?: string
  content?: string
  lines?: number
  truncated?: boolean
  errorMessage?: string
}

const value = (output: Awaited<ReturnType<typeof readLogs>>): ReadLogsValue =>
  output[0].value as ReadLogsValue

afterEach(() => {
  __clearJobsForTest()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { force: true })
  }
  fs.rmSync(path.join(os.tmpdir(), 'openbuff-read-logs-job.log'), {
    force: true,
  })
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith('openbuff-job-read-logs-')) {
      fs.rmSync(path.join(os.tmpdir(), entry), { force: true })
    }
  }
})

describe('readLogs', () => {
  test('returns the requested tail of a file inside cwd', async () => {
    const cwd = makeTempDir()
    fs.writeFileSync(path.join(cwd, 'app.log'), 'one\ntwo\nthree\nfour\n')

    const result = value(
      await readLogs({
        cwd,
        path: 'app.log',
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toBeUndefined()
    expect(result.resolvedPath).toBe(path.join(cwd, 'app.log'))
    expect(result.content).toBe('three\nfour\n')
  })

  test('rejects relative paths outside cwd', async () => {
    const cwd = makeTempDir()
    const outside = makeTempDir()
    fs.writeFileSync(path.join(outside, 'secret.log'), 'secret\n')

    const result = value(
      await readLogs({
        cwd,
        path: path.relative(cwd, path.join(outside, 'secret.log')),
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toContain('outside the project directory')
  })

  test('rejects absolute paths outside cwd', async () => {
    const cwd = makeTempDir()
    const outside = makeTempDir()
    const outsideFile = path.join(outside, 'secret.log')
    fs.writeFileSync(outsideFile, 'secret\n')

    const result = value(
      await readLogs({ cwd, path: outsideFile, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('outside the project directory')
  })

  test('rejects symlinks that resolve outside cwd', async () => {
    const cwd = makeTempDir()
    const outside = makeTempDir()
    const outsideFile = path.join(outside, 'secret.log')
    fs.writeFileSync(outsideFile, 'secret\n')
    fs.symlinkSync(outsideFile, path.join(cwd, 'link.log'))

    const result = value(
      await readLogs({ cwd, path: 'link.log', owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('outside the project directory')
  })

  test('reads an openbuff-owned temp log by absolute path', async () => {
    const cwd = makeTempDir()
    // `openbuff-job-read-logs-*` is an openbuff-owned temp namespace, so it is
    // reachable by path even though it lives outside the project.
    const ownedLog = tempFilePath('openbuff-job-read-logs-owned')
    fs.writeFileSync(ownedLog, 'one\ntwo\nthree\n')

    const result = value(
      await readLogs({
        cwd,
        path: ownedLog,
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toBeUndefined()
    // Compared against the realpath: on macOS `os.tmpdir()` is a symlinked
    // `/var/folders/...` path.
    expect(result.resolvedPath).toBe(fs.realpathSync(ownedLog))
    expect(result.content).toBe('two\nthree\n')
  })

  test('rejects a non-owned temp path outside cwd', async () => {
    const cwd = makeTempDir()
    const notOwned = tempFilePath('not-owned')
    fs.writeFileSync(notOwned, 'secret\n')

    const result = value(
      await readLogs({ cwd, path: notOwned, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('outside the project directory')
    expect(result.content).toBeUndefined()
  })

  test('reads a background job log by jobId', async () => {
    const cwd = makeTempDir()
    const logFile = path.join(os.tmpdir(), 'openbuff-read-logs-job.log')
    fs.writeFileSync(logFile, 'alpha\nbeta\ngamma\n')

    const job: BackgroundJob = {
      jobId: 'job-read-logs-test',
      command: 'echo test',
      child: { pid: 1234 } as unknown as BackgroundJob['child'],
      logFile,
      metadataFile: `${logFile}.json`,
      status: 'running',
      exitCode: null,
      startedAt: 0,
      readOffset: 0,
      owner: TRUSTED_OWNER,
    }
    __registerJobForTest(job)

    const result = value(
      await readLogs({
        cwd,
        jobId: job.jobId,
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toBeUndefined()
    expect(result.jobId).toBe(job.jobId)
    expect(result.status).toBe('running')
    expect(result.resolvedPath).toBe(logFile)
    expect(result.content).toBe('beta\ngamma\n')
  })

  test('does not follow an in-memory background job log symlink swapped in before reading', async () => {
    const cwd = makeTempDir()
    const secretLog = path.join(cwd, 'secret-swap.log')
    const logFile = path.join(os.tmpdir(), 'openbuff-read-logs-job.log')
    fs.writeFileSync(logFile, 'safe\n')
    fs.writeFileSync(secretLog, 'secret\n')

    const job: BackgroundJob = {
      jobId: 'job-read-logs-swap',
      command: 'echo test',
      child: { pid: 1234 } as unknown as BackgroundJob['child'],
      logFile,
      metadataFile: `${logFile}.json`,
      status: 'running',
      exitCode: null,
      startedAt: 0,
      readOffset: 0,
      owner: TRUSTED_OWNER,
    }
    __registerJobForTest(job)
    fs.rmSync(logFile, { force: true })
    fs.symlinkSync(secretLog, logFile)

    const result = value(
      await readLogs({
        cwd,
        jobId: job.jobId,
        lines: 10,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toContain('Path is not a regular file')
    expect(result.content).toBeUndefined()
  })

  test('rejects unsafe jobId values without reading derived paths', async () => {
    const cwd = makeTempDir()
    const result = value(
      await readLogs({
        cwd,
        jobId: 'job-read-logs/../../secret',
        lines: 10,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toContain('No background job found')
  })

  test('refuses a foreign-owned job log with a generic not_found error', async () => {
    const cwd = makeTempDir()
    const logFile = path.join(os.tmpdir(), 'openbuff-read-logs-job.log')
    fs.writeFileSync(logFile, 'secret\n')

    const job: BackgroundJob = {
      jobId: 'job-read-logs-foreign',
      command: 'echo test',
      child: { pid: 1234 } as unknown as BackgroundJob['child'],
      logFile,
      metadataFile: `${logFile}.json`,
      status: 'running',
      exitCode: null,
      startedAt: 0,
      readOffset: 0,
      owner: TRUSTED_OWNER,
    }
    __registerJobForTest(job)

    const result = value(
      await readLogs({
        cwd,
        jobId: job.jobId,
        lines: 10,
        owner: FOREIGN_OWNER,
      }),
    )

    expect(result.errorMessage).toContain(
      `No background job found with id "${job.jobId}"`,
    )
    expect(result.content).toBeUndefined()
  })

  test('refuses a foreign-owned job log read by absolute path with a generic not_found error', async () => {
    const cwd = makeTempDir()
    // The file name is the background-job log name for a REGISTERED job, so
    // the path branch must run the ownership gate instead of treating it as
    // an anonymous openbuff-owned temp file.
    const jobId = 'job-read-logs-path-gate'
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    fs.writeFileSync(logFile, 'secret\n')

    const job: BackgroundJob = {
      jobId,
      command: 'echo test',
      child: { pid: 1234 } as unknown as BackgroundJob['child'],
      logFile,
      metadataFile: `${logFile}.json`,
      status: 'running',
      exitCode: null,
      startedAt: 0,
      readOffset: 0,
      owner: TRUSTED_OWNER,
    }
    __registerJobForTest(job)

    const result = value(
      await readLogs({ cwd, path: logFile, lines: 10, owner: FOREIGN_OWNER }),
    )

    expect(result.errorMessage).toContain('No background job found with id')
    expect(result.content).toBeUndefined()
  })

  test('a model-supplied owner cannot override the trusted owner for a jobId read', async () => {
    const cwd = makeTempDir()
    const logFile = path.join(os.tmpdir(), 'openbuff-read-logs-job.log')
    fs.writeFileSync(logFile, 'safe\n')

    const job: BackgroundJob = {
      jobId: 'job-read-logs-override',
      command: 'echo test',
      child: { pid: 1234 } as unknown as BackgroundJob['child'],
      logFile,
      metadataFile: `${logFile}.json`,
      status: 'running',
      exitCode: null,
      startedAt: 0,
      readOffset: 0,
      owner: TRUSTED_OWNER,
    }
    __registerJobForTest(job)

    // Simulate the run.ts dispatch: spread the (hostile) model input, then
    // pin owner to the trusted value. The trusted owner wins.
    const modelInput = { jobId: job.jobId, owner: FOREIGN_OWNER }
    const result = value(
      await readLogs({ ...modelInput, cwd, lines: 10, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toBeUndefined()
    expect(result.content).toBe('safe\n')
  })

  test('does not trust recovered background job metadata with an unexpected log path', async () => {
    const cwd = makeTempDir()
    const secretLog = path.join(cwd, 'secret.log')
    const jobId = 'job-read-logs-malicious'
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    fs.writeFileSync(secretLog, 'secret\n')
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'echo test',
        processId: null,
        logFile: secretLog,
        status: 'completed',
        exitCode: 0,
        startedAt: 0,
      }),
    )

    const result = value(
      await readLogs({ cwd, jobId, lines: 10, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('No background job found')
    expect(result.content).toBeUndefined()
  })

  test('rejects recovered background job logs that are symlinks', async () => {
    const cwd = makeTempDir()
    const secretLog = path.join(cwd, 'secret.log')
    const jobId = 'job-read-logs-symlink'
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    fs.writeFileSync(secretLog, 'secret\n')
    fs.symlinkSync(secretLog, logFile)
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'echo test',
        processId: null,
        logFile,
        status: 'completed',
        exitCode: 0,
        startedAt: 0,
      }),
    )

    const result = value(
      await readLogs({ cwd, jobId, lines: 10, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('No background job found')
    expect(result.content).toBeUndefined()
  })

  test('bounds the backward scan for a newline-free file larger than the byte ceiling', async () => {
    const cwd = makeTempDir()
    // One head line followed by a single newline-free run far larger than the
    // byte ceiling. Before ER-6 the backward scan read the WHOLE file into one
    // growing JS string, because `lineCount` never advanced past `lines` for
    // newline-free input and the `lines`/`max_chars` caps only bound the
    // returned slice.
    fs.writeFileSync(
      path.join(cwd, 'huge.log'),
      `HEADMARKER\n${'x'.repeat(300_000)}`,
    )

    const result = value(
      await readLogs({ cwd, path: 'huge.log', owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toBeUndefined()
    expect(result.truncated).toBe(true)
    // The default max_chars (20_000) bounds the returned slice...
    expect(result.content?.length).toBe(20_000)
    // ...and the byte-bounded scan never reached the head of the file, so the
    // reported line count describes only the bounded region it actually read.
    expect(result.content).not.toContain('HEADMARKER')
    expect(result.lines).toBe(1)
  })
})

describe('readLogs — allowlisted external read roots', () => {
  beforeEach(() => {
    // The registry is configure-once per PROCESS, and `run.ts` legitimately
    // configures it (with the openbuff config dir) as soon as any suite in this
    // process exercises a run. Reset BEFORE configuring, or the strict
    // `configureExternalReadRoots` throws on the differing set and this test
    // passes in isolation while failing in a full-directory run.
    resetExternalReadRootsForTesting()
  })

  afterEach(() => {
    // Module state: reset unconditionally so no later test inherits an open
    // external read boundary.
    resetExternalReadRootsForTesting()
  })

  test('reads a log inside an allowlisted external root', async () => {
    const cwd = makeTempDir()
    const externalRoot = makeTempDir()
    const externalLog = path.join(externalRoot, 'external.log')
    fs.writeFileSync(externalLog, 'one\ntwo\nthree\n')

    configureExternalReadRoots([externalRoot])

    const result = value(
      await readLogs({
        cwd,
        path: externalLog,
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(result.errorMessage).toBeUndefined()
    // Compared against the realpath: on macOS `os.tmpdir()` is a symlinked
    // `/var/folders/...` path.
    expect(result.resolvedPath).toBe(fs.realpathSync(externalLog))
    expect(result.content).toBe('two\nthree\n')
  })

  test('refuses the same log while the registry is unconfigured', async () => {
    const cwd = makeTempDir()
    const externalRoot = makeTempDir()
    const externalLog = path.join(externalRoot, 'external.log')
    fs.writeFileSync(externalLog, 'one\ntwo\nthree\n')

    const result = value(
      await readLogs({ cwd, path: externalLog, owner: TRUSTED_OWNER }),
    )

    expect(result.errorMessage).toContain('outside the project directory')
    expect(result.content).toBeUndefined()
  })

  test('a host fileFilter blocks a log inside an allowlisted external root', async () => {
    const cwd = makeTempDir()
    const externalRoot = makeTempDir()
    const externalLog = path.join(externalRoot, 'external.log')
    fs.writeFileSync(externalLog, 'one\ntwo\nthree\n')

    configureExternalReadRoots([externalRoot])

    // An 'external-read' resolution carries an ABSOLUTE `relativePath`, so the
    // host policy is targeted through the scoped `external-read/<basename>`
    // alias — the same alias shape read_files / read_image present.
    const blocked = value(
      await readLogs({
        cwd,
        path: externalLog,
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
        fileFilter: (filePath: string) => ({
          status:
            filePath === 'external-read/external.log'
              ? ('blocked' as const)
              : ('allow' as const),
        }),
      }),
    )

    expect(blocked.errorMessage).toBe('[BLOCKED]')
    expect(blocked.content).toBeUndefined()

    // Without a filter the very same log still reads, so the refusal above is
    // the host policy and not the containment boundary.
    const allowed = value(
      await readLogs({
        cwd,
        path: externalLog,
        lines: 2,
        max_chars: 1_000,
        owner: TRUSTED_OWNER,
      }),
    )

    expect(allowed.errorMessage).toBeUndefined()
    expect(allowed.content).toBe('two\nthree\n')
  })
})

describe('owned-temp containment through an injected filesystem', () => {
  const tmpRoot = path.resolve(os.tmpdir())
  const projectRoot = '/virtual/repo'

  /**
   * Minimal injected filesystem. `realpath` is the only hook the containment
   * resolver uses; every path resolves to itself unless `links` remaps it, so
   * the host-derived owned temp roots stay inside themselves (see the
   * host-root caveat on `getOwnedTempRoots`).
   */
  const makeFileSystem = (links: Record<string, string> = {}) =>
    ({
      realpath: async (input: string) => links[input] ?? input,
    }) as unknown as CodebuffFileSystem

  test('accepts an owned temp log and pins the operation to the injected realpath', async () => {
    const ownedLog = path.join(tmpRoot, 'openbuff-job-virtual-x.log')
    const ownedRealLog = path.join(tmpRoot, 'openbuff-job-virtual-x-real.log')

    const resolved = await resolveFilePathForFileSystemOperation(
      projectRoot,
      ownedLog,
      makeFileSystem({ [ownedLog]: ownedRealLog }),
    )

    expect(resolved).not.toBeNull()
    // Owned temp paths live outside the project, so `relativePath` is the
    // absolute path; the operation itself is pinned to the realpath reported
    // by the injected filesystem, never the host one.
    expect(resolved!.relativePath).toBe(ownedLog)
    expect(resolved!.operationPath).toBe(ownedRealLog)
  })

  test('rejects an owned-named symlink whose injected realpath escapes the temp roots', async () => {
    const ownedLink = path.join(tmpRoot, 'openbuff-job-virtual-escape.log')

    await expect(
      resolveFilePathForFileSystemOperation(
        projectRoot,
        ownedLink,
        makeFileSystem({ [ownedLink]: '/outside/secret.log' }),
      ),
    ).resolves.toBeNull()
  })

  test('refuses a raw .. segment identically on the sync and injected-fs paths', async () => {
    // Built by concatenation so the `..` survives into the raw input, and it
    // collapses back INSIDE the owned namespace: the traversal-free contract
    // refuses it anyway, and all three entry points must agree.
    const traversal = `${tmpRoot}/openbuff-a/../openbuff-b.log`

    expect(isOwnedTempPath(traversal)).toBe(false)
    expect(resolveProjectPath(projectRoot, traversal)).toBeNull()
    await expect(
      resolveProjectPathForFileSystem(projectRoot, traversal, makeFileSystem()),
    ).resolves.toBeNull()
  })
})
