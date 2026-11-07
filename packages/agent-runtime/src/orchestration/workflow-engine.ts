/**
 * ADVISORY / TELEMETRY-ONLY workflow state machine.
 *
 * This module is NOT the authoritative orchestration gate. The controlling
 * turn lifecycle (validation hooks, aux gates, and the code-reviewer
 * finalization verdict) lives in `createBase2`'s serialized `handleSteps`
 * generator in `agents/base2/base2.ts`. `transitionWorkflow` and the
 * `WorkflowStateV1` records it produces are bookkeeping/telemetry: they record
 * declarative subflow state (persisted on `AgentState.workflowStates`) for
 * resumability and observability, but they do not decide whether a turn may
 * finalize. Do not reroute the base2 gate through this engine or treat its
 * state as a completion authority; keep it as advisory metadata unless a future
 * change deliberately promotes it (which would require moving the gate
 * decision here and updating the base2 handleSteps contract).
 */
export type WorkflowTransitionV1 = {
  event: string
  from: string[]
  to: string
}

export type WorkflowDefinitionV1 = {
  schemaVersion: 1
  id: string
  initialState: string
  terminalStates: string[]
  transitions: WorkflowTransitionV1[]
}

export type WorkflowStateV1 = {
  schemaVersion: 1
  workflowId: string
  state: string
  revision: number
  updatedAt: number
  lastEvent?: string
}

export function transitionWorkflow(params: {
  definition: WorkflowDefinitionV1
  current?: WorkflowStateV1
  event: string
  expectedRevision?: number
  /**
   * Optional injected wall clock (ms epoch) used for every `updatedAt` stamp
   * this call produces. NOTE(P2-T1): the `Date.now()` fallback keeps callers
   * that predate clock injection (the base2 control plane) byte-identical.
   */
  now?: number
}): WorkflowStateV1 {
  const now = params.now ?? Date.now()
  const current = params.current ?? {
    schemaVersion: 1 as const,
    workflowId: params.definition.id,
    state: params.definition.initialState,
    revision: 0,
    updatedAt: now,
  }
  if (current.workflowId !== params.definition.id) {
    throw new Error(
      `Workflow state ${current.workflowId} cannot be used with ${params.definition.id}.`,
    )
  }
  if (
    params.expectedRevision !== undefined &&
    params.expectedRevision !== current.revision
  ) {
    throw new Error(
      `Workflow revision conflict: expected ${params.expectedRevision}, current ${current.revision}.`,
    )
  }
  const transition = params.definition.transitions.find(
    (candidate) =>
      candidate.event === params.event &&
      candidate.from.includes(current.state),
  )
  if (!transition) {
    throw new Error(
      `Illegal ${params.definition.id} transition: ${current.state} --${params.event}--> ?.`,
    )
  }
  return {
    schemaVersion: 1,
    workflowId: params.definition.id,
    state: transition.to,
    revision: current.revision + 1,
    updatedAt: now,
    lastEvent: params.event,
  }
}

export const base2GateWorkflowV1: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  id: 'base2-gate-v1',
  initialState: 'idle',
  terminalStates: ['final_response_allowed'],
  transitions: [
    {
      event: 'awaiting_validation',
      from: [
        'idle',
        'blocked',
        'repair_loop',
        'awaiting_review',
        'final_response_allowed',
      ],
      to: 'awaiting_validation',
    },
    {
      event: 'awaiting_review',
      from: ['idle', 'awaiting_validation', 'repair_loop', 'blocked'],
      to: 'awaiting_review',
    },
    {
      event: 'repair_loop',
      from: ['awaiting_validation', 'awaiting_review', 'blocked'],
      to: 'repair_loop',
    },
    {
      event: 'blocked',
      from: [
        'idle',
        'awaiting_validation',
        'awaiting_review',
        'repair_loop',
        'blocked',
      ],
      to: 'blocked',
    },
    {
      event: 'final_response_allowed',
      from: ['idle', 'awaiting_validation', 'awaiting_review', 'blocked'],
      to: 'final_response_allowed',
    },
  ],
}

export function transitionBase2Gate(params: {
  current?: WorkflowStateV1
  phase: string
  now?: number
}): WorkflowStateV1 {
  return transitionWorkflow({
    definition: base2GateWorkflowV1,
    current: params.current,
    event: params.phase,
    now: params.now,
  })
}

/**
 * Structured outcome of `transitionBase2GateSafe`: either the advanced
 * advisory state, or a never-throw rejection report carrying the rejected
 * `from` state and `event` so callers can log/telemetry the rejection without
 * a throwing control-plane member suppressing their own telemetry.
 */
export type TransitionBase2GateOutcome =
  | { ok: true; state: WorkflowStateV1 }
  | { ok: false; error: string; from: string; event: string }

/**
 * Never-throw wrapper around `transitionBase2Gate`. Returns a structured
 * `{ ok }` outcome instead of raising: an illegal transition (or any other
 * transition rejection, e.g. a revision conflict) is reported as
 * `{ ok: false, error, from, event }`, while a legal transition returns
 * `{ ok: true, state }`. This stays ADVISORY/telemetry-only — it does not
 * promote the workflow engine to a gate authority; base2 wiring rides a
 * later slice.
 */
export function transitionBase2GateSafe(params: {
  current?: WorkflowStateV1
  phase: string
  now?: number
}): TransitionBase2GateOutcome {
  const from = params.current?.state ?? base2GateWorkflowV1.initialState
  try {
    return { ok: true, state: transitionBase2Gate(params) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      from,
      event: params.phase,
    }
  }
}

/**
 * Render a workflow definition as a deterministic mermaid
 * `stateDiagram-v2` graph for visualization. Pure function: no clock,
 * locale, or ambient state participates, so the same definition always
 * yields byte-identical output. Each (from, event) edge is emitted on its
 * own line as `from --> to : event` — mermaid's stateDiagram-v2 syntax
 * accepts a single source state per transition line, so a definition whose
 * `from` array lists several states simply produces one line per source.
 * Terminal states are marked with the conventional `state --> [*]` edge.
 */
export function workflowStatechartMermaid(
  definition: WorkflowDefinitionV1,
): string {
  const lines: string[] = ['stateDiagram-v2']
  lines.push(`[*] --> ${definition.initialState}`)
  for (const state of definition.terminalStates) {
    lines.push(`${state} --> [*]`)
  }
  for (const transition of definition.transitions) {
    for (const from of transition.from) {
      lines.push(`${from} --> ${transition.to} : ${transition.event}`)
    }
  }
  return lines.join('\n')
}
