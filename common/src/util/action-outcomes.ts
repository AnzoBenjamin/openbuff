import { createHash } from 'node:crypto'

import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
  nativeToolResultErrorV1Schema,
  readFilesResultV1Schema,
} from '../tools/results/filesystem'
import type { ActionOutcome } from '../types/run-outcome'
import type { JSONValue } from '../types/json'
import { jsonToolResult } from './messages'

type ActionResult = Pick<ActionOutcome, 'outcome' | 'cause' | 'effect'>

const unobservedEffect: ActionOutcome['effect'] = {
  status: 'unobserved',
  receiptIds: [],
  confirmedPaths: [],
}

/** Hash the captured input without retaining a second copy of its contents. */
export function hashActionInput(toolName: string, input: unknown): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, member]) => [key, sortKeys(member)]),
      )
    }
    return value
  }
  // The constructor sanitizes arbitrary values (including cycles) at runtime.
  const value = jsonToolResult({ toolName, input: input as JSONValue })[0].value
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex')}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function failed(
  code: string,
  message: string,
  outcome: ActionOutcome['outcome'] = 'failed',
): ActionResult {
  return {
    outcome,
    cause: { code, message: message.slice(0, 4_000) },
    effect: unobservedEffect,
  }
}

/** Interpret declared result fields; opaque output text never confirms an effect. */
export function classifyActionOutput(
  toolName: string,
  output: readonly unknown[],
): ActionResult {
  const values = output.flatMap((part) => {
    const item = record(part)
    return item?.type === 'json' ? [item.value] : []
  })
  const records = values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(record)
    .filter((value): value is Record<string, unknown> => value !== undefined)

  const results = records
    .map((value): ActionResult | undefined => {
      if (value.kind === 'file_mutation_result') {
        const parsed = fileMutationResultV1Schema.safeParse(value)
        if (!parsed.success)
          return failed(
            'malformed_mutation_result',
            'Mutation authority could not be verified.',
            'uncertain',
          )
        const mutation = parsed.data
        const confirmed = getConfirmedAppliedActionsV1(mutation)
        const fullyConfirmed =
          mutation.outcome === 'applied' &&
          confirmed.length > 0 &&
          confirmed.length === mutation.actions.length
        const forward = mutation.actions.flatMap((action) =>
          action.forward
            ? [{ actionId: action.actionId, ...action.forward }]
            : [],
        )
        const uncertainForward = forward.some(
          (item) => item.outcome === 'unconfirmed',
        )
        const observedForward = forward.some(
          (item) =>
            item.outcome === 'applied' ||
            (item.outcome === 'unconfirmed' &&
              Object.keys(item.afterHashes).length > 0),
        )
        const effect: ActionOutcome['effect'] = {
          status: fullyConfirmed
            ? 'confirmed'
            : confirmed.length > 0 || observedForward
              ? 'partial'
              : 'unobserved',
          receiptIds: mutation.receiptId ? [mutation.receiptId] : [],
          confirmedPaths: [
            ...new Set(
              confirmed.flatMap((action) => [
                action.path,
                ...(action.destinationPath ? [action.destinationPath] : []),
              ]),
            ),
          ],
          ...(forward.length > 0 ? { forward } : {}),
        }
        if (fullyConfirmed) return { outcome: 'succeeded', effect }
        const cause =
          mutation.errors[0] ??
          mutation.actions.find((action) => action.error)?.error
        const outcome =
          mutation.outcome === 'applied' ||
          uncertainForward ||
          mutation.outcome === 'unconfirmed' ||
          mutation.outcome === 'rollback_incomplete'
            ? 'uncertain'
            : mutation.outcome === 'not_applied'
              ? 'refused'
              : 'failed'
        return {
          outcome,
          cause: {
            code: cause?.code ?? `mutation_${mutation.outcome}`,
            message: (cause?.message ?? `Mutation ${mutation.outcome}.`).slice(
              0,
              4_000,
            ),
          },
          effect,
        }
      }
      if (value.kind === 'native_tool_result_error') {
        const parsed = nativeToolResultErrorV1Schema.safeParse(value)
        if (!parsed.success)
          return failed(
            'malformed_tool_error',
            'The tool returned an invalid error result.',
          )
        return failed(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.lifecycle.state === 'cancelled' ? 'cancelled' : 'failed',
        )
      }
      if (value.kind === 'read_files_result') {
        const parsed = readFilesResultV1Schema.safeParse(value)
        if (!parsed.success)
          return failed(
            'malformed_read_result',
            'The tool returned an invalid read result.',
          )
        if (parsed.data.summary.failed > 0) {
          const error = parsed.data.results.find(
            (item) => item.status === 'error',
          )
          if (error?.status === 'error')
            return failed(error.error.code, error.error.message)
        }
      }
      if (typeof value.errorMessage === 'string') {
        return failed(
          value.permissionDenied === true
            ? 'permission_denied'
            : value.timedOut === true
              ? 'tool_timeout'
              : 'tool_error',
          value.errorMessage,
          value.permissionDenied === true ? 'refused' : 'failed',
        )
      }
      if (value.isError === true)
        return failed('tool_error', 'The tool reported an error result.')
      if (typeof value.exitCode === 'number' && value.exitCode !== 0)
        return failed(
          'nonzero_exit',
          `Command exited with code ${value.exitCode}.`,
        )
      if (
        typeof value.validationStatus === 'string' &&
        value.validationStatus.startsWith('diagnostic_delta_') &&
        value.validationStatus !== 'diagnostic_delta_passed'
      ) {
        const status = value.validationStatus.slice('diagnostic_delta_'.length)
        return failed(
          `diagnostic_${status}`,
          `Diagnostic observation ${status}.`,
          status === 'cancelled'
            ? 'cancelled'
            : status === 'unknown' ||
                status === 'incomplete' ||
                status === 'unavailable'
              ? 'uncertain'
              : 'failed',
        )
      }
      if (toolName === 'spawn_agents') {
        const receipt = record(value.agentReceipt)
        const run = record(receipt?.runOutcome)
        if (run && run.termination !== 'completed')
          return failed(
            'child_run_failed',
            `Child run ${String(run.termination)}.`,
            run.termination === 'cancelled' ? 'cancelled' : 'failed',
          )
        if (receipt?.status === 'failed' || receipt?.status === 'cancelled')
          return failed(
            'child_run_failed',
            `Child run ${receipt.status}.`,
            receipt.status === 'cancelled' ? 'cancelled' : 'failed',
          )
      }
      if (
        value.status === 'failed' ||
        value.status === 'error' ||
        value.status === 'rejected'
      )
        return failed(
          'tool_reported_failure',
          `The tool reported ${value.status}.`,
        )
      return undefined
    })
    .filter((result): result is ActionResult => result !== undefined)

  // Outcome and observed effects are independent. An error after a committed
  // mutation must retain both the failure and the bytes already confirmed.
  const priority: Record<ActionOutcome['outcome'], number> = {
    succeeded: 0,
    refused: 1,
    uncertain: 2,
    failed: 3,
    cancelled: 4,
  }
  const verdict = results.reduce<ActionResult>(
    (current, result) =>
      priority[result.outcome] > priority[current.outcome] ? result : current,
    { outcome: 'succeeded', effect: unobservedEffect },
  )
  const effects = results.map((result) => result.effect)
  const forward = effects.flatMap((effect) => effect.forward ?? [])
  return {
    outcome: verdict.outcome,
    ...(verdict.cause ? { cause: verdict.cause } : {}),
    effect: {
      status: effects.some((effect) => effect.status === 'partial')
        ? 'partial'
        : effects.some((effect) => effect.status === 'confirmed')
          ? 'confirmed'
          : 'unobserved',
      receiptIds: [...new Set(effects.flatMap((effect) => effect.receiptIds))],
      confirmedPaths: [
        ...new Set(effects.flatMap((effect) => effect.confirmedPaths)),
      ],
      ...(forward.length > 0 ? { forward } : {}),
    },
  }
}
