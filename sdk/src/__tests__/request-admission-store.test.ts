import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  USD_MICROS_PER_CENT,
  capCentsToUsdMicros,
  centsToUsdMicros,
  computeStrictReservationUsdMicros,
  createRequestAdmissionStore,
  requestAdmissionRecordPath,
} from '../services/request-admission-store'

import type { SpendingPolicy } from '@codebuff/common/types/request-admission'

const strictPolicy: SpendingPolicy = {
  mode: 'strict-capped',
  capCents: 1,
  currency: 'USD',
}

const estimatedPolicy: SpendingPolicy = {
  mode: 'estimated-capped',
  capCents: 1,
  currency: 'USD',
  estimator: {
    id: 'fixture-fixed-v1',
    reservationCents: 0.4,
    maxConcurrentAttempts: 1,
  },
}

describe('B09 durable request admission store', () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-request-admission-'),
    )
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test('atomically shares held and reconciled spend across store instances', () => {
    const first = createRequestAdmissionStore({ directory })
    const second = createRequestAdmissionStore({ directory })
    first.initialize({ authorityId: 'shared', policy: strictPolicy })

    const admitted = first.reserve({
      authorityId: 'shared',
      runId: 'root',
      provider: 'fixture',
      model: 'model-a',
      reservationUsdMicros: centsToUsdMicros(0.6),
      basis: { kind: 'strict-bound', description: 'fixture bound' },
    })
    expect(admitted.ok).toBe(true)

    const refused = second.reserve({
      authorityId: 'shared',
      runId: 'child',
      provider: 'fixture',
      model: 'model-b',
      reservationUsdMicros: centsToUsdMicros(0.5),
      basis: { kind: 'strict-bound', description: 'sibling bound' },
    })
    expect(refused).toMatchObject({
      ok: false,
      code: 'spend_cap_exceeded',
      snapshot: {
        heldUsdMicros: centsToUsdMicros(0.6),
        reconciledUsdMicros: 0,
      },
    })

    if (!admitted.ok) throw new Error('Expected first reservation')
    const reconciled = second.reconcile({
      authorityId: 'shared',
      attemptId: admitted.attemptId,
      costUsdMicros: centsToUsdMicros(0.2),
      provenance: 'usage-plus-configured-pricing',
    })
    expect(reconciled).toMatchObject({
      heldUsdMicros: 0,
      reconciledUsdMicros: centsToUsdMicros(0.2),
    })

    expect(
      first.reserve({
        authorityId: 'shared',
        runId: 'child-2',
        provider: 'fixture',
        model: 'model-c',
        reservationUsdMicros: centsToUsdMicros(0.8),
        basis: { kind: 'strict-bound', description: 'remaining cap' },
      }).ok,
    ).toBe(true)
  })

  test('fresh process preserves the active reservation for conservative recovery', () => {
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, '../services/request-admission-store.ts'),
    ).href
    const script = `
      import { createRequestAdmissionStore, centsToUsdMicros } from ${JSON.stringify(moduleUrl)};
      const store = createRequestAdmissionStore({ directory: ${JSON.stringify(directory)} });
      const policy = { mode: 'strict-capped', capCents: 1, currency: 'USD' };
      store.initialize({ authorityId: 'fresh-process', policy });
      const result = store.reserve({ authorityId: 'fresh-process', runId: 'child-process', provider: 'fixture', model: 'model', reservationUsdMicros: centsToUsdMicros(0.7), basis: { kind: 'strict-bound', description: 'child process reservation' } });
      if (!result.ok) throw new Error(result.message);
    `
    const child = Bun.spawnSync({
      cmd: [process.execPath, '--no-env-file', '--no-install', '-e', script],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)

    const reopened = createRequestAdmissionStore({ directory })
    expect(
      reopened.recover({
        authorityId: 'fresh-process',
        policy: strictPolicy,
      }),
    ).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.7),
      activeAttempts: 0,
    })
    expect(
      reopened.reserve({
        authorityId: 'fresh-process',
        runId: 'parent-process',
        provider: 'fixture',
        model: 'model',
        reservationUsdMicros: centsToUsdMicros(0.4),
        basis: { kind: 'strict-bound', description: 'must remain blocked' },
      }),
    ).toMatchObject({ ok: false, code: 'spend_cap_exceeded' })
  })

  test('restart recovery converts active reservations to held uncertainty and never refunds them', () => {
    const before = createRequestAdmissionStore({ directory })
    before.initialize({ authorityId: 'restart', policy: strictPolicy })
    const active = before.reserve({
      authorityId: 'restart',
      runId: 'root',
      provider: 'fixture',
      model: 'model',
      reservationUsdMicros: centsToUsdMicros(0.7),
      basis: { kind: 'strict-bound', description: 'pre-crash' },
    })
    expect(active.ok).toBe(true)

    const after = createRequestAdmissionStore({ directory })
    const recovered = after.recover({
      authorityId: 'restart',
      policy: strictPolicy,
    })
    expect(recovered).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.7),
      activeAttempts: 0,
    })
    expect(recovered.attempts[0]).toMatchObject({
      state: 'held-inactive',
      incompleteReason: 'process-restart',
    })
    expect(
      after.reserve({
        authorityId: 'restart',
        runId: 'root-restarted',
        provider: 'fixture',
        model: 'model',
        reservationUsdMicros: centsToUsdMicros(0.4),
        basis: { kind: 'strict-bound', description: 'post-crash' },
      }),
    ).toMatchObject({ ok: false, code: 'spend_cap_exceeded' })
  })

  test('missing usage stays held while overshoot is retained and blocks later admission', () => {
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'overshoot', policy: strictPolicy })
    const held = store.reserve({
      authorityId: 'overshoot',
      runId: 'root',
      provider: 'fixture',
      model: 'model',
      reservationUsdMicros: centsToUsdMicros(0.4),
      basis: { kind: 'strict-bound', description: 'unknown-result' },
    })
    if (!held.ok) throw new Error('Expected held reservation')
    expect(
      store.markIncomplete({
        authorityId: 'overshoot',
        attemptId: held.attemptId,
        reason: 'missing-usage',
      }),
    ).toMatchObject({ heldUsdMicros: centsToUsdMicros(0.4) })

    const second = store.reserve({
      authorityId: 'overshoot',
      runId: 'root',
      provider: 'fixture',
      model: 'model',
      reservationUsdMicros: centsToUsdMicros(0.5),
      basis: { kind: 'strict-bound', description: 'overshoot-control' },
    })
    if (!second.ok) throw new Error('Expected second reservation')
    const overshot = store.reconcile({
      authorityId: 'overshoot',
      attemptId: second.attemptId,
      costUsdMicros: centsToUsdMicros(0.7),
      provenance: 'provider-reported',
    })
    expect(overshot).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.4),
      reconciledUsdMicros: centsToUsdMicros(0.7),
      exhausted: true,
    })
    expect(
      store.reserve({
        authorityId: 'overshoot',
        runId: 'root',
        provider: 'fixture',
        model: 'model',
        reservationUsdMicros: 0,
        basis: { kind: 'strict-bound', description: 'zero-after-overshoot' },
      }),
    ).toMatchObject({ ok: false, code: 'spend_cap_exceeded' })
  })

  test('estimated mode records degraded provenance and enforces active concurrency', () => {
    const store = createRequestAdmissionStore({ directory })
    const initialized = store.initialize({
      authorityId: 'estimated',
      policy: estimatedPolicy,
    })
    expect(initialized).toMatchObject({ degraded: true })

    const first = store.reserve({
      authorityId: 'estimated',
      runId: 'root',
      provider: 'unknown',
      model: 'unknown',
      reservationUsdMicros: centsToUsdMicros(0.4),
      basis: {
        kind: 'estimated-reservation',
        estimatorId: 'fixture-fixed-v1',
        description: 'explicit degraded estimate',
      },
    })
    expect(first.ok).toBe(true)
    expect(
      store.reserve({
        authorityId: 'estimated',
        runId: 'child',
        provider: 'unknown',
        model: 'unknown',
        reservationUsdMicros: centsToUsdMicros(0.4),
        basis: {
          kind: 'estimated-reservation',
          estimatorId: 'fixture-fixed-v1',
          description: 'concurrent sibling',
        },
      }),
    ).toMatchObject({ ok: false, code: 'concurrency_limit' })
  })

  test('schema-valid aggregate or authority tampering fails closed', () => {
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'tamper', policy: strictPolicy })
    const reservation = store.reserve({
      authorityId: 'tamper',
      runId: 'root',
      provider: 'fixture',
      model: 'model',
      reservationUsdMicros: centsToUsdMicros(0.6),
      basis: { kind: 'strict-bound', description: 'tamper control' },
    })
    expect(reservation.ok).toBe(true)
    const recordPath = requestAdmissionRecordPath(directory, 'tamper')
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<
      string,
      unknown
    >
    record.heldUsdMicros = 0
    fs.writeFileSync(recordPath, JSON.stringify(record))
    expect(() => store.snapshot('tamper')).toThrow(/aggregates/i)

    record.heldUsdMicros = centsToUsdMicros(0.6)
    record.authorityId = 'foreign-authority'
    fs.writeFileSync(recordPath, JSON.stringify(record))
    expect(() => store.snapshot('tamper')).toThrow(/authority/i)
  })

  test('corrupt or policy-mismatched persisted authority fails closed', () => {
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'corrupt', policy: strictPolicy })
    fs.writeFileSync(
      requestAdmissionRecordPath(directory, 'corrupt'),
      '{ invalid json',
    )
    expect(() => store.snapshot('corrupt')).toThrow(/corrupt|invalid/i)

    const other = createRequestAdmissionStore({ directory })
    expect(() =>
      other.initialize({
        authorityId: 'policy',
        policy: strictPolicy,
      }),
    ).not.toThrow()
    expect(() =>
      other.initialize({
        authorityId: 'policy',
        policy: { ...strictPolicy, capCents: 2 },
      }),
    ).toThrow(/policy/i)
  })
})

describe('B09 strict reservation bounds', () => {
  test('uses fixed-point precision and the worst enabled input bucket', () => {
    expect(centsToUsdMicros(0.0018)).toBe(1_800)
    expect(USD_MICROS_PER_CENT).toBe(1_000_000)
    const largeCents = 4_503_599_627.370496
    expect(centsToUsdMicros(largeCents)).toBe(
      Math.ceil(largeCents * USD_MICROS_PER_CENT),
    )
    expect(capCentsToUsdMicros(0.0000019)).toBe(1)
    expect(
      computeStrictReservationUsdMicros({
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          cachedInputPerMillionTokens: 0.3,
          cacheWriteInputPerMillionTokens: 3.75,
          currency: 'USD',
        },
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        cacheWritesPossible: true,
      }),
    ).toEqual({
      ok: true,
      reservationUsdMicros: centsToUsdMicros(0.525),
      description: '1000 input tokens × $3.75/M + 100 output tokens × $15/M',
    })
  })

  test('strict mode refuses unknown currency, pricing, bounds, and cache-write rate', () => {
    const base = {
      pricing: {
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        currency: 'USD',
      },
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
      cacheWritesPossible: false,
    } as const
    for (const candidate of [
      { ...base, pricing: { ...base.pricing, currency: undefined } },
      { ...base, pricing: undefined },
      { ...base, contextWindowTokens: undefined },
      { ...base, maxOutputTokens: undefined },
      { ...base, cacheWritesPossible: true },
    ]) {
      expect(computeStrictReservationUsdMicros(candidate)).toMatchObject({
        ok: false,
      })
    }
  })
})
