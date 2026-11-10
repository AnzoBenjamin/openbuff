import type { HarnessApprovalMode } from '@openbuff/sdk'

export const COMMAND_APPROVAL_MODES = [
  'balanced',
  'strict',
  'allow-all',
] as const

export const COMMAND_APPROVAL_DESCRIPTIONS: Record<
  HarnessApprovalMode,
  string
> = {
  balanced:
    'Routine commands run freely; destructive, remote, and unclassified effects ask.',
  strict:
    'Every classified effect asks; ordinary reads and development commands run freely.',
  'allow-all':
    'Commands run without approval prompts. Filesystem sandbox rules still apply.',
}

// Captured at the start of each run so a setting change cannot authorize an
// operation already waiting for approval. This override lasts for this CLI session.
let override: HarnessApprovalMode | undefined

export function getCommandApprovalOverride(): HarnessApprovalMode | undefined {
  return override
}

export function setCommandApprovalMode(
  mode: HarnessApprovalMode | undefined,
): void {
  override = mode
}

export function resolveCommandApprovalMode(
  configured?: HarnessApprovalMode,
): HarnessApprovalMode {
  return override ?? configured ?? 'balanced'
}

export function isCommandApprovalMode(
  value: string,
): value is HarnessApprovalMode {
  return COMMAND_APPROVAL_MODES.some((mode) => mode === value)
}
