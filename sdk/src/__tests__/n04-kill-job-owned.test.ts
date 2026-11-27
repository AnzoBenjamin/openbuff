import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { checkJobParams } from '@codebuff/common/tools/params/tool/check-job'
import { killJobParams } from '@codebuff/common/tools/params/tool/kill-job'

import { authenticatedHostFixture } from './authenticated-host-fixture'
import {
  admitNodeLaunch,
  prepareNodeLaunch,
} from '../services/execution-launch'
import {
  __clearJobsForTest,
  getBackgroundJobAdapter,
  startBackgroundJob,
  type BackgroundJob,
} from '../tools/background-jobs'
import { checkJob } from '../tools/check-job'
import { killJob } from '../tools/kill-job'

import type { Result } from '@codebuff/common/types/contracts/execution-context'

/** Trusted owner injected into killJob by the run/session layer in tests. */
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

const WORKER_ROOT = 'OPENBUFF_N04_KILL_JOB_TEST_ROOT'
const TRACE = 'N04_KILL_JOB'
const WAIT_MS = 2_000
const GATE_EXIT_CODE = 23
const CHILD_SCRIPT = `
  const fs = require('node:fs')
  function mark(name) {
    fs.writeFileSync(name + '.pending', String(process.pid))
    fs.renameSync(name + '.pending', name)
  }
  process.on('SIGTERM', () => mark('term-received'))
  mark('ready')
  setInterval(() => {
    if (fs.existsSync('release')) process.exit(${GATE_EXIT_CODE})
  }, 5)
  setTimeout(() => process.exit(124), 10_000)
`

function killValue(output: Awaited<ReturnType<typeof killJob>>) {
  return killJobParams.outputSchema.parse(output)[0].value
}

function checkValue(output: Awaited<ReturnType<typeof checkJob>>) {
  return checkJobParams.outputSchema.parse(output)[0].value
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function tempRoot() {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-n04-kill-')),
  )
}

// The SDK writes recovery files and sweeps stale files in os.tmpdir(). Give
// each real-process case its own TMPDIR at process launch, not via a global
// environment override or a mock of the SDK's cleanup and recovery paths.
function ownedTest(
  name: string,
  skip: boolean,
  run: (root: string) => Promise<void>,
) {
  test.skipIf(skip)(name, () => runInOwnedTemp(name, run), 16_000)
}

async function runInOwnedTemp(
  name: string,
  run: (root: string) => Promise<void>,
) {
  const workerRoot = process.env[WORKER_ROOT]
  if (workerRoot) {
    expect(path.basename(workerRoot)).toStartWith('openbuff-n04-kill-')
    expect(os.tmpdir()).toBe(workerRoot)
    expect(process.cwd()).toBe(workerRoot)
    await run(workerRoot)
    return
  }

  const root = tempRoot()
  try {
    const worker = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--no-install',
        'test',
        '--test-name-pattern',
        name,
        import.meta.path,
      ],
      {
        cwd: root,
        env: { HOME: root, TMPDIR: root, [WORKER_ROOT]: root },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 14_000,
        killSignal: 'SIGKILL',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      worker.exited,
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
    ])
    if (code !== 0 || !stdout.includes(`${TRACE} `)) {
      throw new Error(`Owned kill_job case exited ${code}\n${stdout}${stderr}`)
    }
    process.stdout.write(stdout)
    process.stderr.write(stderr)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          WAIT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readMarker(root: string, name: string) {
  const file = path.join(root, name)
  const deadline = performance.now() + WAIT_MS
  while (!fs.existsSync(file)) {
    if (performance.now() >= deadline)
      throw new Error(`Child did not mark ${name}`)
    await Bun.sleep(5)
  }
  return Number(fs.readFileSync(file, 'utf8'))
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null }

async function withOwnedJob(
  root: string,
  run: (fixture: {
    job: BackgroundJob
    pid: number
    scope: NonNullable<BackgroundJob['nodeLaunch']>['scope']
    observedExit: () => ChildExit | undefined
  }) => Promise<void>,
) {
  const host = authenticatedHostFixture(root)
  try {
    const launch = unwrap(
      prepareNodeLaunch({
        executionContext: host.context,
        executable: process.execPath,
        argv: ['--no-env-file', '--no-install', '-e', CHILD_SCRIPT],
        cwd: root,
        branchId: 'terminal.background',
        family: 'background-job',
        processType: 'BACKGROUND',
        adapterOptions: {
          detached: true,
          shell: false,
          stdio: 'ignore-log-log',
        },
      }),
    )
    const job = startBackgroundJob({
      command: 'N04 owned kill_job child',
      admittedLaunch: unwrap(
        await admitNodeLaunch(launch, host.context.signal),
      ),
      executionContext: host.context,
      owner: TRUSTED_OWNER,
    })
    let exit: ChildExit | undefined
    job.child.once('exit', (code, signal) => {
      exit = { code, signal }
    })
    const closed = new Promise<void>((resolve) =>
      job.child.once('close', () => resolve()),
    )
    try {
      const dispatched = job.nodeLaunch
      if (!dispatched)
        throw new Error('SDK did not retain the admitted process scope')
      const { pid } = unwrap(
        await within(dispatched.started, 'SDK spawn observation'),
      )
      expect(pid).toBeGreaterThan(0)
      expect(job.child.pid).toBe(pid)
      expect(path.dirname(job.logFile)).toBe(root)
      expect(path.dirname(job.metadataFile)).toBe(root)
      expect(await readMarker(root, 'ready')).toBe(pid)
      await run({ job, pid, scope: dispatched.scope, observedExit: () => exit })
    } finally {
      // Recovery uses a legacy numeric escalation timer. Disarm it before
      // tearing down the original child, even if a recovery assertion failed.
      const escalation = getBackgroundJobAdapter(job.jobId)?.killEscalationTimer
      if (escalation) clearTimeout(escalation)
      if (job.child.pid && !exit) job.child.kill('SIGKILL')
      await within(closed, 'owned child close')
      if (job.nodeLaunch) {
        await within(
          job.nodeLaunch.scope.requestStop('owner-shutdown', true),
          'owned scope cleanup',
        )
      }
    }
  } finally {
    host.close()
    __clearJobsForTest()
  }
}

describe('killJob owned-process observation', () => {
  ownedTest(
    'N04 confirms killed only after the owned child really exits',
    process.platform === 'win32',
    proveOwnedExit,
  )
  ownedTest(
    'N04 does not mistake recovered tracking loss for an observed exit',
    process.platform !== 'linux',
    proveRecoveredLoss,
  )
})

async function proveOwnedExit(root: string) {
  await withOwnedJob(root, async ({ job, pid, scope, observedExit }) => {
    const request = { jobId: job.jobId, owner: TRUSTED_OWNER }
    expect(
      killValue(await killJob({ ...request, owner: FOREIGN_OWNER })),
    ).toEqual({
      jobId: job.jobId,
      errorMessage: `No background job found with id "${job.jobId}".`,
    })
    expect(checkValue(await checkJob(request))).toMatchObject({
      state: 'running',
    })

    // Pin the trusted owner as SDK dispatch does. The short observation
    // budget ends while the SIGTERM-resistant child is still running.
    const modelInput = { jobId: job.jobId, owner: FOREIGN_OWNER }
    const first = await killJob({
      ...modelInput,
      owner: TRUSTED_OWNER,
      waitForExitMs: 25,
    })
    const live = await scope.observe()
    const stopping = await checkJob(request)
    expect(killValue(first)).toMatchObject({
      jobId: job.jobId,
      status: 'stopping',
      killed: false,
      exitObserved: false,
      signal: 'SIGTERM',
      exitCode: null,
      reason: expect.stringContaining('had not exited'),
      nextStep: expect.stringMatching(/check_job.*kill_job.*SIGKILL/),
    })
    if ('nextStep' in killValue(first)) {
      expect(killValue(first)).not.toMatchObject({
        nextStep: expect.stringMatching(/\bafter \d+\s*s\b/i),
      })
    }
    expect(live).toMatchObject({
      leader: 'running',
      scopePresence: 'living',
      identity: 'verified',
    })
    if (scope.tier === 'posix-owned-group') {
      expect(live.members.map((member) => member.identity.pid)).toEqual([pid])
    }
    expect(observedExit()).toBeUndefined()
    expect(checkValue(stopping)).toMatchObject({ state: 'stopping' })
    expect(checkValue(stopping)).not.toHaveProperty('do_not_repoll')

    // Start the follow-up while the child is still live. Snapshot the exit
    // and cleanup *when* killJob responds, so it cannot claim success early.
    const forced = await killJob({
      ...request,
      signal: 'SIGKILL',
      waitForExitMs: WAIT_MS,
    })
    const exit = observedExit()
    const cleanupAtResponse = scope.currentCleanup()
    const settled = await checkJob(request)
    const repeat = await killJob(request)
    recordTrace({ pid, first, live, stopping, forced, exit, settled, repeat })
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' })
    expect(cleanupAtResponse?.status).toBe('complete')
    expect(killValue(forced)).toEqual({
      jobId: job.jobId,
      status: 'stopped',
      killed: true,
      exitObserved: true,
      signal: 'SIGKILL',
      exitCode: null,
    })
    expect(checkValue(settled)).toMatchObject({
      state: 'stopped',
      do_not_repoll: true,
      processCleanup: {
        attemptId: cleanupAtResponse?.attemptId,
        status: 'complete',
        trigger: 'job-kill',
        selectedTier: scope.tier,
        satisfiesSelectedTier: true,
        cleanupAuthorityRetained: false,
        signals: [
          { signal: 'SIGTERM', result: 'delivered', targetTier: scope.tier },
          { signal: 'SIGKILL', result: 'delivered', targetTier: scope.tier },
        ],
        finalObservation: {
          leader: 'exited-reaped',
          scopePresence: 'absent',
          identity: 'verified',
          membershipComplete: true,
          members: [],
          streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
        },
      },
    })
    expect(killValue(repeat)).toEqual({
      jobId: job.jobId,
      status: 'stopped',
      killed: false,
      signal: 'SIGTERM',
      exitCode: null,
    })
  })
}

async function proveRecoveredLoss(root: string) {
  await withOwnedJob(root, async ({ job, pid, observedExit }) => {
    const request = { jobId: job.jobId, owner: TRUSTED_OWNER }
    // Forget the live adapter via the existing test seam. The next kill
    // must recover from the SDK's own on-disk metadata, not a stubbed row.
    __clearJobsForTest()
    const pendingKill = killJob({ ...request, waitForExitMs: WAIT_MS })
    const stopping = await checkJob(request)
    expect(getBackgroundJobAdapter(job.jobId)?.recovered).toBe(true)
    expect(checkValue(stopping)).toMatchObject({ state: 'stopping' })
    const termReceivedBy = await readMarker(root, 'term-received')
    expect(termReceivedBy).toBe(pid)
    expect(observedExit()).toBeUndefined()

    // The exit is real. Run the recovered observer's PID check before the
    // original adapter (still in this test process) handles the exit event.
    const lostPoll = new Promise<Awaited<ReturnType<typeof checkJob>>>(
      (resolve) => {
        job.child.prependOnceListener('exit', () => resolve(checkJob(request)))
      },
    )
    fs.writeFileSync(path.join(root, 'release'), '')
    const lost = await within(lostPoll, 'recovered liveness check after exit')
    const kill = await pendingKill
    const exit = observedExit()
    recordTrace({ pid, stopping, termReceivedBy, exit, lost, kill })
    expect(exit).toEqual({ code: GATE_EXIT_CODE, signal: null })
    expect(checkValue(lost)).toMatchObject({
      state: 'lost',
      do_not_repoll: true,
    })
    expect(checkValue(lost)).not.toHaveProperty('exitCode')
    expect(checkValue(lost)).not.toHaveProperty('processCleanup')
    expect(killValue(kill)).toMatchObject({
      jobId: job.jobId,
      status: 'lost',
      killed: false,
      exitObserved: false,
      signal: 'SIGTERM',
      exitCode: null,
      reason: expect.stringMatching(/unconfirmed/i),
      nextStep: expect.stringMatching(/verify the process identity/i),
    })
  })
}

function recordTrace(observations: unknown) {
  console.log(TRACE, JSON.stringify(observations))
}
