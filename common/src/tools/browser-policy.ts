/**
 * Browser read-only interaction policy (shared runtime contract).
 *
 * The browser-use agent's `params.interactionPolicy` is a SPAWN PARAMETER, so
 * the agent-runtime tool executor — the one layer that sees both the spawn
 * params and every outgoing browser_logs call — is the enforcement point.
 * Before this contract the policy was enforced only by prompt text: a model
 * that ignored its instructions could click, type, or evaluate on a page the
 * parent explicitly spawned as read-only. This module is the data half of
 * the fix the language-fit audit asked for (policy as data, not prose),
 * mirroring how `terminalPermissionProfile` is enforced.
 */

/**
 * browser_logs action types that do not mutate page or browser state, per the
 * browser-use agent's own taxonomy. Everything not listed here (click, type,
 * key, mouse, hover, drag, select, upload, evaluate, cookie/storage/network
 * mutation, viewport/recording changes, tab create/close) is BLOCKED under an
 * explicit `read-only` spawn. Fail-closed: an unknown action type is blocked,
 * because the list is the allowlist, not the blocklist.
 */
export const READ_ONLY_BROWSER_ACTIONS: ReadonlySet<string> = new Set([
  'navigate',
  'snapshot',
  'screenshot',
  'design_tokens',
  'wait_for',
  'scroll',
  'pdf',
  'pixel_diff',
  'diagnose',
  'tab',
  'stop',
])

/**
 * Whether a browser_logs action is permitted under the given policy value.
 * Unknown/absent policy means the schema default (`allow-interactions`), so
 * only an EXPLICIT `read-only` restricts; any other value allows — matching
 * the input schema's contract exactly.
 */
export function isBrowserActionAllowed(
  actionType: unknown,
  interactionPolicy: unknown,
): boolean {
  if (interactionPolicy !== 'read-only') return true
  return (
    typeof actionType === 'string' && READ_ONLY_BROWSER_ACTIONS.has(actionType)
  )
}

/**
 * The error shown to the MODEL when a read-only spawn attempts a mutating
 * action. Names the remediation (re-spawn with the other policy) so the
 * agent reports the policy need instead of retrying the blocked action.
 */
export function browserActionBlockedMessage(
  actionType: unknown,
): string {
  const shown = typeof actionType === 'string' ? `"${actionType}"` : '(missing type)'
  return (
    `browser_logs action ${shown} is blocked: this agent was spawned with ` +
    `interactionPolicy: read-only, which permits only non-mutating actions ` +
    `(navigate, snapshot, screenshot, design_tokens, wait_for, scroll, pdf, ` +
    `pixel_diff, diagnose, tab list/switch, stop). If the task requires ` +
    `interaction, return a partial result explaining that the parent must ` +
    `re-spawn this agent with interactionPolicy: allow-interactions.`
  )
}
