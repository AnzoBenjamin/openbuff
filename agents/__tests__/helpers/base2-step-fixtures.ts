/**
 * Shared step-feed fixtures for base2 `handleSteps` generator tests. Mirrors
 * the role of extract-inline-function-source.ts: the mirror sites
 * (base2-writer-spawn-rules and the reviewer-spawn-conditions e2e) import
 * these payloads instead of re-declaring near-identical copies.
 */

/** Wrap `value` as a JSON tool-result feed for a base2 step generator. */
export function feedJson(value: unknown) {
  return { toolResult: [{ type: 'json', value }] } as any
}

/**
 * Canonical file_mutation_result receipt (the real production edit-artifact
 * shape) for `path`. Feed this instead of a bare `{ file }` so the edited
 * file lands in the live changedFiles set and the mid-turn git-status sweep
 * absorbs the path into pending gate files.
 */
export function editReceipt(path: string) {
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId: `op-${path}`,
    receiptId: `receipt-${path}`,
    outcome: 'applied',
    authorityTier: 'conditional_commit',
    actions: [
      {
        actionId: `action-${path}`,
        index: 0,
        action: 'update',
        path,
        outcome: 'applied',
        beforeHash: 'before',
        afterHash: 'after',
      },
    ],
    authorityReceipt: {
      operationId: `op-${path}`,
      receiptId: `receipt-${path}`,
      actions: [{ actionId: `action-${path}` }],
    },
    errors: [],
    freshCapabilities: [],
  }
}
