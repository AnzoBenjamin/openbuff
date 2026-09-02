import {
  parsePlanTasks,
  preflightPlan,
} from '@codebuff/common/util/plan-artifacts'

import type {
  PlanSessionState,
  PlanTaskStatus,
} from '@codebuff/common/util/plan-artifacts'

type PlanTransitionUpdate = {
  taskId?: string
  task?: string
  status?: PlanTaskStatus
  completed?: boolean
}

type PlanCheckpoint = {
  taskId: string
  phase: 'validation' | 'review'
  passed: boolean
  receiptIds?: string[]
}

export type PlanTransitionValidation = {
  ok: boolean
  errors: string[]
  claimedTaskId?: string
  completedTaskIds: string[]
}

export function validatePlanTransition(params: {
  originalContent: string
  nextContent: string
  updates: PlanTransitionUpdate[]
  unmatchedTasks: string[]
  currentTask?: string | null
  existingState: PlanSessionState | null
  checkpoint?: PlanCheckpoint
  /**
   * Gate-issued per-task validation receipts read from base2 gate state.
   * `undefined` means the caller has no gate-issued evidence to check against
   * (non-base2 agent, or a base2 run with the validation gate disabled), and
   * the legacy "any non-empty receiptIds" rule applies unchanged. A PRESENT
   * array — including an empty one — means verification is active.
   */
  gateIssuedReceipts?: Array<{ receiptId: string; taskId: string }>
}): PlanTransitionValidation {
  const errors: string[] = []
  const original = preflightPlan(params.originalContent)
  const next = preflightPlan(params.nextContent)
  if (!original.ok) {
    errors.push(...original.errors.map((error) => `PLAN preflight: ${error}`))
  }
  if (!next.ok) {
    errors.push(...next.errors.map((error) => `PLAN transition: ${error}`))
  }
  if (params.unmatchedTasks.length > 0) {
    errors.push(
      `PLAN transition is atomic; no task matched: ${params.unmatchedTasks.join(', ')}.`,
    )
  }
  const originalById = new Map(
    parsePlanTasks(params.originalContent).map((task) => [task.id, task]),
  )
  const nextTasks = parsePlanTasks(params.nextContent)
  const nextById = new Map(nextTasks.map((task) => [task.id, task]))
  const inProgress = nextTasks.filter((task) => task.status === 'in_progress')
  if (inProgress.length > 1) {
    errors.push(
      `Only one PLAN task may be in progress; found ${inProgress.map((task) => task.id).join(', ')}.`,
    )
  }
  const completedTaskIds: string[] = []
  let claimedTaskId: string | undefined
  for (const task of nextTasks) {
    const before = originalById.get(task.id)
    if (task.status === 'in_progress' && before?.status !== 'in_progress') {
      claimedTaskId = task.id
      const incompleteDependencies = task.dependencies.filter((dependency) => {
        const dependencyTask = nextById.get(dependency)
        return (
          dependencyTask?.status !== 'done' &&
          dependencyTask?.status !== 'cancelled'
        )
      })
      if (incompleteDependencies.length > 0) {
        errors.push(
          `Task ${task.id} cannot be claimed until dependencies complete: ${incompleteDependencies.join(', ')}.`,
        )
      }
    }
    if (task.status === 'done' && before?.status !== 'done') {
      completedTaskIds.push(task.id)
      const incompleteDependencies = task.dependencies.filter((dependency) => {
        const dependencyTask = nextById.get(dependency)
        return (
          dependencyTask?.status !== 'done' &&
          dependencyTask?.status !== 'cancelled'
        )
      })
      if (incompleteDependencies.length > 0) {
        errors.push(
          `Task ${task.id} cannot be completed until dependencies complete: ${incompleteDependencies.join(', ')}.`,
        )
      }
      const checkpoint =
        params.checkpoint?.taskId === task.id
          ? params.checkpoint
          : params.existingState?.checkpoint?.taskId === task.id
            ? params.existingState.checkpoint
            : undefined
      if (!checkpoint?.passed || checkpoint.phase !== 'validation') {
        errors.push(
          `Task ${task.id} cannot move to done without a passed validation checkpoint for that task.`,
        )
      }
      if (
        checkpoint?.passed &&
        (!checkpoint.receiptIds || checkpoint.receiptIds.length === 0)
      ) {
        errors.push(
          `Task ${task.id} validation checkpoint must reference at least one receipt ID.`,
        )
      }
      // Real evidence check: the cited receipt must be one the
      // validation/reviewer gate itself issued for THIS task. Receipt IDs are
      // otherwise entirely model-supplied, so an invented string satisfies the
      // non-empty rule above without any gate ever having passed. A PRESENT
      // gateIssuedReceipts array — including an EMPTY one — turns verification
      // on and must reject (gate active, no evidence yet); an ABSENT one leaves
      // the legacy rule untouched for callers with no gate-issued evidence.
      if (params.gateIssuedReceipts) {
        const citedReceiptIds = checkpoint?.receiptIds ?? []
        const citesGateIssuedReceipt = citedReceiptIds.some((receiptId) =>
          params.gateIssuedReceipts?.some(
            (issued) =>
              issued.taskId === task.id && issued.receiptId === receiptId,
          ),
        )
        if (!citesGateIssuedReceipt) {
          // Receipts are superseded when the work they cover changes, so the
          // rejection has to be actionable NOW: name the IDs that are live for
          // this task (bounded so a long ledger cannot flood the message), or
          // say that none is and why.
          const liveReceiptIdsForTask = params.gateIssuedReceipts
            .filter((issued) => issued.taskId === task.id)
            .map((issued) => issued.receiptId)
          const liveReceiptGuidance =
            liveReceiptIdsForTask.length > 0
              ? `Live gate-issued receipt IDs for ${task.id}: ${liveReceiptIdsForTask.slice(0, 4).join(', ')}.`
              : `No gate-issued receipt is live for ${task.id}; let the validation/reviewer gate close for that task's changes first (a receipt is superseded when its files change again).`
          errors.push(
            `Task ${task.id} validation checkpoint must cite a gate-issued receipt ID from a passed validation/reviewer gate for that task; invented receipt IDs are rejected. ${liveReceiptGuidance}`,
          )
        }
      }
    }
  }
  const requestedCurrentTask = params.currentTask?.trim() || null
  if (requestedCurrentTask) {
    const task = nextTasks.find(
      (candidate) =>
        requestedCurrentTask === candidate.id ||
        requestedCurrentTask.startsWith(`${candidate.id} `) ||
        requestedCurrentTask.startsWith(`${candidate.id}:`) ||
        requestedCurrentTask.startsWith(`${candidate.id} —`),
    )
    if (!task || task.status !== 'in_progress') {
      errors.push(
        `currentTask must reference the sole in-progress task; got ${requestedCurrentTask}.`,
      )
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    ...(claimedTaskId ? { claimedTaskId } : {}),
    completedTaskIds,
  }
}
