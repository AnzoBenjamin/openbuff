import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

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

function strictRequest(authorityId: string, runId: string, cents: number) {
  return {
    authorityId,
    runId,
    provider: 'fixture',
    model: 'model',
    reservationUsdMicros: centsToUsdMicros(cents),
    basis: { kind: 'strict-bound' as const, description: 'fixture bound' },
  }
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

  function runInFreshStoreProcess(body: string): string {
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, '../services/request-admission-store.ts'),
    ).href
    const script = `
      import { createRequestAdmissionStore, centsToUsdMicros } from ${JSON.stringify(moduleUrl)};
      const store = createRequestAdmissionStore({ directory: ${JSON.stringify(directory)} });
      const policy = ${JSON.stringify(strictPolicy)};
      ${body}
    `
    const child = Bun.spawnSync({
      cmd: [process.execPath, '--no-env-file', '--no-install', '-e', script],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return child.stdout.toString()
  }

  test('fresh process preserves the active reservation for conservative recovery', () => {
    runInFreshStoreProcess(`
      store.initialize({ authorityId: 'fresh-process', policy });
      const result = store.reserve({ authorityId: 'fresh-process', runId: 'child-process', provider: 'fixture', model: 'model', reservationUsdMicros: centsToUsdMicros(0.7), basis: { kind: 'strict-bound', description: 'child process reservation' } });
      if (!result.ok) throw new Error(result.message);
    `)

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

  test.each([strictPolicy, estimatedPolicy])(
    '$mode blocks new admission after a per-attempt overage even below the cap, including after restart',
    (policy) => {
      const authorityId = 'under-cap-overshoot'
      const store = createRequestAdmissionStore({ directory })
      store.initialize({ authorityId, policy })
      const request = (cents: number) => ({
        authorityId,
        runId: 'fixture',
        provider: 'fixture',
        model: 'fixture',
        reservationUsdMicros: centsToUsdMicros(cents),
        basis:
          policy.mode === 'estimated-capped'
            ? {
                kind: 'estimated-reservation' as const,
                estimatorId: policy.estimator.id,
                description: 'observed budget',
              }
            : { kind: 'strict-bound' as const, description: 'observed budget' },
      })
      const reservedCents =
        policy.mode === 'estimated-capped'
          ? policy.estimator.reservationCents
          : 0.4
      const admitted = store.reserve(request(reservedCents))
      if (!admitted.ok) throw new Error('Expected the first reservation')
      const costUsdMicros = centsToUsdMicros(0.5)
      expect(costUsdMicros + centsToUsdMicros(reservedCents)).toBeLessThan(
        centsToUsdMicros(policy.capCents),
      )
      const settled = store.reconcile({
        authorityId,
        attemptId: admitted.attemptId,
        costUsdMicros,
        provenance: 'provider-reported',
      })
      expect(settled).toMatchObject({
        heldUsdMicros: 0,
        reconciledUsdMicros: costUsdMicros,
        capUsdMicros: centsToUsdMicros(1),
        exhausted: true,
        degraded: policy.mode === 'estimated-capped',
        attempts: [
          {
            attemptId: admitted.attemptId,
            state: 'reconciled',
            reservationUsdMicros: centsToUsdMicros(reservedCents),
            costUsdMicros,
            provenance: 'provider-reported',
          },
        ],
      })
      expect(store.reserve(request(reservedCents))).toMatchObject({
        ok: false,
        code: 'spend_cap_exceeded',
        message: expect.stringContaining('exceeded its reservation'),
      })
      const restarted = createRequestAdmissionStore({ directory })
      expect(restarted.recover({ authorityId, policy })).toEqual(settled)
      expect(restarted.reserve(request(reservedCents))).toMatchObject({
        ok: false,
        code: 'spend_cap_exceeded',
        message: expect.stringContaining('exceeded its reservation'),
      })
    },
  )

  test('late overshoot stops new children without discarding an admitted sibling or netting its underspend', () => {
    const authorityId = 'late-overrun'
    const first = createRequestAdmissionStore({ directory })
    const second = createRequestAdmissionStore({ directory })
    first.initialize({ authorityId, policy: strictPolicy })
    const a = first.reserve(strictRequest(authorityId, 'child-a', 0.2))
    const b = second.reserve(strictRequest(authorityId, 'child-b', 0.6))
    if (!a.ok || !b.ok) throw new Error('Expected both children to reserve')
    expect(
      first.markIncomplete({
        authorityId,
        attemptId: a.attemptId,
        reason: 'missing-usage',
      }),
    ).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.8),
      activeAttempts: 1,
      exhausted: false,
    })

    expect(
      first.reconcile({
        authorityId,
        attemptId: a.attemptId,
        costUsdMicros: centsToUsdMicros(0.25),
        provenance: 'usage-plus-configured-pricing',
      }),
    ).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.6),
      reconciledUsdMicros: centsToUsdMicros(0.25),
      activeAttempts: 1,
      exhausted: true,
    })
    expect(
      second.reserve(strictRequest(authorityId, 'child-c', 0.1)),
    ).toMatchObject({
      ok: false,
      code: 'spend_cap_exceeded',
    })
    expect(
      second.reconcile({
        authorityId,
        attemptId: b.attemptId,
        costUsdMicros: centsToUsdMicros(0.05),
        provenance: 'provider-reported',
      }),
    ).toMatchObject({
      heldUsdMicros: 0,
      reconciledUsdMicros: centsToUsdMicros(0.3),
      activeAttempts: 0,
      exhausted: true,
    })
    expect(
      first.reserve(strictRequest(authorityId, 'child-d', 0.1)),
    ).toMatchObject({
      ok: false,
      code: 'spend_cap_exceeded',
    })
  })

  test('uncapped receipts retain an overrun without blocking later attempts', () => {
    const authorityId = 'uncapped'
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId, policy: { mode: 'uncapped' } })
    const first = store.reserve(strictRequest(authorityId, 'first', 0.2))
    if (!first.ok) throw new Error('Expected an uncapped reservation')
    expect(
      store.reconcile({
        authorityId,
        attemptId: first.attemptId,
        costUsdMicros: centsToUsdMicros(0.3),
        provenance: 'provider-reported',
      }),
    ).toMatchObject({
      reconciledUsdMicros: centsToUsdMicros(0.3),
      exhausted: false,
    })
    expect(store.reserve(strictRequest(authorityId, 'second', 0.9)).ok).toBe(
      true,
    )
  })

  test.each([
    'record-only',
    'total-write-failure',
    'read-before-reconcile',
    'lock-before-reconcile',
  ] as const)(
    'an observed overrun stops capped admission when persistence fails (%s)',
    (fault) => {
      const authorityId = `overrun-${fault}`
      const store = createRequestAdmissionStore({ directory })
      store.initialize({ authorityId, policy: strictPolicy })
      const first = store.reserve(strictRequest(authorityId, 'first', 0.2))
      const sibling = store.reserve(
        strictRequest(authorityId, 'already-admitted', 0.2),
      )
      if (!first.ok || !sibling.ok)
        throw new Error('Expected two initial reservations')
      const recordPath = requestAdmissionRecordPath(directory, authorityId)
      const rename = fs.renameSync.bind(fs)
      const open = fs.openSync.bind(fs)
      const read = fs.readFileSync.bind(fs)
      const readFault = spyOn(fs, 'readFileSync').mockImplementation(((
        file: fs.PathOrFileDescriptor,
        options?: Parameters<typeof fs.readFileSync>[1],
      ) => {
        if (fault === 'read-before-reconcile' && file === recordPath)
          throw new Error('injected record read failure')
        return read(file, options)
      }) as typeof fs.readFileSync)
      const renameFault = spyOn(fs, 'renameSync').mockImplementation(
        (from, to) => {
          if (to === recordPath)
            throw new Error('injected receipt rename failure')
          return rename(from, to)
        },
      )
      const markerFault = spyOn(fs, 'openSync').mockImplementation(
        (file, flags, mode) => {
          if (
            fault === 'lock-before-reconcile' &&
            file === `${recordPath}.lock`
          )
            throw new Error('injected record lock failure')
          if (
            fault === 'total-write-failure' &&
            file === `${recordPath}.reconciliation-required`
          )
            throw new Error('injected marker open failure')
          return open(file, flags, mode)
        },
      )
      try {
        expect(() =>
          store.reconcile({
            authorityId,
            attemptId: first.attemptId,
            costUsdMicros: centsToUsdMicros(0.3),
            provenance: 'provider-reported',
          }),
        ).toThrow(/injected|durable refusal persistence failed/)
      } finally {
        readFault.mockRestore()
        markerFault.mockRestore()
        renameFault.mockRestore()
      }
      const reopened = createRequestAdmissionStore({ directory })
      expect(
        reopened.reserve(strictRequest(authorityId, 'must-not-dispatch', 0.1)),
      ).toMatchObject({
        ok: false,
        code: 'spend_cap_exceeded',
        snapshot: {
          exhausted: true,
          heldUsdMicros: 400_000,
          reconciledUsdMicros: 0,
        },
      })
      reopened.reconcile({
        authorityId,
        attemptId: sibling.attemptId,
        costUsdMicros: centsToUsdMicros(0.1),
        provenance: 'provider-reported',
      })
      expect(reopened.snapshot(authorityId)).toMatchObject({
        exhausted: true,
        heldUsdMicros: 200_000,
        reconciledUsdMicros: 100_000,
      })
      if (fault !== 'total-write-failure') {
        const result = runInFreshStoreProcess(`
          store.recover({ authorityId: ${JSON.stringify(authorityId)}, policy });
          console.log(JSON.stringify(store.reserve(${JSON.stringify(strictRequest(authorityId, 'fresh', 0.1))})));
        `)
        expect(JSON.parse(result)).toMatchObject({
          ok: false,
          code: 'spend_cap_exceeded',
          snapshot: { exhausted: true },
        })
      }
    },
  )

  test('migrates a valid v1 authority with an under-cap overrun without losing receipts', () => {
    const authorityId = 'legacy-overshoot'
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId, policy: strictPolicy })
    const first = store.reserve(strictRequest(authorityId, 'first', 0.2))
    if (!first.ok) throw new Error('Expected the first reservation')
    const settled = store.reconcile({
      authorityId,
      attemptId: first.attemptId,
      costUsdMicros: centsToUsdMicros(0.3),
      provenance: 'provider-reported',
    })
    const recordPath = requestAdmissionRecordPath(directory, authorityId)
    // Version 1 exhausted only when total held plus settled spend reached the cap.
    const legacy = JSON.stringify({
      ...settled,
      schemaVersion: 1,
      exhausted: false,
    })
    fs.writeFileSync(recordPath, legacy)

    const reopened = createRequestAdmissionStore({ directory })
    expect(reopened.snapshot(authorityId)).toEqual({
      ...settled,
      schemaVersion: 1,
      exhausted: true,
    })
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(legacy)
    expect(
      reopened.reserve(strictRequest(authorityId, 'next', 0.1)),
    ).toMatchObject({
      ok: false,
      code: 'spend_cap_exceeded',
      message: expect.stringContaining('exceeded its reservation'),
    })
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual({
      ...settled,
      schemaVersion: 2,
      exhausted: true,
    })
    const afterRestart = runInFreshStoreProcess(`
      store.recover({ authorityId: ${JSON.stringify(authorityId)}, policy });
      console.log(JSON.stringify(store.reserve(${JSON.stringify(strictRequest(authorityId, 'fresh-reader', 0.1))})));
    `)
    expect(JSON.parse(afterRestart)).toMatchObject({
      ok: false,
      code: 'spend_cap_exceeded',
      snapshot: settled,
    })
  })

  test('migrating an ordinary v1 authority preserves held spend and allows a fitting attempt', () => {
    const authorityId = 'legacy-active'
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId, policy: strictPolicy })
    const active = store.reserve(
      strictRequest(authorityId, 'before-restart', 0.4),
    )
    if (!active.ok) throw new Error('Expected the first reservation')
    const recordPath = requestAdmissionRecordPath(directory, authorityId)
    fs.writeFileSync(
      recordPath,
      JSON.stringify({ ...active.snapshot, schemaVersion: 1 }),
    )

    const reopened = createRequestAdmissionStore({ directory })
    const recovered = reopened.recover({ authorityId, policy: strictPolicy })
    expect(recovered).toMatchObject({
      schemaVersion: 1,
      exhausted: false,
      heldUsdMicros: centsToUsdMicros(0.4),
      activeAttempts: 0,
      attempts: [
        {
          attemptId: active.attemptId,
          state: 'held-inactive',
          incompleteReason: 'process-restart',
        },
      ],
    })
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual({
      ...recovered,
      schemaVersion: 2,
    })
    expect(
      reopened.reserve(strictRequest(authorityId, 'after-restart', 0.5)).ok,
    ).toBe(true)
  })

  test.each([
    {
      label: 'cleared v2 exhaustion',
      schemaVersion: 2,
      exhausted: false,
      error: /aggregates/i,
    },
    {
      label: 'inconsistent v1 exhaustion',
      schemaVersion: 1,
      exhausted: true,
      error: /aggregates/i,
    },
    {
      label: 'unknown record version',
      schemaVersion: 99,
      exhausted: true,
      error: /invalid/i,
    },
  ])(
    '$label fails closed without replacing the record',
    ({ schemaVersion, exhausted, error }) => {
      const authorityId = 'invalid-versioned-record'
      const store = createRequestAdmissionStore({ directory })
      store.initialize({ authorityId, policy: strictPolicy })
      const admitted = store.reserve(strictRequest(authorityId, 'first', 0.2))
      if (!admitted.ok) throw new Error('Expected the first reservation')
      const settled = store.reconcile({
        authorityId,
        attemptId: admitted.attemptId,
        costUsdMicros: centsToUsdMicros(0.3),
        provenance: 'provider-reported',
      })
      const recordPath = requestAdmissionRecordPath(directory, authorityId)
      const invalid = JSON.stringify({ ...settled, schemaVersion, exhausted })
      fs.writeFileSync(recordPath, invalid)

      expect(() =>
        store.reserve(strictRequest(authorityId, 'next', 0.1)),
      ).toThrow(error)
      expect(() =>
        store.recover({ authorityId, policy: strictPolicy }),
      ).toThrow(error)
      expect(fs.readFileSync(recordPath, 'utf8')).toBe(invalid)
    },
  )

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
