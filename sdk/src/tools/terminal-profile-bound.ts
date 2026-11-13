import path from 'node:path'

import { evaluateTerminalCommandPolicy } from './terminal-command-policy'

import type { TerminalPermissionProfile } from './terminal-command-policy'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'

/**
 * Agent-declared terminal profiles that bind host dispatch (N03).
 *
 * The agent runtime forwards each agent's declared `terminalPermissionProfile`
 * (`read-only` for every plan-mode lineage) as `permission_profile`. The host
 * execution context keeps its own profile (`full-access` when the sandbox is
 * `unrestricted`, otherwise `workspace-write`), which also selects the OS
 * sandbox, network and landlock settings. A declared profile listed here is an
 * extra lexical policy gate: the command must pass both the declared profile
 * and the host profile. The execution context itself is not narrowed, so
 * sandbox and network behaviour stay as the host configured them.
 *
 * Only `read-only` and `workspace-write` bind. The task-specific profiles
 * (`git-commit`, `dependency-mutation`, `tmux-test`, `validation-diagnosis`,
 * `librarian-read-only`) keep the previous behaviour, where the host profile
 * alone decides: their policies assume SDK flows (owned-path staging,
 * private fixtures, repro directories) that their agents were not tuned
 * against, and enforcing them is a separate change. Agents that declare no
 * profile are forwarded as `full-access` and are unaffected.
 */
export const BINDING_TERMINAL_PROFILES = ['read-only', 'workspace-write'] as const
export type BindingTerminalProfile = (typeof BINDING_TERMINAL_PROFILES)[number]

export function isBindingTerminalProfile(
  profile: unknown,
): profile is BindingTerminalProfile {
  return (BINDING_TERMINAL_PROFILES as readonly unknown[]).includes(profile)
}

/**
 * Evaluate the declared profile as an upper bound on the host profile.
 * Returns a denied `run_terminal_command` result when the declared profile
 * refuses the command, and undefined when dispatch may continue.
 */
export function refuseByDeclaredTerminalProfile(params: {
  command: string
  declaredProfile: TerminalPermissionProfile | undefined
  hostProfile: string | undefined
  mode: 'assistant' | 'user'
  projectRoot: string
  allowedPaths?: readonly string[]
  cwd?: string
}): CodebuffToolOutput<'run_terminal_command'> | undefined {
  const { declaredProfile, hostProfile } = params
  if (!isBindingTerminalProfile(declaredProfile)) return undefined
  if (declaredProfile === hostProfile) return undefined
  const decision = evaluateTerminalCommandPolicy({
    command: params.command,
    mode: params.mode,
    permissionProfile: declaredProfile,
    projectRoot: params.projectRoot,
    allowedPaths: params.allowedPaths ? [...params.allowedPaths] : undefined,
    cwd: path.resolve(params.projectRoot, params.cwd ?? '.'),
  })
  if (decision.allowed) return undefined
  const cause = `Command denied by ${declaredProfile} terminal policy: ${decision.reason}`
  return [
    {
      type: 'json',
      value: {
        command: params.command,
        errorMessage: cause,
        executionRefusal: { ok: false, reason: 'denied', cause },
        permissionProfile: declaredProfile,
        permissionDenied: true,
      },
    },
  ]
}
