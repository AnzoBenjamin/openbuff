const MAX_TRAVERSAL_DEPTH = 32

/**
 * Recursively searches an arbitrary value for a nested `structuralReceipt`
 * object whose `snapshot_id` matches `expectedSnapshotId`. When
 * `expectedSnapshotId` is empty/undefined, any structuralReceipt with a string
 * `snapshot_id` counts as a match. Depth-bounded (<=32) to stay conservative
 * on deeply nested inputs, with visited-object tracking for cyclic/shared graphs.
 * Shared by the general-agent handleSteps gate and the runtime
 * buildRuntimeAgentReceipt gate so the two do not drift.
 */
export function containsStructuralAuditReceipt(
  value: unknown,
  expectedSnapshotId?: string,
): boolean {
  let found = false
  const visited = new WeakSet<object>()
  const visit = (item: unknown, depth = 0): void => {
    if (
      found ||
      !item ||
      depth > MAX_TRAVERSAL_DEPTH ||
      typeof item !== 'object'
    ) {
      return
    }
    if (visited.has(item)) return
    visited.add(item)
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested, depth + 1)
      return
    }
    const record = item as Record<string, unknown>
    const receipt = record.structuralReceipt
    if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
      const snapshotId = (receipt as Record<string, unknown>).snapshot_id
      if (
        typeof snapshotId === 'string' &&
        (!expectedSnapshotId || snapshotId === expectedSnapshotId)
      ) {
        found = true
        return
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1)
  }
  visit(value)
  return found
}
