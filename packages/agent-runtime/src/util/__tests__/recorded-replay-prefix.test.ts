import { describe, expect, test } from 'bun:test'

import {
  captureValueSha256,
  inspectReplayCapture,
  sealReplayCapture,
  verifyReplayWitness,
  type ReplayBasis,
  type ReplayCapture,
} from '../recorded-replay-prefix'

const basis: ReplayBasis = {
  runId: 'fixture-run',
  bundleSha256: '1'.repeat(64),
  runtimeSha256: '2'.repeat(64),
  contractSha256: '3'.repeat(64),
  configurationSha256: '4'.repeat(64),
  inputSha256: '5'.repeat(64),
}

function fixture(): ReplayCapture {
  const clock = { kind: 'host' as const, input: { call: 'clock' } }
  const tool = {
    kind: 'tool' as const,
    input: { tool: 'owned_fixture', label: 'A\r\n' },
  }
  return {
    version: 1,
    basis,
    entries: [
      {
        ordinal: 0,
        occurrence: 0,
        request: clock,
        completion: {
          kind: 'recorded',
          requestSha256: captureValueSha256(clock),
          result: 123,
        },
      },
      {
        ordinal: 1,
        occurrence: 0,
        request: tool,
        completion: {
          kind: 'recorded',
          requestSha256: captureValueSha256(tool),
          result: { observed: 1 },
        },
      },
      {
        ordinal: 2,
        occurrence: 1,
        request: tool,
        completion: {
          kind: 'recorded',
          requestSha256: captureValueSha256(tool),
          result: { observed: 2 },
        },
      },
    ],
    terminal: { output: { summary: 'recorded only' } },
  }
}

const witness = (capture: ReplayCapture) => ({
  requests: capture.entries.map((entry) => entry.request),
  terminal: capture.terminal,
})

describe('B15 sealed recorded replay prefix', () => {
  test('verifies the bound sequence and repeated occurrences without granting live authority', () => {
    const capture = fixture()
    const seal = sealReplayCapture(capture)
    expect(inspectReplayCapture(capture, basis, seal)).toMatchObject({
      status: 'eligible_observations',
      stop: 'terminal',
      pairs: [
        { ordinal: 0, occurrence: 0, result: 123 },
        { ordinal: 1, occurrence: 0, result: { observed: 1 } },
        { ordinal: 2, occurrence: 1, result: { observed: 2 } },
      ],
    })
    expect(verifyReplayWitness(capture, basis, seal, witness(capture))).toEqual(
      {
        status: 'verified',
        verifiedSteps: 3,
        liveReplayPermitted: false,
      },
    )
  })

  test.each([
    'bundleSha256',
    'runtimeSha256',
    'contractSha256',
    'configurationSha256',
    'inputSha256',
  ] as const)(
    'refuses a changed %s before exposing recorded replies',
    (field) => {
      const capture = fixture()
      const expected = { ...basis, [field]: 'a'.repeat(64) }
      expect(
        verifyReplayWitness(
          capture,
          expected,
          sealReplayCapture(capture),
          witness(capture),
        ),
      ).toEqual({
        status: 'unavailable',
        reason: 'basis_mismatch',
        verifiedSteps: 0,
        liveReplayPermitted: false,
      })
    },
  )

  test('a retained suffix or a changed completion cannot stand in for the trusted seal', () => {
    const capture = fixture()
    const seal = sealReplayCapture(capture)
    const suffix = { ...capture, entries: capture.entries.slice(1) }
    expect(inspectReplayCapture(suffix, basis, seal)).toEqual({
      status: 'invalid',
      reason: 'seal_mismatch',
    })
    capture.entries[1]!.completion = {
      kind: 'recorded',
      requestSha256: captureValueSha256(capture.entries[1]!.request),
      result: 'foreign',
    }
    expect(inspectReplayCapture(capture, basis, seal)).toEqual({
      status: 'invalid',
      reason: 'seal_mismatch',
    })
  })

  test.each(['missing', 'uncertain'] as const)(
    'stops at a recorded %s result without consuming the frontier',
    (kind) => {
      const capture = fixture()
      capture.entries = capture.entries.slice(0, 2)
      delete capture.terminal
      delete capture.entries[1]!.completion
      if (kind === 'uncertain') {
        capture.entries[1]!.completion = {
          kind: 'uncertain',
          requestSha256: captureValueSha256(capture.entries[1]!.request),
        }
      }
      const seal = sealReplayCapture(capture)
      expect(inspectReplayCapture(capture, basis, seal)).toMatchObject({
        status: 'eligible_observations',
        stop: kind === 'missing' ? 'missing_result' : 'uncertain_effect',
        pairs: [{ result: 123 }],
      })
      expect(
        verifyReplayWitness(capture, basis, seal, {
          requests: [capture.entries[0]!.request],
        }),
      ).toMatchObject({
        status: 'unavailable',
        reason: kind === 'missing' ? 'missing_result' : 'uncertain_effect',
        verifiedSteps: 1,
        liveReplayPermitted: false,
      })
    },
  )

  test('an authenticated but malformed journal shape cannot pair the wrong occurrence or request', () => {
    const first = fixture()
    first.entries[2]!.occurrence = 0
    expect(
      inspectReplayCapture(first, basis, sealReplayCapture(first)),
    ).toEqual({ status: 'invalid', reason: 'invalid_trace' })
    const second = fixture()
    second.entries[1]!.completion!.requestSha256 = captureValueSha256(
      second.entries[0]!.request,
    )
    expect(
      inspectReplayCapture(second, basis, sealReplayCapture(second)),
    ).toEqual({ status: 'invalid', reason: 'invalid_trace' })
  })

  test('the independently reconstructed yield order and terminal result must match', () => {
    const capture = fixture()
    const seal = sealReplayCapture(capture)
    const replayed = witness(capture)
    replayed.requests[1] = { kind: 'STEP', input: null }
    expect(verifyReplayWitness(capture, basis, seal, replayed)).toEqual({
      status: 'unavailable',
      reason: 'yield_diverged',
      verifiedSteps: 1,
      liveReplayPermitted: false,
    })
    expect(
      verifyReplayWitness(capture, basis, seal, {
        ...witness(capture),
        terminal: { output: 'different' },
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'terminal_diverged',
      verifiedSteps: 3,
      liveReplayPermitted: false,
    })
    const longer = witness(capture)
    longer.requests.push({ kind: 'tool', input: { tool: 'another_effect' } })
    expect(verifyReplayWitness(capture, basis, seal, longer)).toMatchObject({
      status: 'unavailable',
      reason: 'unexpected_yield',
      verifiedSteps: 3,
      liveReplayPermitted: false,
    })
  })

  test('canonicalizes plain data without invoking getters or silently replacing non-JSON input', () => {
    let getterCalls = 0
    const accessor = {
      get secret() {
        getterCalls++
        return 'unsafe'
      },
    }
    expect(() => captureValueSha256(accessor)).toThrow()
    expect(getterCalls).toBe(0)
    expect(() => captureValueSha256({ absent: undefined })).toThrow()
    expect(() => captureValueSha256([NaN])).toThrow()
    expect(captureValueSha256({ b: 'B\r\n', a: 1 })).toBe(
      captureValueSha256({ a: 1, b: 'B\r\n' }),
    )
    expect(captureValueSha256('B\r\n')).not.toBe(captureValueSha256('B\n'))
  })
})
