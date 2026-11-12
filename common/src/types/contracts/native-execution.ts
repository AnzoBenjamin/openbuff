import type {
  Capability,
  LaunchFacts,
  LaunchObserver,
  ProfileFacts,
  Result,
} from './execution-context'

export type NativePlanIdentity = Readonly<{
  planDigest: string
  nonce: string
  artifactSha256: string
}>

/** Trusted adapter observations; wire objects do not register host authority. */
export type NativeTransportObservation = NativePlanIdentity & Readonly<{
  source: 'native-monitor-spawn'
  pid: number
}>

export type NativePreparedObservation = NativePlanIdentity & Readonly<{
  source: 'native-adapter-ready'
  scopeId: string
  enforced: ProfileFacts['enforced']
}>

export type NativeEntryCommit = NativePlanIdentity & Readonly<{
  resourceRemainingMs: number | null
  facts: LaunchFacts
}>

export type NativeTargetEntryObservation = NativePlanIdentity & Readonly<{
  source: 'native-adapter-exec-status'
  scopeId: string
  pid: number
}>

/** One private launch gates transport setup, target entry and active facts. */
export interface NativeLifecycleObserver {
  nativeTransportObserved(
    observation: NativeTransportObservation,
  ): Result<undefined>
  nativePrepared(observation: NativePreparedObservation): Result<undefined>
  commitNativeTargetEntry(identity: NativePlanIdentity): Result<NativeEntryCommit>
  nativeTargetEntered(
    observation: NativeTargetEntryObservation,
  ): Result<Readonly<{ processObservationId: string }>>
}

export type NativeLaunchObserver = LaunchObserver & NativeLifecycleObserver

/** Availability belongs to a verified generation; enforcement belongs to a job. */
export type NativeGenerationCapabilities = Readonly<{
  generation: string
  artifactSha256: string
  capabilities: readonly Capability[]
  unavailableReasons: readonly string[]
}>
