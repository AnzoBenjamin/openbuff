import { describe, expect, test } from 'bun:test'

import {
  recoverTruncatedJsonObject,
  setOutputParams,
} from '../params/tool/set-output'

describe('set_output input schema', () => {
  test('decodes a JSON object string inside data', () => {
    const parsed = setOutputParams.inputSchema.safeParse({
      data: '{"schemaVersion":1,"verdict":"NON_BLOCKING"}',
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.data).toEqual({
        schemaVersion: 1,
        verdict: 'NON_BLOCKING',
      })
    }
  })

  test.each([
    '```json\n{"schemaVersion":1,"verdict":"NON_BLOCKING"}\n```',
    '// json\n{"schemaVersion":1,"verdict":"NON_BLOCKING"}',
  ])('decodes a wrapped JSON object string inside data', (data) => {
    const parsed = setOutputParams.inputSchema.safeParse({ data })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.data).toEqual({
        schemaVersion: 1,
        verdict: 'NON_BLOCKING',
      })
    }
  })

  test('recovers complete top-level fields from a truncated mid-dimensions receipt', () => {
    const truncated =
      '{"schemaVersion":1,"verdict":"LOOKS_GOOD","snapshotFingerprint":"v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6","reviewedFiles":["sdk/src/tools/terminal-command-policy.ts","sdk/src/__tests__/terminal-command-policy.test.ts"],"findings":[],"coverage":"covered","dimensions":{"correctness":"Single-evaluator policy with layered guards that go on forever without closing'

    const recovered = recoverTruncatedJsonObject(truncated)
    expect(recovered).toMatchObject({
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint:
        'v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6',
      reviewedFiles: [
        'sdk/src/tools/terminal-command-policy.ts',
        'sdk/src/__tests__/terminal-command-policy.test.ts',
      ],
      findings: [],
      coverage: 'covered',
      requirementCoverage: [],
    })
    expect(recovered?.dimensions).toEqual({
      correctness: 'recovered-from-truncated-receipt',
      security: 'recovered-from-truncated-receipt',
      tests: 'recovered-from-truncated-receipt',
      apiCompatibility: 'recovered-from-truncated-receipt',
      performance: 'recovered-from-truncated-receipt',
    })

    const parsed = setOutputParams.inputSchema.safeParse({ data: truncated })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.data).toMatchObject({
        verdict: 'LOOKS_GOOD',
        snapshotFingerprint:
          'v3:fe7bd6bf6e902bfa33e6b76622a1d61ca548ac0716b44cb6e8620ab0aa9cdca6',
        reviewedFiles: [
          'sdk/src/tools/terminal-command-policy.ts',
          'sdk/src/__tests__/terminal-command-policy.test.ts',
        ],
      })
    }
  })

  test('does not inject reviewer dimension keys into non-reviewer recoveries', () => {
    // Same attestation-core fields as a review receipt, but with
    // non-reviewer verdict/coverage values: recovery still returns the
    // complete fields without synthesizing the reviewer-only
    // dimensions/requirementCoverage keys.
    const truncated =
      '{"schemaVersion":1,"verdict":"approved","snapshotFingerprint":"v3:abc","reviewedFiles":["src/a.ts"],"findings":[],"coverage":"full","notes":"a truncated essay that never clo'

    const recovered = recoverTruncatedJsonObject(truncated)

    expect(recovered).toEqual({
      schemaVersion: 1,
      verdict: 'approved',
      snapshotFingerprint: 'v3:abc',
      reviewedFiles: ['src/a.ts'],
      findings: [],
      coverage: 'full',
    })
  })

  test('does not invent structure for non-recoverable incomplete JSON', () => {
    expect(recoverTruncatedJsonObject('{"verdict":"LOOKS_GOOD"')).toEqual({
      verdict: 'LOOKS_GOOD',
    })
    expect(recoverTruncatedJsonObject('{')).toBeUndefined()
    expect(recoverTruncatedJsonObject('not json at all')).toBeUndefined()
    expect(recoverTruncatedJsonObject('{"foo":1')).toBeUndefined()
  })

  test.each(['not json', '[]', 'null', '"text"'])(
    'rejects a data string that is not a JSON object: %s',
    (data) => {
      const parsed = setOutputParams.inputSchema.safeParse({ data })

      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({ path: ['data'] }),
        )
      }
    },
  )
})
