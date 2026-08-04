/**
 * Pure gate snapshot fingerprint helpers extracted from `base2.ts`.
 *
 * NOTE: the inline copy is **generated** into the base2 `handleSteps`
 * `<gate-helpers-generated>` region via `scripts/generate-gate-helpers.ts`
 * (same as gate-paths/reviewer/repair/concurrency). `handleSteps` is serialized
 * via `toString()` / `new Function(...)` and loses module closure, so it cannot
 * import this file — edit this module and regenerate rather than hand-maintaining
 * the inline copy.
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
