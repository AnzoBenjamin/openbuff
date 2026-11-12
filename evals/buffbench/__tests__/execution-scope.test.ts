import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import type { ChildProcess } from 'node:child_process'
import type {
  CleanupResult,
  OwnedProcessScope,
  ScopeObservation,
} from '@codebuff/common/types/contracts/process-scope'
import { parseProcStat } from '@codebuff/common/util/linux-process-scope'
import {
  captureEvaluationCommand,
  createEvaluationExecution,
  evaluationProcessScope,
} from '../execution'
import { runFinalCheckCommands } from '../agent-runner'
import { runInit } from '../../subagents/test-repo-utils'

const fixturePath = fileURLToPath(
  new URL('./fixtures/b20-evaluator-process.mjs', import.meta.url),
)
const nodeExecutable = Bun.which('node')!
const evidenceDirectory = process.env.B20_EVALUATOR_EVIDENCE_DIR
type Ready = {
  leaderPid: number
  leaderStat: string
  descendantPid?: number
  descendantStat?: string
}

async function waitForFile(file: string): Promise<void> {
  const expiresAt = performance.now() + 2_000
  while (!existsSync(file)) {
    if (performance.now() >= expiresAt)
      throw new Error(`Evaluator fixture did not become ready: ${file}`)
    await Bun.sleep(2)
  }
}

function physical(pid: number) {
  try {
    const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    return {
      pid,
      present: true,
      state: parsed.state,
      identity: parsed.identity,
      living: !['Z', 'X', 'x'].includes(parsed.state),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { pid, present: false, living: false }
    return { pid, present: null, living: null, error: String(error) }
  }
}

function save(name: string, receipt: unknown): void {
  if (!evidenceDirectory) return
  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(
    join(evidenceDirectory, `${name}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
}

async function runControl(
  mode: string,
  options: {
    variant?: 'redirected' | 'inherited'
    finite?: boolean
    abortAfterReady?: boolean
    quota?: number
    runtime?: 'node' | 'bun'
  },
) {
  const root = mkdtempSync(join(tmpdir(), `b20-evaluator-${mode}-`))
  const controller = new AbortController()
  let scope: OwnedProcessScope | undefined
  let child: ChildProcess | undefined
  let before: ScopeObservation | undefined
  let ready: Ready | undefined
  let leaderExitAtMs: number | undefined
  let childCloseAtMs: number | undefined
  const startedAtMs = performance.now()
  const execution = createEvaluationExecution({
    cwd: root,
    env: {},
    inheritEnv: false,
    ...(options.finite ? { durationMs: 250 } : {}),
  })
  // Attach the rejection handler before waiting for readiness: quota/deadline
  // are expected failures and must not become unhandled rejections.
  const executable =
    options.runtime === 'bun' ? process.execPath : nodeExecutable
  const pending = captureEvaluationCommand(
    executable,
    [
      ...(options.runtime === 'bun' ? ['--no-env-file'] : []),
      fixturePath,
      mode,
      root,
      options.variant ?? 'redirected',
    ],
    {
      cwd: root,
      execution,
      signal: controller.signal,
      branchId: `supplemental.evaluator.b20:${mode}:${options.variant ?? 'redirected'}`,
      captureLimitBytes: options.quota,
      onProcessScope: (owned, actualChild) => {
        scope = owned
        child = actualChild
        actualChild.once('exit', () => {
          leaderExitAtMs = performance.now()
        })
        actualChild.once('close', () => {
          childCloseAtMs = performance.now()
        })
      },
    },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  try {
    await waitForFile(join(root, 'ready.json'))
    ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'))
    before = await scope!.observe()
    const launchObservedAtMs = performance.now()
    if (options.abortAfterReady)
      controller.abort(new Error('Evaluator abort after observed readiness'))
    if (options.quota || mode === 'normal')
      writeFileSync(join(root, 'go'), 'begin bounded capture fixture')
    const settled = await pending
    const observedAtMs = performance.now()
    const captured = 'value' in settled ? settled.value : settled.error
    const processCleanup: CleanupResult = captured.processCleanup
    const oracle = {
      leader: physical(ready!.leaderPid),
      ...(ready!.descendantPid
        ? { descendant: physical(ready!.descendantPid) }
        : {}),
      lateMarkerExists: existsSync(join(root, 'late-marker')),
    }
    const receipt = {
      fixture: {
        mode,
        ...options,
        executable,
        childRuntime: options.runtime ?? 'node',
        selectedDeadlineMs: options.finite ? 250 : null,
        termGraceMs: 200,
        killGraceMs: 200,
        observationMs: 1_000,
      },
      ready,
      before,
      launchObservedAtMs,
      startedAtMs,
      leaderExitAtMs,
      childCloseAtMs,
      observedAtMs,
      elapsedMs: observedAtMs - startedAtMs,
      task: {
        status: 'error' in settled ? 'rejected' : 'resolved',
        name: captured.name,
        message: captured.message,
        commandExitCode: captured.commandExitCode,
        stderrPrefix: captured.stderr?.slice(0, 2_000),
      },
      capture: captured.outputCapture,
      processCleanup,
      oracle,
    }
    // Persist the failing or passing observation BEFORE fallback teardown.
    save(
      `${mode}-${options.variant ?? 'redirected'}-${options.runtime ?? 'node'}${options.finite ? '-d250' : ''}${options.abortAfterReady ? '-abort-after-ready' : ''}`,
      receipt,
    )
    expect(before!.scopePresence).toBe('living')
    expect(before!.identity).toBe('verified')
    expect(
      before!.members.some(
        (member) => member.identity.pid === ready!.leaderPid,
      ),
    ).toBe(true)
    expect(processCleanup.status).toBe('complete')
    expect(processCleanup.selectedTier).toBe('posix-owned-group')
    expect(processCleanup.satisfiesSelectedTier).toBe(true)
    expect(processCleanup.cleanupAuthorityRetained).toBe(false)
    expect(processCleanup.finalObservation.leader).toBe('exited-reaped')
    expect(
      processCleanup.finalObservation.members.every(
        (member) => member.disposition !== 'living',
      ),
    ).toBe(true)
    expect(oracle.leader.living).toBe(false)
    if (oracle.descendant) expect(oracle.descendant.living).toBe(false)
    expect(oracle.lateMarkerExists).toBe(false)
    expect(captured.outputCapture.complete).toBe(true)
    if (options.finite) {
      expect(processCleanup.originalDeadline.kind).toBe('finite')
      expect(processCleanup.launchFacts).toBeDefined()
      expect(processCleanup.originalDeadline).toEqual(
        processCleanup.launchFacts!.deadlines.resourceLifetime,
      )
      expect(receipt.elapsedMs).toBeLessThanOrEqual(1_650)
    }
    return { settled, captured, processCleanup, receipt }
  } finally {
    controller.abort()
    // The oracle above has already been captured. This fallback can never
    // convert an observed survivor or missing receipt into a passing control.
    if (scope && scope.currentCleanup()?.status !== 'complete')
      await scope.retryCleanup(true)
    if (ready) {
      for (const pid of [ready.leaderPid, ready.descendantPid]) {
        if (!pid || physical(pid).living !== true) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* fixture-only fallback */
        }
      }
    } else if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* fixture-only fallback */
      }
    }
    await pending
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform !== 'linux')(
  'B20 evaluator physical cleanup',
  () => {
    test('normal success drains the final UTF-8 stdout and stderr bytes', async () => {
      const { settled, captured, processCleanup } = await runControl(
        'normal',
        {},
      )
      expect('value' in settled).toBe(true)
      expect(captured.stdout).toBe('first\nlast-é✅\n')
      expect(captured.stderr).toBe('first-stderr\nlast-stderr-é✅\n')
      expect(captured.outputCapture.stdoutSeenBytes).toBe(
        Buffer.byteLength(captured.stdout),
      )
      expect(captured.outputCapture.stderrSeenBytes).toBe(
        Buffer.byteLength(captured.stderr),
      )
      expect(captured.outputCapture.droppedBytes).toBe(0)
      expect(processCleanup.trigger).toBe('normal-leader-exit')
    })

    test('Bun child pipe capture preserves final bytes', async () => {
      const { settled, captured } = await runControl('normal', {
        runtime: 'bun',
      })
      expect('value' in settled).toBe(true)
      expect(captured.stdout).toBe('first\nlast-é✅\n')
      expect(captured.stderr).toBe('first-stderr\nlast-stderr-é✅\n')
    })

    test('D=250 ms expires after observed launch and physically cleans the scope', async () => {
      const { settled, processCleanup } = await runControl('wait', {
        finite: true,
      })
      expect('error' in settled).toBe(true)
      expect(processCleanup.trigger).toBe('deadline')
      expect(processCleanup.selectedLimitSatisfied).toBe(true)
      expect(
        processCleanup.signals.some((signal) => signal.signal === 'SIGKILL'),
      ).toBe(true)
    })

    test('caller abort after readiness cleans a genuinely running process', async () => {
      const { captured, processCleanup } = await runControl('wait', {
        abortAfterReady: true,
      })
      expect(captured.name).toBe('AbortError')
      expect(processCleanup.trigger).toBe('owner-cancel')
    })

    test('leader exit during TERM does not disarm KILL for its redirected resistant descendant', async () => {
      const { captured, processCleanup, receipt } = await runControl(
        'early-leader',
        {
          finite: true,
          abortAfterReady: true,
          variant: 'redirected',
        },
      )
      expect(captured.name).toBe('AbortError')
      expect(receipt.ready?.descendantPid).toBeGreaterThan(0)
      expect(receipt.leaderExitAtMs).toBeDefined()
      expect(receipt.childCloseAtMs).toBeDefined()
      expect(receipt.leaderExitAtMs!).toBeLessThan(processCleanup.killAtMs)
      expect(
        processCleanup.signals.some(
          (signal) =>
            signal.signal === 'SIGKILL' && signal.result === 'delivered',
        ),
      ).toBe(true)
    })

    test.each(['redirected', 'inherited'] as const)(
      'normal leader exit reconciles its %s descendant',
      async (variant) => {
        const { settled, captured, processCleanup, receipt } = await runControl(
          'normal-leader',
          { variant },
        )
        expect('value' in settled).toBe(true)
        expect(captured.commandExitCode).toBe(0)
        expect(captured.stdout).toContain('leader-final\n')
        expect(processCleanup.trigger).toBe('normal-leader-exit')
        expect(
          receipt.before?.members.some(
            (member) => member.identity.pid === receipt.ready?.descendantPid,
          ),
        ).toBe(true)
        if (variant === 'inherited')
          expect(captured.stdout).toContain('descendant-write\n')
      },
    )

    test('quota retains bounded bytes and continues counting/draining writes through cleanup', async () => {
      const { captured, processCleanup } = await runControl('quota', {
        quota: 64 * 1024,
        finite: true,
      })
      expect(captured.name).toBe('EvaluationOutputLimitError')
      expect(captured.outputTruncated).toBe(true)
      expect(captured.outputCapture.retainedBytes).toBe(64 * 1024)
      expect(captured.outputCapture.stdoutSeenBytes).toBeGreaterThan(128 * 1024)
      expect(captured.outputCapture.droppedBytes).toBe(
        captured.outputCapture.stdoutSeenBytes +
          captured.outputCapture.stderrSeenBytes -
          captured.outputCapture.retainedBytes,
      )
      expect(processCleanup.trigger).toBe('output-limit')
      expect(processCleanup.selectedLimitSatisfied).toBe(true)
    })

    test('Bun child output quota drains continuing writes through scope cleanup', async () => {
      const { captured } = await runControl('quota', {
        quota: 64 * 1024,
        finite: true,
        runtime: 'bun',
      })
      expect(captured.name).toBe('EvaluationOutputLimitError')
      expect(captured.outputCapture.retainedBytes).toBe(64 * 1024)
      expect(captured.outputCapture.droppedBytes).toBeGreaterThan(0)
      expect(captured.outputCapture.complete).toBe(true)
    })

    test('a nonzero command remains failed when its caller aborts during descendant cleanup', async () => {
      const root = mkdtempSync(join(tmpdir(), 'b20-evaluator-check-axis-'))
      const controller = new AbortController()
      let ready: Ready | undefined
      try {
        let resolveExit!: () => void
        const leaderExited = new Promise<void>((resolve) => {
          resolveExit = resolve
        })
        const execution = createEvaluationExecution({
          cwd: root,
          env: {},
          inheritEnv: false,
        })
        const command = `exec ${nodeExecutable} ${fixturePath} failed-leader ${root} redirected`
        const pending = runFinalCheckCommands(
          [command],
          root,
          undefined,
          controller.signal,
          {
            execution: {
              ...execution,
              spawn: (executable, args, options) => {
                const child = spawn(executable, args ?? [], options ?? {})
                child.once('exit', resolveExit)
                return child
              },
            },
          },
        )
        await waitForFile(join(root, 'ready.json'))
        ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'))
        await leaderExited
        controller.abort(new Error('Abort during cleanup after command exit 2'))
        const [result] = await pending
        const oracle = {
          leader: physical(ready!.leaderPid),
          descendant: physical(ready!.descendantPid!),
        }
        save('failed-check-abort-during-cleanup', { result, ready, oracle })
        expect(result?.outcome).toBe('failed')
        expect(result?.exitCode).toBe(2)
        expect(result?.commandExitCode).toBe(2)
        expect(result?.processCleanup?.status).toBe('complete')
        expect(oracle.descendant.living).toBe(false)
      } finally {
        controller.abort()
        if (
          ready?.descendantPid &&
          physical(ready.descendantPid).living === true
        ) {
          try {
            process.kill(ready.descendantPid, 'SIGKILL')
          } catch {
            /* fixture teardown */
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('setup init joins physical cleanup after leader exit and abort', async () => {
      const root = mkdtempSync(join(tmpdir(), 'b20-evaluator-init-scope-'))
      const controller = new AbortController()
      const startedAtMs = performance.now()
      let child: ChildProcess | undefined
      let ready: Ready | undefined
      let scope: OwnedProcessScope | undefined
      const execution = createEvaluationExecution({
        cwd: root,
        env: {},
        inheritEnv: false,
        durationMs: 250,
      })
      const pending = runInit(
        `exec ${nodeExecutable} ${fixturePath} early-leader ${root} redirected`,
        root,
        {},
        controller.signal,
        {
          ...execution,
          spawn: (executable, args, options) => {
            child = spawn(executable, args ?? [], options ?? {})
            return child
          },
        },
      ).then(
        () => ({ completed: true }),
        (error) => ({ error }),
      )
      try {
        await waitForFile(join(root, 'ready.json'))
        ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'))
        scope = evaluationProcessScope(child!)
        const before = await scope!.observe()
        controller.abort(
          new Error('Init abort after observed worker readiness'),
        )
        const settled = await pending
        const error = 'error' in settled ? settled.error : undefined
        const oracle = {
          leader: physical(ready!.leaderPid),
          descendant: physical(ready!.descendantPid!),
          lateMarkerExists: existsSync(join(root, 'late-marker')),
        }
        save('setup-init-abort-after-ready', {
          before,
          ready,
          processCleanup: error?.processCleanup,
          elapsedMs: performance.now() - startedAtMs,
          oracle,
        })
        expect(
          before.members.some(
            (member) => member.identity.pid === ready!.descendantPid,
          ),
        ).toBe(true)
        expect(error?.name).toBe('AbortError')
        expect(error?.processCleanup.status).toBe('complete')
        expect(error?.processCleanup.selectedTier).toBe('posix-owned-group')
        expect(oracle.leader.living).toBe(false)
        expect(oracle.descendant.living).toBe(false)
        expect(oracle.lateMarkerExists).toBe(false)
      } finally {
        controller.abort()
        if (scope?.currentCleanup()?.cleanupAuthorityRetained)
          await scope.retryCleanup(true)
        if (
          ready?.descendantPid &&
          physical(ready.descendantPid).living === true
        ) {
          try {
            process.kill(ready.descendantPid, 'SIGKILL')
          } catch {
            /* fixture teardown */
          }
        }
        await pending
        rmSync(root, { recursive: true, force: true })
      }
    })
  },
)
