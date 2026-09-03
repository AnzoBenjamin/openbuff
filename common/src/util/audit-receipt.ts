const MAX_TRAVERSAL_DEPTH = 32

/**
 * Recursively searches an arbitrary value for nested proof that an audit
 * shard's findings are durably persisted for `expectedSnapshotId`. Two markers
 * count, and both are held to the SAME snapshot binding:
 *  - `structuralReceipt` from a successful write_audit_findings call, and
 *  - `alreadyPersisted` from an already-exists write_audit_findings collision
 *    whose on-disk artifact is byte-identical to that call's rendered findings
 *    (that call wrote nothing, so it carries this marker in place of a
 *    synthesized `structuralReceipt`). The marker carries
 *    `snapshot_id` only when those identical persisted findings were rendered
 *    for that snapshot, so neither a stale artifact from a different snapshot
 *    nor a collision whose contents differ can clear a snapshot-bound gate. No
 *    other rejection satisfies the gate.
 * When `expectedSnapshotId` is empty/undefined, any marker with a string
 * `snapshot_id` counts as a match. Depth-bounded (<=32) to stay conservative
 * on deeply nested inputs, with min-depth revisit tracking for cyclic/shared
 * graphs: each object records the shallowest depth it was reached at, so a
 * later shorter path (which has more remaining depth budget) re-traverses,
 * while equal-or-deeper revisits (including cycles) are skipped.
 * Shared by the general-agent handleSteps gate and the runtime
 * buildRuntimeAgentReceipt gate so the two do not drift.
 */
export function containsStructuralAuditReceipt(
  value: unknown,
  expectedSnapshotId?: string,
): boolean {
  let found = false
  const visited = new WeakMap<object, number>()
  // A marker counts only when its own snapshot_id matches, so a colliding
  // write can never claim coverage for a snapshot it did not attest to.
  const bindsExpectedSnapshot = (marker: unknown): boolean => {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      return false
    }
    const snapshotId = (marker as Record<string, unknown>).snapshot_id
    return (
      typeof snapshotId === 'string' &&
      (!expectedSnapshotId || snapshotId === expectedSnapshotId)
    )
  }
  const visit = (item: unknown, depth = 0): void => {
    if (
      found ||
      !item ||
      depth > MAX_TRAVERSAL_DEPTH ||
      typeof item !== 'object'
    ) {
      return
    }
    const existing = visited.get(item)
    if (existing !== undefined && existing <= depth) return
    visited.set(item, depth)
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested, depth + 1)
      return
    }
    const record = item as Record<string, unknown>
    if (
      bindsExpectedSnapshot(record.structuralReceipt) ||
      bindsExpectedSnapshot(record.alreadyPersisted)
    ) {
      found = true
      return
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1)
  }
  visit(value)
  return found
}
