/**
 * P2-T8c: supervised-spawn RESTART POLICY fault-injection suite for
 * supervision/supervised-spawn.ts (`buildDefaultSpawnSupervised` third
 * `options` argument: `restart: SupervisedRestartPolicy` + the test-only
 * `_scheduleRestart` backoff sleep hook).
 *
 * The seam's per-attempt body dynamically imports './process-supervisor' and
 * calls `spawnSettledSubagent` / `buildSupervisedChildEnv` there, so the
 * settled outcome SEQUENCE is injected through the TEST-ONLY
 * `_spawnSettledSubagent` option (see SupervisedSpawnOptions) — no production
 * file is modified and no real child process is spawned here (exception: the
 * free-form non-JSON-serializable-request case, which settles inside the seam
 * itself before any spawn). Backoff waits are
 * replaced by the `_scheduleRestart` recording hook (no real sleeps), and
 * every seam call is bounded by a wall-clock race so a restart-loop bug
 * shows as a timeout failure, never a hung run. No unbounded loops.
 */
import { describe, expect, it } from 'bun:test'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type {
  SettledSubagentResult,
  SupervisedSpawnRequest,
} from '@codebuff/common/types/contracts/agent-runtime'

import type { SpawnSettledSubagentParams } from '../process-supervisor'
import { SETTLE_DEFAULT_TIMEOUT_MS } from '../process-supervisor'
import { buildDefaultSpawnSupervised } from '../supervised-spawn'

// ---- outcome-sequence injection (the only test-side seam available) ------

const spawnQueue: SettledSubagentResult[] = []
const spawnCallParams: unknown[] = []

// The queue-driven stub injected via the TEST-ONLY `_spawnSettledSubagent`
// option (see SupervisedSpawnOptions): it matches the REAL
// spawnSettledSubagent signature, records each call's params, and returns the
// next queued settled outcome — so no production file is modified (no bun
// process-global mock.module leak) and no real child process is spawned.
const spawnSettledSubagentStub = async (
  params: SpawnSettledSubagentParams,
): Promise<SettledSubagentResult> => {
  spawnCallParams.push(params)
  const next = spawnQueue.shift()
  if (next === undefined) {
    throw new Error('spawn-settle stub queue exhausted — restart loop unbounded')
  }
  return next
}

/** Resets the injected settled-outcome queue + call log between tests. */
function resetSpawnQueue(): void {
  spawnQueue.length = 0
  spawnCallParams.length = 0
}

// ---- fixture envelopes ---------------------------------------------------

const OK_RECEIPT: AgentReceipt = {
  schemaVersion: 1,
  receiptId: 'restart-fixture-receipt',
  taskId: 'restart-fixture-task',
  role: 'specialist',
  agentId: 'restart-fixture-agent',
  status: 'completed',
  outcome: 'ok',
  changedFiles: [],
  requirementsAddressed: [],
  acceptanceCriteriaAddressed: [],
  findingsAddressed: [],
  evidence: [],
  assumptions: [],
  unresolved: [],
  requestedValidation: [],
  artifacts: [],
  errors: [],
}

function settledOk(): SettledSubagentResult {
  return {
    outcome: 'ok',
    receipt: OK_RECEIPT,
    exitCode: 0,
    durationMs: 5,
    stdoutBytes: 256,
    killed: false,
    stderrTail: '',
  }
}

function settledCrash(
  crashReason: string,
  overrides: Partial<SettledSubagentResult> = {},
): SettledSubagentResult {
  return {
    outcome: 'crashed',
    crashReason,
    exitCode: 1,
    durationMs: 5,
    stdoutBytes: 0,
    killed: false,
    stderrTail: `crash: ${crashReason}`,
    ...overrides,
  }
}

/** Queue a settled-outcome sequence for the next seam run. */
function queueSpawns(...results: SettledSubagentResult[]): void {
  spawnQueue.push(...results)
}

// ---- harness -------------------------------------------------------------

const SETTLE_TIMEOUT_MS = 5_000

/** Fails the test (instead of hanging) when the seam does not settle in time. */
async function settleBounded(
  seam: (request: SupervisedSpawnRequest) => Promise<SettledSubagentResult>,
  request: SupervisedSpawnRequest,
): Promise<SettledSubagentResult> {
  return Promise.race([
    seam(request),
    Bun.sleep(SETTLE_TIMEOUT_MS).then(() => {
      throw new Error(
        `supervised restart test did not settle within ${SETTLE_TIMEOUT_MS}ms — an unbounded restart loop would hang here`,
      )
    }),
  ])
}

const REQUEST: SupervisedSpawnRequest = {
  agentType: 'test-restart-policy',
  prompt: 'Probe',
  spawnParams: undefined,
  child: { agentId: 'restart-fixture-agent-child' },
  timeoutMs: 10_000,
}

interface RecordedRestart {
  delays: number[]
  observes: Array<{ attempt: number; crashReason: string }>
}

/** Builds a seam with restart enabled + recorded backoffs/observations. */
function buildRestartingSeam(policy: {
  maxAttempts: number
  backoffMs?: number
  backoffMultiplier?: number
  onRestart?: (info: { attempt: number; crashReason: string }) => void
}): {
  seam: (request: SupervisedSpawnRequest) => Promise<SettledSubagentResult>
  record: RecordedRestart
} {
  const record: RecordedRestart = { delays: [], observes: [] }
  const seam = buildDefaultSpawnSupervised({}, undefined, {
    restart: {
      maxAttempts: policy.maxAttempts,
      ...(policy.backoffMs !== undefined
        ? { backoffMs: policy.backoffMs }
        : {}),
      ...(policy.backoffMultiplier !== undefined
        ? { backoffMultiplier: policy.backoffMultiplier }
        : {}),
      onRestart:
        policy.onRestart ??
        ((info: { attempt: number; crashReason: string }) => {
          record.observes.push(info)
        }),
    },
    _spawnSettledSubagent: spawnSettledSubagentStub,
    _scheduleRestart: async (delayMs) => {
      record.delays.push(delayMs)
    },
  })
  return { seam, record }
}

describe('supervised-spawn restart policy (P2-T8c)', () => {
  it(
    'crash→respawn fault injection: up to maxAttempts restarts, then settles ok',
    async () => {
      resetSpawnQueue()
      const firstCrash = settledCrash('spawn_failed')
      const secondCrash = settledCrash('internal_error')
      const okResult = settledOk()
      // Two restartable crashes, then the good attempt. maxAttempts 2 →
      // up to 3 total spawns.
      queueSpawns(firstCrash, secondCrash, okResult)
      const { seam, record } = buildRestartingSeam({
        maxAttempts: 2,
        backoffMs: 10,
        backoffMultiplier: 2,
      })
      const result = await settleBounded(seam, REQUEST)
      // 3 spawns consumed the whole queue; the ok attempt is LAST.
      expect(spawnCallParams).toHaveLength(3)
      expect(result).toBe(okResult)
      expect(result.outcome).toBe('ok')
      expect((result.receipt as AgentReceipt)?.taskId).toBe(
        OK_RECEIPT.taskId,
      )
      // onRestart fired exactly maxAttempts times, 1-based restart numbers,
      // each carrying the PREVIOUS attempt's crashReason.
      expect(record.observes).toEqual([
        { attempt: 1, crashReason: 'spawn_failed' },
        { attempt: 2, crashReason: 'internal_error' },
      ])
      // Exponential backoff per recorded _scheduleRestart call:
      // 10 * 2^0 = 10, 10 * 2^1 = 20.
      expect(record.delays).toEqual([10, 20])
    },
  )

  it(
    'exhausted restarts: every attempt crashes → the LAST crashed result is returned UNCHANGED',
    async () => {
      resetSpawnQueue()
      const lastCrash = settledCrash('nonzero_exit', {
        stderrTail: 'final attempt stderr',
      })
      queueSpawns(
        settledCrash('nonzero_exit'),
        settledCrash('nonzero_exit'),
        lastCrash,
      )
      const { seam, record } = buildRestartingSeam({ maxAttempts: 2 })
      const result = await settleBounded(seam, REQUEST)
      expect(spawnCallParams).toHaveLength(3)
      expect(result).toBe(lastCrash)
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('nonzero_exit')
      expect(result.stderrTail).toBe('final attempt stderr')
      // Both budgeted restarts fired before exhaustion.
      expect(record.observes).toEqual([
        { attempt: 1, crashReason: 'nonzero_exit' },
        { attempt: 2, crashReason: 'nonzero_exit' },
      ])
    },
  )

  it('maxAttempts: 0 keeps the inert single-spawn path with zero restarts', async () => {
    resetSpawnQueue()
    const okResult = settledOk()
    // Only ONE spawn may be queued — a second call would throw.
    queueSpawns(okResult)
    const { seam, record } = buildRestartingSeam({ maxAttempts: 0 })
    const result = await settleBounded(seam, REQUEST)
    expect(spawnCallParams).toHaveLength(1)
    expect(result).toBe(okResult)
    expect(record.delays).toEqual([])
    expect(record.observes).toEqual([])
  })

  it('bounded queue: a runaway restart loop drains the queue and timeouts, never hangs', async () => {
    resetSpawnQueue()
    // Two queue entries but maxAttempts 3 would demand a 4th spawn: the
    // stub throws → the settle race surfaces a failure, not a hang.
    queueSpawns(
      settledCrash('spawn_failed'),
      settledCrash('spawn_failed'),
      settledCrash('spawn_failed'),
    )
    const { seam } = buildRestartingSeam({ maxAttempts: 3 })
    const settled = await settleBounded(seam, REQUEST).then(
      () => 'settled-ok',
      (error: unknown) =>
        error instanceof Error
          ? error.message
          : 'rejected with a non-Error',
    )
    expect(settled).toBe(
      'spawn-settle stub queue exhausted — restart loop unbounded',
    )
    expect(spawnCallParams).toHaveLength(4)
  })

  it('crashed with crashReason timeout is NOT restartable — settles as-is', async () => {
    resetSpawnQueue()
    const timeoutCrash = settledCrash('timeout', {
      exitCode: null,
      killed: true,
    })
    queueSpawns(timeoutCrash)
    const { seam, record } = buildRestartingSeam({ maxAttempts: 2 })
    const result = await settleBounded(seam, REQUEST)
    expect(spawnCallParams).toHaveLength(1)
    expect(result).toBe(timeoutCrash)
    expect(record.delays).toEqual([])
    expect(record.observes).toEqual([])
  })

  it(
    'free-form crashReason (non-JSON-serializable request) is NOT restartable — settles as-is',
    async () => {
      resetSpawnQueue()
      const { seam, record } = buildRestartingSeam({ maxAttempts: 2 })
      // Nothing is queued: a restartable crash would drain the queue and
      // throw inside the stub instead of restarting.
      // A circular reference can never survive JSON.stringify, so the seam
      // must settle the structured free-form input-bug crash instead of
      // spawning — and never restart.
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const result = await settleBounded(seam, {
        ...REQUEST,
        child: {
          agentId: 'restart-fixture-agent-child',
          messageHistory: circular,
        },
      })
      expect(result.outcome).toBe('crashed')
      expect(
        result.crashReason?.startsWith(
          'supervised request is not JSON-serializable',
        ),
      ).toBe(true)
      expect(spawnCallParams).toHaveLength(0)
      expect(record.delays).toEqual([])
      expect(record.observes).toEqual([])
    },
  )

  it(
    'nonzero_exit WITH a valid receipt envelope is NOT restartable (agent-level failure)',
    async () => {
      resetSpawnQueue()
      const withReceipt = settledCrash('nonzero_exit', {
        exitCode: 1,
        receipt: OK_RECEIPT,
      })
      queueSpawns(withReceipt)
      const { seam, record } = buildRestartingSeam({ maxAttempts: 2 })
      const result = await settleBounded(seam, REQUEST)
      expect(spawnCallParams).toHaveLength(1)
      expect(result).toBe(withReceipt)
      expect(result.receipt).toBe(OK_RECEIPT)
      expect(record.delays).toEqual([])
      expect(record.observes).toEqual([])
    },
  )

  it(
    'nonzero_exit WITHOUT a receipt envelope IS restartable and respawns',
    async () => {
      resetSpawnQueue()
      const okResult = settledOk()
      queueSpawns(settledCrash('nonzero_exit'), okResult)
      const { seam, record } = buildRestartingSeam({ maxAttempts: 2 })
      const result = await settleBounded(seam, REQUEST)
      expect(spawnCallParams).toHaveLength(2)
      expect(result).toBe(okResult)
      expect(record.observes).toEqual([
        { attempt: 1, crashReason: 'nonzero_exit' },
      ])
    },
  )
})

describe('supervised-spawn restart policy normalization (P2-T8c)', () => {
  // Mirrors RESTART_DEFAULT_BACKOFF_MS / RESTART_DEFAULT_BACKOFF_MULTIPLIER
  // in supervised-spawn.ts (module-private, so asserted by value here).
  const DEFAULT_BACKOFF_MS = 250
  const DEFAULT_BACKOFF_MULTIPLIER = 2

  const NON_FINITE_VALUES: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ]

  for (const [label, value] of NON_FINITE_VALUES) {
    it(`non-finite backoffMs (${label}) clamps to the default ${DEFAULT_BACKOFF_MS}ms`, async () => {
      resetSpawnQueue()
      const okResult = settledOk()
      queueSpawns(settledCrash('spawn_failed'), okResult)
      const { seam, record } = buildRestartingSeam({
        maxAttempts: 1,
        backoffMs: value,
        backoffMultiplier: 2,
      })
      const result = await settleBounded(seam, REQUEST)
      expect(spawnCallParams).toHaveLength(2)
      expect(result).toBe(okResult)
      // First restart waits exactly backoffMs → the clamped default.
      expect(record.delays).toEqual([DEFAULT_BACKOFF_MS])
    })
  }

  it(`negative backoffMs clamps to the default ${DEFAULT_BACKOFF_MS}ms`, async () => {
    resetSpawnQueue()
    const okResult = settledOk()
    queueSpawns(settledCrash('spawn_failed'), okResult)
    const { seam, record } = buildRestartingSeam({
      maxAttempts: 1,
      backoffMs: -5,
      backoffMultiplier: 2,
    })
    const result = await settleBounded(seam, REQUEST)
    expect(spawnCallParams).toHaveLength(2)
    expect(result).toBe(okResult)
    expect(record.delays).toEqual([DEFAULT_BACKOFF_MS])
  })

  for (const [label, value] of NON_FINITE_VALUES) {
    it(`non-finite backoffMultiplier (${label}) clamps to the default ×${DEFAULT_BACKOFF_MULTIPLIER}`, async () => {
      resetSpawnQueue()
      const okResult = settledOk()
      queueSpawns(
        settledCrash('spawn_failed'),
        settledCrash('internal_error'),
        okResult,
      )
      const { seam, record } = buildRestartingSeam({
        maxAttempts: 2,
        backoffMs: 10,
        backoffMultiplier: value,
      })
      const result = await settleBounded(seam, REQUEST)
      expect(spawnCallParams).toHaveLength(3)
      expect(result).toBe(okResult)
      // 10 * 2^0 = 10, 10 * 2^1 = 20 with the clamped default multiplier.
      expect(record.delays).toEqual([10, 10 * DEFAULT_BACKOFF_MULTIPLIER])
    })
  }

  it(`negative backoffMultiplier clamps to the default ×${DEFAULT_BACKOFF_MULTIPLIER}`, async () => {
    resetSpawnQueue()
    const okResult = settledOk()
    queueSpawns(
      settledCrash('spawn_failed'),
      settledCrash('internal_error'),
      okResult,
    )
    const { seam, record } = buildRestartingSeam({
      maxAttempts: 2,
      backoffMs: 10,
      backoffMultiplier: -3,
    })
    const result = await settleBounded(seam, REQUEST)
    expect(spawnCallParams).toHaveLength(3)
    expect(result).toBe(okResult)
    expect(record.delays).toEqual([10, 10 * DEFAULT_BACKOFF_MULTIPLIER])
  })

  it('fractional maxAttempts (2.7) floors to 2 restarts — 3 total spawns', async () => {
    resetSpawnQueue()
    const thirdCrash = settledCrash('spawn_failed', {
      stderrTail: 'third attempt stderr',
    })
    const unusedFourth = settledOk()
    // A 4th entry is queued so that a ceil/round bug (3 restarts) would
    // consume it and settle ok instead of returning the 3rd crash.
    queueSpawns(
      settledCrash('spawn_failed'),
      settledCrash('spawn_failed'),
      thirdCrash,
      unusedFourth,
    )
    const { seam, record } = buildRestartingSeam({
      maxAttempts: 2.7,
      backoffMs: 10,
      backoffMultiplier: 2,
    })
    const result = await settleBounded(seam, REQUEST)
    expect(spawnCallParams).toHaveLength(3)
    expect(result).toBe(thirdCrash)
    expect(spawnQueue).toEqual([unusedFourth])
    expect(record.observes).toEqual([
      { attempt: 1, crashReason: 'spawn_failed' },
      { attempt: 2, crashReason: 'spawn_failed' },
    ])
    expect(record.delays).toEqual([10, 20])
  })
})

describe('supervised-spawn settle deadline wiring (absolute lifetime cap)', () => {
  /**
   * The default seam (no restart policy) driven through the settle-stub
   * injection: the stub records the params it received, so these tests
   * assert the DEADLINE WIRING `runSettledAttempt` hands to the supervisor
   * — without spawning a real child process.
   */
  it('arms idleTimeoutMs AND maxLifetimeMs (plus timeoutMs) at the request deadline', async () => {
    resetSpawnQueue()
    const okResult = settledOk()
    queueSpawns(okResult)
    const seam = buildDefaultSpawnSupervised({}, undefined, {
      _spawnSettledSubagent: spawnSettledSubagentStub,
    })
    const result = await settleBounded(seam, REQUEST)
    expect(result).toBe(okResult)
    const settleParams = spawnCallParams[0] as SpawnSettledSubagentParams
    expect(settleParams.timeoutMs).toBe(REQUEST.timeoutMs)
    expect(settleParams.idleTimeoutMs).toBe(REQUEST.timeoutMs)
    // The absolute lifetime cap MUST ride along with the idle window: with
    // only the idle window armed (the regressions this guards against), a
    // child that keeps emitting stdout/bridge activity resets the window
    // forever and NEVER settles — the supervisor's single wall-clock
    // termTimer branch is skipped whenever idleTimeoutMs is present.
    expect(settleParams.maxLifetimeMs).toBe(REQUEST.timeoutMs)
  })

  it(
    `defaults the deadline (including maxLifetimeMs) to SETTLE_DEFAULT_TIMEOUT_MS when the request omits timeoutMs`,
    async () => {
      resetSpawnQueue()
      const okResult = settledOk()
      queueSpawns(okResult)
      const seam = buildDefaultSpawnSupervised({}, undefined, {
        _spawnSettledSubagent: spawnSettledSubagentStub,
      })
      await settleBounded(seam, { ...REQUEST, timeoutMs: undefined })
      const settleParams = spawnCallParams[0] as SpawnSettledSubagentParams
      expect(settleParams.idleTimeoutMs).toBe(SETTLE_DEFAULT_TIMEOUT_MS)
      expect(settleParams.timeoutMs).toBe(SETTLE_DEFAULT_TIMEOUT_MS)
      // The default deadline applies as the absolute cap too — the
      // documented 10-minute wall-clock deadline holds even for a
      // continuously-active child.
      expect(settleParams.maxLifetimeMs).toBe(SETTLE_DEFAULT_TIMEOUT_MS)
    },
  )
})
