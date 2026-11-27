export type UncappedSpendingPolicy = {
  mode: 'uncapped'
}

export type StrictCappedSpendingPolicy = {
  mode: 'strict-capped'
  /** User-selected cap in USD cents. Converted to fixed-point micros at admission. */
  capCents: number
  currency: 'USD'
}

export type EstimatedCappedSpendingPolicy = {
  mode: 'estimated-capped'
  capCents: number
  currency: 'USD'
  /** Explicit degraded fallback used when a provider route lacks a strict bound. */
  estimator: {
    id: string
    reservationCents: number
    maxConcurrentAttempts: number
  }
}

export type SpendingPolicy =
  | UncappedSpendingPolicy
  | StrictCappedSpendingPolicy
  | EstimatedCappedSpendingPolicy

export type RequestAdmissionBasis =
  | {
      kind: 'strict-bound'
      description: string
    }
  | {
      kind: 'estimated-reservation'
      estimatorId: string
      description: string
    }

export type RequestCostProvenance =
  | 'provider-reported'
  | 'usage-plus-configured-pricing'

export type RequestAdmissionAttempt = {
  attemptId: string
  runId: string
  provider: string
  model: string
  reservationUsdMicros: number
  basis: RequestAdmissionBasis
  state: 'reserve-active' | 'held-inactive' | 'reconciled'
  createdAt: number
  updatedAt: number
  incompleteReason?:
    | 'missing-usage'
    | 'provider-error'
    | 'cancelled'
    | 'timeout'
    | 'process-restart'
    | 'invalid-usage'
    | 'unknown'
  costUsdMicros?: number
  provenance?: RequestCostProvenance
}

export type RequestAdmissionSnapshot = {
  schemaVersion: 1
  authorityId: string
  policy: SpendingPolicy
  policyHash: string
  revision: number
  capUsdMicros?: number
  heldUsdMicros: number
  reconciledUsdMicros: number
  activeAttempts: number
  exhausted: boolean
  degraded: boolean
  attempts: RequestAdmissionAttempt[]
  createdAt: number
  updatedAt: number
}

export type RequestReservationResult =
  | {
      ok: true
      attemptId: string
      snapshot: RequestAdmissionSnapshot
    }
  | {
      ok: false
      code:
        | 'spend_cap_exceeded'
        | 'concurrency_limit'
        | 'authority_unavailable'
        | 'invalid_reservation'
      message: string
      snapshot: RequestAdmissionSnapshot
    }

export interface RequestAdmissionStore {
  initialize(params: {
    authorityId: string
    policy: SpendingPolicy
  }): RequestAdmissionSnapshot
  recover(params: {
    authorityId: string
    policy: SpendingPolicy
  }): RequestAdmissionSnapshot
  reserve(params: {
    authorityId: string
    runId: string
    provider: string
    model: string
    reservationUsdMicros: number
    basis: RequestAdmissionBasis
  }): RequestReservationResult
  markIncomplete(params: {
    authorityId: string
    attemptId: string
    reason: NonNullable<RequestAdmissionAttempt['incompleteReason']>
  }): RequestAdmissionSnapshot
  reconcile(params: {
    authorityId: string
    attemptId: string
    costUsdMicros: number
    provenance: RequestCostProvenance
  }): RequestAdmissionSnapshot
  snapshot(authorityId: string): RequestAdmissionSnapshot
}

/** Minimal durable reference stored with a resumable session/checkpoint. */
export type RequestAdmissionReference = {
  authorityId: string
  policy: SpendingPolicy
  policyHash: string
}
