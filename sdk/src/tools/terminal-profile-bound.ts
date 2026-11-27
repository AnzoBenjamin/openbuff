import path from 'node:path'

import { evaluateTerminalCommandPolicy } from './terminal-command-policy'

import type { TerminalPermissionProfile } from './terminal-command-policy'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'

/**
 * Agent-declared terminal profiles that bind host dispatch (N03).
 *
 * The agent runtime forwards each agent's declared `terminalPermissionProfile`
 * (`read-only` for every plan-mode lineage) as `permission_profile`. Outside
 * plan mode, the host execution context keeps its configured profile and a
 * binding declaration adds only a lexical policy gate. It is not an OS
 * read-only guarantee. Plan terminal actions instead receive a privately
 * registered native-only read-only profile in sdk/src/run.ts, with required
 * filesystem, network and process-tree isolation and no portable fallback.
 * This helper retains the original host/task policy as an additional gate
 * after that authenticated attenuation; it does not verify the sandbox.
 *
 * Only `read-only` and `workspace-write` declarations bind in non-plan runs.
 * Task-specific declarations retain their previous behavior there. For plan
 * actions, `enforceCapturedProfile` is used only with the root-captured
 * original host policy, so narrowing cannot discard its lexical restrictions.
 * Agents that declare no profile are forwarded as `full-access`; their
 * execute-mode behavior is unchanged.
 */
export const BINDING_TERMINAL_PROFILES = [
  'read-only',
  'workspace-write',
] as const
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
  /** Root-captured original host policy; never selected from tool input. */
  enforceCapturedProfile?: boolean
  hostProfile: string | undefined
  mode: 'assistant' | 'user'
  projectRoot: string
  allowedPaths?: readonly string[]
  cwd?: string
}): CodebuffToolOutput<'run_terminal_command'> | undefined {
  const { declaredProfile, hostProfile } = params
  if (
    !declaredProfile ||
    (!isBindingTerminalProfile(declaredProfile) &&
      !params.enforceCapturedProfile)
  )
    return undefined
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
