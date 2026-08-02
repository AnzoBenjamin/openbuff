/**
 * Pure gate snapshot fingerprint helpers extracted from `base2.ts`.
 *
 * NOTE: an equivalent inline copy of `hashGateSnapshotDetails` still exists
 * inside `createBase2`'s `handleSteps` generator because that function is
 * serialized via `handleSteps.toString()` and reconstructed with
 * `new Function(...)`. Reconstructed functions lose their module closure, so
 * they cannot reference imports from this file; the inline copy lazily
 * delegates to this module at call time when a CommonJS loader can resolve
 * it, and otherwise falls back to the inline implementation. Keep the two
 * implementations in sync.
 */

// Canonical SHA-256 snapshot fingerprint: v3: followed by exactly 64
// lowercase hex chars. Only these are reusable as durable attestation.
export function isAttestableSnapshotFingerprint(value: string): boolean {
  return /^v3:[a-f0-9]{64}$/.test(value)
}

export function hashGateSnapshotDetails(details: string): string {
  const getBuiltinModule =
    typeof process === 'object' &&
    process !== null &&
    'getBuiltinModule' in process &&
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : undefined
  const req = (globalThis as any).require as NodeJS.Require | undefined
  let crypto: typeof import('node:crypto') | undefined
  if (getBuiltinModule) {
    crypto = getBuiltinModule('node:crypto') as typeof import('node:crypto')
  } else if (typeof req === 'function') {
    crypto = req('node:crypto')
  }
  if (crypto) {
    return `v3:${crypto.createHash('sha256').update(details).digest('hex')}`
  }
  // Fail closed: without a collision-resistant hash the snapshot cannot
  // be safely attested. Return a non-reusable sentinel so no durable
  // gate credit, review receipt, or bypass challenge can match it.
  return 'unreadable:no-crypto'
}
