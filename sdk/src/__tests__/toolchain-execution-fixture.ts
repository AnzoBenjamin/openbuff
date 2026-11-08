import type { ActionExecutionPort, ExactLaunchInput, ExecutionAdapterContext, LaunchFacts, LaunchObserver, PreparedLaunch, Refusal, TargetDescription, TargetPermit } from '@codebuff/common/types/contracts/execution-context'

/** Adapter test double only; it does not establish common registry authority. */
export function executionFixture(options: { refusal?: Refusal; refusalFor?: (target: TargetDescription) => Refusal | undefined; wait?: Promise<void>; env?: Record<string, string>; resourceRemainingMs?: number } = {}) {
  const targets: TargetDescription[] = []
  const observations: Array<Record<string, unknown>> = []
  const resource = new AbortController()
  let dispatches = 0
  const observer: LaunchObserver = {
    spawnObserved(value) { observations.push({ phase: 'spawn-observed', ...value }); return { ok: true, value: { processObservationId: 'fixture-observation' } } },
    failure(value) { observations.push({ phase: 'dispatch-failed', ...value }); return { ok: true, value: undefined } },
  }
  const execution: ActionExecutionPort = {
    derive() { return { ok: true, value: execution } },
    prepareTarget({ target }) {
      const captured = structuredClone(target)
      targets.push(captured)
      let consumed = false
      const permit = {} as TargetPermit
      const granted = () => options.refusalFor?.(captured) ?? options.refusal ?? { ok: true as const, value: { permit, decisionId: 'fixture-policy' } }
      const launch: PreparedLaunch = {
        facts: () => ({} as LaunchFacts),
        async admit() { await options.wait; return granted() },
        admitSync: granted,
        dispatchNow(token, callback) {
          if (token !== permit || consumed) return { ok: false, reason: 'already-consumed', cause: 'Fixture permit consumed or foreign' }
          consumed = true
          dispatches++
          try {
            const handle = callback({ executable: captured.executable, argv: captured.argv,
              cwd: captured.cwd, env: Object.freeze({ ...options.env }), resourceSignal: resource.signal,
              resourceRemainingMs: options.resourceRemainingMs ?? 2_000, deadlines: {} as ExactLaunchInput['deadlines'],
              adapterOptions: captured.adapterOptions }, observer)
            return { ok: true, value: { phase: 'dispatched', handle, facts: {} as LaunchFacts, observer } }
          } catch (error) {
            observations.push({ phase: 'dispatch-failed', source: 'synchronous-throw' })
            return { ok: false, reason: 'dispatch-failed', cause: String(error), facts: {} as LaunchFacts }
          }
        },
      }
      return { ok: true, value: launch }
    },
    requestResource() { return { ok: false, reason: 'unavailable', cause: 'Fixture has no shared resource' } },
  }
  const context: ExecutionAdapterContext = { execution, projectRoot: process.cwd(), allowedPaths: [process.cwd()],
    mode: 'assistant', profile: { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false } }
  return { context, targets, observations, resource, get dispatches() { return dispatches } }
}
