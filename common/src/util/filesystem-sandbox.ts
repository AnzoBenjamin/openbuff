import { AsyncLocalStorage } from 'node:async_hooks'

import { isMandatorySensitiveReadPath } from './sensitive-paths'

export type FilesystemSandboxPolicy = Readonly<{
  mode: 'unrestricted' | 'project'
  allowPaths: readonly string[]
}>

const context = new AsyncLocalStorage<
  Readonly<{
    policy: FilesystemSandboxPolicy
    projectRoot?: string
    readPolicyToken?: object
  }>
>()
const capturedPolicies = new WeakMap<object, FilesystemSandboxPolicy>()
// Standalone containment utilities retain their contract. Agent runs always
// supply a captured policy, whose default is unrestricted.
const contained: FilesystemSandboxPolicy = Object.freeze({
  mode: 'project',
  allowPaths: Object.freeze([]),
})

function capture(policy: FilesystemSandboxPolicy): FilesystemSandboxPolicy {
  return Object.freeze({
    mode: policy.mode,
    allowPaths: Object.freeze([...policy.allowPaths]),
  })
}

export function bindFilesystemSandbox(
  token: object,
  policy: FilesystemSandboxPolicy,
): void {
  capturedPolicies.set(token, capture(policy))
}

export function getFilesystemSandbox(token?: object): FilesystemSandboxPolicy {
  return (
    (token ? capturedPolicies.get(token) : undefined) ??
    context.getStore()?.policy ??
    contained
  )
}

export function hasFilesystemSandbox(token?: object): boolean {
  return Boolean((token && capturedPolicies.has(token)) || context.getStore())
}

/** Each run and its asynchronous children inherit their own immutable policy. */
export function withFilesystemSandbox<T>(
  policy: FilesystemSandboxPolicy,
  run: () => T,
  options: Readonly<{ projectRoot?: string; readPolicyToken?: object }> = {},
): T {
  return context.run(
    Object.freeze({ policy: capture(policy), ...options }),
    run,
  )
}

export function getSandboxProjectRoot(): string | undefined {
  return context.getStore()?.projectRoot
}
export function getSandboxReadPolicyToken(): object | undefined {
  return context.getStore()?.readPolicyToken
}

export function isSandboxSensitivePath(
  filePath: string,
  token?: object,
): boolean {
  return (
    getFilesystemSandbox(token).mode === 'project' &&
    isMandatorySensitiveReadPath(filePath)
  )
}
