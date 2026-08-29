import fs, {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'

import {
  TEST_AGENT_RUNTIME_IMPL,
  mockFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  SKIP_POSIX_MODE_CASES,
  SKIP_SYMLINK_CASES,
  makeGateTelemetryProjectRoot,
  readGateTelemetrySinkLines as readSinkLines,
} from '@codebuff/common/testing/gate-telemetry-fixtures'
import { createMockLoggerWithCapture } from '@codebuff/common/testing/mocks/logger'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { GATE_TELEMETRY_RELATIVE } from '@codebuff/common/util/gate-telemetry'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import {
  MISSING_BASE2_PROJECT_ROOT_WARN_KEY_CAP,
  clearAgentGeneratorCache,
  runProgrammaticStep,
} from '../../run-programmatic-step'
import {
  GATE_TELEMETRY_WARN_LATCH_MAX_KEYS,
  GATE_TELEMETRY_WARN_RELATCH_SUCCESSES,
  createGateTelemetryRecorder,
  createWarnLatchedLogger,
} from '../gate-telemetry-sink'

import type { AgentTemplate } from '../../templates/types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'

const tempRoots: string[] = []

/**
 * A shared temp root registered for the `afterAll` sweep below. The root and
 * sink-reading helpers come from `common/src/testing/gate-telemetry-fixtures`,
 * so this suite and the sink's own suite cannot drift on the skip policy or on
 * how the sink is read.
 */
function makeProjectRoot(): string {
  const root = makeGateTelemetryProjectRoot('gate-telemetry-sink-test-')
  tempRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Block/unblock every append under `projectRoot`: a regular file where the sink
 * path's FIRST directory segment belongs makes the per-segment lstat fail with
 * ENOTDIR, before mkdir is ever reached, so appends fail until the file is
 * removed. The segment is derived from `GATE_TELEMETRY_RELATIVE` so a sink-path
 * change cannot silently turn the blocked-sink cases into passing no-ops.
 *
 * `blockSink()` REPLACES that segment, so it also WIPES every telemetry line
 * written since the previous block: a `readSinkLines` count taken after a
 * `blockSink()` counts only the appends made since it, which is what the
 * per-phase line-count assertions below read. `unblockSink()` removes the
 * blocker FILE only and never deletes written lines.
 */
function makeBlockableSink(projectRoot: string): {
  blockSink: () => void
  unblockSink: () => void
} {
  const blocker = join(projectRoot, GATE_TELEMETRY_RELATIVE.split(sep)[0])
  return {
    blockSink: () => {
      // Recursive on purpose, and the only place that wipes: once an append has
      // landed the segment is a real directory, which a regular file cannot be
      // written over.
      rmSync(blocker, { recursive: true, force: true })
      writeFileSync(blocker, 'not-a-directory')
    },
    // Non-recursive: the blocker is always the regular file written above, so
    // unblocking cannot remove the sink directory or the lines inside it.
    unblockSink: () => rmSync(blocker, { force: true }),
  }
}

describe('createGateTelemetryRecorder', () => {
  test('forwards the bound project root and writes a JSONL line', () => {
    const projectRoot = makeProjectRoot()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    record({ event: 'base2.gate', findingCount: 3 })

    const lines = readSinkLines(projectRoot)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'base2.gate',
      findingCount: 3,
    })
    expect(getByLevel('warn')).toEqual([])
  })

  test('never throws when the bound project root is blank', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot: '', logger })
    expect(() => record({ event: 'base2.gate' })).not.toThrow()
    // A blank root is a no-op, not a sink failure, so nothing is logged.
    expect(getByLevel('warn')).toEqual([])
  })

  test('warns only once per recorder for a permanently failing sink', () => {
    const projectRoot = makeProjectRoot()
    // A blocked sink fails every append for the lifetime of the recorder.
    makeBlockableSink(projectRoot).blockSink()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    for (let i = 0; i < 5; i++) {
      expect(() => record({ event: 'base2.gate', round: i })).not.toThrow()
    }
    expect(getByLevel('warn')).toHaveLength(1)
    // The single warning identifies the failure mode on its own: the latch key
    // is the code of the logged error.
    expect(
      typeof (getByLevel('warn')[0].meta?.err as { code?: unknown } | undefined)
        ?.code,
    ).toBe('string')

    // The latch is recorder-scoped, so a fresh recorder still reports the
    // first failure it sees.
    const second = createMockLoggerWithCapture()
    createGateTelemetryRecorder({ projectRoot, logger: second.logger })({
      event: 'base2.gate',
    })
    expect(second.getByLevel('warn')).toHaveLength(1)
  })

  test('the latch re-arms only after several consecutive successful appends', () => {
    const projectRoot = makeProjectRoot()
    const { blockSink, unblockSink } = makeBlockableSink(projectRoot)

    blockSink()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    record({ event: 'base2.gate', round: 1 })
    record({ event: 'base2.gate', round: 2 })
    expect(getByLevel('warn')).toHaveLength(1)

    // A single success is a flap, not a recovery: it must not re-arm the latch,
    // or an alternating success/failure sink re-warns on every flip.
    unblockSink()
    record({ event: 'base2.gate', round: 3 })
    expect(readSinkLines(projectRoot)).toHaveLength(1)
    blockSink()
    record({ event: 'base2.gate', round: 4 })
    expect(getByLevel('warn')).toHaveLength(1)

    // A sustained recovery (the full consecutive-success threshold) does re-arm
    // it, so a later persistent failure is still reported once.
    unblockSink()
    for (let i = 0; i < GATE_TELEMETRY_WARN_RELATCH_SUCCESSES; i++) {
      record({ event: 'base2.gate', round: 10 + i })
    }
    expect(getByLevel('warn')).toHaveLength(1)
    expect(readSinkLines(projectRoot)).toHaveLength(
      GATE_TELEMETRY_WARN_RELATCH_SUCCESSES,
    )

    blockSink()
    record({ event: 'base2.gate', round: 20 })
    record({ event: 'base2.gate', round: 21 })
    expect(getByLevel('warn')).toHaveLength(2)
  })

  test('successes while nothing is latched do not count toward a re-arm', () => {
    const projectRoot = makeProjectRoot()
    const { blockSink, unblockSink } = makeBlockableSink(projectRoot)

    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    // A full threshold of successes with an EMPTY latch: nothing is latched, so
    // these must neither be credited toward re-arming a later failure nor keep
    // cycling the counter for the rest of the run.
    for (let i = 0; i < GATE_TELEMETRY_WARN_RELATCH_SUCCESSES; i++) {
      record({ event: 'base2.gate', round: i })
    }
    expect(getByLevel('warn')).toEqual([])

    blockSink()
    record({ event: 'base2.gate', round: 10 })
    expect(getByLevel('warn')).toHaveLength(1)

    // One success is short of the threshold, so the latch is still holding and
    // the repeated failure stays silent — the pre-failure successes bought it
    // nothing.
    unblockSink()
    record({ event: 'base2.gate', round: 11 })
    blockSink()
    record({ event: 'base2.gate', round: 12 })
    expect(getByLevel('warn')).toHaveLength(1)
  })

  test('a successful append that itself warns does not count toward the re-arm', () => {
    // The mode repair is skipped entirely where POSIX modes are not honored, so
    // a successful-but-warning append cannot be produced there.
    if (SKIP_POSIX_MODE_CASES) return
    const projectRoot = makeProjectRoot()
    const { blockSink, unblockSink } = makeBlockableSink(projectRoot)
    const originalFchmodSync = fs.fchmodSync
    try {
      blockSink()
      const { logger, getByLevel } = createMockLoggerWithCapture()
      const record = createGateTelemetryRecorder({ projectRoot, logger })
      record({ event: 'base2.gate', round: 1 })
      expect(getByLevel('warn')).toHaveLength(1)

      // The sink recovers, but its owner-only mode repair now fails: that path
      // warns and STILL reports a successful append. Only the first success
      // after the failure is unverified, so exactly one of the appends below
      // carries that warning.
      unblockSink()
      fs.fchmodSync = () => {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }
      for (let i = 0; i < GATE_TELEMETRY_WARN_RELATCH_SUCCESSES; i++) {
        record({ event: 'base2.gate', round: 10 + i })
      }
      // Every append landed, and the repair failure is reported once.
      expect(readSinkLines(projectRoot)).toHaveLength(
        GATE_TELEMETRY_WARN_RELATCH_SUCCESSES,
      )
      expect(getByLevel('warn')).toHaveLength(2)

      // The warning append spent the streak instead of counting toward it, so
      // the threshold was never met and the original failure stays latched.
      fs.fchmodSync = originalFchmodSync
      blockSink()
      record({ event: 'base2.gate', round: 20 })
      expect(getByLevel('warn')).toHaveLength(2)

      // Three GENUINELY clean appends do re-arm it, so the failure is reported
      // again afterwards.
      unblockSink()
      for (let i = 0; i < GATE_TELEMETRY_WARN_RELATCH_SUCCESSES; i++) {
        record({ event: 'base2.gate', round: 30 + i })
      }
      blockSink()
      record({ event: 'base2.gate', round: 40 })
      expect(getByLevel('warn')).toHaveLength(3)
    } finally {
      fs.fchmodSync = originalFchmodSync
    }
  })

  test('a transient fs failure does not swallow the symlink-refusal warning', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    const { blockSink, unblockSink } = makeBlockableSink(projectRoot)
    // The blocked sink fails with ENOTDIR, an fs failure carrying a code.
    blockSink()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    record({ event: 'base2.gate', round: 1 })
    expect(getByLevel('warn')).toHaveLength(1)

    // Now the sink leaf becomes a symlink to a decoy, WITHOUT any successful
    // append in between to clear the latch. A single shared boolean would drop
    // this security-relevant warning; keying on the failure mode reports it.
    unblockSink()
    const sinkPath = join(projectRoot, GATE_TELEMETRY_RELATIVE)
    const decoyPath = join(projectRoot, 'decoy.jsonl')
    writeFileSync(decoyPath, '')
    mkdirSync(dirname(sinkPath), { recursive: true })
    symlinkSync(decoyPath, sinkPath)

    record({ event: 'base2.gate', round: 2 })

    const warnings = getByLevel('warn')
    expect(warnings).toHaveLength(2)
    expect(warnings[1].message).toContain('symlink')
    expect(warnings[1].meta).toMatchObject({ symlinkedSegment: sinkPath })
    // Nothing was written through the symlink.
    expect(readFileSync(decoyPath, 'utf8')).toBe('')

    // The refusal itself is still latched: repeating it does not re-warn.
    record({ event: 'base2.gate', round: 3 })
    expect(getByLevel('warn')).toHaveLength(2)
  })

  test('a refusal at a DIFFERENT path segment still warns for that segment', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const record = createGateTelemetryRecorder({ projectRoot, logger })

    // First refusal: the sink LEAF is a symlink to a decoy file.
    const sinkPath = join(projectRoot, GATE_TELEMETRY_RELATIVE)
    const telemetryDir = dirname(sinkPath)
    const decoyPath = join(projectRoot, 'decoy.jsonl')
    writeFileSync(decoyPath, '')
    mkdirSync(telemetryDir, { recursive: true })
    symlinkSync(decoyPath, sinkPath)

    record({ event: 'base2.gate', round: 1 })
    const firstWarnings = getByLevel('warn')
    expect(firstWarnings).toHaveLength(1)
    expect(firstWarnings[0].meta).toMatchObject({ symlinkedSegment: sinkPath })

    // The symlink now moves one segment UP, to `.openbuff/telemetry`, with no
    // successful append in between to clear the latch. The message is identical
    // and neither refusal carries an `err`, so a latch key of message + err
    // code alone would silence this second, distinct traversal attempt for the
    // rest of the recorder's lifetime.
    rmSync(sinkPath)
    rmSync(telemetryDir, { recursive: true })
    const decoyDir = join(projectRoot, 'decoy-telemetry')
    mkdirSync(decoyDir)
    const decoyInDir = join(decoyDir, 'base2-gate.jsonl')
    writeFileSync(decoyInDir, '')
    symlinkSync(decoyDir, telemetryDir)

    record({ event: 'base2.gate', round: 2 })
    const afterMove = getByLevel('warn')
    expect(afterMove).toHaveLength(2)
    expect(afterMove[1].message).toContain('symlink')
    expect(afterMove[1].meta).toMatchObject({ symlinkedSegment: telemetryDir })
    // Nothing was written through either symlink.
    expect(readFileSync(decoyPath, 'utf8')).toBe('')
    expect(readFileSync(decoyInDir, 'utf8')).toBe('')

    // Each distinct segment is still reported exactly once.
    record({ event: 'base2.gate', round: 3 })
    expect(getByLevel('warn')).toHaveLength(2)
  })

  test('latches repeated sink failures for a prototype-based logger, at `warn` only', () => {
    const projectRoot = makeProjectRoot()
    // A blocked sink fails every append, so the wrapped `warn` is exercised on
    // the real failure path; an `error`-level report would be visible here if
    // the sink ever used one.
    makeBlockableSink(projectRoot).blockSink()
    const calls: string[] = []
    const record = createGateTelemetryRecorder({
      projectRoot,
      logger: makePrototypeLogger(calls),
    })

    record({ event: 'base2.gate' })
    record({ event: 'base2.gate' })

    // Exactly one entry, so this pins BOTH the latching across repeats and the
    // level every other once-per-failure-mode assertion in this file counts —
    // the reason `createWarnLatchedLogger` latches `warn` alone.
    expect(calls).toEqual(['warn'])
  })
})

describe('createWarnLatchedLogger', () => {
  test('latches `warn` per failure mode, re-arms on clear, and leaves `error` alone', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const { logger: latched, clearLatch } = createWarnLatchedLogger(logger)
    const err = Object.assign(new Error('denied'), { code: 'EACCES' })

    latched.warn({ err }, 'sink failed')
    latched.warn({ err }, 'sink failed')
    expect(getByLevel('warn')).toHaveLength(1)

    // A distinct failure mode is still reported.
    latched.warn({ err: Object.assign(new Error('full'), { code: 'ENOSPC' }) })
    expect(getByLevel('warn')).toHaveLength(2)

    clearLatch()
    latched.warn({ err }, 'sink failed')
    expect(getByLevel('warn')).toHaveLength(3)

    // `warn` is the only level the sink reports through, so `error` stays the
    // wrapped logger's own method instead of being latched speculatively.
    latched.error({ err }, 'sink failed')
    latched.error({ err }, 'sink failed')
    expect(getByLevel('error')).toHaveLength(2)
  })

  test('keys a pino-style string message instead of collapsing distinct reports', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const { logger: latched } = createWarnLatchedLogger(logger)

    // A string first argument IS the message for pino-style callers: ignoring it
    // would give every such call the same key and drop all but the first.
    latched.warn('first report')
    latched.warn('second report')
    latched.warn('first report')

    const warnings = getByLevel('warn')
    expect(warnings).toHaveLength(2)
    expect(warnings.map((entry) => entry.message)).toEqual([
      'first report',
      'second report',
    ])
  })

  test('forwards only the arguments the caller supplied', () => {
    const forwarded: unknown[][] = []
    const logger = Object.create({
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => forwarded.push(args),
      error: () => {},
    }) as Logger
    const { logger: latched } = createWarnLatchedLogger(logger)

    // A pino-style single-argument call must stay single-argument: forwarding
    // `warn(data, undefined)` unconditionally makes the wrapper non-transparent
    // for loggers that inspect `arguments.length`.
    latched.warn('message only')
    latched.warn({ err: { code: 'EACCES' } }, 'with message', 'extra')
    // No message but a trailing arg: the empty `msg` slot must stay in place, or
    // the interpolation arg slides into pino's message slot.
    latched.warn({ err: { code: 'ENOSPC' } }, undefined, 'trailing')

    expect(forwarded).toEqual([
      ['message only'],
      [{ err: { code: 'EACCES' } }, 'with message', 'extra'],
      [{ err: { code: 'ENOSPC' } }, undefined, 'trailing'],
    ])
  })

  test('caps the distinct reports it tracks at GATE_TELEMETRY_WARN_LATCH_MAX_KEYS', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const { logger: latched } = createWarnLatchedLogger(logger)

    // The latch's key space is finite by construction, and the bound is stated
    // in code: past it a fresh report is dropped rather than growing the key set
    // for the recorder's lifetime. The count is derived from the constant rather
    // than hardcoded.
    for (let i = 0; i < GATE_TELEMETRY_WARN_LATCH_MAX_KEYS + 5; i++) {
      latched.warn(`report ${i}`)
    }

    expect(getByLevel('warn')).toHaveLength(GATE_TELEMETRY_WARN_LATCH_MAX_KEYS)
  })

  test('reports `warnCount` only for reports the latch actually forwarded', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const {
      logger: latched,
      clearLatch,
      warnCount,
    } = createWarnLatchedLogger(logger)

    // The recorder counts CLEAN successes toward a re-arm off this counter, so
    // it must track what the latch actually FORWARDED, not merely that a failure
    // occurred: a warning the latch never emitted holds nothing to clear, and a
    // successful append that warns has to be distinguishable from a silent one.
    expect(warnCount()).toBe(0)

    latched.warn('sink failed')
    expect(getByLevel('warn')).toHaveLength(1)
    expect(warnCount()).toBe(1)

    // A repeat is suppressed by the latch, so the count is unchanged rather than
    // incremented by a report that never went out.
    latched.warn('sink failed')
    expect(getByLevel('warn')).toHaveLength(1)
    expect(warnCount()).toBe(1)

    // A DISTINCT report is forwarded, so the count moves: that difference is
    // what tells the recorder this call warned.
    latched.warn('mode repair failed')
    expect(getByLevel('warn')).toHaveLength(2)
    expect(warnCount()).toBe(2)

    clearLatch()
    expect(warnCount()).toBe(0)
  })

  test('counts a report only once the delegate actually emitted it', () => {
    let attempts = 0
    const logger = Object.create({
      debug: () => {},
      info: () => {},
      warn: () => {
        attempts += 1
        throw new Error('logger exploded')
      },
      error: () => {},
    }) as Logger
    const { logger: latched, warnCount } = createWarnLatchedLogger(logger)

    // The wrapper does not swallow a throwing delegate (`appendGateTelemetryEvent`
    // owns that contract), but it must not COUNT the report either: `warnCount()`
    // means "actually emitted", and a phantom count would reset the recorder's
    // clean-append streak for a warning nobody ever saw.
    expect(() => latched.warn('sink failed')).toThrow('logger exploded')
    expect(attempts).toBe(1)
    expect(warnCount()).toBe(0)
  })

  test('re-applies the latch to a `child` logger instead of returning an unlatched one', () => {
    const forwarded: Array<{ scope: string; args: unknown[] }> = []
    // pino exposes `child` on the PROTOTYPE, so the delegating wrapper hands it
    // straight through: without re-wrapping, a caller that takes a child logger
    // would re-warn for every repeat of the same failure mode.
    const makeLogger = (scope: string): Logger =>
      Object.create({
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => forwarded.push({ scope, args }),
        error: () => {},
        child: () => makeLogger(`${scope}.child`),
      }) as Logger
    const {
      logger: latched,
      clearLatch,
      warnCount,
    } = createWarnLatchedLogger(makeLogger('root'))

    const child = (latched as Logger & { child: () => Logger }).child()
    child.warn('sink failed')
    child.warn('sink failed')
    // The child forwards to the CHILD of the wrapped logger, and only once.
    expect(forwarded).toEqual([{ scope: 'root.child', args: ['sink failed'] }])

    // One latch and one count are shared with the parent, so the same failure
    // mode is not reported twice across the two loggers.
    latched.warn('sink failed')
    expect(forwarded).toHaveLength(1)
    expect(warnCount()).toBe(1)

    clearLatch()
    child.warn('sink failed')
    expect(forwarded).toHaveLength(2)
    expect(warnCount()).toBe(1)
  })
})

/**
 * Methods live on the prototype only, like pino: a `{ ...logger }` spread would
 * copy none of them and drop `debug`/`info`/`error` entirely.
 */
function makePrototypeLogger(calls: string[]): Logger {
  return Object.create({
    debug: () => calls.push('debug'),
    info: () => calls.push('info'),
    warn: () => calls.push('warn'),
    error: () => calls.push('error'),
  })
}

/**
 * Wiring coverage for run-programmatic-step's base2 branch.
 *
 * `runProgrammaticStep` builds `generatorParams` locally, so the only way to
 * observe the injection is through the generator it hands them to: a
 * `handleSteps` that captures `params` and returns immediately (done on the
 * first `next()`, so no tool execution or step bookkeeping runs).
 *
 * The blank-projectRoot warning latch lives in run-programmatic-step's run
 * context registry and is re-armed by `clearAgentGeneratorCache` in the
 * `beforeEach` below, so blank-root base2 runs may appear in any test here
 * without making another test's expected warning count order-dependent.
 */
describe('runProgrammaticStep base2 gate-telemetry wiring', () => {
  let runCounter = 0

  beforeEach(() => {
    // The reset logs nothing, so it takes no argument.
    clearAgentGeneratorCache()
  })

  function buildBase2StepParams(args: {
    templateId: string
    projectRoot: string
    logger: Logger
    capture: (generatorParams: Record<string, unknown>) => void
  }): ParamsOf<typeof runProgrammaticStep> {
    const handleSteps = function* (generatorArgs: {
      params?: Record<string, unknown>
    }) {
      args.capture(generatorArgs.params ?? {})
    }
    const template = {
      id: args.templateId,
      displayName: 'Wiring Template',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['end_turn'],
      spawnableAgents: [],
      systemPrompt: '',
      instructionsPrompt: '',
      stepPrompt: '',
      handleSteps,
    } as unknown as AgentTemplate
    const fileContext = { ...mockFileContext, projectRoot: args.projectRoot }
    const sessionState = getInitialSessionState(fileContext)
    const runId =
      `wiring-run-${++runCounter}` as `${string}-${string}-${string}-${string}-${string}`
    const agentState: AgentState = {
      ...sessionState.mainAgentState,
      agentId: 'base2-wiring-agent',
      runId,
      output: undefined,
      directCreditsUsed: 0,
      childRunIds: [],
    }
    return {
      ...TEST_AGENT_RUNTIME_IMPL,
      addAgentStep: async () => 'test-agent-step-id',
      sendAction: () => {},
      runId,
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      agentState,
      template,
      prompt: 'Wire the telemetry sink',
      toolCallParams: { existingParam: 'kept' },
      userId: 'test-user-id',
      userInputId: 'test-user-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      onCostCalculated: async () => {},
      fileContext,
      localAgentTemplates: {},
      system: undefined,
      stepsComplete: false,
      stepNumber: 1,
      tools: {},
      logger: args.logger,
      signal: new AbortController().signal,
    } as unknown as ParamsOf<typeof runProgrammaticStep>
  }

  test('injects recordGateTelemetry for a base2 template and not for others', async () => {
    const projectRoot = makeProjectRoot()
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const captured: Array<Record<string, unknown>> = []

    await runProgrammaticStep(
      buildBase2StepParams({
        templateId: 'base2-fast',
        projectRoot,
        logger,
        capture: (generatorParams) => captured.push(generatorParams),
      }),
    )

    expect(captured).toHaveLength(1)
    const controlPlane = captured[0].orchestrationControlPlane as Record<
      string,
      unknown
    >
    expect(typeof controlPlane.recordGateTelemetry).toBe('function')
    // Caller-supplied params stay additive alongside the injected control plane.
    expect(captured[0].existingParam).toBe('kept')

    // The injected recorder is the real sink bound to this run's project root.
    ;(controlPlane.recordGateTelemetry as (p: Record<string, unknown>) => void)(
      {
        event: 'base2.gate',
        wired: true,
      },
    )
    const lines = readSinkLines(projectRoot)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'base2.gate',
      wired: true,
    })

    // A non-base2 template keeps the caller's params untouched.
    const nonBase2: Array<Record<string, unknown>> = []
    await runProgrammaticStep(
      buildBase2StepParams({
        templateId: 'context-gatherer',
        projectRoot,
        logger,
        capture: (generatorParams) => nonBase2.push(generatorParams),
      }),
    )
    expect(nonBase2).toHaveLength(1)
    expect(nonBase2[0].orchestrationControlPlane).toBeUndefined()
    expect(getByLevel('warn')).toEqual([])
  })

  test('warns exactly once per latch arming when a base2 run has no projectRoot', async () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    const captured: Array<Record<string, unknown>> = []

    // Two invocations, exactly one warning: the registry-owned latch was
    // re-armed for this test by the beforeEach above.
    for (let i = 0; i < 2; i++) {
      await runProgrammaticStep(
        buildBase2StepParams({
          templateId: 'base2',
          projectRoot: '',
          logger,
          capture: (generatorParams) => captured.push(generatorParams),
        }),
      )
    }

    expect(captured).toHaveLength(2)
    const warnings = getByLevel('warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta).toMatchObject({ template: 'base2' })

    // The latch is keyed by template id, so a second, differently-configured
    // base2 variant is still diagnosable instead of silent for the process.
    await runProgrammaticStep(
      buildBase2StepParams({
        templateId: 'base2-fast',
        projectRoot: '',
        logger,
        capture: (generatorParams) => captured.push(generatorParams),
      }),
    )
    const afterVariant = getByLevel('warn')
    expect(afterVariant).toHaveLength(2)
    expect(afterVariant[1].meta).toMatchObject({ template: 'base2-fast' })
    // Without a project root the recorder is omitted entirely rather than
    // allocated as a no-op, which is exactly what the warning above reports.
    // base2 type-guards the field, so the control plane is still injected.
    for (const generatorParams of captured) {
      const controlPlane = generatorParams.orchestrationControlPlane as Record<
        string,
        unknown
      >
      expect(controlPlane).toBeDefined()
      expect(controlPlane.recordGateTelemetry).toBeUndefined()
    }
  })

  test('caps the distinct template ids the blank-projectRoot latch tracks', async () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()

    // The latch key is caller-controlled: any local template id starting with
    // `base2` contributes one. Past the cap a fresh id no longer warns, so the
    // latch's key set stays bounded instead of growing for the process
    // lifetime.
    for (let i = 0; i < MISSING_BASE2_PROJECT_ROOT_WARN_KEY_CAP + 3; i++) {
      await runProgrammaticStep(
        buildBase2StepParams({
          templateId: `base2-variant-${i}`,
          projectRoot: '',
          logger,
          capture: () => {},
        }),
      )
    }

    expect(getByLevel('warn')).toHaveLength(
      MISSING_BASE2_PROJECT_ROOT_WARN_KEY_CAP,
    )
  })

  test('clearing the run-context registry re-arms the blank-projectRoot warning', async () => {
    const first = createMockLoggerWithCapture()
    await runProgrammaticStep(
      buildBase2StepParams({
        templateId: 'base2',
        projectRoot: '',
        logger: first.logger,
        capture: () => {},
      }),
    )
    expect(first.getByLevel('warn')).toHaveLength(1)

    // Without this reset hook the second run below would be silent, which is
    // exactly the cross-test order dependence a module-scoped latch imposes.
    // The reset logs nothing, so it takes no argument here.
    clearAgentGeneratorCache()

    const second = createMockLoggerWithCapture()
    await runProgrammaticStep(
      buildBase2StepParams({
        templateId: 'base2',
        projectRoot: '',
        logger: second.logger,
        capture: () => {},
      }),
    )
    expect(second.getByLevel('warn')).toHaveLength(1)
  })
})
