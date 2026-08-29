import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  hashGateSnapshotDetails,
  isAttestableSnapshotFingerprint,
} from '../base2/gate-fingerprint'

type GateFingerprintHelpers = {
  hashGateSnapshotDetails: (details: string) => string
  isAttestableSnapshotFingerprint: (value: string) => boolean
}

type GateFingerprintFunctionName = keyof GateFingerprintHelpers
type InlineHelperFactory = () => GateFingerprintHelpers

const INLINE_HELPER_NAMES: GateFingerprintFunctionName[] = [
  'hashGateSnapshotDetails',
  'isAttestableSnapshotFingerprint',
]

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  const bodyStart = source.indexOf('{', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      return source.slice(declarationStart, index + 1)
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

function loadInlineGateFingerprintHelpers(): GateFingerprintHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = INLINE_HELPER_NAMES.map((functionName) =>
    extractInlineFunctionSource(base2JavaScript, functionName),
  ).join('\n\n')
  const buildHelpers = new Function(
    `"use strict";\n${helperSource}\nreturn { hashGateSnapshotDetails, isAttestableSnapshotFingerprint }`,
  ) as InlineHelperFactory

  return buildHelpers()
}

describe('gate-fingerprint helpers — inline copies match canonical exports', () => {
  test('isAttestableSnapshotFingerprint parity across representative inputs', () => {
    const inlineHelpers = loadInlineGateFingerprintHelpers()

    const fingerprintInputs: string[] = [
      // valid canonical SHA-256 fingerprint
      `v3:${'a'.repeat(64)}`,
      `v3:${'0123456789abcdef'.repeat(4)}`,
      // invalid FNV / fail-closed sentinels
      'v3:fnv1a-12345678',
      'unreadable:no-crypto',
      // empty / wrong length
      '',
      `v3:${'a'.repeat(63)}`,
      `v3:${'a'.repeat(65)}`,
      // uppercase hex rejected (regex is lowercase-only)
      `v3:${'A'.repeat(64)}`,
      `v3:${'Ab'.repeat(32)}`,
    ]

    for (const input of fingerprintInputs) {
      expect(inlineHelpers.isAttestableSnapshotFingerprint(input)).toBe(
        isAttestableSnapshotFingerprint(input),
      )
    }
  })

  test('hashGateSnapshotDetails parity with crypto available', () => {
    const inlineHelpers = loadInlineGateFingerprintHelpers()

    const detailsInputs: string[] = [
      'test-details',
      'files-v4\nsrc/foo.ts\tsha256:deadbeef\n--\nHook typecheck passed.',
      '',
      'files-v4\n--\n',
    ]

    for (const details of detailsInputs) {
      const canonical = hashGateSnapshotDetails(details)
      const inline = inlineHelpers.hashGateSnapshotDetails(details)
      expect(inline).toBe(canonical)
      expect(isAttestableSnapshotFingerprint(canonical)).toBe(true)
      expect(inlineHelpers.isAttestableSnapshotFingerprint(inline)).toBe(true)
    }
  })

  test('hashGateSnapshotDetails fail-closed parity without crypto (no FNV fallback)', () => {
    const inlineHelpers = loadInlineGateFingerprintHelpers()

    const hadGetBuiltinModule = Object.prototype.hasOwnProperty.call(
      process,
      'getBuiltinModule',
    )
    const savedGetBuiltinModule = hadGetBuiltinModule
      ? (process as any).getBuiltinModule
      : undefined
    const hadRequire = Object.prototype.hasOwnProperty.call(
      globalThis,
      'require',
    )
    const savedRequire = hadRequire ? (globalThis as any).require : undefined
    try {
      delete (process as any).getBuiltinModule
      delete (globalThis as any).require

      const canonical = hashGateSnapshotDetails('test-details')
      const inline = inlineHelpers.hashGateSnapshotDetails('test-details')
      expect(canonical).toBe('unreadable:no-crypto')
      expect(inline).toBe('unreadable:no-crypto')
      expect(canonical).not.toMatch(/^v3:fnv1a-/)
      expect(inline).not.toMatch(/^v3:fnv1a-/)
      expect(isAttestableSnapshotFingerprint(canonical)).toBe(false)
      expect(inlineHelpers.isAttestableSnapshotFingerprint(inline)).toBe(false)
    } finally {
      if (hadGetBuiltinModule) {
        ;(process as any).getBuiltinModule = savedGetBuiltinModule
      } else {
        delete (process as any).getBuiltinModule
      }
      if (hadRequire) {
        ;(globalThis as any).require = savedRequire
      } else {
        delete (globalThis as any).require
      }
    }
  })
})
