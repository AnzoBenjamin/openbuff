import { describe, expect, test } from 'bun:test'

import {
  base2GateWorkflowV1,
  transitionBase2Gate,
  transitionBase2GateSafe,
  transitionWorkflow,
  workflowStatechartMermaid,
} from '../workflow-engine'

describe('workflow engine', () => {
  test('applies a declared transition with compare-and-swap revision', () => {
    const next = transitionWorkflow({
      definition: base2GateWorkflowV1,
      event: 'awaiting_validation',
      expectedRevision: 0,
    })

    expect(next).toMatchObject({
      workflowId: 'base2-gate-v1',
      state: 'awaiting_validation',
      revision: 1,
      lastEvent: 'awaiting_validation',
    })
    expect(() =>
      transitionWorkflow({
        definition: base2GateWorkflowV1,
        current: next,
        event: 'awaiting_review',
        expectedRevision: 0,
      }),
    ).toThrow('revision conflict')
  })

  test('rejects illegal transitions and mismatched workflow state', () => {
    const reviewing = transitionBase2Gate({ phase: 'awaiting_review' })
    const repair = transitionBase2Gate({
      current: reviewing,
      phase: 'repair_loop',
    })
    expect(repair.state).toBe('repair_loop')
    expect(() =>
      transitionBase2Gate({ current: repair, phase: 'final_response_allowed' }),
    ).toThrow('Illegal base2-gate-v1 transition')
    expect(() =>
      transitionWorkflow({
        definition: base2GateWorkflowV1,
        current: { ...repair, workflowId: 'another-workflow' },
        event: 'blocked',
      }),
    ).toThrow('cannot be used with')
  })

  test('reopens validation after a previously allowed final response', () => {
    const allowed = transitionBase2Gate({ phase: 'final_response_allowed' })
    const reopened = transitionBase2Gate({
      current: allowed,
      phase: 'awaiting_validation',
    })

    expect(reopened).toMatchObject({
      state: 'awaiting_validation',
      revision: 2,
      lastEvent: 'awaiting_validation',
    })
  })

  test('uses the injected clock for updatedAt and stays deterministic', () => {
    const now = 1_700_000_000_000

    const fresh = transitionWorkflow({
      definition: base2GateWorkflowV1,
      event: 'awaiting_validation',
      now,
    })
    expect(fresh.updatedAt).toBe(now)

    const resumed = transitionWorkflow({
      definition: base2GateWorkflowV1,
      current: fresh,
      event: 'awaiting_review',
      now: now + 5_000,
    })
    expect(resumed.updatedAt).toBe(now + 5_000)

    // The same event sequence with a fixed clock produces identical states.
    const replay = [
      transitionWorkflow({
        definition: base2GateWorkflowV1,
        event: 'awaiting_validation',
        now,
      }),
    ]
    replay.push(
      transitionWorkflow({
        definition: base2GateWorkflowV1,
        current: replay[0],
        event: 'awaiting_review',
        now: now + 5_000,
      }),
    )
    expect(replay).toEqual([fresh, resumed])
  })

  test('renders a deterministic mermaid stateDiagram-v2 export', () => {
    const diagram = workflowStatechartMermaid(base2GateWorkflowV1)

    expect(diagram.startsWith('stateDiagram-v2')).toBe(true)
    expect(diagram).toContain('[*] --> idle')
    expect(diagram).toContain('final_response_allowed --> [*]')
    expect(diagram).toContain(
      'awaiting_validation --> awaiting_review : awaiting_review',
    )
    expect(diagram).toContain(
      'repair_loop --> blocked : blocked',
    )
    // repair_loop cannot take final_response_allowed per the transition table.
    expect(diagram).not.toContain(
      'repair_loop --> final_response_allowed',
    )
    // Pure function: the same definition yields byte-identical output.
    expect(workflowStatechartMermaid(base2GateWorkflowV1)).toBe(diagram)
  })

  test('transitionBase2GateSafe returns ok for legal transitions', () => {
    const outcome = transitionBase2GateSafe({
      phase: 'awaiting_validation',
      now: 1_700_000_000_000,
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.state).toMatchObject({
        workflowId: 'base2-gate-v1',
        state: 'awaiting_validation',
        revision: 1,
        updatedAt: 1_700_000_000_000,
      })
    }
  })

  test('transitionBase2GateSafe returns a structured error for illegal transitions', () => {
    const reviewing = transitionBase2Gate({ phase: 'awaiting_review' })
    const repair = transitionBase2Gate({
      current: reviewing,
      phase: 'repair_loop',
    })
    // Per the transition table, final_response_allowed is only legal from
    // idle/awaiting_validation/awaiting_review/blocked — not repair_loop.
    const outcome = transitionBase2GateSafe({
      current: repair,
      phase: 'final_response_allowed',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.from).toBe('repair_loop')
      expect(outcome.event).toBe('final_response_allowed')
      expect(outcome.error).toContain('Illegal base2-gate-v1 transition')
    }
  })
})
