import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod/v4'

import type {
  RequestAdmissionAttempt,
  RequestAdmissionBasis,
  RequestAdmissionSnapshot,
  RequestAdmissionStore,
  RequestCostProvenance,
  RequestReservationResult,
  SpendingPolicy,
} from '@codebuff/common/types/request-admission'
import type { ModelPricing } from '../impl/cost-accounting'

export const USD_MICROS_PER_CENT = 1_000_000
const STORE_SCHEMA_VERSION = 1
const MAX_ATTEMPTS = 10_000
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4))
let tempSequence = 0

const finiteNonNegative = z.number().finite().nonnegative()
const safeNonNegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

export const spendingPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('uncapped') }).strict(),
  z
    .object({
      mode: z.literal('strict-capped'),
      capCents: finiteNonNegative,
      currency: z.literal('USD'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('estimated-capped'),
      capCents: finiteNonNegative,
      currency: z.literal('USD'),
      estimator: z
        .object({
          id: z.string().min(1).max(128),
          reservationCents: z.number().finite().positive(),
          maxConcurrentAttempts: z.number().int().positive().max(1_024),
        })
        .strict(),
    })
    .strict(),
])

const basisSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('strict-bound'),
      description: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('estimated-reservation'),
      estimatorId: z.string().min(1).max(128),
      description: z.string().min(1).max(1_024),
    })
    .strict(),
])

const attemptSchema = z
  .object({
    attemptId: z.string().min(1).max(256),
    runId: z.string().min(1).max(4_096),
    provider: z.string().min(1).max(512),
    model: z.string().min(1).max(1_024),
    reservationUsdMicros: safeNonNegativeInteger,
    basis: basisSchema,
    state: z.enum(['reserve-active', 'held-inactive', 'reconciled']),
    createdAt: safeNonNegativeInteger,
    updatedAt: safeNonNegativeInteger,
    incompleteReason: z
      .enum([
        'missing-usage',
        'provider-error',
        'cancelled',
        'timeout',
        'process-restart',
        'invalid-usage',
        'unknown',
      ])
      .optional(),
    costUsdMicros: safeNonNegativeInteger.optional(),
    provenance: z
      .enum(['provider-reported', 'usage-plus-configured-pricing'])
      .optional(),
  })
  .strict()

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    authorityId: z.string().min(1).max(4_096),
    policy: spendingPolicySchema,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: safeNonNegativeInteger,
    capUsdMicros: safeNonNegativeInteger.optional(),
    heldUsdMicros: safeNonNegativeInteger,
    reconciledUsdMicros: safeNonNegativeInteger,
    activeAttempts: z.number().int().nonnegative().max(MAX_ATTEMPTS),
    exhausted: z.boolean(),
    degraded: z.boolean(),
    attempts: z.array(attemptSchema).max(MAX_ATTEMPTS),
    createdAt: safeNonNegativeInteger,
    updatedAt: safeNonNegativeInteger,
  })
  .strict()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function scaledUsdMicros(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0)
    throw new Error('USD cents must be finite and non-negative')
  const scaled = cents * USD_MICROS_PER_CENT
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER)
    throw new Error('USD fixed-point value exceeds the safe integer range')
  return scaled
}

/** Conservative attempt/charge conversion: fractional micros round upward. */
export function centsToUsdMicros(cents: number): number {
  return Math.ceil(scaledUsdMicros(cents))
}

/** Conservative cap conversion: fractional micros never enlarge the cap. */
export function capCentsToUsdMicros(cents: number): number {
  return Math.floor(scaledUsdMicros(cents))
}

export function usdMicrosToCents(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0)
    throw new Error('USD micros must be a non-negative safe integer')
  return micros / USD_MICROS_PER_CENT
}

export type StrictReservationInput = {
  pricing?: ModelPricing
  contextWindowTokens?: number
  maxOutputTokens?: number
  cacheWritesPossible: boolean
}

export type StrictReservationResult =
  | { ok: true; reservationUsdMicros: number; description: string }
  | { ok: false; reason: string }

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validTokenBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function computeStrictReservationUsdMicros(
  input: StrictReservationInput,
): StrictReservationResult {
  const { pricing } = input
  if (!pricing || pricing.currency !== 'USD')
    return { ok: false, reason: 'known USD pricing is required' }
  if (!validTokenBound(input.contextWindowTokens))
    return {
      ok: false,
      reason: 'a finite context-window input bound is required',
    }
  if (!validTokenBound(input.maxOutputTokens))
    return { ok: false, reason: 'an enforced output-token ceiling is required' }
  if (!validRate(pricing.inputPerMillionTokens))
    return { ok: false, reason: 'an input-token price is required' }
  if (input.maxOutputTokens > 0 && !validRate(pricing.outputPerMillionTokens))
    return { ok: false, reason: 'an output-token price is required' }
  if (
    pricing.cachedInputPerMillionTokens !== undefined &&
    !validRate(pricing.cachedInputPerMillionTokens)
  )
    return { ok: false, reason: 'cached-input pricing is invalid' }
  if (
    input.cacheWritesPossible &&
    !validRate(pricing.cacheWriteInputPerMillionTokens)
  )
    return { ok: false, reason: 'cache-write pricing is required' }

  const inputRate = Math.max(
    pricing.inputPerMillionTokens,
    pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens,
    pricing.cacheWriteInputPerMillionTokens ?? 0,
  )
  const outputRate = pricing.outputPerMillionTokens ?? 0
  const cents =
    (input.contextWindowTokens * inputRate +
      input.maxOutputTokens * outputRate) /
    10_000
  try {
    return {
      ok: true,
      reservationUsdMicros: centsToUsdMicros(cents),
      description: `${input.contextWindowTokens} input tokens × $${inputRate}/M + ${input.maxOutputTokens} output tokens × $${outputRate}/M`,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function requestAdmissionRecordPath(
  directory: string,
  authorityId: string,
): string {
  const name = createHash('sha256').update(authorityId).digest('hex')
  return path.join(directory, `${name}.json`)
}

function policyHash(policy: SpendingPolicy): string {
  return sha256(spendingPolicySchema.parse(policy))
}

function lockOwnerIsDead(raw: string): boolean {
  try {
    const owner = JSON.parse(raw) as { pid?: unknown }
    if (
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return false
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    return false
  }
}

function tryReclaimDeadLock(lockPath: string): boolean {
  let observed: string
  try {
    observed = fs.readFileSync(lockPath, 'utf8')
    if (!lockOwnerIsDead(observed)) return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  const displaced = `${lockPath}.reclaim-${process.pid}-${tempSequence++}`
  try {
    fs.renameSync(lockPath, displaced)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  try {
    const current = fs.readFileSync(displaced, 'utf8')
    if (current === observed && lockOwnerIsDead(current)) {
      fs.unlinkSync(displaced)
      return true
    }
    try {
      fs.renameSync(displaced, lockPath)
    } catch {
      // Do not delete an ownership record we could not restore safely.
    }
    return false
  } catch {
    return false
  }
}

function withRecordLock<T>(recordPath: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 })
  const lockPath = `${recordPath}.lock`
  const startedAt = new Date().getTime()
  const owner = `${JSON.stringify({
    pid: process.pid,
    token: `${process.pid}-${startedAt}-${tempSequence++}`,
  })}\n`

  while (true) {
    let fd: number | undefined
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, owner, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      break
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {}
        try {
          fs.unlinkSync(lockPath)
        } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const age = new Date().getTime() - fs.statSync(lockPath).mtimeMs
        if (age > LOCK_STALE_MS && tryReclaimDeadLock(lockPath)) continue
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (new Date().getTime() - startedAt >= LOCK_TIMEOUT_MS)
        throw new Error(
          `Timed out acquiring request admission lock '${lockPath}'.`,
        )
      Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS)
    }
  }

  try {
    return operation()
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath)
    } catch {
      // Missing or replaced lock is not ours to remove.
    }
  }
}

function readSnapshot(
  recordPath: string,
  expectedAuthorityId?: string,
): RequestAdmissionSnapshot | undefined {
  if (!fs.existsSync(recordPath)) return undefined
  const stat = fs.statSync(recordPath)
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES)
    throw new Error(`Request admission record is invalid: '${recordPath}'`)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Request admission record is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const result = snapshotSchema.safeParse(parsed)
  if (!result.success)
    throw new Error(
      `Request admission record is invalid: ${result.error.message}`,
    )
  if (result.data.policyHash !== policyHash(result.data.policy))
    throw new Error('Request admission record policy hash is invalid')
  if (
    expectedAuthorityId !== undefined &&
    result.data.authorityId !== expectedAuthorityId
  )
    throw new Error('Request admission record authority identity is invalid')
  const expectedCap =
    result.data.policy.mode === 'uncapped'
      ? undefined
      : capCentsToUsdMicros(result.data.policy.capCents)
  if (result.data.capUsdMicros !== expectedCap)
    throw new Error('Request admission record cap is inconsistent')

  const attemptIds = new Set<string>()
  for (const attempt of result.data.attempts) {
    if (attemptIds.has(attempt.attemptId))
      throw new Error('Request admission record has duplicate attempt IDs')
    attemptIds.add(attempt.attemptId)
    if (
      result.data.policy.mode === 'strict-capped' &&
      attempt.basis.kind !== 'strict-bound'
    )
      throw new Error('Strict admission record contains an estimated attempt')
    if (
      result.data.policy.mode === 'estimated-capped' &&
      (attempt.basis.kind !== 'estimated-reservation' ||
        attempt.basis.estimatorId !== result.data.policy.estimator.id)
    )
      throw new Error('Estimated admission record has inconsistent provenance')
    if (
      attempt.state === 'reserve-active' &&
      (attempt.incompleteReason !== undefined ||
        attempt.costUsdMicros !== undefined ||
        attempt.provenance !== undefined)
    )
      throw new Error('Active admission attempt contains terminal fields')
    if (
      attempt.state === 'held-inactive' &&
      (attempt.incompleteReason === undefined ||
        attempt.costUsdMicros !== undefined ||
        attempt.provenance !== undefined)
    )
      throw new Error('Held admission attempt is internally inconsistent')
    if (
      attempt.state === 'reconciled' &&
      (attempt.incompleteReason !== undefined ||
        attempt.costUsdMicros === undefined ||
        attempt.provenance === undefined)
    )
      throw new Error('Reconciled admission attempt is internally inconsistent')
  }
  const held = checkedSum(
    result.data.attempts
      .filter(
        (attempt) =>
          attempt.state === 'reserve-active' ||
          attempt.state === 'held-inactive',
      )
      .map((attempt) => attempt.reservationUsdMicros),
  )
  const reconciled = checkedSum(
    result.data.attempts
      .filter((attempt) => attempt.state === 'reconciled')
      .map((attempt) => attempt.costUsdMicros ?? 0),
  )
  const active = result.data.attempts.filter(
    (attempt) => attempt.state === 'reserve-active',
  ).length
  const exhausted =
    expectedCap !== undefined && checkedSum([held, reconciled]) >= expectedCap
  if (
    result.data.heldUsdMicros !== held ||
    result.data.reconciledUsdMicros !== reconciled ||
    result.data.activeAttempts !== active ||
    result.data.exhausted !== exhausted ||
    result.data.degraded !== (result.data.policy.mode === 'estimated-capped')
  )
    throw new Error('Request admission record aggregates are inconsistent')
  return result.data
}

function writeSnapshotAtomic(
  recordPath: string,
  snapshot: RequestAdmissionSnapshot,
): void {
  const parsed = snapshotSchema.parse(snapshot)
  const content = `${JSON.stringify(parsed, null, 2)}\n`
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES)
    throw new Error('Request admission record exceeds its storage bound')
  const tempPath = `${recordPath}.tmp-${process.pid}-${tempSequence++}`
  let fd: number | undefined
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tempPath, recordPath)
    try {
      const dirFd = fs.openSync(path.dirname(recordPath), 'r')
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // Atomic replacement succeeded; directory fsync is unavailable here.
    }
    try {
      fs.chmodSync(recordPath, 0o600)
    } catch {}
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath)
    } catch {}
    throw error
  }
}

function checkedSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error('Request admission fixed-point total overflowed')
  return total
}

function recalculate(
  snapshot: RequestAdmissionSnapshot,
  now: number,
): RequestAdmissionSnapshot {
  const heldUsdMicros = checkedSum(
    snapshot.attempts
      .filter(
        (attempt) =>
          attempt.state === 'reserve-active' ||
          attempt.state === 'held-inactive',
      )
      .map((attempt) => attempt.reservationUsdMicros),
  )
  const reconciledUsdMicros = checkedSum(
    snapshot.attempts
      .filter((attempt) => attempt.state === 'reconciled')
      .map((attempt) => attempt.costUsdMicros ?? 0),
  )
  const activeAttempts = snapshot.attempts.filter(
    (attempt) => attempt.state === 'reserve-active',
  ).length
  const total = checkedSum([heldUsdMicros, reconciledUsdMicros])
  return {
    ...snapshot,
    heldUsdMicros,
    reconciledUsdMicros,
    activeAttempts,
    exhausted:
      snapshot.capUsdMicros !== undefined && total >= snapshot.capUsdMicros,
    degraded: snapshot.policy.mode === 'estimated-capped',
    updatedAt: now,
  }
}

export function createRequestAdmissionStore(params: {
  directory: string
  clock?: { now(): number }
}): RequestAdmissionStore {
  const now = () => params.clock?.now() ?? new Date().getTime()
  const transact = <T>(
    authorityId: string,
    operation: (current: RequestAdmissionSnapshot | undefined) => {
      snapshot: RequestAdmissionSnapshot
      result: T
    },
  ): T => {
    const recordPath = requestAdmissionRecordPath(params.directory, authorityId)
    return withRecordLock(recordPath, () => {
      const next = operation(readSnapshot(recordPath, authorityId))
      writeSnapshotAtomic(recordPath, next.snapshot)
      return next.result
    })
  }
  const mutate = (
    authorityId: string,
    operation: (
      current: RequestAdmissionSnapshot | undefined,
    ) => RequestAdmissionSnapshot,
  ): RequestAdmissionSnapshot =>
    transact(authorityId, (current) => {
      const snapshot = operation(current)
      return { snapshot, result: snapshot }
    })
  const requirePolicy = (
    current: RequestAdmissionSnapshot,
    policy: SpendingPolicy,
  ) => {
    const expected = policyHash(policy)
    if (current.policyHash !== expected)
      throw new Error(
        'Request admission policy does not match the persisted authority',
      )
  }

  return {
    initialize({ authorityId, policy }) {
      const parsedPolicy = spendingPolicySchema.parse(policy)
      return mutate(authorityId, (current) => {
        if (current) {
          requirePolicy(current, parsedPolicy)
          return current
        }
        const timestamp = now()
        const capUsdMicros =
          parsedPolicy.mode === 'uncapped'
            ? undefined
            : capCentsToUsdMicros(parsedPolicy.capCents)
        return {
          schemaVersion: STORE_SCHEMA_VERSION,
          authorityId,
          policy: parsedPolicy,
          policyHash: policyHash(parsedPolicy),
          revision: 0,
          ...(capUsdMicros === undefined ? {} : { capUsdMicros }),
          heldUsdMicros: 0,
          reconciledUsdMicros: 0,
          activeAttempts: 0,
          exhausted: capUsdMicros === 0,
          degraded: parsedPolicy.mode === 'estimated-capped',
          attempts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      })
    },

    recover({ authorityId, policy }) {
      const parsedPolicy = spendingPolicySchema.parse(policy)
      return mutate(authorityId, (current) => {
        if (!current)
          throw new Error(
            'Request admission authority is unavailable on recovery',
          )
        requirePolicy(current, parsedPolicy)
        const timestamp = now()
        const attempts = current.attempts.map(
          (attempt): RequestAdmissionAttempt =>
            attempt.state === 'reserve-active'
              ? {
                  ...attempt,
                  state: 'held-inactive',
                  incompleteReason: 'process-restart',
                  updatedAt: timestamp,
                }
              : attempt,
        )
        if (
          attempts.every(
            (attempt, index) => attempt === current.attempts[index],
          )
        )
          return current
        return recalculate(
          { ...current, attempts, revision: current.revision + 1 },
          timestamp,
        )
      })
    },

    reserve(reservation): RequestReservationResult {
      if (
        !Number.isSafeInteger(reservation.reservationUsdMicros) ||
        reservation.reservationUsdMicros < 0
      )
        throw new Error(
          'Request reservation must be a non-negative safe integer',
        )
      return transact<RequestReservationResult>(
        reservation.authorityId,
        (current) => {
          if (!current)
            throw new Error('Request admission authority is unavailable')
          const timestamp = now()
          const total = checkedSum([
            current.heldUsdMicros,
            current.reconciledUsdMicros,
          ])
          if (
            current.capUsdMicros !== undefined &&
            (current.exhausted ||
              total + reservation.reservationUsdMicros > current.capUsdMicros)
          ) {
            const result: RequestReservationResult = {
              ok: false,
              code: 'spend_cap_exceeded',
              message: 'Request spending cap has no remaining reservation room',
              snapshot: current,
            }
            return { snapshot: current, result }
          }
          if (
            current.policy.mode === 'estimated-capped' &&
            current.activeAttempts >=
              current.policy.estimator.maxConcurrentAttempts
          ) {
            const result: RequestReservationResult = {
              ok: false,
              code: 'concurrency_limit',
              message: 'Estimated spending policy concurrency limit reached',
              snapshot: current,
            }
            return { snapshot: current, result }
          }
          if (current.attempts.length >= MAX_ATTEMPTS)
            throw new Error('Request admission attempt retention is exhausted')
          const attemptId = `${createHash('sha256')
            .update(current.authorityId)
            .digest('hex')
            .slice(
              0,
              16,
            )}-${current.revision + 1}-${current.attempts.length + 1}`
          const attempt: RequestAdmissionAttempt = {
            attemptId,
            runId: reservation.runId,
            provider: reservation.provider,
            model: reservation.model,
            reservationUsdMicros: reservation.reservationUsdMicros,
            basis: basisSchema.parse(
              reservation.basis,
            ) as RequestAdmissionBasis,
            state: 'reserve-active',
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          const snapshot = recalculate(
            {
              ...current,
              revision: current.revision + 1,
              attempts: [...current.attempts, attempt],
            },
            timestamp,
          )
          return {
            snapshot,
            result: {
              ok: true,
              attemptId,
              snapshot,
            } satisfies RequestReservationResult,
          }
        },
      )
    },

    markIncomplete({ authorityId, attemptId, reason }) {
      return mutate(authorityId, (current) => {
        if (!current)
          throw new Error('Request admission authority is unavailable')
        const index = current.attempts.findIndex(
          (attempt) => attempt.attemptId === attemptId,
        )
        if (index < 0)
          throw new Error('Request admission attempt is unavailable')
        const existing = current.attempts[index]
        if (
          existing.state === 'reconciled' ||
          existing.state === 'held-inactive'
        )
          return current
        const timestamp = now()
        const attempts = [...current.attempts]
        attempts[index] = {
          ...existing,
          state: 'held-inactive',
          incompleteReason: reason,
          updatedAt: timestamp,
        }
        return recalculate(
          { ...current, attempts, revision: current.revision + 1 },
          timestamp,
        )
      })
    },

    reconcile({ authorityId, attemptId, costUsdMicros, provenance }) {
      if (!Number.isSafeInteger(costUsdMicros) || costUsdMicros < 0)
        throw new Error(
          'Reconciled request cost must be a non-negative safe integer',
        )
      return mutate(authorityId, (current) => {
        if (!current)
          throw new Error('Request admission authority is unavailable')
        const index = current.attempts.findIndex(
          (attempt) => attempt.attemptId === attemptId,
        )
        if (index < 0)
          throw new Error('Request admission attempt is unavailable')
        const existing = current.attempts[index]
        if (existing.state === 'reconciled') {
          if (
            existing.costUsdMicros !== costUsdMicros ||
            existing.provenance !== provenance
          )
            throw new Error('Conflicting request admission reconciliation')
          return current
        }
        const timestamp = now()
        const attempts = [...current.attempts]
        const { incompleteReason: _incompleteReason, ...reconciledAttempt } =
          existing
        attempts[index] = {
          ...reconciledAttempt,
          state: 'reconciled',
          costUsdMicros,
          provenance: provenance as RequestCostProvenance,
          updatedAt: timestamp,
        }
        return recalculate(
          { ...current, attempts, revision: current.revision + 1 },
          timestamp,
        )
      })
    },

    snapshot(authorityId) {
      const recordPath = requestAdmissionRecordPath(
        params.directory,
        authorityId,
      )
      return withRecordLock(recordPath, () => {
        const snapshot = readSnapshot(recordPath, authorityId)
        if (!snapshot)
          throw new Error('Request admission authority is unavailable')
        return snapshot
      })
    },
  }
}
