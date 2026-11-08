import type { ActionExecutionPort, HostAuthority, Result } from '@codebuff/common/types/contracts/execution-context'
import type { ExecutionScope } from '../host-execution'

/** Derived ports retain authenticated correlation, even with a new facade. */
export function createExecutionScopeRegistry(authority: HostAuthority) {
  const scopes = new Map<string, ExecutionScope>()
  const missing = (): Result<never> => ({ ok: false, reason: 'stale-authority', cause: 'Execution request owner is unavailable' })

  function register(port: ActionExecutionPort, scope: ExecutionScope): Result<undefined> {
    const registration = authority.actionRegistration(port)
    if (!registration.ok) return registration
    const owned = authority.bindAction({ ...registration.value, owner: scope.owner })
    if (!owned.ok) return owned
    const key = JSON.stringify(registration.value.correlation)
    const previous = scopes.get(key)
    if (previous && previous !== scope) return missing()
    scopes.set(key, scope)
    return { ok: true, value: undefined }
  }

  function resolve(port: ActionExecutionPort): Result<ExecutionScope> {
    const registration = authority.actionRegistration(port)
    if (!registration.ok) return registration
    const scope = scopes.get(JSON.stringify(registration.value.correlation))
    if (!scope) return missing()
    const owned = authority.bindAction({ ...registration.value, owner: scope.owner })
    return owned.ok ? { ok: true, value: scope } : owned
  }

  return Object.freeze({ register, resolve })
}
