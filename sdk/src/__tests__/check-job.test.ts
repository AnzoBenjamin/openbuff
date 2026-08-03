import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  __clearJobsForTest,
  __registerJobForTest,
  __sweepOrphanedJobFilesForTest,
  getBackgroundJob,
  killBackgroundJob,
  peekJobLineCarry,
  pruneSettledJobs,
  readNewJobOutput,
  MAX_BACKGROUND_READ_BYTES,
  MAX_LINE_BYTES,
  type BackgroundJob,
} from '../tools/background-jobs'
import {
  CHECK_JOB_POLL_ACCUMULATION_CAP,
  appendBoundedCollected,
  checkJob,
} from '../tools/check-job'
import {
  SETTLED_JOB_TTL_MS,
  jobRegistry,
} from '@codebuff/common/util/job-registry'

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

  test('force-flushes lineCarry once a newline-less flood exceeds MAX_LINE_BYTES', () => {
    // A chatty child with no line terminators must not grow lineCarry without
    // bound: emitJobOutputLines force-emits once carry exceeds MAX_LINE_BYTES
    // and resets it so the next drain starts fresh.
    const job = makeJob()
    const flood = 'x'.repeat(MAX_LINE_BYTES + 100)
    fs.appendFileSync(job.logFile, flood)

    // One read is enough: flood is under MAX_BACKGROUND_READ_BYTES. Loop in case
    // the cap or read path changes so the flood still fully drains.
    for (let i = 0; i < 10; i++) {
      const chunk = readNewJobOutput(job)
      if (chunk === '' && peekJobLineCarry(job) === '') break
    }

    expect(peekJobLineCarry(job)).toBe('')
    const registryId = job.registryJobId ?? job.jobId
    const snapshot = jobRegistry.snapshot(registryId, 0)
    const outputEvents = (snapshot?.events ?? []).filter(
      (event) => event.payload.type === 'output',
    )
    expect(outputEvents.length).toBeGreaterThanOrEqual(1)
    const combined = outputEvents
      .map((event) =>
        event.payload.type === 'output' ? event.payload.data : '',
      )
      .join('')
    expect(combined.length).toBeGreaterThanOrEqual(MAX_LINE_BYTES)
    expect(combined).toBe(flood)
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

  test('hasLiveDrainer: pre-drained registry output appears in the first poll', async () => {
    // Live jobs are drained by the 250ms interval into the registry BEFORE
    // check_job runs. Simulate that path: drain once via readNewJobOutput,
    // then mark hasLiveDrainer so check_job must NOT re-drain (single-drainer
    // contract for readOffset/decoder/lineCarry). Output already in the
    // registry must still appear — lastCheckCursor starts at 0, not the tip.
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'live-pre-drained\n')
    expect(readNewJobOutput(job)).toBe('live-pre-drained\n')
    const offsetAfterLiveDrain = job.readOffset
    job.hasLiveDrainer = true

    const first = value(
      await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
    )
    expect(outputText(first)).toBe('live-pre-drained\n')
    expect(first.state).toBe('running')
    // Single-drainer: check_job must not advance the shared file cursor.
    expect(job.readOffset).toBe(offsetAfterLiveDrain)

    // Second poll must not re-serve the same events (lastCheckCursor advanced).
    const second = value(
      await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
    )
    expect(outputText(second)).toBe('')
    expect(job.readOffset).toBe(offsetAfterLiveDrain)
  })

  test('hasLiveDrainer: wait_for matches a needle already emitted before checkJob entry', async () => {
    // Needle was mirrored by the live drainer (or equivalent pre-drain) into
    // the registry before check_job ran. Poll-mode wait_for must match it
    // immediately — not wait for new bytes — and must not double-drain.
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'boot\nListening on :3000\n')
    expect(readNewJobOutput(job)).toContain('Listening on :3000')
    const offsetAfterLiveDrain = job.readOffset
    job.hasLiveDrainer = true

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        owner: TRUSTED_OWNER,
      }),
    )
    expect(result.matched).toBe(true)
    expect(outputText(result)).toContain('Listening on :3000')
    expect(result.timedOut).toBeUndefined()
    expect(job.readOffset).toBe(offsetAfterLiveDrain)
  })

  test('wait_for matches only via peekJobLineCarry for an unterminated partial line', async () => {
    // Documented live-drainer match-vs-events lag: a needle drained into
    // lineCarry (no trailing newline yet) is matchable via peekJobLineCarry
    // even though no complete per-line registry `output` event has been
    // emitted for it yet. matched can be true while events/outputText lag.
    const job = makeJob()
    const partial = 'Ready > Listening on :3000'
    fs.appendFileSync(job.logFile, partial)

    expect(readNewJobOutput(job)).toBe(partial)
    expect(peekJobLineCarry(job)).toContain('Listening on')

    const registryId = job.registryJobId ?? job.jobId
    const preMatchSnapshot = jobRegistry.snapshot(registryId, 0)
    const preMatchOutput = (preMatchSnapshot?.events ?? [])
      .filter((event) => event.payload.type === 'output')
      .map((event) =>
        event.payload.type === 'output' ? event.payload.data : '',
      )
      .join('')
    expect(preMatchOutput).not.toContain('Listening on')

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        owner: TRUSTED_OWNER,
      }),
    )
    expect(result.matched).toBe(true)
    expect(result.state).toBe('running')
    expect(result.timedOut).toBeUndefined()
    // Carry still holds the unterminated needle; events need not include it.
    expect(peekJobLineCarry(job)).toContain('Listening on')
    expect(outputText(result)).not.toContain('Listening on')
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

  test('poll mode returns matched=true immediately when wait_for is already present in current output', async () => {
    // Direct complement to 'wait_for without timeout_seconds': blocking is
    // governed solely by timeout_seconds, so with the field omitted the call
    // performs a single non-blocking poll. Here the needle is ALREADY in the
    // current output, so it must return matched=true immediately rather than
    // block waiting for a later iteration (which would hang the suite).
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'ready\nListening on :3000\n')

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        owner: TRUSTED_OWNER,
      }),
    )
    expect(result.matched).toBe(true)
    expect(result.state).toBe('running')
    expect(result.timedOut).toBeUndefined()
    expect(outputText(result)).toContain('Listening on :3000')
  })

  test('an explicit zero timeout (timeout_seconds: 0) is poll mode: returns immediately with wait_for evaluated against current output', async () => {
    // An explicit `timeout_seconds: 0` is treated identically to an unset
    // timeout: both are poll mode (non-blocking). The needle is absent from
    // the current output, so the single-poll call returns immediately with
    // matched=false and no timeout.
    const job = makeJob()
    fs.appendFileSync(job.logFile, 'still starting...\n')

    const result = value(
      await checkJob({
        jobId: job.jobId,
        wait_for: 'Listening on',
        timeout_seconds: 0,
        owner: TRUSTED_OWNER,
      }),
    )
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

  test('follow without wait_for times out on a still-running job without killing it', async () => {
    const job = makeJob()

    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          timeout_seconds: 1,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    expect(result).toMatchObject({
      jobId: job.jobId,
      state: 'running',
      timedOut: true,
    })
    // No wait_for, so no matched field is emitted.
    expect(result.matched).toBeUndefined()
    expect(result.killed).toBeUndefined()
    expect(job.status).toBe('running')
  })

  test('follow without wait_for returns completed state when the job finishes', async () => {
    const job = makeJob({ status: 'completed', exitCode: 0 })
    fs.appendFileSync(job.logFile, 'done\n')

    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          timeout_seconds: 1,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    expect(result).toMatchObject({
      jobId: job.jobId,
      state: 'completed',
      exitCode: 0,
    })
    expect(result.timedOut).toBeUndefined()
    expect(result.matched).toBeUndefined()
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

  test('bounds a single oversized output event to the tail of the limit', async () => {
    const CHECK_JOB_OUTPUT_LIMIT = 50_000
    const job = makeJob()
    // One log write larger than the output limit. readNewJobOutput caps a
    // single read at MAX_BACKGROUND_READ_BYTES, so drain in a short loop until
    // the whole blob has been mirrored into the registry, then assert whatever
    // a single poll returns is bounded to the tail of the limit.
    fs.appendFileSync(job.logFile, 'x'.repeat(CHECK_JOB_OUTPUT_LIMIT * 3))

    let result: any
    for (let i = 0; i < 50; i++) {
      result = value(await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }))
      if (readNewJobOutput(job) === '') break
    }

    const text = outputText(result)
    expect(text.length).toBeLessThanOrEqual(CHECK_JOB_OUTPUT_LIMIT)
    if (text.length >= CHECK_JOB_OUTPUT_LIMIT) {
      expect(result.truncated).toBe(true)
    }
  })

  test('follow mode bounds in-memory accumulation for a chatty long-running job', async () => {
    // The follow loop accumulates drained output into an in-memory match
    // window (`collected`) across every poll iteration. A chatty job emitting
    // far more output than CHECK_JOB_POLL_ACCUMULATION_CAP must never grow
    // that window unbounded (which would OOM the runtime); the returned
    // `events` are similarly capped. This test locks the bound in at the
    // checkJob boundary, where the loop's internal `collected` is observable
    // only through the response.
    const job = makeJob()
    // readNewJobOutput caps a single read at MAX_BACKGROUND_READ_BYTES, so the
    // follow loop drains the oversized blob across many bounded iterations:
    // exactly the chatty long-running scenario this guard protects against.
    fs.appendFileSync(
      job.logFile,
      'x'.repeat(CHECK_JOB_POLL_ACCUMULATION_CAP * 3 + 1),
    )

    // The wait_for needle is absent from the written bytes, so the loop never
    // matches and keeps draining/bounding iterations until the (deterministic,
    // fast) follow deadline elapses.
    const result = value(
      await withElapsedFollowTimeout(() =>
        checkJob({
          jobId: job.jobId,
          wait_for: 'NEVER-APPEARS',
          // timeout_seconds must be 1 (not 5): withElapsedFollowTimeout pins
          // Date.now at 2001 after the first call, so a 5s timeout yields a
          // deadline of 6000 that 2001 can never reach — the follow loop would
          // spin forever and the test would time out. A 1s timeout gives a
          // deadline of 2000 that 2001 clears immediately, bounding the loop.
          timeout_seconds: 1,
          owner: TRUSTED_OWNER,
        }),
      ),
    )

    // The match window over the giant input exceeds the accumulation cap, so
    // the response is bounded and marked truncated.
    expect(outputText(result).length).toBeLessThanOrEqual(
      CHECK_JOB_POLL_ACCUMULATION_CAP,
    )
    expect(result.truncated).toBe(true)
    // The job never settled and the follow deadline elapsed without a match.
    expect(result).toMatchObject({
      state: 'running',
      timedOut: true,
      matched: false,
    })
  })

  test('reports completed status and exit code', async () => {
    const job = makeJob({ status: 'completed', exitCode: 0 })
    fs.appendFileSync(job.logFile, 'done\n')
    const result = value(await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }))
    expect(result).toMatchObject({ state: 'completed', exitCode: 0 })
  })

  test('first settled poll emits one-shot dirty-delta touchedPaths', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'check-job-dirty-'),
    )
    try {
      const run = (args: string[]) =>
        spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
      expect(run(['init']).status).toBe(0)
      run(['config', 'user.email', 'test@example.com'])
      run(['config', 'user.name', 'Test'])
      fs.writeFileSync(path.join(projectRoot, 'README'), 'seed\n')
      run(['add', 'README'])
      run(['commit', '-m', 'seed'])

      // Pre-start dirt must not appear in the delta.
      fs.writeFileSync(path.join(projectRoot, 'already-dirty.txt'), 'old\n')
      const dirtyBeforePaths = ['already-dirty.txt']

      // Job-authored dirt appears after the snapshot.
      fs.writeFileSync(path.join(projectRoot, 'from-bg.txt'), 'new\n')

      const job = makeJob({
        status: 'completed',
        exitCode: 0,
        projectRoot,
        dirtyBeforePaths,
      })
      fs.appendFileSync(job.logFile, 'done\n')

      const first = value(
        await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
      )
      expect(first.state).toBe('completed')
      expect(first.touchedPaths).toContain('from-bg.txt')
      expect(first.touchedPaths).not.toContain('already-dirty.txt')
      expect(job.settlementTouchedPaths).toEqual(first.touchedPaths)

      // Subsequent poll must not re-emit (idempotent one-shot), even if more
      // concurrent dirt appears after settle.
      fs.writeFileSync(path.join(projectRoot, 'post-settle.txt'), 'late\n')
      const second = value(
        await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
      )
      expect(second.touchedPaths).toBeUndefined()
      expect(second.state).toBe('completed')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('settled job without dirty snapshot soft-fails (omits touchedPaths)', async () => {
    // Recovered / test jobs without pre-start snapshot must not invent paths.
    const job = makeJob({ status: 'completed', exitCode: 0 })
    fs.appendFileSync(job.logFile, 'done\n')

    const first = value(
      await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
    )
    expect(first.state).toBe('completed')
    expect(first.touchedPaths).toBeUndefined()
    // Locked so a later poll still does not recompute.
    expect(job.settlementTouchedPaths).toEqual([])

    const second = value(
      await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
    )
    expect(second.touchedPaths).toBeUndefined()
  })

  test('running poll never emits touchedPaths even with a dirty snapshot', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'check-job-running-dirty-'),
    )
    try {
      const job = makeJob({
        status: 'running',
        projectRoot,
        dirtyBeforePaths: [],
      })
      fs.appendFileSync(job.logFile, 'still going\n')

      const result = value(
        await checkJob({ jobId: job.jobId, owner: TRUSTED_OWNER }),
      )
      expect(result.state).toBe('running')
      expect(result.touchedPaths).toBeUndefined()
      expect(job.settlementTouchedPaths).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
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

  test('retains a settled job within TTL, prunes it past the TTL, never prunes running jobs, and keeps the first settledAt', () => {
    // Settle a RUNNING job through the REAL settle path (killBackgroundJob)
    // so settledAt is stamped for real rather than hand-injected.
    const job = makeJob({
      child: {
        pid: 1234,
        kill: () => true,
      } as unknown as BackgroundJob['child'],
    })
    const killResult = killBackgroundJob(job.jobId)
    expect('killed' in killResult).toBe(true)
    expect('killed' in killResult ? killResult.killed : false).toBe(true)
    expect(job.status).toBe('stopped')
    expect(job.settledAt).toBeDefined()
    const settledAt = job.settledAt!

    // A settled job is RETAINED while within TTL (injected clock at the TTL
    // boundary, inclusive).
    pruneSettledJobs(settledAt + SETTLED_JOB_TTL_MS)
    expect(getBackgroundJob(job.jobId)).toBe(job)

    // Once it ages past the TTL it is PRUNED from the live Map.
    pruneSettledJobs(settledAt + SETTLED_JOB_TTL_MS + 1)
    expect(getBackgroundJob(job.jobId)).toBeUndefined()

    // A RUNNING job (settledAt undefined) is NOT pruned even at a far-future
    // clock.
    const running = makeJob()
    pruneSettledJobs(Date.now() + 365 * 24 * 60 * 60 * 1000)
    expect(getBackgroundJob(running.jobId)).toBe(running)

    // Settling the same job twice does NOT change its settledAt (idempotency):
    // a late duplicate settle must never extend an entry's retention window.
    const twice = makeJob({
      child: {
        pid: 1234,
        kill: () => true,
      } as unknown as BackgroundJob['child'],
    })
    killBackgroundJob(twice.jobId)
    const firstStamp = twice.settledAt!
    // Re-open the running state and settle again through the real kill path;
    // the guard must keep the FIRST stamp.
    twice.status = 'running'
    const killResult2 = killBackgroundJob(twice.jobId)
    expect('killed' in killResult2).toBe(true)
    expect('killed' in killResult2 ? killResult2.killed : false).toBe(true)
    expect(twice.settledAt).toBe(firstStamp)
  })

  test('does not permanently re-cache a TTL-expired settled job recovered from canonical on-disk metadata', () => {
    // Post-TTL settled disk metadata must not re-enter the live Map or mint a
    // fresh registry row (that would reset completedAt and defeat pruning).
    const expiredJobId = `job-prune-recover-${++counter}`
    const expiredLog = path.join(os.tmpdir(), `openbuff-${expiredJobId}.log`)
    const expiredMetadata = path.join(
      os.tmpdir(),
      `openbuff-${expiredJobId}.json`,
    )
    fs.writeFileSync(expiredLog, 'done\n')
    fs.writeFileSync(
      expiredMetadata,
      JSON.stringify({
        jobId: expiredJobId,
        command: 'echo done',
        processId: null,
        logFile: expiredLog,
        status: 'completed',
        exitCode: 0,
        startedAt: Date.now() - SETTLED_JOB_TTL_MS - 60_000,
        settledAt: Date.now() - SETTLED_JOB_TTL_MS - 1000,
        owner: TRUSTED_OWNER,
      }),
    )
    tempFiles.push(expiredLog, expiredMetadata)

    expect(getBackgroundJob(expiredJobId)).toBeUndefined()
    // A second call must still miss — no permanent re-cache from orphan files.
    expect(getBackgroundJob(expiredJobId)).toBeUndefined()

    // Within-TTL settled recovery must still work so final output stays servable.
    __clearJobsForTest()
    const freshJobId = `job-prune-recover-${++counter}`
    const freshLog = path.join(os.tmpdir(), `openbuff-${freshJobId}.log`)
    const freshMetadata = path.join(
      os.tmpdir(),
      `openbuff-${freshJobId}.json`,
    )
    const freshSettledAt = Date.now() - 1000
    fs.writeFileSync(freshLog, 'done\n')
    fs.writeFileSync(
      freshMetadata,
      JSON.stringify({
        jobId: freshJobId,
        command: 'echo done',
        processId: null,
        logFile: freshLog,
        status: 'completed',
        exitCode: 0,
        startedAt: freshSettledAt - 1000,
        settledAt: freshSettledAt,
        owner: TRUSTED_OWNER,
      }),
    )
    tempFiles.push(freshLog, freshMetadata)

    const recovered = getBackgroundJob(freshJobId)
    expect(recovered).toBeDefined()
    expect(recovered?.status).toBe('completed')
    expect(recovered?.settledAt).toBe(freshSettledAt)
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
