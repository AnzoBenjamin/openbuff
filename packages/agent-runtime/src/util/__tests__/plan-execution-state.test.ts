import { describe, expect, test } from 'bun:test'

import { validatePlanTransition } from '../plan-execution-state'

function plan(
  tasks: Array<{
    id: string
    status: 'pending' | 'in_progress' | 'done' | 'cancelled'
    dependencies?: string[]
  }>,
): string {
  const mark = { pending: ' ', in_progress: '~', done: 'x', cancelled: '/' }
  return tasks
    .flatMap((task) => [
      `- [${mark[task.status]}] ${task.id} Task ${task.id}`,
      ...(task.dependencies?.length
        ? [`  - Depends on: ${task.dependencies.join(', ')}`]
        : []),
      '  - Acceptance: observable result',
      '  - Validate: bun test',
    ])
    .join('\n')
}

describe('validatePlanTransition', () => {
  test('rejects multiple in-progress tasks atomically', () => {
    const originalContent = plan([
      { id: 'P1.1', status: 'pending' },
      { id: 'P1.2', status: 'pending' },
    ])
    const nextContent = plan([
      { id: 'P1.1', status: 'in_progress' },
      { id: 'P1.2', status: 'in_progress' },
    ])

    const result = validatePlanTransition({
      originalContent,
      nextContent,
      updates: [
        { taskId: 'P1.1', status: 'in_progress' },
        { taskId: 'P1.2', status: 'in_progress' },
      ],
      unmatchedTasks: [],
      existingState: null,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('Only one PLAN task')
  })

  test('rejects claiming or completing a task before its dependencies', () => {
    const originalContent = plan([
      { id: 'P1.1', status: 'pending' },
      { id: 'P1.2', status: 'pending', dependencies: ['P1.1'] },
    ])
    const claimed = validatePlanTransition({
      originalContent,
      nextContent: plan([
        { id: 'P1.1', status: 'pending' },
        { id: 'P1.2', status: 'in_progress', dependencies: ['P1.1'] },
      ]),
      updates: [{ taskId: 'P1.2', status: 'in_progress' }],
      unmatchedTasks: [],
      existingState: null,
    })
    const completed = validatePlanTransition({
      originalContent,
      nextContent: plan([
        { id: 'P1.1', status: 'pending' },
        { id: 'P1.2', status: 'done', dependencies: ['P1.1'] },
      ]),
      updates: [{ taskId: 'P1.2', status: 'done' }],
      unmatchedTasks: [],
      existingState: null,
      checkpoint: {
        taskId: 'P1.2',
        phase: 'validation',
        passed: true,
        receiptIds: ['validation-1'],
      },
    })

    expect(claimed.errors.join(' ')).toContain('dependencies complete')
    expect(completed.errors.join(' ')).toContain('dependencies complete')
  })

  test('requires validation receipts before moving a task to done', () => {
    const originalContent = plan([{ id: 'P1.1', status: 'in_progress' }])
    const nextContent = plan([{ id: 'P1.1', status: 'done' }])
    const withoutReceipt = validatePlanTransition({
      originalContent,
      nextContent,
      updates: [{ taskId: 'P1.1', status: 'done' }],
      unmatchedTasks: [],
      existingState: {
        schemaVersion: 2,
        slug: 'test',
        status: 'validating',
        currentTask: 'P1.1',
        revision: 1,
        checkpoint: {
          taskId: 'P1.1',
          phase: 'validation',
          passed: true,
          recordedAt: new Date(0).toISOString(),
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    })
    const withReceipt = validatePlanTransition({
      originalContent,
      nextContent,
      updates: [{ taskId: 'P1.1', status: 'done' }],
      unmatchedTasks: [],
      existingState: null,
      checkpoint: {
        taskId: 'P1.1',
        phase: 'validation',
        passed: true,
        receiptIds: ['validation-1'],
      },
    })

    expect(withoutReceipt.errors.join(' ')).toContain('receipt ID')
    expect(withReceipt).toMatchObject({
      ok: true,
      completedTaskIds: ['P1.1'],
    })
  })

  test('rejects an unmatched update and an invalid current-task pointer', () => {
    const content = plan([{ id: 'P1.1', status: 'pending' }])
    const result = validatePlanTransition({
      originalContent: content,
      nextContent: content,
      updates: [{ taskId: 'P1.9', status: 'in_progress' }],
      unmatchedTasks: ['P1.9'],
      currentTask: 'P1.1',
      existingState: null,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('atomic')
    expect(result.errors.join(' ')).toContain('sole in-progress task')
  })

  // Receipt IDs on a checkpoint are model-supplied, so the non-empty rule above
  // is satisfied by an invented string. These cases pin the real-evidence rule:
  // a PRESENT gateIssuedReceipts array requires the checkpoint to cite an ID the
  // gate itself issued for THAT task, while an ABSENT array keeps the legacy
  // behavior for callers with no gate-issued evidence.
  describe('gate-issued receipt verification', () => {
    const originalContent = plan([{ id: 'P1.1', status: 'in_progress' }])
    const nextContent = plan([{ id: 'P1.1', status: 'done' }])
    const gateReceiptId = `plan-gate:P1.1:v3:${'a'.repeat(13)}`

    function completeWith(params: {
      receiptIds: string[]
      gateIssuedReceipts?: Array<{ receiptId: string; taskId: string }>
    }) {
      return validatePlanTransition({
        originalContent,
        nextContent,
        updates: [{ taskId: 'P1.1', status: 'done' }],
        unmatchedTasks: [],
        existingState: null,
        checkpoint: {
          taskId: 'P1.1',
          phase: 'validation',
          passed: true,
          receiptIds: params.receiptIds,
        },
        ...(params.gateIssuedReceipts
          ? { gateIssuedReceipts: params.gateIssuedReceipts }
          : {}),
      })
    }

    test('accepts a checkpoint citing a gate-issued receipt for that task', () => {
      const result = completeWith({
        receiptIds: [gateReceiptId],
        gateIssuedReceipts: [{ receiptId: gateReceiptId, taskId: 'P1.1' }],
      })

      expect(result).toMatchObject({ ok: true, completedTaskIds: ['P1.1'] })
    })

    test('rejects an invented receipt ID when gate-issued receipts exist', () => {
      const result = completeWith({
        receiptIds: ['validation-1'],
        gateIssuedReceipts: [{ receiptId: gateReceiptId, taskId: 'P1.1' }],
      })

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toContain(
        'must cite a gate-issued receipt ID',
      )
      expect(result.errors.join(' ')).toContain('P1.1')
    })

    // Receipts are superseded when the work they cover changes, so the rejection
    // has to name the IDs that are live for this task right now.
    test('lists the live gate-issued receipt IDs for the task it rejected', () => {
      const otherTaskReceiptId = `plan-gate:P9.9:v3:${'b'.repeat(13)}`
      const noDiffReceiptId = `plan-gate:P1.1:no-diff:v3:${'c'.repeat(13)}`
      const result = completeWith({
        receiptIds: ['validation-1'],
        gateIssuedReceipts: [
          { receiptId: gateReceiptId, taskId: 'P1.1' },
          { receiptId: noDiffReceiptId, taskId: 'P1.1' },
          // Another task's receipt must not be offered as a candidate.
          { receiptId: otherTaskReceiptId, taskId: 'P9.9' },
        ],
      })

      expect(result.ok).toBe(false)
      const message = result.errors.join(' ')
      expect(message).toContain(
        `Live gate-issued receipt IDs for P1.1: ${gateReceiptId}, ${noDiffReceiptId}.`,
      )
      expect(message).not.toContain(otherTaskReceiptId)
    })

    test('bounds the listed live receipt IDs to the first four', () => {
      const liveReceiptIds = Array.from(
        { length: 6 },
        (_entry, index) => `plan-gate:P1.1:v3:${String(index).repeat(13)}`,
      )
      const result = completeWith({
        receiptIds: ['validation-1'],
        gateIssuedReceipts: liveReceiptIds.map((receiptId) => ({
          receiptId,
          taskId: 'P1.1',
        })),
      })

      const message = result.errors.join(' ')
      expect(message).toContain(
        `Live gate-issued receipt IDs for P1.1: ${liveReceiptIds.slice(0, 4).join(', ')}.`,
      )
      expect(message).not.toContain(liveReceiptIds[4])
      expect(message).not.toContain(liveReceiptIds[5])
    })

    test('rejects a gate-issued receipt issued for a different task', () => {
      const otherTaskReceiptId = `plan-gate:P9.9:v3:${'b'.repeat(13)}`
      const result = completeWith({
        receiptIds: [otherTaskReceiptId],
        gateIssuedReceipts: [{ receiptId: otherTaskReceiptId, taskId: 'P9.9' }],
      })

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toContain(
        'must cite a gate-issued receipt ID',
      )
    })

    test('rejects when verification is active but no receipt has been issued yet', () => {
      // Present-but-empty is load-bearing: the gate is active and has issued no
      // evidence, so completion must fail closed rather than fall back.
      const result = completeWith({
        receiptIds: [gateReceiptId],
        gateIssuedReceipts: [],
      })

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toContain(
        'must cite a gate-issued receipt ID',
      )
      // Actionable: say the receipt is not live and what closes that gap, rather
      // than listing candidates that do not exist.
      expect(result.errors.join(' ')).toContain(
        "No gate-issued receipt is live for P1.1; let the validation/reviewer gate close for that task's changes first (a receipt is superseded when its files change again).",
      )
    })

    test('reports the no-live-receipt wording when only other tasks have receipts', () => {
      const result = completeWith({
        receiptIds: ['validation-1'],
        gateIssuedReceipts: [
          { receiptId: `plan-gate:P9.9:v3:${'b'.repeat(13)}`, taskId: 'P9.9' },
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toContain(
        'No gate-issued receipt is live for P1.1;',
      )
      expect(result.errors.join(' ')).not.toContain(
        'Live gate-issued receipt IDs for P1.1',
      )
    })

    test('omitting gateIssuedReceipts keeps the legacy any-non-empty rule', () => {
      const result = completeWith({ receiptIds: ['validation-1'] })

      expect(result).toMatchObject({ ok: true, completedTaskIds: ['P1.1'] })
    })
  })
})
