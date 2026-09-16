import { describe, expect, it } from 'bun:test'

import { updatePlanStatusParams } from './update-plan-status'

describe('updatePlanStatusParams', () => {
  it('accepts and normalizes an empty checkpoint receiptIds array', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      checkpoint: {
        taskId: 'P1-T1',
        phase: 'validation',
        passed: true,
        receiptIds: [],
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.checkpoint?.receiptIds).toBeUndefined()
  })

  it('rejects empty checkpoint receipt IDs', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      checkpoint: {
        taskId: 'P1-T1',
        phase: 'validation',
        passed: true,
        receiptIds: [''],
      },
    })

    expect(result.success).toBe(false)
  })

  it('decodes a stringified-JSON checkpoint object', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      checkpoint: JSON.stringify({
        taskId: 'LP-12',
        phase: 'validation',
        passed: true,
        summary: 'type-check exit 0, lint exit 0.',
        receiptIds: ['lKrt9ptZfQk', 'lKrt-Lw1-Ko'],
      }),
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.checkpoint?.taskId).toBe('LP-12')
    expect(result.data.checkpoint?.phase).toBe('validation')
    expect(result.data.checkpoint?.passed).toBe(true)
    expect(result.data.checkpoint?.receiptIds).toEqual([
      'lKrt9ptZfQk',
      'lKrt-Lw1-Ko',
    ])
  })

  it('decodes a stringified-JSON append object', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/STATUS.md',
      append: JSON.stringify({
        heading: 'Progress',
        body: 'Camera re-staged at 4 breakpoints.',
      }),
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.append?.heading).toBe('Progress')
    expect(result.data.append?.body).toBe('Camera re-staged at 4 breakpoints.')
  })

  it('accepts a checkpoint-only input (top-level refine)', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      checkpoint: {
        taskId: 'P1-T1',
        phase: 'review',
        passed: false,
        receiptIds: ['abc'],
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.checkpoint?.phase).toBe('review')
    expect(result.data.checkpoint?.passed).toBe(false)
  })

  it('rejects an input with no operation', () => {
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
    })

    expect(result.success).toBe(false)
  })

  it('accepts a standalone requestCommittedSurfaceReview opt-in', () => {
    // The flag is documented as a standalone operation, so the top-level
    // refine must accept { path, requestCommittedSurfaceReview: true } alone.
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      requestCommittedSurfaceReview: true,
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.requestCommittedSurfaceReview).toBe(true)
  })

  it('rejects a requestCommittedSurfaceReview value of false with no operation', () => {
    // Only `true` is the opt-in; `false` (or omitted) must keep the original
    // at-least-one-operation rule so a bare no-op call still fails.
    const result = updatePlanStatusParams.inputSchema.safeParse({
      path: '.agents/sessions/example/PLAN.md',
      requestCommittedSurfaceReview: false,
    })

    expect(result.success).toBe(false)
  })
})
