import type { TransactionIntentEntry } from '../tools/transaction-intent-log'

/** One opaque host-generated ID per physical action; a move covers two stages. */
export type TransactionActionCorrelation = Readonly<{
  transactionId: string
  actionId: string
  from: number
  through: number
}>

export type TransactionMutationEvidence = Readonly<{
  correlation: TransactionActionCorrelation
  stages: readonly TransactionIntentEntry[]
}>

export type TransactionStageProof = Readonly<{
  evidence: TransactionMutationEvidence
  index: number
  fullPath: string
}>

// SDK-internal options, never part of a tool schema or an adapter capability claim.
export const transactionForward = Symbol('transaction-forward')
export type TransactionForwardOptions = {
  [transactionForward]?: TransactionMutationEvidence
}

export const isTransactionActionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  )
