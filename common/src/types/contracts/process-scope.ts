import type { AbsoluteDeadline, Clock, LaunchFacts, Scheduler } from './execution-context'

export type ScopeTier = 'posix-owned-group' | 'direct-child' | 'injected' | 'linux-pid-namespace'
export type StopReason = 'deadline' | 'owner-cancel' | 'job-kill' | 'output-limit'
  | 'adapter-error' | 'owner-shutdown' | 'normal-leader-exit'
export type ProcessIdentity = Readonly<{
  pid: number; startTime: string | null; pgid: number | null; sid: number | null
  pidNamespace: string | null
}>
export type ScopeStreams = Readonly<{
  stdin: 'open' | 'closed' | 'unknown'
  stdout: 'open' | 'drained' | 'closed-incomplete' | 'unknown'
  stderr: 'open' | 'drained' | 'closed-incomplete' | 'unknown'
}>
export type ScopeObservation = Readonly<{
  sampledAtMs: number; clockDomainId: string
  leader: 'not-started' | 'running' | 'exited-reaped' | 'unknown'
  scopePresence: 'living' | 'zombie-only' | 'absent' | 'unknown'
  members: readonly Readonly<{
    identity: ProcessIdentity; state: string
    disposition: 'living' | 'zombie' | 'exited' | 'unknown'
  }>[]
  membershipComplete: boolean; identity: 'verified' | 'mismatch' | 'unknown'
  streams: ScopeStreams
}>
export type SignalObservation = Readonly<{
  signal: 'SIGTERM' | 'SIGKILL'; atMs: number; targetTier: ScopeTier
  result: 'delivered' | 'already-absent' | 'refused-identity' | 'unknown'
  errorCode?: string
}>
export type ScopeOutput = Readonly<{
  stdoutSeenBytes: number; stderrSeenBytes: number; retainedBytes: number
  droppedBytes: number; complete: boolean
}>
export type CleanupResult = Readonly<{
  attemptId: string; scopeId: string; status: 'complete' | 'failed' | 'unknown'
  selectedTier: ScopeTier; observedTier: ScopeTier; satisfiesSelectedTier: boolean
  trigger: StopReason; originalDeadline: AbsoluteDeadline
  firstStopAtMs: number; killAtMs: number; observeUntilMs: number
  signals: readonly SignalObservation[]; finalObservation: ScopeObservation
  output: ScopeOutput; cleanupAuthorityRetained: boolean
  selectedLimitSatisfied: boolean | null; cause?: string
  launchFacts?: LaunchFacts
}>
export interface ProcessScopeDriver {
  readonly leaderExited: Promise<ScopeObservation['leader']>
  readonly streamsFinished: Promise<ScopeStreams>
  observe(): Promise<ScopeObservation>
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<SignalObservation>
  closeInput(): void
  /** End owned streams after bounded cleanup failure; output becomes incomplete. */
  abandonStreams?(): void
}
export interface OwnedProcessScope {
  readonly scopeId: string
  readonly tier: ScopeTier
  observe(): Promise<ScopeObservation>
  requestStop(reason: StopReason, force?: boolean): Promise<CleanupResult>
  retryCleanup(force?: boolean): Promise<CleanupResult>
  currentCleanup(): CleanupResult | undefined
}
export type ProcessScopeOptions = Readonly<{
  scopeId: string; tier: ScopeTier; driver: ProcessScopeDriver
  clock?: Clock; scheduler?: Scheduler
  originalDeadline?: AbsoluteDeadline; launchFacts?: () => LaunchFacts
  signal?: AbortSignal; remainingMs?: () => number | null
  termGraceMs?: number; killGraceMs?: number; observationMs?: number
  probeTimeoutMs?: number; pollMs?: number
  output?: () => ScopeOutput; onCleanup?: (result: CleanupResult) => void
  /** Commit ownership fencing before any driver callback can reenter. */
  onStop?: () => void
}>
