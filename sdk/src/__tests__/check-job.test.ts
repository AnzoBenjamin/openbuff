import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  __clearJobsForTest,
  __registerJobForTest,
  __sweepOrphanedJobFilesForTest,
  getBackgroundJob,
  readNewJobOutput,
  MAX_BACKGROUND_READ_BYTES,
  type BackgroundJob,
} from '../tools/background-jobs'
import {
  CHECK_JOB_POLL_ACCUMULATION_CAP,
  appendBoundedCollected,
  checkJob,
} from '../tools/check-job'
import { jobRegistry } from '@codebuff/common/util/job-registry'

/** Flatten the unified `output` events of a checkJob result into a string. */
function outputText(result: any): string {
  return (result.events ?? [])
    .filter((event: any) => event?.payload?.type === 'output')
    .map((event: any) => event.payload.data)
    .join('')}

let counter = 0
const tempFiles: string[] = []

/** Trusted owner injected into checkJob by the run/session layer in tests. */
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

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  counter += 1
  const logFile = path.join(os.tmpdir(), `openbuff-test-job-${counter}.log`)
  fs.writeFileSync(logFile, '')
  tempFiles.push(logFile)
  const job: BackgroundJob = {
    jobId: `job-test-${counter}`,
    command: 'echo hi',
    child: { pid: 1234 } as unknown as BackgroundJob['child'],
    logFile,
    metadataFile: `${logFile}.json`,
    status: 'running',
    exitCode: null,
    startedAt: 0,
    readOffset: 0,
    owner: TRUSTED_OWNER,
    ...overrides,
  }
  __registerJobForTest(job)
  return job
}

function value(output: Awaited<ReturnType<typeof checkJob>>): any {
  return output[0].value
}

async function withElapsedFollowTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const originalNow = Date.now
  let calls = 0
  Date.now = () => {
    calls += 1
    return calls === 1 ? 1_000 : 2_001
  }
  try {
    return await fn()
  } finally {
    Date.now = originalNow
  }
}

afterEach(() => {
  __clearJobsForTest()
  for (const f of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(f)
    } catch {
      // ignore
    }
  }
})

describe('readNewJobOutput', () => {
  test('returns only the bytes appended since the previous read', () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'hello\n')
    expect(readNewJobOutput(job)).toBe('hello\n')
    // Nothing new yet.
    expect(readNewJobOutput(job)).toBe('')
    fs.appendFileSync(job.logFile, 'world\n')
    expect(readNewJobOutput(job)).toBe('world\n')
  })

  test('preserves UTF-8 characters split across incremental reads', () => {
    const job = makeJob()
    const emoji = Buffer.from('🙂')
    fs.appendFileSync(job.logFile, emoji.subarray(0, 2))
    expect(readNewJobOutput(job)).toBe('')
    fs.appendFileSync(job.logFile, emoji.subarray(2))
    expect(readNewJobOutput(job)).toBe('🙂')
  })

  test('bounds each incremental file read', () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'x'.repeat(MAX_BACKGROUND_READ_BYTES + 1))
    expect(readNewJobOutput(job)).toHaveLength(MAX_BACKGROUND_READ_BYTES)
    expect(readNewJobOutput(job)).toBe('x')
  })

  test('does not follow a job log symlink swapped in before reading', () => {
    const job = makeJob()
    const secretLog = path.join(
      os.tmpdir(),
      `openbuff-test-secret-${counter}.log`,
    )
    fs.writeFileSync(secretLog, 'secret\n')
    tempFiles.push(secretLog)
    fs.unlinkSync(job.logFile)
    fs.symlinkSync(secretLog, job.logFile)

    expect(readNewJobOutput(job)).toBe('')
  })
})

describe('checkJob', () => {
  test('poll mode returns new output and running status without repeating', async () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'line one\n')

    const first = value(await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }))
    expect(first).toMatchObject({
      jobId: job.jobId,
      state: 'running',
    })
    expect(outputText(first)).toBe('line one\n')
    expect(first.matched).toBeUndefined()

    fs.appendFileSync(job.logFile, 'line two\n')
    const second = value(
      await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
    )
    expect(outputText(second)).toBe('line two\n')
  })

  test('follow mode returns matched=true once the pattern is present', async () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'starting...\nListening on :3000\n')

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        timeout_seconds: 1,
        owner: TRUSTED_OWNER,
      }),
    )
    expect(result.matched).toBe(true)
    expect(outputText(result)).toContain('Listening on :3000')
  })

  test('wait_for without timeout_seconds performs a single non-blocking poll', async () => {
    // Requirement (clarified): `wait_for` without `timeout_seconds` does NOT
    // block until the pattern appears. Blocking is governed solely by
    // `timeout_seconds`, so with no timeout the call performs a single poll
    // and returns immediately with `matched` reflecting the current output.
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'still starting...\n')

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        owner: TRUSTED_OWNER,
      }),
    )
    // Pattern is absent, but the call returned immediately rather than blocking.
    expect(result.matched).toBe(false)
    expect(result.state).toBe('running')
    expect(result.timedOut).toBeUndefined()
    expect(outputText(result)).toContain('still starting...')
  })

  test('follow mode accumulates output across multiple poll iterations', async () => {
    // The internal poll interval is 200ms. Emit the earlier output before the
    // call (drained on the first iteration, no match), then append the matching
    // line after the first interval elapses so the match happens in a LATER
    // iteration. The returned `events` must cover the FULL window — every
    // output event drained across every iteration — not just the final batch.
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'starting...\n')

    const timer = setTimeout(() => {
      fs.appendFileSync(job.logFile, 'Listening on :3000\n')
    }, 250)

    let result: any
    try {
      result = value(
        await checkJob({
          jobId: job.jobId,
          wait_for: 'Listening on',
          timeout_seconds: 5,
          owner: TRUSTED_OWNER,
        }),
      )
    } finally {
      clearTimeout(timer)
    }

    expect(result.matched).toBe(true)
    const text = outputText(result)
    // Earlier ('starting...') and later (matched) output are BOTH present, so
    // `events` is consistent with `matched` and `nextCursor` and the caller
    // never loses the intermediate iteration's output.
    expect(text).toContain('starting...')
    expect(text).toContain('Listening on :3000')
  })

  test('wait_for matches a pattern that lands mid-stream in a bounded window', async () => {
    // Regression: bounding the match window must not drop wait_for content.
    // readNewJobOutput caps a single read at MAX_BACKGROUND_READ_BYTES, so the
    // first poll iteration fills the match window with filler (no match) and
    // the needle is only reached on a later iteration. The needle sits in the
    // middle of that later read — past the retained head and before the
    // retained tail — so a naive truncate-then-match would drop it. Matching
    // semantics must be preserved: the pattern is still matched despite the
    // accumulation bound.
    const job = makeJob()
    const needle = 'MID-STREAM-NEEDLE'
    fs.appendFileSync(job.logFile, 'a'.repeat(MAX_BACKGROUND_READ_BYTES))
    fs.appendFileSync(
      job.logFile,
      'b'.repeat(20_000) + needle + 'c'.repeat(20_000),
    )

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: needle,
        timeout_seconds: 5,
        owner: TRUSTED_OWNER,
      }),
    )
    expect(result.matched).toBe(true)
  })

  test('follow timeout keeps a still-running job alive by default', async () => {
    let killedSignal: NodeJS.Signals | undefined
    const job = makeJob({
      child: {
        pid: 1234,
        kill: (signal?: NodeJS.Signals | number) => {
          killedSignal = signal as NodeJS.Signals
          return true
        },
      } as unknown as BackgroundJob['child'],
    })

    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          wait_for: 'never appears',
          timeout_seconds: 1,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    expect(killedSignal).toBeUndefined()
    expect(result).toMatchObject({
      jobId: job.jobId,
      state: 'running',
      matched: false,
      timedOut: true,
    })
    expect(result.killed).toBeUndefined()
    expect(job.status).toBe('running')
  })

  test('follow timeout kills a running job when kill_on_timeout is true', async () => {
    let killCalled = false
    const job = makeJob({
      child: {
        pid: 1234,
        kill: () => {
          killCalled = true
          return true
        },
      } as unknown as BackgroundJob['child'],
    })

    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          wait_for: 'never appears',
          timeout_seconds: 1,
          kill_on_timeout: true,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    expect(killCalled).toBe(true)
    expect(result).toMatchObject({
      jobId: job.jobId,
      state: 'stopped',
      matched: false,
      killed: true,
    })
    expect(job.status).toBe('stopped')
  })

  test('follow timeout kill failure surfaces errorMessage through the output union', async () => {
    const job = makeJob({
      child: {
        pid: undefined,
        kill: () => true,
      } as unknown as BackgroundJob['child'],
    })

    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          wait_for: 'never appears',
          timeout_seconds: 1,
          kill_on_timeout: true,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    expect(result.killed).toBe(true)
    expect(typeof result.errorMessage).toBe('string')
    expect(result.errorMessage.length).toBeGreaterThan(0)
  })

  test('reports completed status and exit code', async () => {
    const job = makeJob({ status: 'completed', exitCode: 0 })
    fs.appendFileSync(job.logFile, 'done\n')
    const result = value(await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }))
    expect(result).toMatchObject({ state: 'completed', exitCode: 0 })
  })

  test('success output includes the job logFile for a running job', async () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'line one\n')
    const result = value(await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }))
    expect(result.logFile).toBe(job.logFile)
  })

  test('returns an error for an unknown job id', async () => {
    const result = value(
      await checkJob({ jobId: 'does-not-exist', owner: TRUSTED_OWNER }),
    )
    expect(result.errorMessage).toContain('does-not-exist')
  })

  test('refuses a foreign-owned job with a generic not_found error', async () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'secret\n')

    const result = value(
      await checkJob({ jobId: job.jobId, owner: FOREIGN_OWNER }),
    )
    expect(result.errorMessage).toContain(
      `No background job found with id "${job.jobId}"`,
    )
    // Must not leak state/output for another session's job.
    expect(result.state).toBeUndefined()
    expect(outputText(result)).toBe('')
  })

  test('a model-supplied owner cannot override the trusted owner', async () => {
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'line\n')

    // Simulate the run.ts dispatch: spread the model input, then pin owner to
    // the trusted value. Even when the input carries a foreign owner, the
    // trusted owner wins and the job is served.
    const modelInput = { jobId: job.jobId, owner: FOREIGN_OWNER }
    const result = value(
      await checkJob({ ...modelInput, owner: TRUSTED_OWNER }),
    )
    expect(result.errorMessage).toBeUndefined()
    expect(result.state).toBe('running')
  })

  test('sweeps stale completed job files but preserves running recoverable jobs', () => {
    const oldCompletedJobId = `job-stale-completed-${++counter}`
    const oldRunningJobId = `job-stale-running-${++counter}`
    const oldCompletedLog = path.join(
      os.tmpdir(),
      `openbuff-${oldCompletedJobId}.log`,
    )
    const oldCompletedMetadata = path.join(
      os.tmpdir(),
      `openbuff-${oldCompletedJobId}.json`,
    )
    const oldRunningLog = path.join(
      os.tmpdir(),
      `openbuff-${oldRunningJobId}.log`,
    )
    const oldRunningMetadata = path.join(
      os.tmpdir(),
      `openbuff-${oldRunningJobId}.json`,
    )
    const oldTime = Date.now() - 25 * 60 * 60 * 1000

    fs.writeFileSync(oldCompletedLog, 'old completed\n')
    fs.writeFileSync(
      oldCompletedMetadata,
      JSON.stringify({
        jobId: oldCompletedJobId,
        command: 'completed job',
        processId: null,
        logFile: oldCompletedLog,
        status: 'completed',
        exitCode: 0,
        startedAt: 123,
      }),
    )
    fs.writeFileSync(oldRunningLog, 'old running\n')
    fs.writeFileSync(
      oldRunningMetadata,
      JSON.stringify({
        jobId: oldRunningJobId,
        command: 'running job',
        processId: process.pid,
        logFile: oldRunningLog,
        status: 'running',
        exitCode: null,
        startedAt: 123,
      }),
    )
    fs.utimesSync(oldCompletedLog, oldTime / 1000, oldTime / 1000)
    fs.utimesSync(oldCompletedMetadata, oldTime / 1000, oldTime / 1000)
    fs.utimesSync(oldRunningLog, oldTime / 1000, oldTime / 1000)
    fs.utimesSync(oldRunningMetadata, oldTime / 1000, oldTime / 1000)
    tempFiles.push(
      oldCompletedLog,
      oldCompletedMetadata,
      oldRunningLog,
      oldRunningMetadata,
    )

    __sweepOrphanedJobFilesForTest()

    expect(fs.existsSync(oldCompletedLog)).toBe(false)
    expect(fs.existsSync(oldCompletedMetadata)).toBe(false)
    expect(fs.existsSync(oldRunningLog)).toBe(true)
    expect(fs.existsSync(oldRunningMetadata)).toBe(true)
  })

  test('recovers a job from persisted metadata and log file', async () => {
    const jobId = `job-recovered-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    fs.writeFileSync(logFile, 'ready\n')
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'dev server',
        processId: null,
        logFile,
        status: 'running',
        exitCode: null,
        startedAt: 123,
      }),
    )
    tempFiles.push(logFile, metadataFile)

    const recovered = getBackgroundJob(jobId)
    expect(recovered?.logFile).toBe(logFile)

    const result = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
    expect(result).toMatchObject({
      jobId,
      state: 'lost',
    })
    expect(outputText(result)).toBe('ready\n')
  })

  test('recovers persisted read offsets without duplicating historical output', async () => {
    const jobId = `job-recovered-offset-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    fs.writeFileSync(logFile, 'first\n')
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'dev server',
        processId: null,
        logFile,
        status: 'running',
        exitCode: null,
        startedAt: 123,
      }),
    )
    tempFiles.push(logFile, metadataFile)

    const first = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
    expect(outputText(first)).toBe('first\n')
    __clearJobsForTest()

    fs.appendFileSync(logFile, 'second\n')
    const second = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
    expect(second).toMatchObject({
      jobId,
      state: 'lost',
    })
    expect(outputText(second)).toBe('second\n')
  })

  test('preserves owner metadata when recovering a running job', () => {
    const jobId = `job-recovered-owner-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    const owner = {
      clientSessionId: 'session-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-1',
      parentAgentId: 'agent-1',
    }
    fs.writeFileSync(logFile, '')
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'dev server',
        processId: process.pid,
        logFile,
        status: 'running',
        exitCode: null,
        startedAt: 123,
        owner,
      }),
    )
    tempFiles.push(logFile, metadataFile)

    expect(getBackgroundJob(jobId)?.owner).toEqual(owner)
    // The unified jobRegistry is now the source of truth for live
    // state/ownership (the pending-background-jobs mirror is the legacy
    // store M4 removes). A recovered job is re-emitted into the registry
    // under a fresh registry id stored on the adapter object, carrying the
    // preserved owner.
    const recovered = getBackgroundJob(jobId)
    const registryJob = recovered?.registryJobId
      ? jobRegistry.get(recovered.registryJobId)
      : undefined
    expect(registryJob?.owner).toEqual(owner)
  })

  test('clamps recovered read offsets beyond the log size', async () => {
    const jobId = `job-recovered-offset-clamp-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    fs.writeFileSync(logFile, 'short\n')
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        jobId,
        command: 'dev server',
        processId: null,
        logFile,
        status: 'running',
        exitCode: null,
        startedAt: 123,
        readOffset: 10_000,
      }),
    )
    tempFiles.push(logFile, metadataFile)

    const first = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
    expect(outputText(first)).toBe('')

    fs.appendFileSync(logFile, 'next\n')
    const second = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
    expect(outputText(second)).toBe('next\n')
  })

  test('falls back to the beginning for invalid or missing recovered read offsets', async () => {
    const cases: Array<{
      suffix: string
      metadataPatch?: { readOffset: unknown }
    }> = [
      { suffix: 'missing' },
      { suffix: 'negative', metadataPatch: { readOffset: -1 } },
      { suffix: 'null', metadataPatch: { readOffset: null } },
      { suffix: 'non-number', metadataPatch: { readOffset: '6' } },
    ]

    for (const testCase of cases) {
      const jobId = `job-recovered-offset-${testCase.suffix}-${++counter}`
      const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
      const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
      fs.writeFileSync(logFile, `${testCase.suffix}\n`)
      fs.writeFileSync(
        metadataFile,
        JSON.stringify({
          jobId,
          command: 'dev server',
          processId: null,
          logFile,
          status: 'running',
          exitCode: null,
          startedAt: 123,
          ...(testCase.metadataPatch ?? {}),
        }),
      )
      tempFiles.push(logFile, metadataFile)

      const result = value(await checkJob({ jobId, owner: TRUSTED_OWNER }))
      expect(result).toMatchObject({
        jobId,
        state: 'lost',
      })
      expect(outputText(result)).toBe(`${testCase.suffix}\n`)
      __clearJobsForTest()
    }
  })

  test('does not recover when persisted metadata is a symlink', () => {
    const jobId = `job-metadata-symlink-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    const metadataFile = path.join(os.tmpdir(), `openbuff-${jobId}.json`)
    const targetMetadataFile = path.join(
      os.tmpdir(),
      `openbuff-test-metadata-target-${counter}.json`,
    )
    fs.writeFileSync(logFile, 'ready\n')
    fs.writeFileSync(
      targetMetadataFile,
      JSON.stringify({
        jobId,
        command: 'dev server',
        processId: null,
        logFile,
        status: 'running',
        exitCode: null,
        startedAt: 123,
      }),
    )
    fs.symlinkSync(targetMetadataFile, metadataFile)
    tempFiles.push(logFile, metadataFile, targetMetadataFile)

    expect(getBackgroundJob(jobId)).toBeUndefined()
  })

  test('does not recover a bare log file without valid metadata', () => {
    const jobId = `job-bare-log-${++counter}`
    const logFile = path.join(os.tmpdir(), `openbuff-${jobId}.log`)
    fs.writeFileSync(logFile, 'ready\n')
    tempFiles.push(logFile)

    expect(getBackgroundJob(jobId)).toBeUndefined()
  })

  test('retains a settled registry entry until the TTL sweep', () => {
    // The unified registry retains a settled job (with a recent completedAt)
    // so check_job/read_logs/kill_job can still serve its final output/exit
    // code after it finishes.
    const created = jobRegistry.create({
      kind: 'process',
      label: 'echo hi',
      owner: {
        clientSessionId: 'session-1',
        rootRunId: 'root-1',
        parentRunId: 'parent-1',
        parentAgentId: 'agent-1',
      },
    })
    jobRegistry.start(created.jobId)
    jobRegistry.emit(created.jobId, {
      type: 'lifecycle',
      state: 'completed',
      exitCode: 0,
    })

    // jobRegistry.get sweeps first; a recent completedAt is retained.
    const entry = jobRegistry.get(created.jobId)
    expect(entry?.state).toBe('completed')
    expect(entry?.completedAt).toBeDefined()
  })
})

describe('appendBoundedCollected', () => {
  test('returns the concatenation unchanged when under the cap', () => {
    expect(appendBoundedCollected('abc', 'def')).toBe('abcdef')
  })

  test('bounds accumulation for a chatty long-running job', () => {
    // Simulate many poll iterations, each draining a large chunk. Without a
    // bound, `collected` would grow without limit and OOM the agent runtime.
    let collected = ''
    for (let i = 0; i < 1000; i += 1) {
      collected = appendBoundedCollected(collected, 'x'.repeat(10_000))
      // The window never grows past the cap (plus the short truncation
      // marker) no matter how much output the job emits.
      expect(collected.length).toBeLessThanOrEqual(
        CHECK_JOB_POLL_ACCUMULATION_CAP + 100,
      )
    }
  })

  test('keeps the head and tail of the stream with a truncation marker', () => {
    const head = 'H'.repeat(CHECK_JOB_POLL_ACCUMULATION_CAP * 2)
    const collected = appendBoundedCollected(head, 'TAIL')
    expect(collected.startsWith('H')).toBe(true)
    expect(collected.endsWith('TAIL')).toBe(true)
    expect(collected).toContain('poll truncated')
    // Truncation genuinely shrinks the oversized stream.
    expect(collected.length).toBeLessThan(head.length + 'TAIL'.length)
  })
})
